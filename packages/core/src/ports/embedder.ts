/**
 * Embedder 契約（docs/embedder-contract.md）。
 * Mnemoshelf 只接受多模態 embedder：text 與 image 必須同時支援，且映射到同一個向量空間。
 */

/** 圖片的輸入。本專案統一定義為「已編碼的檔案位元組」。 */
export interface ImageInput {
  /** 圖片的原始位元組（例如 PNG／JPEG 檔內容）。 */
  bytes: Uint8Array;
  /** 選用的 MIME 型別，僅供實作提示。 */
  mimeType?: string;
}

/** embedder 的能力宣告。 */
export interface EmbedderInfo {
  /** 穩定識別，含模型與執行環境，例如 "embeddinggemma-2@onnx-q8"。換模型或量化版就要換 id。 */
  id: string;
  /** 輸出維度（截斷並重新正規化之後的維度）。 */
  dim: number;
  capabilities: {
    /** 必須為 true。 */
    text: true;
    /** 必須為 true。 */
    image: true;
    audio: boolean;
    video: boolean;
  };
}

/** 啟動探測的結果。 */
export interface ProbeResult {
  ok: boolean;
  /** 失敗或補充說明（不含敏感資訊）。 */
  message?: string;
}

/** 模態 embedding 介面。所有回傳向量必須長度為 info.dim 且已 L2 正規化（容差 1e-3）。 */
export interface Embedder {
  readonly info: EmbedderInfo;
  /** 查詢文字（實作會套用查詢 prefix）。 */
  embedQuery(text: string): Promise<Float32Array>;
  /** 文件文字；title 沒有時用 "none"（實作會套用文件 prefix）。 */
  embedDocument(text: string, title?: string): Promise<Float32Array>;
  /** 圖片。 */
  embedImage(image: ImageInput): Promise<Float32Array>;
  /** 啟動探測。 */
  probe(): Promise<ProbeResult>;
  dispose(): Promise<void>;
}
