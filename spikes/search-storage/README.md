# Spike：M1 預設儲存（SQLite 驅動 × sqlite-vec × 中文 FTS × 混合排序 × 規模）

這個 spike 回答 Mnemoshelf M1 預設儲存的三件事：

1. Node 用哪個 SQLite 驅動載入 `sqlite-vec`（`better-sqlite3` 或內建 `node:sqlite`）；
2. **中文全文檢索**要採哪種做法（trigram／二元組／`Intl.Segmenter` 斷詞）；
3. `sqlite-vec` 在 1 萬～100 萬筆規模的查詢延遲、`root_id` 過濾寫法、量化效果，
   以及混合排序（RRF）是否比單一路徑好。

量測結果與逐題結論的完整研究紀錄為內部文件，不隨本 repo 公開；本目錄只保留可重跑的
量測程式，以及 `results/` 下的原始數字。
這裡的程式碼是一次性驗證用的 spike：可醜，但**必須可重跑**。

## 環境需求

- Node.js ≥ 22（實測 v22.23.2）、pnpm 10（實測 10.34.5）。
- 建置 `better-sqlite3` 需要 C++ 工具鏈（node-gyp）；實測在本機以原始碼編譯成功。
- **`eval` 需要一台本機 embedding 服務**：OpenAI 相容 `POST /v1/embeddings`，
  預設 `http://127.0.0.1:8181`（可用 `EMB_URL` 覆寫）。本 spike **只讀呼叫、不修改、
  不重啟**該服務。`drivers`／`scale`／`wal` **不需要**它。
- 語料目錄由環境變數 `CORPUS_DIR` 傳入（**程式碼中不硬寫任何本機路徑**）。
  語料只在本機讀取分析，**不會**被複製進本 repo；結果檔只存聚合數字。

## 安裝與重跑

```bash
cd mnemoshelf/spikes/search-storage
pnpm install

# Q1：驅動與擴充載入、FTS5/trigram 可用性
pnpm run drivers

# Q2/Q3：中文檢索評測（需要 CORPUS_DIR 與 :8181）
CORPUS_DIR=<你的語料目錄> pnpm run eval   # 例如含 *.md 的任何本機目錄

# Q4/Q5/Q6：規模、root_id 過濾、量化（不需要 :8181）
pnpm run scale

# Q7：WAL 一寫多讀（不需要 :8181）
pnpm run wal
```

`pnpm run eval` 會把向量快取在 `mnemoshelf/.tmp/search-storage/eval-embed-cache.json`，
第二次之後同一組文字不必重新嵌入（要強制重跑加 `-- --refresh`）。

### 環境變數與參數

| 變數／參數 | 預設 | 說明 |
|---|---|---|
| `CORPUS_DIR` | （必填） | 語料目錄（遞迴找 `*.md`） |
| `EMB_URL` | `http://127.0.0.1:8181` | embedding 服務位址 |
| `eval --max-pairs=N` | 300 | 評測對數量（等距抽樣） |
| `eval --limit-docs=N` | 0（全部） | 只嵌入前 N 塊，用於快速煙霧測試 |
| `eval --refresh` | 關 | 忽略向量快取 |
| `scale --sizes=...` | `10000,100000,500000,1000000` | 規模測試的筆數清單 |
| `scale --driver=...` | `better-sqlite3` | `better-sqlite3` 或 `node:sqlite` |
| `scale --latency-runs=N` | 50 | 每規模的 KNN 查詢次數（計 p50/p95） |
| `scale --filter-size=N` | 100000 | `root_id` 過濾測試的規模 |
| `scale --out=<檔名>` | `scale.json` | 結果輸出檔（寫在 `results/`），避免煙霧測試覆蓋正式結果 |
| `scale --skip-quant` | 關 | 跳過量化測試 |

## 各腳本量什麼

| 腳本 | 內容 |
|---|---|
| `scripts/drivers.mjs` | 兩驅動開記憶體 DB、載入 `sqlite-vec`、記錄 `sqlite_version()`／`vec_version()`／實際安裝版本；建 `unicode61` 與 `trigram` FTS5 表並用 2 字／4 字查詢探測；測 `node:sqlite` 的 `allowExtension` 時機 |
| `scripts/eval.mjs` | 語料依 `#` 標題切塊（≤1200 字元）→ 查詢 = 標題、目標 = 該塊內文 → T（trigram）／B（二元組）／S（Segmenter）三 FTS、sqlite-vec 向量（`title: none` 與 `title: {t}` 兩版）、RRF 混合（k=60）→ 各查詢長度組的 Recall@5／Recall@10／MRR |
| `scripts/scale.mjs` | 固定種子隨機單位向量（512 維）建 1 萬／10 萬／50 萬／100 萬筆：寫入時間、檔案大小、top-10 KNN 延遲（p50/p95）；`root_id` 過濾三寫法（metadata column／partition key／KNN 大 k + 應用層過濾）的延遲與精確度；binary／int8 量化的大小、延遲與 recall@10 |
| `scripts/wal.mjs` | 起一個持續寫入的子行程（寫一般表與 `vec0` 表），同時用另一個唯讀子行程查詢；驗證 WAL 下一寫多讀、無 `SQLITE_BUSY`、快照隔離 |

## 輸出

- `results/*.json`（進版控）：完整數字，供 PM 複核。內容僅有聚合數字、版本資訊與
  合成測試字串，**不含語料原文、不含本機絕對路徑**（路徑經 `lib/paths.mjs` 的 `sanitize()` 處理）。
- `mnemoshelf/.tmp/search-storage/**`（不進版控）：測試資料庫、向量快取、log。
- 冷快取的 `eval` 很慢（實測約 81 分鐘，`:8181` 為 CPU 序列推論）；
  `scale` 全規模約 10 分鐘。

## 注意

- 本 spike 只寫 `spikes/search-storage/**` 與 `mnemoshelf/.tmp/**`，不碰產品程式碼
  （不建立 `mnemoshelf/packages/**`）。
- 向量只用於**量測文字檢索**；產品真正的多模態 embedder 由另一張任務卡驗證。
- 所有路徑以 `node:path` 處理，不假設 Linux。
