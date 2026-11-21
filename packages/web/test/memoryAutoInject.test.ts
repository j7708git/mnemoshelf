import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// 使用與 memoryLibraryState.test.ts 一致的有狀態 hooks 替身，在不依賴 jsdom 的情況下驗證元件互動與狀態更新。
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

import {
  getMemoryAutoInjectSettings,
  MemoryAutoInjectUnavailableError,
  MemoryRecallConflictError,
  updateMemoryAutoInjectSettings,
  type MemoryAutoInjectSettings,
} from "../src/api";
import { MemoryAutoInjectPanel } from "../src/MemoryAutoInjectPanel";
import { MemoryRecallRules } from "../src/MemoryRecallRules";

function render<T>(callback: () => T): T {
  hooks.cursor = 0;
  const result = callback();
  const effects = hooks.pendingEffects.splice(0);
  for (const effect of effects) effect();
  return result;
}

async function flush() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

type ElementProps = {
  children?: ReactNode;
  "aria-label"?: string;
  value?: string;
  disabled?: boolean;
  role?: string;
  onChange?: (event: { target: { value: string } }) => void;
  onSubmit?: (event: { preventDefault: () => void }) => void;
  onClick?: () => void;
};

function elements(node: ReactNode): ReactElement<ElementProps>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (node === null || typeof node !== "object" || !("props" in node)) return [];
  const element = node as ReactElement<ElementProps>;
  return [element, ...elements(element.props.children)];
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

afterEach(() => {
  for (const slot of hooks.slots) {
    if (slot !== null && typeof slot === "object" && "cleanup" in slot && typeof slot.cleanup === "function") {
      slot.cleanup();
    }
  }
  hooks.cursor = 0;
  hooks.slots = [];
  hooks.pendingEffects = [];
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("自動注入設定 REST API", () => {
  it("讀取設定帶入 token、避開快取並支援取消訊號", async () => {
    const payload: MemoryAutoInjectSettings = {
      revision: 2,
      defaultMode: "all",
      projects: { "proj-alpha": "refined-only" },
    };
    const fetch = vi.fn().mockResolvedValue(Response.json(payload));
    vi.stubGlobal("fetch", fetch);
    vi.stubGlobal("sessionStorage", { getItem: () => "fixture-token" });
    const abort = new AbortController();

    await expect(getMemoryAutoInjectSettings(abort.signal)).resolves.toEqual(payload);
    expect(fetch).toHaveBeenCalledWith("/memory-auto-inject", expect.objectContaining({
      cache: "no-store",
      signal: abort.signal,
    }));
    const headers = fetch.mock.calls[0][1].headers as Headers;
    expect(headers.get("authorization")).toBe("Bearer fixture-token");
    expect(headers.get("accept")).toBe("application/json");
  });

  it("更新全域預設或專案覆寫（含 null 移除）送出正確 PATCH", async () => {
    const updated: MemoryAutoInjectSettings = {
      revision: 3,
      defaultMode: "refined-only",
      projects: { "proj-beta": "off" },
    };
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json(updated))
      .mockResolvedValueOnce(Response.json({ ...updated, revision: 4, projects: {} }));
    vi.stubGlobal("fetch", fetch);

    await expect(updateMemoryAutoInjectSettings({
      expectedRevision: 2,
      defaultMode: "refined-only",
      projects: { "proj-beta": "off" },
    })).resolves.toEqual(updated);

    expect(fetch.mock.calls[0][0]).toBe("/memory-auto-inject");
    expect(fetch.mock.calls[0][1].method).toBe("PATCH");
    expect((fetch.mock.calls[0][1].headers as Headers).get("content-type")).toBe("application/json");
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({
      expectedRevision: 2,
      defaultMode: "refined-only",
      projects: { "proj-beta": "off" },
    });

    await expect(updateMemoryAutoInjectSettings({
      expectedRevision: 3,
      projects: { "proj-beta": null },
    })).resolves.toEqual({ revision: 4, defaultMode: "refined-only", projects: {} });
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({
      expectedRevision: 3,
      projects: { "proj-beta": null },
    });
  });

  it("404 拋出 MemoryAutoInjectUnavailableError，409 沿用 MemoryRecallConflictError", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(Response.json({ error: { message: "revision conflict" } }, { status: 409 }))
      .mockResolvedValueOnce(Response.json({ error: { message: "revision conflict" } }, { status: 409 })));

    await expect(getMemoryAutoInjectSettings()).rejects.toBeInstanceOf(MemoryAutoInjectUnavailableError);
    await expect(updateMemoryAutoInjectSettings({ expectedRevision: 1, defaultMode: "off" }))
      .rejects.toBeInstanceOf(MemoryAutoInjectUnavailableError);
    await expect(getMemoryAutoInjectSettings()).rejects.toBeInstanceOf(MemoryRecallConflictError);
    await expect(updateMemoryAutoInjectSettings({ expectedRevision: 1, defaultMode: "off" }))
      .rejects.toBeInstanceOf(MemoryRecallConflictError);
  });

  it("非 2xx 回應帶出伺服器錯誤訊息", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(Response.json({ error: { message: "專案名稱不合法" } }, { status: 400 }))
      .mockResolvedValueOnce(new Response("server down", { status: 500 })));

    await expect(updateMemoryAutoInjectSettings({ expectedRevision: 1, projects: { "": "off" } }))
      .rejects.toThrow("專案名稱不合法");
    await expect(getMemoryAutoInjectSettings()).rejects.toThrow("HTTP 500");
  });

  it.each([
    null,
    [],
    { revision: 0, defaultMode: "all", projects: {} },
    { revision: 1.5, defaultMode: "all", projects: {} },
    { revision: 1, defaultMode: "invalid", projects: {} },
    { revision: 1, defaultMode: "all", projects: [] },
    { revision: 1, defaultMode: "all", projects: null },
    { revision: 1, defaultMode: "all", projects: { "": "off" } },
    { revision: 1, defaultMode: "all", projects: { demo: "unknown" } },
  ])("拒絕格式不正確的回應結構 %#", async (badBody) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(badBody)));
    await expect(getMemoryAutoInjectSettings()).rejects.toThrow("自動注入設定格式不正確");
  });
});

describe("MemoryAutoInjectPanel 元件互動", () => {
  it("載入中顯示狀態，載入完成呈現說明、全域預設與專案覆寫建議清單", async () => {
    const pending = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn().mockReturnValueOnce(pending.promise));
    const draw = () => elements(render(() => MemoryAutoInjectPanel({ projects: ["proj-a", "proj-b"], revision: 0 })));

    let tree = draw();
    const loadingMarkup = renderToStaticMarkup(tree[0]!);
    expect(loadingMarkup).toContain("自動注入設定（不影響 MCP 主動搜尋）");
    expect(loadingMarkup).toContain("search_memories");
    expect(loadingMarkup).toContain("正在載入自動注入設定");

    pending.resolve(Response.json({ revision: 1, defaultMode: "all", projects: { "proj-a": "off" } }));
    await flush();
    tree = draw();
    const loadedMarkup = renderToStaticMarkup(tree[0]!);
    expect(loadedMarkup).toContain("精煉優先＋原文補位");
    expect(loadedMarkup).toContain("僅自動注入精煉記憶");
    expect(loadedMarkup).toContain("停用自動注入");
    expect(loadedMarkup).toContain('value="proj-a"');
    expect(loadedMarkup).toContain('value="proj-b"');
    expect(loadedMarkup).toContain("回復預設");
  });

  it("404 舊版服務顯示升級提示，不顯示可操作表單或錯誤警告", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(null, { status: 404 })));
    const draw = () => elements(render(() => MemoryAutoInjectPanel({ projects: ["proj-a"], revision: 0 })));

    draw();
    await flush();
    const tree = draw();
    const markup = renderToStaticMarkup(tree[0]!);
    expect(markup).toContain("HTTP 404");
    expect(markup).toContain("尚未支援自動注入設定");
    expect(tree.some((element) => element.props.role === "alert")).toBe(false);
    expect(tree.some((element) => element.props["aria-label"] === "全域預設自動注入模式")).toBe(false);
  });

  it("切換全域預設、新增專案覆寫、修改專案模式與回復預設（傳 null）皆正確呼叫 PATCH", async () => {
    const fetch = vi.fn()
      // 1. 初始 GET
      .mockResolvedValueOnce(Response.json({ revision: 1, defaultMode: "all", projects: {} }))
      // 2. PATCH 全域預設
      .mockResolvedValueOnce(Response.json({ revision: 2, defaultMode: "refined-only", projects: {} }))
      // 3. PATCH 新增專案覆寫
      .mockResolvedValueOnce(Response.json({ revision: 3, defaultMode: "refined-only", projects: { "proj-x": "off" } }))
      // 4. PATCH 切換既有專案模式
      .mockResolvedValueOnce(Response.json({ revision: 4, defaultMode: "refined-only", projects: { "proj-x": "all" } }))
      // 5. PATCH 回復預設（null）
      .mockResolvedValueOnce(Response.json({ revision: 5, defaultMode: "refined-only", projects: {} }));
    vi.stubGlobal("fetch", fetch);

    const draw = () => elements(render(() => MemoryAutoInjectPanel({ projects: ["proj-x"], revision: 0 })));
    draw();
    await flush();
    let tree = draw();

    // 切換全域預設
    const globalSelect = tree.find((el) => el.props["aria-label"] === "全域預設自動注入模式")!;
    globalSelect.props.onChange!({ target: { value: "refined-only" } });
    await flush();
    tree = draw();
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ expectedRevision: 1, defaultMode: "refined-only" });

    // 新增專案覆寫（自動 trim 空白）
    tree.find((el) => el.props["aria-label"] === "自動注入專案名稱")!.props.onChange!({ target: { value: "  proj-x  " } });
    tree.find((el) => el.props["aria-label"] === "專案自動注入模式")!.props.onChange!({ target: { value: "off" } });
    tree = draw();
    tree.find((el) => el.type === "form")!.props.onSubmit!({ preventDefault: () => undefined });
    await flush();
    tree = draw();
    expect(JSON.parse(fetch.mock.calls[2][1].body)).toEqual({ expectedRevision: 2, projects: { "proj-x": "off" } });
    expect(tree.find((el) => el.props["aria-label"] === "自動注入專案名稱")!.props.value).toBe("");

    // 修改既有專案覆寫模式
    tree.find((el) => el.props["aria-label"] === "專案 proj-x 自動注入模式")!.props.onChange!({ target: { value: "all" } });
    await flush();
    tree = draw();
    expect(JSON.parse(fetch.mock.calls[3][1].body)).toEqual({ expectedRevision: 3, projects: { "proj-x": "all" } });

    // 回復預設（送出 null）
    tree.find((el) => el.props["aria-label"] === "回復預設（proj-x）")!.props.onClick!();
    await flush();
    tree = draw();
    expect(JSON.parse(fetch.mock.calls[4][1].body)).toEqual({ expectedRevision: 4, projects: { "proj-x": null } });
    expect(tree.some((el) => el.props["aria-label"] === "專案 proj-x 自動注入模式")).toBe(false);
  });

  it("409 revision 衝突時顯示錯誤並自動重新載入最新設定", async () => {
    const fetch = vi.fn()
      // 1. 初始 GET (revision 1)
      .mockResolvedValueOnce(Response.json({ revision: 1, defaultMode: "all", projects: {} }))
      // 2. PATCH 收到 409
      .mockResolvedValueOnce(Response.json({ error: { message: "conflict" } }, { status: 409 }))
      // 3. 自動重載 GET (revision 5)
      .mockResolvedValueOnce(Response.json({ revision: 5, defaultMode: "off", projects: { "other-proj": "refined-only" } }))
      // 4. 後續 PATCH 使用新 revision 5
      .mockResolvedValueOnce(Response.json({ revision: 6, defaultMode: "all", projects: { "other-proj": "refined-only" } }));
    vi.stubGlobal("fetch", fetch);

    const draw = () => elements(render(() => MemoryAutoInjectPanel({ projects: ["other-proj"], revision: 0 })));
    draw();
    await flush();
    let tree = draw();

    tree.find((el) => el.props["aria-label"] === "全域預設自動注入模式")!.props.onChange!({ target: { value: "off" } });
    await flush();
    // effect 觸發自動重載
    tree = draw();
    await flush();
    tree = draw();

    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls[2][0]).toBe("/memory-auto-inject");
    expect(tree.some((el) => el.props.role === "alert")).toBe(true);
    expect(tree.find((el) => el.props["aria-label"] === "全域預設自動注入模式")!.props.value).toBe("off");
    expect(tree.some((el) => el.props["aria-label"] === "專案 other-proj 自動注入模式")).toBe(true);

    // 使用重載後的 revision 5 再更新一次
    tree.find((el) => el.props["aria-label"] === "全域預設自動注入模式")!.props.onChange!({ target: { value: "all" } });
    await flush();
    expect(JSON.parse(fetch.mock.calls[3][1].body)).toEqual({ expectedRevision: 5, defaultMode: "all" });
  });

  it("MemoryRecallRules 下方有掛載 MemoryAutoInjectPanel", () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ revision: 1, dataRevision: 1, rules: [] })));
    const tree = elements(render(() => MemoryRecallRules({ projects: ["demo"], writers: [], revision: 1, onChanged: vi.fn() })));
    expect(tree.some((el) => el.type === MemoryAutoInjectPanel)).toBe(true);
  });
});
