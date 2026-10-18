/**
 * 卡 B1（記憶語意化基礎）的伺服器測試：
 *
 * 1. `MemoryEmbeddingWorker` 的行為（成功／too-long／重試後 failed／回填／換 embedder 的 stale
 *    重嵌／佇列去重／未知與已刪除 id／`close()` 不 hang）。
 * 2. 真 server 整合：`POST /memories` 立即回應（嵌入在背景）、`GET /diagnostics` 的 memories 統計、
 *    重啟換 embedder 後 stale 可觀察、`close()` 不 hang。
 * 3. O2：`POST /memories` 的 scope／project 正規化。
 *
 * 一律使用合成記憶與 `FakeEmbedder`／可控 embedder；不讀取任何使用者資料。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  openDatabase,
  SqliteMetadataStore,
  type DocumentInput,
  type Embedder,
  type EmbedderInfo,
  type ImageInput,
  type NewMemory,
  type ProbeResult,
  type SqliteDatabase,
} from "@mnemoshelf/core";
import { FakeEmbedder } from "@mnemoshelf/core/testing";
import {
  api,
  errorName,
  makeTempDir,
  removeTempDir,
  startTestServer,
  TEST_TOKEN,
  type TestServer,
} from "./helpers.js";
import {
  createServer,
  MemoryEmbeddingWorker,
  type DiagnosticsResponse,
  type MnemoshelfServer,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// 測試工具
// ---------------------------------------------------------------------------

/** 記錄呼叫次數、可注入失敗／延遲／固定 id 的 embedder（無語意；向量內容不重要）。 */
class ControlEmbedder implements Embedder {
  readonly info: EmbedderInfo;
  calls = 0;
  private readonly inner = new FakeEmbedder();
  private readonly impl: (text: string, title?: string) => Promise<Float32Array>;

  constructor(options: { id?: string; impl?: (text: string, title?: string) => Promise<Float32Array> } = {}) {
    this.info = { ...this.inner.info, id: options.id ?? "control-embedder@test" };
    this.impl = options.impl ?? ((text, title) => this.inner.embedDocument(text, title));
  }

  async embedQuery(text: string): Promise<Float32Array> {
    return this.inner.embedQuery(text);
  }

  async embedDocument(text: string, title?: string): Promise<Float32Array> {
    this.calls += 1;
    return this.impl(text, title);
  }

  async embedDocuments(inputs: readonly DocumentInput[], _opts?: unknown): Promise<Float32Array[]> {
    const vectors: Float32Array[] = [];
    for (const input of inputs) vectors.push(await this.embedDocument(input.text, input.title));
    return vectors;
  }

  async embedImage(image: ImageInput): Promise<Float32Array> {
    return this.inner.embedImage(image);
  }

  async probe(): Promise<ProbeResult> {
    return { ok: true, message: "測試用 embedder（無語意）" };
  }

  async dispose(): Promise<void> {
    // 無資源。
  }
}

/** embedder 契約的「單筆輸入過長」錯誤（穩定錯誤碼；與 `FakeEmbedder`、真實實作同結構）。 */
function inputTooLongError(): Error {
  return Object.assign(new Error("單筆輸入超過上限"), {
    name: "EmbedderInputError",
    code: "input-too-long",
  });
}

function memoryInput(overrides: Partial<NewMemory> = {}): NewMemory {
  return {
    content: "worker 測試記憶",
    kind: "fact",
    scope: "global",
    project: null,
    agent: "worker-test",
    supersedes: null,
    ...overrides,
  };
}

/** 輪詢等待條件成立；逾時就讓測試失敗（避免測試自己 hang 住）。 */
async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`等待條件逾時（${timeoutMs}ms）`);
}

/** 讀出 `GET /diagnostics` 的記憶語意化段落。 */
async function memoryDiagnostics(instance: MnemoshelfServer): Promise<DiagnosticsResponse["memories"]> {
  const response = await api(instance, "GET", "/diagnostics");
  expect(response.status).toBe(200);
  return (response.body as DiagnosticsResponse).memories;
}

/** 讀出一筆記憶的 `scope`／`project`（POST／GET 的回應都適用）。 */
function scopeProject(body: unknown): { scope: string; project: string | null } {
  const record = body as { scope?: unknown; project?: unknown };
  return { scope: String(record.scope), project: record.project === null ? null : String(record.project) };
}

// ---------------------------------------------------------------------------
// Worker 單元測試（in-memory SQLite）
// ---------------------------------------------------------------------------

describe("MemoryEmbeddingWorker", () => {
  let db: SqliteDatabase;
  let store: SqliteMetadataStore;
  const workers: MemoryEmbeddingWorker[] = [];

  beforeEach(async () => {
    db = openDatabase(":memory:");
    store = new SqliteMetadataStore(db);
    await store.migrate();
  });

  afterEach(async () => {
    while (workers.length > 0) await workers.pop()!.close();
    db.close();
  });

  /** 建立並追蹤 worker（測試結束自動 close）。 */
  function workerFor(embedder: Embedder, options: { batchSize?: number; retryAttempts?: number } = {}): MemoryEmbeddingWorker {
    const worker = new MemoryEmbeddingWorker({ store, embedder, retryDelayMs: 0, ...options });
    workers.push(worker);
    return worker;
  }

  async function addMemory(content: string): Promise<number> {
    const memory = await store.addMemory(memoryInput({ content }));
    return memory.id;
  }

  it("enqueue 後成功嵌入：ready、待嵌清單清空、worker 統計正確", async () => {
    const embedder = new ControlEmbedder();
    const worker = workerFor(embedder);
    const id = await addMemory("要成功嵌入的記憶");

    worker.start();
    worker.enqueue(id);
    await waitFor(async () => (await store.memoryEmbeddingStats(embedder.info.id)).ready === 1);

    expect(embedder.calls).toBe(1);
    expect(worker.stats()).toEqual({ queued: 0, processing: 0, embedded: 1, failed: 0, tooLong: 0 });
    expect(await store.memoryEmbeddingStats(embedder.info.id)).toEqual({
      total: 1,
      pending: 0,
      ready: 1,
      failed: 0,
      tooLong: 0,
      stale: 0,
    });
    expect(await store.listMemoriesNeedingEmbedding(embedder.info.id)).toEqual([]);
  });

  it("input-too-long → too-long，且不重試", async () => {
    const embedder = new ControlEmbedder({
      impl: async () => {
        throw inputTooLongError();
      },
    });
    const worker = workerFor(embedder, { retryAttempts: 3 });
    const id = await addMemory("超過 embedder 單筆上限的記憶");

    worker.start();
    worker.enqueue(id);
    await waitFor(async () => (await store.memoryEmbeddingStats(embedder.info.id)).tooLong === 1);

    expect(embedder.calls).toBe(1); // 永久性失敗不重試
    expect(worker.stats()).toMatchObject({ tooLong: 1, failed: 0, embedded: 0 });
    // too-long 永久排除在待嵌清單之外。
    expect(await store.listMemoriesNeedingEmbedding(embedder.info.id)).toEqual([]);
  });

  it("其他錯誤重試 retryAttempts 次後標 failed（下次 start 可再試）", async () => {
    let calls = 0;
    const embedder = new ControlEmbedder({
      impl: async () => {
        calls += 1;
        throw new Error("模擬嵌入失敗");
      },
    });
    const worker = workerFor(embedder, { retryAttempts: 3 });
    const id = await addMemory("一直失敗的記憶");

    worker.start();
    worker.enqueue(id);
    await waitFor(async () => (await store.memoryEmbeddingStats(embedder.info.id)).failed === 1);

    // retryAttempts=3 是「重試次數（不含第一次）」→ 共 4 次呼叫。
    expect(calls).toBe(4);
    expect(worker.stats()).toMatchObject({ failed: 1, embedded: 0, tooLong: 0 });
    // failed 仍會列在待嵌清單，下次回填再試。
    expect((await store.listMemoriesNeedingEmbedding(embedder.info.id)).map((memory) => memory.id)).toEqual([id]);
  });

  it("重試後成功 → ready（不會被標成 failed）", async () => {
    const inner = new FakeEmbedder();
    let calls = 0;
    const embedder = new ControlEmbedder({
      impl: async (text, title) => {
        calls += 1;
        if (calls < 3) throw new Error("暫時失敗");
        return inner.embedDocument(text, title);
      },
    });
    const worker = workerFor(embedder, { retryAttempts: 3 });
    const id = await addMemory("第三次才成功的記憶");

    worker.start();
    worker.enqueue(id);
    await waitFor(async () => (await store.memoryEmbeddingStats(embedder.info.id)).ready === 1);

    expect(calls).toBe(3);
    expect(worker.stats()).toMatchObject({ embedded: 1, failed: 0, tooLong: 0 });
  });

  it("start() 會回填既有記憶（含分批抓取）", async () => {
    const embedder = new ControlEmbedder();
    const worker = workerFor(embedder, { batchSize: 2 });
    await addMemory("回填一");
    await addMemory("回填二");
    await addMemory("回填三");

    worker.start();
    await waitFor(async () => (await store.memoryEmbeddingStats(embedder.info.id)).ready === 3);

    expect(worker.stats().embedded).toBe(3);
    expect(await store.listMemoriesNeedingEmbedding(embedder.info.id)).toEqual([]);
  });

  it("換 embedder 後回填會重嵌 stale 的記憶", async () => {
    const firstEmbedder = new ControlEmbedder({ id: "control-a@test" });
    const workerA = workerFor(firstEmbedder);
    const id = await addMemory("跨 embedder 的記憶");
    workerA.start();
    workerA.enqueue(id);
    await waitFor(async () => (await store.memoryEmbeddingStats(firstEmbedder.info.id)).ready === 1);
    await workerA.close();

    // 換成不同 id 的 embedder：ready 但 stale，且會重新列入待嵌清單。
    const secondEmbedder = new ControlEmbedder({ id: "control-b@test" });
    expect(await store.memoryEmbeddingStats(secondEmbedder.info.id)).toMatchObject({ ready: 1, stale: 1 });
    expect((await store.listMemoriesNeedingEmbedding(secondEmbedder.info.id)).map((memory) => memory.id)).toEqual([id]);

    const workerB = workerFor(secondEmbedder);
    workerB.start();
    await waitFor(async () => (await store.memoryEmbeddingStats(secondEmbedder.info.id)).stale === 0);

    expect(secondEmbedder.calls).toBe(1);
    expect(await store.memoryEmbeddingStats(secondEmbedder.info.id)).toMatchObject({ ready: 1, pending: 0 });
  });

  it("同一個 id 重複 enqueue 只會嵌一次", async () => {
    const embedder = new ControlEmbedder();
    const worker = workerFor(embedder);
    const id = await addMemory("佇列去重測試");

    worker.start();
    worker.enqueue(id);
    worker.enqueue(id);
    worker.enqueue(id);
    await waitFor(async () => (await store.memoryEmbeddingStats(embedder.info.id)).ready === 1);
    // 再多等一下，確認沒有第二次呼叫。
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(embedder.calls).toBe(1);
  });

  it("處理中重複 enqueue 同一 id 只會嵌一次（F1）", async () => {
    // 慢速但**一定會完成**的 embedder：若去重退化（處理中未保留 id），第二次嵌入會真的發生，
    // 測試會以 `calls === 2` 乾淨失敗；同時 teardown 的 close() 不會被永遠 pending 的嵌入卡住。
    const embedder = new ControlEmbedder({
      impl: async () => {
        await new Promise((resolve) => setTimeout(resolve, 80));
        return new Float32Array([0.1, 0.2]);
      },
    });
    const worker = workerFor(embedder);
    const id = await addMemory("處理中去重測試");

    worker.start();
    worker.enqueue(id);
    await waitFor(() => embedder.calls === 1);
    expect(worker.stats()).toMatchObject({ processing: 1 });

    // 嵌入還在進行中：重複 enqueue 必須被忽略（id 仍算「處理中」）。
    worker.enqueue(id);
    worker.enqueue(id);
    expect(worker.stats()).toMatchObject({ processing: 1, queued: 0 });

    await waitFor(async () => (await store.memoryEmbeddingStats(embedder.info.id)).ready === 1);
    // 等超過一次嵌入的時間：若重複 enqueue 生效，第二次嵌入會在第一次完成後發生。
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(embedder.calls).toBe(1);
    expect(worker.stats()).toMatchObject({ embedded: 1, processing: 0, queued: 0 });
  });

  it("處理完成後再 enqueue 同一 id 仍會正常處理（去重集合已釋放）", async () => {
    const embedder = new ControlEmbedder();
    const worker = workerFor(embedder);
    const id = await addMemory("完成後再 enqueue 的記憶");

    worker.start();
    worker.enqueue(id);
    await waitFor(async () => (await store.memoryEmbeddingStats(embedder.info.id)).ready === 1);
    expect(embedder.calls).toBe(1);

    // 已完成、目前不在佇列也不在處理中 → 再次 enqueue 應正常再嵌一次。
    worker.enqueue(id);
    await waitFor(() => embedder.calls === 2);
    await waitFor(() => worker.stats().embedded === 2);
    expect(worker.stats()).toMatchObject({ embedded: 2, processing: 0, queued: 0 });
  });

  it("回填查詢期間到達的 enqueue 不會被漏掉（喚醒競態）", async () => {
    const embedder = new ControlEmbedder();
    let worker: MemoryEmbeddingWorker | undefined;
    let injected = false;
    let injectedId: number | undefined;

    // 回填查詢回傳「空」之後、loop 睡下去之前，才建立並 enqueue 一筆記憶：
    // 此時 loop 剛結束 await 查詢，`wakeLoop` 還是 null，喚醒會是 no-op——
    // worker 必須在 waitForWork 之前再檢查一次佇列，否則會帶著新工作去睡（生產環境卡住）。
    const original = store.listMemoriesNeedingEmbedding.bind(store);
    store.listMemoriesNeedingEmbedding = async (embedderId, limit) => {
      const result = await original(embedderId, limit);
      if (!injected && worker !== undefined) {
        injected = true;
        const memory = await store.addMemory(memoryInput({ content: "回填期間 enqueue 的競態記憶" }));
        injectedId = memory.id;
        worker.enqueue(memory.id);
      }
      return result;
    };

    worker = workerFor(embedder);
    worker.start();
    await waitFor(async () => (await store.memoryEmbeddingStats(embedder.info.id)).ready === 1);

    expect(injected).toBe(true);
    expect(injectedId).toBeDefined();
    expect(embedder.calls).toBe(1);
  });

  it("不存在或已刪除的 id 會跳過，不影響後續工作", async () => {
    const embedder = new ControlEmbedder();
    const worker = workerFor(embedder);
    const deleted = await store.addMemory(memoryInput({ content: "已刪除的記憶" }));
    await store.forgetMemory(deleted.id);
    const valid = await addMemory("有效的記憶");

    worker.start();
    worker.enqueue(987654);
    worker.enqueue(deleted.id);
    worker.enqueue(valid);
    await waitFor(async () => (await store.memoryEmbeddingStats(embedder.info.id)).ready === 1);

    expect(embedder.calls).toBe(1);
    expect(worker.stats()).toMatchObject({ embedded: 1, failed: 0, tooLong: 0 });
    // 已刪除者不進統計。
    expect(await store.memoryEmbeddingStats(embedder.info.id)).toMatchObject({ total: 1, ready: 1 });
  });

  it("close() 在閒置時立即結束（不 hang）", async () => {
    const worker = workerFor(new ControlEmbedder());
    worker.start();
    const started = Date.now();
    await worker.close();
    expect(Date.now() - started).toBeLessThan(1000);
    // 冪等。
    await worker.close();
  });

  it("close() 等目前這筆結束、清空佇列，不會處理下一筆", async () => {
    let release: (() => void) | undefined;
    const embedder = new ControlEmbedder({
      impl: () =>
        new Promise<Float32Array>((resolve) => {
          release = () => resolve(new Float32Array([0.1, 0.2]));
        }),
    });
    const worker = workerFor(embedder);
    worker.start();
    worker.enqueue(await addMemory("處理中的記憶"));
    worker.enqueue(await addMemory("排隊中的記憶"));
    await waitFor(() => embedder.calls === 1);

    const closed = worker.close();
    release?.();
    await Promise.race([
      closed,
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error("close 逾時")), 1000)),
    ]);

    expect(embedder.calls).toBe(1);
    expect(worker.stats()).toMatchObject({ queued: 0, processing: 0 });
  });

  it("close() 會取消重試等待，不會留下 timer", async () => {
    const embedder = new ControlEmbedder({
      impl: async () => {
        throw new Error("失敗");
      },
    });
    // 重試延遲很長；close() 必須取消它，否則測試會 hang 或拖慢。
    const worker = new MemoryEmbeddingWorker({ store, embedder, retryAttempts: 3, retryDelayMs: 10_000 });
    workers.push(worker);
    worker.start();
    worker.enqueue(await addMemory("重試中的記憶"));
    await waitFor(() => embedder.calls === 1);

    const started = Date.now();
    await worker.close();
    expect(Date.now() - started).toBeLessThan(1000);
    // 重試被取消、尚未標成 failed → 保持 pending，下次回填再試。
    expect((await store.memoryEmbeddingStats(embedder.info.id)).pending).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 真 server 整合：非阻塞寫入、診斷、重啟換 embedder
// ---------------------------------------------------------------------------

describe("POST /memories 與記憶語意化整合", () => {
  let server: TestServer | undefined;
  const tempDirs: string[] = [];
  let releasePending: (() => void) | undefined;

  afterEach(async () => {
    releasePending?.();
    releasePending = undefined;
    await server?.close();
    server = undefined;
    while (tempDirs.length > 0) await removeTempDir(tempDirs.pop()!);
  });

  it("POST /memories 立即回應；向量在背景完成後 diagnostics 顯示 ready", async () => {
    const embedder = new ControlEmbedder({
      impl: () =>
        new Promise<Float32Array>((resolve) => {
          releasePending = () => resolve(new Float32Array([0.1, 0.2, 0.3]));
        }),
    });
    server = await startTestServer({ embedder });
    const instance = server.instance;

    const started = Date.now();
    const created = await api(instance, "POST", "/memories", {
      body: { content: "非阻塞嵌入的測試記憶", agent: "agent-embed" },
    });
    const elapsed = Date.now() - started;
    expect(created.status).toBe(201);
    // 嵌入還被卡住，POST 就已經回應（證明不等待模型，只是 enqueue）。
    expect(elapsed).toBeLessThan(1000);
    await waitFor(() => releasePending !== undefined);

    const during = await memoryDiagnostics(instance);
    expect(during).toMatchObject({ total: 1, pending: 1, ready: 0, failed: 0, tooLong: 0, stale: 0 });
    expect(during.worker).toMatchObject({ processing: 1 });

    releasePending?.();
    releasePending = undefined;
    await waitFor(async () => (await memoryDiagnostics(instance)).ready === 1);
    const after = await memoryDiagnostics(instance);
    expect(after).toMatchObject({ total: 1, ready: 1, pending: 0, worker: { embedded: 1, processing: 0 } });
    // 統計自洽。
    expect(after.total).toBe(after.pending + after.ready + after.failed + after.tooLong);
  });

  it("超過 embedder 單筆上限的記憶 → diagnostics 看到 too-long", async () => {
    const embedder = new ControlEmbedder({
      impl: async () => {
        throw inputTooLongError();
      },
    });
    server = await startTestServer({ embedder, memoryEmbedding: { retryDelayMs: 0 } });
    const instance = server.instance;

    const created = await api(instance, "POST", "/memories", {
      body: { content: "TOO-LONG-MARKER 的記憶", agent: "agent-embed" },
    });
    expect(created.status).toBe(201);

    await waitFor(async () => (await memoryDiagnostics(instance)).tooLong === 1);
    expect(await memoryDiagnostics(instance)).toMatchObject({
      total: 1,
      tooLong: 1,
      pending: 0,
      worker: { tooLong: 1 },
    });
    expect(await instance.store.listMemoriesNeedingEmbedding(embedder.info.id)).toEqual([]);
  });

  it("其他錯誤重試後 failed，diagnostics 與待嵌清單可觀察", async () => {
    const embedder = new ControlEmbedder({
      impl: async () => {
        throw new Error("模擬永久失敗");
      },
    });
    server = await startTestServer({ embedder, memoryEmbedding: { retryAttempts: 2, retryDelayMs: 0 } });
    const instance = server.instance;

    await api(instance, "POST", "/memories", { body: { content: "失敗的記憶", agent: "agent-embed" } });
    await waitFor(async () => (await memoryDiagnostics(instance)).failed === 1);

    expect(await memoryDiagnostics(instance)).toMatchObject({
      total: 1,
      failed: 1,
      pending: 0,
      worker: { failed: 1 },
    });
    expect((await instance.store.listMemoriesNeedingEmbedding(embedder.info.id)).length).toBe(1);
  });

  it("換 embedder 重啟後 stale 可觀察，背景回填後回到 ready", async () => {
    const dataDir = await makeTempDir("mnemoshelf-embed-restart-");
    tempDirs.push(dataDir);

    const firstEmbedder = new ControlEmbedder({ id: "restart-a@test" });
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
        body: { content: "重啟後要重嵌的記憶", agent: "agent-embed" },
      });
      expect(created.status).toBe(201);
      await waitFor(async () => (await memoryDiagnostics(first)).ready === 1);
    } finally {
      await first.close();
    }

    // 第二個 embedder 卡住第一次 embed，讓我們能在回填完成前觀察 stale。
    let releaseSecond: (() => void) | undefined;
    const secondEmbedder = new ControlEmbedder({
      id: "restart-b@test",
      impl: () =>
        new Promise<Float32Array>((resolve) => {
          releaseSecond = () => resolve(new Float32Array([0.4, 0.5, 0.6]));
        }),
    });
    let second: MnemoshelfServer | undefined;
    try {
      second = await createServer({
        env: {},
        token: TEST_TOKEN,
        dataDir,
        port: 0,
        embedder: secondEmbedder,
        memoryEmbedding: { retryDelayMs: 0 },
      });
      await waitFor(() => releaseSecond !== undefined);

      const stale = await memoryDiagnostics(second);
      expect(stale).toMatchObject({ total: 1, ready: 1, stale: 1, pending: 0 });
      expect(stale.worker).toMatchObject({ processing: 1 });

      releaseSecond?.();
      releaseSecond = undefined;
      await waitFor(async () => (await memoryDiagnostics(second!)).stale === 0);
      expect(await memoryDiagnostics(second)).toMatchObject({ ready: 1, pending: 0, worker: { embedded: 1 } });
      expect(secondEmbedder.calls).toBe(1);
    } finally {
      releaseSecond?.();
      await second?.close();
    }
  });

  it("supersedes 建立的新版本同樣會排入背景嵌入", async () => {
    server = await startTestServer({ memoryEmbedding: { retryDelayMs: 0 } });
    const first = await api(server.instance, "POST", "/memories", {
      body: { content: "舊版本記憶", agent: "agent-embed" },
    });
    expect(first.status).toBe(201);
    const oldId = (first.body as { id: number }).id;

    const second = await api(server.instance, "POST", "/memories", {
      body: { content: "新版本記憶", agent: "agent-embed", supersedes: oldId },
    });
    expect(second.status).toBe(201);
    const newId = (second.body as { id: number }).id;

    await waitFor(async () => {
      const stats = await memoryDiagnostics(server!.instance);
      return stats.total === 1 && stats.ready === 1;
    });
    const stats = await memoryDiagnostics(server.instance);
    expect(stats).toMatchObject({ total: 1, ready: 1 });
    // 舊版已軟刪除、新版是唯一在統計中的記憶。
    expect((await server.instance.store.getMemory(oldId))?.deletedAt).not.toBeNull();
    expect((await server.instance.store.getMemory(newId))?.deletedAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// O2：POST /memories 的 scope／project 正規化
// ---------------------------------------------------------------------------

describe("REST：POST /memories 的 scope/project 正規化（O2）", () => {
  let server: TestServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("省略 scope 且有 project → 視為 project，專案名 trim 後儲存", async () => {
    server = await startTestServer();
    const created = await api(server.instance, "POST", "/memories", {
      body: { content: "省略 scope 但有 project", agent: "agent-o2", project: "  proj-o2  " },
    });
    expect(created.status).toBe(201);
    expect(scopeProject(created.body)).toEqual({ scope: "project", project: "proj-o2" });
    // GET 也反映。
    const listed = (await api(server.instance, "GET", "/memories")).body as { memories: { project: string | null }[] };
    expect(listed.memories[0]?.project).toBe("proj-o2");
  });

  it("省略 scope 且無 project → global（既有預設不變）", async () => {
    server = await startTestServer();
    const created = await api(server.instance, "POST", "/memories", {
      body: { content: "省略 scope 且無 project", agent: "agent-o2" },
    });
    expect(created.status).toBe(201);
    expect(scopeProject(created.body)).toEqual({ scope: "global", project: null });
  });

  it("scope=project 缺 project／空字串／只有空白 → 400", async () => {
    server = await startTestServer();
    for (const body of [
      { content: "缺 project", agent: "agent-o2", scope: "project" },
      { content: "project 空字串", agent: "agent-o2", scope: "project", project: "" },
      { content: "project 只有空白", agent: "agent-o2", scope: "project", project: "   " },
      { content: "project null", agent: "agent-o2", scope: "project", project: null },
    ]) {
      const response = await api(server.instance, "POST", "/memories", { body });
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(errorName(response.body)).toBe("ValidationError");
    }
    // 全部被拒，沒有寫入任何記憶。
    expect(((await api(server.instance, "GET", "/memories")).body as { memories: unknown[] }).memories).toEqual([]);
  });

  it("scope=global|agent 帶非 null project → 400（不默默存矛盾組合）", async () => {
    server = await startTestServer();
    for (const scope of ["global", "agent"] as const) {
      const response = await api(server.instance, "POST", "/memories", {
        body: { content: `scope ${scope} 帶 project`, agent: "agent-o2", scope, project: "proj-o2" },
      });
      expect(response.status).toBe(400);
      expect(errorName(response.body)).toBe("ValidationError");
    }
    // 明確 global／agent 且 project 為 null（或省略）仍可寫入。
    const global = await api(server.instance, "POST", "/memories", {
      body: { content: "global 無 project", agent: "agent-o2", scope: "global", project: null },
    });
    expect(global.status).toBe(201);
    expect(scopeProject(global.body)).toEqual({ scope: "global", project: null });
    const agent = await api(server.instance, "POST", "/memories", {
      body: { content: "agent 無 project", agent: "agent-o2", scope: "agent" },
    });
    expect(agent.status).toBe(201);
    expect(scopeProject(agent.body)).toEqual({ scope: "agent", project: null });
  });

  it("顯式 scope 非字串（含 null／數字／布林）→ 400，不靜默套預設", async () => {
    server = await startTestServer();
    for (const scope of [null, 42, true, { scope: "global" }]) {
      const response = await api(server.instance, "POST", "/memories", {
        body: { content: "非字串 scope", agent: "agent-o2", scope },
      });
      expect(response.status).toBe(400);
      expect(errorName(response.body)).toBe("ValidationError");
    }
  });
});
