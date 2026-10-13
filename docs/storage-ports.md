# 儲存介面（Ports）

儲存分成兩個窄介面，各自可替換。**不要**做成單一的「通用資料庫介面」。

| 介面 | 職責 | 預設實作 | 預計的替代實作 |
|---|---|---|---|
| `MetadataStore` | roots、檔案、chunk 文字、記憶、設定、遷移 | SQLite | PostgreSQL |
| `VectorIndex` | 寫入向量、帶過濾條件的 top-k 近鄰查詢 | sqlite-vec | LanceDB、pgvector |

## 設計規則

1. **混合排序在應用層。** 每個後端只負責各自擅長的排名：
   - `MetadataStore.searchKeyword(query, filter, k)` 回傳關鍵字排名清單；
   - `VectorIndex.searchVector(vec, filter, k)` 回傳向量排名清單；
   - 由應用層用 Reciprocal Rank Fusion（RRF，`score = Σ 1 / (60 + rank)`）合併。
   如此換後端時，排序行為保持一致。
2. **每筆向量帶 `embedder_id` 與 `dim`。** 換 embedder 時能判斷哪些要重建。
3. **過濾條件至少支援 `root_id`**（權限與刪除都以 root 為單位），
   之後可擴充 `kind`、`path` 前綴。
4. **單一寫入者。** 只有核心服務行程寫入資料庫；MCP、CLI、UI 都經由本機 HTTP。
5. **契約測試。** 同一組測試套件對每個實作都要通過；新增後端就是讓它通過同一組測試。
6. **中立的匯出格式。** 提供匯出與匯入（JSON Lines 加上向量檔），用於跨後端搬遷。

## 全文檢索與中文

SQLite FTS5 預設斷詞對中文效果差；三字元的 `trigram` tokenizer 對兩字詞查詢無效。
採用哪種中文處理方式由實測決定（候選：trigram 加短查詢 LIKE 備援、二元組預處理、
`Intl.Segmenter` 斷詞後交給 `unicode61`）。這是 `MetadataStore` 的實作細節，
**不得洩漏到介面**。

## 規模參考

sqlite-vec 目前只有暴力掃描（無 ANN 索引）。以 512 維 float32 計，每筆向量約 2 KB。
資料量超過數十萬筆後，查詢延遲需實測；超過約百萬筆時應考慮有 ANN 索引的後端。
