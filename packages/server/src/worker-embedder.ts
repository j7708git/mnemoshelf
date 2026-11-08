/**
 * `WorkerEmbedder`：把真實的 embedder 推論放到 **Node worker thread**，主執行緒只留 HTTP／DB。
 *
 * 為什麼：onnxruntime-node 的 CPU 推論在**呼叫執行緒同步執行**。先前 embedder 直接跑在 server
 * 主執行緒，索引期間 `/health`、`/diagnostics`、`/index/status` 會 20–90 秒沒有回應
 * （量測見筆記：20ms interval ticks=0、event-loop max 71.5s）。這裡用 `node:worker_threads`
 * （**不新增依賴**）把模型搬出主執行緒；DB 的單一寫入者仍只在主執行緒（worker 不碰 DB）。
 *
 * 設計重點：
 * - **`info` 同步可用**：建構子會建一個**不載入模型**的 `TransformersEmbedder`，只取 `info`
 *   （`createServer` 要同步用 `embedder.info.dim` 建 `SqliteVectorIndex`）。真正的實例在 worker 內。
 *   metadata 實例**強制 `cpu`**：建構子在 macOS 的 `auto` 會讀／寫裝置決定快取，主執行緒再走一次
 *   會讓「載入期崩潰重試」計數被重複推進；`info` 只看模型與 dtype，換裝置不改變 `info.id`。
 *   也因為繞過了裝置選項，這裡先自行呼叫 `parseEmbedDeviceOption`，維持「非法值啟動失敗」。
 * - **一次只有一個進行中的呼叫**：worker 只有一個模型 session，proxy 以有界雙佇列序列化所有
 *   `embed*`／`probe`。文件批次逐窗交還排程；查詢優先且有連續查詢上限，背景工作不會飢餓。
 * - **取消**：`embedDocuments` 的 `AbortSignal` 以 `{type:"cancel"}` 訊息送進 worker；native 推論
 *   不可中斷，因此取消在**下一個邊界**（下一個批次視窗／下一次取消檢查）生效。呼叫端若在
 *   完成後才 abort，proxy 也會以 `AbortError` 拒絕（語意一致：取消後不採用結果）。
 * - **崩潰**：worker 意外結束／發出 `error` 時，在途呼叫以 `EmbedderWorkerCrashError` 拒絕
 *   （不 hang），下一次呼叫會**自動重建一次**（`maxRestarts`）；連續失敗超過上限就一律回
 *   清楚錯誤，避免無限 crash loop。
 * - **安全關閉**：native 推論不可中斷，terminate 一個正在推論的 worker、或讓行程在 native
 *   返回前結束，都會在 teardown 拋 `Napi::Error` abort 整個行程（SIGABRT）。因此 `dispose()`
 *   會拒絕尚未執行的工作，再 `drain()` 等目前在途的視窗結束，worker 閒置後才 terminate；
 *   `createServer.close()` 回傳時已無 native 推論在跑，呼叫端之後 `process.exit()` 是安全的。
 *   只有 drain 超過上限（worker 卡死，預設 120 秒）才記錄並放棄：**不 terminate** 推論中的
 *   worker，此時呼叫端不得 `process.exit()`（理論邊界，見 `docs/roots-and-privacy.md` 的「資料存放與刪除」一節）。
 * - `runtimeStatus` 由 worker 提供：初次 handshake 後快取，之後每次回應都更新；尚未 handshake
 *   前為 `undefined`（與沒有裝置概念的 embedder 相同，診斷層顯示 `null`）。
 *
 * 協定（主執行緒 → worker）：`init`（建 embedder）、`request`（方法＋參數，含 id）、`cancel`。
 * worker → 主執行緒：`ready`（info／runtimeStatus／初始化錯誤）、`response`（結果／錯誤／
 * runtimeStatus）。結果中的 `Float32Array` 以 transferable 傳回，避免多一次記憶體複製。
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import type { Transferable } from "node:worker_threads";
import type {
  AudioInput,
  DocumentInput,
  Embedder,
  EmbedderInfo,
  EmbedderRuntimeStatus,
  EmbedDocumentsOptions,
  ImageInput,
  ProbeResult,
} from "@mnemoshelf/core";
import {
  EMBED_DEVICE_ENV,
  parseEmbedDeviceOption,
  TransformersEmbedder,
  type TransformersEmbedderOptions,
} from "@mnemoshelf/embedder-transformers";

/** worker 端可執行的方法（與 `Embedder` 的公開方法一一對應）。 */
export type EmbedderWorkerMethod =
  | "embedDocuments"
  | "embedQuery"
  | "embedDocument"
  | "embedImage"
  | "embedAudio"
  | "probe"
  | "dispose";

/** 跨執行緒傳遞的錯誤（只保留結構化欄位；刻意不帶 stack／路徑）。 */
export interface EmbedderWorkerWireError {
  name: string;
  message: string;
  /** 穩定的錯誤碼（例如 `undecodable`／`input-too-long`）；沒有時不存在。 */
  code?: string;
}

/** 主執行緒 → worker：初始化（在 worker 內建立真的 `TransformersEmbedder`）。 */
export interface EmbedderWorkerInitMessage {
  type: "init";
  options: TransformersEmbedderOptions;
}

/** 主執行緒 → worker：取消某個進行中的 request id。 */
export interface EmbedderWorkerCancelMessage {
  type: "cancel";
  id: number;
}

/** 主執行緒 → worker：執行一個 embedder 方法。 */
export interface EmbedderWorkerRequestMessage {
  type: "request";
  id: number;
  method: EmbedderWorkerMethod;
  params: unknown;
}

export type EmbedderWorkerInboundMessage =
  | EmbedderWorkerInitMessage
  | EmbedderWorkerCancelMessage
  | EmbedderWorkerRequestMessage;

/** worker → 主執行緒：初始化完成（或失敗）。 */
export type EmbedderWorkerReadyMessage =
  | { type: "ready"; ok: true; info: EmbedderInfo; runtimeStatus?: EmbedderRuntimeStatus }
  | { type: "ready"; ok: false; error: EmbedderWorkerWireError };

/** worker → 主執行緒：某個 request 的結果。 */
export interface EmbedderWorkerResponseMessage {
  type: "response";
  id: number;
  ok: boolean;
  result?: unknown;
  error?: EmbedderWorkerWireError;
  runtimeStatus?: EmbedderRuntimeStatus;
}

export type EmbedderWorkerOutboundMessage = EmbedderWorkerReadyMessage | EmbedderWorkerResponseMessage
  | { type: "status"; runtimeStatus: EmbedderRuntimeStatus };

/**
 * 測試可注入的 worker 介面（只涵蓋 proxy 用到的部分）。
 *
 * 用結構型別而不是 `node:worker_threads` 的 `Worker`：單元測試可以注入一個在行程內的假 worker
 * （事件驅動、無執行緒），而正式路徑傳入真正的 `Worker`。
 */
export type EmbedderWorkerEvent = "message" | "error" | "exit";
export interface EmbedderWorkerLike {
  postMessage(message: unknown, transferList?: readonly Transferable[]): void;
  on(event: EmbedderWorkerEvent, listener: (...args: unknown[]) => void): unknown;
  off(event: EmbedderWorkerEvent, listener: (...args: unknown[]) => void): unknown;
  terminate(): Promise<number> | number | void;
}

/** `WorkerEmbedder` 的建構選項。 */
export interface WorkerEmbedderOptions {
  /** 交給 worker 內 `TransformersEmbedder` 的建構選項（cacheDir／appVersion／device…）。 */
  embedderOptions?: TransformersEmbedderOptions;
  /** 建立 worker 的工廠；預設載入同目錄的 `embedder-worker.js`。測試可注入假 worker。 */
  createWorker?: () => EmbedderWorkerLike;
  /**
   * 只提供 `info` 的輕量本體；預設自建一個**不載入模型**的 `TransformersEmbedder`。
   * 測試可注入 `FakeEmbedder`，避免每次 worker 測試都載入 embedder 套件。
   */
  metadataEmbedder?: Pick<Embedder, "info">;
  /** 等待 worker 完成 `ready` 的上限毫秒；預設 60 秒（worker 內只是建構子，不載模型）。 */
  handshakeTimeoutMs?: number;
  /** `dispose()` 等待優雅收尾／terminate 的上限毫秒；預設 5 秒。 */
  disposeTimeoutMs?: number;
  /**
   * `drain()`／`dispose()` 等在途推論收尾的上限毫秒；預設 **120 秒**。
   *
   * native 推論不可中斷，安全關閉必須等**目前這一個批次**跑完才能在邊界 terminate。
   * 超過上限視為 worker 卡死：記錄後放棄（不 terminate 推論中的 worker），
   * 此時呼叫端**不得** `process.exit()`（行程 teardown 仍可能 abort；理論邊界）。
   */
  drainTimeoutMs?: number;
  /** 推論排程護欄；未提供時使用有界預設。 */
  scheduling?: Partial<EmbedderSchedulingLimits>;
  /** 連續崩潰且沒有成功呼叫時，最多自動重建幾次；預設 1（卡上要求「至少一次」）。 */
  maxRestarts?: number;
}

/** worker 意外結束／初始化失敗（在途呼叫都會以此拒絕，不會 hang）。 */
export class EmbedderWorkerCrashError extends Error {
  /** 穩定錯誤碼（測試／上層可程式比對）。 */
  readonly code = "EWORKERCRASH";

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "EmbedderWorkerCrashError";
  }
}

/** `dispose()` 之後（或關閉途中）呼叫 embedder 方法。 */
export class EmbedderWorkerClosedError extends Error {
  /** 穩定錯誤碼（測試／上層可程式比對）。 */
  readonly code = "EWORKERCLOSED";

  constructor(message = "embedder worker 已關閉") {
    super(message);
    this.name = "EmbedderWorkerClosedError";
  }
}

/** 邏輯請求的准入與視窗上限（包含正在執行的工作）。 */
export interface EmbedderSchedulingLimits {
  maxRequests: number;
  maxInputs: number;
  maxInputBytes: number;
  maxWindowInputs: number;
  maxQueryBurst: number;
}

/** 僅含彙總數字，不保留文字、標題、路徑或請求識別值。 */
export interface EmbedderSchedulingStatus {
  admittedRequests: number;
  admittedInputs: number;
  admittedInputBytes: number;
  queuedQueries: number;
  queuedBackground: number;
  active: number;
  completedWindows: number;
  completedRequests: number;
  completedDocumentInputs: number;
  cancelledRequests: number;
  rejectedRequests: number;
  failedRequests: number;
  queueWaitMs: number;
  workerRunMs: number;
  maxObservedRequests: number;
  maxObservedInputs: number;
  maxObservedInputBytes: number;
  maxObservedWindowInputs: number;
  limits: EmbedderSchedulingLimits;
}

/** 准入超限；不截短輸入、不回傳部分向量，呼叫端可以稍後重試。 */
export class EmbedderQueueFullError extends Error {
  readonly code = "EEMBEDDERQUEUEFULL";
  constructor() {
    super("嵌入排程已達請求數、輸入數或位元組上限，請稍後重試");
    this.name = "EmbedderQueueFullError";
  }
}

interface ScheduledCall {
  query: boolean;
  inputs: number;
  documents: number;
  bytes: number;
  signal: AbortSignal | undefined;
  onAbort: (() => void) | undefined;
  settled: boolean;
  queuedAt: number;
  step: (state: WorkerState) => Promise<{ done: boolean; value?: unknown }>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  signal: AbortSignal | undefined;
  onAbort: (() => void) | undefined;
}

interface WorkerListeners {
  message: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  exit: (...args: unknown[]) => void;
}

interface WorkerState {
  worker: EmbedderWorkerLike;
  listeners: WorkerListeners;
  ready: Promise<void>;
  readyResolve: () => void;
  readyReject: (error: unknown) => void;
  readyTimer: ReturnType<typeof setTimeout> | null;
  readySettled: boolean;
  readyOk: boolean;
  dead: boolean;
  /** `dispose()` 已接手：exit 事件不再算「崩潰」。 */
  closing: boolean;
  /**
   * `dispose()` 在推論中途接手：在途呼叫已拒絕，但**還沒 terminate**（等 native 邊界）
   * （native 推論不可安全中斷）；等它回報（native 邊界）後才 terminate。
   */
  abandoned: boolean;
}

/** 取消檢查（沿用 core indexer／embedder 的 `throwIfAborted` 慣例）。 */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal === undefined) return;
  if (typeof signal.throwIfAborted === "function") {
    signal.throwIfAborted();
    return;
  }
  if (signal.aborted) throw abortError(signal);
}

/** 依 signal 產生取消錯誤（與 `throwIfAborted` 同語意）。 */
function abortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  const error = new Error("嵌入已取消");
  error.name = "AbortError";
  return error;
}

/** 把跨執行緒的錯誤物件還原成 `Error`（保留 name／code；不帶 stack）。 */
function reviveError(wire: EmbedderWorkerWireError | undefined): Error {
  if (wire === undefined) return new Error("embedder worker 回報未說明的錯誤");
  const error = new Error(wire.message);
  if (typeof wire.name === "string" && wire.name !== "") error.name = wire.name;
  if (typeof wire.code === "string") {
    Object.defineProperty(error, "code", { value: wire.code, enumerable: true, writable: true, configurable: true });
  }
  return error;
}

/** 錯誤 → 跨執行緒可傳的結構（不帶 stack，避免把本機路徑帶回主執行緒）。 */
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

/** 非負整數選項（未設定或非法時用預設）。 */
function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isInteger(value) && value > 0 ? value : fallback;
}

/** 非負整數（0 合法）。 */
function nonNegativeInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isInteger(value) && value >= 0 ? value : fallback;
}

/** 不可 unref 的短延遲（dispose 的 timeout 用；避免拖住行程）。 */
function unrefDelay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/**
 * 等 promise 最多 `ms` 毫秒；回傳是否在期限內完成。
 *
 * 只用於關閉流程的等待上限：promise 本身不會 reject（`drain()` 只等不拋），
 * 計時器一定要清掉，不能留到行程尾端。
 */
async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([promise.then(() => true, () => true), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** `app.asar` 在檔案路徑中的目錄段（前後都帶分隔符，避免誤中 `app.asar.unpacked`）。 */
const ASAR_SEGMENT = `${path.sep}app.asar${path.sep}`;

/**
 * 把 `…/app.asar/…` 路徑換成對應的 `…/app.asar.unpacked/…`；不在 asar 內時回 `null`。
 *
 * 用 `path.sep` 比對而非寫死 `/`：Windows 的 `fileURLToPath` 會給反斜線路徑。
 */
function toUnpackedPath(filePath: string): string | null {
  const index = filePath.indexOf(ASAR_SEGMENT);
  if (index === -1) return null;
  return (
    filePath.slice(0, index) +
    `${path.sep}app.asar.unpacked${path.sep}` +
    filePath.slice(index + ASAR_SEGMENT.length)
  );
}

/**
 * 解析 `embedder-worker.js` 的實際路徑（預設同目錄）。
 *
 * Electron 打包後 `import.meta.url` 位於 `app.asar` 內；worker 的入口必須是真實檔案，
 * 因此當 `electron-builder.yml` 把 `embedder-worker.js` 解包到 `app.asar.unpacked` 時，
 * 改用 unpacked 路徑。只有「module 在 app.asar 內」**且**「unpacked 檔真的存在」才替換；
 * 其餘情況（開發環境、未解包、檔案缺失）維持原路徑，行為與舊版相同。
 *
 * 抽成獨立函式是為了可測試：`pathExists` 可注入，單元測試不必真的建立 asar。
 */
export function resolveEmbedderWorkerUrl(
  moduleUrl: string | URL = import.meta.url,
  pathExists: (filePath: string) => boolean = existsSync,
): URL {
  const workerUrl = new URL("./embedder-worker.js", moduleUrl);
  const unpackedPath = toUnpackedPath(fileURLToPath(workerUrl));
  if (unpackedPath === null || !pathExists(unpackedPath)) return workerUrl;
  return pathToFileURL(unpackedPath);
}

/**
 * 預設 worker：載入 build 後的同目錄入口。
 *
 * `src/worker-embedder.ts` 與 `dist/worker-embedder.js` 旁邊都有 `embedder-worker.*`；
 * 正式路徑（`tsc` 產物）解析到 `dist/embedder-worker.js`。單元測試一律注入 `createWorker`，
 * 因此不依賴 vitest 對 TS 原始碼的轉換。Electron 打包後由 `resolveEmbedderWorkerUrl`
 * 改用 `app.asar.unpacked` 的實體檔案（見 `electron-builder.yml` 的 `asarUnpack`）。
 */
function defaultCreateWorker(): EmbedderWorkerLike {
  return new Worker(resolveEmbedderWorkerUrl(import.meta.url));
}

/**
 * 建一個**只取 `info`** 的 metadata 本體。
 *
 * 強制 `cpu` 的兩個理由：
 * 1. 建構子不載模型，但 macOS 的 `auto` 會同步讀裝置決定快取、且特定狀態會**寫回**
 *    （載入期崩潰重試計數）。主執行緒不該是那個決策的參與者——真正載入只發生在 worker。
 * 2. `info.id` 只由模型 id 與 dtype 決定（見 embedder 的說明：換裝置不改變 `info.id`），
 *    所以 `cpu` 得到的 `info` 與 worker 內實際裝置完全相同。
 *
 * `MNEMOSHELF_EMBED_DEVICE` 的驗證原本發生在 embedder 建構子（非法值→啟動失敗）；強制 `cpu`
 * 會繞過它，因此先在這裡解析一次，維持既有「非法值直接拒絕啟動」的行為。
 */
function createMetadataEmbedder(options: TransformersEmbedderOptions): Pick<Embedder, "info"> {
  parseEmbedDeviceOption(options.device ?? process.env[EMBED_DEVICE_ENV]);
  return new TransformersEmbedder({ ...options, device: "cpu" });
}

/**
 * 實作 `Embedder` 的 worker proxy（同一時間最多一個進行中的呼叫）。
 *
 * 生命週期：建構（同步取得 `info`）→ 第一次 `embed*`／`probe` 才建立 worker 並 handshake
 * （模型仍由第一次推論 lazy 載入）→ `dispose()` 關閉 worker。`dispose()` 冪等。
 */
export class WorkerEmbedder implements Embedder {
  /** 能力宣告；與 worker 內的實例相同（由同一組模型／dtype 選項建構）。 */
  readonly info: EmbedderInfo;

  private readonly embedderOptions: TransformersEmbedderOptions;
  private readonly createWorker: () => EmbedderWorkerLike;
  private readonly handshakeTimeoutMs: number;
  private readonly disposeTimeoutMs: number;
  private readonly drainTimeoutMs: number;
  private readonly maxRestarts: number;

  private state: WorkerState | null = null;
  /** 已送出但尚未回應的 request（序列化下最多一個；dispose／崩潰時會全部拒絕）。 */
  private readonly pending = new Map<number, PendingRequest>();
  private readonly limits: EmbedderSchedulingLimits;
  private readonly queryQueue: ScheduledCall[] = [];
  private readonly backgroundQueue: ScheduledCall[] = [];
  private readonly admitted = new Set<ScheduledCall>();
  private active: ScheduledCall | null = null;
  private scheduled = false;
  private queryBurst = 0;
  private inputCount = 0;
  private inputBytes = 0;
  private completedWindows = 0;
  private completedRequests = 0;
  private completedDocumentInputs = 0;
  private cancelledRequests = 0;
  private rejectedRequests = 0;
  private failedRequests = 0;
  private queueWaitMs = 0;
  private workerRunMs = 0;
  private maxObservedRequests = 0;
  private maxObservedInputs = 0;
  private maxObservedInputBytes = 0;
  private maxObservedWindowInputs = 0;
  /** 已准入但尚未結算的邏輯呼叫數（跨視窗保持不變）。 */
  private busy = 0;
  /** `drain()` 的等待者：`busy` 歸零時喚醒。 */
  private readonly idleWaiters = new Set<() => void>();
  /** 由 worker 回應更新的 runtimeStatus（handshake 前沒有值）。 */
  private statusValue: EmbedderRuntimeStatus | undefined;
  private nextId = 0;
  /** 連續失敗次數（任何一次成功回應就歸零）。 */
  private consecutiveCrashes = 0;
  private closed = false;
  private disposal: Promise<void> | null = null;

  constructor(options: WorkerEmbedderOptions = {}) {
    this.embedderOptions = options.embedderOptions ?? {};
    this.createWorker = options.createWorker ?? defaultCreateWorker;
    this.handshakeTimeoutMs = positiveInteger(options.handshakeTimeoutMs, 60_000);
    this.disposeTimeoutMs = positiveInteger(options.disposeTimeoutMs, 5_000);
    this.drainTimeoutMs = positiveInteger(options.drainTimeoutMs, 120_000);
    this.maxRestarts = nonNegativeInteger(options.maxRestarts, 1);
    const limits = options.scheduling;
    this.limits = {
      maxRequests: positiveInteger(limits?.maxRequests, 128),
      maxInputs: positiveInteger(limits?.maxInputs, 8192),
      maxInputBytes: positiveInteger(limits?.maxInputBytes, 64 * 1024 * 1024),
      maxWindowInputs: positiveInteger(limits?.maxWindowInputs, 16),
      maxQueryBurst: positiveInteger(limits?.maxQueryBurst, 4),
    };
    const metadata = options.metadataEmbedder ?? createMetadataEmbedder(this.embedderOptions);
    this.info = metadata.info;
  }

  /**
   * 執行裝置狀態；初次 handshake 前為 `undefined`。
   *
   * 之後每次 worker 回應都會更新（模型載入完成、退回 CPU 等狀態變化都看得到）。
   */
  get runtimeStatus(): EmbedderRuntimeStatus | undefined {
    return this.statusValue;
  }

  get schedulingStatus(): EmbedderSchedulingStatus {
    return {
      admittedRequests: this.busy,
      admittedInputs: this.inputCount,
      admittedInputBytes: this.inputBytes,
      queuedQueries: this.queryQueue.length,
      queuedBackground: this.backgroundQueue.length,
      active: this.active === null ? 0 : 1,
      completedWindows: this.completedWindows,
      completedRequests: this.completedRequests,
      completedDocumentInputs: this.completedDocumentInputs,
      cancelledRequests: this.cancelledRequests,
      rejectedRequests: this.rejectedRequests,
      failedRequests: this.failedRequests,
      queueWaitMs: this.queueWaitMs,
      workerRunMs: this.workerRunMs,
      maxObservedRequests: this.maxObservedRequests,
      maxObservedInputs: this.maxObservedInputs,
      maxObservedInputBytes: this.maxObservedInputBytes,
      maxObservedWindowInputs: this.maxObservedWindowInputs,
      limits: { ...this.limits },
    };
  }

  async embedQuery(text: string): Promise<Float32Array> {
    return await this.call<Float32Array>("embedQuery", { text }, undefined, this.textBytes(text));
  }

  async embedDocument(text: string, title?: string): Promise<Float32Array> {
    return await this.call<Float32Array>(
      "embedDocument", title === undefined ? { text } : { text, title }, undefined,
      this.textBytes(text, title),
    );
  }

  async embedDocuments(
    inputs: readonly DocumentInput[],
    opts?: EmbedDocumentsOptions,
  ): Promise<Float32Array[]> {
    const signal = opts?.signal;
    if (this.closed) throw new EmbedderWorkerClosedError();
    throwIfAborted(signal);
    if (inputs.length === 0) return [];
    this.checkAdmission(inputs.length, 0);
    let bytes = 0;
    for (const input of inputs) {
      bytes += this.textBytes(input.text, input.title);
      this.checkAdmission(inputs.length, bytes);
    }
    return await this.enqueue<Float32Array[]>(false, inputs.length, bytes, signal, () => {
      // 准入後才擷取有界快照，避免呼叫端在排隊期間修改輸入。
      const snapshot = inputs.map(({ text, title }) => title === undefined ? { text } : { text, title });
      const vectors: Float32Array[] = [];
      let offset = 0;
      return async (state) => {
        throwIfAborted(signal);
        const windowSize = Math.min(this.limits.maxWindowInputs, positiveInteger(this.statusValue?.batchSize, 1));
        const window = snapshot.slice(offset, offset + windowSize);
        this.maxObservedWindowInputs = Math.max(this.maxObservedWindowInputs, window.length);
        const result = await this.send(state, "embedDocuments", { inputs: window }, signal);
        throwIfAborted(signal);
        if (!Array.isArray(result) || result.length !== window.length) {
          throw new Error("embedder worker 的批次輸出數量不符");
        }
        vectors.push(...result as Float32Array[]);
        offset += window.length;
        if (this.closed && offset < snapshot.length) throw new EmbedderWorkerClosedError();
        return { done: offset === snapshot.length, value: vectors };
      };
    }, inputs.length);
  }

  async embedImage(image: ImageInput, opts?: EmbedDocumentsOptions): Promise<Float32Array> {
    const signal = opts?.signal;
    throwIfAborted(signal);
    return await this.enqueue<Float32Array>(false, 1, image.bytes.byteLength + this.textBytes(image.mimeType ?? ""), signal, () => {
      // 准入後才複製；不可 detach 呼叫端仍需用來計算 hash 的 buffer。
      const bytes = new Uint8Array(image.bytes);
      const params = image.mimeType === undefined ? { bytes } : { bytes, mimeType: image.mimeType };
      return async (state) => {
        throwIfAborted(signal);
        const value = await this.send(state, "embedImage", params, signal, [bytes.buffer]);
        throwIfAborted(signal);
        return { done: true, value };
      };
    });
  }

  async probe(): Promise<ProbeResult> {
    return await this.call<ProbeResult>("probe", {}, undefined);
  }

  async embedAudio(audio: AudioInput, opts?: EmbedDocumentsOptions): Promise<Float32Array> {
    const signal = opts?.signal;
    throwIfAborted(signal);
    if (!(audio.samples instanceof Float32Array) || audio.sampleRate !== 16000 ||
        audio.samples.length === 0 || audio.samples.length > 480_000 ||
        audio.samples.some((sample) => !Number.isFinite(sample) || Math.abs(sample) > 1)) {
      throw Object.assign(new Error("音訊必須為 16 kHz、最多 30 秒的有限單聲道 PCM"), {
        name: "EmbedderInputError", code: "undecodable",
      });
    }
    return await this.enqueue<Float32Array>(false, 1, audio.samples.byteLength, signal, () => {
      // 准入後才複製，不 detach 呼叫端的 PCM；一次片段即一個公平排程視窗。
      const samples = new Float32Array(audio.samples);
      return async (state) => {
        throwIfAborted(signal);
        const value = await this.send(state, "embedAudio", { samples, sampleRate: 16000 }, signal, [samples.buffer]);
        throwIfAborted(signal);
        return { done: true, value };
      };
    });
  }

  /**
   * 等目前所有在途／已排隊的嵌入呼叫結束（**不關閉** worker）。
   *
   * 關閉流程用：取消在途索引後，等正在跑的 native 推論批次收尾；之後 `dispose()` 才能
   * 在安全邊界 terminate（推論中 terminate 或行程先結束都會 N-API abort）。
   * 這個 promise 只等不拋：worker 卡死時它不會自己結束，呼叫端要用期限包住
   * （`dispose()` 內建 `drainTimeoutMs` 上限）。
   */
  async drain(): Promise<void> {
    await this.waitForIdle();
  }

  /**
   * 關閉 worker（冪等、**不 hang**）。
   *
   * - **有在途／排隊呼叫（native 推論可能正在跑）**：先拒絕排隊工作，再等目前 native 視窗，
   *   worker 閒置後才 terminate。**不**在推論中 terminate、也不放手讓行程先結束：
   *   實測 macOS CPU 的 onnxruntime 會拋出 `Napi::Error` abort 整個行程（SIGABRT）。
   *   等「目前一個批次」跑完是安全關閉的必要代價（`close()` 回傳前完成）。
   * - **drain 超過上限**（`drainTimeoutMs`，預設 120 秒；呼叫端可傳 `timeoutMs` 覆寫）：
   *   記錄後**放棄**：拒絕在途呼叫、保留 worker 的 ref、等它在 native 邊界回報後才 terminate。
   *   這是 worker 卡死的理論邊界；此時呼叫端**不得** `process.exit()`。
   * - **沒有在途呼叫**：先請 worker 釋放模型 session（有上限），再 `terminate()`。
   * - 優雅關閉請求也逾時（worker 沒回報，可能卡在 native）：走同一條放棄路徑。
   *
   * 尚未執行的工作與未完成的多窗文件以 `EmbedderWorkerClosedError` 拒絕；正在執行的單窗
   * 工作仍可正常取得結果。drain 超時則拒絕所有呼叫；關閉後不再接受任何新呼叫。
   *
   * @param options.timeoutMs 覆寫這次等待 drain 的上限（0＝不重複等待，直接走放棄路徑；
   *   供 `createServer.close()` 在整體期限已用完時使用）。
   */
  async dispose(options: { timeoutMs?: number } = {}): Promise<void> {
    this.disposal ??= this.disposeInternal(options);
    await this.disposal;
  }

  private async disposeInternal(options: { timeoutMs?: number }): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.rejectQueued(new EmbedderWorkerClosedError());
    const state = this.state;
    if (state === null) {
      await this.waitForIdle();
      return;
    }
    state.closing = true;

    // 1) 排隊工作已拒絕；等目前在途視窗結束：native 推論不可中斷，推論中 terminate 或讓
    //    行程先結束都會 abort。關閉後新呼叫會因 `closed` 立刻失敗，不影響這裡的收斂。
    if (this.busy > 0 || this.pending.size > 0) {
      const budget = options.timeoutMs ?? this.drainTimeoutMs;
      if (!(await settlesWithin(this.waitForIdle(), Math.max(0, budget)))) {
        console.error(
          `[mnemoshelf] embedder worker 在 ${budget}ms 內未完成目前在途推論；` +
            "放棄等待（不 terminate 推論中的 worker；此時結束行程不保證安全）",
        );
        this.abandon(state, new EmbedderWorkerClosedError());
        return;
      }
    }

    // 2) worker 已閒置：先請它釋放模型 session（有上限），再 terminate。
    if (!state.dead && state.readyOk) {
      try {
        const finished = await Promise.race([
          this.send(state, "dispose", {}, undefined).then(() => true),
          unrefDelay(this.disposeTimeoutMs).then(() => false),
        ]);
        if (!finished) {
          // dispose 請求已送出，但 worker 可能在 native 內沒回報：同樣不能 terminate。
          this.abandon(state, new EmbedderWorkerClosedError());
          return;
        }
      } catch {
        // 忽略：下面走安全 terminate（沒有在途呼叫）。
      }
    }

    this.state = null;
    this.rejectPending(new EmbedderWorkerClosedError());
    if (!state.readySettled) {
      state.readySettled = true;
      state.readyOk = false;
      state.readyReject(new EmbedderWorkerClosedError());
    }
    if (state.readyTimer !== null) {
      clearTimeout(state.readyTimer);
      state.readyTimer = null;
    }
    state.dead = true;
    this.detach(state);
    await this.terminate(state.worker);
  }

  /**
   * 等所有已准入的邏輯呼叫完成，包括視窗間空隙、handshake 與 native 回應後的結算。
   * 關閉之後不會有新准入；只有 native 卡住時才需由 dispose 的期限放棄等待。
   */
  private async waitForIdle(): Promise<void> {
    while (this.busy > 0 || this.pending.size > 0 || this.active !== null) {
      await new Promise<void>((resolve) => {
        this.idleWaiters.add(resolve);
      });
    }
  }

  /** 狀態變動後：若已完全閒置（沒有排隊、也沒有在途 request）就喚醒 `drain()` 的等待者。 */
  private notifyIdle(): void {
    if (this.busy > 0 || this.pending.size > 0 || this.active !== null) return;
    for (const resolve of [...this.idleWaiters]) resolve();
    this.idleWaiters.clear();
  }

  /**
   * 放棄一個可能正在 native 推論中的 worker（不 terminate）。
   *
   * 只在 `drain()`／優雅 dispose 請求超過上限時使用（worker 卡死的理論邊界）：
   * - 拒絕所有在途呼叫；之後的呼叫由 `closed` 擋掉。
   * - **不 unref**：推論中若行程先結束，onnxruntime 會在 teardown 拋 `Napi::Error` abort；
   *   保留 ref 讓 Node 等目前這一個 native 批次跑完（close 本身已返回）。
   * - **保留事件監聽**：worker 在 native 邊界回報時（`onMessage`）才 terminate，
   *   避免在推論中途 terminate 造成 `Napi::Error` abort。
   */
  private abandon(state: WorkerState, error: unknown): void {
    const nativePending = this.pending.size > 0;
    state.closing = true;
    state.abandoned = true;
    this.state = null;
    if (state.readyTimer !== null) {
      clearTimeout(state.readyTimer);
      state.readyTimer = null;
    }
    if (!state.readySettled) {
      state.readySettled = true;
      state.readyOk = false;
      state.readyReject(error);
    }
    this.rejectPending(error);
    for (const job of [...this.admitted]) this.finishJob(job, error);
    // handshake 期間尚無 native 請求，可以立即安全釋放。
    if (!nativePending) void this.terminateAbandoned(state);
    // 其餘情況刻意不 unref、也不 terminate：native 推論中結束行程會 abort。
  }

  /** 已放棄的 worker 回報（native 邊界）後，安全 terminate。 */
  private async terminateAbandoned(state: WorkerState): Promise<void> {
    if (state.dead) return;
    state.dead = true;
    this.detach(state);
    await this.terminate(state.worker);
  }

  /** 單筆方法與探測共用排程入口。 */
  private call<T>(
    method: EmbedderWorkerMethod,
    params: unknown,
    signal: AbortSignal | undefined,
    bytes = 0,
  ): Promise<T> {
    return this.enqueue<T>(method === "embedQuery", 1, bytes, signal, () => async (state) => {
      throwIfAborted(signal);
      const value = await this.send(state, method, params, signal);
      throwIfAborted(signal);
      return { done: true, value };
    }, method === "embedDocument" ? 1 : 0);
  }

  /** 先以字元長度擋掉明顯超限輸入，再精確計算 UTF-8 位元組，期間不複製文字。 */
  private textBytes(text: string, title?: string): number {
    if (this.closed) throw new EmbedderWorkerClosedError();
    if (text.length + (title?.length ?? 0) > this.limits.maxInputBytes) {
      this.rejectedRequests += 1;
      throw new EmbedderQueueFullError();
    }
    return Buffer.byteLength(text) + (title === undefined ? 0 : Buffer.byteLength(title));
  }

  private checkAdmission(inputs: number, bytes: number): void {
    if (this.closed) throw new EmbedderWorkerClosedError();
    if (this.busy >= this.limits.maxRequests || this.inputCount + inputs > this.limits.maxInputs ||
        this.inputBytes + bytes > this.limits.maxInputBytes) {
      this.rejectedRequests += 1;
      throw new EmbedderQueueFullError();
    }
  }

  /** 准入記帳涵蓋整個邏輯請求，視窗間也不會暫時變成 idle。 */
  private enqueue<T>(
    query: boolean, inputs: number, bytes: number, signal: AbortSignal | undefined,
    createStep: () => ScheduledCall["step"], documents = 0,
  ): Promise<T> {
    try {
      throwIfAborted(signal);
      this.checkAdmission(inputs, bytes);
      const step = createStep();
      throwIfAborted(signal);
      return new Promise<T>((resolve, reject) => {
        const job: ScheduledCall = {
          query, inputs, documents, bytes, signal, onAbort: undefined, settled: false, queuedAt: performance.now(), step,
          resolve: (value) => resolve(value as T), reject,
        };
        this.busy += 1;
        this.inputCount += inputs;
        this.inputBytes += bytes;
        this.admitted.add(job);
        this.maxObservedRequests = Math.max(this.maxObservedRequests, this.busy);
        this.maxObservedInputs = Math.max(this.maxObservedInputs, this.inputCount);
        this.maxObservedInputBytes = Math.max(this.maxObservedInputBytes, this.inputBytes);
        if (signal !== undefined) {
          job.onAbort = () => {
            if (this.active !== job || this.pending.size === 0) this.finishJob(job, abortError(signal));
          };
          signal.addEventListener("abort", job.onAbort, { once: true });
        }
        (query ? this.queryQueue : this.backgroundQueue).push(job);
        this.schedule();
      });
    } catch (error) {
      return Promise.reject(error);
    }
  }

  private finishJob(job: ScheduledCall, error?: unknown, value?: unknown): void {
    if (job.settled) return;
    job.settled = true;
    // 移除排隊 payload 的 closure；handshake 取消不必等 ready 才釋放大批文字／圖片。
    job.step = async () => ({ done: true });
    if (job.onAbort !== undefined) job.signal?.removeEventListener("abort", job.onAbort);
    for (const queue of [this.queryQueue, this.backgroundQueue]) {
      const index = queue.indexOf(job);
      if (index >= 0) queue.splice(index, 1);
    }
    this.admitted.delete(job);
    this.busy -= 1;
    this.inputCount -= job.inputs;
    this.inputBytes -= job.bytes;
    if (error !== undefined) {
      if (job.signal?.aborted === true) this.cancelledRequests += 1;
      else this.failedRequests += 1;
      job.reject(error);
    } else {
      this.completedRequests += 1;
      this.completedDocumentInputs += job.documents;
      job.resolve(value);
    }
    this.notifyIdle();
  }

  private rejectQueued(error: unknown): void {
    for (const job of [...this.admitted]) {
      if (job !== this.active) this.finishJob(job, error);
    }
  }

  /** 每一窗交還 event loop；查詢優先，但背景工作最多只讓過固定數量的查詢。 */
  private schedule(): void {
    if (this.scheduled || this.active !== null || this.closed || this.busy === 0) return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      if (this.closed || this.active !== null) return;
      const chooseQuery = this.queryQueue.length > 0 &&
        (this.backgroundQueue.length === 0 || this.queryBurst < this.limits.maxQueryBurst);
      const job = (chooseQuery ? this.queryQueue : this.backgroundQueue).shift();
      if (job === undefined) return;
      this.queryBurst = chooseQuery ? Math.min(this.queryBurst + 1, this.limits.maxQueryBurst) : 0;
      this.active = job;
      this.queueWaitMs += performance.now() - job.queuedAt;
      void this.runStep(job);
    });
  }

  private async runStep(job: ScheduledCall): Promise<void> {
    try {
      throwIfAborted(job.signal);
      const state = await this.ensureReady();
      if (job.settled) return;
      throwIfAborted(job.signal);
      const result = await job.step(state);
      if (job.settled) return;
      this.completedWindows += 1;
      throwIfAborted(job.signal);
      if (result.done) this.finishJob(job, undefined, result.value);
      else if (this.closed) this.finishJob(job, new EmbedderWorkerClosedError());
      else if (!job.settled) {
        job.queuedAt = performance.now();
        (job.query ? this.queryQueue : this.backgroundQueue).push(job);
      }
    } catch (error) {
      this.finishJob(job, error);
    } finally {
      this.active = null;
      this.notifyIdle();
      this.schedule();
    }
  }

  /** 取得（必要時建立）worker，並等它完成初始化。 */
  private async ensureReady(): Promise<WorkerState> {
    if (this.closed) throw new EmbedderWorkerClosedError();
    let state = this.state;
    if (state === null) {
      if (this.consecutiveCrashes > this.maxRestarts) {
        throw new EmbedderWorkerCrashError(
          `embedder worker 連續失敗 ${this.consecutiveCrashes} 次（自動重建上限 ${this.maxRestarts} 次），請重啟服務`,
        );
      }
      state = this.spawn();
    }
    await state.ready;
    if (this.closed) throw new EmbedderWorkerClosedError();
    return state;
  }

  /** 建立 worker、掛事件、送出 init；`ready` 由訊息或 timeout 結算。 */
  private spawn(): WorkerState {
    const worker = this.createWorker();
    let readyResolve!: () => void;
    let readyReject!: (error: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
    // 沒有人 await（例如 dispose 在 handshake 途中進來）也不能變成 unhandled rejection。
    ready.catch(() => undefined);

    const state: WorkerState = {
      worker,
      listeners: {
        message: (message) => this.onMessage(state, message),
        error: (error) => this.onWorkerFailure(state, error),
        exit: (code) => this.onWorkerExit(state, code),
      },
      ready,
      readyResolve,
      readyReject,
      readyTimer: null,
      readySettled: false,
      readyOk: false,
      dead: false,
      closing: false,
      abandoned: false,
    };
    this.state = state;

    worker.on("message", state.listeners.message);
    worker.on("error", state.listeners.error);
    worker.on("exit", state.listeners.exit);

    const timer = setTimeout(() => {
      this.onWorkerFailure(
        state,
        new EmbedderWorkerCrashError(`embedder worker 在 ${this.handshakeTimeoutMs}ms 內未完成初始化`),
      );
    }, this.handshakeTimeoutMs);
    timer.unref?.();
    state.readyTimer = timer;

    try {
      const init: EmbedderWorkerInitMessage = { type: "init", options: this.embedderOptions };
      worker.postMessage(init);
    } catch (error) {
      this.onWorkerFailure(state, error);
    }
    return state;
  }

  /** 處理 worker 訊息：`ready` 或 `response`。 */
  private onMessage(state: WorkerState, raw: unknown): void {
    if (state.dead) return;
    const message = raw as { type?: unknown; id?: unknown };
    if (message.type === "ready") {
      if (state.readySettled) return;
      state.readySettled = true;
      if (state.readyTimer !== null) {
        clearTimeout(state.readyTimer);
        state.readyTimer = null;
      }
      const ready = raw as EmbedderWorkerReadyMessage;
      if (!ready.ok) {
        const error = reviveError(ready.error);
        state.readyOk = false;
        state.readyReject(error);
        this.onWorkerFailure(state, error);
        return;
      }
      if (ready.info.id !== this.info.id || ready.info.dim !== this.info.dim) {
        const error = new EmbedderWorkerCrashError(
          `embedder worker 的 info 與主執行緒不一致（${ready.info.id}/${ready.info.dim} vs ${this.info.id}/${this.info.dim}）`,
        );
        state.readyOk = false;
        state.readyReject(error);
        this.onWorkerFailure(state, error);
        return;
      }
      if (ready.runtimeStatus !== undefined) this.setStatus(ready.runtimeStatus);
      state.readyOk = true;
      state.readyResolve();
      return;
    }

    if (message.type === "status") {
      const status = (raw as { runtimeStatus?: EmbedderRuntimeStatus }).runtimeStatus;
      if (status !== undefined) this.setStatus(status);
      return;
    }
    if (message.type !== "response" || typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (pending === undefined) {
      // 已放棄的 worker 在 native 邊界回報（結果已被丟棄）：現在它不在推論中，
      // 可以安全 terminate（不必把它留到行程結束）。
      if (state.abandoned) void this.terminateAbandoned(state);
      return;
    }
    const response = raw as EmbedderWorkerResponseMessage;
    if (response.runtimeStatus !== undefined) this.setStatus(response.runtimeStatus);
    if (response.ok) {
      // 任何一次成功都代表 worker 這次是健康的：重置連續失敗計數（重建預算）。
      this.consecutiveCrashes = 0;
      if (pending.signal?.aborted === true) pending.reject(abortError(pending.signal));
      else pending.resolve(response.result);
      return;
    }
    pending.reject(reviveError(response.error));
  }

  /** 建立並送出一個 request；取消以 `cancel` 訊息轉發（不提前 reject，維持單一在途）。 */
  private send(
    state: WorkerState,
    method: EmbedderWorkerMethod,
    params: unknown,
    signal: AbortSignal | undefined,
    transfer?: Transferable[],
  ): Promise<unknown> {
    if (this.closed && method !== "dispose") throw new EmbedderWorkerClosedError();
    if (state.dead || state.abandoned) throw new EmbedderWorkerCrashError("embedder worker 已無法接收工作");
    throwIfAborted(signal);
    const id = this.nextId;
    this.nextId += 1;

    const startedAt = performance.now();
    return new Promise<unknown>((resolve, reject) => {
      let settled = false;
      const finish = (settle: (value: unknown) => void, value: unknown): void => {
        if (settled) return;
        settled = true;
        if (method !== "dispose") this.workerRunMs += performance.now() - startedAt;
        if (pending.onAbort !== undefined) signal?.removeEventListener("abort", pending.onAbort);
        this.pending.delete(id);
        settle(value);
        this.notifyIdle();
      };
      const pending: PendingRequest = {
        resolve: (value) => finish(resolve, value),
        reject: (error) => finish(reject, error),
        signal,
        onAbort: undefined,
      };
      if (signal !== undefined) {
        pending.onAbort = () => {
          // native 推論不可中斷：只送取消訊息，讓 worker 在下一個邊界以 AbortError 回應。
          try {
            const cancel: EmbedderWorkerCancelMessage = { type: "cancel", id };
            state.worker.postMessage(cancel);
          } catch {
            // worker 已死：交給 exit／error 事件拒絕在途呼叫。
          }
        };
        signal.addEventListener("abort", pending.onAbort, { once: true });
      }
      this.pending.set(id, pending);
      try {
        const request: EmbedderWorkerRequestMessage = { type: "request", id, method, params };
        state.worker.postMessage(request, transfer);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        finish(
          reject,
          new EmbedderWorkerCrashError(`無法傳送工作給 embedder worker：${message}`, { cause: error }),
        );
      }
    });
  }

  /** worker 發出 `error`（未捕捉例外）→ 當成崩潰處理。 */
  private onWorkerFailure(state: WorkerState, error: unknown): void {
    if (state.dead) return;
    state.dead = true;
    if (this.state === state) this.state = null;
    if (state.readyTimer !== null) {
      clearTimeout(state.readyTimer);
      state.readyTimer = null;
    }
    const cause = error instanceof Error ? error : new Error(String(error));
    const crash =
      cause instanceof EmbedderWorkerCrashError
        ? cause
        : new EmbedderWorkerCrashError(`embedder worker 失敗：${cause.message}`, { cause });
    if (!state.readySettled) {
      state.readySettled = true;
      state.readyOk = false;
      state.readyReject(crash);
    }
    this.rejectPending(crash);
    for (const job of [...this.admitted]) {
      // 初始化錯誤由 ready promise 保留原始名稱；已 ready 的實例崩潰則立即使整個邏輯工作失效。
      if (job !== this.active || state.readyOk) this.finishJob(job, crash);
    }
    // 關閉中的 terminate 不算「崩潰連鎖」：不推進重建預算。
    if (!state.closing) this.consecutiveCrashes += 1;
    this.detach(state);
    try {
      void state.worker.terminate();
    } catch {
      // terminate 失敗不影響後續（執行緒會隨行程回收）。
    }
  }

  /** worker `exit`：關閉中＝正常；否則視為崩潰（在途呼叫以清楚錯誤拒絕）。 */
  private onWorkerExit(state: WorkerState, code: unknown): void {
    if (state.dead) return;
    if (state.closing || this.closed) {
      state.dead = true;
      if (this.state === state) this.state = null;
      if (!state.readySettled) {
        state.readySettled = true;
        state.readyOk = false;
        state.readyReject(new EmbedderWorkerClosedError());
      }
      this.rejectPending(new EmbedderWorkerClosedError());
      this.detach(state);
      return;
    }
    this.onWorkerFailure(state, new EmbedderWorkerCrashError(`embedder worker 意外結束（exit code ${String(code)}）`));
  }

  /** 拒絕所有在途呼叫（副本迭代：reject 會同步改動 map）。 */
  private rejectPending(error: unknown): void {
    for (const pending of [...this.pending.values()]) pending.reject(error);
  }

  /** 移除 worker 事件監聽（避免 terminate／exit 再進來）。 */
  private detach(state: WorkerState): void {
    try {
      state.worker.off("message", state.listeners.message);
      state.worker.off("error", state.listeners.error);
      state.worker.off("exit", state.listeners.exit);
    } catch {
      // 假 worker 可能不支援 off；忽略（事件處理器本身有 dead 守衛）。
    }
  }

  /** terminate 並等它結束（有上限，保證 dispose 不 hang）。 */
  private async terminate(worker: EmbedderWorkerLike): Promise<void> {
    try {
      const result = worker.terminate();
      if (result !== undefined && typeof (result as Promise<unknown>).then === "function") {
        await Promise.race([result as Promise<unknown>, unrefDelay(this.disposeTimeoutMs)]);
      }
    } catch {
      // terminate 失敗不影響 close：worker 執行緒會隨行程結束回收。
    }
  }

  /** 更新快取的 runtimeStatus（worker 是唯一來源）。 */
  private setStatus(status: EmbedderRuntimeStatus): void {
    this.statusValue = status;
  }
}
