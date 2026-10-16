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
 *   - 批次視窗依裝置：DML 32、CPU 16（見 `device.ts` 的實測依據）。
 *   - 換裝置**不改變** `info.id`（只吃 model id 與 dtype）：向量兩者等值，既有索引不需重建。
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
  CPU_BATCH_SIZE,
  EMBED_DEVICE_ENV,
  EMBED_DML_DEVICE_ID_ENV,
  deviceBatchSize,
  parseDmlDeviceId,
  requiresSerializedInference,
  parseEmbedDeviceOption,
  resolveEmbedDevice,
  summarizeFailure,
  type EmbedDevice,
  type EmbedDeviceOption,
} from "./device.js";
import {
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
 * 超過上限的輸入由 `embedDocuments` 內部切成多個視窗，呼叫端不需自行分批。
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
        const window = inputs.slice(windowStart, windowStart + deviceBatchSize(this.device));
        const prefixed = window.map((input) => this.documentPrefix(input.text, input.title));
        const processed = await processor(prefixed);
        const rows = await runModel(this.modelId, model, processed);
        if (rows.length !== window.length) {
          throw new ModelInferenceError(
            this.modelId,
            `批次回傳 ${rows.length} 筆向量，預期 ${window.length} 筆`,
          );
        }
        return { windowLength: window.length, rows };
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
      const rawImage = await load_image(blob);
      const inputs = await processor(null, [[rawImage]]);
      return await runModel(this.modelId, model, inputs);
    }, undefined);
    return this.toVector(rows);
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
   * 走的就是 CPU 路徑。取消（`AbortError`／`signal.aborted`）不算裝置失敗，原樣拋出。
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

  /** 這個失敗是否該退回 CPU（只有 dml、且不是取消）。 */
  private shouldFallBack(signal: AbortSignal | undefined, error: unknown): boolean {
    if (this.device !== "dml") return false;
    if (signal?.aborted === true) return false;
    if (error instanceof Error && error.name === "AbortError") return false;
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
        ...(device === "dml"
          ? {
              session_options: {
                executionProviders: [{ name: "dml", deviceId: this.dmlDeviceId }],
              },
            }
          : {}),
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
