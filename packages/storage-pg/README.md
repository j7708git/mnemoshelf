# @mnemoshelf/storage-pg

以 **PostgreSQL ＋ pgvector** 實作 `@mnemoshelf/core` 的兩個窄 port：

- `PgMetadataStore` → `MetadataStore`（roots、chunk 文字、記憶、遷移）
- `PgVectorIndex` → `VectorIndex`（寫入向量、帶過濾的 top-k 近鄰查詢）

這是 Mnemoshelf 的**第二個儲存後端**（預設是 SQLite）。它不修改 core 的任何程式碼或公開
契約，而是讓同一組契約測試（`@mnemoshelf/core/testing` 的 `runMetadataStoreContract`、
`runVectorIndexContract`）在 PostgreSQL 上通過，藉此驗證 `docs/storage-ports.md` 的
「儲存可替換」抽象。選型與實測依據見 `project-notes` 的
`research/postgres-pgvector-backend.md`。

## 需求

- Node 22 以上、pnpm。
- PostgreSQL 13 以上，且 **pgvector ≥ 0.8.0**（`hnsw.iterative_scan` 從 0.8.0 起；
  帶 `rootIds` 過濾的查詢需要它）。開發／測試用的 image 見下方「測試」。
- 建立擴充需要資料庫層權限：`migrate()` 會執行 `CREATE EXTENSION IF NOT EXISTS vector`；
  若產品端連線角色沒有這個權限，請由管理者事先在目標資料庫安裝 `vector` 擴充。

## 用法

```ts
import { Pool } from "pg";
import { PgMetadataStore, PgVectorIndex } from "@mnemoshelf/storage-pg";

const pool = new Pool({ connectionString: process.env.MNEMOSHELF_PG_URL });

const store = new PgMetadataStore(pool);        // 預設 schema：public
await store.migrate();                          // 冪等：可重複呼叫

const index = new PgVectorIndex(pool, { dim: 512 });
await index.migrate();                          // 建立擴充＋向量表＋HNSW 索引
```

- 兩個類別共用同一個 `Pool`。`schema` 選項可把資料表放進指定 schema（契約測試即以此隔離）；
  識別字會先驗證再以雙引號包裹，不會拼接未經驗證的字串。
- 維度由 `PgVectorIndex` 的 `dim` 決定（預設 512，對應 core 的 `DEFAULT_DIM`），
  並寫死進 `vector(N)` 型別；寫入／查詢的向量長度不符時拋 `VectorDimensionError`。
- 連線池由呼叫端擁有與關閉；本套件不讀環境變數，也不管理服務設定。

## 實作要點

### 1. 測試 image 鎖定

契約測試用 **`pgvector/pgvector:0.8.7-pg18-bookworm`**（完全鎖定的 tag，不用浮動的 `pg18`），
以 testcontainers 起 throwaway 容器。此 tag 對應 PostgreSQL 18 ＋ pgvector 0.8.7。
testcontainers 的 PostgreSQL 模組**不會**自動帶 pgvector，因此必須明確指定此 image，
並在 `migrate()` 內 `CREATE EXTENSION IF NOT EXISTS vector`。

### 2. `hnsw.iterative_scan` 與 `max_scan_tuples` 上限語意

向量表用 **HNSW（`vector_cosine_ops`）**，可在空表建立（migrate 友善）。但 pgvector 的
**近似索引是先掃描、後過濾**：若查詢帶 `root_id = ANY(...)` 過濾，預設 `ef_search=40` 下
`LIMIT 10` 可能只回 7 列（實測），直接違反契約「過濾在 KNN 之內生效」。

因此 `searchVector` **每次查詢前**都在同一個交易內執行：

```sql
set local hnsw.iterative_scan = strict_order;
```

`strict_order` 保證結果依距離精確排序並回滿。`SET LOCAL` 只在交易內、且只影響該連線；
`withTransaction` 固定同一條連線並在歸還池前結束交易，設定不會殘留到其他查詢。

**代價（上限語意）**：iterative scan 仍受 `hnsw.max_scan_tuples`（預設 **20000**）限制——
它限制掃描的候選列數。若某個 root 的向量在整體排名中非常稀疏、候選超過上限仍不足 k 筆，
查詢就會回不滿 k 列。需要時調大 `hnsw.max_scan_tuples`（與 `hnsw.scan_mem_multiplier`）。
這是 PostgreSQL 後端相對 SQLite（vec0 partition key 精確過濾）在極端選擇性下的已知落差。

### 3. tie 排序：`seq` ＋ 覆寫＝delete＋insert

pgvector 對「距離相同時」的順序**沒有保證**。`VectorIndex` 契約有一條要求：同一個 key
被覆寫後，在並列距離中要排在後面（對應 sqlite-vec 的 rowid＝插入序行為）。

做法：向量表有 `seq bigint generated always as identity`（單調遞增序），`upsert` 以
**delete＋insert** 實作（不是 `ON CONFLICT DO UPDATE`），因此被覆寫的 key 取得更大的 `seq`；
查詢 `ORDER BY embedding <=> $vec, seq` 即可重現「重寫入者排後面」。

### 4. 中文全文檢索：應用層斷詞 ＋ `tsvector('simple')` ＋ GIN

PostgreSQL 內建 parser 對連續中文視為**單一 token**（`to_tsvector('simple','儲存介面與向量搜尋')`
只產生一個 lexeme），不做斷詞就完全搜不到中文。因此沿用 core SQLite 後端的「方案 S」：

- 寫入時對 chunk 文字／記憶內容以 `Intl.Segmenter('zh-Hant', { granularity: 'word' })`
  斷詞，結果以空白連接存入 `seg` 欄位；`tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', seg)) STORED`
  ＋ GIN 索引自動同步（`seg` 為 NULL 時 `tsv` 為 NULL，GIN 自然忽略，對應圖片 chunk 不進 FTS）。
- 查詢端用**同一個** `segmentText` 斷詞，各 token 以 `plainto_tsquery('simple', $n)` 參數綁定，
  再用 `tsquery || tsquery`（OR）組合。`plainto_tsquery` 預設是 AND，契約語意是 OR，因此必須自行組合。
- 不用 `zhparser`／`pg_jieba`／`pg_trgm`：沒有同時內含 pgvector 且維護良好的現成 image；
  `pg_trgm` 對 2 字中文查詢會退化成全表掃描。詳見研究筆記。
- 排名用 `ts_rank`（越大越前），與 SQLite 的 `bm25`（越小越前）方向相反；同分以 key 字典序決勝，
  兩後端可重現。

## 已知差異與限制

- `searchVector` 的 `k` 上限夾在 `MAX_SEARCH_K`（4096，與 SQLite 的 `MAX_KNN_K` 同值）。
- `count()` 對 `count(*)`（`int8`，`pg` 會回字串）顯式 `Number()`；`id` 一律用 `int4`。
- 時間欄位用 `text` ISO 字串（字典序＝時間序），不用 `timestamptz`（`pg` 會回 `Date`）。
- 刻意**不建** chunks→roots 外鍵：`removeRoot(deleteData=false)` 會刪 root 列卻保留 chunks。
- 目前 server／MCP 層尚未接上此後端（本套件只提供 port 實作與契約測試）。

## 測試

契約測試由環境變數閘控，確保沒有 Docker 的環境 `pnpm test` 仍全綠：

```bash
# 不設變數：PG 契約測試以可見訊息 skip，不啟動容器、不連網
pnpm test

# 啟用：testcontainers 自動起容器，image 用鎖定的 tag（首跑會下載，數百 MB）
MNEMOSHELF_PG=1 pnpm --filter @mnemoshelf/storage-pg test
```

每個測試用一個全新 schema（`create schema "t_<uuid>"`）取得獨立實例，容器測後由 testcontainers
自動清理。容器只綁本機，不使用雲端資料庫。

## 相依

- 執行期：`pg` 8.23.1（MIT）——**不需要** `pgvector` npm 套件，因為本 port 從不讀回向量，
  寫入只要 `$n::vector` 佔位符 ＋ `'[1,2,...]'` 字面值。
- 開發／測試：`@types/pg` 8.23.1（MIT）、`@testcontainers/postgresql` 12.2.1（MIT）。
