import { afterEach, describe, expect, it, vi } from "vitest";
import { listMemoryLibrary, type MemoryLibraryPage } from "../src/api";
import { EMPTY_LIBRARY_FILTERS, memoryLibraryQuery, memoryNameOption, memoryOptionNames } from "../src/useMemoryLibrary";

const emptyPage: MemoryLibraryPage = {
  entries: [], total: 0, counts: { sources: 0, memories: 0 },
  facets: { projects: ["all", "後頁專案"], writers: ["all", "後頁寫入者"], hasUnassigned: true },
  nextCursor: null,
};

afterEach(() => vi.unstubAllGlobals());

describe("管理篩選與全庫選單", () => {
  it("名稱 all 與控制選項分開，四個條件與游標一併傳遞", () => {
    const filters = { project: memoryNameOption("all"), writer: memoryNameOption("all"), type: "source" as const, query: "  100%_內容  " };
    expect(memoryLibraryQuery(filters, "cursor-a")).toEqual({
      project: "all", writer: "all", type: "source", query: "100%_內容", limit: 25, cursor: "cursor-a",
    });
    expect(memoryLibraryQuery(EMPTY_LIBRARY_FILTERS, null)).toEqual({ limit: 25 });
    expect(memoryLibraryQuery({ ...EMPTY_LIBRARY_FILTERS, project: "unassigned" }, null)).toEqual({ limit: 25, unassigned: true });
    expect(memoryLibraryQuery({ ...EMPTY_LIBRARY_FILTERS, project: memoryNameOption("unassigned") }, null))
      .toEqual({ limit: 25, project: "unassigned" });
  });

  it("全庫資料移除最後一筆後，選單仍如實顯示當前條件", () => {
    expect(memoryOptionNames(["保留專案"], memoryNameOption("已刪專案"))).toEqual(["保留專案", "已刪專案"]);
    expect(memoryOptionNames(["all"], memoryNameOption("all"))).toEqual(["all"]);
    expect(memoryOptionNames([], "all")).toEqual([]);
  });
});

describe("記憶管理 REST", () => {
  it("完整編碼條件與 opaque 游標，保留全庫選單並可取消請求", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json(emptyPage));
    vi.stubGlobal("fetch", fetch);
    const abort = new AbortController();
    const page = await listMemoryLibrary({ project: "all", writer: "writer/+&", type: "source", query: "100%_", cursor: "a+/=", limit: 25 }, abort.signal);
    const [path, init] = fetch.mock.calls[0];
    const url = new URL(path, "http://example.invalid");
    expect(url.pathname).toBe("/memory-library");
    expect(Object.fromEntries(url.searchParams)).toEqual({ project: "all", writer: "writer/+&", type: "source", query: "100%_", cursor: "a+/=", limit: "25" });
    expect(init.cache).toBe("no-store");
    expect(init.signal).toBe(abort.signal);
    expect(page.facets.projects).toContain("後頁專案");
    expect(page.facets.writers).toContain("後頁寫入者");
  });

  it.each([
    null,
    { ...emptyPage, counts: { sources: 3, memories: 0 } },
    { ...emptyPage, nextCursor: 1 },
    { ...emptyPage, entries: [{ type: "source", id: 1, chunkCount: 2, memory: null }] },
  ])("拒絕無法安全呈現的回應 %#", async (page) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(page)));
    await expect(listMemoryLibrary()).rejects.toThrow("記憶清單格式不正確");
  });

  it("顯示服務端錯誤，不能把失敗當作空清單", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: { message: "游標已失效" } }, { status: 400 })));
    await expect(listMemoryLibrary({ cursor: "old" })).rejects.toThrow("游標已失效");
  });
});
