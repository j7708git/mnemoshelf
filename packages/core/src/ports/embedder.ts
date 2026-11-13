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

/** 已解碼的單聲道音訊片段；不接受檔案位元組或路徑。 */
export interface AudioInput {
  /** 16 kHz PCM，值有限且介於 -1 與 1；1 至 480,000 個樣本（最多 30 秒）。 */
  samples: Float32Array;
  sampleRate: 16000;
}

/** 已解碼的單一影格；RGB（3 通道）或 RGBA（4 通道）像素，row-major、不做 alpha 預乘。 */
export interface VideoFrameInput {
  /** 已解碼像素；長度必須等於 width × height × channels。 */
  pixels: Uint8Array;
  /** 影格寬度（像素整數）；1 至 MAX_VIDEO_FRAME_EDGE。 */
  width: number;
  /** 影格高度（像素整數）；1 至 MAX_VIDEO_FRAME_EDGE。 */
  height: number;
  /** 通道數：3＝RGB、4＝RGBA。 */
  channels: 3 | 4;
  /** 來源時間（秒）；有限、非負，同一片段內非遞減。模型不編碼時間，但應用要保存與驗證。 */
  timestampSeconds: number;
}

/** 一段影片片段的已解碼影格序列（同段內所有影格的寬、高、通道數必須一致）。 */
export interface VideoInput {
  /** 1 至 MAX_VIDEO_FRAMES 幀；超過上限必須拒絕，不得默默抽樣。 */
  frames: readonly VideoFrameInput[];
}

/** 每段影片的影格數上限（對齊預設模型 video_processor 的 max_frames；超過不得默默抽樣）。 */
export const MAX_VIDEO_FRAMES = 32;

/** 單一影格的邊長上限（像素）；保護前處理與記憶體，正常輸入縮放後遠小於此值。 */
export const MAX_VIDEO_FRAME_EDGE = 2048;

/** 一段影片所有影格的像素總數上限（8,388,608；RGBA 最壞 32 MiB）。 */
export const MAX_VIDEO_PIXELS = 8_388_608;

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
 * 加速器**自我測試**的結果（選填；只有需要「先量測再決定」的實作會提供）。
 *
 * 用途：有些加速器（例如 macOS 的 CoreML）「值不值得用」無法事先查詢，只能實測；
 * 而實測成本高（編譯數秒到數分鐘）又有崩潰風險，因此實作會把量測結果持久化，
 * 之後直接沿用決定。這個型別是那個決定的**摘要**，供診斷與設定頁顯示。
 *
 * `outcome` 的語意：
 * - `usable`：量測通過，加速器已採用。
 * - `unusable`：量測未通過（太慢／向量不一致／記憶體超限／載入失敗），已改用 CPU。
 * - `crashed`：上一次測試**讓行程死掉**（實作以測試前落地的標記推導）→ 永久不再自動重試。
 *
 * 實作若從未測試、或該實作沒有自我測試概念，就不提供這個成員（欄位不存在＝「未測試」）。
 * `reason` 為穩定短標籤（可程式比對），實作定義；契約檔列舉預設實作的標籤。
 */
export interface EmbedderSelfTestStatus {
  /** 測試結論。 */
  outcome: "usable" | "unusable" | "crashed";
  /** 穩定短標籤（實作定義；例如 `too-slow`／`inconsistent`／`memory-exceeded`）。 */
  reason?: string;
  /** 量測到的吞吐倍率（加速器 ÷ CPU）；未量到時不存在。 */
  throughputRatio?: number;
  /** 量測到的向量一致性下限（逐樣本餘弦的最小值）；未量到時不存在。 */
  minCosine?: number;
  /** 測試期間建立 CPU session 的耗時（毫秒）；未量到時不存在。 */
  cpuSessionBuildMs?: number;
  /** 測試期間建立加速器 session 的耗時（毫秒）；載入失敗或未量到時不存在。 */
  coreMlSessionBuildMs?: number;
  /** 測試時間（ISO 8601）；未測試過時不存在。 */
  testedAt?: string;
}

/**
 * embedder 的執行裝置狀態（**選填**能力，供診斷與排程參考）。
 *
 * 為什麼是選填：只有會用到加速器的實作才有「裝置」概念（目前是 `TransformersEmbedder`
 * 的 cpu／DirectML／CoreML）。純軟體或其他實作不需要提供，索引器與 REST 層一律以
 * 「欄位不存在」處理。`serializedInference` 為 true 時，索引器會把檔案間併發限制為 1。
 */
export interface EmbedderRuntimeStatus {
  /** 音訊模型資產的就緒狀態；選配能力不等於資產已載入。 */
  audioState?: "disabled" | "not-loaded" | "loading" | "ready" | "failed";
  /** 音訊失敗後是否可在同一行程重試；false 表示需重新啟動，避免重複原生載入失敗。 */
  audioRetryable?: boolean;
  /** 影片模型資產的就緒狀態；選配能力不等於資產已載入（decoder 是否可用由解碼／索引層另行回報）。 */
  videoState?: "disabled" | "not-loaded" | "loading" | "ready" | "failed";
  /** 影片失敗後是否可在同一行程重試；false 表示需重新啟動後再試。 */
  videoRetryable?: boolean;
  /** 要求／設定的裝置選項（`auto` 表示依平台自動決定）；值由實作定義。 */
  requestedDevice: string;
  /**
   * 目前使用的裝置；模型尚未載入時為**依平台與設定解析出的計畫裝置**。
   * 值由實作定義（本專案目前為 `cpu`／`dml`／`coreml`）。
   */
  device: string;
  /** 模型是否已載入；true 代表 `device` 是實際使用的裝置，而非計畫值。 */
  loaded: boolean;
  /** 曾從 GPU 退回 CPU 時的原因；未退回為 `null`。 */
  fallbackReason: EmbedderFallbackReason | null;
  /** 單一推論視窗含 padding 的 token 預算。 */
  batchTokenBudget?: number;
  /** WebGPU 的實際載入與文字／圖片推論探測。 */
  webgpuProbe?: { status: "pending" | "passed" | "failed"; reason?: string };
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
  /**
   * 加速器自我測試的結果（選填；見 `EmbedderSelfTestStatus`）。
   *
   * 欄位不存在＝從未測試過（或該實作不做自我測試）；舊的實作與舊的診斷 payload
   * 都不會因為缺這個欄位而出錯。
   */
  selfTest?: EmbedderSelfTestStatus;
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
  embedImage(image: ImageInput, opts?: EmbedDocumentsOptions): Promise<Float32Array>;
  /** 音訊片段（選配）；audio 能力為 true 時必須提供，取消語意與圖片相同。 */
  embedAudio?(audio: AudioInput, opts?: EmbedDocumentsOptions): Promise<Float32Array>;
  /**
   * 影片幀序列（選配）；video 能力為 true 時必須提供，取消語意與圖片相同。
   * 輸入是**已解碼**的幀，不接受檔案位元組、路徑或影片容器；不加文字 prefix。
   */
  embedVideo?(video: VideoInput, opts?: EmbedDocumentsOptions): Promise<Float32Array>;
  /** 啟動探測。 */
  probe(): Promise<ProbeResult>;
  dispose(): Promise<void>;
}
