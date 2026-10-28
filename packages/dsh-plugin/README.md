# `@mnemoshelf/dsh-plugin`

Mnemoshelf 的 [dsh](https://www.npmjs.com/package/@deepseek-ai/dsh) 外掛（v1）：

- **回合前自動召回**：在 `agent/pre-step` 用本次使用者輸入查 `POST /memories/search`，把相關記憶
  包成 `<memory-context source="mnemoshelf" trust="untrusted" form="recall">` 追加成一則
  `user/message`。
- **回合後自動寫入**：在 `turn/end` 取本回合最後一則使用者文字與助理回覆，剝除注入塊／附件／
  system-reminder 後，寫一張**抽取式、確定性**的回合卡（`agent: "dsh/turn"`）。
- **fail-open 與 spool**：服務不可用時不影響 dsh 回合；寫入先進
  `~/.dsh/mnemoshelf-spool/`，服務恢復後補送。

契約來源：`docs/agent-integration.md`；dsh API 行為見 T2 spike 筆記
（`research/2026-10-28-dsh-plugin-api.md`）。

## 需求

- Node.js 22.14 以上（與 repo 其他套件一致）。
- dsh `0.2.1-rc.2`（manifest 的 `engines.dsh` 是 `^0.2.1-rc.2`）。
- 一個執行中的 Mnemoshelf 服務，且已開啟 agent discovery（`runtime.json`），
  或自行提供 `MNEMOSHELF_URL`／`MNEMOSHELF_TOKEN`。

外掛只需要 Node 內建的 `fetch`／`fs`／`crypto`，沒有執行期第三方依賴。

## 建置

```sh
pnpm --filter @mnemoshelf/dsh-plugin build
pnpm --filter @mnemoshelf/dsh-plugin typecheck
pnpm --filter @mnemoshelf/dsh-plugin test
```

`build` 產出 `dist/`；`dsh` 載入的是 `dist/index.js`，改完程式碼要重新 build。

## 安裝

本套件是 **bundle**：`package.json` 有 `dsh.bundle.patch`，套件根目錄的
`cordis.patch.yml` 會插入自己的 plugin row。因此**不要**在 profile 的
`cordis.patch.yml` 再寫一次，否則會重複掛載。

以下以 `web` profile 為例；其他 profile 把名稱換掉即可。

### 1. 備份 profile 設定

```sh
cp ~/.dsh/profiles/web/package.json \
   ~/.dsh/profiles/web/package.json.bak-mnemoshelf-2026-10-28
cp ~/.dsh/profiles/web/cordis.patch.yml \
   ~/.dsh/profiles/web/cordis.patch.yml.bak-mnemoshelf-2026-10-28
```

### 2. 加入 dependency 與 bundle

編輯 `~/.dsh/profiles/web/package.json`：

```json
{
  "dependencies": {
    "@mnemoshelf/dsh-plugin": "link:<repo>/packages/dsh-plugin"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "...既有 bundles 原樣保留...",
        "@mnemoshelf/dsh-plugin"
      ]
    }
  }
}
```

- `link:` 的值用**絕對路徑**（或相對於 profile 目錄的路徑）。`dsh plugin add` 會用
  **呼叫時的 cwd** 解析相對路徑，這點很容易踩坑；手動編輯 manifest 再用
  `dsh plugin --profile web install` 最穩。
- 也可以直接安裝本機套件（它是 bundle，所以 manager 會一併選進 `dsh.profile.bundles`）：

  ```sh
  dsh plugin --profile web add <repo>/packages/dsh-plugin
  ```

  請給絕對路徑，不要用 `./`。

### 3. 安裝依賴

```sh
dsh plugin --profile web install
```

這一步等於在 profile 目錄跑 `pnpm install`，會建立 link 與 profile 的 lockfile。

### 4. 確認載入

```sh
dsh --profile web --dump-config | grep -A2 mnemoshelf-dsh-plugin
```

應看到 `id: mnemoshelf-dsh-plugin` 與 `name: '@mnemoshelf/dsh-plugin'`（可能是 file URL／
套件 specifier）。`--dump-config` 不會真的開模型。

重新啟動 dsh（`dsh web`）後，stderr 會有一行
`[mnemoshelf-dsh] connection {...}`，代表外掛已載入並解析連線。

## 移除

```sh
dsh plugin --profile web remove @mnemoshelf/dsh-plugin
```

或手動從 profile 的 `dependencies` 與 `dsh.profile.bundles` 移除，再
`dsh plugin --profile web install`。移除後 `~/.dsh/mnemoshelf-spool/` 可自行刪除
（裡面只有待補送的記憶卡，沒有憑證）。

## 設定

外掛選項放在 dsh 的 plugin row `config`（或 `cordis.patch.yml` 的 row override）：

| 選項 | 說明 |
|---|---|
| `project` | 專案名。省略時依序用 `MNEMOSHELF_PROJECT`、dsh 啟動目錄的資料夾名；都解析不到就寫 `global`、召回只查 global。 |
| `baseUrl` | Mnemoshelf 網址（通常不需要；預設讀 `runtime.json`）。 |
| `token` | REST token（通常不需要；不要寫進版控）。 |
| `runtimeFile` | 明確指定 `runtime.json` 路徑（自訂資料目錄時使用）。 |
| `spoolDir` | 覆寫 spool 目錄（預設 `<DSH_HOME>/mnemoshelf-spool`，`DSH_HOME` 未設時是 `~/.dsh`）。 |

連線優先序（與文件契約一致）：

1. 選項 `baseUrl` ＋ `token`（明確指定，不驗身分）。
2. 環境變數 `MNEMOSHELF_URL` ＋ `MNEMOSHELF_TOKEN`。
3. `runtime.json`：先驗 loopback 網址、pid 存活與 `GET /health` 的
   `service === "mnemoshelf"`，通過才送 token。

`runtime.json` 位置：`runtimeFile` → `MNEMOSHELF_RUNTIME_FILE` →
`MNEMOSHELF_DATA_DIR/runtime.json` → 平台預設（桌面版與 CLI 位置都會試）。
**明確指定就不會再猜別的位置**（避免連到另一個資料庫）。

## 行為

### 召回

- 只在 `agent/pre-step` 的 **step 1**、且這一步有 `source.kind: "user"` 的訊息時執行。
- 請求：`POST /memories/search`，`k: 4`、`minScore: 0.65`、timeout **800ms**；
  有專案就查「本專案＋global」，沒有就送 `scope: "global"`。
- 注入：追加一則 `user/message`（`source: {kind:'mnemoshelf-recall', form:'recall'}`），
  內容是 `<memory-context …>` 區塊；**不改寫使用者原始訊息**。
- 總長（含標記）**≤ 900 字元**；超過從最後一筆開始丟，不留半截圍籬。
- 空召回、`degraded: true`、逾時、連線失敗、HTTP 錯誤 → 不注入，回合照常進行。
- 最新使用者訊息已含 Mnemoshelf 區塊時不重複注入。

### 寫入

- 只在 `turn/end` 的 `reason.kind === "completed"` 時寫。
- 取本回合**最後一則**真人 `user/message` 與**最後一則有文字**的 `assistant/message`。
- 剝除：`<memory-context>` 整塊、`<file>`／`<attached-file>`／`<attachment>`、
  `<system-reminder>`；只取 `type:"text"` block。
- 使用者文字（剝除後）**< 40 字元**、空白、或助理沒有文字 → 不寫、不報錯。
- 內容固定為：

  ```text
  User: <本次使用者文字>
  Assistant: <本次助理最終文字>
  ```

  兩段各有固定字元上限（2000／4000），不使用時間戳、回合 id、長度統計或隨機排序。
  同一回合重算兩次逐字相同。
- `POST /memories`：`kind: "fact"`、`agent: "dsh/turn"`、
  `sourceSession`＝dsh session id、`sourceMessage`＝turn 編號。回應 `201` 或
  `200 duplicate: true` 都算成功。

### spool

- 目錄：`~/.dsh/mnemoshelf-spool/`（`0700`）；檔案 `0600`，以 tmp＋rename 原子寫入。
- 檔名：`<epoch-ms>-<sha256 前 12 碼>.json`；同內容不會重複入 spool。
- 只在「已知服務位址但當下不可用」（pid 死亡、health 逾時／連不上、請求失敗）時 spool；
  平台預設位置的 `runtime.json` 因服務正常關閉而被刪除時，只要該機器的 Mnemoshelf
  資料目錄還在，也會進 spool（補送時用新的 runtime 檔）。明確指定錯誤的
  `runtimeFile` 則靜默停用，不堆積檔案。
- 啟動後與每 **5 分鐘**補送；成功或 `duplicate` 刪除；`4xx`（非 `429`）移到 `failed/`；
  `429`／`5xx`／連線失敗保留到下一輪。
- 上限 **200 筆**，超過丟最舊。

## 疑難排解

| 現象 | 先確認 |
|---|---|
| 啟動時看到 `disabling profile plugin row "mnemoshelf-dsh-plugin"` | dsh 版本與 `engines.dsh` 不符（目標 `0.2.1-rc.2`）。看 stderr 的 requirements，必要時用官方 `allow-version` 流程，不要改 range 硬塞。 |
| 一直沒有召回 | `dsh --profile <name> --dump-config` 是否看到外掛；stderr 的 `connection` 是否 `offline`（原因代碼見下）；使用者訊息是否含 `source.kind: "user"`。 |
| `connection` 顯示 `runtime-missing` | 服務沒開、agent discovery 沒開，或自訂資料目錄但沒給 `runtimeFile`／`MNEMOSHELF_RUNTIME_FILE`。 |
| `connection` 顯示 `health-identity-mismatch` | 同一個埠上不是 Mnemoshelf；外掛不會送出 token。 |
| 有回合但沒有卡片 | 看 `turn-skip` 的 `reason`：`short`（使用者文字 <40 字元）、`no-assistant`、`aborted`／`error`（非 completed 不寫）。 |
| `~/.dsh/mnemoshelf-spool/` 一直長大 | 服務沒恢復；`spool-offline` 會帶 `reason` 與 `remaining`。服務回來後最多等 5 分鐘，或重啟 dsh 觸發啟動補送。 |
| `failed/` 有檔案 | 伺服器回 4xx（內容／欄位不合法），屬於永久失敗，不會無限重試；可刪除。 |
| 召回很慢 | 契約 timeout 是 800ms；服務忙線時每個回合最多多等這些時間，之後 fail-open。 |

log 只會出現事件名、原因代碼與計數，**不會**有記憶內容、token、檔案路徑或 session id。

## 隱私

- spool 檔只有卡片 payload，**不含 token、url 或連線資訊**；補送時才從 `runtime.json`
  取當下憑證。
- `runtime.json` 含全權 token，請維持 `0600`，不要備份到 repo 或共用資料夾。
- 注入區塊是**不受信任資料**：`trust="untrusted"` 只是提示與剝除標記，不是安全邊界。

## 已知限制（v1）

- 不做 snapshot 注入、不改 system prompt、不提供工具介面。
- 注入塊會留在 session 歷史（dsh 的一般 `user/message`），直到 compaction 遮掉；
  因此區塊保持短（≤900 字元）。
- 只寫「成功完成」的回合；取消／錯誤／`blocked` 不寫卡。
- 只處理 `session/event`；不依賴 process-local 的 `assistant-stream`。
- Windows 尚未實測（POSIX 權限語意在 Windows 由使用者 profile ACL 取代）。
