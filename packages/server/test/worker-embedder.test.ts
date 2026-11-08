/**
 * `WorkerEmbedder`（embedder 推論的 worker thread proxy）單元測試。
 *
 * 多數測試用**行程內的假 worker**（事件驅動、無執行緒）：可以精確控制延遲、錯誤與取消時序，
 * 不需要真的模型。另有一個測試用**真正的 `node:worker_threads` Worker**（見 `fixtures/`），
 * 驗證跨執行緒的崩潰處理：在途呼叫要有清楚錯誤、不 hang，下一次呼叫會自動重建一次。
 */
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { describe, expect, it, vi } from "vitest";
import type { EmbedderInfo, EmbedderRuntimeStatus } from "@mnemoshelf/core";
import { FakeEmbedder } from "@mnemoshelf/core/testing";
import {
  EmbedderWorkerClosedError,
  EmbedderWorkerCrashError,
  WorkerEmbedder,
  type EmbedderWorkerEvent,
  type EmbedderWorkerLike,
  type WorkerEmbedderOptions,
} from "../src/index.js";
import { EmbedderQueueFullError, resolveEmbedderWorkerUrl } from "../src/worker-embedder.js";

const INFO: EmbedderInfo = new FakeEmbedder().info;

const STATUS: EmbedderRuntimeStatus = {
  requestedDevice: "cpu",
  device: "cpu",
  loaded: false,
  fallbackReason: null,
  batchSize: 16,
  serializedInference: false,
  dmlDeviceId: 0,
};

describe("音訊片段排程", () => {
  const audio = () => ({ samples: Float32Array.of(0.1, -0.1), sampleRate: 16000 as const });

  it("PCM計入准入位元組且排隊時已快照，不修改或detach呼叫端", async () => {
    const { embedder, requests, release } = controlledEmbedder();
    const source = audio();
    const pending = embedder.embedAudio(source);
    source.samples[0] = 0.8;
    expect(embedder.schedulingStatus.admittedInputBytes).toBe(8);
    await waitFor(() => requests.length === 1);
    const params = requests[0]!.message.params as { samples: Float32Array; sampleRate: number };
    expect(params.samples[0]).toBeCloseTo(0.1);
    expect(params.samples).not.toBe(source.samples);
    expect(source.samples.byteLength).toBe(8);
    expect(params.sampleRate).toBe(16000);
    await release(0);
    await pending;
    expect(embedder.schedulingStatus.admittedInputBytes).toBe(0);
    await embedder.dispose();
  });

  it("超限拒絕且不啟動worker；非法PCM與預先取消同樣不執行", async () => {
    const { embedder, workers } = controlledEmbedder({ scheduling: { maxInputBytes: 4 } });
    await expect(embedder.embedAudio(audio())).rejects.toBeInstanceOf(EmbedderQueueFullError);
    await expect(embedder.embedAudio({ samples: Float32Array.of(NaN), sampleRate: 16000 }))
      .rejects.toMatchObject({ name: "EmbedderInputError" });
    const controller = new AbortController();
    controller.abort();
    await expect(embedder.embedAudio(audio(), { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(workers).toHaveLength(0);
    await embedder.dispose();
  });

  it("音訊間查詢優先，背景音訊仍會前進", async () => {
    const { embedder, requests, release } = controlledEmbedder();
    const first = embedder.embedAudio(audio());
    await waitFor(() => requests.length === 1);
    const second = embedder.embedAudio(audio());
    const query = embedder.embedQuery("查詢");
    await release(0);
    await release(1);
    await release(2);
    await Promise.all([first, second, query]);
    expect(requests.map(({ message }) => message.method)).toEqual(["embedAudio", "embedQuery", "embedAudio"]);
    await embedder.dispose();
  });

  it("排隊音訊立即取消；在途音訊取消與dispose必須等native回應", async () => {
    const { embedder, requests, release, workers } = controlledEmbedder();
    const activeController = new AbortController();
    const active = embedder.embedAudio(audio(), { signal: activeController.signal });
    const rejected = expect(active).rejects.toMatchObject({ name: "AbortError" });
    await waitFor(() => requests.length === 1);
    const queuedController = new AbortController();
    const queued = embedder.embedAudio(audio(), { signal: queuedController.signal });
    const queuedRejected = expect(queued).rejects.toMatchObject({ name: "AbortError" });
    queuedController.abort();
    await queuedRejected;
    activeController.abort();
    let disposed = false;
    const disposal = embedder.dispose().then(() => { disposed = true; });
    await flushPromises();
    expect(disposed).toBe(false);
    expect(workers[0]!.terminated).toBe(false);
    await release(0);
    await Promise.all([rejected, disposal]);
    expect(requests).toHaveLength(1);
    expect(embedder.schedulingStatus.admittedInputBytes).toBe(0);
  });

  it("worker準備期狀態會傳回proxy，失敗後仍可觀察", async () => {
    const { embedder, requests, workers } = controlledEmbedder();
    const pending = embedder.embedAudio(audio());
    const rejected = expect(pending).rejects.toMatchObject({ name: "ModelLoadError" });
    await waitFor(() => requests.length === 1);
    workers[0]!.emit("message", { type: "status", runtimeStatus: { ...STATUS, audioState: "loading" } });
    expect(embedder.runtimeStatus?.audioState).toBe("loading");
    workers[0]!.emit("message", {
      type: "response", id: requests[0]!.message.id, ok: false,
      error: { name: "ModelLoadError", message: "音訊資產準備失敗" },
      runtimeStatus: { ...STATUS, audioState: "failed" },
    });
    await rejected;
    expect(embedder.runtimeStatus?.audioState).toBe("failed");
    await embedder.dispose();
  });
});

type FakeMessage = Record<string, unknown>;
type FakeHandler = (message: FakeMessage, worker: FakeEmbedderWorker) => void;

/** 行程內的假 worker：`postMessage` 以 microtask 非同步回呼，事件介面與真的 Worker 相同。 */
class FakeEmbedderWorker implements EmbedderWorkerLike {
  readonly posted: FakeMessage[] = [];
  terminated = false;
  private readonly listeners: Record<EmbedderWorkerEvent, Set<(...args: unknown[]) => void>> = {
    message: new Set(),
    error: new Set(),
    exit: new Set(),
  };

  constructor(private readonly handler: FakeHandler) {}

  postMessage(message: unknown): void {
    const typed = message as FakeMessage;
    this.posted.push(typed);
    queueMicrotask(() => {
      if (!this.terminated) this.handler(typed, this);
    });
  }

  on(event: EmbedderWorkerEvent, listener: (...args: unknown[]) => void): this {
    this.listeners[event].add(listener);
    return this;
  }

  off(event: EmbedderWorkerEvent, listener: (...args: unknown[]) => void): this {
    this.listeners[event].delete(listener);
    return this;
  }

  terminate(): Promise<number> {
    this.terminated = true;
    return Promise.resolve(0);
  }

  emit(event: EmbedderWorkerEvent, ...args: unknown[]): void {
    for (const listener of [...this.listeners[event]]) listener(...args);
  }

  /** 回應 init（預設成功）。 */
  ready(ok = true): void {
    if (ok) this.emit("message", { type: "ready", ok: true, info: INFO, runtimeStatus: STATUS });
    else this.emit("message", { type: "ready", ok: false, error: { name: "InvalidEmbedderOptionError", message: "dtype 無效" } });
  }

  respond(id: number, result: unknown): void {
    this.emit("message", { type: "response", id, ok: true, result, runtimeStatus: STATUS });
  }

  fail(id: number, error: { name: string; message: string; code?: string }): void {
    this.emit("message", { type: "response", id, ok: false, error, runtimeStatus: STATUS });
  }
}

/** 建一個注入假 worker 的 proxy；`workers` 保留每次建立的假 worker 供斷言。 */
function makeEmbedder(
  handler: FakeHandler,
  overrides: Partial<WorkerEmbedderOptions> = {},
): { embedder: WorkerEmbedder; workers: FakeEmbedderWorker[] } {
  const workers: FakeEmbedderWorker[] = [];
  const embedder = new WorkerEmbedder({
    metadataEmbedder: { info: INFO },
    createWorker: () => {
      const worker = new FakeEmbedderWorker(handler);
      workers.push(worker);
      return worker;
    },
    handshakeTimeoutMs: 500,
    disposeTimeoutMs: 200,
    // 單元測試不該真的等 120 秒：預設給 drain 一個短上限，個別測試再覆寫。
    drainTimeoutMs: 150,
    ...overrides,
  });
  return { embedder, workers };
}

/** 預設 handler：init 成功；request 交給 `onRequest`。 */
function withRequests(onRequest: (message: FakeMessage, worker: FakeEmbedderWorker) => void): FakeHandler {
  return (message, worker) => {
    if (message.type === "init") {
      worker.ready();
      return;
    }
    if (message.type === "request") onRequest(message, worker);
  };
}

/** 等 predicate 成立（有上限；測試失敗不要 hang 在 60 秒）。 */
async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("waitFor 逾時");
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

describe("WorkerEmbedder：info 與 handshake", () => {
  it("info 同步可用；第一次呼叫才建立 worker，之後 runtimeStatus 由 worker 提供", async () => {
    const { embedder, workers } = makeEmbedder(
      withRequests((message, worker) => {
        if (message.method === "embedQuery") worker.respond(message.id as number, new Float32Array([1, 2, 3]));
      }),
    );

    expect(embedder.info).toEqual(INFO);
    expect(embedder.runtimeStatus).toBeUndefined();
    expect(workers).toHaveLength(0);

    const vector = await embedder.embedQuery("hello");
    expect([...vector]).toEqual([1, 2, 3]);
    expect(workers).toHaveLength(1);
    expect(embedder.runtimeStatus).toEqual(STATUS);
  });

  it("初始化失敗（ready ok:false）→ 以原本的錯誤名稱拒絕，不 hang", async () => {
    const { embedder, workers } = makeEmbedder((message, worker) => {
      if (message.type === "init") worker.ready(false);
    });
    await expect(embedder.embedQuery("x")).rejects.toMatchObject({ name: "InvalidEmbedderOptionError" });
    expect(workers).toHaveLength(1);
    await embedder.dispose();
  });

  it("handshake 逾時 → 以 crash 錯誤拒絕（不 hang）", async () => {
    const { embedder } = makeEmbedder(() => undefined, { handshakeTimeoutMs: 40 });
    await expect(embedder.embedQuery("x")).rejects.toMatchObject({
      name: EmbedderWorkerCrashError.name,
      code: "EWORKERCRASH",
    });
    await embedder.dispose();
  });
});

describe("WorkerEmbedder：序列化與錯誤", () => {
  it("同一時間最多一個在途呼叫（依呼叫順序執行）", async () => {
    let active = 0;
    let maxActive = 0;
    const order: string[] = [];

    const { embedder } = makeEmbedder(
      withRequests((message, worker) => {
        const id = message.id as number;
        const method = message.method as string;
        active += 1;
        maxActive = Math.max(maxActive, active);
        order.push(method);
        setTimeout(() => {
          active -= 1;
          worker.respond(id, method === "probe" ? { ok: true } :
            method === "embedDocuments" ? [new Float32Array([1]), new Float32Array([2])] : new Float32Array([1]));
        }, 15);
      }),
    );

    await Promise.all([
      embedder.embedQuery("a"),
      embedder.probe(),
      embedder.embedDocuments([{ text: "b" }, { text: "c" }]),
    ]);

    expect(order).toEqual(["embedQuery", "probe", "embedDocuments"]);
    expect(maxActive).toBe(1);
  });

  it("worker 的錯誤保留 name 與 code（core 的 undecodable 判定不變）", async () => {
    const { embedder } = makeEmbedder(
      withRequests((message, worker) => {
        worker.fail(message.id as number, {
          name: "EmbedderInputError",
          message: "圖片解不開",
          code: "undecodable",
        });
      }),
    );

    await expect(embedder.embedImage({ bytes: new Uint8Array([1, 2, 3]) })).rejects.toMatchObject({
      name: "EmbedderInputError",
      code: "undecodable",
      message: "圖片解不開",
    });
  });
});

describe("WorkerEmbedder：取消", () => {
  it("已中止的 signal 不建立 worker、不送 request", async () => {
    const { embedder, workers } = makeEmbedder(withRequests(() => undefined));
    const controller = new AbortController();
    controller.abort();

    await expect(
      embedder.embedDocuments([{ text: "x" }], { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(workers).toHaveLength(0);
    await embedder.dispose();
  });

  it("進行中 abort → 送 cancel 訊息，worker 在下一個邊界以 AbortError 回應", async () => {
    const controller = new AbortController();
    let requestId: number | undefined;

    const { embedder, workers } = makeEmbedder((message, worker) => {
      if (message.type === "init") {
        worker.ready();
        return;
      }
      if (message.type === "request") {
        requestId = message.id as number;
        return; // 模擬 native 推論進行中：先不回應
      }
      if (message.type === "cancel") {
        // native 不可中斷：worker 在下一個邊界才回報取消。
        worker.fail(message.id as number, { name: "AbortError", message: "嵌入已取消" });
      }
    });

    const run = embedder.embedDocuments([{ text: "x" }], { signal: controller.signal });
    await waitFor(() => workers[0]?.posted.some((message) => message.type === "request") === true);
    controller.abort();

    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    expect(requestId).toBeTypeOf("number");
    expect(workers[0]!.posted.some((message) => message.type === "cancel" && message.id === requestId)).toBe(true);
    await embedder.dispose();
  });
});

describe("WorkerEmbedder：崩潰與關閉", () => {
  it("真正的 Worker 崩潰：在途呼叫有清楚錯誤、下一次自動重建一次、之後停止 crash loop", async () => {
    let spawned = 0;
    const embedder = new WorkerEmbedder({
      metadataEmbedder: { info: INFO },
      createWorker: () => {
        spawned += 1;
        return new Worker(new URL("./fixtures/crashing-embedder-worker.mjs", import.meta.url), {
          execArgv: [],
        });
      },
      handshakeTimeoutMs: 5_000,
      disposeTimeoutMs: 1_000,
      maxRestarts: 1,
    });

    try {
      // 第一次：worker 收到 request 後直接結束（模擬 native 崩潰）。
      await expect(embedder.embedQuery("x")).rejects.toMatchObject({
        name: "EmbedderWorkerCrashError",
        code: "EWORKERCRASH",
      });
      expect(spawned).toBe(1);

      // 第二次：proxy 自動重建一次（卡上要求的「至少一次」），仍然崩潰。
      await expect(embedder.embedQuery("x")).rejects.toMatchObject({
        name: "EmbedderWorkerCrashError",
        code: "EWORKERCRASH",
      });
      expect(spawned).toBe(2);

      // 第三次：已達重建上限 → 直接回清楚錯誤，不再無限重建。
      await expect(embedder.embedQuery("x")).rejects.toMatchObject({
        name: "EmbedderWorkerCrashError",
        code: "EWORKERCRASH",
      });
      expect(spawned).toBe(2);
    } finally {
      await embedder.dispose();
    }
  });

  it("drain() 等目前 in-flight 與排隊呼叫都結束才 resolve（不關閉 worker）", async () => {
    const timeline: string[] = [];
    const { embedder, workers } = makeEmbedder(
      withRequests((message, worker) => {
        const id = message.id as number;
        const method = message.method as string;
        setTimeout(() => {
          timeline.push(`respond:${method}`);
          worker.respond(id, method === "probe" ? { ok: true } : new Float32Array([1]));
        }, 20);
      }),
    );

    const first = embedder.embedQuery("a");
    const second = embedder.probe();
    const drain = embedder.drain().then(() => {
      timeline.push("drain");
    });
    await first;
    await second;
    await drain;

    // drain 必須等兩個呼叫都完成（第二個是排隊中的）；worker 沒有被關掉。
    expect(timeline).toEqual(["respond:embedQuery", "respond:probe", "drain"]);
    expect(workers[0]!.terminated).toBe(false);
    await embedder.dispose();
  });

  it("dispose() 在推論中會等 drain 完成才 terminate，在途呼叫仍拿到結果", async () => {
    let requestId: number | undefined;
    const { embedder, workers } = makeEmbedder(
      (message, worker) => {
        if (message.type === "init") {
          worker.ready();
          return;
        }
        if (message.type !== "request") return;
        if (message.method === "dispose") {
          worker.respond(message.id as number, null);
          return;
        }
        // 模擬一個進行中的 native 批次：刻意不回應，等測試明確放行（不用時間門檻，
        // 避免平行測試負載讓計時器提早／延後造成 flake）。
        requestId = message.id as number;
      },
      { drainTimeoutMs: 5_000 },
    );

    const run = embedder.embedQuery("x");
    await waitFor(() => requestId !== undefined);

    let disposeDone = false;
    const disposing = embedder.dispose().then(() => {
      disposeDone = true;
    });
    // 給 dispose 機會進入 drain：推論還沒回報 → 不得返回、不得送 dispose、也不得 terminate。
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(disposeDone).toBe(false);
    expect(workers[0]!.terminated).toBe(false);
    expect(
      workers[0]!.posted.some((message) => message.type === "request" && message.method === "dispose"),
    ).toBe(false);

    // native 批次回報 → drain 完成後才送 dispose 並 terminate；在途呼叫拿到正常結果。
    workers[0]!.respond(requestId!, new Float32Array([7, 8]));
    await disposing;
    expect(disposeDone).toBe(true);
    expect(workers[0]!.terminated).toBe(true);
    await expect(run).resolves.toEqual(new Float32Array([7, 8]));
  });

  it("dispose 在 worker 卡住（native 推論）時：drain 逾時後放棄、不 terminate；回報後才 terminate", async () => {
    let requestId: number | undefined;
    const { embedder, workers } = makeEmbedder(
      (message, worker) => {
        if (message.type === "init") worker.ready();
        if (message.type === "request") requestId = message.id as number;
        // request 刻意不回應（模擬卡住的 native 呼叫）。
      },
      { disposeTimeoutMs: 50, drainTimeoutMs: 50 },
    );

    const run = embedder.embedQuery("x");
    await waitFor(() => workers[0]?.posted.some((message) => message.type === "request") === true);

    const startedAt = Date.now();
    await embedder.dispose();
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    // native 推論不可安全中斷（terminate 會 abort 行程）：drain 逾時後放棄，不在推論中 terminate。
    expect(workers[0]!.terminated).toBe(false);
    await expect(run).rejects.toBeInstanceOf(EmbedderWorkerClosedError);
    await expect(embedder.embedQuery("x")).rejects.toMatchObject({ code: "EWORKERCLOSED" });

    // worker 在 native 邊界回報（即使結果已被丟棄）→ 此時才安全 terminate。
    expect(requestId).toBeTypeOf("number");
    workers[0]!.respond(requestId!, new Float32Array([1]));
    await waitFor(() => workers[0]!.terminated);
    // 冪等
    await embedder.dispose();
  });

  it("沒有建立過 worker 時 dispose 立即完成", async () => {
    const { embedder, workers } = makeEmbedder(withRequests(() => undefined));
    await embedder.dispose();
    expect(workers).toHaveLength(0);
  });
});

describe("resolveEmbedderWorkerUrl：Electron asar 解包", () => {
  // 用平台無關的方式組出 fixture 路徑（不建立實體檔案；存在性由注入的 pathExists 決定）。
  const resources = path.join(os.tmpdir(), "mnemoshelf-asar-fixture", "resources");
  const moduleUrl = pathToFileURL(
    path.join(resources, "app.asar", "packages", "server", "dist", "worker-embedder.js"),
  );
  const expectedWorkerUrl = pathToFileURL(
    path.join(resources, "app.asar.unpacked", "packages", "server", "dist", "embedder-worker.js"),
  );

  it("module 在 app.asar、且 unpacked 有 embedder-worker.js → 用 unpacked 路徑", () => {
    const probed: string[] = [];
    const resolved = resolveEmbedderWorkerUrl(moduleUrl, (filePath) => {
      probed.push(filePath);
      return true;
    });
    expect(resolved.href).toBe(expectedWorkerUrl.href);
    expect(probed).toEqual([fileURLToPath(expectedWorkerUrl)]);
  });

  it("module 在 app.asar、但 unpacked 沒有檔案 → 維持原本的 asar 路徑", () => {
    const resolved = resolveEmbedderWorkerUrl(moduleUrl, () => false);
    expect(resolved.href).toBe(new URL("./embedder-worker.js", moduleUrl).href);
  });

  it("module 不在 asar（開發環境）→ 維持原路徑，也不檢查 unpacked", () => {
    let probed = false;
    const devModule = pathToFileURL(
      path.join(resources, "packages", "server", "dist", "worker-embedder.js"),
    );
    const resolved = resolveEmbedderWorkerUrl(devModule, () => {
      probed = true;
      return true;
    });
    expect(resolved.href).toBe(new URL("./embedder-worker.js", devModule).href);
    expect(probed).toBe(false);
  });
});


/** 每個 request 都由測試明確放行；dispose 不占推論測試的 gate。 */
function controlledEmbedder(overrides: Partial<WorkerEmbedderOptions> = {}) {
  const requests: { message: FakeMessage; worker: FakeEmbedderWorker }[] = [];
  const result = makeEmbedder(withRequests((message, worker) => {
    if (message.method === "dispose") worker.respond(message.id as number, null);
    else requests.push({ message, worker });
  }), overrides);
  return {
    ...result,
    requests,
    async release(index: number): Promise<void> {
      await waitFor(() => requests.length > index);
      const { message, worker } = requests[index]!;
      const params = message.params as { inputs?: { text: string }[]; text?: string };
      worker.respond(message.id as number, message.method === "embedDocuments"
        ? params.inputs!.map(({ text }) => new Float32Array([Number(text)]))
        : new Float32Array([Number(params.text ?? 0)]));
    },
  };
}

/** 只清空 promise continuation，不推進下一個 setImmediate 排程回合。 */
async function flushPromises(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
}

describe("WorkerEmbedder：有界公平排程", () => {
  it("空批次不建立 worker；已取消的空批次仍遵循取消契約", async () => {
    const { embedder, workers } = controlledEmbedder();
    await expect(embedder.embedDocuments([])).resolves.toEqual([]);
    const controller = new AbortController();
    controller.abort();
    await expect(embedder.embedDocuments([], { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(workers).toHaveLength(0);
    expect(embedder.schedulingStatus.admittedRequests).toBe(0);
    await embedder.dispose();
  });

  it("逐窗交還排程、查詢優先、有界連續查詢且背景文件輪流進展", async () => {
    const { embedder, requests, release } = controlledEmbedder({ scheduling: { maxWindowInputs: 1, maxQueryBurst: 2 } });
    const first = embedder.embedDocuments([0, 1, 2, 3, 4].map((text) => ({ text: String(text) })));
    await waitFor(() => requests.length === 1);
    const queries = [10, 11, 12, 13, 14, 15].map((text) => embedder.embedQuery(String(text)));
    const second = embedder.embedDocuments([{ text: "20" }, { text: "21" }]);
    const all = Promise.all([first, ...queries, second]);
    for (let i = 0; i < 13; i += 1) await release(i);
    const values = await all;
    const order = requests.map(({ message }) => {
      const params = message.params as { inputs?: { text: string }[]; text?: string };
      return Number(params.text ?? params.inputs![0]!.text);
    });
    expect(order).toEqual([0, 10, 11, 20, 12, 13, 1, 14, 15, 21, 2, 3, 4]);
    expect((values[0] as Float32Array[]).map((vec) => vec[0])).toEqual([0, 1, 2, 3, 4]);
    expect((values[7] as Float32Array[]).map((vec) => vec[0])).toEqual([20, 21]);
    expect(embedder.schedulingStatus).toMatchObject({
      admittedRequests: 0, admittedInputs: 0, admittedInputBytes: 0,
      completedRequests: 8, completedDocumentInputs: 7, completedWindows: 13,
      maxObservedRequests: 8, maxObservedInputs: 13, maxObservedWindowInputs: 1,
    });
    await embedder.dispose();
  });

  it("每窗採用最新 runtime batchSize 且不超過排程上限；快照保持原順序", async () => {
    const { embedder, requests, release } = controlledEmbedder({ scheduling: { maxWindowInputs: 3 } });
    const inputs = Array.from({ length: 7 }, (_, index) => ({ text: String(index), title: "合成標題" }));
    const run = embedder.embedDocuments(inputs);
    inputs[0]!.text = "99";
    await waitFor(() => requests.length === 1);
    const first = requests[0]!;
    first.worker.emit("message", {
      type: "response", id: first.message.id, ok: true,
      result: [0, 1, 2].map((n) => new Float32Array([n])),
      runtimeStatus: { ...STATUS, batchSize: 1 },
    });
    await waitFor(() => requests.length === 2);
    const second = requests[1]!;
    second.worker.emit("message", {
      type: "response", id: second.message.id, ok: true, result: [new Float32Array([3])],
      runtimeStatus: { ...STATUS, batchSize: 2 },
    });
    await release(2);
    await release(3);
    const result = await run;
    expect(requests.map(({ message }) => (message.params as { inputs: unknown[] }).inputs.length)).toEqual([3, 1, 2, 1]);
    expect(result.map((vec) => vec[0])).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(embedder.schedulingStatus.completedDocumentInputs).toBe(7);
    await embedder.dispose();
  });

  it("排隊取消立即拒絕並釋放准入；不必等正在執行的 native 工作", async () => {
    const { embedder, requests, release } = controlledEmbedder({ scheduling: { maxRequests: 2 } });
    const active = embedder.embedQuery("1");
    await waitFor(() => requests.length === 1);
    const controller = new AbortController();
    const queued = embedder.embedDocuments([{ text: "2" }], { signal: controller.signal });
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");
    const rejected = expect(queued).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await rejected;
    expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(embedder.schedulingStatus).toMatchObject({ admittedRequests: 1, queuedBackground: 0, cancelledRequests: 1 });
    const admittedAgain = embedder.embedQuery("3");
    expect(requests).toHaveLength(1);
    await release(0);
    await release(1);
    await Promise.all([active, admittedAgain]);
    expect(requests.map(({ message }) => message.method)).toEqual(["embedQuery", "embedQuery"]);
    await embedder.dispose();
  });

  it("排隊圖片收到取消後立即移除，不會啟動圖片 native 推論", async () => {
    const { embedder, requests, release } = controlledEmbedder();
    const active = embedder.embedQuery("1");
    await waitFor(() => requests.length === 1);
    const controller = new AbortController();
    const run = embedder.embedImage({ bytes: new Uint8Array([1, 2, 3]), mimeType: "image/png" }, { signal: controller.signal });
    const rejected = expect(run).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await rejected;
    await release(0);
    await active;
    await embedder.drain();
    expect(requests.map(({ message }) => message.method)).toEqual(["embedQuery"]);
    expect(embedder.schedulingStatus.admittedInputBytes).toBe(0);
    await embedder.dispose();
  });

  it("執行中圖片取消後仍等 native 回應才完成 drain 與 dispose", async () => {
    const { embedder, requests, release, workers } = controlledEmbedder();
    const controller = new AbortController();
    const run = embedder.embedImage({ bytes: new Uint8Array([1, 2, 3]) }, { signal: controller.signal });
    const rejected = expect(run).rejects.toMatchObject({ name: "AbortError" });
    await waitFor(() => requests.length === 1);
    controller.abort();
    let drained = false;
    const drain = embedder.drain().then(() => { drained = true; });
    const disposing = embedder.dispose();
    await flushPromises();
    expect(drained).toBe(false);
    expect(workers[0]!.terminated).toBe(false);
    await release(0);
    await Promise.all([rejected, drain, disposing]);
    expect(workers[0]!.terminated).toBe(true);
    expect(requests).toHaveLength(1);
  });

  it("執行中取消不釋放 native slot；回應後丟棄整批部分結果與剩餘視窗", async () => {
    const { embedder, requests, release, workers } = controlledEmbedder({ scheduling: { maxWindowInputs: 1 } });
    const controller = new AbortController();
    const run = embedder.embedDocuments([{ text: "1" }, { text: "2" }], { signal: controller.signal });
    const cancelled = expect(run).rejects.toMatchObject({ name: "AbortError" });
    await waitFor(() => requests.length === 1);
    controller.abort();
    const query = embedder.embedQuery("3");
    await flushPromises();
    expect(requests).toHaveLength(1);
    expect(embedder.schedulingStatus.active).toBe(1);
    expect(workers[0]!.posted.some((message) => message.type === "cancel")).toBe(true);
    await release(0);
    await cancelled;
    await release(1);
    await query;
    expect(requests.map(({ message }) => message.method)).toEqual(["embedDocuments", "embedQuery"]);
    expect(embedder.schedulingStatus).toMatchObject({ completedDocumentInputs: 0, cancelledRequests: 1 });
    await embedder.dispose();
  });

  it("取消視窗間隙的工作立即拒絕；drain 不把該間隙當作完成", async () => {
    const { embedder, release, requests } = controlledEmbedder({ scheduling: { maxWindowInputs: 1 } });
    const controller = new AbortController();
    const run = embedder.embedDocuments([{ text: "1" }, { text: "2" }], { signal: controller.signal });
    const cancelled = expect(run).rejects.toMatchObject({ name: "AbortError" });
    let drained = false;
    const drain = embedder.drain().then(() => { drained = true; });
    await release(0);
    await flushPromises();
    expect(drained).toBe(false);
    expect(embedder.schedulingStatus).toMatchObject({ active: 0, admittedRequests: 1, queuedBackground: 1, completedDocumentInputs: 0 });
    controller.abort();
    await cancelled;
    await drain;
    expect(requests).toHaveLength(1);
    await embedder.dispose();
  });

  it("dispose 在視窗間隙拒絕剩餘邏輯工作；不能漏掉排程而重建 worker", async () => {
    const { embedder, release, requests, workers } = controlledEmbedder({ scheduling: { maxWindowInputs: 1 } });
    const run = embedder.embedDocuments([{ text: "1" }, { text: "2" }]);
    const closed = expect(run).rejects.toBeInstanceOf(EmbedderWorkerClosedError);
    await release(0);
    await flushPromises();
    await embedder.dispose();
    await closed;
    expect(requests).toHaveLength(1);
    expect(workers).toHaveLength(1);
    expect(workers[0]!.terminated).toBe(true);
    expect(embedder.schedulingStatus).toMatchObject({ admittedRequests: 0, admittedInputBytes: 0 });
  });

  it("dispose 在第一個 dispatch 前仍會拒絕工作並釋放准入", async () => {
    const { embedder, workers } = controlledEmbedder();
    const run = embedder.embedQuery("1");
    const rejected = expect(run).rejects.toBeInstanceOf(EmbedderWorkerClosedError);
    await embedder.dispose();
    await rejected;
    expect(workers).toHaveLength(0);
    expect(embedder.schedulingStatus.admittedRequests).toBe(0);
  });

  it("後續視窗失敗只拒絕整批；下個邏輯請求仍可使用 worker", async () => {
    const { embedder, requests, release } = controlledEmbedder({ scheduling: { maxWindowInputs: 1 } });
    const run = embedder.embedDocuments([{ text: "1" }, { text: "2" }, { text: "3" }]);
    const rejected = expect(run).rejects.toMatchObject({ code: "input-too-long" });
    await release(0);
    await waitFor(() => requests.length === 2);
    const second = requests[1]!;
    second.worker.fail(second.message.id as number, { name: "EmbedderInputError", message: "合成超限輸入", code: "input-too-long" });
    await rejected;
    const query = embedder.embedQuery("4");
    await release(2);
    await query;
    expect(embedder.schedulingStatus).toMatchObject({ completedDocumentInputs: 0, completedWindows: 2, failedRequests: 1 });
    await embedder.dispose();
  });

  it("worker 在視窗間崩潰拒絕所有已准入工作；新請求重建且不重送舊視窗", async () => {
    const { embedder, requests, release, workers } = controlledEmbedder({ scheduling: { maxWindowInputs: 1 } });
    const run = embedder.embedDocuments([{ text: "1" }, { text: "2" }]);
    await waitFor(() => requests.length === 1);
    const queued = embedder.embedQuery("3");
    const failed = Promise.allSettled([run, queued]);
    await release(0);
    await flushPromises();
    workers[0]!.emit("exit", 1);
    expect((await failed).map((result) => result.status)).toEqual(["rejected", "rejected"]);
    expect(embedder.schedulingStatus.admittedRequests).toBe(0);
    const next = embedder.embedQuery("4");
    await release(1);
    await next;
    expect(workers).toHaveLength(2);
    expect(requests.map(({ message }) => message.method)).toEqual(["embedDocuments", "embedQuery"]);
    expect(embedder.schedulingStatus.completedDocumentInputs).toBe(0);
    await embedder.dispose();
  });

  it("回應與 promise 結算之間崩潰也不能把部分文件重新排回新 worker", async () => {
    const { embedder, requests, workers, release } = controlledEmbedder({ scheduling: { maxWindowInputs: 1 } });
    const run = embedder.embedDocuments([{ text: "1" }, { text: "2" }]);
    const rejected = expect(run).rejects.toBeInstanceOf(EmbedderWorkerCrashError);
    await waitFor(() => requests.length === 1);
    const request = requests[0]!;
    request.worker.respond(request.message.id as number, [new Float32Array([1])]);
    request.worker.emit("exit", 1);
    await rejected;
    await embedder.drain();
    expect(embedder.schedulingStatus).toMatchObject({ admittedRequests: 0, queuedBackground: 0, completedDocumentInputs: 0 });
    const next = embedder.embedQuery("3");
    await release(1);
    await next;
    expect(workers).toHaveLength(2);
    expect(requests.map(({ message }) => message.method)).toEqual(["embedDocuments", "embedQuery"]);
    await embedder.dispose();
  });

  it("請求數／輸入數／UTF-8 位元組皆含在途工作，超限拒絕且不複製大型輸入", async () => {
    const { embedder, release } = controlledEmbedder({ scheduling: { maxRequests: 2, maxInputs: 3, maxInputBytes: 8 } });
    const active = embedder.embedQuery("一");
    await expect(embedder.embedDocuments([{ text: "二二" }])).rejects.toBeInstanceOf(EmbedderQueueFullError);
    const inputs = [{ text: "x" }, { text: "y" }, { text: "z" }];
    Object.defineProperty(inputs, "0", { get: () => { throw new Error("超量時不應讀取或複製輸入"); } });
    await expect(embedder.embedDocuments(inputs)).rejects.toMatchObject({ code: "EEMBEDDERQUEUEFULL" });
    const bytes = new Uint8Array(9);
    Object.defineProperty(bytes, Symbol.iterator, { value: () => { throw new Error("超量時不應複製圖片"); } });
    await expect(embedder.embedImage({ bytes })).rejects.toBeInstanceOf(EmbedderQueueFullError);
    const queued = embedder.embedQuery("a");
    await expect(embedder.probe()).rejects.toBeInstanceOf(EmbedderQueueFullError);
    expect(embedder.schedulingStatus).toMatchObject({ admittedRequests: 2, admittedInputs: 2, admittedInputBytes: 4, rejectedRequests: 4 });
    await release(0);
    await release(1);
    await Promise.all([active, queued]);
    expect(embedder.schedulingStatus).toMatchObject({ admittedRequests: 0, admittedInputs: 0, admittedInputBytes: 0 });
    await embedder.dispose();
  });

  it("handshake 尚未完成時的取消立即拒絕，不會在 ready 後偷偷送 native 工作", async () => {
    // 測試自行接管 init，不回應 ready。
    const { embedder: blocked, workers: blockedWorkers } = makeEmbedder((message, worker) => {
      if (message.type === "request" && message.method === "dispose") worker.respond(message.id as number, null);
    });
    const controller = new AbortController();
    const run = blocked.embedDocuments([{ text: "1" }], { signal: controller.signal });
    await waitFor(() => blockedWorkers.length === 1);
    const cancelled = expect(run).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await cancelled;
    expect(blocked.schedulingStatus.admittedRequests).toBe(0);
    blockedWorkers[0]!.ready();
    await blocked.drain();
    expect(blockedWorkers[0]!.posted.some((message) => message.type === "request")).toBe(false);
    await blocked.dispose();
  });

  it("handshake 期間 dispose 不啟動 native 工作；所有並行 dispose 等同一個安全邊界", async () => {
    const { embedder, workers } = makeEmbedder((message, worker) => {
      if (message.type === "request" && message.method === "dispose") worker.respond(message.id as number, null);
    });
    const run = embedder.embedQuery("1");
    const rejected = expect(run).rejects.toBeInstanceOf(EmbedderWorkerClosedError);
    await waitFor(() => workers.length === 1);
    const first = embedder.dispose();
    const second = embedder.dispose();
    workers[0]!.ready();
    await Promise.all([first, second, rejected]);
    expect(workers[0]!.posted.filter((message) => message.type === "request").map((message) => message.method)).toEqual(["dispose"]);
    expect(workers[0]!.terminated).toBe(true);
  });

  it("ready 已結算但尚未送 request 的空隙關閉，不會在 closed 後啟動 native", async () => {
    const { embedder, workers } = makeEmbedder((message, worker) => {
      if (message.type === "request" && message.method === "dispose") worker.respond(message.id as number, null);
    });
    const run = embedder.embedQuery("1");
    const rejected = expect(run).rejects.toBeInstanceOf(EmbedderWorkerClosedError);
    await waitFor(() => workers.length === 1);
    workers[0]!.ready();
    await Promise.resolve();
    await embedder.dispose();
    await rejected;
    expect(workers[0]!.posted.filter((message) => message.type === "request").map((message) => message.method)).toEqual(["dispose"]);
  });

  it("ready 已結算但尚未送 request 的空隙崩潰，不會把 request 留在死 worker", async () => {
    const { embedder, workers } = makeEmbedder(() => undefined);
    const run = embedder.embedQuery("1");
    const rejected = expect(run).rejects.toBeInstanceOf(EmbedderWorkerCrashError);
    await waitFor(() => workers.length === 1);
    workers[0]!.ready();
    await Promise.resolve();
    workers[0]!.emit("exit", 1);
    await rejected;
    await embedder.drain();
    expect(workers[0]!.posted.some((message) => message.type === "request")).toBe(false);
    await embedder.dispose();
  });

  it("並行 dispose 都必須等待正在執行的 native 工作", async () => {
    const { embedder, requests, release, workers } = controlledEmbedder();
    const run = embedder.embedQuery("1");
    await waitFor(() => requests.length === 1);
    let secondDone = false;
    const first = embedder.dispose();
    const second = embedder.dispose().then(() => { secondDone = true; });
    await flushPromises();
    expect(secondDone).toBe(false);
    expect(workers[0]!.terminated).toBe(false);
    await release(0);
    await Promise.all([run, first, second]);
    expect(workers[0]!.terminated).toBe(true);
  });

  it("彙總診斷是快照且只含計數與時間，不洩漏合成輸入；進度到整批完成才結算", async () => {
    const { embedder, release, requests } = controlledEmbedder({ scheduling: { maxWindowInputs: 1 } });
    const run = embedder.embedDocuments([{ text: "1", title: "synthetic-private-title" }, { text: "2" }]);
    await release(0);
    await flushPromises();
    const partial = embedder.schedulingStatus;
    expect(partial).toMatchObject({ completedWindows: 1, completedDocumentInputs: 0, admittedRequests: 1, admittedInputs: 2 });
    expect(JSON.stringify(partial)).not.toContain("synthetic-private-title");
    partial.limits.maxInputs = 999;
    expect(embedder.schedulingStatus.limits.maxInputs).toBe(8192);
    await release(1);
    await run;
    await embedder.drain();
    expect(requests).toHaveLength(2);
    expect(embedder.schedulingStatus).toMatchObject({ completedWindows: 2, completedDocumentInputs: 2, completedRequests: 1 });
    expect(embedder.schedulingStatus.queueWaitMs).toBeGreaterThanOrEqual(0);
    expect(embedder.schedulingStatus.workerRunMs).toBeGreaterThanOrEqual(0);
    await embedder.dispose();
  });
});
