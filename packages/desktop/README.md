# @mnemoshelf/desktop（Electron 桌面殼）

Mnemoshelf 的桌面外殼。負責把 Core 服務包成「桌面應用程式該有的樣子」，並用
electron-builder 打包（`--dir` 產物供本機實跑驗收）。

技術決策與實測依據整理在本檔下方（工具版本、asarUnpack 範圍、模型快取位置與已知坑）；
對外的產品方向見 repo 根目錄的 `README.md` 與 `docs/`。

## 這一版做了什麼

- **main process 內啟動 Core 服務**：直接 `import { createServer } from "@mnemoshelf/server"`，
  不另起子行程（單一寫入者契約天然成立）。服務只綁 `127.0.0.1`、`MNEMOSHELF_PORT=0`（OS 指派隨機埠）。
- **token 由應用自己管**：第一次啟動產生 32 bytes 的隨機 token，用 Electron `safeStorage`
  **加密**保存在 `<userData>/token.bin`（`0600`），之後每次啟動沿用。所有送往本機服務的請求由
  main process 以 `session.defaultSession.webRequest.onBeforeSendHeaders` 注入
  `Authorization: Bearer …`，**renderer 完全看不到 token，使用者不必手動貼**。
  - `MNEMOSHELF_TOKEN` 有值時沿用（與 `pnpm serve`／MCP 的用法一致）。
  - 環境沒有可用的加密後端時（例如 Linux 沒有金鑰庫），改成「只在本次執行有效的 token」並在
    設定畫面說明，**不寫明碼檔**。
- **系統匣 ＋ 關窗縮到匣**：關閉視窗只隱藏，服務繼續跑；匣選單提供「開啟主視窗／離開」。
  單一實例鎖（`requestSingleInstanceLock`）避免兩個行程搶同一個 SQLite／埠；第二次啟動會把
  既有視窗帶到前景後自行結束。
- **首次啟動預先下載模型（含進度與重試）**：模型是 lazy 載入的，第一次索引才會下載（約 300 MB）。
  桌面殼改成啟動時先確認 `<userData>/models` 是否就緒，未就緒就下載並把進度推給 UI
  （`BootstrapScreen`），失敗可重試；下載中斷（程序被砍）留下的暫存檔會在下次啟動清掉，
  **已完成的檔案一律保留**（transformers.js 的快取是 tmp ＋ rename）。
- **開機自啟開關（預設關）**：設定畫面一個開關；Linux 寫 XDG autostart 檔
  （`<XDG_CONFIG_HOME|~/.config>/autostart/mnemoshelf.desktop`，`Exec` 帶 `--hidden`），
  macOS／Windows 走 `app.setLoginItemSettings`（由系統管理，沒有落地檔案）。
- **headless 模式**：`--headless` 不開視窗、不建系統匣，只跑 Core 服務（仍需要 GUI session，
  見下方「已知限制」）。`--hidden` 則是「有視窗但不主動顯示」（開機自啟時用，從系統匣叫回來）。
- **模型快取改到 userData**：transformers.js 的 `env.cacheDir` 預設相對於套件安裝位置，
  打包後會落在唯讀的 `app.asar` 內；本殼把 `MNEMOSHELF_MODEL_DIR` 指到
  `app.getPath("userData")/models`，並讓 Core 服務走同一條設定路徑。
- **Web UI 放在 asar 之外**：`extraResources` 把 `packages/web/dist` 複製到 `resources/web`，
  由 Core 服務以 `MNEMOSHELF_WEB_DIR` 同源服務。
- **production node_modules asar 解包**：`worker_threads` 不能讀 asar 內的檔案；`asarUnpack`
  把整個 production `node_modules` 解包到 `app.asar.unpacked`，涵蓋 worker 的 JS 依賴
  （`@mnemoshelf/embedder-transformers`、`@huggingface/transformers`）與 better-sqlite3／
  sqlite-vec／onnxruntime-node／sharp 的原生二進位。app 自身 `dist/**` 仍留在 asar。
- **sqlite-vec 的路徑修正（唯一的繞道）**：`sqlite-vec` 用 `import.meta.resolve()` 算出擴充檔路徑，
  打包後是 asar 內的路徑；但 SQLite 的 C 層 `load_extension()` 直接開檔、不經過 Electron 的 fs 補丁，
  所以會得到 `ENOTDIR`。`src/asar-paths.ts` 在 `better-sqlite3` 的 `loadExtension` 上包一層，
  把 asar 路徑改指到 `app.asar.unpacked`（上游同問題：electron-builder issue #8824）。
- **啟動失敗不留白屏**：服務起不來或 UI 載入失敗時，視窗顯示可讀的錯誤頁。

## desktop shell API（renderer 端）

preload（`src/preload.cts` → `dist/preload.cjs`）用 `contextBridge` 掛上
`window.mnemoshelfDesktop`（sandbox 只支援 CommonJS preload，所以用 `.cts`）。契約在
`src/desktop-api.ts`，web 端的鏡像在 `packages/web/src/desktop.ts`：

| 成員 | 說明 |
|---|---|
| `kind`／`apiVersion`／`platform` | 桌面模式識別（web 端據此決定要不要顯示 token 表單） |
| `bootstrap.getState()` | 目前的模型下載狀態 |
| `bootstrap.retry()` | 重新檢查並（必要時）重試下載 |
| `bootstrap.onUpdate(listener)` | 訂閱狀態推播；回傳取消訂閱函式 |
| `settings.get()` | 應用版本、token **保存狀態**（不含 token）、開機自啟狀態 |
| `settings.setAutostart(enabled)` | 切換開機自啟；回傳更新後的設定 |

**renderer 拿不到 token**：介面只回傳狀態，token 只留在 main process。

## 怎麼跑

```bash
pnpm install
pnpm -r build                             # core / embedder / server / web / desktop 全部 build
pnpm --filter @mnemoshelf/desktop dist    # = tsc + electron-builder --dir
./packages/desktop/dist-app/linux-unpacked/mnemoshelf
```

`dist` 產出未封裝目錄，**目錄名含架構後綴**（x64 為 `dist-app/linux-unpacked/`，
arm64 為 `dist-app/linux-arm64-unpacked/`）。開發模式可以直接
`pnpm --filter @mnemoshelf/desktop start`（會退回 repo 內的 `packages/web/dist`）。

要產出**安裝檔**（發版用）改用：

```bash
pnpm --filter @mnemoshelf/desktop run dist:linux   # AppImage + tar.gz
pnpm --filter @mnemoshelf/desktop run dist:mac     # dmg（Apple Silicon）
pnpm --filter @mnemoshelf/desktop run dist:win     # NSIS 安裝檔（x64）
```

三平台各自在原生環境建置（不要從 Linux 交叉建 macOS）；發版由 GitHub Actions 的
`desktop-release.yml` 負責（推送 `v*` tag 時建置並建立 Release）。完整的建置說明、
安裝檔的簽章狀態（macOS 為 ad-hoc 簽章、未公證；Windows 未簽章）與開啟方式、授權
（LGPL-3.0 的 libvips）見 **`docs/building.md`**。

命令列選項：

| 選項 | 效果 |
|---|---|
| `--headless` | 不開視窗、不建系統匣，只跑 Core 服務（需要 GUI session 才起得來，見下） |
| `--hidden` | 建立視窗但不主動顯示（開機自啟用；從系統匣選單叫回來） |

會被讀取的環境變數：

| 變數 | 用途 |
|---|---|
| `MNEMOSHELF_TOKEN` | 有值時沿用這組 token（不加密落地） |
| `MNEMOSHELF_DESKTOP_USER_DATA` | 覆寫 `app.getPath("userData")`（驗收用乾淨目錄） |
| `MNEMOSHELF_PORT` | 覆寫監聽埠（預設 0＝隨機埠；headless 驗收用固定埠） |
| `MNEMOSHELF_WEB_DIR` | 覆寫 Web UI 目錄 |

> 開發模式下的啟動 log 會說原生模組「解析失敗」、`loadExtension asar 路徑修正：未安裝`：
> 那是因為未打包時 `packages/desktop` 解析不到那些套件（pnpm 的嚴格佈局），而且根本沒有 asar，
> **不代表模組有問題**。探測與修正只在打包產物內有意義。

**務必用 `pnpm` 執行 electron-builder**（例如 `pnpm --filter @mnemoshelf/desktop dist`）。
直接跑 `node_modules/.bin/electron-builder` 時，electron-builder 無法從檔案判定套件管理器、
會退回環境偵測而誤判成 npm，導致 **pnpm 沒有攤平的平台套件**（`@img/sharp-linux-x64`、
`@img/sharp-libvips-linux-x64`、`sqlite-vec-linux-x64`）不會被收進產物——那是安裝檔「跑得起來但
縮圖／向量搜尋壞掉」的無聲故障。

## 驗收用的自動流程

`scripts/smoke.mjs` 會在 xvfb 下啟動 `--dir` 產物，用真實視窗跑完桌面殼的行為，每步截圖並寫出
`report.json`。四個子命令：

```bash
# 需要 xvfb-run（Electron 沒有 display 起不來）
node packages/desktop/scripts/smoke.mjs gui        # 模型狀態→桌面模式→單一實例→瀏覽器模式→索引／搜尋→自啟→系統匣
node packages/desktop/scripts/smoke.mjs interrupt  # 下載中斷（SIGKILL）→ 重啟沿用已下載檔案並完成
node packages/desktop/scripts/smoke.mjs headless   # --headless：沒有視窗，curl 帶 token 打服務
node packages/desktop/scripts/smoke.mjs hidden     # --hidden：視窗已建立且 UI 已載入，但不主動顯示
node packages/desktop/scripts/smoke.mjs all        # 以上四個依序跑
```

選項：`--out <dir>`、`--user-data <dir>`、`--sample-root <dir>`、`--only <情境>`、`--skip-build`。
情境可用 `bootstrap,app,single,browser,index,autostart,tray`。

- 產物在 `<out>`（預設 `«repo»/.tmp/desktop-shell/`）：`report-gui/report.json`、各步驟截圖、
  各次啟動的完整 log、`summary.json`（摘要）。
- **`XDG_CONFIG_HOME` 一律指到 `.tmp/` 底下**，開機自啟的驗收不會動到使用者真正的
  `~/.config/autostart`。
- `gui` 每次會清掉 userData 的 `data/`（保留 `models/` 快取），因此可以重複跑；
  要驗「首次下載」請用乾淨的 userData（或直接跑 `interrupt`）。
- 第一次跑會下載模型（約 300 MB）。

應用端讀取的環境變數（由驅動腳本設定，也可手動帶）：

| 變數 | 用途 |
|---|---|
| `MNEMOSHELF_AUTOTEST` | 情境清單（逗號分隔）或 `all`；有值才啟用自動流程 |
| `MNEMOSHELF_AUTOTEST_OUT` | 截圖與 `report.json` 的輸出目錄 |
| `MNEMOSHELF_AUTOTEST_SAMPLE_ROOT` | `index` 情境要加入的測試資料夾 |
| `MNEMOSHELF_AUTOTEST_TEXT` / `_IMAGE` | 樣本檔名（預設 `hello.txt` / `picture.png`） |
| `MNEMOSHELF_AUTOTEST_QUERY` | 搜尋字串 |
| `MNEMOSHELF_AUTOTEST_KILL_AFTER_PROGRESS=1` | 只確認下載進度出現就停住（讓驅動腳本砍掉行程） |
| `MNEMOSHELF_AUTOTEST_STEP_TIMEOUT_MS` / `_INDEX_TIMEOUT_MS` / `_BOOTSTRAP_TIMEOUT_MS` | 各階段等待上限 |

自動流程只操作真正的 UI（在 renderer 內以 DOM 事件驅動），不會繞過 UI 直接打 API；
「系統匣 → 離開」「顯示主視窗」用的也是產品程式碼匯出的同一個函式。**不是產品功能。**

## 已知限制

- **headless 仍需要 GUI session**：Electron 沒有 display 起不來（M0 spike 實測）。伺服器上要跑
  headless 請用 `xvfb-run`（或不使用桌面殼，直接跑 `packages/server`）。
- **macOS／Windows 未實測**：本卡只在 Linux 實跑；macOS／Windows 的自啟與系統匣（`...Template`
  圖示、Windows `guid`）只做了文件審查與程式碼層的處理，尚未實機驗證。
- **macOS 自啟的已知限制**：自啟走 SMAppService，**ad-hoc 簽章（未公證）的版本可能不生效**
  （系統會擋下沒有有效簽章的登入項目）；而且 `setLoginItemSettings` 的 `--hidden` 是經由 `path`／`args` 傳遞，那兩個參數是
  **Windows-only**，macOS 的登入啟動拿不到它們。桌面殼因此改用 `app.getLoginItemSettings().wasOpenedAtLogin`
  推導「這次是登入時啟動」，據此不顯示視窗並隱藏 Dock 圖示（與 Linux／Windows 的 `--hidden` 等效）。
- **本機環境沒有桌面環境變數時**（例如從 tty／systemd 啟動），Chromium 認不出桌面環境會退到
  `basic_text` 後端、`safeStorage` 不可用；桌面殼偵測到這種情況會明確指定 libsecret 後端，
  仍失敗時才降級成「本次執行有效的 token」。
- 圖片縮圖在 Linux 會印出 sharp 的 glib 訊息（縮圖本身正確），來源是 Electron／sharp 的已知問題。
- `app.asar.unpacked` 目前由 `asarUnpack: "**/node_modules/**"` 產生：production `node_modules`
  全部解包（worker 的 JS 依賴也必須是真實檔案，不只原生 `.node`／`.so`）；新增依賴時不必再
  逐項列出，但要注意它們都會落在 unpacked。
