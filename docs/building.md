# 建置與安裝（桌面版）

Mnemoshelf 是可離線使用的桌面應用程式（Electron），原始碼在 `packages/desktop`。
本頁說明如何**從原始碼建置**、**各平台的產物**、**下載安裝檔時的未簽署警告怎麼處理**，
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

`dist` 產出 `packages/desktop/dist-app/linux-unpacked/`（依平台目錄名不同），可直接執行裡面的
`mnemoshelf` 執行檔。開發模式另可用 `pnpm --filter @mnemoshelf/desktop start`。

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

## 下載安裝檔（未簽署）

本專案的安裝檔**未經程式碼簽署，也沒有 macOS 公證**（沒有購買簽署憑證）。因此第一次開啟時，
系統會出現警告——這是預期行為。請確認安裝檔來自本專案的 GitHub Release，再用下列方式開啟：

- **Windows**：SmartScreen 視窗 →「**更多資訊**」→「**仍要執行**」。
- **macOS**：在 Finder 對 App 按**右鍵** → 選「**打開**」→ 在跳出的視窗再按一次「**打開**」。
  （直接雙擊會被 Gatekeeper 擋下；右鍵開啟只需要做一次。）
  也可以在終端機移除隔離屬性：
  `xattr -dr com.apple.quarantine /Applications/Mnemoshelf.app`。
- **Linux AppImage**：下載後 `chmod +x <檔名>` 再執行（需要 FUSE；沒有 FUSE 時可用
  `--appimage-extract` 解開後執行）。

因為沒有簽章，本專案也**沒有 auto-update**：要更新請重新下載新版本安裝檔。

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
  與 token 驗證），最後由獨立的 release job 建立 GitHub Release 並附上安裝檔與授權資料。
  建置前會先跑 `pnpm typecheck`、`pnpm build`、`pnpm test`（verify job），全綠才發布。
- 手動觸發（`workflow_dispatch`）：只建置並上傳 artifacts，**不**建立 Release（測試用）。
- tag 去 `v` 後的版本號會在建置時寫入 app 版本，因此安裝檔版本與 tag 一致。

## 已知限制

- **未簽章 / 未公證**：安裝時需依上面「下載安裝檔」一節繞過系統警告；沒有 auto-update。
- **macOS 只支援 Apple Silicon（arm64）**。
- **Linux 的縮圖**使用 sharp 時會在行程 stderr 印出 glib 相關訊息（功能正常，是 Electron 與
  sharp 在 Linux 的已知問題）。
- 執行時需要網路才能**首次下載 embedding 模型**（約 300 MB，存在使用者資料目錄）；安裝檔本身
  不含模型。
