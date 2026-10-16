# Embedder 契約

Mnemoshelf 只接受**多模態** embedding 模型：文字與圖片必須映射到**同一個**向量空間，
這樣才能用文字搜尋圖片。純文字模型不能作為 embedder。

## 能力宣告

每個 embedder 實作必須宣告：

```ts
interface EmbedderInfo {
  /** 穩定識別，含模型與執行環境，例如 "embeddinggemma-2@onnx-q8"。換模型或量化版就要換 id。 */
  id: string;
  /** 輸出維度（截斷並重新正規化之後的維度）。 */
  dim: number;
  capabilities: {
    text: true;          // 必須
    image: true;         // 必須
    audio: boolean;      // 選用
    video: boolean;      // 選用
  };
}
```

`text` 與 `image` 兩者缺一就不能註冊成 embedder。

## 介面

```ts
interface Embedder {
  readonly info: EmbedderInfo;
  /** 執行裝置狀態（**選配**成員，見「執行裝置狀態」一節）；沒有加速器概念的實作可以不提供。 */
  readonly runtimeStatus?: EmbedderRuntimeStatus;
  /** 查詢文字（會套用查詢 prefix）。 */
  embedQuery(text: string): Promise<Float32Array>;
  /** 文件文字；title 沒有時用 "none"（會套用文件 prefix）。 */
  embedDocument(text: string, title?: string): Promise<Float32Array>;
  /** 文件文字批次；輸出與 inputs 一一對應且順序相同（見「批次方法」一節）。 */
  embedDocuments(inputs: readonly DocumentInput[], opts?: EmbedDocumentsOptions): Promise<Float32Array[]>;
  /** 圖片。輸入為已解碼的像素或檔案位元組，由實作決定，但必須明確定義。 */
  embedImage(image: ImageInput): Promise<Float32Array>;
  /** 啟動探測，見「啟動探測」一節。 */
  probe(): Promise<ProbeResult>;
  dispose(): Promise<void>;
}
```

所有回傳的向量：長度為 `info.dim`、**已 L2 正規化**（模長 1，容差 1e-3）。

## 執行裝置狀態（`runtimeStatus`，選配）

> 本節於 **2026-10-16 經使用者核准新增**。這個成員在型別上是**選配**：既有實作不需要提供
> 也不會受影響，索引器與 REST 層遇到「欄位不存在」時照舊運作。

只有會用到加速器的實作才有「裝置」概念，因此 `runtimeStatus` 是**選配**成員；
它提供診斷（例如 `GET /diagnostics` 顯示實際裝置與退回原因）與索引器併發決策所需的資訊。

```ts
/** embedder 的執行裝置狀態（選配能力，供診斷與排程參考）。 */
interface EmbedderRuntimeStatus {
  /** 要求／設定的裝置選項（`auto` 表示依平台自動決定）；值由實作定義。 */
  requestedDevice: string;
  /**
   * 目前使用的裝置；模型尚未載入時為**依平台與設定解析出的計畫裝置**。
   * 值由實作定義（本專案的預設實作為 `cpu`／`dml`）。
   */
  device: string;
  /** 模型是否已載入；true 代表 `device` 是**實際使用**的裝置，而非計畫值。 */
  loaded: boolean;
  /** 曾從 GPU 退回 CPU 時的原因；未退回為 `null`。 */
  fallbackReason: EmbedderFallbackReason | null;
  /** 目前的批次視窗大小（一次送進模型的輸入數上限）。 */
  batchSize: number;
  /**
   * 同一 session 是否只允許序列推論（同一時間僅一次 `Run`）。
   * 為 true 時索引器把**檔案間**併發限制為 1，且實作本身必須在同一實例內
   * 序列化所有 `embed*` 呼叫（多個索引 job、搜尋與探測都可能並發）。
   */
  serializedInference: boolean;
  /**
   * DirectML 的 adapter **設定值**（`IDXGIFactory::EnumAdapters` 順序，0＝預設顯示卡）。
   * 非 dml 路徑與退回 CPU 後仍顯示這個設定值，診斷才判讀得出「原本指定第 N 張卡、之後退回了」。
   * **沒有 adapter 概念的實作為 `null`。**
   */
  dmlDeviceId: number | null;
}

/** 從 GPU 退回 CPU 的原因（短標籤＋已去識別化的說明）。 */
interface EmbedderFallbackReason {
  /** 穩定短標籤（可程式比對），例如 `unsupported-platform`／`load-failed`／`inference-failed`。 */
  code: string;
  /** 人類可讀的短說明；**不得**含本機絕對路徑或個資（會經 `GET /diagnostics` 外洩）。 */
  message: string;
}
```

## 批次方法（`embedDocuments`）

> 本節於 **2026-10-15 經使用者核准新增**。舊的單筆方法（`embedDocument`）保留，語意不變；
> 批次方法讓實作可以一次 forward 算多塊，改善索引吞吐量。

```ts
/** 批次中的單一文件輸入項。 */
interface DocumentInput {
  /** 文件文字內容。 */
  text: string;
  /** 文件標題（本專案慣例：相對路徑）。省略時視為 "none"。 */
  title?: string;
}

interface EmbedDocumentsOptions {
  /** 取消訊號；實作應在開始推論前檢查（沿用 `throwIfAborted` 慣例）。 */
  signal?: AbortSignal;
}
```

保證：

- **順序與數量**：回傳陣列長度等於 `inputs.length`，且 `output[i]` 對應 `inputs[i]`。
- **語意一致**：同一文字在批次中的向量，與逐筆 `embedDocument(text, title)` 的向量一致
  （允許 pad 造成的極小差異；實測餘弦 ≥ 0.999）。
- **空輸入**：`inputs` 為空陣列時回傳 `[]`，且不需要載入模型。
- **失敗**：任一項失敗（模型輸出形狀不符、取消）即**整批拋錯**，不回傳部分結果。
- **取消**：`opts.signal` 沿用索引器的 `throwIfAborted` 慣例，實作應在開始推論前檢查。

**批次上限**：一次 forward 的視窗上限由實作決定，並可由 `runtimeStatus.batchSize` 讀到。
本專案的預設實作**依執行裝置**取上限：DirectML（`dml`）為 32、CPU 為 16
（常數 `MAX_BATCH_SIZE` 即 CPU 的 16；DML 取 32 的依據為實測，見實作內註解）。批次會把同批
文字 pad 到同批最長序列，過大的批次會讓 pad 成本與記憶體上升，因此需要上限；超過上限的輸入
應由實作**內部切成多個視窗**後串接回傳，呼叫端不需自行分批。

## 啟動探測（probe）

註冊 embedder 後、建立任何索引前，必須先通過探測；未通過就拒絕啟用，
避免用壞掉的模型建出整個無效的索引。

探測內容：嵌入至少兩張內容明顯不同的測試圖與數句描述文字，檢查：

1. 向量維度等於 `info.dim`，且沒有 `NaN` 或 `Infinity`。
2. 向量已正規化。
3. 每張圖與「描述它的文字」的相似度，高於與「描述另一張圖的文字」的相似度
   （有明確差距，差距門檻由實測決定並寫進實作）。

## 無法解碼／處理的輸入（輸入類失敗）

> 本節於 **2026-10-16 經使用者核准新增**。這是語意補述，不改既有行為：把「輸入解不開」與
> 「裝置／模型失敗」的分野寫成契約，讓所有 embedder 實作遵循。

embedder 可能收到**永遠處理不了**的輸入，最典型的是解不開的媒體位元組：解碼器不支援的格式
（如 HEIC／BMP／ICO）、標頭損毀、通道數不合法，或是 0 byte 的佔位檔。這一類屬於**輸入類**失敗，
**與執行裝置無關**——換 CPU、重試同一份位元組，結果都一樣。

**實作端：以可辨識的標記回報。** 遇到無法解碼／處理的輸入時，應以**可辨識的標記**回報，
不要只拋一般的 `Error`。本專案的預設實作為 `EmbedderInputError`，帶**穩定錯誤碼**
`code:"undecodable"`；`EmptyImageInputError`（零位元組圖片輸入）是其子類，同樣帶這個碼。
`undecodable` 與 core 的 `SkipReason` 同名是刻意的：同一個語意、同一個字。其他實作只要照樣
帶上這個 `code` 就能被 core 認成同一類，不必 import 本專案的套件（core 也不 import embedder
套件，不該知道實作內用了哪個解碼器）。

**核心端：分類處置。** core（indexer）遇到帶此標記的錯誤時：

- **媒體檔**：記為乾淨跳過的 `skipped(undecodable)`，**不進** `failedFiles`；該檔既有索引資料
  一併清除（沿用「被跳過者不得保留索引」的規則）。
- **不視為裝置失敗**：不觸發 GPU→CPU 退回，`runtimeStatus.fallbackReason` 不會因此改變。
- **非媒體檔**（文字／程式碼）：同一類錯誤仍視為**一般**失敗，照舊進 `failedFiles`，
  失敗檔的既有索引資料保留、下一輪重試。
- **取消不是解碼失敗**：`AbortError` 照舊中止整輪，不得被誤判成 `undecodable`。

**訊息措辭的後備判準。** 核心另以訊息措辭（與少數已知的錯誤名稱）作為**後備**判準，服務尚未
實作標記的 embedder 實作：core 拿不到結構化訊號時仍能判出這一類。但那只是相容性後備，且刻意
保守——只認得清單內的措辭才降級成 skipped，其餘（含未知的新錯誤）一律維持一般失敗，免得把
真正的嵌入錯誤靜默吞成跳過。**新實作應優先支援標記**，不要依賴訊息文字（措辭會隨
sharp／transformers.js 版本變動）。

## EmbeddingGemma 2 的使用要點（目前的預設模型）

- 文字要套 prefix：查詢 `task: search result | query: {query}`；
  文件 `title: {title} | text: {content}`（沒有標題用 `title: none`）。
  **圖片、音訊、影片不加 prefix。**
- 原生輸出 768 維，支援截斷成 512、256、128 維；**截斷後必須重新 L2 正規化**；
  查詢與文件必須用相同維度。預設採用 512 維，實測後可調整。
- 精度只能用 `bfloat16` 或 `float32`，**不可用 `float16`**（會出現 NaN 或靜默劣化）。
  ONNX 量化版（q8、q4）是另外釋出的檔案，不受此限，但需實測品質。
- 上下文共 8192 token；圖片預設每張 280 token，音訊每秒 25 token，影片每幀 140 token。
- 視覺與音訊編碼器可以選擇性載入，只用文字加圖片時不需載入音訊編碼器。

## 更換 embedder

每筆向量記錄 `embedder_id` 與 `dim`。更換 embedder 後，既有向量不可混用，
必須重新建立索引；系統需能偵測並提示。
