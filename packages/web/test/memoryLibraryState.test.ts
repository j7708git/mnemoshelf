import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";

// 使用有狀態的 hooks 替身驅動實際 callback；瀏覽器版面仍由獨立 smoke 驗證。
const hooks = vi.hoisted(() => ({ cursor: 0, slots: [] as unknown[], pendingEffects: [] as (() => void)[] }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.slots)) hooks.slots[index] = initial;
    return [hooks.slots[index], (next: unknown) => { hooks.slots[index] = typeof next === "function" ? next(hooks.slots[index]) : next; }];
  },
  useRef: (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.slots)) hooks.slots[index] = { current: initial };
    return hooks.slots[index];
  },
  useCallback: (callback: unknown) => callback,
  useEffect: (effect: () => void | (() => void), deps: unknown[]) => {
    const index = hooks.cursor++;
    const previous = hooks.slots[index] as { deps: unknown[]; cleanup?: () => void } | undefined;
    if (previous !== undefined && previous.deps.length === deps.length && deps.every((dep, i) => Object.is(dep, previous.deps[i]))) return;
    hooks.pendingEffects.push(() => {
      previous?.cleanup?.();
      hooks.slots[index] = { deps, cleanup: effect() };
    });
  },
}));
vi.mock("../src/api", async (original) => ({
  ...await original<typeof import("../src/api")>(),
  listMemoryLibrary: vi.fn(), searchMemories: vi.fn(),
}));

import { listMemoryLibrary, searchMemories, type MemoryLibraryPage, type MemoryRecallResult } from "../src/api";
import { memoryNameOption, useMemoryLibrary } from "../src/useMemoryLibrary";
import { MemoryRecallPreview } from "../src/MemoryRecallPreview";

function render<T>(callback: () => T): T {
  hooks.cursor = 0;
  const result = callback();
  const effects = hooks.pendingEffects.splice(0);
  for (const effect of effects) effect();
  return result;
}
async function flush() { for (let i = 0; i < 8; i++) await Promise.resolve(); }
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const page = (nextCursor: string | null = null): MemoryLibraryPage => ({
  entries: [], total: 0, counts: { sources: 0, memories: 0 },
  facets: { projects: ["all", "後頁專案"], writers: ["後頁寫入者"], hasUnassigned: true }, nextCursor,
});

afterEach(() => {
  for (const slot of hooks.slots) {
    if (slot !== null && typeof slot === "object" && "cleanup" in slot && typeof slot.cleanup === "function") slot.cleanup();
  }
  hooks.cursor = 0; hooks.slots = []; hooks.pendingEffects = [];
  vi.resetAllMocks();
});

describe("管理分頁與在途請求", () => {
  it("前後頁只使用服務端游標，換條件與重新載入會回第一頁", async () => {
    vi.mocked(listMemoryLibrary).mockResolvedValue(page("next-a"));
    let view = render(useMemoryLibrary);
    await flush();
    view = render(useMemoryLibrary);
    expect(view.facets.projects).toContain("後頁專案");
    view.next();
    view = render(useMemoryLibrary);
    expect(view.pageNumber).toBe(2);
    expect(vi.mocked(listMemoryLibrary).mock.lastCall?.[0]).toEqual({ limit: 25, cursor: "next-a" });
    await flush();
    view = render(useMemoryLibrary);
    view.previous();
    view = render(useMemoryLibrary);
    expect(view.pageNumber).toBe(1);
    expect(vi.mocked(listMemoryLibrary).mock.lastCall?.[0]).toEqual({ limit: 25 });
    await flush();
    view = render(useMemoryLibrary);
    view.next(); render(useMemoryLibrary); await flush();
    view = render(useMemoryLibrary);
    view.changeFilters({ project: memoryNameOption("all"), writer: memoryNameOption("後頁寫入者"), type: "memory" });
    view = render(useMemoryLibrary);
    expect(view.pageNumber).toBe(1);
    expect(view.state.kind).toBe("loading");
    expect(vi.mocked(listMemoryLibrary).mock.lastCall?.[0]).toEqual({ limit: 25, project: "all", writer: "後頁寫入者", type: "memory" });
    await flush();
    view = render(useMemoryLibrary);
    view.next(); render(useMemoryLibrary); await flush();
    view = render(useMemoryLibrary);
    view.reload();
    expect(render(useMemoryLibrary).pageNumber).toBe(1);
    expect(vi.mocked(listMemoryLibrary).mock.lastCall?.[0].cursor).toBeUndefined();
  });

  it.each(["resolve", "reject"] as const)("條件一變便清除舊結果，舊請求晚到的 %s 不能覆蓋新條件", async (outcome) => {
    const old = deferred<MemoryLibraryPage>();
    const current = deferred<MemoryLibraryPage>();
    vi.mocked(listMemoryLibrary).mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    let view = render(useMemoryLibrary);
    const oldSignal = vi.mocked(listMemoryLibrary).mock.calls[0][1]!;
    view.changeFilters({ query: "新條件" });
    expect(oldSignal.aborted).toBe(true);
    view = render(useMemoryLibrary);
    expect(view.state.kind).toBe("loading");
    current.resolve({ ...page(), total: 4, counts: { sources: 4, memories: 0 } });
    await flush();
    if (outcome === "resolve") old.resolve({ ...page(), total: 999, counts: { sources: 0, memories: 999 } });
    else old.reject(new Error("舊錯誤"));
    await flush();
    view = render(useMemoryLibrary);
    expect(view.state.kind).toBe("ready");
    if (view.state.kind === "ready") expect(view.state.page.total).toBe(4);
  });
});

type ElementProps = { children?: ReactNode; "aria-label"?: string; onChange?: (event: { target: { value: string } }) => void; onSubmit?: (event: { preventDefault: () => void }) => void; role?: string; result?: MemoryRecallResult };
function elements(node: ReactNode): ReactElement<ElementProps>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (node === null || typeof node !== "object" || !("props" in node)) return [];
  const element = node as ReactElement<ElementProps>;
  return [element, ...elements(element.props.children)];
}

describe("獨立召回情境", () => {
  it.each(["召回查詢", "召回情境的專案", "召回身分標記"])("修改 %s 清掉結果，也拒絕舊請求晚到", async (field) => {
    const old = deferred<MemoryRecallResult>();
    vi.mocked(searchMemories).mockReturnValue(old.promise);
    const draw = () => elements(render(() => MemoryRecallPreview({ projects: ["all"], writers: ["writer-a"], revision: 0 })));
    let tree = draw();
    tree.find((element) => element.props["aria-label"] === "召回情境的專案")!.props.onChange!({ target: { value: memoryNameOption("all") } });
    tree.find((element) => element.props["aria-label"] === "召回查詢")!.props.onChange!({ target: { value: "舊內容" } });
    tree = draw();
    tree.find((element) => element.type === "form")!.props.onSubmit!({ preventDefault: () => undefined });
    expect(vi.mocked(searchMemories).mock.calls[0][0]).toEqual({ query: "舊內容", project: "all", k: 10 });
    tree = draw();
    expect(tree.some((element) => element.props.role === "status")).toBe(true);
    tree.find((element) => element.props["aria-label"] === field)!.props.onChange!({ target: { value: field === "召回情境的專案" ? "global" : "新內容" } });
    expect(vi.mocked(searchMemories).mock.calls[0][1]?.aborted).toBe(true);
    old.resolve({ query: "舊內容", k: 10, degraded: false, degradedReason: null, hits: [], memoryEmbedding: { ready: 0, pending: 0, failed: 0, tooLong: 0, stale: 0, total: 0 } });
    await flush();
    tree = draw();
    expect(tree.some((element) => element.props.result !== undefined)).toBe(false);
    expect(tree.some((element) => element.props.role === "status")).toBe(false);
  });
});
