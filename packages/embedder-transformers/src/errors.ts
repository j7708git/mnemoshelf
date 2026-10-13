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

/** 空白圖片輸入（零位元組）。 */
export class EmptyImageInputError extends Error {
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
