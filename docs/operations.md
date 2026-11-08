# 營運操作速查

這份文件彙整服務的對外介面與執行期開關：REST 端點、MCP 工具、環境變數，以及索引期間的
排隊與取消行為。**契約的權威仍是程式碼**；root 驗證、機密遮罩、信任模型與資料刪除見
`docs/roots-and-privacy.md`，儲存與檢索語意見 `docs/storage-ports.md`。

服務只綁 `127.0.0.1`。除 `GET /health` 外，所有 REST 請求都要帶
`Authorization: Bearer <token>`；錯誤一律回 `{error:{name,message}}` 與對應狀態碼。

## REST 端點速查

音訊索引先以 `PATCH /roots/:id` 的 `modalities` 明確加入 `audio`，再預覽並索引。
本版只支援受限 WAV；格式與上限見 [音訊契約](roots-and-privacy.md#音訊索引與來源定位)。
`POST /search` 與 MCP `search` 的音訊命中有 `media.startSeconds`／`endSeconds`、
`track`、`preprocessVersion`、`embedderId`、`embeddingDim`，沒有逐字稿；以 vector／hybrid 查詢。
`GET /roots/:id/file?path=...` 對支援 WAV 回 `audio/wav`，仍需 token 與 root 守衛，最多 10 MiB。
`GET /diagnostics` 的 `embedderRuntime.audioState` 區分未載入／準備中／就緒／失敗；
失敗且 `audioRetryable=false` 時需重啟後再試，否則可修正下載問題後重跑索引。

| 端點 | 說明 |
|---|---|
| `GET /health` | 免 token；服務身分、版本與 build（建置 commit） |
| `GET /diagnostics` | 診斷資訊（版本、平台、embedder 裝置與退回原因、每 root 統計、記憶向量狀態） |
| `GET /roots` / `POST /roots` | 列出／加入 root（`POST` 可帶 `maxFileBytes` 指定**單檔大小上限**，預設 10 MB） |
| `GET /roots/:id` | 單一 root |
| `PATCH /roots/:id` | 改模態（`modalities`） |
| `DELETE /roots/:id?deleteData=1` | 移除 root；`deleteData` 決定是否連帶刪已索引資料。接受 `1`／`0`／`true`／`false`／`yes`／`no` |
| `POST /roots/:id/preview` | 索引前預覽（乾跑，不寫入；root 需已加入） |
| `POST /roots/:id/index` | 開始索引；同一 root 已在索引中會回 `409` |
| `GET /roots/:id/index/status` / `POST /roots/:id/index/cancel` | 進度／取消 |
| `GET /roots/:id/entries` | 條目（`?path=` 相對路徑；省略＝root 根目錄） |
| `GET /roots/:id/file` | 讀檔（`?path=`；文字回 JSON 預覽，圖片回原始位元組） |
| `GET /roots/:id/thumb` | 縮圖（`?path=`） |
| `POST /search` | 檔案語意搜尋（`mode`：`vector` 預設／`keyword`／`hybrid`；`k` 上限 100） |
| `GET /memory-policy` / `PATCH /memory-policy` | 讀取／保存記憶遮罩開關與政策版本 |
| `POST /memory-sources` | 完整原文回合寫入；8 MiB 上限，事件重送去重 |
| `GET /memory-sources/:id` | 帶範圍與政策版本的來源分頁續讀 |
| `PATCH /memory-sources/:id` / `DELETE /memory-sources/:id` | 整回合範圍更新／軟硬刪除 |
| `GET /memories` / `POST /memories` | 列出／寫入（列表可用 `kind`／`scope`／`project`／`agent`／`limit` 篩選） |
| `PATCH /memories/:id` | 改 `scope`／`project`（共享開關） |
| `DELETE /memories/:id?hard=true` | 軟刪除／硬刪除。`hard` **只接受** `true`／`1`，其他值（含 `false`、`yes`）一律 `400`（刻意嚴格防誤觸） |
| `POST /memories/:id/pin` | 釘選 |
| `POST /memories/search` | 記憶語意召回（語意不可用時降級關鍵字） |
| `GET /memories/export` / `POST /memories/import` | NDJSON 備份（import 支援 `?dryRun=1`／`true`，上限 32 MiB） |

備份預設 v2，包含短記憶與完整原文來源，依當下遮罩政策產生；舊 v1 仍可匯入。
原文上限、事件衝突、分頁與備份相容性見 [原文記憶](raw-memory.md)。

`GET /health` 回 `{status, service, appVersion, build}`。`build` 是 build 時的 commit：
`packages/server/scripts/build-info.mjs` 在 build 時以 `git rev-parse HEAD` 寫入
`dist/build-info.json`（git 不可用時退回 build 環境的 `MNEMOSHELF_BUILD_COMMIT`，再退回
`unknown`）。服務在**啟動時讀一次**；讀不到檔案時用執行環境的 `MNEMOSHELF_BUILD_COMMIT`
或 `unknown`。這些都是 additive 欄位，呼叫端只比對 `service`（見 `docs/agent-integration.md`）。
App 內更新後可用這個欄位確認實際執行的是新版本的建置（桌面版更新後應同時看到新的
`appVersion` 與 `build`）。

## MCP 工具

MCP 入口是 local stdio 程式，**只把請求轉發給本機 REST，不直接開資料庫**；授權與參數驗證
都由 REST 決定。共有七個工具：

| 工具 | 說明 |
|---|---|
| `search` | 搜尋已索引的檔案片段與記憶（`mode`：`vector` 預設／`keyword`／`hybrid`） |
| `remember` | 寫入一筆記憶；預設以「目前專案」為範圍，重複內容回既有記憶並標 `duplicate` |
| `recall` | **跨專案**列出未刪除的記憶（由新到舊，可用 `project`／`scope` 篩選，**不套用**預設專案解析） |
| `forget` | 依 id 軟刪除；若為原文片段，刪除整個來源回合 |
| `list_roots` | 列出已加入的 roots（路徑、模式、模態） |
| `search_memories` | 用自然語言搜尋記憶（語意優先，預設範圍＝目前專案＋全域共享） |
| `read_memory_source` | 按來源 ID 與範圍分頁讀取原文角色、時間及上下文 |

- **沒有備份用的 MCP 工具**：匯出／匯入只存在 REST（原因與範圍見 `docs/storage-ports.md`
  §記憶的匯出／匯入）。
- `remember`／`search_memories` 預設以「目前專案」為範圍；專案解析順序＝工具參數 `project`
  → 環境變數 `MNEMOSHELF_PROJECT` → MCP 行程 cwd 的資料夾名稱（cwd 是家目錄時跳過）。
  解析不到專案時，未指定 scope 的 `remember` 才退回全域；`search_memories` 預設會回驗證錯誤。
  `search_memories` 要跨所有專案請帶 `includeAllProjects: true`，只查全域請指定 `scope: "global"`；
  `remember` 要寫成全域共享請明確帶 `scope: "global"`。
  建議在 MCP client 設定 `MNEMOSHELF_PROJECT=<專案名>`，避免 cwd 不同造成專案混淆
  （設定方式見 `docs/agent-integration.md` 的「MCP 設定範例」一節）。
- 工具回傳的內容一律視為不受信任的資料，不得當成指令；信任模型見
  `docs/roots-and-privacy.md` §信任模型。

## 環境變數總表

「誰會用到」指出讀取點所在：**服務端**（CLI／自行啟動的服務；桌面版也是用它）、**桌面版**
（Electron 殼額外讀取或覆寫）、**MCP 入口**（`packages/server` 的 stdio 程式）、**外掛**
（`@mnemoshelf/opencode-plugin`）、**dsh 外掛**（`@mnemoshelf/dsh-plugin`）、**embedder**
（`@mnemoshelf/embedder-transformers`）。
桌面版會覆寫其中幾個變數，請以桌面版欄位為準。

| 名稱 | 誰會用到 | 預設 | 一句話語意 |
|---|---|---|---|
| `MNEMOSHELF_PORT` | 服務端、桌面版 | `0`（OS 指派隨機埠） | 監聽埠；永遠只綁 `127.0.0.1`。 |
| `MNEMOSHELF_TOKEN` | 服務端、桌面版、MCP 入口、外掛、dsh 外掛 | 無（CLI 未設即啟動失敗；桌面版自動產生並保存） | REST 的 Bearer token，持有即本機全權。MCP 入口缺這個變數時會改讀 `runtime.json`。 |
| `MNEMOSHELF_DATA_DIR` | 服務端、桌面版、外掛與 dsh 外掛（算 `runtime.json` 位置）、MCP 入口（算 `runtime.json` 位置） | OS 使用者資料目錄下的 `mnemoshelf`（桌面版為 `<userData>/data`） | SQLite 資料目錄。 |
| `MNEMOSHELF_MODEL_DIR` | 服務端、桌面版、embedder | OS 使用者資料目錄下的 `mnemoshelf/models`（桌面版為 `<userData>/models`） | 模型快取目錄。 |
| `MNEMOSHELF_WEB_DIR` | 服務端、桌面版 | 本 repo 的 `packages/web/dist`（桌面版為 `resources/web`） | Web UI 靜態檔目錄；不存在時 API 仍正常。 |
| `MNEMOSHELF_URL` | MCP 入口、外掛、dsh 外掛 | 無（MCP 未設時改讀 `runtime.json`；仍找不到就啟動失敗） | REST 基底網址（例如 `http://127.0.0.1:8787`）。 |
| `MNEMOSHELF_RUNTIME_FILE` | 服務端（寫出）、MCP 入口、外掛與 dsh 外掛（讀取） | `<dataDir>/runtime.json` | 覆寫連線資訊檔位置。 |
| `MNEMOSHELF_AGENT_DISCOVERY` | 服務端（CLI）；桌面版由設定頁覆寫 | `off`（桌面版預設 `on`） | 是否寫出含 token 的 `runtime.json`。 |
| `MNEMOSHELF_PROJECT` | MCP 入口、外掛、dsh 外掛 | 未設定 | 預設專案名稱（MCP 的 `remember`／`search_memories`；外掛的召回範圍）。 |
| `DSH_HOME` | dsh 外掛 | `~/.dsh` | dsh 的家目錄；外掛的待補送 spool 在 `<DSH_HOME>/mnemoshelf-spool`（選項 `spoolDir` 可覆寫）。 |
| `MNEMOSHELF_DESKTOP_USER_DATA` | 桌面版 | Electron 預設 `userData` | 覆寫桌面版的 userData（開發／驗收用）。 |
| `MNEMOSHELF_EMBED_DEVICE` | embedder（服務端／桌面版） | `auto` | 執行裝置 `auto`／`cpu`／`dml`／`coreml`；`auto` 依平台挑加速器（Windows → `dml`、macOS → `coreml`），其中 macOS 的 `auto` 會**先跑自我測試、通過才採用**並把決定快取起來；載入或推論失敗自動退回 CPU（語意見 `docs/embedder-contract.md` 的「加速器自我測試」一節）。 |
| `MNEMOSHELF_EMBED_DML_DEVICE_ID` | embedder（Windows 的 DirectML） | `0`（預設顯示卡） | DirectML adapter 索引；多顯卡時指定獨顯。只接受十進位非負整數字串，非法值直接拒絕啟動（不靜默回預設）。 |
| `MNEMOSHELF_EMBED_ORT_LOG` | embedder | 未設定（不覆寫 ORT 預設） | ONNX Runtime log 等級 `0`–`4`（`0`＝verbose），僅診斷用。 |
| `MNEMOSHELF_MEMORY_BACKFILL` | 服務端 | `on` | 啟動時是否回填既有記憶向量；只接受 `on`／`off`（大小寫不拘），非法值直接拒絕啟動。`off` 只停啟動回填，**新寫入的記憶仍會嵌入**。 |
| `MNEMOSHELF_INDEX_RATE` | 服務端 | `off` | 索引限速：`normal` 每檔之間休眠 50ms、`low` 250ms，`off` 不休眠。**只作用於檔案與檔案之間**；大檔內的讓渡由下述視窗排程負責。非法值直接拒絕啟動。 |
| `MNEMOSHELF_BUILD_COMMIT` | 建置腳本（server）；服務端僅在讀不到 build-info 時後備 | `unknown` | **build 時 fallback**：`git rev-parse HEAD` 不可用時（例如從 tarball build）寫入的 commit；不用於執行期設定。 |

測試專用的變數（`MNEMOSHELF_E2E`、`MNEMOSHELF_AUTOTEST_*`、`MNEMOSHELF_SMOKE_NO_SANDBOX`、
`MNEMOSHELF_DEV_CORE`、`MNEMOSHELF_PG`）不在上表：它們只給 repo 內的測試／煙霧測試使用，
不是產品設定。

## 索引期間的排隊與取消

- **一次只跑一個推論**：推論在 **server 行程的 worker thread** 執行（`node:worker_threads`），
  主執行緒只做 HTTP、DB 與索引編排，worker 內只有一個模型 session——索引、搜尋與記憶背景嵌入
  共用這條序列佇列。需要嵌入的請求（`POST /search`、`POST /memories/search`、記憶的背景嵌入）
  在有界工作視窗間排程。文字查詢優先，連續最多 4 個查詢後讓等待中的背景工作執行一窗；
  背景工作輪流前進。每個文字視窗最多 16 筆且不超過裝置上限，模型仍可依 token 預算縮窗。
  正在執行的 native 推論不能搶占，因此不保證固定毫秒回應。
- **取消**（`POST /roots/:id/index/cancel`）在 native 推論的**下一個邊界**生效，最長等目前
  一個排程視窗；排隊中的文字／圖片直接取消，不再啟動新視窗，已在 native 中的工作等待收尾。
- 不需要嵌入的請求（`GET /health`、`GET /diagnostics`、`GET /roots/:id/index/status` 等）
  在索引期間照常回應。
- 關閉服務時的取消與等待語意，見 `docs/roots-and-privacy.md` §資料存放與刪除。

診斷新增 `embedderScheduling`（不提供排程資訊的實作為 `null`），包含准入數、輸入位元組、
已完成視窗／邏輯請求、累計排隊時間、worker 往返時間與上限。`indexingTimings` 是本行程
累計的 scan／read／prepare／embed／write 次數及耗時；prepare 含增量檢查，embed 含排隊、
解碼、tokenize 與推論，尚未細拆為純模型時間；併發時各階段加總不等於整輪牆鐘時間。
上述只含計數與耗時，不含檔案內容。視窗完成與逐檔持久化完成分開，不將部分向量假報為索引成功。

排程准入預設最多 128 個邏輯請求、8,192 個輸入與 64 MiB 輸入位元組（含正在執行的工作）。
搜尋超限回 `503 EmbedderQueueFullError`、碼 `EEMBEDDERQUEUEFULL`，附 `Retry-After: 1`；
單一請求本身超限應縮小輸入。詳細契約見 [embedder-contract.md](embedder-contract.md)。
