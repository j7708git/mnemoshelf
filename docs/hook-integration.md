# 通用 Agent Hook 接入指南

> **讀者**：想把 Mnemoshelf 記憶與語意搜尋接入支援生命週期 Hook 的 AI Agent Harness（Antigravity、Codex、Claude Code、Gemini CLI、Cursor 等）的使用者與開發者。
>
> **一句話**：透過共用 Hook 核心與通用 CLI 入口，以複製貼上的方式為各類 Agent 加上「回合前自動召回」與「MCP 工具存取」。
>
> **現在要做**：建置腳本，依宿主選擇召回及原文保存設定，再以合成對話驗證。
>
> **依據**：[Agent 整合契約](agent-integration.md)、[原文記憶契約](raw-memory.md)、[隱私與信任模型](roots-and-privacy.md)。

---

## 三步快速上手（複製貼上範本）

先確認 Mnemoshelf 服務正在執行（桌面版設定頁的「Agent 連線資訊」開關為開啟），並在原始碼目錄建置伺服端腳本：

```bash
pnpm install --frozen-lockfile
pnpm --filter '@mnemoshelf/server...' build
```

### 第一步：掛載 MCP 工具（`mcp_config.json`）

將以下片段加入宿主的 MCP 設定（不需手動貼 token，入口會自動讀取本機 `runtime.json`）：

```json
{
  "mcpServers": {
    "mnemoshelf": {
      "command": "<Node 執行檔>",
      "args": ["<Mnemoshelf 原始碼目錄>/packages/server/dist/scripts/mcp.js"]
    }
  }
}
```

### 第二步：設定生命週期 Hook（`hooks.json`）

依你使用的宿主選擇對應的設定片段：

#### A. Antigravity（原生 Plugin：自動召回＋原文保存）

將以下檔案放進 `~/.gemini/config/plugins/mnemoshelf/`（需搭配 `plugin.json` 與上一步的 `mcp_config.json`）：

```json
{
  "mnemoshelf": {
    "PreInvocation": [
      {
        "type": "command",
        "command": "'<Node 執行檔>' '<Mnemoshelf 原始碼目錄>/packages/server/dist/scripts/antigravity-hook.js' pre-invocation",
        "timeout": 4
      }
    ],
    "Stop": [
      {
        "type": "command",
        "command": "'<Node 執行檔>' '<Mnemoshelf 原始碼目錄>/packages/server/dist/scripts/antigravity-hook.js' stop",
        "timeout": 5
      }
    ]
  }
}
```

- `PreInvocation` 預設採 `per-turn`。同一對話中，只要正規化提問或 `initialNumSteps` 與上次記錄相同，就略過本次召回，連健康檢查也省略。工具呼叫使步數遞增時，相同提問仍只召回一次。先問 A、再問 B、之後回到 A，第三輪會重新搜尋並過濾已注入的記憶。設定 `MNEMOSHELF_RECALL_MODE=every-turn` 可在每次模型呼叫時召回並略過記憶去重。
- `Stop` 在回合正常結束時解析 `transcript.jsonl`：解包 `<USER_REQUEST>` 並剝除 `<ADDITIONAL_METADATA>`、`<USER_SETTINGS_CHANGE>`、`<SYSTEM_MESSAGE>`、`<memory-context>` 等宿主注入標籤，排除 `thinking`、工具輸出、系統步驟與伴隨 `tool_calls` 的過場步驟（僅保留無 `tool_calls` 的實質回覆），透過 `POST /memory-sources` 等冪保存對話原文。

#### B. Codex（自動召回＋可選 Stop 原文保存）

完整說明見 [Codex 自動召回與原文保存](codex-recall.md)。跨專案啟用時加入 `~/.codex/hooks.json`，並移除專案 `.codex/hooks.json` 中相同的 Mnemoshelf 項目，保留其他 hook；只要單一專案時僅設專案層。這不改變記憶的本專案＋global 查詢範圍。

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

`Stop` 只保存當次 session／turn 的可見 user 與 assistant 完成項目，排除系統注入、推理和工具內容。僅讀取 Codex sessions root 內的 transcript，確認保存後寫入本機事件游標；離線不確認、不回填歷史。同輪重送由游標與服務等冪去重，完整限制見上方 Codex 指引。

#### C. 其他支援 Command Hook 的宿主（通用 CLI：`generic-hook.js`）

使用 `generic-hook.js --preset <harness>`（或自訂 `--prompt-field`／`--cwd-field`／`--output-mode`）：

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "'<Node 執行檔>' '<Mnemoshelf 原始碼目錄>/packages/server/dist/scripts/generic-hook.js' --preset claude-code",
            "timeout": 3
          }
        ]
      }
    ]
  }
}
```

### 第三步：專案名稱與資料夾權限提醒

1. **專案隔離（`MNEMOSHELF_PROJECT`）**：Hook 預設以工作目錄資料夾名稱作為 `project`（排除家目錄與根目錄）；若有多個同名資料夾，請於命令前明確設定 `MNEMOSHELF_PROJECT=<專案名>`。
2. **檔案搜尋分享開關（`allowAgentSearch`）**：MCP `search` 工具預設 `agentOnly: true`，只搜尋你在 Mnemoshelf UI 中勾選「允許 Agent 搜尋此資料夾」的 root；記憶召回不受此開關限制。

### Antigravity 多資料夾工作區

專用 Hook 的 `PreInvocation` 和 `Stop` 均優先採用 `MNEMOSHELF_PROJECT`。未設定時，以選中的資料夾名稱作為專案。只採用正規化後的絕對路徑，排除家目錄與檔案系統根目錄。

1. 有可用的 `cwd` 時，選擇 `workspacePaths` 中與其相同或包含它的最深層目錄。找不到匹配項時直接使用 `cwd`。
2. 沒有可用的 `cwd` 時，排除包含其他工作區的上層目錄。若只剩一個葉節點，直接選用。
3. 有多個葉節點時，`PreInvocation` 可依提示選擇唯一被明確提及的資料夾。名稱至少兩個字元，比對時忽略大小寫並要求完整詞界。
4. 若提示未命中、同時命中多個資料夾，或事件沒有可用提示（例如 `Stop`），採用原始清單中第一個合法項目。沒有合法目錄時，召回及保存使用全域範圍。

---

## 生命週期事件與欄位對照表

| Harness | Preset (`--preset`) | 召回事件 | 提示欄位 (`--prompt-field`) | 工作目錄欄位 (`--cwd-field`) | 輸出模式 (`--output-mode`) | 原文保存 (`Stop`) |
| --- | --- | --- | --- | --- | --- | --- |
| Antigravity | 專用 `antigravity-hook.js` 或通用 `antigravity` | `PreInvocation` | `lastUserInput` | 專用 Hook 採 `cwd` 與 `workspacePaths`。通用 preset 採 `workspacePaths.0` | `injectSteps` | 支援（`antigravity-hook.js stop`） |
| Codex | `codex`（或專用 `codex-recall.js`） | `UserPromptSubmit` | `prompt` | `cwd` | `hookSpecificOutput` | 支援（`codex-capture.js`；`0.167.0-alpha.4.1` 的 CLI 與 macOS 桌面一般聊天均已實測） |
| Claude Code | `claude-code` | `UserPromptSubmit` | `prompt` | `cwd` | `hookSpecificOutput` | 視宿主設定 |
| Gemini CLI | `gemini-cli` | `BeforeAgent` | `prompt` | `cwd` | `hookSpecificOutput` | 視宿主設定 |
| Cursor | `cursor` | `beforeSubmitPrompt` | `prompt` | `workspace_roots.0` | `additionalContext` | 視宿主設定 |

若需對接表外宿主，可直接指定欄位與模式，例如：

```bash
node dist/scripts/generic-hook.js \
  --event-name UserPromptSubmit \
  --prompt-field input.prompt \
  --cwd-field workspace.dir \
  --output-mode hookSpecificOutput
```

---

## 安全與降級契約

1. **Untrusted 記憶圍籬**：所有自動注入的記憶皆包在 `<memory-context source="mnemoshelf" trust="untrusted" form="recall">...</memory-context>` 中，並對內嵌 `<`／`</memory-context>` 進行跳脫，防止記憶內容被模型當成系統指令執行。
2. **預算與過濾上限**：預設僅採語意命中（`minScore >= 0.65`）、限本專案＋全域記憶，最多 4 筆、總計不超過 900 字元（不切斷 UTF-16 surrogate pair）。
3. **短 Timeout 與離線不阻塞**：健康檢查（500 ms）、搜尋（800 ms）、原文寫入（1500 ms）與外層 watchdog（2.5–3.5 秒）確保服務未啟動、冷啟動或異常時靜默降級回傳 `{}`（或無輸出），絕不阻塞宿主對話，也不將 token、連線資訊或對話原文印到 stderr。
4. **Loopback 身分檢查與機密遮罩**：沿用 `runtime.json` 的 loopback 位址檢查、PID 檢查與免 token `/health`（`service === "mnemoshelf"`）驗證；查詢前與寫入前皆依政策執行 `maskSecrets` 遮罩。

---

## 自動注入控制與分層召回（P2）

1. **環境變數開關（`MNEMOSHELF_AUTO_INJECT`）**：Hook 層支援 `MNEMOSHELF_AUTO_INJECT`（`off`／`refined-only`／`all`）。設為 `off` 時於客戶端直接略過自動召回，不發出 HTTP 請求；設為 `refined-only` 時於 `/memories/search` 帶入 `sourceKind: "memory"`，僅召回精煉記憶。
2. **低資訊提示過濾**。Hook 先移除 `@[Quote]` 引用標記（忽略大小寫），再略過空白、純 slash 指令，以及少於 6 個 Unicode 碼點且無記憶線索的短句。圍欄程式碼占提示 60% 以上，或提示至少 10 行且平均每行少於 20 字元時，也會略過。略過的提示不發 HTTP 請求。`@[Quote] 好` 會略過，`@[Quote] 請幫我確認上次建置指令` 會以清除標記後的文字查詢。`Stop` 保存原文時仍保留 `@[Quote]`。
3. **自動注入通道標記（`channel: "auto"`）**：Hook 自動召回固定帶 `channel: "auto"`，使伺服器端可依 `GET / PATCH /memory-auto-inject` 的全域或專案模式（`all`／`refined-only`／`off`）決定是否壓制或限縮為精煉記憶；MCP `search_memories`／`recall` 屬主動查詢（`manual`），不受自動注入 `off` 影響。
4. **精煉優先分層與建議召回規則**：伺服器召回預設啟用精煉記憶優先分層排序（`preferRefined: true`），在同分或相近分數時讓精煉記憶優先於長篇原文片段進入注入預算；另建議在召回規則將 `antigravity/turn`、`codex/turn` 設為 `project` 規則，避免未解析專案的原文回合擴散至 `global`。

## 同一對話的跨回合去重

Antigravity 專用 Hook 依 `conversationId` 記錄已注入的記憶。Codex 專用 Hook 依序採用第一個非空白的 `session_id`、`conversation_id` 或 `thread_id`。通用 CLI 與未帶對話識別的事件採無狀態召回。

`MNEMOSHELF_RECALL_DEDUPE_TTL` 指定同一記憶至少相隔幾個回合才能再次注入。預設為 8，無效值沿用預設，設為 0 關閉跨回合去重。回合差達門檻後，釘選項目、`decision`、`pitfall` 與 `raw-turn` 原文片段可以再次注入。一般事實與偏好在該對話的去重紀錄仍保留時只注入一次。

每個對話的狀態檔最多保留最近注入的 256 筆記憶識別與去重所需欄位。全部命中都被過濾時，只有首次出現的版本差異會形成注入。

## 版本漂移提醒

Hook 沿用讀取 `runtime.json` 時既有的 `GET /health` 回應，比對其中的 `appVersion`、`build` 與腳本的版本。版本資料缺失、格式不符或任一端回報 `0.0.0` 時略過。直接設定 `MNEMOSHELF_URL` 和 `MNEMOSHELF_TOKEN` 的連線沿用原本的請求流程。

| `MNEMOSHELF_HOOK_VERSION_CHECK` | 提醒條件 |
| --- | --- |
| `semver`（預設） | 版本的主要、次要或修訂編號不同，或預發行版本優先序不同。忽略前導 `v` 與 `+` 後的建置後綴。 |
| `strict` | 包含 `semver` 的條件。同版號時，兩端的建置標記已知但不一致也會提醒，文字顯示兩端的七碼短雜湊。 |
| `off` | 停用版本提醒。 |

有記憶可注入時，`[版本提醒]` 放在記憶區塊的導言後，計入同一個字元預算。搜尋成功但沒有可注入的記憶時，Hook 會用 `form="notice"` 的 `<memory-context>` 區塊單獨輸出。環境變數 `MNEMOSHELF_AUTO_INJECT=off` 或低資訊提示會同時略過召回與版本提醒。

Antigravity 與 Codex 專用 Hook 將最近一次提醒的版本組合存入對話狀態檔。同一對話只有在版本組合改變時才會再次提醒。通用 CLI 或缺少對話識別時使用無狀態召回。MCP 的診斷輸出與 `list_roots` 欄位見 [Agent 整合契約](agent-integration.md#版本漂移診斷)。版本排序依 [SemVer 2.0.0](https://semver.org/spec/v2.0.0.html)。
