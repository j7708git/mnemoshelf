/**
 * 卡 B2（記憶語意召回）的 REST 測試：
 *
 * 1. `POST /memories/search` 的驗證與 400 邊界、405／401。
 * 2. 語意不可用時的降級（`no-embeddings`／`embedder-unavailable`）與 bucket 過濾。
 * 3. 語意召回：排序／score／source、`minScore`、關鍵字補足、`includeAllProjects`、agent 範圍。
 * 4. 既有 `/memories` 與 `/search` 不回歸。
 *
 * 一律用可控 embedder（2 維「主題空間」）與合成資料，不讀取任何使用者檔案。
 */
import { afterEach, describe, expect, it } from "vitest";
import type {
  DocumentInput,
  EmbedDocumentsOptions,
  Embedder,
  EmbedderInfo,
  ImageInput,
  ProbeResult,
} from "@mnemoshelf/core";
import {
  api,
  errorName,
  makeTempDir,
  removeTempDir,
  startTestServer,
  TEST_TOKEN,
  type TestServer,
} from "./helpers.js";
import { createServer, type MemoryRecallResponseBody, type MnemoshelfServer } from "../src/index.js";

/**
 * 可控的 2 維 embedder：文件內容含 apple→[1,0]、banana→[0,1]、其他→[0.7,0.7]；查詢固定 [1,0]。
 * 可指定 `id`（模擬換 embedder 造成 stale），也可讓 `embedDocument` 卡住（驗證回填完成前的降級）。
 */
class RecallEmbedder implements Embedder {
  readonly info: EmbedderInfo;
  /** 讓 `embedQuery` 失敗（模擬模型載入／推論失敗）。 */
  failQuery = false;
  /** 自訂 `embedQuery` 的失敗錯誤（例如 input-too-long）。 */
  queryError: Error | undefined;
  /** `embedQuery` 被呼叫的次數（驗證降級時是否跳過模型）。 */
  queryCalls = 0;
  /** true 時 `embedDocument` 會停住，直到測試呼叫 `releaseDocument()`。 */
  readonly gateDocuments: boolean;
  releaseDocument: (() => void) | undefined;

  constructor(options: { id?: string; gateDocuments?: boolean } = {}) {
    this.info = {
      id: options.id ?? "recall-embedder@test",
      dim: 2,
      capabilities: { text: true, image: true, audio: false, video: false },
    };
    this.gateDocuments = options.gateDocuments === true;
  }

  async embedQuery(): Promise<Float32Array> {
    this.queryCalls += 1;
    if (this.failQuery) throw this.queryError ?? new Error("模擬 embedder 查詢失敗");
    return new Float32Array([1, 0]);
  }

  async embedDocument(text: string): Promise<Float32Array> {
    if (this.gateDocuments) {
      await new Promise<void>((resolve) => {
        this.releaseDocument = () => resolve();
      });
    }
    if (text.includes("apple")) return new Float32Array([1, 0]);
    if (text.includes("banana")) return new Float32Array([0, 1]);
    return new Float32Array([0.7, 0.7]);
  }

  async embedDocuments(inputs: readonly DocumentInput[], _opts?: EmbedDocumentsOptions): Promise<Float32Array[]> {
    const vectors: Float32Array[] = [];
    for (const input of inputs) vectors.push(await this.embedDocument(input.text));
    return vectors;
  }

  async embedImage(_image: ImageInput): Promise<Float32Array> {
    return new Float32Array([1, 0]);
  }

  async probe(): Promise<ProbeResult> {
    return { ok: true, message: "測試用 embedder（無語意）" };
  }

  async dispose(): Promise<void> {
    // 無資源。
  }
}

/** 永遠無法嵌入的 embedder：讓記憶的 `ready` 一直是 0 → 觸發 `no-embeddings` 降級。 */
class BrokenEmbedder implements Embedder {
  readonly info: EmbedderInfo = {
    id: "broken-embedder@test",
    dim: 2,
    capabilities: { text: true, image: true, audio: false, video: false },
  };

  async embedQuery(): Promise<Float32Array> {
    throw new Error("模型無法載入");
  }

  async embedDocument(): Promise<Float32Array> {
    throw new Error("模型無法載入");
  }

  async embedDocuments(): Promise<Float32Array[]> {
    throw new Error("模型無法載入");
  }

  async embedImage(): Promise<Float32Array> {
    throw new Error("模型無法載入");
  }

  async probe(): Promise<ProbeResult> {
    return { ok: false, message: "模擬損壞" };
  }

  async dispose(): Promise<void> {
    // 無資源。
  }
}

let server: TestServer | undefined;
/** 需要跨重啟測試的額外 server／暫存資料目錄（afterEach 統一清理）。 */
const extraServers: MnemoshelfServer[] = [];
const extraDirs: string[] = [];

afterEach(async () => {
  while (extraServers.length > 0) await extraServers.pop()!.close();
  for (const dir of extraDirs.splice(0)) await removeTempDir(dir);
  await server?.close();
  server = undefined;
});

/** 新增一筆記憶（回傳完整記憶）。 */
async function createMemory(instance: TestServer["instance"], body: Record<string, unknown>): Promise<{ id: number }> {
  const response = await api(instance, "POST", "/memories", { body: { agent: "agent-recall", ...body } });
  expect(response.status).toBe(201);
  return response.body as { id: number };
}

/** 輪詢到指定筆數的記憶向量就緒。 */
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

/** 呼叫記憶召回；回傳狀態與（成功時的）完整回應。 */
async function search(
  instance: TestServer["instance"],
  body: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> {
  return await api(instance, "POST", "/memories/search", { body });
}

function ids(result: { hits: { id: number }[] }): number[] {
  return result.hits.map((hit) => hit.id);
}

describe("POST /memories/search：驗證與路由", () => {
  it("缺少 query／非法 k／minScore／scope／kind → 400 ValidationError", async () => {
    server = await startTestServer();
    const badBodies: Record<string, unknown>[] = [
      {},
      { query: "" },
      { query: "   " },
      { query: "x", k: 0 },
      { query: "x", k: -1 },
      { query: "x", k: 1.5 },
      { query: "x", k: "3" },
      { query: "x", minScore: -0.1 },
      { query: "x", minScore: 1.1 },
      { query: "x", minScore: "0.5" },
      { query: "x", scope: "bogus" },
      { query: "x", scope: null },
      { query: "x", kind: "bogus" },
      { query: "x", project: 42 },
    ];
    for (const body of badBodies) {
      const response = await search(server.instance, body);
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(errorName(response.body)).toBe("ValidationError");
    }
  });

  it("召回範圍不明確 → 400（無 project 且未 includeAllProjects；scope=agent 缺 agent；scope=project 缺 project）", async () => {
    server = await startTestServer();
    for (const body of [
      { query: "x" },
      { query: "x", project: "   " },
      { query: "x", scope: "agent" },
      { query: "x", scope: "project" },
      { query: "x", scope: "project", project: "" },
    ]) {
      const response = await search(server.instance, body);
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(errorName(response.body)).toBe("ValidationError");
    }
  });

  it("GET /memories/search → 405（Allow POST）；無 token → 401", async () => {
    server = await startTestServer();
    const notAllowed = await api(server.instance, "GET", "/memories/search");
    expect(notAllowed.status).toBe(405);
    expect(notAllowed.headers.get("allow")).toBe("POST");

    const noToken = await api(server.instance, "POST", "/memories/search", { body: { query: "x" }, token: null });
    expect(noToken.status).toBe(401);
    expect(errorName(noToken.body)).toBe("UnauthorizedError");
  });

  it("既有記憶端點與 /search 不回歸", async () => {
    server = await startTestServer();
    expect((await api(server.instance, "GET", "/memories")).status).toBe(200);
    expect(
      (await api(server.instance, "POST", "/search", { body: { query: "x", mode: "keyword" } })).status,
    ).toBe(200);
    // `/memories/:id` 的既有路由不受 `/memories/search` 影響（GET 非既有方法 → 405；PATCH 共享開關仍可用）。
    const memory = await createMemory(server.instance, { content: "回歸測試記憶" });
    expect((await api(server.instance, "GET", `/memories/${memory.id}`)).status).toBe(405);
    expect((await api(server.instance, "PATCH", `/memories/${memory.id}`, { body: { scope: "global" } })).status).toBe(200);
  });
});

describe("POST /memories/search：降級（語意不可用）", () => {
  it("ready=0 → degraded/no-embeddings，改用關鍵字且 bucket 過濾仍生效", async () => {
    server = await startTestServer({
      embedder: new BrokenEmbedder(),
      memoryEmbedding: { retryAttempts: 0, retryDelayMs: 0 },
    });
    const instance = server.instance;

    const global = await createMemory(instance, { content: "召回 apple 全域", scope: "global" });
    const proj = await createMemory(instance, {
      content: "召回 apple 本專案",
      scope: "project",
      project: "proj-recall",
    });
    const otherProject = await createMemory(instance, {
      content: "召回 apple 其他專案",
      scope: "project",
      project: "proj-other",
    });
    const agentScope = await createMemory(instance, {
      content: "召回 apple agent 範圍",
      scope: "agent",
      agent: "recall-agent-x",
    });

    const result = await search(instance, { query: "apple", project: "proj-recall" });
    expect(result.status).toBe(200);
    const body = result.body as MemoryRecallResponseBody;
    expect(body.degraded).toBe(true);
    expect(body.degradedReason).toBe("no-embeddings");
    expect(body.memoryEmbedding.ready).toBe(0);
    expect(new Set(ids(body))).toEqual(new Set([global.id, proj.id]));
    for (const hit of body.hits) {
      expect(hit.source).toBe("keyword");
      expect(hit.score).toBeGreaterThan(0);
    }

    // 有明確 agent 才納入 agent 範圍。
    const withAgent = await search(instance, { query: "apple", project: "proj-recall", agent: "recall-agent-x" });
    expect(new Set(ids(withAgent.body as MemoryRecallResponseBody))).toEqual(
      new Set([global.id, proj.id, agentScope.id]),
    );
    // includeAllProjects 跨專案（但不含 agent，因為沒提供 agent）。
    const allProjects = await search(instance, { query: "apple", includeAllProjects: true });
    expect(new Set(ids(allProjects.body as MemoryRecallResponseBody))).toEqual(
      new Set([global.id, proj.id, otherProject.id]),
    );
    // 明確 scope=global 只回全域。
    const globalOnly = await search(instance, { query: "apple", scope: "global" });
    expect(ids(globalOnly.body as MemoryRecallResponseBody)).toEqual([global.id]);
  });

  it("ready>0 但 embedQuery 失敗 → degraded/embedder-unavailable + 關鍵字", async () => {
    const embedder = new RecallEmbedder();
    server = await startTestServer({ embedder, memoryEmbedding: { retryDelayMs: 0 } });
    const instance = server.instance;
    const memory = await createMemory(instance, { content: "apple 召回降級", project: "proj-recall" });
    await waitForReady(instance, 1);

    embedder.failQuery = true;
    const result = await search(instance, { query: "apple", project: "proj-recall" });
    const body = result.body as MemoryRecallResponseBody;
    expect(result.status).toBe(200);
    expect(body.degraded).toBe(true);
    expect(body.degradedReason).toBe("embedder-unavailable");
    expect(ids(body)).toContain(memory.id);
    expect(body.hits.every((hit) => hit.source === "keyword")).toBe(true);
  });

  it("ready 全部 stale（換 embedder、回填完成前）→ degraded/no-embeddings 且不呼叫 embedQuery（O2）", async () => {
    const dataDir = await makeTempDir("mnemoshelf-b2-stale-");
    extraDirs.push(dataDir);

    // 第一個 embedder 先把記憶嵌成 ready。
    const firstEmbedder = new RecallEmbedder({ id: "recall-embedder-a@test" });
    const first = await createServer({
      env: {},
      token: TEST_TOKEN,
      dataDir,
      port: 0,
      embedder: firstEmbedder,
      memoryEmbedding: { retryDelayMs: 0 },
    });
    try {
      const created = await api(first, "POST", "/memories", {
        body: { content: "apple stale 測試", agent: "agent-stale", scope: "global" },
      });
      expect(created.status).toBe(201);
      await waitForReady(first, 1);
    } finally {
      await first.close();
    }

    // 換一個 embedder（不同 info.id）重啟；卡住回填，讓狀態維持「ready 但全部 stale」。
    const secondEmbedder = new RecallEmbedder({ id: "recall-embedder-b@test", gateDocuments: true });
    const second = await createServer({
      env: {},
      token: TEST_TOKEN,
      dataDir,
      port: 0,
      embedder: secondEmbedder,
      memoryEmbedding: { retryDelayMs: 0 },
    });
    extraServers.push(second);
    try {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && secondEmbedder.releaseDocument === undefined) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(secondEmbedder.releaseDocument).toBeDefined();

      const response = await search(second, { query: "apple", scope: "global" });
      expect(response.status).toBe(200);
      const body = response.body as MemoryRecallResponseBody;
      expect(body.degraded).toBe(true);
      expect(body.degradedReason).toBe("no-embeddings");
      expect(body.memoryEmbedding.ready).toBe(1);
      expect(body.memoryEmbedding.stale).toBe(1);
      // 降級時不呼叫模型（若呼叫了會變成 embedder-unavailable）。
      expect(secondEmbedder.queryCalls).toBe(0);
      expect(body.hits.length).toBeGreaterThanOrEqual(1);
      expect(body.hits.every((hit) => hit.source === "keyword")).toBe(true);
    } finally {
      secondEmbedder.releaseDocument?.();
      secondEmbedder.releaseDocument = undefined;
      const index = extraServers.indexOf(second);
      if (index >= 0) extraServers.splice(index, 1);
      await second.close();
    }
  });

  it("O4：query 超過 embedder 輸入上限（input-too-long）→ 200 + degraded/embedder-unavailable + 關鍵字", async () => {
    const embedder = new RecallEmbedder();
    server = await startTestServer({ embedder, memoryEmbedding: { retryDelayMs: 0 } });
    const instance = server.instance;
    const memory = await createMemory(instance, { content: "apple 超長查詢降級", project: "proj-recall" });
    await waitForReady(instance, 1);

    embedder.failQuery = true;
    embedder.queryError = Object.assign(new Error("單筆輸入超過上限"), {
      name: "EmbedderInputError",
      code: "input-too-long",
    });
    const result = await search(instance, { query: "很長的查詢字串", project: "proj-recall" });
    expect(result.status).toBe(200); // 與 /search 的 400 不同：召回有降級路徑
    const body = result.body as MemoryRecallResponseBody;
    expect(body.degraded).toBe(true);
    expect(body.degradedReason).toBe("embedder-unavailable");
    expect(ids(body)).toContain(memory.id);
    expect(body.hits.every((hit) => hit.source === "keyword")).toBe(true);
  });
});

describe("POST /memories/search：語意召回", () => {
  /** 建立固定資料集並等待向量就緒。 */
  async function setupDataset(): Promise<{
    instance: TestServer["instance"];
    apple: number;
    banana: number;
    global: number;
    other: number;
  }> {
    server = await startTestServer({ embedder: new RecallEmbedder(), memoryEmbedding: { retryDelayMs: 0 } });
    const instance = server.instance;
    const apple = await createMemory(instance, {
      content: "apple 的決策內容",
      kind: "decision",
      scope: "project",
      project: "proj-recall",
    });
    const banana = await createMemory(instance, {
      content: "banana 的筆記內容",
      kind: "fact",
      scope: "project",
      project: "proj-recall",
    });
    const global = await createMemory(instance, { content: "apple 全域共享", scope: "global" });
    const other = await createMemory(instance, {
      content: "apple 其他專案",
      scope: "project",
      project: "proj-other",
    });
    await waitForReady(instance, 4);
    return { instance, apple: apple.id, banana: banana.id, global: global.id, other: other.id };
  }

  it("語意結果依 cosine 排序、score/source 正確、degraded=false", async () => {
    const { instance, apple, global, banana } = await setupDataset();
    const result = await search(instance, { query: "apple", project: "proj-recall" });
    const body = result.body as MemoryRecallResponseBody;

    expect(result.status).toBe(200);
    expect(body.degraded).toBe(false);
    expect(body.degradedReason).toBeNull();
    // apple 與 global 的向量都是 [1,0]（分數 1，同分依 id 升冪），banana 為 [0,1]（分數 0）。
    expect(ids(body)).toEqual([apple, global, banana]);
    expect(body.hits[0]!.score).toBeCloseTo(1, 5);
    expect(body.hits[2]!.score).toBeCloseTo(0, 5);
    expect(body.hits.every((hit) => hit.source === "semantic")).toBe(true);
    expect(body.hits.map((hit) => hit.rank)).toEqual([1, 2, 3]);
    // 完整記憶欄位（與 GET /memories 一致）。
    expect(body.hits[0]).toMatchObject({ id: apple, kind: "decision", scope: "project", project: "proj-recall" });
    expect(typeof body.hits[0]!.content).toBe("string");
    expect(body.memoryEmbedding.ready).toBeGreaterThanOrEqual(4);
  });

  it("minScore 只過濾語意結果；不足 k 時關鍵字補足且不重排語意結果", async () => {
    const { instance, apple, global, banana } = await setupDataset();
    const result = await search(instance, { query: "banana", project: "proj-recall", k: 3, minScore: 0.5 });
    const body = result.body as MemoryRecallResponseBody;

    // 語意：apple/global = [1,0] 對 query [1,0] 得分 1；banana = 0 被 minScore 過濾。
    // 關鍵字 "banana" 只命中 banana → 以 keyword 補足、附加在語意結果後、不重排。
    expect(ids(body)).toEqual([apple, global, banana]);
    expect(body.hits.map((hit) => hit.source)).toEqual(["semantic", "semantic", "keyword"]);
    expect(body.hits[2]!.score).toBeCloseTo(1, 5); // 關鍵字 rank 1 → 1/rank
    expect(body.hits.map((hit) => hit.rank)).toEqual([1, 2, 3]);
  });

  it("k 限制結果筆數；includeAllProjects 跨專案；scope=global 只回全域", async () => {
    const { instance, apple, banana, global, other } = await setupDataset();

    const limited = (await search(instance, { query: "apple", project: "proj-recall", k: 1 })).body as MemoryRecallResponseBody;
    expect(limited.k).toBe(1);
    expect(limited.hits).toHaveLength(1);
    expect(limited.hits[0]!.id).toBe(apple);

    // 預設（project=proj-recall）不含其他專案。
    const defaultScope = (await search(instance, { query: "apple", project: "proj-recall" }))
      .body as MemoryRecallResponseBody;
    expect(ids(defaultScope)).not.toContain(other);
    expect(new Set(ids(defaultScope))).toEqual(new Set([apple, global, banana]));

    // includeAllProjects 含其他專案。
    const allProjects = (await search(instance, { query: "apple", includeAllProjects: true }))
      .body as MemoryRecallResponseBody;
    expect(ids(allProjects)).toContain(other);

    // 明確 scope=global 只回全域。
    const globalOnly = (await search(instance, { query: "apple", scope: "global" })).body as MemoryRecallResponseBody;
    expect(ids(globalOnly)).toEqual([global]);
  });

  it("O3：scope=project 同時帶 project 與 includeAllProjects → project 優先（includeAllProjects 被忽略）", async () => {
    const { instance, apple, banana, global, other } = await setupDataset();
    const result = (
      await search(instance, {
        query: "apple",
        scope: "project",
        project: "proj-recall",
        includeAllProjects: true,
        agent: "recall-agent-x",
      })
    ).body as MemoryRecallResponseBody;

    // 只回 proj-recall 的記憶：不含 global、不含其他專案（includeAllProjects 被忽略）、不含 agent。
    expect(new Set(ids(result))).toEqual(new Set([apple, banana]));
    expect(ids(result)).not.toContain(global);
    expect(ids(result)).not.toContain(other);
  });

  it("agent 範圍只在提供 agent 時納入；kind 過濾語意結果", async () => {
    const { instance, apple, banana } = await setupDataset();
    const agentMemory = await createMemory(instance, {
      content: "apple agent 範圍",
      scope: "agent",
      agent: "recall-agent-x",
    });
    await waitForReady(instance, 5);

    const withoutAgent = (await search(instance, { query: "apple", project: "proj-recall" }))
      .body as MemoryRecallResponseBody;
    expect(ids(withoutAgent)).not.toContain(agentMemory.id);

    const withAgent = (
      await search(instance, { query: "apple", project: "proj-recall", agent: "recall-agent-x" })
    ).body as MemoryRecallResponseBody;
    expect(ids(withAgent)).toContain(agentMemory.id);

    // F1：明確 scope=project 只回 project 範圍——即使提供 agent，也不得納入 agent scope／global。
    const explicitProject = (
      await search(instance, { query: "apple", scope: "project", project: "proj-recall", agent: "recall-agent-x" })
    ).body as MemoryRecallResponseBody;
    expect(ids(explicitProject)).not.toContain(agentMemory.id);
    expect(new Set(ids(explicitProject))).toEqual(new Set([apple, banana]));

    // kind 在 SQL 先過濾（decision 只剩 apple）。
    const onlyDecision = (await search(instance, { query: "apple", project: "proj-recall", kind: "decision" }))
      .body as MemoryRecallResponseBody;
    expect(ids(onlyDecision)).toEqual([apple]);
  });

  it("k 超過上限夾到 100（不會被當成 400）", async () => {
    const { instance } = await setupDataset();
    const result = await search(instance, { query: "apple", project: "proj-recall", k: 1000 });
    expect(result.status).toBe(200);
    expect((result.body as MemoryRecallResponseBody).k).toBe(100);
  });
});
