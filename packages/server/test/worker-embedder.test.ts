/**
 * `WorkerEmbedder`（embedder 推論的 worker thread proxy）單元測試。
 *
 * 多數測試用**行程內的假 worker**（事件驅動、無執行緒）：可以精確控制延遲、錯誤與取消時序，
 * 不需要真的模型。另有一個測試用**真正的 `node:worker_threads` Worker**（見 `fixtures/`），
 * 驗證跨執行緒的崩潰處理：在途呼叫要有清楚錯誤、不 hang，下一次呼叫會自動重建一次。
 */
import { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";
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
          worker.respond(id, method === "probe" ? { ok: true } : new Float32Array([1]));
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
