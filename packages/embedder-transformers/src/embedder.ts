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
 *   - `auto`（預設）：**Windows** 嘗試 DirectML GPU（`dml`）、**macOS** 嘗試 CoreML
 *     （`coreml`，需通過內建自我測試才會採用）、其他平台維持現狀 CPU。
 *   - `dml` 載入或推論失敗時**自動退回 CPU**，不中斷；原因可在 `runtimeStatus.fallbackReason` 讀到。
 *   - `coreml` 的處置與 `dml` 相同（載入／推論失敗一律退回 CPU），但**多了一層自我測試**：
 *     macOS 的 `auto` 在沒有（或過期的）決定快取時，會先量測 CoreML 與 CPU 的吞吐、
 *     向量一致性與峰值記憶體，通過才採用；決定會持久化（見 `self-test.ts`）。
 *     **明示** `coreml` 的語意是「忽略快取、強制嘗試」（使用者自負；不寫回快取）。
 *   - **例外：解碼／輸入類失敗不退**（`EmbedderInputError`／`code:"undecodable"`）。一張壞圖
 *     不該讓整場永久失去 GPU；這類錯誤照常往上拋，由 core 記成 `skipped(undecodable)`。
 *   - 批次視窗依裝置：DML 32、CPU／CoreML 16（見 `device.ts` 的實測依據），另受 token 預算限制
 *     （一窗的 token 總量上限，`BATCH_TOKEN_BUDGET`）。
 *   - 換裝置**不改變** `info.id`（只吃 model id 與 dtype）：向量兩者等值，既有索引不需重建。
 *
 * Session options（`createBackend`，所有裝置共用）：
 *   - `enableCpuMemArena: false`：關閉 ORT 的 CPU arena。arena 在請求超過目前 chunk 時會把
 *     chunk 以 2 的冪次往上翻，一次超過 1 GiB 的請求因而變成 ≥2 GiB 的單一配置；這個大小
 *     在 Chromium／Electron 內會被 PartitionAlloc **直接終止行程**（整個 app 閃退）。
 *     關掉即整條路移除，並大幅降低 RSS（代價：同工作負載約 +5% 時間，實測在噪聲範圍內）。
 *   - `enableMemPattern: false`：關閉 ORT 的 memory pattern。arena 關掉之後，**聚合的
 *     pattern 大區塊**成了同一條死路的殘餘配置點：pattern 命中時 ORT 於 `ExecutionFrame`
 *     建構子一次配置「整個 graph 中間張量的峰值總和」，實測該值隨單塊長度成長，8k token
 *     的窗可到 2.28 GiB（> PartitionAlloc 的單一配置上限 2 GiB − 2 MiB）。
 *     關掉後配置退回個別 tensor，護欄內最大單一 tensor 實測 ≈ `T×49,152 B`。
 *   - 選填 `logSeverityLevel`（環境變數 `MNEMOSHELF_EMBED_ORT_LOG`，診斷用，預設不開）。
 *   - 文字與視覺 session **共用同一組 options**：transformers.js 對每個 session
 *     （`model`／`vision_encoder`）各複製一份 `session_options`（`constructSessions` 逐一
 *     呼叫 `getSession`，每次都 `{ ...options.session_options }`），因此寫在一處即涵蓋兩者。
 *   - **單筆輸入的硬上限**（`MAX_INPUT_TOKENS`）：token 數超過模型上下文就拒絕，不送進模型。
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
  EmbedderSelfTestStatus,
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
  isCoreMlPlatform,
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
import {
  ACCEL_UNAVAILABLE_MESSAGE,
  COREML_MLPROGRAM_FLAG,
  DEVICE_DECISION_SCHEMA,
  SELF_TEST_REASONS,
  classifyDecision,
  describeLoadCrashRetry,
  describeSelfTestReason,
  measurementFieldsOf,
  readDecisionRecord,
  runCoreMlSelfTest,
  selfTestFallbackCode,
  toSelfTestStatus,
  writeDecisionRecord,
  type CoreMlSelfTestResult,
  type DeviceDecisionIdentity,
  type DeviceDecisionOutcome,
  type DeviceDecisionPhase,
  type DeviceDecisionRecord,
  type SelfTestMeasurementFields,
} from "./self-test.js";
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

/**
 * 單筆輸入的 **token 數硬上限**（＝8192，等同模型的上下文長度）。
 *
 * 為什麼需要這條上限：一窗的 token 預算（`BATCH_TOKEN_BUDGET`）**只能在視窗內有多筆時**
 * 靠縮窗降下來；`embedDocuments` 的單筆視窗（`window.length === 1`）與單筆文字入口
 * （`embedQuery`／`embedDocument`；生產路徑見下）先前**完全沒有上限**——一個超長輸入
 * 就是護欄的破口（見 `docs/embedder-contract.md`）。
 *
 * 為什麼取 8192：
 * - **不窄化任何原本合法的輸入**：8192 正是契約載明的模型上下文；超過的輸入本來就處理不了
 *   （tokenizer **不會截斷**：`truncation` 預設 `null`；處理器雖傳 `padding: true`，但單筆時
 *   會夾成該筆自身長度、形同 no-op；且快取內的 `model_max_length` 實質無上限，超長序列會
 *   **原樣**送進模型，推論張量形狀與配置隨長度成長）。正常切塊（512 估算 token ⇒ 約 ≤2048
 *   真實 token）不可能觸及，這是安全網而非常態路徑。
 * - **pattern 關閉後最壞的單筆配置仍有界**：注意力類 `[1,4,8192,8192]` fp32 ≈ 1.07 GB、
 *   per-token 類 ≈ `T×49,152 B`（T=8192）≈ 0.41 GB，**確定性**地低於 Chromium
 *   PartitionAlloc 的單一配置上限 `2 GiB − 2 MiB` = 2,145,386,496 B（越過即
 *   `PA_IMMEDIATE_CRASH`，整個 app 死）。
 *
 * **這條上限與 `BATCH_TOKEN_BUDGET` 都不是記憶體配置的護欄**，真正的配置護欄是 session
 * options：`enableMemPattern: false`（關掉 memory-pattern 的聚合大區塊）與
 * `enableCpuMemArena: false`（一併關閉 arena）。實測 `5×1529`（1.97 GiB）與
 * `4×1985`（2.28 GiB）**都落在 `BATCH_TOKEN_BUDGET`（8192）之內**，而後者已達 PartitionAlloc
 * 上限的 113.9%（在 Electron 內必死）；連**超出**預算的 `16×522`（T=8,352）也有 1.60 GiB
 * ——可見 token 預算並不保證配置低於上限；日後若要為效能把 pattern 打開，不可拿預算當安全論證。
 *
 * 超過時的語意：拋 `EmbedderInputError`（穩定錯誤碼 `code:"input-too-long"`）——輸入類失敗，
 * 與執行裝置無關、重試無用。core 以錯誤**名稱**把這類錯誤歸成「可跳過的輸入類失敗」，
 * 索引路徑不會因這一筆而中斷整輪（見 `docs/embedder-contract.md` 的兩節）。
 */
export const MAX_INPUT_TOKENS = 8192;

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
   * `auto`＝Windows 試 `dml`（DirectML GPU）、macOS 試 `coreml`（CoreML，需通過自我測試）、
   * 其他平台維持 CPU；不可用或失敗時自動退回 `cpu`，原因見 `runtimeStatus.fallbackReason`。
   * 明示 `coreml`＝忽略快取強制嘗試（可能不穩；見 `docs/embedder-contract.md`）。
   */
  device?: EmbedDeviceOption;
  /** 輸出維度，預設 512。僅允許 128／256／512／768。 */
  dim?: number;
  /** 模型快取目錄；預設環境變數 `MNEMOSHELF_MODEL_DIR`，再預設 OS 使用者資料目錄下的 `mnemoshelf/models`。 */
  cacheDir?: string;
  /**
   * 應用程式版本（寫進裝置決定快取；換版本時加速器自我測試會重測一次）。
   *
   * 未提供時為 `"unknown"`。組裝層（`@mnemoshelf/server`）會傳自己的 `APP_VERSION`，
   * 因此發行新版後 macOS 的 CoreML 決定會自動重測。
   */
  appVersion?: string;
  /**
   * 裝置決定快取（CoreML 自我測試的結果）的檔案路徑；
   * 預設 `<cacheDir>/device-decision.json`（與模型快取同處：兩者都必須是可寫的資料區，
   * 打包後的桌面版把 `MNEMOSHELF_MODEL_DIR` 指向 `userData/models`）。
   *
   * 只為測試而存在時可覆寫；產品碼不需要設定。
   */
  deviceDecisionPath?: string;
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

/**
 * 裝置決定快取（CoreML 自我測試的結果）的預設路徑：`<cacheDir>/device-decision.json`。
 *
 * 為什麼放在模型快取目錄：那個目錄**本來就必須可寫**（要下載模型），
 * 而且桌面殼已把它指到 `userData/models`（打包後 `app.asar` 唯讀，只有這裡寫得進去）
 * → 「dev 與打包皆可寫」用同一條路徑就成立，不需要再引入一個環境變數或第二個資料區。
 * 代價：模型快取目錄若被設成唯讀的共用目錄，寫入會失敗——但那只讓下一次啟動重測一次
 * （`writeDecisionRecord` 回傳 false，不影響任何流程）。
 */
export function defaultDeviceDecisionPath(cacheDir: string): string {
  return join(cacheDir, "device-decision.json");
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
 * 單筆輸入的硬上限檢查（`MAX_INPUT_TOKENS`；量法沿用 `promptTokens` 的**實際** token 數）。
 *
 * 呼叫端必須保證「這一窗就是一筆」：
 * - `embedDocuments` 在 `window.length === 1` 時呼叫（那時 `tokens` 恰為該筆的 token 數）。
 * - `embedText`（單筆文字入口：`embedQuery`／`embedDocument`／`probe()`）以單筆送入時呼叫。
 *   生產路徑目前只有兩處：`/search` 的 `embedQuery` 與 desktop 模型驗證的短字串
 *   （`embedDocument` 是介面方法，目前非熱路徑；記憶寫入 `POST /memories` 不經 embedder）。
 *
 * 形狀取不到（`promptTokens` 回 `null`）時不判定：寧可放行也不要對畸形輸出誤判，
 * 這種情況另有「模型輸出形狀不符」的檢查擋著。
 */
function assertWithinInputLimit(tokens: number | null): void {
  if (tokens === null || tokens <= MAX_INPUT_TOKENS) return;
  throw new EmbedderInputError(
    `單筆輸入 ${tokens} token 超過上限 ${MAX_INPUT_TOKENS}（MAX_INPUT_TOKENS）`,
    { code: "input-too-long" },
  );
}

/**
 * 多模態 embedder（真實模型）。
 *
 * lazy 載入：建構子不載模型；第一次 `embed*`／`probe()` 才載。`info` 不依賴模型，建構後即可同步讀取。
 * `dispose()` 後再呼叫 `embed*` 會**自動重新載入**（本實作選擇「自動重新載入」，見測試與註解）。
 *
 * 裝置與退回（`runtimeStatus` 可同步讀取，載入模型前就有值）：
 * - 建構子依 `device` 選項／環境變數與平台解析出**計畫裝置**（非 Windows 不可能是 `dml`、
 *   非 macOS 不可能是 `coreml`）。
 * - 計畫裝置為 `dml` 時，載入或推論失敗**自動退回 CPU 並重試一次**（同一實例只退一次、退回後不再
 *   嘗試 `dml`），不讓整輪索引因此中斷；原因記在 `runtimeStatus.fallbackReason`。
 * - 計畫裝置為 `coreml` 時走同一條骨架，但依情境分岔：
 *   - macOS 的 `auto`：建構子先讀裝置決定快取（`<cacheDir>/device-decision.json`）。
 *     已有可用決定就直接沿用；沒有或過期時，於 `loadModel()` 內跑一次自我測試
 *     （`runCoreMlSelfTest`：CPU 基準 → CoreML 量測 → 判準），通過才保留 CoreML session。
 *   - 明示 `coreml`：忽略快取、**強制嘗試**、不跑自我測試也不寫快取（使用者自負）。
 * - 取消（`AbortError`／`signal.aborted`）不算裝置失敗，一律原樣拋出。
 * - **輸入類失敗**（`EmbedderInputError`，例如解不開的圖）也不算裝置失敗：與裝置無關，
 *   不退回、不在同窗重試，原樣往上拋給 core 判定 `skipped(undecodable)`（見 `shouldFallBack`）。
 *
 * 序列推論（DirectML 的硬性限制；CoreML 沿用同一條骨架）：
 * - `dml`／`coreml` 的同一 session 不支援並發 `Run`，而並發來源不止索引器（多個 root 同時索引、
 *   「索引＋搜尋」並行、探測與查詢交錯）。因此**本實例內建互斥佇列**：裝置為 `dml`／`coreml` 時，
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
  /** 平台（`options.platform` 可覆寫，測試用）。 */
  private readonly platform: string;
  /** 應用程式版本（裝置決定快取的身分欄位之一）。 */
  private readonly appVersion: string;
  /** 裝置決定快取的檔案路徑。 */
  private readonly deviceDecisionPath: string;
  /**
   * 是否使用裝置決定快取：**只有 macOS 的 `auto`**（也就是會跑 CoreML 自我測試的那條路）。
   *
   * 這個單一開關同時保證三件事：Windows／Linux 完全不碰這個檔案（既有行為不動）、
   * 明示 `cpu`／`dml`／`coreml` 時不讀不寫（env 明示＝忽略快取、強制嘗試）。
   */
  private readonly deviceDecisionEnabled: boolean;
  /** 建構子已套用一份可用的決定（載入時不必再自我測試）。 */
  private decisionApplied = false;
  /**
   * 疑似「載入期崩潰」的累計次數（由決定快取帶進來；載入成功時歸零）。
   *
   * 用途：載入期護欄把它寫進 `pending(load)` 標記，下一次啟動才能判斷「這是連續第幾次」
   * 而決定要不要永久停用加速器。
   */
  private suspectedLoadCrashes = 0;
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
  /** 加速器自我測試的摘要（有快取或跑過測試時才有值）。 */
  private selfTest: EmbedderSelfTestStatus | undefined;

  private loaded: LoadedModel | null = null;
  private loading: Promise<LoadedModel> | null = null;
  /** 序列推論的鎖：`true` 表示有人持有（只有 `dml`／`coreml` 會用到）。 */
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
    this.platform = options.platform ?? process.platform;
    this.appVersion = options.appVersion ?? "unknown";
    // 裝置決定快取與模型快取放在同一個可寫的資料區（見 defaultDeviceDecisionPath 的說明）。
    this.deviceDecisionPath = options.deviceDecisionPath ?? defaultDeviceDecisionPath(this.cacheDir);
    this.deviceDecisionEnabled = this.requestedDevice === "auto" && isCoreMlPlatform(this.platform);

    const plan = resolveEmbedDevice(this.requestedDevice, this.platform);
    this.device = plan.device;
    this.fallbackReason = plan.fallbackReason;
    // macOS 的 auto：先把已快取的決定套上（同步讀一個 tiny JSON；理由見 applyCachedDecision）。
    if (this.deviceDecisionEnabled) this.applyCachedDecision();
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

  /**
   * 執行裝置狀態（診斷與索引器併發用）；載入模型前即為計畫值。
   *
   * `selfTest` 只在「有決定快取」或「跑過自我測試」時才出現（欄位不存在＝未測試）。
   */
  get runtimeStatus(): EmbedderRuntimeStatus {
    const status: EmbedderRuntimeStatus = {
      requestedDevice: this.requestedDevice,
      device: this.device,
      loaded: this.loaded !== null,
      fallbackReason: this.fallbackReason === null ? null : { ...this.fallbackReason },
      batchSize: deviceBatchSize(this.device),
      serializedInference: requiresSerializedInference(this.device),
      // 設定值（不隨退回改變）：診斷要能看出「DML 是哪一張卡」。
      dmlDeviceId: this.dmlDeviceId,
    };
    if (this.selfTest !== undefined) status.selfTest = { ...this.selfTest };
    return status;
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
   * - **單筆輸入另有硬上限**（`MAX_INPUT_TOKENS`）：縮到單筆（`window.length === 1`）時
   *   這一窗就是那一筆，token 數仍超過上限即拋 `EmbedderInputError`
   *   （`code:"input-too-long"`），**不送進模型**。這是「預算只在多筆時生效」的破口補丁
   *   （見 `MAX_INPUT_TOKENS` 的理由）；超限的那一筆在索引路徑上屬輸入類失敗，
   *   不會讓整輪失敗。
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
          // token 護欄（兩層，順序有意義）：
          // 1. 單筆硬上限：`window.length === 1` 時這一窗就是那一筆，`tokens` 即該筆的
          //    實際 token 數；超過 `MAX_INPUT_TOKENS` 即拒絕、**不送進模型**。
          //    （舊版在這個分支「照常送給模型」——那正是單筆輸入無上限的破口。）
          // 2. 一窗總量預算：多筆時超過 `BATCH_TOKEN_BUDGET` 就以「按比例縮小」重試
          //    （至少減 1 筆，收斂到單筆後由第 1 層接手）。
          const tokens = promptTokens(processed);
          if (window.length === 1) assertWithinInputLimit(tokens);
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
      // 單筆文字入口（生產路徑為 `/search` 的查詢、desktop 的模型驗證與啟動探測）受同一條
      // 硬上限約束：這裡的 `promptTokens` 就是這一筆的實際 token 數（batch 1，沒有 padding）。
      assertWithinInputLimit(promptTokens(inputs));
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
   * 執行一次推論操作：先取得序列鎖（`dml`／`coreml` 時）、載入模型、執行，
   * 並在裝置類失敗時退回 CPU 重試。
   *
   * 鎖的範圍刻意涵蓋「載入 → 推論 → 退回重載」整段：退回會丟掉舊 session 並換裝置，
   * 不能與另一個正在使用舊 session 的呼叫重疊。
   *
   * 退回只做一次、且只針對 `dml`／`coreml`：`fallBackToCpu` 會把 `this.device` 改成 `cpu`，
   * 之後的呼叫走的就是 CPU 路徑（CoreML 額外會把結果寫進決定快取，見 `fallBackToCpu`）。
   * 取消（`AbortError`／`signal.aborted`）與輸入類錯誤（`EmbedderInputError`）不算裝置失敗，
   * 原樣拋出（見 `shouldFallBack`）。
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
   * 序列推論的互斥佇列：`serializedInference`（`dml`／`coreml`）時，同一實例的推論單位永不重疊。
   *
   * - 先到先跑（FIFO）；`operation` 拋錯也會釋放，不會卡住佇列。
   * - 等待中被 abort → 以取消錯誤拒絕、**不執行**，且立刻從佇列移除（其他等待者的順序不變）。
   * - 裝置不需要序列推論時（`cpu`，含退回後）完全不排隊，直接執行。
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
   * 這個失敗是否該退回 CPU。只有 `dml`／`coreml`、且是「裝置／模型類」的失敗才退回。
   *
   * - 取消（`AbortError`／`signal.aborted`）不算裝置失敗。
   * - **輸入類錯誤**（`EmbedderInputError`：解不開的圖、前處理失敗）也不算：換裝置、
   *   重試同一份位元組結果一樣，退回只會讓整場永久失去 GPU，卻什麼都沒換到。照常往上拋，
   *   由 core 認標記後記成 `skipped(undecodable)`。
   *
   * `coreml` 與 `dml` 同規則：CoreML EP 是「多個分區各自在不同硬體上跑」的裝置，
   * 一旦某個輸入把它跑壞，之後每個輸入都可能踩到同一個問題 → 退回 CPU 並把結果記進快取
   * （見 `fallBackToCpu`）。
   */
  private shouldFallBack(signal: AbortSignal | undefined, error: unknown): boolean {
    if (this.device !== "dml" && this.device !== "coreml") return false;
    if (signal?.aborted === true) return false;
    if (isAbortError(error)) return false;
    if (error instanceof EmbedderInputError) return false;
    return true;
  }

  /**
   * 退回 CPU：丟掉壞掉的 session、記錄原因，下一次 `ensureLoaded` 會載 CPU 模型。
   *
   * 若丟掉的是 **CoreML** session，順手把「這台機器的加速器跑不起來」寫進決定快取
   * （`unusable`／`inference-failed`）——不然下一次啟動又會帶著「可用」的舊決定再踩一次。
   * 與載入失敗同一條規則：**沿用上一輪的量測欄位與 `testedAt`**，只改 `outcome`／`reason`。
   * 寫入與否由 `writeDecision` 的單一開關決定（明示 `coreml` 時不寫）。
   */
  private async fallBackToCpu(code: string, error: unknown): Promise<void> {
    const previous = this.device;
    const loaded = this.loaded;
    this.loaded = null;
    this.loading = null;
    this.device = "cpu";
    this.fallbackReason = { code, message: summarizeFailure(error) };
    if (previous === "coreml") {
      const measured = this.measurementFields();
      this.selfTest = {
        ...measured,
        outcome: "unusable",
        reason: SELF_TEST_REASONS.inferenceFailed,
        testedAt: measured.testedAt ?? new Date().toISOString(),
      };
      this.writeDecision("unusable", this.selfTest);
    }
    try {
      await loaded?.model.dispose?.();
    } catch {
      // 釋放失敗不影響退回（session 會隨行程結束回收）；退回本身必須成功。
    }
  }

  /** 這次量測代表的身分（寫進決定記錄；讀取時也用來比對）。 */
  private decisionIdentity(): DeviceDecisionIdentity {
    return {
      appVersion: this.appVersion,
      modelId: this.modelId,
      dtype: dtypeLabel(this.dtype),
      platform: this.platform,
      arch: process.arch,
      coreMlFlags: COREML_MLPROGRAM_FLAG,
    };
  }

  /**
   * 把快取的裝置決定套到 `this.device`／`this.selfTest`／`this.fallbackReason`。
   *
   * 為什麼在**建構子同步**讀檔：`runtimeStatus` 在任何時候（模型還沒載入時也算）都要能回答
   * 「這台機器最後決定用什麼、為什麼」，而 REST 層讀 `runtimeStatus` 是同步的。
   * 檔案只有幾百 bytes，且只在 macOS 的 `auto` 路徑讀一次。
   *
   * 五種處置（見 `classifyDecision`）：
   * - `test-required`：不套用（計畫裝置維持 `coreml`，載入時再跑自我測試）。
   * - `usable`：維持 `coreml`，並把疑似載入崩潰計數帶進載入期護欄。
   * - `unusable`：改用 CPU 並記下原因。
   * - `load-crash-retry`：上一次啟動疑似死在 CoreML 載入（第一次）→ **這次用 CPU**、
   *   把決定寫回 `usable`（次數 +1），下次啟動自然再試一次。
   * - `crashed`：**永久**改用 CPU；若磁碟上還是 `pending` 存活標記就補寫成結論。
   *
   * 為什麼「疑似載入崩潰」當次不重試：那條路徑剛剛才殺掉上一個行程，同一次啟動再試
   * 只會陷入「啟動→崩潰→啟動」的迴圈，而且計數會停在同一個值、永遠到不了永久停用的門檻。
   */
  private applyCachedDecision(): void {
    const identity = this.decisionIdentity();
    const classified = classifyDecision(readDecisionRecord(this.deviceDecisionPath), identity);
    if (classified.kind === "test-required") return;

    this.selfTest = classified.status;
    this.decisionApplied = true;

    if (classified.kind === "usable") {
      this.suspectedLoadCrashes = classified.suspectedLoadCrashes;
      return;
    }

    if (classified.kind === "load-crash-retry") {
      this.suspectedLoadCrashes = classified.suspectedLoadCrashes;
      this.device = "cpu";
      this.fallbackReason = {
        code: "accel-load-crashed",
        message: describeLoadCrashRetry(classified.suspectedLoadCrashes),
      };
      // 寫回 `usable`（量測欄位沿用、次數 +1）：下次啟動會照常載入 CoreML 再試一次。
      this.persistRecord(classified.rewrite);
      return;
    }

    this.device = "cpu";
    this.fallbackReason = {
      code: selfTestFallbackCode(classified.status.reason),
      message: describeSelfTestReason(classified.status.reason),
    };
    if (classified.kind === "crashed" && classified.rewrite !== null) {
      // 上一次碰 CoreML 時行程死掉了：把存活標記改成結論，避免下次再被判讀成 pending。
      this.persistRecord(classified.rewrite);
    }
  }

  /** 依現有的量測數據寫入決定快取（值的鍵一律由這裡決定，避免各處拼字不一致）。 */
  private persistRecord(record: DeviceDecisionRecord): void {
    if (!this.deviceDecisionEnabled) return;
    writeDecisionRecord(this.deviceDecisionPath, record);
  }

  /**
   * 寫入裝置決定快取（best-effort）。
   *
   * **單一開關**：`deviceDecisionEnabled` 為 false（Windows／Linux，或明示裝置）時完全不寫，
   * 因此 Windows 的既有行為與「env 明示不吃快取」都不需要各自記得判斷。
   *
   * `lifecycle` 只放生命週期欄位（`pendingPhase`／`suspectedLoadCrashes`）：它們不屬於
   * `selfTest` 摘要（那是給診斷看的），但必須落在同一個檔案裡才原子。
   */
  private writeDecision(
    outcome: DeviceDecisionOutcome,
    fields: Partial<EmbedderSelfTestStatus> = {},
    lifecycle: { pendingPhase?: DeviceDecisionPhase; suspectedLoadCrashes?: number } = {},
  ): boolean {
    if (!this.deviceDecisionEnabled) return false;
    const record: DeviceDecisionRecord = {
      schema: DEVICE_DECISION_SCHEMA,
      ...this.decisionIdentity(),
      outcome,
      testedAt: fields.testedAt ?? new Date().toISOString(),
    };
    if (fields.reason !== undefined) record.reason = fields.reason;
    if (fields.throughputRatio !== undefined) record.throughputRatio = fields.throughputRatio;
    if (fields.minCosine !== undefined) record.minCosine = fields.minCosine;
    if (fields.cpuSessionBuildMs !== undefined) record.cpuSessionBuildMs = fields.cpuSessionBuildMs;
    if (fields.coreMlSessionBuildMs !== undefined) record.coreMlSessionBuildMs = fields.coreMlSessionBuildMs;
    if (lifecycle.pendingPhase !== undefined) record.pendingPhase = lifecycle.pendingPhase;
    if (lifecycle.suspectedLoadCrashes !== undefined) {
      record.suspectedLoadCrashes = lifecycle.suspectedLoadCrashes;
    }
    return writeDecisionRecord(this.deviceDecisionPath, record);
  }

  /**
   * 目前記憶體裡的**量測欄位**（`outcome`／`reason` 一律不搬）。
   *
   * 只放量測欄位是刻意的：這個物件會被寫進 `pending` 存活標記，若把舊的結論或失敗原因一起帶進去，
   * 下一次啟動就會讀到一個不屬於那個階段的 `reason`。過濾由共用的 `measurementFieldsOf` 負責，
   * 避免「這個方法的名字說只給量測欄位、行為卻不是」。
   */
  private measurementFields(): SelfTestMeasurementFields {
    return measurementFieldsOf(this.selfTest ?? {});
  }

  /** 以某個已載入的 session 嵌入樣本，回傳**最終向量**（截斷＋L2 正規化）。 */
  private async embedSamples(
    backend: LoadedModel,
    texts: readonly string[],
  ): Promise<readonly Float32Array[]> {
    const prefixed = texts.map((text) => this.documentPrefix(text));
    const inputs = await backend.processor(prefixed);
    const rows = await runModel(this.modelId, backend.model, inputs);
    if (rows.length !== prefixed.length) {
      throw new ModelInferenceError(
        this.modelId,
        `批次回傳 ${rows.length} 筆向量，預期 ${prefixed.length} 筆`,
      );
    }
    return rows.map((row) => truncateAndNormalize(Float32Array.from(row), this.dim));
  }

  /** 釋放一個 backend（自我測試用；失敗不往外拋）。 */
  private async disposeBackend(backend: LoadedModel): Promise<void> {
    try {
      await backend.model.dispose?.();
    } catch {
      // 釋放失敗不影響流程（session 會隨行程結束回收）。
    }
  }

  /**
   * 建立指定裝置的模型 session；DML 另外指定 EP 與 adapter（沿用 `spikes/dml-bench` 的作法）。
   *
   * **這個 options 物件同時涵蓋文字與視覺兩個 session**：`AutoModel.from_pretrained` 內部由
   * transformers.js 的 `constructSessions` 對每個 session 名稱各複製一份
   * （`getSession` 做 `{ ...options.session_options }`），因此寫在一處即兩個 session 都吃到
   * （測試以 mock 記錄 `from_pretrained` 的參數釘住這一點）。
   *
   * `session_options.enableCpuMemArena = false`（**所有平台、兩個裝置路徑都帶**）：
   * ORT 的 CPU arena 在擴張時會把 chunk 翻倍（`BFCArena::Extend` 的 `while … *= 2`），
   * 當單一配置請求超過 1 GiB 時會直接翻成 2 GiB 的單一配置；這個大小的配置在
   * Chromium／Electron 內會被 PartitionAlloc **依設計直接殺掉行程**（見 `docs/` 與研究筆記）。
   * 關掉 arena 等於整條路移除，並附帶大幅降低 RSS（同工作負載實測 4.8 GB → 0.7 GB），
   * 代價是同工作負載的執行時間約 +5%。
   *
   * `session_options.enableMemPattern = false`（同樣全平台、所有裝置路徑）：
   * arena 關掉後，**聚合的 pattern 大區塊**是同一族死路的殘餘配置點。ORT 的 memory pattern
   * 會在該輸入形狀已有快取 pattern 時，於 `ExecutionFrame` 建構子**一次**配置
   * 「整個 graph 中間張量的峰值總和」（`alloc->Alloc(peak_size)`）；arena 關閉後沒有冪次
   * 加倍，**請求值就是 peak 值本身**。實測這個聚合值隨「單塊長度」成長（8k token 的窗：
   * `16×522` 1.60 GiB、`5×1529` 1.97 GiB、`4×1985` **2.28 GiB**），越過 PartitionAlloc 的
   * 單一配置上限（`MaxAllocationSize()` = 2 GiB − 2 MiB = 2,145,386,496 B）即
   * `PartitionExcessiveAllocationSize` → `PA_IMMEDIATE_CRASH`（`brk #0`）→ 整個 app 閃退。
   * 關掉 pattern 後配置退回個別 tensor，在護欄（`BATCH_TOKEN_BUDGET`／`MAX_INPUT_TOKENS`）
   * 內最大單一 tensor 實測 ≈ `T×49,152 B`（T=8192 ⇒ 約 0.41 GB），遠離上限。
   *
   * 為什麼全平台而不是只有 darwin：
   * 1. 這兩條路徑都是「ORT 配置策略 × 底層配置器上限」的組合問題，與平台無關；PA 在
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
          // 見上方說明：所有平台、所有裝置路徑、文字與視覺兩個 session 都關閉
          // CPU arena 與 memory pattern（單一配置不得逼近 2 GiB）。
          enableCpuMemArena: false,
          enableMemPattern: false,
          ...(device === "dml"
            ? { executionProviders: [{ name: "dml", deviceId: this.dmlDeviceId }] }
            : {}),
          ...(device === "coreml"
            ? {
                // 物件形式是唯一能帶旗標的方法（其他欄位會被綁定層靜默丟棄）；
                // 帶 `0x010`＝MLProgram，理由見 `COREML_MLPROGRAM_FLAG`。
                executionProviders: [{ name: "coreml", coreMlFlags: COREML_MLPROGRAM_FLAG }],
              }
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
   * 依目前裝置載入模型。
   *
   * - `cpu`：直接載。
   * - `dml`（Windows）：載入失敗自動退回 CPU 再載一次（**既有行為，不動**）。
   * - `coreml`（macOS）：見 `loadCoreMl`。
   *
   * CPU 也載不起來時 `ModelLoadError` 照常往外拋（沒有可退的地方）。
   */
  private async loadModel(): Promise<LoadedModel> {
    if (this.device === "cpu") return await this.createBackend("cpu");
    if (this.device === "coreml") return await this.loadCoreMl();
    try {
      return await this.createBackend("dml");
    } catch (error) {
      this.fallbackReason = { code: "load-failed", message: summarizeFailure(error) };
      this.device = "cpu";
      return await this.createBackend("cpu");
    }
  }

  /**
   * 載入 CoreML（macOS）。
   *
   * 三條分岔：
   * 1. **明示 `coreml`**（`requestedDevice` 不是 `auto`）：忽略快取、強制嘗試——不跑自我測試、
   *    不讀寫決定快取、**也不加載入期護欄**（沒有快取就沒有可寫的 marker；契約語意）。
   *    使用者的意圖就是「我就是要試」，判斷與記帳都交給他們。
   * 2. **`auto` 且尚未有可沿用的決定**：跑一次自我測試（marker＝`pending(self-test)`）。
   * 3. **`auto` 且有可沿用的決定**：走**載入期護欄**（marker＝`pending(load)`）——載入成功才把
   *    決定寫回 `usable`，疑似崩潰則由下一次啟動的 `classifyDecision` 處理。
   *
   * 自我測試若**自己拋錯**（最典型：CPU 基準都載不起來），先把 `pending` 改寫成
   * `unusable`／`load-failed` 再往外拋——否則下一次啟動會把「非崩潰的失敗」誤讀成
   * 「上次死在測試中」，永久鎖在 CPU。
   */
  private async loadCoreMl(): Promise<LoadedModel> {
    if (!this.deviceDecisionEnabled) {
      // 明示 `coreml`：強制嘗試、不讀不寫快取（見上方第 1 點）。
      const attempt = await this.attemptCoreMlLoad();
      return attempt.backend;
    }
    if (!this.decisionApplied) return await this.loadCoreMlAfterSelfTest();
    return await this.loadCoreMlWithGuard();
  }

  /** `auto`＋尚未定案：跑自我測試，依結果決定沿用它的 session 或改用 CPU。 */
  private async loadCoreMlAfterSelfTest(): Promise<LoadedModel> {
    let result: CoreMlSelfTestResult<LoadedModel>;
    try {
      result = await runCoreMlSelfTest<LoadedModel>({
        decisionPath: this.deviceDecisionPath,
        identity: this.decisionIdentity(),
        createBackend: (device) => this.createBackend(device),
        embed: (backend, texts) => this.embedSamples(backend, texts),
        disposeBackend: (backend) => this.disposeBackend(backend),
      });
    } catch (error) {
      this.selfTest = {
        outcome: "unusable",
        reason: SELF_TEST_REASONS.loadFailed,
        testedAt: new Date().toISOString(),
      };
      this.writeDecision("unusable", this.measurementFields());
      throw error;
    }

    if (result.kind === "unavailable") {
      // 存活標記寫不進去 → 不得碰 CoreML（保護鏈的前提不存在）。改用 CPU，
      // 且**不嘗試持久化任何決策**（存不了就是存不了；低機率下最壞＝下次啟動保守誤記，安全側）。
      this.device = "cpu";
      this.fallbackReason = { code: "accel-unavailable", message: ACCEL_UNAVAILABLE_MESSAGE };
      return await this.createBackend("cpu");
    }

    this.selfTest = toSelfTestStatus(result.record);
    // 決定已經落地（或已嘗試落地）：同一實例不必再測一次（`dispose()` 後重載也一樣）。
    this.decisionApplied = true;
    if (result.backend !== null) return result.backend;

    // 未通過：改用 CPU。測試中建立的 CoreML session 已由自我測試釋放。
    this.device = "cpu";
    this.fallbackReason = {
      code: selfTestFallbackCode(result.record.reason),
      message: result.message ?? describeSelfTestReason(result.record.reason),
    };
    return await this.createBackend("cpu");
  }

  /**
   * `auto`＋已有可沿用的決定：**載入期護欄**。
   *
   * 為什麼要有這一層：`#28005` 的 SIGBUS 若只是間歇性的，那麼「自我測試剛好沒踩到、
   * 之後每次啟動都踩到」就會變成**無上限的啟動閃退迴圈**，而記錄永遠停在 `usable`
   * ——超出使用者核准的「閃一次就記住」。因此每次為正式使用建 CoreML session 前，
   * 先原子落地 `pending(load)`；成功才把決定寫回 `usable`（計數歸零），
   * 失敗則沿用既有的 `unusable`／`load-failed` 持久化，崩潰則由下一次啟動結算。
   *
   * 護欄寫不進去時**不碰 CoreML**（見 `docs/embedder-contract.md`）：改用 CPU 並用
   * `fallbackReason` 回報，不嘗試持久化任何決策。
   */
  private async loadCoreMlWithGuard(): Promise<LoadedModel> {
    const markerWritten = this.writeDecision("pending", this.measurementFields(), {
      pendingPhase: "load",
      suspectedLoadCrashes: this.suspectedLoadCrashes,
    });
    if (!markerWritten) {
      this.device = "cpu";
      this.fallbackReason = { code: "accel-unavailable", message: ACCEL_UNAVAILABLE_MESSAGE };
      return await this.createBackend("cpu");
    }

    const attempt = await this.attemptCoreMlLoad();
    if (attempt.usedCoreMl) {
      // 建置成功：寫回 `usable`（量測欄位沿用、疑似載入崩潰的計數歸零、不帶任何舊結論）。
      const status: EmbedderSelfTestStatus = {
        ...this.measurementFields(),
        outcome: "usable",
        testedAt: this.selfTest?.testedAt ?? new Date().toISOString(),
      };
      this.selfTest = status;
      this.suspectedLoadCrashes = 0;
      this.writeDecision("usable", status);
    }
    return attempt.backend;
  }

  /**
   * 直接嘗試建 CoreML session；失敗就退回 CPU 並把 `unusable`／`load-failed` 寫進決定快取。
   *
   * 寫回的理由：快取說「可用」但這次載入失敗（驅動更新、ORT 換版、記憶體不足…），
   * 下次啟動不該再付一次失敗的編譯成本。`usedCoreMl` 讓呼叫端分辨「真的用了 CoreML」
   * 與「已退回 CPU」，不必回頭猜 `this.device`。
   *
   * 寫回時**沿用上一輪的量測欄位與 `testedAt`**（只改 `outcome`／`reason`）：那些數字描述的是
   * 「這台機器的加速器量起來如何」，不會因為某次載入失敗而失效；丟掉它們只會讓診斷與設定頁
   * 少掉「（吞吐 …）」的資訊，與載入期崩潰路徑的處置也不一致。
   */
  private async attemptCoreMlLoad(): Promise<{ backend: LoadedModel; usedCoreMl: boolean }> {
    try {
      const backend = await this.createBackend("coreml");
      return { backend, usedCoreMl: true };
    } catch (error) {
      const message = summarizeFailure(error);
      const measured = this.measurementFields();
      this.fallbackReason = { code: "load-failed", message };
      this.selfTest = {
        ...measured,
        outcome: "unusable",
        reason: SELF_TEST_REASONS.loadFailed,
        testedAt: measured.testedAt ?? new Date().toISOString(),
      };
      this.device = "cpu";
      this.writeDecision("unusable", this.selfTest);
      return { backend: await this.createBackend("cpu"), usedCoreMl: false };
    }
  }
}
