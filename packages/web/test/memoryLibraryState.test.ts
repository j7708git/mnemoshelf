import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

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
  getMemoryRecallRules: vi.fn(), previewMemoryRecallRule: vi.fn(), saveMemoryRecallRule: vi.fn(),
  deleteMemoryRecallRule: vi.fn(), updateMemoryOrganization: vi.fn(), importMemories: vi.fn(),
}));

import { getMemoryRecallRules, importMemories, listMemoryLibrary, MemoryImportError, MemoryRecallConflictError, previewMemoryRecallRule, saveMemoryRecallRule, searchMemories, updateMemoryOrganization,
  type MemoryLibraryEntry, type MemoryLibraryPage, type MemoryRecallResult, type MemoryRulePreview } from "../src/api";
import { memoryNameOption, useMemoryLibrary } from "../src/useMemoryLibrary";
import { MemoryRecallPreview } from "../src/MemoryRecallPreview";
import { MemoryRecallRules } from "../src/MemoryRecallRules";
import { MemoryOrganizationEditor } from "../src/MemoryOrganizationEditor";
import { MemoriesPanel } from "../src/MemoriesPanel";

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
  facets: { projects: ["all", "後頁專案"], writers: ["後頁寫入者"], hasUnassigned: true }, nextCursor, recallVersion: 1,
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

type ElementProps = { children?: ReactNode; "aria-label"?: string; onChange?: (event: { target: { value?: string; checked?: boolean; files?: unknown[] } }) => void; onSubmit?: (event: { preventDefault: () => void }) => void; onClick?: () => void; role?: string; result?: MemoryRecallResult; disabled?: boolean; checked?: boolean };
function elements(node: ReactNode): ReactElement<ElementProps>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (node === null || typeof node !== "object" || !("props" in node)) return [];
  const element = node as ReactElement<ElementProps>;
  return [element, ...elements(element.props.children)];
}

describe("獨立召回情境", () => {
  it("非原文命中顯示短記憶，不將新寫入內容誤標為舊版", async () => {
    vi.mocked(searchMemories).mockResolvedValue({
      query: "新記憶", k: 10, degraded: false, degradedReason: null,
      memoryEmbedding: { ready: 1, pending: 0, failed: 0, tooLong: 0, stale: 0, total: 1 },
      hits: [{ id: 1, content: "新寫入的合成記憶", kind: "fact", scope: "project", project: "demo", agent: "writer-a",
        supersedes: null, pinned: false, sourceSession: null, sourceMessage: null, createdAt: "2026-11-14T00:00:00.000Z", deletedAt: null,
        rank: 1, score: 1, source: "semantic", untrusted: true }],
    });
    const draw = () => elements(render(() => MemoryRecallPreview({ projects: ["demo"], writers: [], revision: 0 })));
    let tree = draw();
    tree.find((element) => element.props["aria-label"] === "召回情境的專案")!.props.onChange!({ target: { value: memoryNameOption("demo") } });
    tree.find((element) => element.props["aria-label"] === "召回查詢")!.props.onChange!({ target: { value: "新記憶" } });
    tree = draw(); tree.find((element) => element.type === "form")!.props.onSubmit!({ preventDefault: () => undefined });
    await flush(); tree = draw();
    const markup = renderToStaticMarkup(tree.find((element) => element.props.result !== undefined)!);
    expect(markup).toContain("短記憶");
    expect(markup).not.toContain("舊版");
  });

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

const rulePreview: MemoryRulePreview = { revision: 2, dataRevision: 8, matched: { sources: 6, memories: 2 }, changed: { sources: 5, memories: 1 }, preservedOverrides: { sources: 1, memories: 1 } };
const ruleSettings = { revision: 2, dataRevision: 8, rules: [] };
const button = (tree: ReactElement<ElementProps>[], label: string) => tree.find((element) => element.type === "button" && element.props.children === label)!;
const input = (tree: ReactElement<ElementProps>[], label: string) => tree.find((element) => element.props["aria-label"] === label)!;

describe("規則表單預覽與保存", () => {
  it.each([false, true])("套用既有資料=%s：送出與畫面選擇一致的修訂，預設不改歷史", async (existing) => {
    vi.mocked(getMemoryRecallRules).mockResolvedValue(ruleSettings);
    vi.mocked(previewMemoryRecallRule).mockResolvedValue(rulePreview);
    vi.mocked(saveMemoryRecallRule).mockResolvedValue({ settings: { ...ruleSettings, revision: 3 }, ...rulePreview });
    const onChanged = vi.fn();
    const draw = () => elements(render(() => MemoryRecallRules({ projects: ["all"], writers: [], revision: 0, onChanged })));
    draw(); await flush();
    let tree = draw();
    expect(input(tree, "一併套用符合條件的既有記憶").props.checked).toBe(false);
    input(tree, "規則專案").props.onChange!({ target: { value: "all" } });
    if (existing) input(tree, "一併套用符合條件的既有記憶").props.onChange!({ target: { checked: true } });
    tree = draw(); button(tree, "預覽變更").props.onClick!(); await flush();
    tree = draw();
    const previewText = tree.filter((element) => element.type === "p").map((element) => renderToStaticMarkup(element)).join("");
    expect(previewText).toContain(existing ? "預計更新用途／規則依據" : "若套用既有資料可更新用途／規則依據");
    button(tree, existing ? "保存並套用既有記憶" : "保存規則（僅未來）").props.onClick!(); await flush();
    expect(vi.mocked(saveMemoryRecallRule).mock.calls[0][1]).toEqual({ expectedRevision: 2, applyExisting: existing, ...(existing ? { expectedDataRevision: 8 } : {}) });
    expect(onChanged).toHaveBeenCalledOnce();
  });

  it("變更表單作廢在途預覽；409後不能沿用舊預覽保存", async () => {
    vi.mocked(getMemoryRecallRules).mockResolvedValue(ruleSettings);
    const old = deferred<MemoryRulePreview>();
    vi.mocked(previewMemoryRecallRule).mockReturnValueOnce(old.promise).mockResolvedValue(rulePreview);
    vi.mocked(saveMemoryRecallRule).mockRejectedValue(new MemoryRecallConflictError());
    const draw = () => elements(render(() => MemoryRecallRules({ projects: ["all"], writers: [], revision: 0, onChanged: vi.fn() })));
    draw(); await flush(); let tree = draw();
    input(tree, "規則專案").props.onChange!({ target: { value: "all" } });
    tree = draw(); button(tree, "預覽變更").props.onClick!();
    tree = draw(); input(tree, "規則召回用途").props.onChange!({ target: { value: "global" } });
    expect(vi.mocked(previewMemoryRecallRule).mock.calls[0][1]?.aborted).toBe(true);
    old.resolve(rulePreview); await flush(); tree = draw();
    expect(button(tree, "保存規則（僅未來）")).toBeUndefined();
    button(tree, "預覽變更").props.onClick!(); await flush(); tree = draw();
    button(tree, "保存規則（僅未來）").props.onClick!(); await flush(); tree = draw(); await flush();
    expect(button(tree, "保存規則（僅未來）")).toBeUndefined();
    expect(tree.some((element) => element.props.role === "alert")).toBe(true);
    expect(vi.mocked(getMemoryRecallRules).mock.calls.length).toBeGreaterThan(1);
  });

  it("預覽後改勾既有資料，必須重做預覽才能保存", async () => {
    vi.mocked(getMemoryRecallRules).mockResolvedValue(ruleSettings);
    vi.mocked(previewMemoryRecallRule).mockResolvedValue(rulePreview);
    const draw = () => elements(render(() => MemoryRecallRules({ projects: ["all"], writers: [], revision: 0, onChanged: vi.fn() })));
    draw(); await flush(); let tree = draw();
    input(tree, "規則專案").props.onChange!({ target: { value: "all" } }); tree = draw();
    button(tree, "預覽變更").props.onClick!(); await flush(); tree = draw();
    expect(button(tree, "保存規則（僅未來）")).toBeDefined();
    input(tree, "一併套用符合條件的既有記憶").props.onChange!({ target: { checked: true } }); tree = draw();
    expect(button(tree, "保存並套用既有記憶")).toBeUndefined();
  });
});

describe("單筆例外與規則備份", () => {
  const entry: MemoryLibraryEntry = { type: "source", id: 7, chunkCount: 3, memory: {
    id: 30, content: "合成回合節錄", kind: "fact", scope: "project", project: "demo", agent: "writer-a", sourceId: 7,
    supersedes: null, pinned: false, sourceSession: "session-a", sourceMessage: null, createdAt: "2026-11-14T00:00:00.000Z", deletedAt: null,
    originProject: "original", assignedProject: "demo", recallPolicy: "project", recallPolicySource: "legacy", recallRuleId: null, recallRuleRevision: null,
  } };

  it.each(["keep", "rules"])("整理歸屬 %s 以完整回合為單位，不擅自新增override", async (policy) => {
    vi.mocked(updateMemoryOrganization).mockResolvedValue(undefined);
    const onSaved = vi.fn();
    const draw = () => elements(render(() => MemoryOrganizationEditor({ entry, projects: ["next"], dataRevision: 8, onSaved, onReload: vi.fn() })));
    let tree = draw();
    input(tree, "歸屬專案（source #7）").props.onChange!({ target: { value: "next" } });
    input(tree, "單筆召回用途（source #7）").props.onChange!({ target: { value: policy } });
    tree = draw(); button(tree, "保存歸屬與用途").props.onClick!(); await flush();
    expect(vi.mocked(updateMemoryOrganization).mock.calls[0]).toEqual(["source", 7, { assignedProject: "next", expectedDataRevision: 8, ...(policy === "rules" ? { recallPolicy: null } : {}) }]);
    expect(entry.memory.originProject).toBe("original");
    expect(onSaved).toHaveBeenCalledOnce();
  });

  it("只有召回規則、零記憶的備份仍能明確預覽並還原", async () => {
    vi.mocked(listMemoryLibrary).mockResolvedValue(page());
    vi.mocked(getMemoryRecallRules).mockResolvedValue(ruleSettings);
    vi.mocked(importMemories).mockImplementation(async (_text, options) => ({
      dryRun: options.dryRun, total: 0, valid: 0, invalid: [], duplicates: 0, redacted: 0, created: 0, wouldCreate: 0,
      rules: { mode: options.rulesMode ?? "preserve", available: 1, availableInBackup: true, replaced: !options.dryRun && options.rulesMode === "replace", revision: 2 },
    }));
    const draw = () => elements(render(MemoriesPanel));
    let tree = draw(); await flush(); tree = draw();
    input(tree, "選擇記憶備份檔").props.onChange!({ target: { files: [{ name: "rules-only.ndjson", text: async () => "合成備份" }] } });
    await flush(); tree = draw();
    input(tree, "一併還原備份中的召回規則").props.onChange!({ target: { checked: true } });
    await flush(); tree = draw();
    expect(button(tree, "確認匯入").props.disabled).toBe(false);
    button(tree, "確認匯入").props.onClick!(); await flush();
    expect(vi.mocked(importMemories).mock.lastCall?.[1]).toEqual({ dryRun: false, rulesMode: "replace", expectedRevision: 2 });
  });

  it.each([false, true])("匯入部分完成明示失敗項目是否已保存內容：%s", async (failedAfterCreate) => {
    vi.mocked(listMemoryLibrary).mockResolvedValue(page());
    vi.mocked(importMemories).mockResolvedValueOnce({
      dryRun: true, total: 3, valid: 3, invalid: [], duplicates: 0, redacted: 0, created: 0, wouldCreate: 3,
    }).mockRejectedValueOnce(new MemoryImportError("合成匯入錯誤", null, {
      partial: true, created: 1, duplicates: 0, failed: 1, pending: 1, rulesRestored: false, failedAfterCreate,
    }));
    const draw = () => elements(render(MemoriesPanel));
    let tree = draw(); await flush(); tree = draw();
    input(tree, "選擇記憶備份檔").props.onChange!({ target: { files: [{ name: "partial.ndjson", text: async () => "合成備份" }] } });
    await flush(); tree = draw();
    button(tree, "確認匯入").props.onClick!(); await flush(); tree = draw();
    const errorText = tree.filter((element) => element.props.role === "alert").map((element) => renderToStaticMarkup(element)).join("");
    expect(errorText).toContain("已新增 1 筆");
    expect(errorText.includes("失敗項目的內容已保存，後續設定未完成")).toBe(failedAfterCreate);
  });
});
