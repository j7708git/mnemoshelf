# Mnemoshelf

> 狀態：v0.4.0（開發中，功能仍可能變動）。本版重點＝**OpenChamber／OpenCode 自動召回**（外掛在模型請求前召回相關記憶，只召回、不自動寫入）；桌面版安裝檔與版本請見 GitHub Releases。

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
  - `POST /memories`：寫入。內容在寫入前會遮蔽可辨識的機密，回應帶 `redacted`／`redactedCount`；
    相同內容（遮罩＋正規化後，同 `scope`／`project`／`agent`）不會重複新增，回 `200`＋
    `duplicate: true`，可用 `force: true` 強制新增。
  - `GET /memories`：列表（讀取時再遮一次，回應頂層 `untrusted: true`）。
  - `PATCH /memories/:id`：改 `scope`／`project`（共享開關）。
  - `POST /memories/:id/pin`：釘選；`DELETE /memories/:id`：軟刪除（帶 `?hard=true` 可真的刪除資料列）。
  - `POST /memories/search`：自然語言召回（語意優先；先過濾再排名；語意不可用時降級關鍵字並標
    `degraded`；命中帶 `untrusted: true`）。
  - `GET /memories/export`：下載 NDJSON 備份（`memories-YYYYMMDD.ndjson`）。**只含未刪除的記憶**、
    依 `createdAt` 由舊到新；內容是**遮罩後視圖**（與畫面同一組遮罩），不含向量與已刪除版本。
  - `POST /memories/import`：匯入 NDJSON 備份（原始 body，上限 32 MiB）。查詢 `dryRun=1`／`true`
    只驗證與預覽、不寫入；**整批先驗證**，任何一行不合法就回 `400` 且完全不寫。正式匯入會先遮罩、
    跳過重複內容、保留 `pinned`，但不保留 `id`／`createdAt`／`supersedes`（新 id、匯入時間）；
    向量由背景 worker 重建。
- **UI（備份）**：記憶管理面板的工具列有「匯出備份」與「匯入備份」；匯入會先選檔
  （`.ndjson`／`.jsonl`／`.txt`）跑一次 dry-run，顯示預計新增／重複／遮罩筆數與不合法行，
  使用者確認後才正式寫入。下載的備份檔由使用者保管（可能含專案內部資訊）。
- **MCP**（stdio 入口）：六個工具 `search`、`remember`、`recall`、`forget`、`list_roots`、
  `search_memories`。MCP 只轉發本機 REST，不直接開資料庫（備份匯出／匯入也**沒有** MCP 工具）。
- **自動召回（OpenChamber／OpenCode）**：`@mnemoshelf/opencode-plugin` 在每次模型請求前，用
  最新的使用者訊息查詢本機 REST（`context` hook），把相關記憶注入**當次**請求。**只召回、
  不自動寫入**：v1 不會新增、修改或刪除記憶；注入不進 session 歷史；逾時、連線失敗或索引中
  一律 fail-open（該輪不注入）。預設只查「本專案＋global」，跨專案僅能用 `/memory-all` 一次性
  查詢；`scope=agent` 的記憶不會被自動召回。連線沿用 `runtime.json` 或 `MNEMOSHELF_URL`／
  `MNEMOSHELF_TOKEN`；v1 需由使用者**手動**把外掛加進 OpenCode 設定（不自動改設定）。安裝、
  參數與疑難排解見 [docs/opencode-plugin.md](docs/opencode-plugin.md)。
- **專案範圍**：MCP 的 `remember`／`search_memories` 預設以「目前專案」為範圍；`recall` 是
  **跨專案列表**（可用 `project`／`scope` 篩選，不套用預設專案解析）。專案名稱解析順序
  （適用 `remember`／`search_memories`）為工具參數 `project` → 環境變數 `MNEMOSHELF_PROJECT` →
  MCP 行程 cwd 的資料夾名稱 → 退回全域。
  建議在 MCP client 設定 `MNEMOSHELF_PROJECT=<專案名>`，避免 cwd 不同造成專案混淆。
- **信任模型（重要）**：目前是**本機單一 owner 全權**——一組 token 就能讀寫全部記憶；
  `agent` 只是來源標記、不是身分驗證，`scope=agent` 不是安全邊界。不要把 token 分享給
  不受信任的程式；需要 per-agent 隔離時必須先擴充身分模型（尚未實作）。
  桌面版執行時可能在本機資料目錄留下含全權 token 的 `runtime.json`（連線發現，預設開啟；
  可在設定頁關閉並立即刪除）；CLI 需以 `MNEMOSHELF_AGENT_DISCOVERY=on` 明確開啟。詳見
  [docs/agent-integration.md](docs/agent-integration.md)。
- **安全防護**：記憶內容在寫入前與讀取時都會用 curated 規則遮蔽可辨識的機密（私鑰、常見
  token 前綴、JWT、`Bearer`、敏感名稱賦值、連線字串帳密）。同一組規則也用於**檔案索引**：
  文字／程式碼在切塊、嵌入前先遮罩，索引後的 chunk 不含可辨識憑證（媒體檔不套文字遮罩；
  既有索引需重跑該 root 的索引才會套用，詳見 [docs/roots-and-privacy.md](docs/roots-and-privacy.md)）。
  這是盡力而為的防護，**不是完整 DLP**，仍可能有**極少數**誤判（例如特定程式識別字）。
  **寫入時的遮罩會改寫內容（不可回復）**，請以 `POST /memories` 回應的
  `redacted`／`redactedCount` 確認是否被改寫；在意原文時請先自行檢查。
  `agent`／`project` 若含 token-like 機密會在寫入時被拒絕（`400`），既有資料的這兩個欄位在讀取時
  也會遮罩。HTTP 回應中的記憶一律視為**不受信任資料**，agent 不應把內容當成指令。
- **資料與刪除現況**：DB 是本機明文 SQLite（POSIX 上資料目錄 `700`、DB 檔 `600`）；
  `DELETE` 預設是軟刪除，帶 `?hard=true` 會真的刪除資料列（**未做取證級抹除**，WAL／檔案系統
  頁面可能仍有殘留）。加密**尚未實作**；記憶備份已提供 JSONL 匯出／匯入，但匯出是**遮罩後視圖**
  （只含未刪除的記憶、不含向量），還原的是遮罩後內容，備份檔由使用者保管、可能含專案內部資訊。
- **UI**：記憶管理面板的卡片提供「永久刪除」（二次確認；文案明示無法復原、WAL／檔案系統可能有
  殘留）。`POST /memories` 的重複提示（`duplicate: true`）是防禦性處理：目前 UI 沒有新增記憶表單，
  記憶主要由 agent 經 REST／MCP 寫入；編輯流程一律帶 `supersedes`、不套用去重。
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
| `MNEMOSHELF_INDEX_RATE` | `off`／`normal`／`low` | `off` | **索引限速**：`normal`／`low` 會在「每處理完一個檔案、換下一檔之前」休眠（`normal` 50ms、`low` 250ms）。索引總時間會變長，但同一台機器上的其他工作（UI、影片、其他程式）比較不會被索引吃滿。`off` 是現行行為（不休眠）。限速**只作用於檔案與檔案之間**，同一個大檔的嵌入批次仍會一次跑完。推論在 worker thread，健康檢查與一般 HTTP 不受影響，但**需要嵌入的請求會排隊**（見下節）。非法值會直接拒絕啟動。 |
| `MNEMOSHELF_PROJECT` | 專案名稱 | 未設定 | MCP 的 `remember`／`search_memories` 的預設專案（參數未帶 `project` 時使用）。 |
| `MNEMOSHELF_AGENT_DISCOVERY` | `on`／`off` | `off`（桌面版由設定頁控制，預設開啟） | 是否寫出 agent 連線資訊檔 `runtime.json`（含全權 token；POSIX 權限 `0600`）。CLI 需明確設 `on`；桌面版的設定頁優先於此變數，關閉開關會立即刪除檔案。非法值會直接拒絕啟動。詳見 [docs/agent-integration.md](docs/agent-integration.md)。 |
| `MNEMOSHELF_RUNTIME_FILE` | 路徑 | `<dataDir>/runtime.json` | 覆寫連線資訊檔的位置（服務寫出與外掛讀取都用這個名稱）。自訂 `MNEMOSHELF_DATA_DIR`／XDG 時，外掛不一定算得出預設路徑，請明確指定。 |

## 索引進行中與關閉

索引與 embedding 在**server 行程的 worker thread** 執行，主執行緒只做 HTTP／DB。以下是目前
版本的實際語意（不是待辦）：

- **健康檢查與一般 HTTP 可回應**：索引期間 `GET /health`、`GET /diagnostics`、
  `GET /roots/:id/index/status` 等不需要嵌入的請求可正常回應。
- **需要嵌入的請求會排隊**：worker 一次只跑一個推論。語意搜尋（`POST /search`、
  `POST /memories/search`）與記憶的背景嵌入會排在**目前批次**之後，索引期間可能等數十秒。
  要避免等待請等索引完成，或把大 root 拆成小 root 分批索引（查詢優先權列為後續工作）。
- **取消**（`POST /roots/:id/index/cancel`）：在 native 推論的**下一個邊界**生效，最長等目前
  一個檔案的嵌入批次（大檔可能數十秒），不是立即中斷。
- **限速**（`MNEMOSHELF_INDEX_RATE`）：只在**檔案與檔案之間**休眠；同一個大檔的嵌入批次不受影響。
- **關閉**：`close()` 會先**取消在途索引**（該輪可能記為 `cancelled`；已完成的檔案是逐檔交易，
  下一次索引會重做未完成的部分）並停止記憶嵌入 worker 拉新工作，然後**等目前在途的推論批次
  收尾**才返回（閒置時立即完成）。因為 ONNX Runtime 的 native 推論不可中斷，關閉不會硬殺正在
  推論的 worker（那會讓行程以 `Napi::Error` abort／SIGABRT 結束）；代價是索引中關閉最壞多等
  **目前一個嵌入批次**（實測 1 檔 7 chunks 約 14 秒、2 檔 15 chunks 在第一次檔案批次收尾約
  18 秒；批次時間依切塊與內容而定，大檔可能數十秒）。
  **`close()` 回傳後再結束行程（含 `process.exit`）是安全的**：此時 worker 已閒置並安全
  terminate，不會 SIGABRT；若 `close()` 還沒回傳就被作業系統強制砍掉，不在保證內。若推論超過
  120 秒仍未收尾（worker 卡死），關閉會記錄並完成，但此時結束行程不保證安全（理論邊界）。
  要**即時**關閉（<1 秒）需要把 embedder 隔離到子行程，列為 S2。重啟同一資料目錄後可正常再索引。

**明示 `coreml` 的提醒**：設定 `MNEMOSHELF_EMBED_DEVICE=coreml` 表示「**忽略已快取的決定、
強制嘗試 CoreML**」（不自我測試、也不寫回快取），由使用者自負後果。macOS 的 CoreML EP
目前對這種量化模型沒有實測過的加速證據，且上游仍有未修的當機風險
（onnxruntime 的 CoreML EP＋外部資料檔以檔案路徑載入曾造成 SIGBUS）；要驗證請以
`MNEMOSHELF_EMBED_DEVICE=coreml` 單獨跑一次，**不要**當成日常設定。

## 授權

尚未決定。
