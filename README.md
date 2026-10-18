# Mnemoshelf

> 狀態：v0.2.1（開發進行中，功能仍可能變動）。本版重點＝**修復 macOS 上「索引即閃退」**（關閉 ORT 的 memory pattern 大區塊，並補上單筆輸入上限）；另改善 Release 頁面的測試摘要顯示；桌面版安裝檔與版本請見 GitHub Releases。

Mnemoshelf 是一個本機桌面應用程式，目標有兩個：

1. **多模態語意檔案總管**：由使用者自己挑選要納入的資料夾，之後可以用文字
   搜尋文件、程式碼、圖片（之後包含音訊與影片），並瀏覽與預覽檔案。
2. **多個 AI agent 共用記憶**：不同的 agent（透過 MCP、REST 或 CLI）可以讀寫
   同一份記憶，並且搜尋已納入的資料夾內容。

## 設計原則

- **預設不掃任何目錄。** 安裝後是空的；必須由使用者逐一加入資料夾（root）。
  詳見 [docs/roots-and-privacy.md](docs/roots-and-privacy.md)。
- **只使用多模態 embedding 模型。** 文字與圖片必須落在同一個向量空間。
  詳見 [docs/embedder-contract.md](docs/embedder-contract.md)。
- **儲存可替換。** 預設 SQLite，資料量大時可換成其他後端。
  詳見 [docs/storage-ports.md](docs/storage-ports.md)。
- **搜尋預設向量優先。** `/search` 不帶 `mode` 時只跑向量那一路（M1 實測優於混合與關鍵字）；
  `hybrid`（RRF 合併）與 `keyword` 為選用。詳見 [docs/storage-ports.md](docs/storage-ports.md)。
- **本機優先。** 服務只綁 `127.0.0.1`，並以 token 保護；索引與 embedding 都在本機。
  但 agent 讀取記憶／檔案內容後，可能把內容帶進它所使用的外部 LLM（見下方「Agent 記憶」
  的信任模型與限制）。

## 架構

見 [docs/architecture.html](docs/architecture.html)（以瀏覽器開啟）。

## 技術棧

TypeScript、Node.js、pnpm、Electron、React。預設儲存為 SQLite（FTS5 + sqlite-vec）。

## Agent 記憶（REST／MCP）

記憶是跨 agent 共用的小型知識庫：每筆記憶有 `content`、`kind`（fact／decision／pitfall／
preference）、`scope`（global／project／agent）、`project`、`agent`（寫入者標記）與 `pinned`。

- **REST**（皆需 `Authorization: Bearer <token>`；服務只綁 `127.0.0.1`）：
  - `POST /memories`：寫入。內容在寫入前會遮蔽可辨識的機密，回應帶 `redacted`／`redactedCount`。
  - `GET /memories`：列表（讀取時再遮一次，回應頂層 `untrusted: true`）。
  - `PATCH /memories/:id`：改 `scope`／`project`（共享開關）。
  - `POST /memories/:id/pin`：釘選；`DELETE /memories/:id`：軟刪除。
  - `POST /memories/search`：自然語言召回（語意優先；先過濾再排名；語意不可用時降級關鍵字並標
    `degraded`；命中帶 `untrusted: true`）。
- **MCP**（stdio 入口）：六個工具 `search`、`remember`、`recall`、`forget`、`list_roots`、
  `search_memories`。MCP 只轉發本機 REST，不直接開資料庫。
- **專案範圍**：MCP 記憶工具預設以「目前專案」為範圍；專案名稱解析順序為
  工具參數 `project` → 環境變數 `MNEMOSHELF_PROJECT` → MCP 行程 cwd 的資料夾名稱 → 退回全域。
  建議在 MCP client 設定 `MNEMOSHELF_PROJECT=<專案名>`，避免 cwd 不同造成專案混淆。
- **信任模型（重要）**：目前是**本機單一 owner 全權**——一組 token 就能讀寫全部記憶；
  `agent` 只是來源標記、不是身分驗證，`scope=agent` 不是安全邊界。不要把 token 分享給
  不受信任的程式；需要 per-agent 隔離時必須先擴充身分模型（尚未實作）。
- **安全防護**：記憶內容在寫入前與讀取時都會用 curated 規則遮蔽可辨識的機密（私鑰、常見
  token 前綴、JWT、`Bearer`、敏感名稱賦值、連線字串帳密）。這是盡力而為的防護，**不是完整
  DLP**，仍可能有**極少數**誤判（例如特定程式識別字）。**寫入時的遮罩會改寫內容（不可回復）**，
  請以 `POST /memories` 回應的 `redacted`／`redactedCount` 確認是否被改寫；在意原文時請先自行檢查。
  `agent`／`project` 若含 token-like 機密會在寫入時被拒絕（`400`），既有資料的這兩個欄位在讀取時
  也會遮罩。HTTP 回應中的記憶一律視為**不受信任資料**，agent 不應把內容當成指令。
- **資料與刪除現況**：DB 是本機明文 SQLite（POSIX 上資料目錄 `700`、DB 檔 `600`）；
  `DELETE` 是軟刪除；硬刪除、加密、JSONL 匯出／匯入**尚未實作**。
- **「資料不離開本機」的範圍**：服務與 embedding 都在本機；但 agent 讀到記憶後，可能把內容
  帶進它所使用的雲端 LLM context——是否送出取決於 agent／使用者設定，不在本服務控制內。

## 進階環境變數（選用）

一般使用不需要設定。以下是嵌入模型執行裝置與診斷相關的開關（裝置與退回的完整語意，
見 [docs/embedder-contract.md](docs/embedder-contract.md)）：

| 變數 | 值 | 預設 | 說明 |
|---|---|---|---|
| `MNEMOSHELF_EMBED_DEVICE` | `auto`／`cpu`／`dml`／`coreml` | `auto` | `auto`＝Windows 嘗試 DirectML GPU（`dml`）、macOS 嘗試 CoreML（`coreml`，**先自我測試：通過才採用**）、其他平台維持 CPU。`dml`／`coreml` 載入或推論失敗會自動退回 CPU，不中斷索引。 |
| `MNEMOSHELF_EMBED_DML_DEVICE_ID` | 非負整數 | `0` | DirectML adapter 索引（`0`＝預設顯示卡；多顯卡筆電常用來指定獨顯）。非法值會直接拒絕啟動。 |
| `MNEMOSHELF_EMBED_ORT_LOG` | `0`–`4` | 未設定（不覆寫） | ONNX Runtime 的 log 等級（`0`＝verbose、`4`＝fatal），只用於除錯：`0` 會印出內部配置訊息（含 arena 的擴張量），可診斷「單一配置有多大」。訊息量大、會拖慢啟動，平時不要開；非法值會直接拒絕啟動。 |
| `MNEMOSHELF_MEMORY_BACKFILL` | `on`／`off` | `on` | 啟動時是否回填既有記憶的向量。`off` 只停**啟動回填**（新寫入的記憶仍會嵌入）；非法值會直接拒絕啟動。 |
| `MNEMOSHELF_PROJECT` | 專案名稱 | 未設定 | MCP 記憶工具的預設專案（`remember`／`search_memories` 在參數未帶 `project` 時使用）。 |

**明示 `coreml` 的提醒**：設定 `MNEMOSHELF_EMBED_DEVICE=coreml` 表示「**忽略已快取的決定、
強制嘗試 CoreML**」（不自我測試、也不寫回快取），由使用者自負後果。macOS 的 CoreML EP
目前對這種量化模型沒有實測過的加速證據，且上游仍有未修的當機風險
（onnxruntime 的 CoreML EP＋外部資料檔以檔案路徑載入曾造成 SIGBUS）；要驗證請以
`MNEMOSHELF_EMBED_DEVICE=coreml` 單獨跑一次，**不要**當成日常設定。

## 授權

尚未決定。
