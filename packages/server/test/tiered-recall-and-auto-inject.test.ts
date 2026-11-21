/**
 * Issue #22 P2：精煉記憶優先分層排序、自動注入模式（REST／召回通道）與 Hook 護欄的測試。
 *
 * 一律用可控 embedder（查詢固定 [1,0]；文件內含 `[[cos:0.xx]]` 標記時，向量的 cosine 即為該值）
 * 與合成資料，不讀取任何使用者檔案。
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type {
  DocumentInput,
  EmbedDocumentsOptions,
  Embedder,
  EmbedderInfo,
  ImageInput,
  MemoryAutoInjectSettings,
  ProbeResult,
} from "@mnemoshelf/core";
import { api, errorName, startTestServer, TEST_TOKEN, type TestServer } from "./helpers.js";
import { REFINED_SEMANTIC_BOOST, type MemoryRecallResponseBody } from "../src/index.js";
import { runStdio } from "../src/index.js";
import { recallForPrompt, shouldSkipAutoRecallPrompt } from "../src/scripts/hook-core.js";

/** 可控 embedder：`[[cos:0.70]]` → 與查詢 [1,0] 的 cosine＝0.70；無標記 → [0.7,0.7]。 */
class TierEmbedder implements Embedder {
  readonly info: EmbedderInfo = {
    id: "tier-embedder@test",
    dim: 2,
    capabilities: { text: true, image: true, audio: false, video: false },
  };
  queryCalls = 0;
  failQuery = false;

  async embedQuery(): Promise<Float32Array> {
    this.queryCalls += 1;
    if (this.failQuery) throw new Error("模擬 embedder 查詢失敗");
    return new Float32Array([1, 0]);
  }

  async embedDocument(text: string): Promise<Float32Array> {
    const match = /\[\[cos:([0-9.]+)\]\]/.exec(text);
    if (match === null) return new Float32Array([0.7, 0.7]);
    const cos = Number(match[1]);
    return new Float32Array([cos, Math.sqrt(1 - cos * cos)]);
  }

  async embedDocuments(inputs: readonly DocumentInput[], _opts?: EmbedDocumentsOptions): Promise<Float32Array[]> {
    return await Promise.all(inputs.map((input) => this.embedDocument(input.text)));
  }

  async embedImage(_image: ImageInput): Promise<Float32Array> {
    return new Float32Array([1, 0]);
  }

  async probe(): Promise<ProbeResult> {
    return { ok: true, message: "測試用 embedder" };
  }

  async dispose(): Promise<void> {
    // 無資源。
  }
}

const PROJECT = "tier-lab";

let server: TestServer | undefined;
let embedder: TierEmbedder;

beforeEach(() => {
  embedder = new TierEmbedder();
});

afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function start(): Promise<TestServer["instance"]> {
  server = await startTestServer({ embedder });
  return server.instance;
}

/** 新增精煉記憶（`legacy-memory`，無 sourceId）。 */
async function addRefined(instance: TestServer["instance"], content: string): Promise<number> {
  const response = await api(instance, "POST", "/memories", {
    body: { agent: "tier-agent", scope: "project", project: PROJECT, content },
  });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return (response.body as { id: number }).id;
}

let turnCounter = 0;
/** 新增一則原文（raw-turn），回傳其記憶 id（單一訊息短內容＝單一 chunk）。 */
async function addRaw(instance: TestServer["instance"], content: string): Promise<number> {
  turnCounter += 1;
  const response = await api(instance, "POST", "/memory-sources", {
    body: {
      agent: "tier-agent",
      scope: "project",
      project: PROJECT,
      sourceSession: "session-tier",
      sourceTurn: `turn-${turnCounter}`,
      messages: [{ sourceMessage: `message-${turnCounter}`, role: "user", content, occurredAt: null }],
    },
  });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  const { memoryIds } = response.body as { memoryIds: number[] };
  expect(memoryIds).toHaveLength(1);
  return memoryIds[0]!;
}

async function waitForReady(instance: TestServer["instance"], count: number): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const response = await api(instance, "GET", "/diagnostics");
    const memories = (response.body as { memories?: { ready?: number } }).memories;
    if ((memories?.ready ?? 0) >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`等待 ${count} 筆記憶就緒逾時`);
}

async function recall(
  instance: TestServer["instance"],
  extra: Record<string, unknown> = {},
): Promise<MemoryRecallResponseBody & { hits: Array<{ id: number; score: number; sourceType: string; source: string }> }> {
  const response = await api(instance, "POST", "/memories/search", {
    body: { query: "alpha query", project: PROJECT, k: 10, ...extra },
  });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body as never;
}

const ids = (result: { hits: Array<{ id: number }> }): number[] => result.hits.map((hit) => hit.id);

describe("精煉記憶優先分層排序", () => {
  it("精煉 0.70 贏過 raw-turn 0.76，且回傳原始未加權 score", async () => {
    const instance = await start();
    const raw = await addRaw(instance, "raw 長篇雜訊 [[cos:0.76]]");
    const refined = await addRefined(instance, "refined 精煉結論 [[cos:0.70]]");
    await waitForReady(instance, 2);

    expect(0.70 + REFINED_SEMANTIC_BOOST).toBeGreaterThan(0.76);
    const result = await recall(instance);
    expect(ids(result)).toEqual([refined, raw]);
    expect(result.hits[0]!.score).toBeCloseTo(0.70, 4);
    expect(result.hits[1]!.score).toBeCloseTo(0.76, 4);
    expect(result.hits.map((hit) => hit.rank)).toEqual([1, 2]);
  });

  it("高相關 raw-turn 0.90 仍贏過精煉 0.65", async () => {
    const instance = await start();
    const refined = await addRefined(instance, "refined 低相關 [[cos:0.65]]");
    const raw = await addRaw(instance, "raw 高相關 [[cos:0.90]]");
    await waitForReady(instance, 2);
    expect(ids(await recall(instance))).toEqual([raw, refined]);
  });

  it("preferRefined=false 關閉加權，維持純 cosine 排序", async () => {
    const instance = await start();
    const raw = await addRaw(instance, "raw 雜訊 [[cos:0.76]]");
    const refined = await addRefined(instance, "refined 結論 [[cos:0.70]]");
    await waitForReady(instance, 2);
    expect(ids(await recall(instance, { preferRefined: false }))).toEqual([raw, refined]);
    expect(ids(await recall(instance, { preferRefined: true }))).toEqual([refined, raw]);
  });

  it("純精煉與純 raw-turn 集合的相對順序不變；pinned 不影響排序", async () => {
    const instance = await start();
    const refinedLow = await addRefined(instance, "refined 低 [[cos:0.60]]");
    const refinedHigh = await addRefined(instance, "refined 高 [[cos:0.80]]");
    const rawLow = await addRaw(instance, "raw 低 [[cos:0.50]]");
    const rawHigh = await addRaw(instance, "raw 高 [[cos:0.70]]");
    await waitForReady(instance, 4);
    // 釘選較低分的精煉記憶：不得因此排到較高分之前。
    expect((await api(instance, "POST", `/memories/${refinedLow}/pin`, { body: {} })).status).toBe(200);

    const result = await recall(instance);
    const refinedOrder = ids(result).filter((id) => [refinedLow, refinedHigh].includes(id));
    const rawOrder = ids(result).filter((id) => [rawLow, rawHigh].includes(id));
    expect(refinedOrder).toEqual([refinedHigh, refinedLow]);
    expect(rawOrder).toEqual([rawHigh, rawLow]);
    // 加權鍵：refinedHigh 0.88、rawHigh 0.70、refinedLow 0.68、rawLow 0.50。
    expect(ids(result)).toEqual([refinedHigh, rawHigh, refinedLow, rawLow]);
    expect(result.hits.map((hit) => Number(hit.score.toFixed(2)))).toEqual([0.8, 0.7, 0.6, 0.5]);
  });

  it("sourceKind=memory／raw-turn 先過濾再排名；all 不過濾", async () => {
    const instance = await start();
    const raw = await addRaw(instance, "raw 雜訊 [[cos:0.90]]");
    const refined = await addRefined(instance, "refined 結論 [[cos:0.60]]");
    await waitForReady(instance, 2);
    expect(ids(await recall(instance, { sourceKind: "memory" }))).toEqual([refined]);
    expect(ids(await recall(instance, { sourceKind: "raw-turn" }))).toEqual([raw]);
    expect(ids(await recall(instance, { sourceKind: "all" })).sort()).toEqual([raw, refined].sort());
  });

  it("關鍵字降級路徑也做分層：精煉名次 ×0.7，score 維持 1/rank", async () => {
    const instance = await start();
    // 以重複詞頻讓 FTS 名次依序為 A > B > C > D（D 為精煉記憶）。
    const a = await addRaw(instance, "zebra zebra zebra zebra zebra zebra");
    const b = await addRaw(instance, "zebra zebra zebra zebra zebra filler1");
    const c = await addRaw(instance, "zebra zebra zebra zebra filler1 filler2");
    const d = await addRefined(instance, "zebra zebra zebra filler1 filler2 filler3");
    await waitForReady(instance, 4);
    embedder.failQuery = true;

    const plain = await recall(instance, { query: "zebra", preferRefined: false });
    expect(plain.degraded).toBe(true);
    expect(plain.degradedReason).toBe("embedder-unavailable");
    expect(ids(plain)).toEqual([a, b, c, d]);

    const tiered = await recall(instance, { query: "zebra" });
    expect(tiered.degraded).toBe(true);
    // D 原名次 4 → 有效名次 2.8，排到 C（3）之前。
    expect(ids(tiered)).toEqual([a, b, d, c]);
    const dHit = tiered.hits.find((hit) => hit.id === d)!;
    expect(dHit.source).toBe("keyword");
    expect(dHit.score).toBeCloseTo(1 / 4, 6);
  });
});

describe("GET／PATCH /memory-auto-inject", () => {
  it("預設 all；更新 defaultMode、多專案覆寫、局部 patch 保留其他專案、null 移除覆寫", async () => {
    const instance = await start();
    const initial = await api(instance, "GET", "/memory-auto-inject");
    expect(initial.status).toBe(200);
    const settings0 = initial.body as MemoryAutoInjectSettings;
    expect(settings0).toMatchObject({ defaultMode: "all", projects: {} });

    const step1 = await api(instance, "PATCH", "/memory-auto-inject", {
      body: { expectedRevision: settings0.revision, defaultMode: "refined-only" },
    });
    expect(step1.status).toBe(200);
    const settings1 = step1.body as MemoryAutoInjectSettings;
    expect(settings1).toMatchObject({ defaultMode: "refined-only", projects: {}, revision: settings0.revision + 1 });

    const step2 = await api(instance, "PATCH", "/memory-auto-inject", {
      body: { expectedRevision: settings1.revision, projects: { alpha: "off", beta: "refined-only" } },
    });
    const settings2 = step2.body as MemoryAutoInjectSettings;
    expect(settings2).toMatchObject({ defaultMode: "refined-only", projects: { alpha: "off", beta: "refined-only" } });

    // 局部 patch：只動 gamma，alpha／beta 不得被抹除。
    const step3 = await api(instance, "PATCH", "/memory-auto-inject", {
      body: { expectedRevision: settings2.revision, projects: { gamma: "all" } },
    });
    const settings3 = step3.body as MemoryAutoInjectSettings;
    expect(settings3.projects).toEqual({ alpha: "off", beta: "refined-only", gamma: "all" });

    // null 移除覆寫。
    const step4 = await api(instance, "PATCH", "/memory-auto-inject", {
      body: { expectedRevision: settings3.revision, projects: { alpha: null } },
    });
    const settings4 = step4.body as MemoryAutoInjectSettings;
    expect(settings4.projects).toEqual({ beta: "refined-only", gamma: "all" });
    expect((await api(instance, "GET", "/memory-auto-inject")).body).toEqual(settings4);
  });

  it("未知欄位／非法值 → 400；過期 expectedRevision → 409；未帶 token → 401；非法方法 → 405", async () => {
    const instance = await start();
    const current = (await api(instance, "GET", "/memory-auto-inject")).body as MemoryAutoInjectSettings;
    const patch = (body: unknown) => api(instance, "PATCH", "/memory-auto-inject", { body });

    const unknown = await patch({ expectedRevision: current.revision, defaultMode: "all", extra: 1 });
    expect(unknown.status).toBe(400);
    expect(errorName(unknown.body)).toBe("ValidationError");
    expect((await patch({ defaultMode: "off" })).status).toBe(400);
    expect((await patch({ expectedRevision: current.revision, defaultMode: "bogus" })).status).toBe(400);
    expect((await patch({ expectedRevision: current.revision, projects: { a: "bogus" } })).status).toBe(400);
    expect((await patch({ expectedRevision: current.revision, projects: ["a"] })).status).toBe(400);
    // 沒有任何可變更欄位（store 層 TypeError → 400）。
    expect((await patch({ expectedRevision: current.revision })).status).toBe(400);
    expect((await patch({ expectedRevision: current.revision, projects: { "  ": "off" } })).status).toBe(400);

    const ok = await patch({ expectedRevision: current.revision, defaultMode: "off" });
    expect(ok.status).toBe(200);
    const stale = await patch({ expectedRevision: current.revision, defaultMode: "all" });
    expect(stale.status).toBe(409);

    expect((await api(instance, "GET", "/memory-auto-inject", { token: null })).status).toBe(401);
    expect((await api(instance, "PATCH", "/memory-auto-inject", { token: null, body: {} })).status).toBe(401);
    expect((await api(instance, "DELETE", "/memory-auto-inject")).status).toBe(405);
    expect((await api(instance, "GET", "/memory-auto-inject/extra")).status).toBe(404);
  });

  it("POST /memories/search 新欄位驗證：channel／sourceKind／preferRefined", async () => {
    const instance = await start();
    const bad = (body: Record<string, unknown>) =>
      api(instance, "POST", "/memories/search", { body: { query: "x", project: PROJECT, ...body } });
    expect((await bad({ channel: "bogus" })).status).toBe(400);
    expect((await bad({ channel: 1 })).status).toBe(400);
    expect((await bad({ sourceKind: "bogus" })).status).toBe(400);
    expect((await bad({ preferRefined: "yes" })).status).toBe(400);
    for (const body of [{ channel: "auto" }, { channel: "manual" }, { sourceKind: "raw-turn" }, { preferRefined: false }]) {
      expect((await bad(body)).status).toBe(200);
    }
  });
});

async function setMode(
  instance: TestServer["instance"],
  patch: { defaultMode?: string; projects?: Record<string, string | null> },
): Promise<void> {
  const current = (await api(instance, "GET", "/memory-auto-inject")).body as MemoryAutoInjectSettings;
  const response = await api(instance, "PATCH", "/memory-auto-inject", {
    body: { expectedRevision: current.revision, ...patch },
  });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
}

describe("channel=auto 與自動注入模式", () => {
  it("專案 off：auto 在 embedQuery 前短路；manual 與 MCP search_memories 仍正常召回", async () => {
    const instance = await start();
    const refined = await addRefined(instance, "refined 結論 [[cos:0.80]]");
    const raw = await addRaw(instance, "raw 原文 [[cos:0.90]]");
    await waitForReady(instance, 2);
    await setMode(instance, { projects: { [PROJECT]: "off" } });

    embedder.queryCalls = 0;
    const auto = await recall(instance, { channel: "auto" });
    expect(embedder.queryCalls).toBe(0);
    expect(auto).toMatchObject({
      hits: [],
      degraded: false,
      degradedReason: null,
      autoInjectSuppressed: true,
      query: "alpha query",
      k: 10,
    });
    expect(typeof auto.policyVersion).toBe("number");
    expect(typeof auto.recallVersion).toBe("number");
    expect(auto.memoryEmbedding.ready).toBeGreaterThanOrEqual(2);

    const manual = await recall(instance, { channel: "manual" });
    expect(embedder.queryCalls).toBe(1);
    expect(manual.autoInjectSuppressed).toBeUndefined();
    expect(ids(manual).sort()).toEqual([raw, refined].sort());
    // 未帶 channel 等同 manual。
    expect(ids(await recall(instance)).sort()).toEqual([raw, refined].sort());

    // 其他專案不受影響（走全域預設 all）。
    const other = await api(instance, "POST", "/memories/search", {
      body: { query: "alpha query", scope: "global", channel: "auto" },
    });
    expect((other.body as MemoryRecallResponseBody).autoInjectSuppressed).toBeUndefined();
  });

  it("MCP search_memories 不帶 channel：專案 off 時仍可召回", async () => {
    server = await startTestServer({ embedder });
    const instance = server.instance;
    await api(instance, "POST", "/memories", {
      body: { agent: "tier-agent", scope: "project", project: PROJECT, content: "mcp refined [[cos:0.80]]" },
    });
    await waitForReady(instance, 1);
    await setMode(instance, { projects: { [PROJECT]: "off" } });

    const clientToServer = new PassThrough();
    const serverToClient = new PassThrough();
    const started = await runStdio({
      env: { MNEMOSHELF_URL: instance.url, MNEMOSHELF_TOKEN: TEST_TOKEN, MNEMOSHELF_PROJECT: PROJECT },
      stdin: clientToServer,
      stdout: serverToClient,
    });
    const client = new Client({ name: "tier-client", version: "0.0.0" });
    await client.connect(new StdioServerTransport(serverToClient, clientToServer));
    try {
      const result = await client.callTool({ name: "search_memories", arguments: { query: "mcp refined" } });
      expect((result as { isError?: boolean }).isError).toBeFalsy();
      const text = ((result as { content: Array<{ text: string }> }).content[0]!).text;
      const body = JSON.parse(text) as MemoryRecallResponseBody;
      expect(body.autoInjectSuppressed).toBeUndefined();
      expect(body.hits).toHaveLength(1);
    } finally {
      await client.close();
      await started.server.close();
    }
  });

  it("refined-only：auto 只回精煉記憶；manual 兩者都回；auto+raw-turn 直接短路", async () => {
    const instance = await start();
    const refined = await addRefined(instance, "refined 結論 [[cos:0.70]]");
    const raw = await addRaw(instance, "raw 原文 [[cos:0.90]]");
    await waitForReady(instance, 2);
    await setMode(instance, { projects: { [PROJECT]: "refined-only" } });

    const auto = await recall(instance, { channel: "auto" });
    expect(ids(auto)).toEqual([refined]);
    expect(auto.autoInjectSuppressed).toBeUndefined();

    const manual = await recall(instance, { channel: "manual" });
    expect(ids(manual).sort()).toEqual([raw, refined].sort());

    embedder.queryCalls = 0;
    const rawAuto = await recall(instance, { channel: "auto", sourceKind: "raw-turn" });
    expect(embedder.queryCalls).toBe(0);
    expect(rawAuto).toMatchObject({ hits: [], autoInjectSuppressed: true, degraded: false, degradedReason: null });
  });

  it("全域預設 off 對沒有覆寫的專案生效；專案覆寫 all 可例外開啟", async () => {
    const instance = await start();
    const refined = await addRefined(instance, "refined 結論 [[cos:0.70]]");
    await waitForReady(instance, 1);
    await setMode(instance, { defaultMode: "off" });
    expect((await recall(instance, { channel: "auto" })).autoInjectSuppressed).toBe(true);
    await setMode(instance, { projects: { [PROJECT]: "all" } });
    const result = await recall(instance, { channel: "auto" });
    expect(result.autoInjectSuppressed).toBeUndefined();
    expect(ids(result)).toEqual([refined]);
  });
});

describe("hook-core：shouldSkipAutoRecallPrompt", () => {
  it.each([
    ["", true],
    ["   \n ", true],
    ["/compact", true],
    ["/clear", true],
    ["  /clear  ", true],
    ["/plan 我想推進到p2", false],
    ["OK", true],
    ["好", true],
    ["繼續", true],
    ["方案A", true],
    ["五個字元啊", true],
    ["六個字元啊啊", false],
    ["還記得嗎", false],
    ["上次呢", false],
    ["remember?", false],
    ["Recall", false],
    ["last time", false],
    ["請問架構如何設計？", false],
    ["😀😀😀😀😀", true],
    ["😀😀😀😀😀😀", false],
  ])("%j → %s", (prompt, expected) => {
    expect(shouldSkipAutoRecallPrompt(prompt)).toBe(expected);
  });
});

describe("hook-core：recallForPrompt 的 channel 與 MNEMOSHELF_AUTO_INJECT", () => {
  const baseUrl = "http://127.0.0.1:4399";
  const credential = ["synthetic", "tier", "token"].join("-");
  let tempDir: string;
  let runtimeFile: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "mnemoshelf-tier-hook-test-"));
    runtimeFile = path.join(tempDir, "runtime.json");
    await writeFile(
      runtimeFile,
      JSON.stringify({
        schemaVersion: 1,
        url: baseUrl,
        token: credential,
        pid: process.pid,
        startedAt: "2026-11-13T00:00:00.000Z",
        appVersion: "0.9.1",
      }),
    );
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  function mockFetch() {
    return vi.fn<typeof fetch>().mockImplementation(async (url) => {
      if (url === `${baseUrl}/health`) return Response.json({ service: "mnemoshelf" });
      if (url === `${baseUrl}/memories/search`) {
        return Response.json({
          degraded: false,
          policyVersion: 1,
          hits: [{ source: "semantic", scope: "global", kind: "fact", score: 0.9, content: "合成記憶" }],
        });
      }
      throw new Error(`unexpected url: ${String(url)}`);
    });
  }

  const searchBodies = (fetchImpl: ReturnType<typeof mockFetch>): Array<Record<string, unknown>> =>
    fetchImpl.mock.calls
      .filter(([url]) => url === `${baseUrl}/memories/search`)
      .map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>);

  const run = (prompt: string, env: NodeJS.ProcessEnv, fetchImpl: typeof fetch) =>
    recallForPrompt({ prompt, env: { MNEMOSHELF_RUNTIME_FILE: runtimeFile, ...env }, fetchImpl });

  it("預設送出 channel=auto，且不帶 sourceKind", async () => {
    const fetchImpl = mockFetch();
    const block = await run("請問這個專案的架構如何？", {}, fetchImpl);
    expect(block).toContain("合成記憶");
    const bodies = searchBodies(fetchImpl);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ channel: "auto" });
    expect(bodies[0]).not.toHaveProperty("sourceKind");
  });

  it("MNEMOSHELF_AUTO_INJECT=off：完全不發 HTTP（含 health）", async () => {
    for (const value of ["off", " OFF "]) {
      const fetchImpl = mockFetch();
      expect(await run("請問這個專案的架構如何？", { MNEMOSHELF_AUTO_INJECT: value }, fetchImpl)).toBeNull();
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  });

  it("MNEMOSHELF_AUTO_INJECT=refined-only：搜尋 body 附加 sourceKind=memory", async () => {
    const fetchImpl = mockFetch();
    await run("請問這個專案的架構如何？", { MNEMOSHELF_AUTO_INJECT: "Refined-Only" }, fetchImpl);
    expect(searchBodies(fetchImpl)[0]).toMatchObject({ channel: "auto", sourceKind: "memory" });
  });

  it("寒暄與純 slash 指令不發 HTTP；有記憶線索詞的短提示仍召回", async () => {
    for (const prompt of ["OK", "繼續", "/compact", "   "]) {
      const fetchImpl = mockFetch();
      expect(await run(prompt, {}, fetchImpl)).toBeNull();
      expect(fetchImpl).not.toHaveBeenCalled();
    }
    const fetchImpl = mockFetch();
    await run("還記得嗎", {}, fetchImpl);
    expect(searchBodies(fetchImpl)).toHaveLength(1);
  });
});
