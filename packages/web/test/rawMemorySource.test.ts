import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchMemorySource, MemorySourcePolicyChangedError, type MemorySourcePage } from "../src/api";
import { memoryOriginLabel } from "../src/format";
import { RawMemorySourcePageContent } from "../src/RawMemorySourcePanel";

const firstPage: MemorySourcePage = {
  source: {
    id: 3,
    scope: "project",
    project: "原文測試 + 回合",
    agent: "fixture",
    sourceSession: "session-a",
    sourceTurn: "turn-a",
    createdAt: "2026-11-06T01:00:00.000Z",
    chunkVersion: "raw-v1",
    messageCount: 2,
  },
  indexState: { total: 8, pending: 3, ready: 3, failed: 1, tooLong: 1, stale: 1 },
  messages: [
    {
      sourceMessage: "message-a",
      role: "user",
      content: "原文內容 😀\n  下一行",
      occurredAt: null,
      messageIndex: 0,
      start: 0,
      end: 13,
      totalChars: 13,
      complete: true,
    },
    {
      sourceMessage: "message-b",
      role: "assistant",
      content: "助理節錄",
      occurredAt: "2026-11-06T00:55:00.000Z",
      messageIndex: 1,
      start: 0,
      end: 4,
      totalChars: 5,
      complete: false,
    },
  ],
  next: { messageIndex: 1, offset: 4, policyVersion: 2 },
  truncated: true,
  policyVersion: 2,
  untrusted: true,
};

afterEach(() => vi.unstubAllGlobals());

describe("原文來源 REST 讀取", () => {
  it("管理讀取走獨立端點，disabled原文仍可讀並綁定兩個版本續讀", async () => {
    const managed = { ...firstPage, recallVersion: 8, source: { ...firstPage.source, recallPolicy: "disabled" },
      next: { ...firstPage.next!, recallVersion: 8 } };
    const fetch = vi.fn().mockResolvedValueOnce(Response.json(managed))
      .mockResolvedValueOnce(Response.json({ ...managed, recallVersion: 9, next: { ...managed.next, recallVersion: 9 } }));
    vi.stubGlobal("fetch", fetch);
    const first = await fetchMemorySource(3, firstPage.source, null, undefined, true);
    await expect(fetchMemorySource(3, firstPage.source, first.next, undefined, true)).rejects.toBeInstanceOf(MemorySourcePolicyChangedError);
    const [firstUrl, lastUrl] = fetch.mock.calls.map(([url]) => new URL(url, "http://example.invalid"));
    expect(firstUrl.pathname).toBe("/memory-library/source/3");
    expect(firstUrl.searchParams.has("scope")).toBe(false);
    expect(lastUrl.searchParams.get("policyVersion")).toBe("2");
    expect(lastUrl.searchParams.get("recallVersion")).toBe("8");
  });

  it("從頭讀取後，將服務給的游標與相同專案範圍送回", async () => {
    const lastPage: MemorySourcePage = {
      ...firstPage,
      next: null,
      truncated: false,
      messages: [{ ...firstPage.messages[1], content: "尾", start: 4, end: 5, complete: true }],
    };
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json(firstPage))
      .mockResolvedValueOnce(Response.json(lastPage));
    vi.stubGlobal("fetch", fetch);
    const { source } = firstPage;

    const first = await fetchMemorySource(source.id, source, null);
    const last = await fetchMemorySource(source.id, source, first.next);
    expect(last.messages[0].content).toBe("尾");
    expect(last.next).toBeNull();

    const [firstUrl, lastUrl] = fetch.mock.calls.map(([url]) => new URL(url, "http://example.invalid"));
    expect(firstUrl.pathname).toBe("/memory-sources/3");
    expect(firstUrl.searchParams.get("scope")).toBe("project");
    expect(firstUrl.searchParams.get("project")).toBe(source.project);
    expect(firstUrl.searchParams.has("policyVersion")).toBe(false);
    expect(lastUrl.searchParams.get("project")).toBe(source.project);
    expect(lastUrl.searchParams.get("messageIndex")).toBe("1");
    expect(lastUrl.searchParams.get("offset")).toBe("4");
    expect(lastUrl.searchParams.get("policyVersion")).toBe("2");
    expect(fetch.mock.calls[1][1].cache).toBe("no-store");
  });

  it("拒絕拼接政策不同的分頁，並提示不可讀取的來源", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: "policy-changed" }, { status: 409 }))
      .mockResolvedValueOnce(Response.json(firstPage))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetch);
    const access = { scope: "agent", project: null, agent: "fixture" } as const;

    await expect(fetchMemorySource(3, access, firstPage.next)).rejects.toBeInstanceOf(MemorySourcePolicyChangedError);
    await expect(fetchMemorySource(3, access, { messageIndex: 1, offset: 4, policyVersion: 1 }))
      .rejects.toBeInstanceOf(MemorySourcePolicyChangedError);
    await expect(fetchMemorySource(3, access, null)).rejects.toThrow("不在可讀取的範圍");
    expect(fetch.mock.calls[0][0]).toContain("scope=agent&agent=fixture");
  });
});

describe("原文來源畫面", () => {
  it("區分角色與未知對話時間，並從索引完成數扣除待重建片段", () => {
    const html = renderToStaticMarkup(createElement(RawMemorySourcePageContent, { page: firstPage }));
    expect(html).toContain("使用者・第 1 則");
    expect(html).toContain("助理・第 2 則");
    expect(html).toContain("對話時間未知");
    expect(html).toContain("原文內容 😀\n  下一行");
    expect(html).toContain("原文已保存");
    expect(html).toContain("已完成 2");
    expect(html).toContain("待重建 1");
    expect(html).toContain("此頁只顯示部分原文");
  });

  it("只將已知的舊 OpenCode 摘要寫入者標為舊版摘要", () => {
    expect(memoryOriginLabel({ agent: "opencode-plugin/turn" })).toBe("舊版摘要");
    expect(memoryOriginLabel({ agent: "dsh/turn" })).toBe("舊版記憶");
    expect(memoryOriginLabel({ agent: "fixture" })).toBe("舊版記憶");
    expect(memoryOriginLabel({ agent: "opencode-plugin/turn", sourceId: 3 })).toBe("原文回合片段");
  });
});
