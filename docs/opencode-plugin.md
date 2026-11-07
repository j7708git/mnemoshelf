# OpenCode／OpenChamber 外掛：原文擷取與自動召回

> **讀者**：首次安裝或從 digest 摘要流程升級的 OpenCode／OpenChamber 使用者。
> **一句話**：外掛自動帶入相關記憶，選用的回合擷取保存原文，不再需要摘要模型。
> **現在要做**：建置外掛、保留既有設定並加入外掛，使用 `/memory` 確認連線與擷取狀態。
> **依據**：本套件設定、宿主事件接入與 [原文記憶契約](raw-memory.md)。

## 需求與相容性

外掛型別依 `@opencode/plugin@2.1.1`；宿主版本升級後需重新檢查載入與回合事件。本輪另在 macOS 以 OpenChamber 隨附的 OpenCode 2.2.5 CLI、standalone 隔離設定與合成本機 SSE 模型通過兩輪原文寫入及召回，並逐則對照宿主 session export。這不等於 OpenChamber GUI 或其他版本皆已驗證。Node.js 22.14 以上、pnpm 10 用於建置，HTTP 使用內建 fetch，不增加生成模型依賴。

原文寫入需要支援 `/memory-policy` 與 `/memory-sources` 的 Mnemoshelf 服務；舊服務不支援時會提示升級並保留待補送事件，不退回截短卡片。外掛與服務應使用同一份新版原始碼建置。既有 `runtime.json` 與 loopback/token 契約不變，詳見 [Agent 連線指引](agent-integration.md)。

## 安裝

外掛隨本 repo 提供，本機目錄是安裝入口：

```sh
pnpm install --frozen-lockfile
pnpm --filter @mnemoshelf/opencode-plugin build
```

確認 `packages/opencode-plugin/index.js` 與 `dist/index.js` 存在。根 index.js 導向 dist；本機載入器的 `package` 應指向**套件目錄**，不是 dist/index.js。更新原始碼後需重新建置並重載宿主。

在 `~/.config/opencode/opencode.jsonc`（或 opencode.json）的既有 plugins 陣列加一筆，保留其他設定。Windows 使用 `%USERPROFILE%/.config/opencode/`；OpenChamber 共用這份設定。

```jsonc
{
  "plugins": [
    {
      "package": "<外掛套件目錄的絕對路徑>",
      "options": {
        "runtimeFile": "<runtime.json 的絕對路徑>",
        "captureEnabled": true
      }
    }
  ]
}
```

`runtimeFile` 可省略，由外掛找平台預設位置。App「連接 Agent」頁可複製安裝片段；App 不替你改宿主設定。路徑填入自己的實際位置，JSON 的反斜線需跳脫；勿把連線 token 寫入版控。

## 確認連線

先啟動 Mnemoshelf App，確認「Agent 連線資訊」已開啟。自行啟動服務者用 `MNEMOSHELF_AGENT_DISCOVERY=on`。在 OpenCode TUI 或 OpenChamber 執行 `/memory`，確認服務、專案、召回與擷取狀態。

`opencode run` 的 slash command 可能只被當成普通訊息，不等於經過宿主 command API；不要以此判斷 `/memory` 壞掉。外掛載入可看宿主 `loading plugin` 與外掛 setup log，單次 plugin list 空結果也不代表未載入。

連線每個欄位依 options → 環境變數 → runtime discovery 取得。明確指定 runtimeFile 或 `MNEMOSHELF_RUNTIME_FILE` 時，只使用該位置，不改連其他實例。runtime discovery 先檢查 loopback、服務 health 與平台支援的 pid 存活；這只能降低誤連風險，不是服務身分的密碼學保證。

環境變數：`MNEMOSHELF_URL`、`MNEMOSHELF_TOKEN`、`MNEMOSHELF_PROJECT`、`MNEMOSHELF_RUNTIME_FILE`、`MNEMOSHELF_DATA_DIR`。不要把 options 裡的字串 `"{env:...}"` 當作已確認的安全代換機制。

## 設定

| 參數 | 預設 | 說明 |
| --- | --- | --- |
| captureEnabled | false | 回合原文擷取；明確設定優先於舊 digestEnabled |
| captureOnInterrupted | false | 選擇是否擷取中斷回合；shutdown／superseded 不寫 |
| spoolDir | 平台狀態目錄 | 覆寫待補送事件的位置 |
| runtimeFile | 平台預設候選 | 指定連線資訊檔 |
| project | 由環境／工作目錄解析 | 覆寫專案名稱 |
| trigger | first-turn+explicit | 可改 every-turn |
| kMax | 8 | 搜尋候選筆數，範圍 1–20 |
| maxItems | 4 | 最多注入項數，範圍 1–8 |
| minScore | 0.65 | 語意命中最低分數，0–1 |
| timeoutMs | 150 | 召回 timeout，100–2000 毫秒 |
| maxFactChars | 180 | 舊 fact 卡片每筆預算；原文命中不以舊 fact 規則盲目截頭 |
| maxOtherChars | 220 | 舊 decision／pitfall／preference 每筆預算 |
| softChars | 900 | 項目行合計軟上限 |
| hardChars | 1200 | 整段注入硬上限 |
| dedupeTTL | 8 | 同 session 已注入 id 的輪次去重 |
| recentTurns | 3 | 最近回合參考數量，可設 0 關閉 |

`baseUrl`／`token` 仍可明確指定，但通常用 runtime 檔即可。設定與錯誤診斷不得記錄 token 或原文。

### 從摘要設定升級

- 沒有新 captureEnabled 時，沿用合法的舊 `digestEnabled` 布林值；原先 false 或未設定者仍關閉。
- 新 `captureEnabled` 明確設定時優先，因此可保留舊欄位而明確關閉擷取。
- `captureOnInterrupted` 同理接替 `digestOnInterrupted`。
- `digestModel`、`digestTimeoutMs` 已退役，會提示移除；不驗模型清單、不呼叫生成模型，也不要求填另一個模型。
- 舊摘要與原子記憶保留；新回合保存來源原文，不嘗試還原舊摘要。

啟用原文後，保存範圍會比舊摘要完整。可以先在 App 確認記憶遮罩設定，再重載宿主。

## 回合擷取

外掛從宿主回合事件取得可見 user／assistant 文字及穩定來源 ID，不讀隱藏推理或全機歷史。若宿主只提供最終文字而沒有逐則訊息，就只保存該事件可見的文字，不聲稱包含整個歷史。產品注入的記憶、system、工具輸出與附件不回存；保留下來的原文不以舊 user／assistant 字數上限截斷。

來源經 `POST /memory-sources` 保存，服務以事件 key 去重。相同事件重送回 duplicate；內容變了卻重用事件 ID 回 409。超過來源傳輸上限回 413，不能把失敗當作完整保存。

自動寫入不需摘要模型，但向量索引仍使用 Mnemoshelf 既有 embedding。寫入成功只代表原文已存，索引完成可在 App 來源面板確認。

### 離線補送

captureEnabled=false 時停止新擷取與既有 spool 補送。原文事件使用 schemaVersion 2 spool，以固定事件 key 保存首次準備的 payload；不因重試重新生成內容，不以容量上限靜默刪除舊事件。

| 平台 | 預設 spool 位置 |
| --- | --- |
| Linux | `$XDG_STATE_HOME/mnemoshelf/opencode-spool`；未設定時用使用者狀態目錄 |
| macOS | `~/Library/Application Support/mnemoshelf/opencode-spool` |
| Windows | `%LOCALAPPDATA%/mnemoshelf/opencode-spool` |

檔案不含連線 token／URL。遮罩開啟或政策未知時，先遮罩完整訊息再落地；第一次送出與重試使用同一份文字。關閉時可保留原文，服務接收時仍依當下政策處理。切換不改寫舊 spool，政策切換後宿主重建相同事件但內容不同可能回 409，不能偷偷改 ID 來略過衝突。

## 召回與來源續讀

預設在 session 第一則 prompt 或含明示記憶線索時召回，every-turn 可改為每回合。查詢依專案／scope，內容以不受信任的記憶區塊注入當次模型上下文。空結果、逾時、離線或格式不符時不阻擋宿主回覆。

原文命中以相關片段為中心，保留角色與來源 ID；注入預算限制呈現，不刪保存的文字。需要完整內容時，Agent 可用 MCP `read_memory_source`。相關片段優先於額外前後文，不能把節錄稱作完整對話。

重新注入前確認有效政策，政策版本改變時清除召回快取。讀政策失敗時不沿用舊的關閉遮罩快取；已存在宿主歷史中的文字無法追回。

`/memory` 顯示連線、召回與原文擷取狀態、最近結果。`/memory-all <query>` 用於明確跨專案搜尋。狀態訊息使用 `[[mnemoshelf-status]]` 標記，避免把指令輸出當成新查詢或原文記憶。

## 排查

| 情況 | 檢查方式 |
| --- | --- |
| 外掛未載入 | 檢查 package 指向目錄、根 index.js 與 dist 是否存在，重新建置並重載宿主 |
| 未連線 | App 是否執行、runtimeFile 是否指向正確實例、Agent 連線資訊是否開啟 |
| 沒有自動寫入 | captureEnabled 有效值、宿主是否送出適合的回合事件、`/memory` 最近結果 |
| 服務不支援 | 以同一份新版程式重建服務與外掛；保留 spool，不退回截短寫入 |
| 409 | 同事件內容衝突或事件已刪除；檢查事件身分與待補送狀態，不自動覆寫 |
| 413 | 回合超過明確上限；未保存，不得標成完整成功 |
| 查不到剛存的來源 | 先看來源索引狀態，再檢查專案範圍、模型暖機與 timeout |

原文與檢索結果可能包含專案資訊。服務本機運作，但 Agent 使用結果時仍可能將內容傳給其雲端模型；移除摘要模型不等於所有宿主模型都在本機。
