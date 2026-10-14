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
  /** 查詢文字（會套用查詢 prefix）。 */
  embedQuery(text: string): Promise<Float32Array>;
  /** 文件文字；title 沒有時用 "none"（會套用文件 prefix）。 */
  embedDocument(text: string, title?: string): Promise<Float32Array>;
  /** 文件文字批次；輸出與 inputs 一一對應且順序相同（見下節）。 */
  embedDocuments(inputs: readonly DocumentInput[], opts?: EmbedDocumentsOptions): Promise<Float32Array[]>;
  /** 圖片。輸入為已解碼的像素或檔案位元組，由實作決定，但必須明確定義。 */
  embedImage(image: ImageInput): Promise<Float32Array>;
  /** 啟動探測，見下節。 */
  probe(): Promise<ProbeResult>;
  dispose(): Promise<void>;
}
```

所有回傳的向量：長度為 `info.dim`、**已 L2 正規化**（模長 1，容差 1e-3）。

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

**批次上限**：一次 forward 的視窗上限由實作決定（預設 embedder 為 16，常數
`MAX_BATCH_SIZE`）。批次會把同批文字 pad 到同批最長序列，過大的批次會讓 pad 成本與
記憶體上升，因此需要上限；超過上限的輸入應由實作**內部切成多個視窗**後串接回傳，
呼叫端不需自行分批。

## 啟動探測（probe）

註冊 embedder 後、建立任何索引前，必須先通過探測；未通過就拒絕啟用，
避免用壞掉的模型建出整個無效的索引。

探測內容：嵌入至少兩張內容明顯不同的測試圖與數句描述文字，檢查：

1. 向量維度等於 `info.dim`，且沒有 `NaN` 或 `Infinity`。
2. 向量已正規化。
3. 每張圖與「描述它的文字」的相似度，高於與「描述另一張圖的文字」的相似度
   （有明確差距，差距門檻由實測決定並寫進實作）。

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
