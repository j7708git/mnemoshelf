/**
 * `close()` 限時收尾（修復 F1）：關閉時**取消在途索引**，不被整個索引／native 推論批次拖住。
 *
 * 對照的 bug：舊版 `close()` 依序 `await app.settled()` → `memoryEmbedder.close()`，因此在途索引
 * 會完整跑完（真模型 1 檔 7 chunks＝11.78s、2 檔 15 chunks＝63.68s）才返回。
 *
 * 這裡用兩種 fake embedder 分別鎖住兩條路徑：
 * - `SlowEmbedder`：取消在下一個邊界生效 → 正常（graceful）收尾，close 遠早於索引總時間。
 * - `BlockingEmbedder`：模擬 native 推論不可中斷（不理 signal，只有 `dispose()` 會讓在途呼叫失敗）
 *   → 寬限用完後 terminate/dispose，close 仍在數秒內結束、不回 hang。
 */
import { describe, expect, it } from "vitest";
import type { DocumentInput, EmbedDocumentsOptions } from "@mnemoshelf/core";
import { FakeEmbedder } from "@mnemoshelf/core/testing";
import type { MnemoshelfServer } from "../src/index.js";
import {
  api,
  makeFixtureRoot,
  removeTempDir,
  SlowEmbedder,
  startTestServer,
} from "./helpers.js";

/**
 * 模擬「native 推論不可中斷」的 embedder：`embedDocuments` 永不自己結束，也不理 abort；
 * 只有 `dispose()` 會讓在途呼叫失敗（對應 WorkerEmbedder terminate 後在途呼叫收到關閉錯誤）。
 */
class BlockingEmbedder extends FakeEmbedder {
  private readonly pending: Array<(error: unknown) => void> = [];
  disposeCalls = 0;

  /** 目前卡在「native 推論」的呼叫數（測試用來確認 close 時真的有在途工作）。 */
  get pendingCount(): number {
    return this.pending.length;
  }

  override async embedDocuments(
    _inputs: readonly DocumentInput[],
    _opts?: EmbedDocumentsOptions,
  ): Promise<Float32Array[]> {
    return await new Promise<Float32Array[]>((_resolve, reject) => {
      this.pending.push(reject);
    });
  }

  override async dispose(): Promise<void> {
    this.disposeCalls += 1;
    // 以「清楚的關閉錯誤」結束在途呼叫（名稱對應 WorkerEmbedder 的 EmbedderWorkerClosedError）。
    for (const reject of this.pending.splice(0)) {
      reject(Object.assign(new Error("embedder 已關閉（測試）"), { name: "EmbedderWorkerClosedError" }));
    }
  }
}

/** `SlowEmbedder`＋在途計數（確認 close 時真的有嵌入在跑，而不是只走到掃描）。 */
class TrackedSlowEmbedder extends SlowEmbedder {
  inFlight = 0;

  override async embedDocuments(
    inputs: readonly DocumentInput[],
    opts?: EmbedDocumentsOptions,
  ): Promise<Float32Array[]> {
    this.inFlight += 1;
    try {
      return await super.embedDocuments(inputs, opts);
    } finally {
      this.inFlight -= 1;
    }
  }
}

/**
 * 有 `drain()` 的可控 embedder（模擬 `WorkerEmbedder` 的安全關閉契約）。
 *
 * `close()` 必須等 drain（目前推論）完成才返回；`dispose()` 只該在閒置時被呼叫
 * （在途時 terminate 會讓真的 native 推論 N-API abort，所以產品碼先 drain 再 dispose）。
 * 推論以 gate 卡住、由測試明確放行——不用時間門檻，避免平行測試負載造成 flake。
 */
class DrainableGatedEmbedder extends FakeEmbedder {
  private active = 0;
  drainCalls = 0;
  disposeCalls = 0;
  /** dispose 當下的在途數（0＝drain 已完成）。 */
  activeAtDispose = -1;
  private readonly started: Promise<void>;
  private startedResolve!: () => void;
  private readonly gate: Promise<void>;
  private releaseGate!: () => void;

  constructor() {
    super();
    this.started = new Promise<void>((resolve) => {
      this.startedResolve = resolve;
    });
    this.gate = new Promise<void>((resolve) => {
      this.releaseGate = resolve;
    });
  }

  /** 目前卡在「推論」的呼叫數（測試用來確認 close 當下真的有在途工作）。 */
  get activeCalls(): number {
    return this.active;
  }

  /** 等第一個「推論」真的開始。 */
  get firstCallStarted(): Promise<void> {
    return this.started;
  }

  /** 讓卡住的「推論」完成（模擬 native 批次回報）。 */
  finishEmbedding(): void {
    this.releaseGate();
  }

  override async embedQuery(text: string): Promise<Float32Array> {
    this.active += 1;
    this.startedResolve();
    try {
      await this.gate;
      return await super.embedQuery(text);
    } finally {
      this.active -= 1;
    }
  }

  async drain(): Promise<void> {
    this.drainCalls += 1;
    while (this.active > 0) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  override async dispose(): Promise<void> {
    this.disposeCalls += 1;
    this.activeAtDispose = this.active;
    await super.dispose();
  }
}

/** 輪詢到索引進入 running（避免與請求處理競態）。 */
async function waitUntilRunning(instance: MnemoshelfServer, rootId: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const current = await api(instance, "GET", `/roots/${rootId}/index/status`);
    if ((current.body as { state?: string }).state === "running") return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("索引未在期限內進入 running");
}

async function addFixtureRoot(instance: MnemoshelfServer, dir: string): Promise<number> {
  const created = await api(instance, "POST", "/roots", {
    body: { path: dir, modalities: ["text", "code"] },
  });
  expect(created.status).toBe(201);
  return (created.body as { id: number }).id;
}

describe("createServer.close()：關閉優先、有限等待", () => {
  it("cancelAllIndexing() 冪等：回傳實際中止數、請求 200 cancelled、之後不再啟動新索引", async () => {
    const server = await startTestServer({ embedder: new SlowEmbedder(80) });
    const dir = await makeFixtureRoot();
    try {
      const rootId = await addFixtureRoot(server.instance, dir);
      const started = api(server.instance, "POST", `/roots/${rootId}/index`);
      started.catch(() => undefined);
      await waitUntilRunning(server.instance, rootId);

      expect(server.instance.app.indexing.has(rootId)).toBe(true);
      expect(server.instance.app.cancelAllIndexing()).toBe(1);
      // 冪等：已 abort 過的 controller 不重複計數。
      expect(server.instance.app.cancelAllIndexing()).toBe(0);

      const finished = await started;
      expect(finished.status).toBe(200);
      expect(finished.body).toMatchObject({ rootId, cancelled: true });
      expect(server.instance.app.indexing.has(rootId)).toBe(false);

      // 關閉流程已停止索引：之後的索引請求直接回 cancelled（durationMs 0、不再跑一輪）。
      const after = await api(server.instance, "POST", `/roots/${rootId}/index`);
      expect(after.status).toBe(200);
      expect(after.body).toMatchObject({ rootId, cancelled: true, durationMs: 0 });
      expect((await api(server.instance, "GET", `/roots/${rootId}/index/status`)).body).toMatchObject({
        state: "cancelled",
      });
    } finally {
      await server.close();
      await removeTempDir(dir);
    }
  });

  it("索引中 close()：先取消、不等待整個索引跑完；在途索引以 AbortError 結束", async () => {
    const embedder = new TrackedSlowEmbedder(100);
    const server = await startTestServer({ embedder });
    const dir = await makeFixtureRoot();
    try {
      const rootId = await addFixtureRoot(server.instance, dir);
      const request = api(server.instance, "POST", `/roots/${rootId}/index`);
      request.catch(() => undefined);
      await waitUntilRunning(server.instance, rootId);
      for (let attempt = 0; attempt < 400 && embedder.inFlight === 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(embedder.inFlight).toBeGreaterThanOrEqual(1);

      const run = server.instance.app.indexing.get(rootId);
      expect(run).toBeDefined();
      const outcome = run!.then(
        () => null,
        (error: unknown) => error,
      );

      const startedAt = performance.now();
      await server.instance.close();
      const closeMs = performance.now() - startedAt;

      // 索引有 2 檔、每檔 embedding 100ms；close 若等整輪至少 200ms，正常情況只需數十毫秒。
      // 這裡的門檻同時保證「遠低於卡上的 10s」且不會被排程負載誤判。
      expect(closeMs).toBeLessThan(5_000);
      const error = await outcome;
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).name).toBe("AbortError");
      expect(server.instance.app.indexing.size).toBe(0);
    } finally {
      await server.close();
      await removeTempDir(dir);
    }
  });

  it("native 推論不回 abort 時：寬限後 dispose embedder，close 仍在數秒內結束（不 hang）", async () => {
    const embedder = new BlockingEmbedder();
    const server = await startTestServer({ embedder });
    const dir = await makeFixtureRoot();
    try {
      const rootId = await addFixtureRoot(server.instance, dir);
      const request = api(server.instance, "POST", `/roots/${rootId}/index`);
      request.catch(() => undefined);
      await waitUntilRunning(server.instance, rootId);
      // 確認 close 時真的有一個「native 推論」卡在裡面（不是只走到掃描／排隊）。
      for (let attempt = 0; attempt < 400 && embedder.pendingCount === 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(embedder.pendingCount).toBeGreaterThanOrEqual(1);

      const run = server.instance.app.indexing.get(rootId);
      expect(run).toBeDefined();
      const outcome = run!.then(
        () => null,
        (error: unknown) => error,
      );

      const startedAt = performance.now();
      await server.instance.close();
      const closeMs = performance.now() - startedAt;

      // 舊版會永遠等這兩個永不返回的嵌入（測試會 timeout）；新版寬限 2s 後 dispose。
      expect(closeMs).toBeLessThan(5_000);
      // 在途索引以取消結束，不是 hang、也不是背景工作洩漏。
      const error = await outcome;
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).name).toBe("AbortError");
      expect(server.instance.app.indexing.size).toBe(0);
      // 有走到「強制收尾」：dispose 至少被呼叫一次（close 尾端還會再呼叫一次，冪等）。
      expect(embedder.disposeCalls).toBeGreaterThanOrEqual(1);
    } finally {
      await server.close();
      await removeTempDir(dir);
    }
  });

  it("有 drain 的 embedder：close() 等 drain（在途推論）完成才返回，dispose 在閒置時才呼叫", async () => {
    const embedder = new DrainableGatedEmbedder();
    const server = await startTestServer({ embedder });
    try {
      // 刻意**不經 HTTP** 直接呼叫 embedder：證明 close 的 drain 涵蓋不在 `app.settled()` 裡的
      // 背景嵌入，而不是只等 HTTP 請求結束。
      const background = server.instance.embedder.embedQuery("暖機");
      await embedder.firstCallStarted;
      expect(embedder.activeCalls).toBe(1);

      let closeDone = false;
      const closing = server.instance.close().then(() => {
        closeDone = true;
      });
      // 等 close 走到 drain：推論被 gate 卡住時，close 不得返回、也不得先 dispose。
      for (let attempt = 0; attempt < 400 && embedder.drainCalls === 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(embedder.drainCalls).toBeGreaterThanOrEqual(1);
      expect(closeDone).toBe(false);
      expect(embedder.disposeCalls).toBe(0);
      expect(embedder.activeCalls).toBe(1);

      // 放行「native 批次」→ close 才能完成；dispose 必須發生在閒置之後。
      embedder.finishEmbedding();
      await closing;
      expect(closeDone).toBe(true);
      expect(embedder.disposeCalls).toBe(1);
      // 關鍵：dispose 被呼叫時已經沒有在途推論（安全 terminate 的前提）。
      expect(embedder.activeAtDispose).toBe(0);
      await background;
    } finally {
      await server.close();
    }
  });
});
