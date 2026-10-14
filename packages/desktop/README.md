# @mnemoshelf/desktop（Electron 桌面殼，spike）

Mnemoshelf 的桌面外殼。**本套件目前是 M4 的打包 spike**：目標只有一個——證明
「Electron ＋ electron-builder 打得出來，而且打包後的產物能完整跑完索引→搜尋→縮圖」。

技術決策與實測依據整理在本檔下方（工具版本、asarUnpack 範圍、模型快取位置與已知坑）；
對外的產品方向見 repo 根目錄的 `README.md` 與 `docs/`。

## 這一版做了什麼

- **main process 內啟動 Core 服務**：直接 `import { createServer } from "@mnemoshelf/server"`，
  不另起子行程（單一寫入者契約天然成立）。服務只綁 `127.0.0.1`、`MNEMOSHELF_PORT=0`（OS 指派隨機埠）。
- **模型快取改到 userData**：transformers.js 的 `env.cacheDir` 預設相對於套件安裝位置，
  打包後會落在唯讀的 `app.asar` 內；本殼把 `MNEMOSHELF_MODEL_DIR` 指到
  `app.getPath("userData")/models`，並讓 Core 服務走同一條設定路徑。
- **Web UI 放在 asar 之外**：`extraResources` 把 `packages/web/dist` 複製到 `resources/web`，
  由 Core 服務以 `MNEMOSHELF_WEB_DIR` 同源服務（研究者所謂「同源載入」路線）。
- **原生模組 asar 解包**：`asarUnpack` 讓 better-sqlite3／sqlite-vec／onnxruntime-node／sharp
  的原生二進位落在 `app.asar.unpacked`（Electron 對 `require`／`process.dlopen` 會透明導向）。
- **sqlite-vec 的路徑修正（唯一的繞道）**：`sqlite-vec` 用 `import.meta.resolve()` 算出擴充檔路徑，
  打包後是 asar 內的路徑；但 SQLite 的 C 層 `load_extension()` 直接開檔、不經過 Electron 的 fs 補丁，
  所以會得到 `ENOTDIR`。`src/asar-paths.ts` 在 `better-sqlite3` 的 `loadExtension` 上包一層，
  把 asar 路徑改指到 `app.asar.unpacked`（上游同問題：electron-builder issue #8824）。
- **啟動失敗不留白屏**：服務起不來或 UI 載入失敗時，視窗顯示可讀的錯誤頁。

**刻意不做**（屬 M4 後續卡片）：系統匣／關窗縮匣／單一實例鎖、`safeStorage` token 管理與
`webRequest` 注入、開機自啟、headless 模式、模型下載進度 UI、安裝檔與 CI。

### token（spike 限定）

`MNEMOSHELF_TOKEN` 有值就沿用（與 `pnpm serve` 一致）；沒有的話啟動時產生一組隨機 token，
寫入 `<userData>/spike-token.txt`（`0600`），並把路徑印在啟動 log。使用者把該檔內容貼進
UI 的 token 畫面即可。**正式的 token 管理（`safeStorage` ＋ 自動注入標頭）是下一張卡。**

## 怎麼跑

```bash
pnpm install
pnpm -r build                     # core / embedder / server / web / desktop 全部 build
pnpm --filter @mnemoshelf/desktop dist   # = tsc + electron-builder --dir
./packages/desktop/dist-app/linux-unpacked/mnemoshelf
```

`dist` 產出未封裝目錄（`dist-app/linux-unpacked/`）。開發模式可以直接
`pnpm --filter @mnemoshelf/desktop start`（會退回 repo 內的 `packages/web/dist`）。

> 開發模式下的啟動 log 會說原生模組「解析失敗」、`loadExtension asar 路徑修正：未安裝`：
> 那是因為未打包時 `packages/desktop` 解析不到那些套件（pnpm 的嚴格佈局），而且根本沒有 asar，
> **不代表模組有問題**。探測與修正只在打包產物內有意義。

**務必用 `pnpm` 執行 electron-builder**（例如 `pnpm --filter @mnemoshelf/desktop dist`）。
直接跑 `node_modules/.bin/electron-builder` 時，electron-builder 無法從檔案判定套件管理器、
會退回環境偵測而誤判成 npm，導致 **pnpm 沒有攤平的平台套件**（`@img/sharp-linux-x64`、
`@img/sharp-libvips-linux-x64`、`sqlite-vec-linux-x64`）不會被收進產物——那是安裝檔「跑得起來但
縮圖／向量搜尋壞掉」的無聲故障。

## 驗收用的自動流程（spike 限定）

`scripts/smoke.mjs` 會在 xvfb 下啟動 `--dir` 產物，用真實視窗把
「貼 token → 加入測試資料夾 → 索引 → 搜尋 → 文字預覽 → 圖片縮圖」跑一遍，
每步截圖並寫出 `report.json`：

```bash
# 需要 xvfb-run（Electron 沒有 display 起不來）；第一次跑會下載模型（約 300MB）
node packages/desktop/scripts/smoke.mjs

# 可選參數：--sample-root <dir> --out <dir> --user-data <dir> --query <字串>
# 預設 userData 是 <repo>/.tmp/desktop-spike/userData（乾淨、可重複）；
# 要驗證預設路徑（app.getPath("userData")）就 --user-data 指過去，
# 但那個目錄不能已經加入過同一個資料夾（會回 409「此目錄已經加入過」）。
```

會被讀取的環境變數（由 `scripts/smoke.mjs` 設定，也可手動帶）：

| 變數 | 用途 |
|---|---|
| `MNEMOSHELF_SPIKE_AUTOTEST` | 要加入的測試資料夾；有值才啟用自動流程 |
| `MNEMOSHELF_SPIKE_AUTOTEST_OUT` | 截圖與 `report.json` 的輸出目錄 |
| `MNEMOSHELF_SPIKE_QUERY` | 搜尋字串（預設 `Electron 桌面打包`） |
| `MNEMOSHELF_SPIKE_TEXT` / `MNEMOSHELF_SPIKE_IMAGE` | 樣本檔名（預設 `hello.txt` / `picture.png`） |
| `MNEMOSHELF_SPIKE_INDEX_TIMEOUT_MS` | 索引（含首次下載模型）的等待上限 |
| `MNEMOSHELF_DESKTOP_USER_DATA` | 覆寫 `app.getPath("userData")`（驗收用乾淨目錄） |

自動流程只操作真正的 UI（在 renderer 內以 DOM 事件驅動），不會繞過 UI 直接打 API；
它只是讓「打包產物在跑」這件事可重複驗證，不是產品功能。
