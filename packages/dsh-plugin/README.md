# `@mnemoshelf/dsh-plugin`

Mnemoshelf 的 [dsh](https://www.npmjs.com/package/@deepseek-ai/dsh) 外掛（v1）：

- **回合前自動召回**：在 `agent/pre-step` 用本次使用者輸入查 `POST /memories/search`，把相關記憶
  包成 `<memory-context source="mnemoshelf" trust="untrusted" form="recall">` 追加成一則
  `user/message`。
- **回合後自動寫入**：在 `turn/end` 取本回合宿主提供的有序使用者文字與助理回覆，剝除注入塊／附件／
  system-reminder 後，保存完整可見的原文回合（`agent: "dsh/turn"`），不呼叫摘要模型。
- **fail-open 與 spool**：服務不可用時不影響 dsh 回合；寫入先進
  `~/.dsh/mnemoshelf-spool/`，服務恢復後補送。

契約來源：[Agent 整合](../../docs/agent-integration.md) 與 [原文記憶](../../docs/raw-memory.md)。回合事件依宿主提供的 session／turn／message 識別處理，不讀取額外私人歷史。

## 需求

- Node.js 22.14 以上（與 repo 其他套件一致）。
- dsh manifest 的 `engines.dsh` 是 `^0.2.1-rc.2`；型別與初期接入以 rc.2 核對。原文流程另在 macOS 上以 App 隨附的 rc.5 runtime 及隔離 profile 通過兩輪串接驗證。
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
| `captureEnabled` | 預設開啟；設 false 停止新增原文擷取與既有 spool 補送，不改召回。 |
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
- 請求：`POST /memories/search`，`k: 8`、`minScore: 0.65`、timeout **800ms**；
  有專案就查「本專案＋global」，沒有就送 `scope: "global"`。
- 注入：追加一則 `user/message`（`source: {kind:'mnemoshelf-recall', form:'recall'}`），
  內容是 `<memory-context …>` 區塊；**不改寫使用者原始訊息**。
- 總長（含標記）**≤ 900 Unicode 碼點**。原文最多四個來源，每來源最多兩個不同片段，依角色及位置去重，分配剩餘預算。每組保留 source ID 與 user／assistant 角色，節錄可用 read_memory_source 續讀；不留半截圍籬。
- 召回前確認有效記憶政策，政策讀取失敗或服務不支援時不注入舊快取。已留在宿主歷史的內容無法藉開關追回。
- 空召回、逾時、連線失敗、HTTP 錯誤 → 不注入，回合照常進行。`degraded: true` 時只接受格式與政策版本有效的原文關鍵字命中，舊記憶降級結果不注入。
- 最新使用者訊息已含 Mnemoshelf 區塊時不重複注入。

### 原文寫入

只在成功完成的 `turn/end` 擷取本回合宿主提供的可見使用者與助理文字。每則保留角色、順序、來源識別與原始時間（未知為 null），排除工具、system、附件及再次注入的記憶。原文不再套用舊 2,000／4,000 字元截斷，也不因使用者訊息短於 40 字元而直接丟掉重要短回覆。

新入口為 `POST /memory-sources`。相同事件重送為 duplicate，不同事件相同文字保留；事件內容衝突 409、超過 8 MiB 413，皆不得回報完整成功。原文保存與向量索引完成分開，App 來源面板可看索引狀態與繼續讀取。完整契約見 [原文記憶](../../docs/raw-memory.md)。

### spool

- 目錄仍為 `<DSH_HOME>/mnemoshelf-spool`，未設定 DSH_HOME 時為 `~/.dsh/mnemoshelf-spool`；POSIX 目錄 0700、檔案 0600。
- 新事件 schemaVersion 2，檔名 `raw-<事件 key hash>.json`，保存第一次準備的固定 payload；不含 token／URL。
- 遮罩開啟或無法確認政策時，完整訊息先遮罩再落地；關閉時可保存原文，送入服務時仍按有效政策處理。切換不批次改寫舊 spool。
- 成功或明確 duplicate 才刪除待送檔案。舊服務、409、413、離線與格式錯誤保留診斷狀態，不退回短卡，不以 200 筆上限靜默丟最舊事件。
- 啟動時與每 5 分鐘補送；captureEnabled=false 時暫停補送。未設定有效服務時顯示 write-disabled，不建立新 spool。舊 schemaVersion 1 檔案保留並提示待遷移，不冒稱完整原文。

## 疑難排解

| 現象 | 先確認 |
|---|---|
| 啟動時看到 `disabling profile plugin row "mnemoshelf-dsh-plugin"` | dsh 版本與 `engines.dsh` 不符（目標 `0.2.1-rc.2`）。看 stderr 的 requirements，必要時用官方 `allow-version` 流程，不要改 range 硬塞。 |
| 一直沒有召回 | `dsh --profile <name> --dump-config` 是否看到外掛；stderr 的 `connection` 是否 `offline`（原因代碼見下）；使用者訊息是否含 `source.kind: "user"`。 |
| `connection` 顯示 `runtime-missing` | 服務沒開、agent discovery 沒開，或自訂資料目錄但沒給 `runtimeFile`／`MNEMOSHELF_RUNTIME_FILE`。 |
| `connection` 顯示 `health-identity-mismatch` | 同一個埠上不是 Mnemoshelf；外掛不會送出 token。 |
| 有回合但沒有原文 | 檢查 captureEnabled、宿主 completed 事件、政策端點是否支援，以及 spool 診斷狀態。 |
| `~/.dsh/mnemoshelf-spool/` 一直長大 | 服務沒恢復；`spool-deferred` 的 reason=offline 表示離線；flush 會回報計數。服務回來後最多等 5 分鐘，或重啟 dsh 觸發啟動補送。 |
| 待送事件持續保留 | 檢查需升級、來源衝突、超限或格式錯誤；不要以重新產生 ID 來繞過衝突。 |
| 召回很慢 | 召回的政策讀取、搜尋、政策重驗與一次重試共用 800ms deadline；連線就緒確認另有 50ms 預算。超時不注入，回合照常進行。 |

log 只會出現事件名、原因代碼與計數，**不會**有記憶內容、token、檔案路徑或 session id。

## 隱私

- spool 檔只有來源事件 payload，**不含 token、url 或連線資訊**；補送時才從 `runtime.json`
  取當下憑證。
- `runtime.json` 含全權 token，請維持 `0600`，不要備份到 repo 或共用資料夾。
- 注入區塊是**不受信任資料**：`trust="untrusted"` 只是提示與剝除標記，不是安全邊界。

## 已知限制

- 不做 snapshot 注入、不改 system prompt、不提供工具介面。
- 注入塊會留在 session 歷史（dsh 的一般 `user/message`），直到 compaction 遮掉；
  因此區塊保持短（≤900 字元）。
- 只寫「成功完成」的回合；取消／錯誤／`blocked` 不寫入。
- 只處理 `session/event`；不依賴 process-local 的 `assistant-stream`。
- Windows 尚未實測（POSIX 權限語意在 Windows 由使用者 profile ACL 取代）。

## 原文流程的宿主驗證

macOS 上使用 App 隨附、未改寫的 dsh 0.2.1-rc.5 runtime，在隔離資料目錄與合成模型 adapter 完成兩輪對話。第一輪超過 12,000 UTF-16 字元的助理文字完整保存，第二輪模型輸入帶入尾段記憶及來源 ID。隔離 profile 的相依套件連到 App 隨附依賴的未修改實體副本後，原 App launcher 正常完成兩輪。保存的四則訊息另與宿主持久日誌逐字比對，召回注入事件未被回存。這是 CLI/runtime 串接證據，不等於桌面 GUI 或真模型回答品質驗證。
