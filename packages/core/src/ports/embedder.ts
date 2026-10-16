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

/** 從 GPU 退回 CPU 的原因（短標籤＋已去識別化的說明）。 */
export interface EmbedderFallbackReason {
  /** 穩定短標籤（可程式比對），例如 `unsupported-platform`／`load-failed`／`inference-failed`。 */
  code: string;
  /** 人類可讀的短說明；**不得**含本機絕對路徑或個資（會經 `GET /diagnostics` 外洩）。 */
  message: string;
}

/**
 * embedder 的執行裝置狀態（**選填**能力，供診斷與排程參考）。
 *
 * 為什麼是選填：只有會用到加速器的實作才有「裝置」概念（目前是 `TransformersEmbedder`
 * 的 cpu／DirectML）。純軟體或其他實作不需要提供，索引器與 REST 層一律以
 * 「欄位不存在」處理。`serializedInference` 為 true 時，索引器會把檔案間併發限制為 1。
 */
export interface EmbedderRuntimeStatus {
  /** 要求／設定的裝置選項（`auto` 表示依平台自動決定）；值由實作定義。 */
  requestedDevice: string;
  /**
   * 目前使用的裝置；模型尚未載入時為**依平台與設定解析出的計畫裝置**。
   * 值由實作定義（本專案目前為 `cpu`／`dml`）。
   */
  device: string;
  /** 模型是否已載入；true 代表 `device` 是實際使用的裝置，而非計畫值。 */
  loaded: boolean;
  /** 曾從 GPU 退回 CPU 時的原因；未退回為 `null`。 */
  fallbackReason: EmbedderFallbackReason | null;
  /** 目前的批次視窗大小（一次送進模型的輸入數上限）。 */
  batchSize: number;
  /**
   * 同一 session 是否只允許序列推論（同一時間僅一次 `Run`）。
   * DirectML 有此官方限制 → 為 true 時索引器把檔案間併發固定為 1，
   * 且實作本身必須在同一實例內序列化所有 `embed*` 呼叫（多個索引 job、搜尋與探測都可能並發）。
   */
  serializedInference: boolean;
  /**
   * DirectML 的 adapter **設定值**（`IDXGIFactory::EnumAdapters` 順序，0＝預設顯示卡）。
   *
   * 語意：只有 `dml` 路徑會拿它建立 session，但**非 dml 路徑與退回 CPU 後仍顯示這個設定值**，
   * 診斷才判讀得出「原本指定第 N 張卡、之後退回了」。沒有 adapter 概念的實作為 `null`。
   */
  dmlDeviceId: number | null;
}

/** 啟動探測的結果。 */
export interface ProbeResult {
  ok: boolean;
  /** 失敗或補充說明（不含敏感資訊）。 */
  message?: string;
}

/**
 * 批次文件文字的單一輸入項。
 * 語意與 `embedDocument(text, title)` 完全相同：title 沒有時視為 "none"，實作會套用文件 prefix。
 */
export interface DocumentInput {
  /** 文件文字內容。 */
  text: string;
  /** 文件標題（本專案慣例：相對路徑）。省略時視為 "none"。 */
  title?: string;
}

/** `embedDocuments` 的呼叫選項。 */
export interface EmbedDocumentsOptions {
  /** 取消訊號；實作應在開始推論前檢查（沿用 `throwIfAborted` 慣例）。 */
  signal?: AbortSignal;
}

/** 模態 embedding 介面。所有回傳向量必須長度為 info.dim 且已 L2 正規化（容差 1e-3）。 */
export interface Embedder {
  readonly info: EmbedderInfo;
  /**
   * 執行裝置狀態（**選填**的加值成員，向後相容）：有加速器概念的實作才提供。
   *
   * 用途：`GET /diagnostics` 顯示實際裝置與退回原因；索引器依
   * `serializedInference` 決定檔案間併發上限（見 `indexRoot`）。
   */
  readonly runtimeStatus?: EmbedderRuntimeStatus;
  /** 查詢文字（實作會套用查詢 prefix）。 */
  embedQuery(text: string): Promise<Float32Array>;
  /** 文件文字；title 沒有時用 "none"（實作會套用文件 prefix）。 */
  embedDocument(text: string, title?: string): Promise<Float32Array>;
  /**
   * 文件文字批次；輸出與 `inputs` **一一對應且順序相同**（`output[i]` 對應 `inputs[i]`）。
   * 空陣列回傳 `[]`。任一項失敗則整批拋錯，不回傳部分結果。
   * 語意與逐項呼叫 `embedDocument` 一致（見 docs/embedder-contract.md 的批次方法一節）。
   */
  embedDocuments(inputs: readonly DocumentInput[], opts?: EmbedDocumentsOptions): Promise<Float32Array[]>;
  /** 圖片。 */
  embedImage(image: ImageInput): Promise<Float32Array>;
  /** 啟動探測。 */
  probe(): Promise<ProbeResult>;
  dispose(): Promise<void>;
}
