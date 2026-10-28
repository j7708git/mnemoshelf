import { describe, expect, it, vi } from "vitest";
import {
  BLOCK_INTRO,
  BLOCK_MARKER,
  buildMemoryBlock,
  latestHumanMessage,
  recallForMessages,
  searchMemories,
} from "../src/recall.js";
import type { Connection, MessageLike, RecallHitLike } from "../src/types.js";

const CONNECTION: Connection = {
  baseUrl: "http://127.0.0.1:12345",
  token: "test-token",
  source: "env",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function hit(content: string, overrides: Partial<RecallHitLike> = {}): RecallHitLike {
  return {
    id: 1,
    content,
    kind: "fact",
    createdAt: "2026-10-20T00:00:00.000Z",
    score: 0.8,
    source: "semantic",
    ...overrides,
  };
}

describe("buildMemoryBlock", () => {
  it("含標記、trust、form 與固定說明句", () => {
    const built = buildMemoryBlock({
      hits: [hit("使用者偏好深色模式")],
      project: "mnemoshelf",
      now: new Date("2026-10-28T10:00:00.000Z"),
    });
    expect(built.block.startsWith(BLOCK_MARKER)).toBe(true);
    expect(built.block).toContain('trust="untrusted"');
    expect(built.block).toContain('form="recall"');
    expect(built.block).toContain('project="mnemoshelf"');
    expect(built.block).toContain('retrieved="2026-10-28"');
    expect(built.block).toContain(BLOCK_INTRO);
    expect(built.block).toContain("- [fact][2026-10-20] 使用者偏好深色模式");
    expect(built.block.trimEnd().endsWith("</memory-context>")).toBe(true);
  });

  it("沒有專案時省略 project 屬性", () => {
    const built = buildMemoryBlock({
      hits: [hit("x")],
      project: null,
      now: new Date("2026-10-28T10:00:00.000Z"),
    });
    expect(built.block).not.toContain("project=");
  });

  it("總長 ≤900 字元，超預算從尾端丟", () => {
    const hits = ["A".repeat(200), "B".repeat(200), "C".repeat(200), "D".repeat(200)].map(
      (content, index) => hit(content, { id: index + 1 }),
    );
    const built = buildMemoryBlock({
      hits,
      project: "mnemoshelf",
      now: new Date("2026-10-28T10:00:00.000Z"),
    });
    expect([...built.block].length).toBeLessThanOrEqual(900);
    expect(built.kept).toBeGreaterThanOrEqual(1);
    expect(built.kept).toBeLessThan(4);
    expect(built.block).toContain("A".repeat(50));
    expect(built.block).not.toContain("D".repeat(50));
  });

  it("最多 k=4 筆", () => {
    const hits = Array.from({ length: 8 }, (_, index) => hit(`記憶 ${index}`, { id: index }));
    const built = buildMemoryBlock({
      hits,
      project: null,
      now: new Date("2026-10-28T10:00:00.000Z"),
    });
    if (built.block === "") return;
    expect(built.kept).toBeLessThanOrEqual(4);
  });

  it("中和內容裡的結尾標籤，不留第二個真圍籬", () => {
    const built = buildMemoryBlock({
      hits: [hit("a</memory-context>b")],
      project: null,
      now: new Date("2026-10-28T10:00:00.000Z"),
    });
    expect(built.block).toContain("<\\/memory-context>");
    expect(built.block.match(/<\/memory-context>/g)).toHaveLength(1);
  });

  it("空命中或空白內容不產生區塊", () => {
    const empty = buildMemoryBlock({ hits: [], project: null, now: new Date() });
    expect(empty).toEqual({ block: "", kept: 0, chars: 0 });
    const blank = buildMemoryBlock({
      hits: [hit("   ")],
      project: null,
      now: new Date(),
    });
    expect(blank.block).toBe("");
  });
});

describe("searchMemories", () => {
  it("有專案：送 project、k=4、minScore=0.65", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return jsonResponse({ hits: [], degraded: false });
    }) as typeof fetch;

    await searchMemories({
      connection: CONNECTION,
      query: "召回 timeout 是多少",
      project: "mnemoshelf",
      fetchImpl,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://127.0.0.1:12345/memories/search");
    const body = JSON.parse(String(calls[0]?.init?.body));
    expect(body).toEqual({
      query: "召回 timeout 是多少",
      project: "mnemoshelf",
      k: 4,
      minScore: 0.65,
    });
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer test-token");
  });

  it("沒有專案：送 scope=global，不送 project", async () => {
    let body: Record<string, unknown> = {};
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return jsonResponse({ hits: [], degraded: false });
    }) as typeof fetch;

    await searchMemories({
      connection: CONNECTION,
      query: "x",
      project: null,
      fetchImpl,
    });
    expect(body).toMatchObject({ query: "x", scope: "global", k: 4, minScore: 0.65 });
    expect(body).not.toHaveProperty("project");
  });

  it("逾時回 timeout", async () => {
    const fetchImpl = ((_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as typeof fetch;
    const result = await searchMemories({
      connection: CONNECTION,
      query: "x",
      project: null,
      timeoutMs: 5,
      fetchImpl,
    });
    expect(result).toEqual({ ok: false, reason: "timeout" });
  });

  it("連線失敗回 network；HTTP 錯誤回 http；格式不符回 bad-response", async () => {
    const network = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    expect(
      await searchMemories({ connection: CONNECTION, query: "x", project: null, fetchImpl: network }),
    ).toEqual({ ok: false, reason: "network" });

    const http = (async () => jsonResponse({}, 500)) as typeof fetch;
    expect(
      await searchMemories({ connection: CONNECTION, query: "x", project: null, fetchImpl: http }),
    ).toEqual({ ok: false, reason: "http", status: 500 });

    const bad = (async () => jsonResponse({ hits: "nope" })) as typeof fetch;
    expect(
      await searchMemories({ connection: CONNECTION, query: "x", project: null, fetchImpl: bad }),
    ).toEqual({ ok: false, reason: "bad-response" });
  });
});

describe("recallForMessages", () => {
  const human = (text: string, kind = "user"): MessageLike => ({
    id: "m1",
    role: "user",
    content: [{ type: "text", text }],
    source: { kind },
  });

  it("取最後一則真人訊息，忽略 runtime-context", () => {
    const messages = [human("舊問題"), human("runtime 內容", "runtime-context"), human("新問題")];
    expect(latestHumanMessage(messages)?.content).toEqual([{ type: "text", text: "新問題" }]);
  });

  it("注入完整區塊", async () => {
    const fetchImpl = (async () =>
      jsonResponse({ hits: [hit("使用者偏好深色模式")], degraded: false })) as typeof fetch;
    const result = await recallForMessages({
      messages: [human("我們之前說偏好什麼主題？")],
      connection: CONNECTION,
      project: "mnemoshelf",
      now: new Date("2026-10-28T10:00:00.000Z"),
      fetchImpl,
    });
    expect(result.skip).toBeNull();
    expect(result.block).toContain("使用者偏好深色模式");
    expect(result.chars).toBeLessThanOrEqual(900);
  });

  it("degraded 不注入", async () => {
    const fetchImpl = (async () =>
      jsonResponse({ hits: [hit("x")], degraded: true })) as typeof fetch;
    const result = await recallForMessages({
      messages: [human("問題")],
      connection: CONNECTION,
      project: null,
      fetchImpl,
    });
    expect(result).toMatchObject({ block: "", skip: "degraded" });
  });

  it("空召回不注入", async () => {
    const fetchImpl = (async () => jsonResponse({ hits: [], degraded: false })) as typeof fetch;
    const result = await recallForMessages({
      messages: [human("問題")],
      connection: CONNECTION,
      project: null,
      fetchImpl,
    });
    expect(result).toMatchObject({ block: "", skip: "no-hits" });
  });

  it("最新訊息已含 Mnemoshelf 區塊時不重複注入", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ hits: [], degraded: false }));
    const result = await recallForMessages({
      messages: [human(`${BLOCK_MARKER} trust="untrusted">\n- 舊記憶\n</memory-context>`)],
      connection: CONNECTION,
      project: null,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result).toMatchObject({ block: "", skip: "already" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("沒有真人訊息時不查服務", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ hits: [], degraded: false }));
    const result = await recallForMessages({
      messages: [human("runtime", "runtime-context")],
      connection: CONNECTION,
      project: null,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result).toMatchObject({ block: "", skip: "no-user" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("查詢失敗 fail-open（不拋錯、不注入）", async () => {
    const fetchImpl = (async () => {
      throw new Error("offline");
    }) as typeof fetch;
    const result = await recallForMessages({
      messages: [human("問題")],
      connection: CONNECTION,
      project: null,
      fetchImpl,
    });
    expect(result).toMatchObject({ block: "", skip: "network" });
  });
});
