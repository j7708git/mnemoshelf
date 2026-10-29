# Roots 與隱私契約

## 核心規則：預設不掃任何目錄

安裝後沒有任何 root。使用者必須逐一加入資料夾，之後系統才會讀取或索引它。
沒有「全機掃描」功能。

## Root 的設定

每個 root 有：

| 欄位 | 說明 |
|---|---|
| `path` | 使用者選的目錄（儲存時解析為真實路徑） |
| `mode` | `browse`（只瀏覽，不建索引）或 `index`（瀏覽並建立語意索引） |
| `modalities` | 要索引的類型，預設只有 `text` 與 `code`；`image`、`audio`、`video` 需手動開啟 |
| `include` / `exclude` | 包含與排除規則（glob） |
| `respectGitignore` | 預設 `true` |
| `watch` | 持續監看變更，或手動重建 |
| `agentAccess` | 哪些 agent 可以搜尋這個 root（**尚未實作**；目前所有持有 token 的程式都可搜尋，見 §信任模型） |

## 改變模態（`PATCH /roots/:id`）

root 加入後要更改可索引的模態（例如之後才想含圖片）不必移除重建：`PATCH /roots/:id` 以
`{ "modalities": [...] }` 更新，成功回 `200`＋更新後的 root；缺少 `modalities` 或值非法
（非字串、非已知模態名）→ `400` 且不更動資料，未知的 root → `404`。

這是**寫入端點，但只寫 Mnemoshelf 自己的資料庫**：它只改這個 root 的設定，**不讀、不寫、
不刪使用者磁碟上的任何檔案**。

- **改模態不會自動重新索引，需使用者手動重跑該 root 的索引才會生效**
  （`POST /roots/:id/index`）。關掉某個模態也**不會立刻**釋放既有的 chunk／向量，同樣要重跑
  索引才由清理迴圈清掉——與「排除規則改動需重新索引」是同一套語意。
- **圖片模態的隱私語意**：開啟 `image` 只是允許該 root 的圖片被讀取與索引；圖片以**本機**
  的 embedding 模型解碼與嵌入，**不會上傳**到任何服務。這與核心原則一致——資料不離開本機，
  除非使用者明確選用雲端 embedding（見 README 的設計原則）。路徑安全、黑名單與系統／垃圾檔
  排除照常套用，不因開啟圖片模態而放寬。

## 加入時先乾跑預覽

root 記錄建立後、索引開始前先做一次乾跑（dry run），回報：

- 將納入的檔案數量、總大小、各類型分佈；
- 預估索引時間；
- 將被跳過的檔案與原因（排除規則、黑名單、系統／垃圾檔、過大等）。**預覽不會因為檔案含機密
  而跳過**：索引階段會對文字／程式碼套用遮罩（見 §機密遮罩），原檔案仍會被納入、只讀不寫。

使用者確認後才開始索引。索引可取消，也可限速，避免占滿 CPU。
  <!-- 2026-10-19 更新：`POST /roots/:id/index/cancel` 已實作；限速 `MNEMOSHELF_INDEX_RATE=off|normal|low`
       也已實作（`normal` 50ms、`low` 250ms，`off` 為預設），只作用於「檔案與檔案之間」，
       同一個大檔的嵌入批次仍一次跑完。預設值與完整行為以 `docs/operations.md` 與
       `packages/server/src/config.ts` 為準。 -->

## 路徑安全（所有檔案存取都要通過）

1. **realpath 驗證**：把請求的路徑解析成真實路徑（跟隨 symlink），
   結果必須落在某個已加入的 root 內；否則拒絕。這擋住 `../` 與指向 root 外的 symlink。
2. **黑名單**：即使位於使用者選的 root 內，也一律不索引、不回傳：
   - 設定與金鑰目錄：`.ssh`、`.gnupg`、`.password-store`、`.aws`、`.kube` 等；
   - 瀏覽器設定檔與憑證存放區；
   - `.env`、`.env.*`（`.env.example` 除外）、`*.pem`、`*.key`、`id_rsa*`、`*.p12`、`*.kdbx`。
3. **過寬的 root 要警告或拒絕**：根目錄、家目錄本身。要求使用者改選更具體的子目錄。
4. **機密遮罩**：**記憶**與**檔案索引（文字／程式碼）**都已套用 curated 遮罩（見 §機密遮罩）；
   檔案索引在切塊、嵌入、入庫之前遮罩，媒體檔不套文字遮罩。仍是 curated 規則、**不是完整 DLP**，
   極少數程式內容可能被誤遮。
5. **唯讀**：第一版對使用者檔案只讀不寫。

## 系統／垃圾檔排除

除了上面的黑名單（處理**機密**，跳過原因 `blocked`），另外有兩道「不索引系統與垃圾檔」
的防線——它們處理的是沒有檢索價值的檔案，把這類內容當文字嵌入只會讓搜尋出現亂碼。
兩道防線都**只讀不寫**：命中時使用者磁碟上的檔案原封不動，只是不被讀取、不被索引。

1. **檔名／副檔名層（掃描階段，`walkRoot`，跳過原因 `unsupported-type`）**：
   - macOS：`.DS_Store`、`.localized`、`._*`（AppleDouble 中繼資料）、
     `.Spotlight-V100`、`.Trashes`；
   - Windows：`Thumbs.db`、`desktop.ini`；
   - 未完成的下載：`*.crdownload`、`*.part`、`*.partial`、`*.download`。
   這一層**不讀內容**，因此預覽（dry run）與索引看到的結果一致。
2. **內容層（索引階段，`processFile`，跳過原因 `binary-content`）**：
   副檔名看似文字／程式碼的檔案，讀入後檢查**前 8 KB**；出現 NUL 位元組，或不可印字元
   （控制字元、UTF-8 解碼失敗的替代字元）比例超過 10%，即視為二進位，不切塊、不嵌入。
   未知副檔名一律預設為文字，這一層是接住「還沒列進清單的新格式」的最後一道網。

命中的檔案既有的 chunk 與向量會被清除——與其他跳過原因一致：**被跳過就不得保留索引**
（見下方「加入時先乾跑預覽」的跳過原因回報）。

> **既有索引需重新索引才會清除舊資料。** 排除規則只影響之後的索引；先前被誤判為文字而
> 嵌入的 `.DS_Store` 等內容，會在該 root **下一次重新索引**時被清掉。要讓搜尋不再出現
> 這些亂碼，請對受影響的 root 重跑一次索引。

## App 讀取的 harness 設定（只讀，2026-10-29）

「連接 Agent」頁為了顯示每個 harness「缺什麼、怎麼補」，只讀下列**使用者層**設定，不碰其他
使用者檔案。

- **讀什麼**：
  - OpenCode／OpenChamber：`~/.config/opencode/opencode.jsonc`、
    `~/.config/opencode/opencode.json`，以及 `~/.config/opencode/plugins/` 下每個項目
    （最多 50 個；目錄讀它的 `package.json`，單一檔案**只讀路徑、不讀內容**）。
  - codex：`~/.codex/config.toml`、`~/.codex/hooks.json`。
  - dsh：`<DSH_HOME>/profiles/*/package.json`（`DSH_HOME` 未設定時為 `~/.dsh`；最多 50 個
    profile）。
- **Windows 也一樣**：OpenCode／OpenChamber 的使用者層設定在
  `%USERPROFILE%\.config\opencode\`，**不是** `%APPDATA%\opencode\`。
- **為什麼讀**：只為了顯示「這個 harness 缺什麼、怎麼補」（外掛、MCP server、hook 的狀態），
  沒有其他用途。
- **不讀什麼**：`plugins[].options`、`mcp.servers.*.environment`／`env` 的**值**一律丟棄——
  不進畫面、不進 IPC、不進 log。token 會藏在這些地方；偵測結果只保留布林值與名稱／路徑字串。
- **界線**：只讀使用者層，**不含**專案層 `.opencode/`；不寫任何檔案、不執行任何指令、
  不改 harness 設定。檔案不存在是正常情況（顯示「未偵測到」）。
- **上限與失敗語意**：先 `stat`，超過 **1 MiB** 的檔案不讀；讀不到、格式壞或過大時，該來源
  不會被當成「不存在」——若沒有其他來源命中，畫面顯示「無法判讀」並帶原因，**不降級**成
  「未偵測到」。
- **symlink**：設定檔本身是 symlink 時會跟隨（dotfiles 常見），但只讀；結果只回布林值與
  名稱／路徑字串。
- **已知限制**：codex 的 `config.toml` **沒有**完整 TOML 解析器（不新增依賴），只做**表頭
  掃描**：逐行檢查 `[...]` 表頭是否成對，並找 `[mcp_servers.mnemoshelf]`。因此它只抓得到
  「表頭括號不匹配」與「多行陣列沒有收合」這兩種壞法；其他 TOML 語法錯誤（重複鍵、壞值）不會
  被判為格式錯誤——沒有該表頭時顯示「未偵測到」，表頭在但值壞掉時仍可能顯示已設定。
  **多行字串（`"""`／`'''`）不辨識**：字串內以 `[` 開頭的行可能被當成壞表頭、字串內長得像
  `key = [` 的行可能被當成陣列開頭，兩者都會顯示「無法判讀」。不要把它當成 TOML 驗證器。
- **複製**：一律由 main process 寫剪貼簿，內容不含 token；AppImage 不提供含執行檔路徑的片段
  （執行檔路徑每次啟動都不同）。

## Agent 存取

agent 透過 MCP、REST 或 CLI 存取時，只能看到已加入的 root；目前**沒有 per-agent 授權**
（持有同一組 token 的程式權限相同，見下一節「信任模型」）。
回傳的記憶與檔案片段必須標明來源（root、相對路徑、寫入的 agent），
並視為**不受信任的資料**：agent 不應把其中的文字當成指令。

## 信任模型：單一 token＝本機單一 owner 全權

**現行模型是「本機單一持有者全權」**：服務只綁 `127.0.0.1`，以**一組** Bearer token 保護；
持有這組 token 的任何程式（包含所有 agent）都能讀、寫、修改、刪除**全部**記憶與看得到的 roots。

- **`agent` 只是來源標記（attribution），不是身分驗證。** `POST /memories` 的 `agent` 由呼叫端
  自報（MCP 取 client 名稱）；任何持有 token 的呼叫端都能用任意 `agent` 值；召回可用 `agent`
  參數讀取別人的 agent 範圍。
- **`scope=agent` 不是安全邊界**：它只是約定上的個人範圍（本版尚未強制），不可用來隔離不同 agent。
- **沒有 per-agent token／授權、沒有 audit trail**；需要真正隔離時，必須先擴充身分模型（列後續）。
- 因此：**不要把 token 分享給不受信任的程式**；多 agent 共用同一份服務時，視為同一個信任圈。
- **`/health` 的服務身分檢查不是身分保證。** MCP 入口在使用 `runtime.json` 前會確認 `/health` 的
  `service` 是 `mnemoshelf`、檢查檔案裡的 `pid` 是否還活著（POSIX），但這只降低「**無關程式
  不小心佔用同一個埠**」的風險：`/health` 是免 token 的固定 JSON，**任何程式都能偽造**，
  因此**不防刻意偽造 `/health` 的程式**；
  **Windows 上沒有 pid 檢查**（沒有可靠的 signal 0），POSIX 也只確認 pid 活著、不確認它是
  Mnemoshelf。這些檢查**不能**保證 token 不會被送到錯的程式。
- **共用機器的多人情境請不要開啟連線資訊檔功能**（或改用獨立帳號／獨立資料目錄）：同一個
  作業系統帳號的程式都能讀取檔案內的 token，也能改寫 `url`。要真正隔離需要 challenge-HMAC
  或 owner／ACL 等機制（列後續）。

## 機密遮罩（實作語意）

記憶內容在**寫入前**與**讀取時**、以及檔案索引的文字／程式碼在**切塊前**，都會套用同一組 curated
遮罩（實作在 `packages/core/src/privacy/secret-masking.ts`；server 端 `src/secret-masking.ts`
只是轉出 shim，公開 API 不變）：

- 規則涵蓋：PEM 私鑰區塊、常見 token 前綴（`sk-`、GitHub `ghp_`／`github_pat_`、Slack `xox?-`、
  AWS `AKIA…`、Google `AIza…`）、JWT、`Bearer <token>`、敏感名稱的賦值（`api_key`／`secret`／
  `token`／`password` 等）、連線字串中的帳密。
- 命中片段替換成穩定的 `[REDACTED:<kind>]`；**不記錄原文、不整筆拒絕**。`POST /memories` 的回應
  另帶 `redacted`／`redactedCount`（additive 欄位；`Memory` 公開型別不變）。
- **不做全面熵遮罩**：常見的 commit SHA、UUID 不會被誤遮；但 curated 規則仍可能對**極少數**
  程式識別字誤判（例如特定長度的 dotted 名稱或套件名稱）。**寫入時的遮罩會改寫內容**（不可回復），
  請以 `POST /memories` 回應的 `redacted`／`redactedCount` 確認是否被改寫；若在意原文，請先自行
  檢查或不要把憑證寫進記憶。
- **metadata 也受保護**：`agent`／`project` 在寫入時若偵測到 token-like 機密會直接 `400`
  （它們是查詢鍵，不能在寫入時改寫）；既有資料的 `agent`／`project` 在讀取回應中會套同一組遮罩。
- 讀取路徑（`GET /memories`、`POST /memories/search`、`POST /search` 的記憶命中、MCP）會再遮一次，
  因此**既有 DB 的未遮罩舊資料**也不會原文外流；遮罩是 idempotent。
- **檔案索引路徑**：文字／程式碼檔案在**切塊、嵌入、寫入 DB 之前**套用同一組遮罩，索引後的 chunk
  文字只有 `[REDACTED:<kind>]`、不含可辨識憑證；送進 embedder 的 `title`（相對路徑檔名）也先
  套同一組遮罩；使用者磁碟上的檔案**只讀不寫**（原文不變）。
  - 檔案級 `contentHash` 以**遮罩後內容**計算：既有未遮罩的索引會在下一次索引自動重做；
    只改到會被遮罩的區段（遮罩後內容相同）不會重嵌；遮罩規則改進也會自動觸發重做。
  - `POST /roots/:id/index` 的回應（`IndexRootResult`）新增 additive `maskedFiles`：只計「內容」
    至少遮一處的檔案（媒體檔、跳過與未變更的檔案不計）。**title-only 遮罩不計入**：既有索引
    若內容未變會跳過，title 的遮罩只對本輪重新嵌入的檔案生效。
  - 媒體檔（`image`／`audio`／`video`）**不套**文字遮罩，仍以原始位元組嵌入；`contentHash` 仍為
    原始位元組的 sha256。
  - **既有索引需重跑該 root 的索引才會套用**；未重跑前，舊 chunk 仍可能含未遮罩內容
    （本版不自動清除舊索引，避免升級即全庫重嵌）。對受影響的 root 重跑一次索引即可。
- **限制（誠實標示）**：這是 curated、盡力而為的防護，**不是完整 DLP**；無法保證所有憑證格式
  都會命中。檔案索引只遮文字／程式碼，媒體檔不套文字遮罩；遮罩只在「文字」層，at-rest 仍是
  明文 SQLite（見下）。另外，**底線前綴的程式識別字可能被誤遮**（例如
  `some_token = refreshTokenValue` 這種寫法會被當成敏感賦值而遮掉值）；**多行賦值**（值在
  下一行）不遮。

## 資料存放與刪除（現況）

- 資料庫（含記憶原文）以**明文**存在本機資料目錄；POSIX 上啟動時會把資料目錄收緊為 `700`、
  DB 檔（含 WAL／SHM）為 `600`（best-effort；Windows 不套用）。
- `DELETE /memories/:id` 預設是**軟刪除**（設定 `deleted_at`）：內容仍留在 DB／WAL，可能可被復原。
  帶 `?hard=true`（或 `hard=1`）則是**硬刪除**：資料列（含 FTS；向量同列欄位）真的刪除，
  API／查詢不再可見；可刪已軟刪除者。但**不做取證級抹除**（SQLite WAL／檔案系統頁面可能仍有
  殘留、at-rest 仍為明文）、也沒有加密（列後續）。
- **JSONL 備份（已實作）**：`GET /memories/export`／`POST /memories/import` 只涵蓋**記憶**，
  不含 chunk／向量與已刪除的歷史版本；匯入後向量由背景 worker 重建。匯出是**遮罩後視圖**
  （與畫面同一組機密遮罩、只含未刪除的記憶），還原的是遮罩後內容而不是原文。
  備份檔案由**使用者自行保管**（下載位置、分享對象、保存期限都取決於使用者），內容可能包含
  專案內部資訊，請比照記憶本身的敏感度處理；不要把備份檔留在共用目錄或提交進版本控制。
- 關閉注意（**取消索引、等一個推論批次、安全結束**）：服務關閉時會先**取消在途索引**（該輪
  可能記為 `cancelled`；已完成的檔案是逐檔交易，下一次索引會重做未完成的部分）並停止記憶嵌入
  worker 拉新工作，然後**等目前在途的推論批次收尾**才返回（閒置時立即完成）。ONNX Runtime 的
  native 推論不可中斷，關閉不會硬殺正在推論的 worker（那會讓行程以 `Napi::Error` abort／
  SIGABRT 結束）；代價是索引中關閉最壞多等**目前一個嵌入批次**（實測 1 檔 7 chunks 約 14 秒、
  2 檔 15 chunks 在第一次檔案批次收尾約 18 秒；批次時間依切塊與內容而定，大檔可能數十秒）。
  **`close()` 回傳後再結束行程（含 `process.exit`）是安全的**；若 `close()` 尚未回傳就被作業
  系統強制砍掉，不在保證內。若推論超過 120 秒仍未收尾（worker 卡死），關閉會記錄並完成，但
  此時結束行程不保證安全（理論邊界）。要**即時**關閉（<1 秒）需把 embedder 隔離到子行程
  （S2）。同一資料目錄重啟後可正常再索引。

## 記憶的範圍與共享（2026-10-18）

記憶以 `scope` 與 `project` 兩個欄位表達範圍，語意如下：

| `scope` | 可見範圍 | 本版狀態 |
|---|---|---|
| `global` | 所有專案可見（全域共享） | 已實作；可由 UI 或 REST 明確切換 |
| `project` | 只屬於同一個 `project` 名稱的專案 | 已實作寫入、標記與召回範圍過濾（見下方「召回」） |
| `agent` | 寫入者 agent 的個人範圍 | **約定，尚未強制**；可用 `PATCH /memories/:id` 設定，召回需明確提供 agent 才納入 |

- **新記憶的預設**：MCP 的 `remember` 以「目前專案」為預設，解析優先序為
  工具參數 `project` → 環境變數 `MNEMOSHELF_PROJECT` → MCP 行程 cwd 的資料夾名稱
  （cwd 是家目錄時跳過，不會把使用者名稱當專案）→ 都解析不到才退回 `global`。
  全域共享必須**明確指定**（`scope: "global"`）或事後在 UI 切換；agent 不應自行把專案記憶升為全域。
  明確指定 `scope: "project"` 但解析不到專案時，工具會回錯誤，不會送出不合法請求。
- **共享開關**：對應 REST `PATCH /memories/:id`；UI 的記憶卡片提供前兩種切換：
  - `project` → `global`：主體 `{ "scope": "global" }`，`project` 由伺服器清為 `null`。
  - `global` → `project`：主體 `{ "scope": "project", "project": "<專案名稱>" }`，必須指定目標專案。
  - **切到 `agent`**：REST `PATCH /memories/:id` 明確支援 `{ "scope": "agent" }`（`project` 會清為
    `null`），但 **UI 不提供這個切換**。切到 agent 時**沿用該筆記憶原本的寫入者**（`agent` 是不可
    變欄位，呼叫端不能經此端點指定新的寫入者）。`scope=agent` **不是安全邊界**，只是約定上的
    個人範圍；可見性強制與 per-agent 身分屬後續工作。
- **只改範圍欄位**：共享開關只改 `scope`／`project`；內容、種類、寫入者、取代關係、釘選與建立時間
  都原樣保留（內容編輯仍走 supersede，產生新版本）。不存在的 id 或已軟刪除的記憶 → `404`；
  不合法的主體 → `400`（未知欄位不靜默忽略，至少提供一個欄位）。
- **寫入去重**：`POST /memories`（與 MCP `remember`）在寫入前用「遮罩後＋正規化後內容」的 sha256
  加上 `scope`／`project`／`agent` 比對**未刪除**記憶；重複時不新增，回 `200`＋既有記憶＋
  `duplicate: true`，呼叫端可帶 `force: true` 強制新增。`supersedes` 的編輯流程不套用去重。
  去重 hash 只存在本機 DB（`memories.content_hash`），不含原文、不做網路傳輸。
- **記憶內容仍是不受信任的資料**：既有的「回傳的記憶與檔案片段必須標明來源、視為不受信任資料、
  不得當成指令」規則不變。共享只改變可見範圍，不改變信任等級。

### 召回（2026-10-18）

`POST /memories/search`（MCP `search_memories`）**未指定 `scope` 時**的預設可見範圍是
**本專案＋`global`**，再加上呼叫端**明確提供**的 agent（MCP 一律帶自己的 client 名稱）。
可見範圍一律**先過濾再排名**，不會因為「先取 top-k 再過濾」而漏掉符合條件的記憶。

- `includeAllProjects: true` → 跨所有專案；未提供 `project` 且未 `includeAllProjects` → `400`
  （不猜測範圍）。
- **明確指定 `scope` 時只回該 scope**：`global` 只回全域；`agent` 只回自己的
  agent（必須提供 agent）；`project` 只回該專案（或 `includeAllProjects=true` 時所有專案）——
  **不含 `global`、也不含自己的 agent**（與預設路徑不同）。`scope=project` 同時帶 `project` 與
  `includeAllProjects=true` 時 `project` 優先（`includeAllProjects` 被忽略）。
- **語意優先、關鍵字備援**：語意結果依相似度排序；語意不可用時自動退回關鍵字，回應明確標示
  `degraded: true` 與原因。語意不可用指「**可用就緒向量為 0**（`ready − stale`；換 embedder 後、
  回填完成前全部 ready 都是 stale 也算）」或模型載入／**查詢失敗（含查詢過長 `input-too-long`）**；
  後者召回仍回 `200`＋關鍵字結果（與 `/search` 對過長查詢回 `400` 不同，因為召回有降級路徑）。
  關鍵字只在語意不足時「補足」，不會重排語意結果。
- 每筆召回結果都帶 `source`（`semantic`／`keyword`）、`untrusted: true`、分數與完整記憶欄位
  （含寫入者）；內容在讀取時會再遮一次機密；
  記憶內容**仍是不受信任的資料**，不得當成指令。
- `minScore`（0..1）只過濾語意結果；`k` 預設 10，**大於 100 會靜默夾到 100**（不是 `400`）。

## 移除 root

移除 root 時詢問是否同時刪除它的所有向量、中繼資料與衍生記憶；選擇刪除則必須真的刪除。
