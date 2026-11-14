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

- `PreInvocation` 預設採 `first-turn+explicit`：每個新使用者提問自動召回一次，同一回合的多步工具迴圈內不重複注入；若需每步都召回，可設 `MNEMOSHELF_RECALL_MODE=every-turn`。
- `Stop` 在回合正常結束時解析 `transcript.jsonl`（排除 `thinking`、`tool_calls`、工具輸出與系統注入），並透過 `POST /memory-sources` 等冪保存對話原文。

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

---

## 生命週期事件與欄位對照表

| Harness | Preset (`--preset`) | 召回事件 | 提示欄位 (`--prompt-field`) | 工作目錄欄位 (`--cwd-field`) | 輸出模式 (`--output-mode`) | 原文保存 (`Stop`) |
| --- | --- | --- | --- | --- | --- | --- |
| Antigravity | `antigravity`（或專用 `antigravity-hook.js`） | `PreInvocation` | `lastUserInput` | `workspacePaths.0` | `injectSteps` | 支援（`antigravity-hook.js stop`） |
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
