# 儲存介面（Ports）

儲存分成兩個窄介面，各自可替換。**不要**做成單一的「通用資料庫介面」。

> **修訂紀錄**：2026-10-14（M2）修訂「搜尋排序」——`/search` 預設由 `hybrid`（RRF 合併）改為
> `vector`（向量優先），`hybrid` 與 `keyword` 保留為選用；並新增 §搜尋模式與預設、§PostgreSQL 後端。
> 舊語意以註記保留在 §設計規則 1，方便讀舊文件的人。
>
> 2026-10-14（M3）新增 §記憶的釘選：`Memory.pinned` 欄位與 `MetadataStore.setMemoryPinned`
> 方法（兩後端皆實作、通過同一組契約測試）；`listMemories` 的排序語意不變。

| 介面 | 職責 | 預設實作 | 預計的替代實作 |
|---|---|---|---|
| `MetadataStore` | roots、檔案、chunk 文字、記憶、設定、遷移 | SQLite | PostgreSQL |
| `VectorIndex` | 寫入向量、帶過濾條件的 top-k 近鄰查詢 | sqlite-vec | LanceDB、pgvector |

## 設計規則

1. **排序在應用層；預設只跑向量那一路，混合為選用。** 每個後端只負責各自擅長的排名：
   - `MetadataStore.searchKeyword(query, filter, k)` 回傳關鍵字排名清單；
   - `VectorIndex.searchVector(vec, filter, k)` 回傳向量排名清單；
   - 由應用層的 `mode` 決定跑哪幾路：預設 `vector`（只跑向量）、`keyword`（只跑關鍵字）、
     `hybrid`（兩路都用 Reciprocal Rank Fusion（RRF，`score = Σ 1 / (60 + rank)`）合併）。
   如此換後端時，排序行為保持一致。

   > **2026-10-14（M2）修訂：搜尋預設由 `hybrid`（RRF）改為 `vector`。**
   > 原文為「**混合排序在應用層**……由應用層用 RRF 合併」，並以 `hybrid` 為 `/search` 預設。
   > 依 M1 整體驗收的三模式複測（見 §搜尋模式與預設），向量單獨優於混合與關鍵字；
   > RRF 實作與 `hybrid`／`keyword` 模式**保留不刪**，只是降為選用（明確帶 `mode` 仍可用）。
2. **每筆向量帶 `embedder_id` 與 `dim`。** 換 embedder 時能判斷哪些要重建。
3. **過濾條件至少支援 `root_id`**（權限與刪除都以 root 為單位），
   之後可擴充 `kind`、`path` 前綴。
4. **單一寫入者。** 只有核心服務行程寫入資料庫；MCP、CLI、UI 都經由本機 HTTP。
5. **契約測試。** 同一組測試套件對每個實作都要通過；新增後端就是讓它通過同一組測試。
6. **中立的匯出格式。** 提供匯出與匯入（JSON Lines 加上向量檔），用於跨後端搬遷。

## 搜尋模式與預設（M2 修訂）

`/search`（REST）與 MCP 的 `search` 工具支援三種 `mode`：

| `mode` | 跑哪幾路 | 排序 | 記憶是否納入 |
|---|---|---|---|
| `vector`（**預設**） | `VectorIndex.searchVector` | 後端回傳的向量名次 | 否（`remember` 不嵌入內容） |
| `keyword` | `MetadataStore.searchKeyword` | 後端回傳的關鍵字名次 | 是 |
| `hybrid` | 兩路 | 應用層 RRF（`score = Σ 1 / (60 + rank)`）合併 | 是 |

**為什麼預設改為 `vector`（M1 實測）**：M1 整體驗收以 8 個自然語句查詢對三模式複測，Top-1 為相關結果的
次數為 **`vector` 8/8 ＞ `hybrid` 7/8 ＞ `keyword` 5/8**。關鍵反例：以中文查詢找圖時，`hybrid` 的
keyword 路把 vector 路原本正確的命中壓了下去（RRF 讓兩路等權，關鍵字路的雜訊拉低正確結果的名次）。

**樣本限制（重要）**：只有 8 個查詢、且「相關」是 tester 自評，**不是嚴謹的檢索評測**；查詢集與語料都小。
此修訂是依現有最佳證據做的方向性決定，未來有更大的查詢集時應複測。

**`hybrid` 與 `keyword` 保留不刪**：兩者仍是正式模式，明確帶 `mode` 即照舊可用；RRF 實作保留在應用層
（見 §設計規則 1）。需要固定行為的呼叫端請一律明確帶 `mode`。**記憶只進 keyword 那一路**，因此預設
`vector` 不含記憶命中；要搜尋記憶請帶 `mode: "keyword"` 或 `"hybrid"`。

## 記憶的釘選（M3 擴充）

管理面的標記：`Memory.pinned: boolean`（型別見 `ports/types.ts`）。既有資料與新增的記憶一律
預設 `false`；`NewMemory` 刻意**不含** `pinned`，要釘選請用下列方法。

| 方法 | 語意 |
|---|---|
| `MetadataStore.setMemoryPinned(id, pinned)` | 設定／取消釘選，**冪等** |

- **不存在的 id 是無操作**（不拋錯），與 `forgetMemory` 的既有風格一致；需要回 404 的
  呼叫端（REST）請先 `getMemory` 判斷存在與否。
- `pinned` **不影響** `listMemories` 的排序（仍是 `createdAt` 由新到舊、同毫秒以 `id` 決勝）；
  「釘選優先」的排序由呼叫端（UI）自行處理，後端契約因此不必變動既有排序語意。
- `getMemory` 與 `listMemories` 回傳的 `Memory` 都帶正確的 `pinned`。

**兩個後端的實作**：

- **SQLite（預設）**：欄位 `memories.pinned integer not null default 0`；以版本化遷移
  `0002_memory_pinned` 補欄位（先查 `pragma table_info` 再 `alter table add column`，維持冪等），
  既有資料庫的既有資料自動為 `0`。
- **PostgreSQL**：欄位 `pinned boolean not null default false`；`migrate()` 除了 `create table`，
  另以 `alter table … add column if not exists pinned …` 補既有資料庫的欄位（冪等）。

契約測試（`@mnemoshelf/core/testing` 的 `runMetadataStoreContract`）新增兩例：釘選／取消
（含冪等，且 `getMemory` 與 `listMemories` 都反映），以及不存在 id 的無操作。SQLite 與
PostgreSQL 兩個後端都必須通過同一組測試。

## 全文檢索與中文

SQLite FTS5 預設斷詞對中文效果差；三字元的 `trigram` tokenizer 對兩字詞查詢無效。
採用哪種中文處理方式由實測決定（候選：trigram 加短查詢 LIKE 備援、二元組預處理、
`Intl.Segmenter` 斷詞後交給 `unicode61`）。這是 `MetadataStore` 的實作細節，
**不得洩漏到介面**。PostgreSQL 後端的中文檢索路線與 trigram 退化行為見 §PostgreSQL 後端。

## PostgreSQL 後端

`MetadataStore` 與 `VectorIndex` 的第二個實作（`@mnemoshelf/storage-pg`，PostgreSQL ＋ pgvector）。
**行為細節與實測依據以 `packages/storage-pg/README.md` 為準**；本節只記契約層要點。

- **同一組契約測試**：兩個 port 都讓 `@mnemoshelf/core/testing` 的 `runMetadataStoreContract`、
  `runVectorIndexContract` 通過；換後端不動 core，也不改本文件的介面。
- **需求**：PostgreSQL 13 以上、**pgvector ≥ 0.8.0**（帶 `rootIds` 過濾的 KNN 需要
  `hnsw.iterative_scan`，0.8.0 起提供）。
- **向量索引**：HNSW（`vector_cosine_ops`），可在空表建立（`migrate()` 冪等、不必等資料）。
- **過濾與 iterative scan**：pgvector 的近似索引是**先掃描、後過濾**；帶 `rootIds` 的查詢若不開
  iterative scan，預設 `ef_search=40` 下 `LIMIT 10` 可能只回 7 列（實測），直接違反「過濾在 KNN
  之內生效」的契約。因此每個查詢前在**同一交易內**執行 `SET LOCAL hnsw.iterative_scan = strict_order`。
- **上限語意（`max_scan_tuples`）**：iterative scan 仍受 `hnsw.max_scan_tuples`（預設 **20000**）
  限制——它限制掃描的候選列數。若某個 root 的向量在整體排名中非常稀疏、候選超過上限仍不足 k 筆，
  查詢就會**回不滿 k 列**。需要時調大 `hnsw.max_scan_tuples`（與 `hnsw.scan_mem_multiplier`）。
  這是 PostgreSQL 後端相對 SQLite（vec0 partition key 精確過濾）在極端選擇性下的已知落差。
- **中文全文檢索**：沿用 SQLite 端的「應用層 `Intl.Segmenter` 斷詞」路線——寫入時存斷詞後文字，
  PostgreSQL 端用 generated `tsvector('simple', …)` ＋ GIN。兩後端因此共用同一套斷詞程式碼，
  中英文 FTS 行為一致。

### 與 SQLite 的差異摘要

| 面向 | SQLite（預設） | PostgreSQL（pgvector） |
|---|---|---|
| 向量索引 | sqlite-vec 暴力掃描（無 ANN） | HNSW 近似索引（＋ iterative scan） |
| 過濾語意 | vec0 partition key，精確過濾 | index scan 後才過濾，靠 iterative scan 補足；仍受 `max_scan_tuples` 上限 |
| 關鍵字排名方向 | `bm25()`（越小越前） | `ts_rank`（越大越前）——adapter 統一方向 |
| trigram 退化行為 | FTS5 `trigram` 對 <3 字元查詢**回 0 命中** | `pg_trgm` 對 2 字中文**結果正確但退化成全表掃描**（無索引加速） |
| tie 排序 | rowid＝插入序（覆寫＝delete＋insert） | 無保證；adapter 以單調 `seq` ＋ `ORDER BY distance, seq` 重現 |
| 中文處理 | 應用層斷詞（方案 S） | 同一套應用層斷詞 ＋ `tsvector('simple')` ＋ GIN |

**`trigram` 的失效方式不同**：SQLite FTS5 `trigram` 對 2 字查詢回 0 命中；pg_trgm ＋ `LIKE` 對 2 字
中文結果仍正確、只是用不到索引。兩者的「失效方式」不同，因此**不能直接照搬 SQLite 的 `LIKE` 備援設計**
到 PostgreSQL 端。

## 規模參考

sqlite-vec 目前只有暴力掃描（無 ANN 索引）。以 512 維 float32 計，每筆向量約 2 KB。
資料量超過數十萬筆後，查詢延遲需實測；超過約百萬筆時應考慮有 ANN 索引的後端。
