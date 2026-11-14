# Codex 自動召回與原文保存

> 讀者：已在本機執行 Codex 和 Mnemoshelf 的使用者，以及維護 hook 的開發者。
>
> 一句話：送出提示時召回記憶，回合結束時可選擇保存可見對話原文。
>
> 現在要做：建置腳本、審查兩條 hook，再選擇全域或單一專案啟用。
>
> 依據：[Agent 整合契約](agent-integration.md)、[原文記憶契約](raw-memory.md)與 [OpenAI Hooks 文件](https://learn.chatgpt.com/docs/hooks)。

## 啟用與確認

1. 讓 Mnemoshelf App 保持執行，在「Agent 連線資訊」確認 `runtime.json` 可用。
2. 在原始碼目錄，以 Node.js 22.14 以上執行 `pnpm install --frozen-lockfile` 與 `pnpm --filter '@mnemoshelf/server...' build`。產物為 `packages/server/dist/scripts/codex-recall.js` 和 `codex-capture.js`；本版請搭配 v0.9.2 App，以使用完整召回規則與版本核對。升級 App 不會自動更換既有 Hook 指向的建置路徑。
3. 跨專案啟用時，將下面設定合併到 `~/.codex/hooks.json`；自訂 `CODEX_HOME` 者使用該目錄下的 `hooks.json`。只在特定專案啟用時，使用該專案的 `.codex/hooks.json`。
4. 全域與專案 hook 會同時生效。轉成全域前，移除專案層相同的 Mnemoshelf 召回／擷取項目，保留其他 hook；只有檔案已無任何設定時才移除空檔。

下例使用 macOS／Linux shell。將括號內的值換成實際的絕對路徑；Node.js 路徑可用 `command -v node` 查詢。從桌面介面啟動時可能讀不到終端機的 `PATH`，因此兩條命令均使用明確路徑。不要在 hook 設定內填入 token。

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "MNEMOSHELF_RUNTIME_FILE='<連線資訊檔>' '<Node 執行檔>' '<Mnemoshelf 原始碼目錄>/packages/server/dist/scripts/codex-recall.js'",
            "timeout": 3
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "MNEMOSHELF_RUNTIME_FILE='<連線資訊檔>' '<Node 執行檔>' '<Mnemoshelf 原始碼目錄>/packages/server/dist/scripts/codex-capture.js'",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

開啟新的本機 Codex 工作階段並信任專案；CLI 使用 `/hooks`，桌面版使用「Review hooks」或「Settings → Hooks」審查兩條命令。只需要召回時省略 `Stop`。用一輪合成對話確認原文保存，再開另一段對話、以不含答案的相關提示確認召回；用戶層設定也可在 Mnemoshelf「連接 Agent」頁重新偵測，但該頁只辨識設定文字，不能證明 hook 曾執行。

**全域化指設定跨專案生效，不會把專案記憶變成全域共享。** Hook 仍以每次事件的 `cwd` 資料夾名稱作為 `project`；`MNEMOSHELF_PROJECT` 可明確覆寫。有專案時查該專案＋global，無法判定專案時只查 global；擷取同樣沿用此專案解析。兩個同名資料夾需另設不同專案名稱。

## 召回範圍與資料流向

每次提交提示最多注入四筆語意命中，整段最多 900 字元。查詢透過本機服務執行，命中的記憶會成為 Codex 的參考上下文，也會傳給該工作階段使用的模型。注入一律包在不受信任的 `<memory-context>` 區塊中。

`codex-recall.js` 只查詢；原文保存由另外啟用的 `codex-capture.js` 執行。原文命中是片段，可用 MCP `read_memory_source` 依來源 ID 續讀，遮罩由服務的有效政策決定。

## Stop 保存的範圍與去重

Adapter 只讀 `Stop.transcript_path` 指定的 JSONL，且真實路徑必須落在 `$CODEX_HOME/sessions`（預設 `~/.codex/sessions`）內，副檔名為 `.jsonl` 並通過敏感路徑黑名單。這是使用者啟用 hook 所選的宿主 transcript 來源；不新增檔案索引 root、不掃描其他對話、不接受任意外部檔案。

解析時核對 `session_meta` 的 session ID、`task_started` 的 turn ID，以及 `item_completed` 的 thread／turn ID。只讀以下完成項目：

| 完成項目 | 保存內容 |
| --- | --- |
| `UserMessage` | `content[]` 中 `type: text` 的文字 |
| `AgentMessage` | `content[]` 中 `type: Text` 的文字；phase 為 `commentary`、`final_answer` 或省略 |
| 其他項目 | 全部忽略，包括 `Reasoning`、工具呼叫與工具輸出 |

`response_item` 是另一份重複表示，且其中的 user 角色可能是宿主環境注入，因此完全忽略。文字中的 `<memory-context>`、system／developer 提示、thinking／reasoning、工具與附件區塊也會移除；其餘文字保留首尾空白、換行及合法 Unicode。未知時間保持 `null`，不冒充擷取時間。

Stop 觸發時 `task_complete` 尚未寫入；Adapter 以最後一則可見回答核對 `last_assistant_message`，確保回答已完整 flush。該欄只作核對，不用來補造遺漏訊息。缺少使用者文字、最後回答、必要 ID，或格式未知／破損時整輪略過。

桌面 `create_thread` 工具建立對話時，起始派工內容可能記為 `FunctionCallOutput`，並未產生 `UserMessage`。這類只有工具輸入的回合不保存；驗證一般聊天時須從桌面輸入框送出使用者訊息，不能把派工工具當成等價輸入。

`sourceSession`、`sourceTurn`、`sourceMessage` 分別沿用 session、turn 與 item ID，寫入者為 `codex/turn`。同輪重觸發先查本機游標；只有服務明確回覆 `saved: true` 和有效來源 ID 才確認。游標位於 `$CODEX_HOME/mnemoshelf/capture-cursors`，每個事件一個原子檔，只含事件 hash 與保存標記，不存原文或 token。不同回合即使文字相同也各自保存；並行觸發或游標遺失由服務端事件等冪去重。

## 降級、重試與排查

召回遇到無命中、冷啟動、離線、查詢降級或逾時便略過注入。擷取遇到服務離線、錯誤回應、格式不符或逾時回 `{}`／無輸出並以退出碼 0 結束，不要求 Codex 繼續或阻擋停止。CLI watchdog 為 3.5 秒，外層 hook timeout 為 5 秒；stdin 上限 256 KiB、transcript 上限 32 MiB，超限整輪略過，不截短原文。

擷取不建立離線 spool，也不在下一輪補抓歷史。失敗時不確認游標，同一 Stop 再次觸發才會重試；只對當次事件保存成功負責。服務回 409 時不改 ID、不覆寫，也不假稱已保存。若其他 Stop hook 讓同一 turn 繼續產生內容，已保存的事件不會被覆寫。

先檢查 App、runtime 檔、專案範圍、兩條命令的路徑與 Codex hook 信任狀態，再用合成對話驗證。不要把真實 transcript 或 runtime 內容貼入公開紀錄。要停用時移除對應設定並開新工作階段；已保存的來源另由 Mnemoshelf 管理。

## 版本能力與驗證界線

macOS 桌面應用程式內附 CLI 位於 `/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex`。`0.167.0-alpha.4.1` 的 hooks feature 為啟用；本機 schema 接受下列 14 種事件：

| 類別 | 事件 |
| --- | --- |
| 模型／工具 | `PreModelRequest`、`PostModelRequest`、`PreToolUse`、`PermissionRequest`、`PostToolUse` |
| 壓縮／工作階段 | `PreCompact`、`PostCompact`、`SessionStart`、`SessionEnd` |
| 提示／回合／子代理 | `UserPromptSubmit`、`Stop`、`Interrupt`、`SubagentStart`、`SubagentStop` |

在此版本使用隔離設定與合成模型回應，已實際觸發 `SessionStart`、`UserPromptSubmit`、`PreModelRequest`、`PostModelRequest`、`Stop`、`SessionEnd`，並在 Stop 當下讀到 user、commentary、final、reasoning 與工具項目。其餘事件僅驗 schema，沒有逐一觸發。

同一內附 CLI 搭配執行中的 Mnemoshelf v0.9.1，已以合成對話完成兩個 hook 的端到端冒煙測試：保存與讀回可見文字、重觸發去重、下一輪模型請求收到召回，以及測試來源硬刪除。這是本機服務與命令 hook 的驗證，不代表已替使用者啟用全域設定。

macOS 桌面版亦已使用正式全域設定與正常 hook 信任完成一般聊天驗證：從輸入框在同一專案建立兩段獨立對話，兩輪的 user／assistant 共四則原文均逐字一致；第二段提問未包含答案、沒有工具呼叫，但收到第一段來源的 `<memory-context>` 並正確回答。第二段保存內容只有可見 user／assistant，未重複保存注入記憶。驗證時 transcript 的 originator 為 `Codex Desktop`、內附版本為上述 `0.167.0-alpha.4.1`。

實際 Stop stdin 欄位是 `session_id`、`turn_id`、`transcript_path`、`cwd`、`hook_event_name`、`model`、`permission_mode`、`stop_hook_active`、`last_assistant_message`；其中 transcript 路徑與最後回答的 schema 允許 null，Adapter 遇到 null 會略過。

官方明示 [transcript 格式不是穩定介面](https://learn.chatgpt.com/docs/hooks#common-input-fields)。此 Adapter 依上述版本的完成項目格式實作；升級後應先重做合成 smoke。已開啟聊天的設定熱重載、Windows 命令的 `commandWindows`、Linux、遠端／雲端、fork、壓縮與恢復舊 transcript 尚未實機驗證。
