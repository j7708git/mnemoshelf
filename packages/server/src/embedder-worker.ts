/**
 * embedder worker 的**入口**（`node:worker_threads`）。
 *
 * 這個檔案只會在 worker thread 內被執行（`parentPort !== null`）：主執行緒由
 * `worker-embedder.ts` 的 `WorkerEmbedder` 建立 worker 並以訊息驅動。職責刻意很薄：
 * 建立**真的** `TransformersEmbedder`（模型 session 只存在這個執行緒）、依 request 呼叫方法、
 * 把結果（含 `Float32Array`，以 transferable 傳回）與錯誤回報給主執行緒。
 *
 * 取消：`{type:"cancel", id}` 會 abort 對應的 `AbortController`。native 推論不可中斷，
 * 因此取消在**下一個邊界**生效（`embedDocuments` 內的下一個批次視窗／下一次取消檢查）；
 * 已完成但已取消的結果由 proxy 丟棄（不採用以外的語意都與直接呼叫相同）。
 *
 * 錯誤：以 `{name,message,code?}` 回傳（**不含 stack**，避免把本機路徑帶回主執行緒），
 * proxy 還原成 `Error` 並保留 `name`／`code`——core 的 `undecodable`／`AbortError` 判定因此不變。
 *
 * 注意：**不要**在這個檔案做 DB／HTTP 工作；worker 只持有模型，單一寫入者仍是主執行緒。
 * 檔案同時是協定的 worker 側實作；協定型別定義在 `worker-embedder.ts`（type-only import，
 * 不會把 proxy 的程式碼載進 worker）。
 */
import { parentPort } from "node:worker_threads";
import type { Transferable } from "node:worker_threads";
import type { DocumentInput, EmbedderRuntimeStatus, ImageInput } from "@mnemoshelf/core";
import { TransformersEmbedder, type TransformersEmbedderOptions } from "@mnemoshelf/embedder-transformers";
import type {
  EmbedderWorkerCancelMessage,
  EmbedderWorkerOutboundMessage,
  EmbedderWorkerRequestMessage,
  EmbedderWorkerResponseMessage,
  EmbedderWorkerWireError,
} from "./worker-embedder.js";

/** worker 端只需要 `postMessage` 與 `message` 事件（正式路徑是 `MessagePort`）。 */
interface WorkerPort {
  on(event: "message", listener: (message: unknown) => void): unknown;
  postMessage(value: unknown, transferList?: readonly Transferable[]): void;
}

/** 錯誤 → 跨執行緒可傳的結構（不帶 stack）。 */
function toWireError(error: unknown): EmbedderWorkerWireError {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return {
      name: error.name,
      message: error.message,
      ...(typeof code === "string" ? { code } : {}),
    };
  }
  return { name: "Error", message: typeof error === "string" ? error : "未知的嵌入錯誤" };
}

/** 讀取 `embedDocuments` 的參數（同一行程內的訊息；仍做基本檢查，錯誤會變成清楚的失敗）。 */
function readDocuments(params: unknown): DocumentInput[] {
  const inputs = (params as { inputs?: unknown } | null)?.inputs;
  if (!Array.isArray(inputs)) throw new Error("embedDocuments 缺少 inputs 陣列");
  return inputs.map((entry, index) => {
    const input = entry as { text?: unknown; title?: unknown } | null;
    if (typeof input?.text !== "string") throw new Error(`embedDocuments 第 ${index} 筆缺少 text`);
    return typeof input.title === "string" ? { text: input.text, title: input.title } : { text: input.text };
  });
}

/** 讀取單筆文字參數。 */
function readText(params: unknown): string {
  const text = (params as { text?: unknown } | null)?.text;
  if (typeof text !== "string") throw new Error("缺少 text 參數");
  return text;
}

/** 讀取圖片參數（位元組是 proxy 複製後 transfer 過來的 `Uint8Array`）。 */
function readImage(params: unknown): ImageInput {
  const record = params as { bytes?: unknown; mimeType?: unknown } | null;
  if (!(record?.bytes instanceof Uint8Array)) throw new Error("embedImage 缺少 bytes");
  return typeof record.mimeType === "string"
    ? { bytes: record.bytes, mimeType: record.mimeType }
    : { bytes: record.bytes };
}

/** 蒐集要 transfer 的 buffer（去重；只有真正的 `ArrayBuffer` 可以轉移）。 */
function buffersOf(vectors: readonly Float32Array[]): Transferable[] {
  const buffers = new Set<ArrayBuffer>();
  for (const vector of vectors) {
    if (vector.buffer instanceof ArrayBuffer) buffers.add(vector.buffer);
  }
  return [...buffers];
}

/**
 * 啟動 worker 的訊息迴圈（由檔案底部的 `parentPort` 自動呼叫；測試可注入假 port）。
 *
 * 初始化前收到 request 一律回「尚未初始化」的錯誤；初始化失敗（例如非法 dtype／環境變數）
 * 以 `ready{ok:false}` 回報，proxy 會把在途呼叫拒絕掉並可依重建策略重試。
 */
export function startEmbedderWorker(port: WorkerPort): void {
  /** 真正的 embedder；模型 session 只在這個執行緒內。 */
  let embedder: TransformersEmbedder | null = null;
  /** 進行中的可取消 request（目前只有 `embedDocuments`）。 */
  const controllers = new Map<number, AbortController>();

  const post = (message: EmbedderWorkerOutboundMessage, transferList?: Transferable[]): void => {
    if (transferList !== undefined && transferList.length > 0) port.postMessage(message, transferList);
    else port.postMessage(message);
  };

  const runtimeStatus = (): EmbedderRuntimeStatus | undefined => embedder?.runtimeStatus;

  const reply = (id: number, result: unknown, transfer: Transferable[] = []): void => {
    const status = runtimeStatus();
    const response: EmbedderWorkerResponseMessage = {
      type: "response",
      id,
      ok: true,
      result,
      ...(status === undefined ? {} : { runtimeStatus: status }),
    };
    post(response, transfer);
  };

  const replyError = (id: number, error: unknown): void => {
    const status = runtimeStatus();
    const response: EmbedderWorkerResponseMessage = {
      type: "response",
      id,
      ok: false,
      error: toWireError(error),
      ...(status === undefined ? {} : { runtimeStatus: status }),
    };
    post(response);
  };

  const initialize = (options: TransformersEmbedderOptions): void => {
    try {
      embedder = new TransformersEmbedder(options);
      const status = embedder.runtimeStatus;
      post({
        type: "ready",
        ok: true,
        info: embedder.info,
        ...(status === undefined ? {} : { runtimeStatus: status }),
      });
    } catch (error) {
      embedder = null;
      post({ type: "ready", ok: false, error: toWireError(error) });
    }
  };

  const handleRequest = async (message: EmbedderWorkerRequestMessage): Promise<void> => {
    const { id, method } = message;
    if (embedder === null) {
      replyError(id, new Error("embedder worker 尚未初始化"));
      return;
    }
    const controller = method === "embedDocuments" ? new AbortController() : null;
    if (controller !== null) controllers.set(id, controller);
    try {
      switch (method) {
        case "embedDocuments": {
          if (controller === null) throw new Error("embedDocuments 缺少取消控制器");
          const vectors = await embedder.embedDocuments(readDocuments(message.params), {
            signal: controller.signal,
          });
          reply(id, vectors, buffersOf(vectors));
          return;
        }
        case "embedQuery": {
          const vector = await embedder.embedQuery(readText(message.params));
          reply(id, vector, buffersOf([vector]));
          return;
        }
        case "embedDocument": {
          const params = message.params as { title?: unknown } | null;
          const text = readText(message.params);
          const vector =
            typeof params?.title === "string"
              ? await embedder.embedDocument(text, params.title)
              : await embedder.embedDocument(text);
          reply(id, vector, buffersOf([vector]));
          return;
        }
        case "embedImage": {
          const vector = await embedder.embedImage(readImage(message.params));
          reply(id, vector, buffersOf([vector]));
          return;
        }
        case "probe": {
          reply(id, await embedder.probe());
          return;
        }
        case "dispose": {
          await embedder.dispose();
          reply(id, null);
          return;
        }
      }
    } catch (error) {
      replyError(id, error);
    } finally {
      controllers.delete(id);
    }
  };

  port.on("message", (raw) => {
    const message = raw as { type?: unknown };
    if (message.type === "init") {
      const options = (raw as { options?: unknown }).options;
      if (options === undefined || options === null || typeof options !== "object") {
        post({ type: "ready", ok: false, error: { name: "Error", message: "init 缺少選項" } });
        return;
      }
      initialize(options as TransformersEmbedderOptions);
      return;
    }
    if (message.type === "cancel") {
      const cancel = raw as EmbedderWorkerCancelMessage;
      controllers.get(cancel.id)?.abort();
      return;
    }
    if (message.type === "request") {
      // 每個 request 各自處理；proxy 保證同一時間只有一個在途，這裡不需要再排隊。
      void handleRequest(raw as EmbedderWorkerRequestMessage);
    }
  });
}

// 只有在 worker thread 才啟動（主執行緒 import 本檔的型別／常數時不會有副作用）。
if (parentPort !== null) startEmbedderWorker(parentPort);
