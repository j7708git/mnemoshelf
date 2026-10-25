# 建置與安裝（桌面版）

Mnemoshelf 是可離線使用的桌面應用程式（Electron），原始碼在 `packages/desktop`。
本頁說明如何**從原始碼建置**、**各平台的產物**、**下載安裝檔時的簽章與公證警告怎麼處理**，
以及**第三方授權（含 LGPL-3.0 的 libvips）**的合規資訊。

## 環境需求

- **Node.js >= 22.14.0**（`better-sqlite3` 的 N-API 版本需求；Electron 內建 Node 24 不受影響）。
- **pnpm 10.x**（repo 的 `packageManager` 欄位已釘住版本；用 corepack 或自行安裝皆可）。
- 各平台用**原生**環境建置；**不要從 Linux 交叉建 macOS**（簽章與工具鏈都在 macOS 上）。
- 無顯示環境（例如伺服器、CI）要跑 Electron 時需要 `xvfb`。

## 從原始碼建置

```bash
pnpm install --frozen-lockfile
pnpm build                                    # core / embedder / server / web / desktop 依序編譯
pnpm --filter @mnemoshelf/desktop dist        # 未封裝目錄（electron-builder --dir），開發與驗收用
```

`dist` 產出 `packages/desktop/dist-app/` 底下的未封裝目錄，**目錄名含架構後綴**：
Linux x64 為 `linux-unpacked`、Linux arm64 為 `linux-arm64-unpacked`（非 x64 才有架構後綴）。
（解析未封裝目錄的 `findUnpackedDir` 是**打包後 smoke 的 Linux 專用**工具，macOS／Windows 的
未封裝目錄名不在它的涵蓋範圍。）可直接執行裡面的 `mnemoshelf` 執行檔。開發模式另可用
`pnpm --filter @mnemoshelf/desktop start`。

要產出**安裝檔**：

```bash
pnpm --filter @mnemoshelf/desktop run dist:linux   # Linux：AppImage + tar.gz
pnpm --filter @mnemoshelf/desktop run dist:mac     # macOS（Apple Silicon）：dmg
pnpm --filter @mnemoshelf/desktop run dist:win     # Windows x64：NSIS 安裝檔
```

產物在 `packages/desktop/dist-app/`。

> **務必用 pnpm 呼叫 electron-builder**（上面的 script 已經包好 `pnpm run build && electron-builder …`）。
> 直接執行 `node_modules/.bin/electron-builder` 時，electron-builder 無法從檔案判定套件管理器、
> 會退回環境偵測而誤判成 npm，導致 **pnpm 沒有攤平的平台套件**（`@img/sharp-*`、
> `@img/sharp-libvips-*`、`sqlite-vec-*`）不會被收進產物——那是「裝得起來，但縮圖／向量搜尋壞掉」
> 的無聲故障。

## 各平台產物

安裝檔命名由 `packages/desktop/electron-builder.yml` 的 `artifactName` 決定，一律含平台與架構。

| 目標平台 | 建置環境（CI runner） | 產物 |
|---|---|---|
| Linux x64 | `ubuntu-latest` | `Mnemoshelf-<版本>-linux-x86_64.AppImage`、`Mnemoshelf-<版本>-linux-x64.tar.gz` |
| Linux arm64 | `ubuntu-24.04-arm` | `Mnemoshelf-<版本>-linux-arm64.AppImage`、`Mnemoshelf-<版本>-linux-arm64.tar.gz` |
| macOS（Apple Silicon） | `macos-latest`（現行為 arm64） | `Mnemoshelf-<版本>-mac-arm64.dmg` |
| Windows x64 | `windows-latest` | `Mnemoshelf-<版本>-win-x64.exe`（NSIS 安裝程式） |

> Linux 產物名稱中的 x64 在 AppImage 會寫成 `x86_64`、在 tar.gz 寫成 `x64`
> （electron-builder 對不同 target 的架構正規化不同）。上表的 Linux 名稱是實測結果；
> macOS／Windows 的產物名稱依同一套命名規則（尚未在實機產出）。

安裝檔裡也帶著 **MCP 入口**，讓採用 `mcpServers` JSON 設定的 MCP client（Claude Code、Cursor、
Cline 等）連上本機服務：入口在
`<安裝目錄>/resources/app.asar.unpacked/node_modules/@mnemoshelf/server/dist/scripts/mcp.js`
（**不是** `app.asar` 裡——一般 `node` 讀不到 asar 內的虛擬檔案系統）。
桌面版設定頁的「複製 MCP 設定片段」會直接產生含正確路徑的設定：片段的 `command` 是
**應用程式自己的 Electron 執行檔**，並帶 `ELECTRON_RUN_AS_NODE=1` 讓它以一般 Node.js 身分
執行入口腳本，因此使用者的機器**不需要另外安裝 Node.js**（需要 `RunAsNode` fuse 未被關閉；
本專案沒有關閉任何 fuse）。片段不含 token、也不含服務網址，憑證由入口執行時讀 `runtime.json`。
其他 client 的設定形狀可能不同，見 [agent-integration.md](agent-integration.md) §MCP 設定片段。

> **Electron-as-node 的取捨**：保留 `RunAsNode` fuse 讓本機程式可以用這個**已簽章**的應用程式
> 執行檔執行任意 Node 腳本（多了一個可執行的 Node 入口），這是刻意的便利交換。**更新或移除
> 應用程式前要先停掉 MCP client**（client 記住舊路徑）；**AppImage 的掛載點不固定**，不建議
> 用這個片段（設定頁在 AppImage 環境不會產生片段，請改用環境變數連線或解壓後的版本）。
> 完整說明見 [agent-integration.md](agent-integration.md) §入口路徑與執行方式。

## 下載安裝檔（ad-hoc 簽章、未公證）

本專案的 macOS 安裝檔使用 **ad-hoc 簽章**（無身份證明的自我簽章，`identity: "-"`）——
它讓 macOS 接受執行檔，但**沒有開發者憑證、也未經公證**（沒有購買簽署憑證）；
Windows 安裝檔則**未簽章**。因此第一次開啟時，
系統會出現警告——這是預期行為。請確認安裝檔來自本專案的 GitHub Release，再用下列方式開啟：

- **Windows**：SmartScreen 視窗 →「**更多資訊**」→「**仍要執行**」。
- **macOS**：安裝檔只有 ad-hoc 簽章、未公證，在 Apple Silicon 上**右鍵 → 打開不一定可用**（常見是直接
  顯示「**已損毀，無法打開**」，此時右鍵選單裡不會有「打開」選項）。請依序嘗試：
  1. **系統設定 → 隱私權與安全性** → 捲到「安全性」區塊：若出現「**仍要打開**」按鈕
     （會列出被擋下的 App 名稱），按它並輸入密碼後即可開啟。
  2. 若沒有該按鈕、或顯示「已損毀」：在**終端機**移除隔離屬性後再開（這對未公證的
     App 通常是最後有效的一招）：
     ```bash
     xattr -dr com.apple.quarantine /Applications/Mnemoshelf.app
     ```
     （路徑依你實際放置的位置調整；`-r` 連同 App 內所有檔案一起處理。）
  3. 若以上都不行，請回報當時看到的**完整錯誤訊息**，再對症處理。
- **Linux AppImage**：下載後 `chmod +x <檔名>` 再執行（需要 FUSE；沒有 FUSE 時可用
  `--appimage-extract` 解開後執行）。

因為沒有開發者簽章與公證，本專案也**沒有 auto-update**：要更新請重新下載新版本安裝檔。

## 授權清單與 LGPL 合規

第三方授權清單由 pnpm 產生（以 desktop 為主的 production 相依閉包；各平台各自產生一份，
內容反映該平台實際隨附的套件）：

```bash
pnpm --filter "@mnemoshelf/desktop..." licenses list --prod --long
```

重點：縮圖使用的 `sharp` 會隨附**預編 libvips**，而 libvips 採 **LGPL-3.0-or-later**：

- Linux／macOS：獨立的平台套件 `@img/sharp-libvips-<平台>`（例如 `lib/libvips-cpp.so.<版本>`）。
- Windows x64：libvips 的 DLL 打包在 `@img/sharp-win32-x64` 內，該套件授權為
  `Apache-2.0 AND LGPL-3.0-or-later`。

本 repo 的 [`docs/licenses/`](licenses/) 提供：

- [`LGPL-3.0.txt`](licenses/LGPL-3.0.txt) 與 [`GPL-3.0.txt`](licenses/GPL-3.0.txt)：授權全文
  （LGPL-3.0 以 GPL-3.0 為基礎）。
- [`THIRD-PARTY-NOTICES.md`](licenses/THIRD-PARTY-NOTICES.md)：哪些套件是 LGPL、對應原始碼的
  取得方式，以及如何替換該 shared library。

每個 GitHub Release 都會附上：各平台的 `third-party-licenses-<平台>.txt`、
`LGPL-3.0.txt`、`GPL-3.0.txt`、`THIRD-PARTY-NOTICES.md`。

## 發版（CI）

發版由 GitHub Actions 的 `.github/workflows/desktop-release.yml` 負責：

- 推送 `v*` tag（例如 `v0.1.0`）：四條管線（Linux x64／Linux arm64／macOS arm64／Windows x64）
  各以原生 runner 建置，Linux 打包後會跑一次 headless smoke（在 xvfb 內啟動並檢查 `/health`
  與 token 驗證）；Linux x64 另外會跑 `bootstrap,index` 的真正索引 smoke（會觸發 worker／
  embedder；模型優先從 Actions cache 還原，cache miss 時從內部 Release `model-cache-q4-v1`
  下載固定快取，避免每次重新連 Hugging Face），最後由獨立的 release job 建立 GitHub Release 並附上安裝檔與授權資料。
  建置前會先跑 `pnpm typecheck`、`pnpm build`、`pnpm test`（verify job），全綠才發布。
- 手動觸發（`workflow_dispatch`）：**不**建立正式 Release、也不上傳 artifacts（避開 Actions
  artifact 額度）；macOS arm64 會把 dmg 與授權清單放進 **草稿 Release**（tag 為
  `mac-test-<run id>-<attempt>`），適合在 Actions artifact 額度不足時取測試包；草稿 Release 不是
  正式版本，測完可刪。
- tag 去 `v` 後的版本號會在建置時寫入 app 版本，因此安裝檔版本與 tag 一致。

## 隱私掃描（密鑰與個人本機路徑）

repo 內有一支可獨立執行的掃描 `.github/scripts/scan-repo.sh`，由
`.github/workflows/privacy-scan.yml` 在**所有分支的 push**、`v*` 版本 tag、pull request 與
手動觸發時執行。它是**事後偵測**：內容推上來之後才檢查，不是推送當下的阻擋。

- **密鑰**：gitleaks（釘住 8.30.1；CI 下載官方 release 並驗 sha256），設定在 `.gitleaks.toml`。
  掃描一律帶 `--ignore-gitleaks-allow`，且不把 `.gitleaksignore` 放進掃描目標，repo 內的
  忽略檔或行內 `# gitleaks:allow` 不能讓發現消失。
- **個人本機路徑**：`.github/scripts/check-personal-paths.py` 讀
  `.github/repo-privacy-policy.json`，比對家目錄形式的絕對路徑（家目錄前綴後面接個人帳號）。
  檔案不會因為是 UTF-16、含 NUL、非 UTF-8 或超過 `maxFileBytes` 而被跳過（最後者改成逐行
  串流）；真的讀不到的檔案會列出來並以退出碼 `2` 結束。

**規則來源**：這個 repo 的規則以 `.github/repo-privacy-policy.json`（個人路徑）與
`.gitleaks.toml`（密鑰）為準。工作區層級另有 `.openchamber/repo-privacy-policy.json` 給
**其他專案**的本機 hook 使用；兩份目前內容相同，但**各自獨立、沒有同步機制**——改規則時
兩邊都要改。CI 一律以 `personalPathSeverity = high` 擋下：政策值只影響輸出顯示，即使政策檔
把等級調低，CI 仍會失敗（比本機 hook 更嚴，避免兩邊分叉）。

**掃描哪些內容**：輸出會標明這次是「樹掃描」「範圍掃描」或「兩者都做」。

- **樹掃描**：目前工作樹「會進版控的檔案」（已追蹤，以及未追蹤但未被 `.gitignore` 忽略的
  檔案）。判準是**會不會進版控**，不是目錄名稱——用 `git add -f` 加進來的 `out/`、`dist/`
  檔案照樣會掃；被忽略的生成物本來就不在清單裡。五種常見 lockfile（`pnpm-lock.yaml`、
  `package-lock.json`、`yarn.lock`、`deno.lock`、`npm-shrinkwrap.json`）也會掃。
- **範圍掃描**：這次事件帶來的 commit 內容。push 用 `before..after`；`before` 全為 0
  （新建分支／tag）時退回「上一個 `v*` tag..head」。pull request 用「合併基底..PR head」。
  另外會掃該範圍的差異文字（個人路徑），抓得到「同一批 push 裡先加後刪」的內容。
  取不到 PR 基底時退回只有樹掃描，並在輸出說明——那代表覆蓋範圍較小，不是「乾淨」的證明。

**CI 不涵蓋**：更早的歷史 commit（除非落在這次範圍內）、force push 覆蓋掉的中間 commit、
commit message 與 PR 描述、GitHub 以外的備份，以及推送當下的即時阻擋（事前阻擋靠本機
hook 與 GitHub 免費的 push protection，後者只擋已知廠商憑證格式）。

**支援範圍**：本機執行需要 **Linux 或 macOS**；Windows 請用 **Git Bash 或 WSL**（原生
PowerShell 不支援）。需要 `gitleaks` 8.30.1 在 `PATH`，以及 Python 3（預設用 `python3`，
可用環境變數 `PYTHON` 指定解譯器）。

```bash
bash .github/scripts/scan-repo.sh                # 掃描本 repo（本機沒有事件範圍時只做樹掃描）
bash .github/scripts/scan-repo.sh --self-test    # 在暫存目錄建合成樣本，驗證 scanner 不是 no-op
```

退出碼：`0` 乾淨、`1` 有發現（log 只列出 `檔案:行號` 與類型，不會印出密鑰原文或命中的路徑）、
`2` 掃描沒有完成——包含工具／設定錯誤、範圍掃描失敗，以及**有檔案被跳過**（例如讀取失敗）；
這種情況**不代表乾淨**。CI 失敗時請依指出的位置修正；不要用跳過 workflow 的方式合併。

## 已知限制

- **ad-hoc 簽章、未公證**：安裝時需依上面「下載安裝檔」一節繞過系統警告；沒有 auto-update。
- **macOS 只支援 Apple Silicon（arm64）**。
- **macOS 的自啟可能不生效**：自啟走 SMAppService（由系統管理登入項目），**ad-hoc 簽章
  （未公證）的版本可能被系統擋下而靜默無效**；而且 macOS 的登入啟動**不會**收到 `--hidden` 之類的自啟參數
  （`setLoginItemSettings` 的 `path`／`args` 是 Windows-only），桌面殼改以
  `wasOpenedAtLogin` 推導「登入時啟動」來避免彈出視窗。
- **Linux 的縮圖**使用 sharp 時會在行程 stderr 印出 glib 相關訊息（功能正常，是 Electron 與
  sharp 在 Linux 的已知問題）。
- 執行時需要網路才能**首次下載 embedding 模型**（約 300 MB，存在使用者資料目錄）；安裝檔本身
  不含模型。
