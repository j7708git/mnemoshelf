# Codex 自動召回

> 讀者：已在本機執行 Codex 和 Mnemoshelf 的使用者。
>
> 一句話：Codex 送出提示時，可自動附上 Mnemoshelf 找到的相關記憶。
>
> 現在要做：從原始碼建置腳本，將它加到指定專案的 Codex 設定，並審查該 hook。
>
> 依據：Mnemoshelf 的 [Agent 整合契約](agent-integration.md)與 [OpenAI 的 hook 文件](https://learn.chatgpt.com/docs/hooks#userpromptsubmit)。

## 啟用與確認

1. 讓 Mnemoshelf App 保持執行。在設定的「Agent 連線資訊」確認連線資訊檔可用，記下顯示的 `runtime.json` 絕對路徑。
2. 在包含此腳本的 Mnemoshelf 原始碼目錄，用 Node.js 22.14 以上執行 `pnpm install --frozen-lockfile` 和 `pnpm --filter '@mnemoshelf/server...' build`。腳本位於 `packages/server/dist/scripts/codex-recall.js`，可搭配已安裝的 v0.6.0 App。
3. 在要啟用的專案中，將下列設定合併到 `.codex/hooks.json`。若已有 `hooks.UserPromptSubmit`，在陣列內新增一組，保留其他 hook。要跨專案啟用才使用 `~/.codex/hooks.json`，同一專案只設一份以避免重複查詢。

下列範例使用 macOS／Linux shell。將三個括號內的值換成 `runtime.json`、Node.js 執行檔及腳本的絕對路徑。Codex 從介面啟動時可能讀不到終端機的 `PATH`，可先用 `command -v node` 查 Node.js 路徑。

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
    ]
  }
}
```

開啟新的本機 Codex CLI 工作階段，信任該專案，使用 `/hooks` 找到這條命令並審查。用一筆已建好語意向量的合成記憶測試，輸入與它相關的提示，確認 Codex 能參考該筆內容。用戶層的 `hooks.json` 可在 Mnemoshelf 的「連接 Agent」頁重新偵測。該畫面只辨識設定文字，實際執行狀態以 Codex 為準。

## 召回範圍與資料流向

腳本使用 Codex 提供的工作目錄名稱作為專案名稱，或採用命令中明確設定的 `MNEMOSHELF_PROJECT`。有專案名稱時查該專案與全域記憶，無法判定專案時只查全域記憶。若有兩個同名資料夾，請替各專案指定不同名稱，並讓寫入記憶時使用相同名稱。

每次提交提示最多注入四筆語意命中，整段最多 900 字元。查詢透過本機服務執行，命中的記憶會成為 Codex 模型的參考上下文，因此也會傳給該工作階段使用的模型。記憶內容可能過時或包含指令字樣，注入時一律標記為不受信任的參考資料。腳本只查詢記憶。

## 查不到記憶時

沒有相關記憶、模型冷啟動、服務離線、查詢降級或逾時，都會略過注入，提示仍可照常送出。先確認 App 執行中、連線資訊檔存在、記憶的專案範圍相符，再用語意搜尋暖機後重試。要停用時，從 `hooks.json` 移除這一組設定，然後開啟新的 Codex 工作階段。

此範例適用於本機 CLI 的命令 hook。Windows 的命令需依實際 shell 設定 `commandWindows`，目前未驗證。不同 Codex 宿主是否執行本機 hook，請參考 [OpenAI 的 hook 文件](https://learn.chatgpt.com/docs/hooks)。
