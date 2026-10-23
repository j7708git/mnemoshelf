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
   * 值由實作定義（本專案的預設實作為 `cpu`／`dml`／`coreml`）。
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
  /** 加速器自我測試的結果（**選配**；見下一節）。欄位不存在＝未測試過。 */
  selfTest?: EmbedderSelfTestStatus;
}

/** 從 GPU 退回 CPU 的原因（短標籤＋已去識別化的說明）。 */
interface EmbedderFallbackReason {
  /** 穩定短標籤（可程式比對），例如 `unsupported-platform`／`load-failed`／`inference-failed`。 */
  code: string;
  /** 人類可讀的短說明；**不得**含本機絕對路徑或個資（會經 `GET /diagnostics` 外洩）。 */
  message: string;
}
```

**ONNX Runtime log 等級（`MNEMOSHELF_EMBED_ORT_LOG`，選配、純診斷）**：設定後覆寫推論 session 的
`logSeverityLevel`；值是 `0`–`4`（`0`＝verbose、`1`＝info、`2`＝warning、`3`＝error、`4`＝fatal），
未設定＝**不覆寫** ONNX Runtime 的預設。`0` 會印出 ORT 內部的配置訊息，**包括 arena 每一次擴張的
`num_bytes`**，是「單一配置到底多大」唯一的直接讀數（配置護欄見「批次方法」一節）。代價是訊息量
很大、會拖慢啟動，**平時不要開**；非法值（不是 `0`–`4`）直接拒絕啟動，不會靜默回退預設。
它只是診斷開關，不參與任何裝置決策，也不改變 `selfTest` 的結果。

## 加速器自我測試（`runtimeStatus.selfTest`，選配）

> 本節於 **2026-10-16 經使用者核准新增**。這只是一個**選配**的診斷欄位：不提供它的實作
> 完全不受影響，`GET /diagnostics` 只是不會出現 `selfTest` 這個鍵（不是 `null`）。

有些加速器「值不值得用」**無法事先查詢**（macOS 的 CoreML EP 沒有能力查詢 API），只能實測；
而實測的成本（編譯時間可達數分鐘）與風險（上游已知問題可能直接終止行程）都高，
因此實作會「量測一次、把決定持久化」，之後直接沿用。`selfTest` 就是那個決定的摘要。

```ts
/** 加速器自我測試的結果（選配）。 */
interface EmbedderSelfTestStatus {
  /** `usable`＝量測通過、已採用加速器；`unusable`＝量測未通過、已改用 CPU；
   *  `crashed`＝上一次測試讓行程死掉（永久不再自動重試）。 */
  outcome: "usable" | "unusable" | "crashed";
  /** 穩定短標籤（實作定義；見下方預設實作的清單）。 */
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
```

**預設實作（`TransformersEmbedder`）的判準**：吞吐倍率 ≥ **1.3×**、向量一致性 min cos ≥ **0.999**、
測試期峰值 RSS ≤ **6 GiB**。三者以「**剛好達到門檻即通過**」為準（`>=`／`<=`）。

**session 建置耗時（`cpuSessionBuildMs`／`coreMlSessionBuildMs`）**：**純診斷數據，不參與判準**
（不設門檻）。為什麼要記：Node 端拿不到 CoreML 的編譯快取（綁定層會丟棄
`ModelCacheDirectory`），每次啟動第一次使用加速器都要重新編譯，這個數字就是
「那次會不會卡」的直接讀數；CPU 那一邊一起記，才有可比較的基準。
語意：CoreML **載入失敗**時不記（沒有建好的 session）；未量到時欄位不存在。

**預設實作的 `reason` 標籤**（穩定字串，可程式比對）：

| `reason` | 意義 |
|---|---|
| `too-slow` | 加速器不夠快（吞吐倍率未達門檻） |
| `inconsistent` | 向量與 CPU 不一致（餘弦未達門檻） |
| `memory-exceeded` | 測試期峰值記憶體超過門檻 |
| `load-failed` | 加速器 session 載入失敗 |
| `inference-failed` | session 建得起來，但推論失敗 |
| `crashed-during-self-test` | 由「測試中」的存活標記推導：上一次測試讓行程死掉 |
| `crashed-during-load` | 由「載入中」的存活標記推導：連續第二次在正式載入時疑似讓行程死掉 |

**預設實作的 `fallbackReason.code`**：自我測試擋下的情況用 `accel-*` 家族
（`accel-slow`／`accel-inconsistent`／`accel-memory-exceeded`／`accel-crashed`），
讓診斷一眼看出「是加速器自我測試擋的」而不是別的載入錯誤；載入失敗與推論失敗沿用既有的
`load-failed`／`inference-failed`；疑似載入崩潰但還在容忍內為 `accel-load-crashed`，
存活標記寫不進去（因此不敢碰加速器）為 `accel-unavailable`。

**重測政策（預設實作）**：`crashed` 永不自動重試；其他結果在**應用程式版本**變更時重測一次
（量測結果與當時的實作綁在一起）；模型 id／dtype／平台／CPU 架構任一改變也重測。
決定快取存在模型快取目錄（`<cacheDir>/device-decision.json`）並以原子寫入更新。

**明示 `coreml` 的語意**：只有 `auto` 會跑自我測試並讀寫決定快取；**明示** `coreml`
（環境變數或建構子選項）代表「忽略已快取的決定、強制嘗試」，因此**不執行自我測試、也不讀寫
決定快取**——載入失敗時 `selfTest` 只反映該次載入的結果、不落地。
這個模式**只供單次驗證，不要當成日常設定**：上游的 `onnxruntime#28005`（CoreML EP＋external
data、以檔案路徑建 session 的 `SIGBUS`）仍未修，可能在**任何一次**載入時直接結束行程（證據見
`packages/embedder-transformers/src/self-test.ts` 的模組註解與自我測試入口），而明示模式也
**不套用**下方「載入期的崩潰政策」段落的存活標記護欄（沒有決定快取就沒有可寫的 marker，見
`packages/embedder-transformers/src/embedder.ts` 的 `loadCoreMl` 分岔註解），等於少了自我測試
那次的量測把關。macOS 的 CoreML EP 對這種量化模型也**沒有實測過的加速證據**。

**已判定 `usable` 後的載入失敗**：該次載入失敗會把決定改寫成 `unusable`／`load-failed`，
之後不再自動嘗試；重測只可能發生在**應用程式版本變更**或**明示 `coreml`** 時。

**載入期的崩潰政策**：加速器可能在**任何一次**載入時讓行程結束（上游已知問題），而「自我測試
那次剛好沒踩到、之後每次啟動都踩到」是最壞的情況；因此 `auto` 的每一次正式載入前都會先落地
一張存活標記（決定檔的 `pending` 記錄；標記**一律**帶階段——自我測試為 `self-test`、正式載入為
`load`——而**只有載入期護欄的標記**另帶疑似載入崩潰的次數），並依下列規則結算：

- **自我測試期崩潰**（階段 `self-test`，等同舊檔缺階段的記錄）→ 永久 `crashed`（`crashed-during-self-test`），不再自動重試。
- **載入期崩潰**（階段 `load`）→ 疑似一次：**該次啟動改用 CPU**、把決定寫回 `usable`（次數 +1），
  下次啟動再試一次；**連續第二次**才永久 `crashed`（`crashed-during-load`）。
- **載入成功**時疑似崩潰的次數歸零（量測欄位沿用，不因載入而遺失）。

**存活標記寫不進去時不得碰加速器**：任何「先寫標記、再碰 CoreML」的路徑，若標記無法落地，
該次**不嘗試**加速器（以 CPU 執行、`fallbackReason.code` 為 `accel-unavailable`），
且不嘗試持久化任何決策（寫不進去就是寫不進去）。

**最終結果寫不進去時的行為**：該次的決定在記憶體中仍然有效（本次執行照它走），磁碟上留下的則是
那一輪的存活標記，因此下一次啟動的處置**依路徑而不同**：

- **自我測試路徑**留下 `pending(self-test)` → 保守記成 `crashed`（`crashed-during-self-test`，
  永久改用 CPU）。
- **載入期護欄**留下 `pending(load)` → 該次先用 CPU、疑似崩潰次數 +1，下次啟動再試一次
  （與「疑似載入期崩潰」同一條規則；連續第二次就永久停用——磁碟上「真的崩潰」與「只是寫不進去」
  無法區分，這是刻意的保守取捨）。

兩者都是**安全側**的結果；改寫後仍寫不進去就接受（低機率、且下一次啟動的處置仍然保守）。

**不屬於契約的部分**：快取檔的檔案格式、路徑與量測方法都由實作決定；契約只保證
`selfTest` 這個欄位的形狀與它「不存在＝未測試」的語意。診斷輸出中的字串一律
遵守「不含本機絕對路徑與個資」的既有規則。

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
本專案的預設實作**依執行裝置**取上限：DirectML（`dml`）為 32、CPU 與 CoreML（`coreml`）為 16
（常數 `MAX_BATCH_SIZE` 即 CPU 的 16；DML 取 32 的依據為實測，見實作內註解）。批次會把同批
文字 pad 到同批最長序列，過大的批次會讓 pad 成本與記憶體上升，因此需要上限；超過上限的輸入
應由實作**內部切成多個視窗**後串接回傳，呼叫端不需自行分批。

**單筆輸入上限（`MAX_INPUT_TOKENS`，數值 8192）**

> 本段於 **2026-10-17 經使用者核准新增**（macOS 索引閃退的破口補丁）。

「一窗的 token 預算」只能在視窗內**有多筆**時靠縮窗生效——單筆就是護欄的破口。因此實作
**必須**對單筆輸入另設硬上限，判定方式為：

- 以**實際** token 數判定，不靠估算（估算對罕用 CJK／byte-fallback 內容會低估 3–4 倍）。
  本專案的預設實作以 processor 算出的 `input_ids` 形狀量測（`batch × 序列長度`）。
- **超過 8192 即拒絕**：該筆**不得**送進模型，實作應拋出輸入類錯誤
  （見「無法解碼／處理的輸入」一節的**穩定錯誤碼 `input-too-long`**）。
- **剛好等於 8192 是合法的**（上限的語意是「不超過」）。

涵蓋範圍：

- `embedDocuments` 的**單筆視窗**：`inputs` 只有一筆，或批次視窗因預算縮窗縮到剩一筆時。
- 單筆文字入口：`embedQuery`／`embedDocument`。生產路徑目前只有兩處：`/search` 的
  `embedQuery` 查詢，以及 desktop 啟動時的模型驗證短字串；`embedDocument` 是介面方法，
  目前非熱路徑（索引走批次方法 `embedDocuments`）。**記憶寫入（`POST /memories`）不經
  embedder**：它只寫 metadata store，不產生向量、不進索引，因此不受這條上限保護。
- **不涵蓋圖片**：影像前處理的 token 數由模型設定自然有界（本專案實測 `pixel_values`
  一律 `[1,630,768]`，與圖尺寸無關），因此圖片路徑沒有這條上限。

為什麼是 8192：**等同模型契約載明的上下文長度**（見「EmbeddingGemma 2 的使用要點」），
超過本來就處理不了（tokenizer **不會截斷**——`truncation` 預設 `null`；處理器雖傳 `padding: true`，
但單筆時會夾成該筆自身長度、形同 no-op；且快取內的 `model_max_length` 實質無上限，故超長序列
會**原樣**進模型），因此**不窄化任何原本合法的輸入**；正常切塊（512 估算
token ≈ 最多約 2,048 真實 token）離這個值很遠，這是安全網而非常態路徑。

為什麼要有數值上的硬界線：推論的單一配置大小隨輸入形狀成長，而 Electron 的底層配置器
（Chromium PartitionAlloc）對**單一配置**有硬上限，越過即**直接終止整個行程**
（`MaxAllocationSize()` 故意設在 2 GiB 以下：2 GiB − 2 MiB = 2,145,386,496 B）。以 8192 為界時，
最壞的單筆配置仍有界（注意力類 `[1,4,8192,8192]` fp32 ≈ 1.07 GB、per-token 類
`T×49,152 B`（T=8192）≈ 0.41 GB），**確定性**地低於該上限。

**但這條上限（與批次 token 預算 `BATCH_TOKEN_BUDGET`）都不是記憶體配置的護欄。** 真正的
配置護欄是 session options 的 `enableMemPattern: false`（關掉 memory-pattern 的聚合大區塊；
`enableCpuMemArena: false` 一併關閉 arena）。實測 `5×1529`（1.97 GiB）與 `4×1985`（2.28 GiB）
**都落在 `BATCH_TOKEN_BUDGET`（8192）之內**，而後者已達 PartitionAlloc 上限的 **113.9%**
（在 Electron 內必死）；連**超出**預算的 `16×522`（T=8,352）也有 1.60 GiB——可見 token 預算
並不保證配置低於 PartitionAlloc 的單一配置上限。**不要**因為預算「看起來夠小」就把 pattern 打開：
那條路正是 macOS 索引閃退的成因。

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

**單筆輸入過長也是輸入類失敗（穩定錯誤碼 `input-too-long`）。** 單筆輸入的實際 token 數超過
上限時（見「批次方法」一節的單筆輸入上限），實作**不得**把該筆送進模型，並應以同一類標記
回報：本專案的預設實作為 `EmbedderInputError`，帶**穩定錯誤碼** `code:"input-too-long"`。
它與 `undecodable` 屬同一類（**與執行裝置無關**、重試同一份輸入結果相同），差別只在原因；
因此同樣**不觸發** GPU→CPU 退回、不改變 `runtimeStatus.fallbackReason`。
core 目前以錯誤**名稱**（`EmbedderInputError`／`EmptyImageInputError`）歸類，故錯誤名稱不變
即可被認成同一類。**但 `input-too-long` 這個碼不是選配**：共用契約測試會要求它，且 server 端
就是靠這個碼把這類失敗回應成 **4xx（不是 500）**；只帶名稱而不帶這個碼的實作，會過得了
core 的歸類、卻過不了契約測試與 HTTP 分級。

**索引路徑的行為＝不讓整輪失敗。** 這一類錯誤在索引路徑上屬「可跳過的輸入類失敗」，
**不會**讓整輪索引中斷：該筆不會被嵌入，該檔依 core 既有的輸入類規則處置
（媒體檔記成 `skipped(undecodable)`、不進 `failedFiles`；文字／程式碼檔記在該檔的
`failedFiles`，既有索引保留、下一輪重試）。實務上正常切塊不可能觸及這個上限
（見「批次方法」），因此這是安全網而非常態路徑。

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
  單筆輸入的 token 數硬上限就用這個值（`MAX_INPUT_TOKENS`；見「批次方法」與
  「無法解碼／處理的輸入」兩節）。
- 視覺與音訊編碼器可以選擇性載入，只用文字加圖片時不需載入音訊編碼器。

## 更換 embedder

每筆向量記錄 `embedder_id` 與 `dim`。更換 embedder 後，既有向量不可混用，
必須重新建立索引；系統需能偵測並提示。
