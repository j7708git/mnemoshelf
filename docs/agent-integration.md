# Agent 整合：連線資訊檔（`runtime.json`）

Mnemoshelf 的服務只綁 `127.0.0.1`，而且所有 REST 端點都需要 Bearer token。
同一台機器上的 agent（OpenCode／OpenChamber 外掛、MCP client、自己的腳本）原本得由使用者
手動複製網址與 token 才能連上；**連線發現**把這兩項寫成一份只有本使用者可讀的檔案，
讓程式自己找到服務。

> 這份檔案是公開文件；內容以程式碼與 `docs/roots-and-privacy.md` 的契約為準。

## 這個檔案是什麼

開啟連線發現後，服務在**啟動完成時**寫出：

```json
{
  "schemaVersion": 1,
  "url": "http://127.0.0.1:12345",
  "token": "<MNEMOSHELF_TOKEN>",
  "pid": 12345,
  "startedAt": "2026-10-21T00:00:00.000Z",
  "appVersion": "<server-version>"
}
```

| 欄位 | 說明 |
|---|---|
| `schemaVersion` | 格式版本；目前是 `1`。 |
| `url` | 服務網址，永遠是 loopback。 |
| `token` | REST 的 Bearer token（**本機全權**，見下方安全說明）。 |
| `pid` | 寫出檔案（＝啟動服務）的行程；關閉時只用來判斷「這個檔是不是自己的」。 |
| `startedAt` | 服務啟動時間（ISO 8601）。 |
| `appVersion` | 服務版本；與 `GET /health` 的 `appVersion` 相同。 |

檔案以**原子寫入**產生（同目錄的 `.tmp` 再 rename），POSIX 上權限 `0600`。

## 開啟與關閉

### CLI／自行啟動的服務

| 變數 | 值 | 預設 | 說明 |
|---|---|---|---|
| `MNEMOSHELF_AGENT_DISCOVERY` | `on`／`off` | `off` | 是否寫出連線資訊檔。非法值會拒絕啟動。 |
| `MNEMOSHELF_RUNTIME_FILE` | 路徑 | `<dataDir>/runtime.json` | 覆寫檔案位置。 |

```sh
MNEMOSHELF_TOKEN=<token> MNEMOSHELF_AGENT_DISCOVERY=on \
  pnpm --filter @mnemoshelf/server run serve
```

- 服務**啟動完成後**才寫檔；listen 或後續啟動步驟失敗時不會留下含 token 的檔案。
- `close()` 只在檔案內的 `pid` 等於自己時刪除檔案。
- 以 `off` 啟動時，若上次（例如被 SIGKILL／當機）留下 `runtime.json`，會**直接清除**。
- 檔案寫入失敗（權限、磁碟）不會阻止服務啟動，只記錄一則不含 token 的 warning。

### 桌面版

桌面版的設定頁（「設定 → Agent 連線資訊」）有開關，**預設開啟**：

- 開關狀態保存在 `<userData>/agentSettings.json`（`0600`）。
- 關閉開關時**無條件立即刪除** `runtime.json`（即使服務還在跑）；刪除失敗會在設定頁顯示
  「連線資訊檔未清除」。
- 開啟開關後要**重新啟動應用程式**，服務才會寫出檔案。
- **桌面版的設定優先於 shell 環境變數**：桌面啟動服務時會覆寫
  `MNEMOSHELF_AGENT_DISCOVERY` 與 `MNEMOSHELF_RUNTIME_FILE`。也就是說，只在 shell 設
  `MNEMOSHELF_AGENT_DISCOVERY=on` 不會讓桌面版寫檔；請用設定頁的開關。
- 設定頁也有「複製連線資訊」按鈕：按下後把 `{"url": "...", "token": "..."}` 放進剪貼簿。
  內容**包含 token**，只貼給信任的程式；token 不會顯示在畫面上，也不會寫進 log。

## 預設路徑

桌面版與 CLI 的資料目錄不同（桌面版在 Electron 的 `userData` 底下多一層 `data`）：

| 平台 | 桌面版 `runtime.json` | 桌面版設定檔 | CLI／服務的 `runtime.json` |
|---|---|---|---|
| Linux | `~/.config/Mnemoshelf/data/runtime.json` | `~/.config/Mnemoshelf/agentSettings.json` | `~/.local/share/mnemoshelf/runtime.json`（或 `$XDG_DATA_HOME/mnemoshelf/runtime.json`） |
| macOS | `~/Library/Application Support/Mnemoshelf/data/runtime.json` | `~/Library/Application Support/Mnemoshelf/agentSettings.json` | `~/Library/Application Support/mnemoshelf/runtime.json` |
| Windows | `%APPDATA%\Mnemoshelf\data\runtime.json` | `%APPDATA%\Mnemoshelf\agentSettings.json` | `%APPDATA%\mnemoshelf\runtime.json` |

- Linux 的桌面 `userData` 尊重 `XDG_CONFIG_HOME`；CLI 的資料目錄尊重 `XDG_DATA_HOME`。
- 桌面版的實際位置以設定頁顯示的路徑為準（開發模式與打包版可能不同）。
- **自訂 `MNEMOSHELF_DATA_DIR`／`XDG_DATA_HOME` 時**，外部程式不一定算得出預設路徑；
  請明確設定 `MNEMOSHELF_RUNTIME_FILE`（或外掛的 `runtimeFile` 選項），不要假設預設路徑找得到。

## 讀取與使用

1. 讀 `runtime.json`，取出 `url` 與 `token`。
2. 先打免 token 的 `GET /health`，確認回應的 `service` 是 `"mnemoshelf"`、`appVersion` 符合
   預期——避免把 token 送到佔用同一個埠的無關程式。
3. 之後的請求帶 `Authorization: Bearer <token>`。

以下用 Node 22（本專案的執行環境）讀檔，不依賴 `jq`：

```sh
MNEMOSHELF_RUNTIME_FILE="$HOME/.local/share/mnemoshelf/runtime.json" node --input-type=module -e '
import { readFile } from "node:fs/promises";
const runtime = JSON.parse(await readFile(process.env.MNEMOSHELF_RUNTIME_FILE, "utf8"));
console.log(await (await fetch(`${runtime.url}/health`)).json());
const response = await fetch(`${runtime.url}/memories?limit=1`, {
  headers: { authorization: `Bearer ${runtime.token}` },
});
console.log(response.status);
'
```

換成自己的 `runtime.json` 路徑即可；預期 `health` 回應包含 `"service":"mnemoshelf"`，記憶列表回 `200`。

檔案不存在時，先確認開關是否開啟、服務是否正在執行，以及是否自訂了資料目錄
（見上一節的 `MNEMOSHELF_RUNTIME_FILE`）。

## MCP 設定範例（OpenCode V2）

Mnemoshelf 的 MCP 入口是 local stdio 程式，只把請求轉發給本機 REST。
以下是 OpenCode V2 的設定形狀（`mcp.servers`）；其他 client 的鍵名可能不同。

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "mnemoshelf": {
        "type": "local",
        "command": [
          "node",
          "<MNEMOSHELF_REPO>/packages/server/dist/scripts/mcp.js"
        ],
        "environment": {
          "MNEMOSHELF_URL": "http://127.0.0.1:<port>",
          "MNEMOSHELF_TOKEN": "<token>",
          "MNEMOSHELF_PROJECT": "<project-name>"
        }
      }
    }
  }
}
```

- `<MNEMOSHELF_REPO>`：本 repo 的位置；`<port>`／`<token>`：從 `runtime.json` 取得；
  `<project-name>`：這個 agent 的預設專案名稱（可省略，省略時退回 MCP 行程 cwd 的資料夾名稱）。
- **桌面版打包後的 MCP 入口路徑尚未實測**，請不要把上面的 placeholder 當成一定可用；
  必要時以原始碼 checkout 的 `packages/server/dist/scripts/mcp.js` 執行。
- token 會隨 `runtime.json` 變動；不要把它寫進 repo 內的設定檔。設定請放在使用者層級
  （例如 `~/.config/opencode/opencode.jsonc`）。

## 與 OpenCode 外掛的關係（MCP vs 自動召回）

兩者都連同一台本機服務、用同一組 `url` + `token`，但分工不同：

| | MCP 入口（本文上節） | `@mnemoshelf/opencode-plugin`（自動召回） |
|---|---|---|
| 誰發動 | **agent 主動呼叫工具**（`remember`／`search_memories`／`recall` 等） | 外掛在**每次模型請求前**自動查一次 |
| 能做什麼 | 查詢、寫入、釘選、遺忘（六個工具） | **召回**（注入當次請求）＋**可選**的每回合摘要寫入（`digestEnabled`＋`digestModel`，預設關閉） |
| 連線來源 | **只讀環境變數** `MNEMOSHELF_URL`／`MNEMOSHELF_TOKEN`（手動貼上） | options → 環境變數 → **自動讀 `runtime.json`** |
| 設定方式 | 使用者在 MCP client 設定（見上節） | 使用者手動加進 `opencode.jsonc` 的 `plugins`（v1 不自動改設定） |

- **`runtime.json` 只給外掛自動發現用**：MCP 入口目前不讀這個檔，仍要自己把 `url`／`token`
  寫進 MCP client 設定（值可從 `runtime.json` 抄出，見本文前面的 Node 讀檔範例）。
- **外掛的寫入是可選的**：召回一直是開啟的；寫入只有在你設定 `digestEnabled: true` 並指定
  `digestModel` 後才會發生——每個成功結束的回合會把 1 張回合紀錄＋最多 2 則原子記憶寫回
  mnemoshelf（見 [opencode-plugin.md](opencode-plugin.md) §7）。沒有開啟時外掛不呼叫模型、
  也不寫入；要主動留下記憶，請用 MCP 工具或 REST（見 README 的功能說明與
  `docs/operations.md` §REST 端點速查）。
- **職責邊界**：外掛負責「每回合自動摘要寫入＋需要時自動召回」，MCP 負責「agent 想查、想寫、
  想釘選或想遺忘時自己動手」；兩者共用同一台本機服務與同一組 `url` + `token`。
- 兩者可以同時開：外掛負責「不用問就帶進背景」，MCP 負責「agent 想查或想寫時自己動手」。
- 詳細安裝、參數與疑難排解見 [opencode-plugin.md](opencode-plugin.md)。

## 安全說明（請務必讀）

- **檔案含全權 token。** 目前的信任模型是「本機單一 owner 全權」：持有這組 token 的程式
  可以讀寫全部記憶、瀏覽已加入的 root。`agent` 只是來源標記，不是身分驗證。
- **`0600` 只擋其他使用者，不擋同使用者身分的程式。** 同一個作業系統帳號跑的任何程式
  （含惡意程式）都可以讀取這個檔案。
- **同使用者程式也能改寫 `runtime.json` 的 `url`。** v1 以 `/health` 的 `service` 身分比對
  與 `pid` 檢查來緩解「把 token 送到錯的程式」與「誤刪別人的檔」，但**不防惡意篡改**。
- **不要複製這個檔案到別台機器、備份、repo 或共用資料夾。** 需要備份 token 時請用密碼管理工具。
- Windows 沒有 POSIX `0600` 的等價語意；檔案位於使用者專屬的 `%APPDATA%`，由使用者 profile
  的 ACL 保護。**Windows 上的行為尚未實測**。
- 同一時間建議只跑**一個** Mnemoshelf 服務：兩個服務寫同一個 `runtime.json` 會互相覆蓋，
  以最後啟動者為準。

## 與其他文件的關係

- 服務綁定位址、root 驗證與機密遮罩：`docs/roots-and-privacy.md`。
- 桌面版的 token 保存（safeStorage 密文）與 renderer 可見範圍：`packages/desktop/src/token-store.ts`
  與 `docs/roots-and-privacy.md` §信任模型。
- MCP 工具語意：`docs/operations.md` §MCP 工具。
