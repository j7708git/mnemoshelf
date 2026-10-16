/**
 * TransformersEmbedder：以 `@huggingface/transformers`（ONNX）實作多模態 Embedder。
 *
 * 基線（M0 可行性 spike 的本機實測結論）：
 *   - 模型 `onnx-community/embeddinggemma-2-ONNX`。
 *   - dtype 逐元件 `{ model:"q4", vision_encoder:"q4" }`（q4 最快、最小；q8／fp32 可設定）。
 *   - 原生 768 維；輸出截斷成 512 維後**重新 L2 正規化**。
 *   - 圖片 `max_soft_tokens = 70`（延遲約 1/4，檢索品質不變）。
 *   - 只載文字＋圖片：`config.audio_config = null`。**不用** `pipeline("feature-extraction")`（會載入全部編碼器）。
 *
 * 執行裝置（`device` 選項／`MNEMOSHELF_EMBED_DEVICE`）：
 *   - `auto`（預設）：**只在 Windows** 嘗試 DirectML GPU（`dml`），其他平台維持現狀 CPU。
 *   - `dml` 載入或推論失敗時**自動退回 CPU**，不中斷；原因可在 `runtimeStatus.fallbackReason` 讀到。
 *   - **例外：解碼／輸入類失敗不退**（`EmbedderInputError`／`code:"undecodable"`）。一張壞圖
 *     不該讓整場永久失去 GPU；這類錯誤照常往上拋，由 core 記成 `skipped(undecodable)`。
 *   - 批次視窗依裝置：DML 32、CPU 16（見 `device.ts` 的實測依據），另受 token 預算限制
 *     （一窗的 token 總量上限，`BATCH_TOKEN_BUDGET`）。
 *   - 換裝置**不改變** `info.id`（只吃 model id 與 dtype）：向量兩者等值，既有索引不需重建。
 *
 * Session options（`createBackend`，所有裝置共用）：
 *   - `enableCpuMemArena: false`：關閉 ORT 的 CPU arena。arena 在請求超過目前 chunk 時會把
 *     chunk 以 2 的冪次往上翻，一次超過 1 GiB 的請求因而變成 ≥2 GiB 的單一配置；這個大小
 *     在 Chromium／Electron 內會被 PartitionAlloc **直接終止行程**（整個 app 閃退）。
 *     關掉即整條路移除，並大幅降低 RSS（代價：同工作負載約 +5% 時間，實測在噪聲範圍內）。
 *   - 選填 `logSeverityLevel`（環境變數 `MNEMOSHELF_EMBED_ORT_LOG`，診斷用，預設不開）。
 *
 * 文字 prefix：查詢 `task: search result | query: {q}`；文件 `title: {title} | text: {content}`
 * （無標題用 `title: none`）。**圖片不加 prefix**。
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { AutoConfig, AutoModel, AutoProcessor, env, load_image } from "@huggingface/transformers";
import type {
  DocumentInput,
  Embedder,
  EmbedderFallbackReason,
  EmbedderInfo,
  EmbedderRuntimeStatus,
  EmbedDocumentsOptions,
  ImageInput,
  ProbeResult,
} from "@mnemoshelf/core";
import {
  BATCH_TOKEN_BUDGET,
  CPU_BATCH_SIZE,
  EMBED_DEVICE_ENV,
  EMBED_DML_DEVICE_ID_ENV,
  EMBED_ORT_LOG_ENV,
  deviceBatchSize,
  parseDmlDeviceId,
  parseOrtLogLevel,
  requiresSerializedInference,
  parseEmbedDeviceOption,
  resolveEmbedDevice,
  summarizeFailure,
  type EmbedDevice,
  type EmbedDeviceOption,
  type OrtLogSeverityLevel,
} from "./device.js";
import {
  EmbedderInputError,
  EmptyImageInputError,
  InvalidEmbedderOptionError,
  ModelInferenceError,
  ModelLoadError,
  UnsupportedDtypeError,
} from "./errors.js";
import { runProbe } from "./probe.js";
import { assertMrlDimension, truncateAndNormalize } from "./vector.js";

/** 預設模型 id。 */
export const DEFAULT_MODEL_ID = "onnx-community/embeddinggemma-2-ONNX";
/** 預設輸出維度（截斷後）。 */
export const DEFAULT_DIM = 512;
/** 預設圖片 soft token 預算。 */
export const DEFAULT_MAX_SOFT_TOKENS = 70;

/**
 * CPU（預設裝置）的批次視窗上限，等同 `CPU_BATCH_SIZE`。
 *
 * 取值理由：批次會把同批文字 pad 到同批最長序列；批次愈大，pad 成本與記憶體愈高
 * （大量圖片批次曾把 RSS 推到數 GiB）。本專案的 chunk 是 600–1200 字元
 * （約 150–300 token），pad 成本相對小，取 16 作為「一次 forward 吃最多塊、
 * 又不會讓記憶體失控」的折衷。
 *
 * DirectML 用 `DML_BATCH_SIZE`（32，依實測最佳）；實際值見 `runtimeStatus.batchSize`。
 * 超過上限的輸入由 `embedDocuments` 內部切成多個視窗，呼叫端不需自行分批；
 * 另外，一窗的 token 總量若超過 `BATCH_TOKEN_BUDGET`，視窗會再自動縮小。
 */
export const MAX_BATCH_SIZE = CPU_BATCH_SIZE;

/** 本套件允許的 dtype（官方模型卡有 fp16，但契約明示不可用 fp16）。 */
export const SUPPORTED_DTYPES = ["fp32", "q8", "q4", "q4f16"] as const;
export type TransformersDtype = (typeof SUPPORTED_DTYPES)[number];

/** 逐元件的 dtype 設定（`model` 是文字模型）。用 type alias 才能相容於 transformers 的 `Record<string, DataType>`。 */
export type PerComponentDtype = {
  model: TransformersDtype;
  vision_encoder: TransformersDtype;
};

/** dtype 選項：單一字串（同時套用到文字與視覺）或逐元件指定。 */
export type DtypeOption = TransformersDtype | PerComponentDtype;

/** TransformersEmbedder 的建構子選項。 */
export interface TransformersEmbedderOptions {
  /** 模型 id，預設 `onnx-community/embeddinggemma-2-ONNX`。 */
  modelId?: string;
  /** dtype，預設 q4（逐元件 `{model:"q4", vision_encoder:"q4"}`）。 */
  dtype?: DtypeOption;
  /**
   * 嵌入裝置，預設 `auto`（環境變數 `MNEMOSHELF_EMBED_DEVICE` 可設定；選項優先於環境變數）。
   *
   * `auto`＝只在 Windows 嘗試 `dml`（DirectML GPU），其他平台維持現狀 CPU；
   * `dml` 不可用或失敗時自動退回 `cpu`，原因見 `runtimeStatus.fallbackReason`。
   */
  device?: EmbedDeviceOption;
  /** 輸出維度，預設 512。僅允許 128／256／512／768。 */
  dim?: number;
  /** 模型快取目錄；預設環境變數 `MNEMOSHELF_MODEL_DIR`，再預設 OS 使用者資料目錄下的 `mnemoshelf/models`。 */
  cacheDir?: string;
  /** 圖片 soft token 預算，預設 70。 */
  maxSoftTokens?: number;
  /**
   * 覆寫平台判斷（預設 `process.platform`）。
   *
   * 只為測試而存在：讓非 Windows 的開發機也能驗證 Windows 的裝置解析與退回路徑。
   * 產品碼不需要設定。
   */
  platform?: string;
}

/** 已載入的模型資源。 */
interface LoadedModel {
  processor: GemmaProcessor;
  model: GemmaModel;
}

/** transformers.js processor 的最小介面（避免相依其龐大的型別）。 */
interface GemmaProcessor {
  (text: string[] | string | null, images?: unknown): Promise<Record<string, unknown>>;
  image_processor: { max_soft_tokens: number };
}

/** Tensor 的最小介面。 */
interface GemmaTensor {
  dims: number[];
  tolist(): Promise<number[][]>;
}

/** model 輸出與可呼叫簽章的最小介面（含 dispose／sessions）。 */
interface GemmaModel {
  (inputs: unknown): Promise<{ sentence_embedding?: GemmaTensor }>;
  dispose?: () => Promise<unknown>;
  sessions?: Record<string, unknown>;
}

const DEFAULT_DTYPE: TransformersDtype = "q4";

/** 解析並驗證 dtype 選項，一律回傳逐元件形式。 */
function resolveDtype(option: DtypeOption): PerComponentDtype {
  if (typeof option === "string") {
    assertDtype(option);
    return { model: option, vision_encoder: option };
  }
  assertDtype(option.model);
  assertDtype(option.vision_encoder);
  return { model: option.model, vision_encoder: option.vision_encoder };
}

function assertDtype(value: string): asserts value is TransformersDtype {
  if ((SUPPORTED_DTYPES as readonly string[]).includes(value)) return;
  const reason =
    value === "fp16" || value === "bfloat16"
      ? "契約明示不可使用 float16（會出現 NaN 或靜默劣化）"
      : "不在此套件允許的 dtype 清單";
  throw new UnsupportedDtypeError(value, SUPPORTED_DTYPES, reason);
}

/** dtype 標籤，用於 `info.id`。 */
function dtypeLabel(dtype: PerComponentDtype): string {
  if (dtype.model === dtype.vision_encoder) return dtype.model;
  return `model-${dtype.model}-vision-${dtype.vision_encoder}`;
}

/** 由模型 id 與 dtype 標籤組出穩定識別（`-ONNX` 後綴不進 id）。 */
function buildEmbedderId(modelId: string, label: string): string {
  const lastSegment = modelId.split("/").pop() ?? modelId;
  const base = lastSegment.replace(/-ONNX$/i, "");
  return `${base}@onnx-${label}`;
}

/** OS 使用者資料目錄（跨平台，不硬寫分隔符）。 */
function osUserDataDir(home: string): string {
  if (process.platform === "win32") {
    return process.env.APPDATA && process.env.APPDATA.trim() !== ""
      ? process.env.APPDATA
      : join(home, "AppData", "Roaming");
  }
  if (process.platform === "darwin") {
    return join(home, "Library", "Application Support");
  }
  return process.env.XDG_DATA_HOME && process.env.XDG_DATA_HOME.trim() !== ""
    ? process.env.XDG_DATA_HOME
    : join(home, ".local", "share");
}

/** 模型快取的預設目錄。 */
export function defaultModelCacheDir(): string {
  const fromEnv = process.env.MNEMOSHELF_MODEL_DIR;
  if (fromEnv && fromEnv.trim() !== "") return fromEnv;
  return join(osUserDataDir(homedir()), "mnemoshelf", "models");
}

/** 取消檢查（沿用 @mnemoshelf/core indexer 的 `throwIfAborted` 慣例）。 */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal === undefined) return;
  if (typeof signal.throwIfAborted === "function") {
    signal.throwIfAborted();
    return;
  }
  if (signal.aborted) {
    const reason = signal.reason;
    if (reason instanceof Error) throw reason;
    const error = new Error("嵌入已取消");
    error.name = "AbortError";
    throw error;
  }
}

/** 依 signal 產生取消錯誤（與 `throwIfAborted` 同語意；用於等待佇列時被中止）。 */
function abortReason(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  const error = new Error("嵌入已取消（等待序列推論時）");
  error.name = "AbortError";
  return error;
}

/**
 * 等待序列鎖的呼叫（FIFO 佇列的一員）。
 *
 * `grant` 由釋放者呼叫，交棒時附上「釋放這一次持有」的函式。
 */
interface LockWaiter {
  grant: (release: () => void) => void;
  reject: (error: unknown) => void;
  signal: AbortSignal | undefined;
  onAbort: (() => void) | undefined;
}

/** 非同步取回 `sentence_embedding`，偶發取不到時重試一次（見 M0 spike「實作踩雷」）。 */
async function runModel(modelId: string, model: GemmaModel, inputs: unknown): Promise<number[][]> {
  let lastMessage = "未取得輸出";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const out = await model(inputs);
    const tensor = out?.sentence_embedding;
    if (tensor && typeof tensor.tolist === "function") {
      return tensor.tolist();
    }
    lastMessage = `模型輸出缺少可用的 sentence_embedding（第 ${attempt + 1} 次嘗試）`;
  }
  throw new ModelInferenceError(modelId, lastMessage);
}

/** 取消錯誤的名稱（與 `throwIfAborted` 的慣例一致）。 */
function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/**
 * 把「圖片解碼／前處理」階段的失敗轉成可辨識的 `EmbedderInputError`。
 *
 * 為什麼是**整個階段**而不是逐一比對訊息措辭：`load_image`（transformers.js → sharp／libvips）
 * 與圖片前處理（`RawImage.rgb()` 的通道轉換）**都不碰 ONNX session**，這一階段沒有任何裝置
 * 或模型推論工作，因此這裡的失敗在結構上就是「輸入無法處理」。用結構分類比比對解碼器訊息
 * 更耐用（措辭會隨 sharp／transformers.js 版本變動；core 現行的措辭清單只是給**其他**
 * embedder 實作當後備）。
 *
 * - 取消（`AbortError`）原樣拋出：取消不是「輸入壞掉」。
 * - 已是 `EmbedderInputError` 者原樣拋出，不重複包裝。
 * - 其餘包成 `EmbedderInputError`，底層摘要（已去識別化）放進訊息與 `cause`，方便診斷。
 *
 * `cause` 放的是**已遮罩的摘要**而不是原始錯誤：訊息會被遮罩（`summarizeFailure` 把家目錄
 * 換成 `~`），但原始錯誤物件若留在 `cause`，任何 `console.error(error)`／`util.inspect(error)`
 * 都會把 `[cause]` 連同裡面的本機絕對路徑一起印出來——也就是遮罩等於白做。`cause` 因此
 * 只放 `summarizeFailure` 的結果（錯誤名稱＋訊息首行、已遮罩、已截斷）。
 */
function asImageInputError(error: unknown): EmbedderInputError {
  if (error instanceof EmbedderInputError) return error;
  const summary = summarizeFailure(error);
  return new EmbedderInputError(`圖片解碼／前處理失敗：${summary}`, { cause: new Error(summary) });
}

/**
 * 取這一窗的 prompt token 總量（batch × 序列長度，含 padding）；取不到形狀時回 `null`。
 *
 * 用 processor 實際算出的 `input_ids` 形狀而不是自己估：`processor` 就是模型真正吃的
 * tokenizer 管線，形狀是精確值；估算法（見 core 的 `estimateTokens`）只在切塊端用來
 * 決定「一塊多大」，兩者互補。
 */
function promptTokens(processed: Record<string, unknown>): number | null {
  const inputIds = processed["input_ids"] as { dims?: unknown } | undefined;
  const dims = inputIds?.dims;
  if (!Array.isArray(dims) || dims.length !== 2) return null;
  const [batch, length] = dims as unknown[];
  if (typeof batch !== "number" || typeof length !== "number") return null;
  return batch * length;
}

/**
 * 多模態 embedder（真實模型）。
 *
 * lazy 載入：建構子不載模型；第一次 `embed*`／`probe()` 才載。`info` 不依賴模型，建構後即可同步讀取。
 * `dispose()` 後再呼叫 `embed*` 會**自動重新載入**（本實作選擇「自動重新載入」，見測試與註解）。
 *
 * 裝置與退回（`runtimeStatus` 可同步讀取，載入模型前就有值）：
 * - 建構子依 `device` 選項／環境變數與平台解析出**計畫裝置**（非 Windows 不可能是 `dml`）。
 * - 計畫裝置為 `dml` 時，載入或推論失敗**自動退回 CPU 並重試一次**（同一實例只退一次、退回後不再
 *   嘗試 `dml`），不讓整輪索引因此中斷；原因記在 `runtimeStatus.fallbackReason`。
 * - 取消（`AbortError`／`signal.aborted`）不算裝置失敗，一律原樣拋出。
 * - **輸入類失敗**（`EmbedderInputError`，例如解不開的圖）也不算裝置失敗：與裝置無關，
 *   不退回、不在同窗重試，原樣往上拋給 core 判定 `skipped(undecodable)`（見 `shouldFallBack`）。
 *
 * 序列推論（DirectML 的硬性限制）：
 * - `dml` 的同一 session 不支援並發 `Run`，而並發來源不止索引器（多個 root 同時索引、
 *   「索引＋搜尋」並行、探測與查詢交錯）。因此**本實例內建互斥佇列**：裝置為 `dml` 時，
 *   同一實例的所有推論單位（一批文件、一段文字、一張圖片）永不重疊，呼叫端不需自行排隊。
 * - 等待中的呼叫若被 abort → 直接以取消錯誤拒絕、**不執行**、立即讓出佇列（不卡住後面的呼叫）；
 *   已在執行中的呼叫不受影響（照常跑完或依自己的 signal 中止）。
 * - 退回 CPU 後互斥自動解除（CPU 可並發）。
 *
 * 已知限制：`loadModel()` 進行中呼叫 `dispose()` 時，進行中的載入完成後才會實際釋放
 * （`this.loaded` 在載入完成時設定）。此競態視窗為刻意接受：本專案架構為單一寫入者行程，
 * 「載入中 dispose」不會發生於正常生命週期；若未來需要嚴格即時釋放，以載入代數（generation
 * token）在完成時比對後再決定是否保留。
 */
export class TransformersEmbedder implements Embedder {
  readonly info: EmbedderInfo;

  private readonly modelId: string;
  private readonly dim: number;
  private readonly dtype: PerComponentDtype;
  private readonly cacheDir: string;
  private readonly maxSoftTokens: number;
  private readonly requestedDevice: EmbedDeviceOption;
  /**
   * DirectML adapter 索引（設定值）：只有 `dml` 路徑會帶進 session options，
   * 但**非 dml 路徑與退回 CPU 後仍照原設定顯示**，診斷才看得出「原本指定第 N 張卡、已退回」。
   */
  private readonly dmlDeviceId: number;
  /**
   * ONNX Runtime 的 log 等級覆寫（`undefined`＝不覆寫）。
   *
   * 只為診斷而存在（見 `EMBED_ORT_LOG_ENV`）；`0` 會讓 ORT 印出 arena 擴張的
   * `num_bytes`，用來確認「單一配置到底多大」。
   */
  private readonly ortLogLevel: OrtLogSeverityLevel | undefined;

  /** 目前（或計畫）使用的裝置；退回後永久為 `cpu`。 */
  private device: EmbedDevice;
  /** 退回原因；未退回為 null。 */
  private fallbackReason: EmbedderFallbackReason | null;

  private loaded: LoadedModel | null = null;
  private loading: Promise<LoadedModel> | null = null;
  /** 序列推論的鎖：`true` 表示有人持有（只有 `dml` 會用到）。 */
  private lockHeld = false;
  /** 等待序列鎖的佇列（FIFO）。 */
  private lockWaiters: LockWaiter[] = [];

  constructor(options: TransformersEmbedderOptions = {}) {
    this.modelId = options.modelId ?? DEFAULT_MODEL_ID;
    this.dim = options.dim ?? DEFAULT_DIM;
    assertMrlDimension(this.dim);

    this.dtype = resolveDtype(options.dtype ?? DEFAULT_DTYPE);

    const maxSoftTokens = options.maxSoftTokens ?? DEFAULT_MAX_SOFT_TOKENS;
    if (!Number.isInteger(maxSoftTokens) || maxSoftTokens <= 0) {
      throw new InvalidEmbedderOptionError("maxSoftTokens", maxSoftTokens, "必須是正整數");
    }
    this.maxSoftTokens = maxSoftTokens;

    this.cacheDir = options.cacheDir ?? defaultModelCacheDir();

    // 選項優先於環境變數；兩者皆未設時為 "auto"。
    this.requestedDevice = parseEmbedDeviceOption(options.device ?? process.env[EMBED_DEVICE_ENV]);
    const plan = resolveEmbedDevice(this.requestedDevice, options.platform ?? process.platform);
    this.device = plan.device;
    this.fallbackReason = plan.fallbackReason;
    // adapter 索引一律先驗證（非法值立即失敗，不等到真的載入 dml 才發現）。
    this.dmlDeviceId = parseDmlDeviceId(process.env[EMBED_DML_DEVICE_ID_ENV]);
    // 診斷用的 ORT log 等級；同樣先驗證（未設定＝不覆寫）。
    this.ortLogLevel = parseOrtLogLevel(process.env[EMBED_ORT_LOG_ENV]);

    this.info = {
      id: buildEmbedderId(this.modelId, dtypeLabel(this.dtype)),
      dim: this.dim,
      // audio_config 已設為 null，故 audio 為 false；本套件不做影片。
      capabilities: { text: true, image: true, audio: false, video: false },
    };
  }

  /** 執行裝置狀態（診斷與索引器併發用）；載入模型前即為計畫值。 */
  get runtimeStatus(): EmbedderRuntimeStatus {
    return {
      requestedDevice: this.requestedDevice,
      device: this.device,
      loaded: this.loaded !== null,
      fallbackReason: this.fallbackReason === null ? null : { ...this.fallbackReason },
      batchSize: deviceBatchSize(this.device),
      serializedInference: requiresSerializedInference(this.device),
      // 設定值（不隨退回改變）：診斷要能看出「DML 是哪一張卡」。
      dmlDeviceId: this.dmlDeviceId,
    };
  }

  async embedQuery(text: string): Promise<Float32Array> {
    return this.embedText(`task: search result | query: ${text}`);
  }

  async embedDocument(text: string, title?: string): Promise<Float32Array> {
    return this.embedText(this.documentPrefix(text, title));
  }

  /**
   * 文字批次：把每項套上文件 prefix 後，一次 `processor([…])`＋一次 `model(inputs)`。
   *
   * - 空陣列回傳 `[]`（不載入模型）。
   * - 輸出與 `inputs` 一一對應且順序相同；每列各自截斷成 `info.dim` 並重新 L2 正規化。
   * - 超過視窗上限（DML 32、CPU 16，見 `runtimeStatus.batchSize`）時內部切成多個視窗
   *   （順序串接），呼叫端不需自行分批。
   * - **另受 token 預算限制**（`BATCH_TOKEN_BUDGET`）：processor 算出的 `input_ids` 形狀
   *   顯示這一窗的 token 總量超過預算時，會**縮小視窗重試**（依超出比例按比例縮減、
   *   至少減 1 筆，直到單筆為止）。這一層保護的是「一窗的總量」；單一輸入的長度由切塊端的
   *   `CHUNK_MAX_TOKENS` 控制，這裡**不切分單一輸入**（輸出必須與輸入一一對應）。
   * - **視窗在每次嘗試時才切**：若某個視窗在 `dml` 上失敗而退回 CPU，該位置會以 CPU 的
   *   視窗大小（16）**重新切窗**再重試，後續視窗也用 CPU 大小。
   * - 任一視窗失敗（模型輸出形狀不符、取消）即整批拋錯，不回傳部分結果；若失敗發生在
   *   `dml` 且不是取消，先退回 CPU 並重試該位置一次。
   */
  async embedDocuments(
    inputs: readonly DocumentInput[],
    opts?: EmbedDocumentsOptions,
  ): Promise<Float32Array[]> {
    if (inputs.length === 0) return [];

    // 先檢查取消，避免已取消還去載模型。
    throwIfAborted(opts?.signal);
    const vectors: Float32Array[] = [];

    for (let start = 0; start < inputs.length; ) {
      const windowStart = start;
      const attempt = await this.runWithFallback(async ({ processor, model }) => {
        // 視窗大小依「當下」的裝置決定：退回 CPU 後這裡會重新切（見上方第 5 點）。
        let windowSize = deviceBatchSize(this.device);
        for (;;) {
          const window = inputs.slice(windowStart, windowStart + windowSize);
          const prefixed = window.map((input) => this.documentPrefix(input.text, input.title));
          const processed = await processor(prefixed);
          // token 預算護欄：超過即以「按比例縮小」重試（至少減 1 筆，保證收斂）。
          // 單筆仍超預算時無處可退：輸出必須與輸入一一對應，這裡不切分單一輸入
          // （單塊長度由切塊端的 CHUNK_MAX_TOKENS 控制），照常送給模型。
          const tokens = promptTokens(processed);
          if (tokens !== null && tokens > BATCH_TOKEN_BUDGET && window.length > 1) {
            const scaled = Math.floor((BATCH_TOKEN_BUDGET * window.length) / tokens);
            windowSize = Math.max(1, Math.min(window.length - 1, scaled));
            continue;
          }
          const rows = await runModel(this.modelId, model, processed);
          if (rows.length !== window.length) {
            throw new ModelInferenceError(
              this.modelId,
              `批次回傳 ${rows.length} 筆向量，預期 ${window.length} 筆`,
            );
          }
          return { windowLength: window.length, rows };
        }
      }, opts?.signal);

      for (const row of attempt.rows) {
        vectors.push(truncateAndNormalize(Float32Array.from(row), this.dim));
      }
      start += attempt.windowLength;
    }

    return vectors;
  }

  async embedImage(image: ImageInput): Promise<Float32Array> {
    if (image.bytes.length === 0) throw new EmptyImageInputError();

    // transformers.js 在 Node 以 sharp 解碼；load_image 接受 Blob。先複製成
    // ArrayBuffer-backed 的 Uint8Array，避免與呼叫端共用緩衝。
    const bytes = new Uint8Array(image.bytes);
    const blob = new Blob([bytes], { type: image.mimeType ?? "application/octet-stream" });

    const rows = await this.runWithFallback(async ({ processor, model }) => {
      // 解碼與圖片前處理都不碰 ONNX session：這一段的失敗一律標成 EmbedderInputError
      // （見 asImageInputError），因此不會被 shouldFallBack 當成裝置失敗。真正的推論
      // 錯誤發生在下面的 runModel，維持原本「dml 失敗即退回」的判定。
      const rawImage = await this.inImageInputPhase(() => load_image(blob));
      const inputs = await this.inImageInputPhase(() => processor(null, [[rawImage]]));
      return await runModel(this.modelId, model, inputs);
    }, undefined);
    return this.toVector(rows);
  }

  /** 執行一段「只碰輸入位元組、不碰裝置」的圖片解碼／前處理，失敗一律分類成輸入錯誤。 */
  private async inImageInputPhase<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (isAbortError(error)) throw error;
      throw asImageInputError(error);
    }
  }

  async probe(): Promise<ProbeResult> {
    return runProbe({
      dim: this.dim,
      embedText: (text) => this.embedQuery(text),
      embedImage: (image) => this.embedImage(image),
    });
  }

  /**
   * 釋放模型 session。可安全重複呼叫（冪等）；未載入時為無害的 no-op。
   * 釋放後再呼叫 `embed*`／`probe()` 會自動重新載入模型。
   *
   * 裝置與退回原因**不因 dispose 重置**：已退回 CPU 的實例不會再嘗試 `dml`（避免同一台機器
   * 反覆踩同一個失敗）。
   */
  async dispose(): Promise<void> {
    const loaded = this.loaded;
    this.loaded = null;
    this.loading = null;
    if (loaded?.model.dispose) {
      await loaded.model.dispose();
    }
  }

  /** 文件 prefix（查詢 prefix 見 `embedQuery`）。title 沒有時用 "none"。 */
  private documentPrefix(text: string, title?: string): string {
    return `title: ${title ?? "none"} | text: ${text}`;
  }

  private async embedText(prefixed: string): Promise<Float32Array> {
    const rows = await this.runWithFallback(async ({ processor, model }) => {
      const inputs = await processor([prefixed]);
      return await runModel(this.modelId, model, inputs);
    }, undefined);
    return this.toVector(rows);
  }

  /** 取第一筆並依 `info.dim` 截斷＋重新 L2 正規化。 */
  private toVector(data: number[][]): Float32Array {
    const row = data[0];
    if (!row) {
      throw new ModelInferenceError(this.modelId, "模型回傳空的 embedding 批次");
    }
    return truncateAndNormalize(Float32Array.from(row), this.dim);
  }

  private async ensureLoaded(): Promise<LoadedModel> {
    if (this.loaded) return this.loaded;
    if (!this.loading) {
      this.loading = this.loadModel();
    }
    try {
      const loaded = await this.loading;
      this.loaded = loaded;
      return loaded;
    } finally {
      this.loading = null;
    }
  }

  /**
   * 執行一次推論操作：先取得序列鎖（`dml` 時）、載入模型、執行，並在 `dml` 失敗時退回 CPU 重試。
   *
   * 鎖的範圍刻意涵蓋「載入 → 推論 → 退回重載」整段：退回會丟掉舊 session 並換裝置，
   * 不能與另一個正在使用舊 session 的呼叫重疊。
   *
   * 退回只做一次、且只針對 `dml`：`fallBackToCpu` 會把 `this.device` 改成 `cpu`，之後的呼叫
   * 走的就是 CPU 路徑。取消（`AbortError`／`signal.aborted`）與輸入類錯誤
   * （`EmbedderInputError`）不算裝置失敗，原樣拋出（見 `shouldFallBack`）。
   */
  private async runWithFallback<T>(
    operation: (loaded: LoadedModel) => Promise<T>,
    signal: AbortSignal | undefined,
  ): Promise<T> {
    return await this.withLock(signal, async () => {
      throwIfAborted(signal);
      const loaded = await this.ensureLoaded();
      try {
        return await operation(loaded);
      } catch (error) {
        if (!this.shouldFallBack(signal, error)) throw error;
        await this.fallBackToCpu("inference-failed", error);
        throwIfAborted(signal);
        const reloaded = await this.ensureLoaded();
        return await operation(reloaded);
      }
    });
  }

  /**
   * 序列推論的互斥佇列：`serializedInference`（DML）時，同一實例的推論單位永不重疊。
   *
   * - 先到先跑（FIFO）；`operation` 拋錯也會釋放，不會卡住佇列。
   * - 等待中被 abort → 以取消錯誤拒絕、**不執行**，且立刻從佇列移除（其他等待者的順序不變）。
   * - 裝置不是 `dml`（含退回後）時完全不排隊，直接執行。
   */
  private async withLock<T>(signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
    if (!requiresSerializedInference(this.device)) return await operation();
    const release = await this.acquireLock(signal);
    try {
      return await operation();
    } finally {
      release();
    }
  }

  /**
   * 取得序列鎖（FIFO）；回傳釋放函式。同一時間只有一個持有者。
   *
   * 「等待中 abort」是從佇列**移除自己**，不是立刻把鎖交出去——鎖仍在目前持有者手上，
   * 後面的人照樣等它釋放（否則會與正在跑的推論重疊）。
   */
  private async acquireLock(signal: AbortSignal | undefined): Promise<() => void> {
    throwIfAborted(signal);
    if (!this.lockHeld) {
      this.lockHeld = true;
      return () => this.releaseLock();
    }
    return await new Promise<() => void>((resolve, reject) => {
      const waiter: LockWaiter = { grant: resolve, reject, signal, onAbort: undefined };
      if (signal !== undefined) {
        waiter.onAbort = () => {
          const index = this.lockWaiters.indexOf(waiter);
          // 已經被交棒（不在佇列）→ 不拒絕：執行路徑會自己檢查 signal 並釋放鎖。
          if (index === -1) return;
          this.lockWaiters.splice(index, 1);
          signal.removeEventListener("abort", waiter.onAbort!);
          reject(abortReason(signal));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.lockWaiters.push(waiter);
      // 極窄競態：addEventListener 之後、push 之前就 abort 了 → 補一次檢查。
      if (signal?.aborted === true) waiter.onAbort?.();
    });
  }

  /** 釋放序列鎖：交給佇列中最早、且仍在等待的呼叫（跳過已被 abort 移除者）。 */
  private releaseLock(): void {
    const next = this.lockWaiters.shift();
    if (next === undefined) {
      this.lockHeld = false;
      return;
    }
    if (next.onAbort !== undefined) next.signal?.removeEventListener("abort", next.onAbort);
    next.grant(() => this.releaseLock());
  }

  /**
   * 這個失敗是否該退回 CPU。只有 `dml`、且是「裝置／模型類」的失敗才退回。
   *
   * - 取消（`AbortError`／`signal.aborted`）不算裝置失敗。
   * - **輸入類錯誤**（`EmbedderInputError`：解不開的圖、前處理失敗）也不算：換裝置、
   *   重試同一份位元組結果一樣，退回只會讓整場永久失去 GPU，卻什麼都沒換到。照常往上拋，
   *   由 core 認標記後記成 `skipped(undecodable)`。
   */
  private shouldFallBack(signal: AbortSignal | undefined, error: unknown): boolean {
    if (this.device !== "dml") return false;
    if (signal?.aborted === true) return false;
    if (isAbortError(error)) return false;
    if (error instanceof EmbedderInputError) return false;
    return true;
  }

  /** 退回 CPU：丟掉壞掉的 session、記錄原因，下一次 `ensureLoaded` 會載 CPU 模型。 */
  private async fallBackToCpu(code: string, error: unknown): Promise<void> {
    const loaded = this.loaded;
    this.loaded = null;
    this.loading = null;
    this.device = "cpu";
    this.fallbackReason = { code, message: summarizeFailure(error) };
    try {
      await loaded?.model.dispose?.();
    } catch {
      // 釋放失敗不影響退回（session 會隨行程結束回收）；退回本身必須成功。
    }
  }

  /**
   * 建立指定裝置的模型 session；DML 另外指定 EP 與 adapter（沿用 `spikes/dml-bench` 的作法）。
   *
   * `session_options.enableCpuMemArena = false`（**所有平台、兩個裝置路徑都帶**）：
   * ORT 的 CPU arena 在擴張時會把 chunk 翻倍（`BFCArena::Extend` 的 `while … *= 2`），
   * 當單一配置請求超過 1 GiB 時會直接翻成 2 GiB 的單一配置；這個大小的配置在
   * Chromium／Electron 內會被 PartitionAlloc **依設計直接殺掉行程**（見 `docs/` 與研究筆記）。
   * 關掉 arena 等於整條路移除，並附帶大幅降低 RSS（同工作負載實測 4.8 GB → 0.7 GB），
   * 代價是同工作負載的執行時間約 +5%。
   *
   * 為什麼全平台而不是只有 darwin：
   * 1. 這條路徑是「arena 擴張 × 底層配置器上限」的組合問題，與平台無關；PA 在
   *    Chromium 的 Linux 版同樣啟用，本專案沒有實測證據說 Linux 免疫。
   * 2. 兩個裝置（cpu／dml）共用同一組 options，避免「其中一條路徑忘了帶」這種
   *    最難查的落差（本 bug 原本就只加在 dml 分支）。
   * 3. RSS 收益（模型常駐 + 索引峰值）在所有平台都成立。
   * 4. 成本已量測且有界（≈+5%），而崩潰的代價是整個 app。
   *
   * `session_options.executionProviders` 用物件形式指定 `deviceId`（預設 0＝預設顯示卡，
   * 可用環境變數 `MNEMOSHELF_EMBED_DML_DEVICE_ID` 改；多顯卡的筆電常需指定獨顯）；
   * transformers.js 以 `??=` 保留使用者指定的 EP 清單，因此與 `device:"dml"` 並用不衝突。
   * 失敗一律包成 `ModelLoadError`（呼叫端據此決定是否退回）。
   */
  private async createBackend(device: EmbedDevice): Promise<LoadedModel> {
    try {
      // 讓 HF 下載的快取落在指定目錄（全域設定；與 M0 spike 相同做法）。
      env.cacheDir = this.cacheDir;

      const config = await AutoConfig.from_pretrained(this.modelId);
      // 只載文字＋圖片：不要載入音訊編碼器（官方模型卡 Selective Encoder Loading）。
      (config as unknown as { audio_config: unknown }).audio_config = null;

      const processor = (await AutoProcessor.from_pretrained(this.modelId)) as unknown as GemmaProcessor;
      processor.image_processor.max_soft_tokens = this.maxSoftTokens;

      const model = (await AutoModel.from_pretrained(this.modelId, {
        config,
        device,
        dtype: this.dtype,
        session_options: {
          // 見上方說明：所有平台、兩個裝置路徑都關閉 CPU arena。
          enableCpuMemArena: false,
          ...(device === "dml"
            ? { executionProviders: [{ name: "dml", deviceId: this.dmlDeviceId }] }
            : {}),
          // 只在明確設定時覆寫 ORT 的 log 等級（診斷用）。
          ...(this.ortLogLevel === undefined ? {} : { logSeverityLevel: this.ortLogLevel }),
        },
      })) as unknown as GemmaModel;

      return { processor, model };
    } catch (error) {
      if (error instanceof ModelInferenceError) throw error;
      throw new ModelLoadError(this.modelId, error);
    }
  }

  /**
   * 依目前裝置載入模型；計畫裝置是 `dml` 且載入失敗時，自動退回 CPU 再載一次。
   *
   * CPU 也載不起來時 `ModelLoadError` 照常往外拋（沒有可退的地方）。
   */
  private async loadModel(): Promise<LoadedModel> {
    if (this.device === "cpu") return await this.createBackend("cpu");
    try {
      return await this.createBackend("dml");
    } catch (error) {
      this.fallbackReason = { code: "load-failed", message: summarizeFailure(error) };
      this.device = "cpu";
      return await this.createBackend("cpu");
    }
  }
}
