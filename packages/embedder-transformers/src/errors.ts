/**
 * 具名的錯誤型別（沿用 @mnemoshelf/core `errors.ts` 的風格）。
 * 訊息不得包含敏感資訊；必要的原始值放在欄位裡。
 */

/** 建構子選項無效（維度、dtype、maxSoftTokens 等）。 */
export class InvalidEmbedderOptionError extends Error {
  /** 出問題的選項名稱。 */
  readonly option: string;
  /** 傳入的值（原始值，便於除錯）。 */
  readonly value: unknown;

  constructor(option: string, value: unknown, message: string) {
    super(`embedder 選項「${option}」無效：${message}`);
    this.name = "InvalidEmbedderOptionError";
    this.option = option;
    this.value = value;
  }
}

/** 維度不是模型支援的 MRL 截斷點（128／256／512／768）。 */
export class UnsupportedDimensionError extends InvalidEmbedderOptionError {
  /** 支援的維度清單。 */
  readonly supported: readonly number[];

  constructor(dim: number, supported: readonly number[]) {
    super("dim", dim, `${dim} 不是支援的維度；支援 ${supported.join("、")}`);
    this.name = "UnsupportedDimensionError";
    this.supported = supported;
  }
}

/** dtype 不在允許清單，或是不被允許的精度（如 float16）。 */
export class UnsupportedDtypeError extends InvalidEmbedderOptionError {
  /** 支援的 dtype 清單。 */
  readonly supported: readonly string[];

  constructor(dtype: string, supported: readonly string[], reason: string) {
    super("dtype", dtype, `不支援「${dtype}」：${reason}；支援 ${supported.join("、")}`);
    this.name = "UnsupportedDtypeError";
    this.supported = supported;
  }
}

/** 載入模型（config／processor／model 或權重下載）失敗。 */
export class ModelLoadError extends Error {
  /** 模型 id。 */
  readonly modelId: string;

  constructor(modelId: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`載入模型「${modelId}」失敗：${detail}`);
    this.name = "ModelLoadError";
    this.modelId = modelId;
  }
}

/**
 * 輸入本身無法處理（圖片解不開、格式不支援、通道數不符…）。
 *
 * 這一類錯誤**與執行裝置無關**：換 CPU 或重試同一份位元組結果一樣，因此呼叫端應該
 * 跳過這個檔案，而不是退回裝置或重試。屬「輸入類」而非「裝置／模型類」失敗。
 *
 * 與 `@mnemoshelf/core` 的跨套件契約（core 不得 import 本套件）：本錯誤以**穩定錯誤碼**
 * `code:"undecodable"` 標記（同名於 core 的 `SkipReason`）。core 的
 * `isMediaDecodeError` 以這個碼為主要判準，不必解析訊息文字——訊息措辭會隨 sharp／
 * transformers.js 版本變動。其他 embedder 實作只要照樣帶這個 `code`（或沿用已知的
 * 訊息措辭）即可被 core 認成同一類。
 */
export class EmbedderInputError extends Error {
  /** 穩定錯誤碼：讓 core 以結構化標記辨識「解不開」，不依賴訊息文字。 */
  readonly code = "undecodable";

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "EmbedderInputError";
  }
}

/** 推論失敗（模型輸出缺少可用的 sentence_embedding，或形狀不符）。 */
export class ModelInferenceError extends Error {
  /** 模型 id。 */
  readonly modelId: string;

  constructor(modelId: string, message: string) {
    super(`模型「${modelId}」推論失敗：${message}`);
    this.name = "ModelInferenceError";
    this.modelId = modelId;
  }
}

/**
 * 空白圖片輸入（零位元組）。
 *
 * 是 `EmbedderInputError` 的特例（零位元組＝永遠解不開），因此也帶 `code:"undecodable"`；
 * 保留自己的名字是為了讓既有以 `name` 判定的路徑（core 與既有測試）繼續辨識得出。
 */
export class EmptyImageInputError extends EmbedderInputError {
  constructor() {
    super("圖片輸入為空：bytes 長度為 0");
    this.name = "EmptyImageInputError";
  }
}

/** 截斷維度大於向量現有長度。 */
export class VectorTruncationError extends Error {
  /** 要求的維度。 */
  readonly requested: number;
  /** 現有長度。 */
  readonly available: number;

  constructor(requested: number, available: number) {
    super(`無法截斷成 ${requested} 維：向量只有 ${available} 維`);
    this.name = "VectorTruncationError";
    this.requested = requested;
    this.available = available;
  }
}
