# 應用程式內更新

Mnemoshelf 桌面版會從本專案的 GitHub Release 檢查新版本。**Linux AppImage 與 Windows NSIS
可以在 App 內下載並安裝**；macOS 只檢查版本、開啟下載頁，由使用者手動安裝。其他安裝形式
（Linux tar.gz、自行解壓的目錄）請手動下載替換。

更新相關的程式碼在 `packages/desktop/src/updater/`；本頁是使用者與維運者看的行為說明。

## 支援矩陣

| 平台／安裝形式 | 檢查 | App 內下載 | App 內安裝 | 更新來源 |
|---|---|---|---|---|
| Linux AppImage（x64／arm64） | ✅ | ✅ | ✅（替換目前 AppImage 後重新啟動） | `latest-linux.yml`／`latest-linux-arm64.yml` |
| Windows NSIS 安裝檔（x64） | ✅ | ✅ | ✅（執行 NSIS 安裝程式） | `latest.yml` |
| macOS dmg（Apple Silicon） | ✅（GitHub API） | ❌ | ❌（只開啟 Release 下載頁） | GitHub Releases |
| Linux tar.gz／手動解壓目錄 | ❌ | ❌ | ❌ | 手動下載替換 |
| `--appimage-extract-and-run` 啟動 | ❌ | ❌ | ❌ | 手動下載替換 |
| `--headless`、開發模式（未打包） | ❌ | ❌ | ❌ | — |

- 更新只會**升級**：目前版本等於或高於 Release 版本時不會提示，也不會自動降級。
- 目前版本或 Release 是 prerelease 時，穩定版檢查不會把它當成更新。
- 自動更新的檢查在啟動後約 30 秒第一次執行，之後每 6 小時一次；使用者也可以手動按「檢查更新」。

> **驗證範圍**：Linux AppImage 是本專案的主要支援與驗收路徑。**0.5.0 → 0.5.1 已在 Linux
> AppImage 完成真實的 App 內更新**（檢查、下載、備份與替換安裝檔都成功，更新後的自動重啟
> 也已確認）。
> Windows NSIS 與 macOS 的更新流程尚未在本專案實機驗證，行為依 electron-updater 6.8.11 的
> 原始碼與目前設定推導。

### 已實證：0.5.0 → 0.5.1（Linux AppImage）

2026-10-28 以 0.5.0 的 Linux x64 AppImage 對真實的 GitHub Release feed 跑過完整流程：

- 檢查→下載→「重啟並安裝」；更新後版本 `0.5.0 → 0.5.1`，`GET /health` 的 `appVersion` 與
  `build` 都換成新版本的值。
- 安裝檔換成 `Mnemoshelf-0.5.1-linux-x86_64.AppImage`，舊檔已移除；新檔 SHA-512 與
  `latest-linux.yml` 相符。
- 更新前備份 `pre-update-0.5.0-to-0.5.1/` 建立成功（目錄 `0700`、DB `0600`、只含資料庫）。
- 資料保全：`memories`／`chunks`／`roots` 筆數不變、資料庫檔位元組相同；roots、token
  （帶 token `200`／不帶 `401` 的對照）與模型快取都沿用。
- 用更新後 AppImage 內附的 MCP 入口可完成 `initialize`／`tools/list`／`recall`。
- App 自動重新啟動，新實例的 `/health` 回 `0.5.1`。

這是一次 Linux x64 的實證，不代表 Windows／macOS 已驗證；其他安裝形式仍請手動替換。

## 檢查、下載與安裝

1. **檢查**：App 向 GitHub Release 取得 `latest*.yml`（macOS 走 GitHub API），比較版本。
   有新版本時只顯示版本與 Release notes，**不會自動下載**。
2. **下載**：使用者按下「下載」才開始；畫面顯示進度。下載完成後停在「可安裝」，
   **不會**在使用者關閉 App 時靜默安裝（`autoInstallOnAppQuit` 已明確關閉）。
3. **安裝**：使用者按下「重啟並安裝」後依序：
   - 標記正在結束，停止接受新的關閉流程；
   - **只關閉本機 Core 服務**（不直接結束行程），讓 SQLite 收乾淨；
   - **更新前備份**（見下一節）；備份失敗預設**取消安裝**；
   - 交給 electron-updater 替換檔案／執行安裝程式，App 重新啟動。
4. 安裝完成後版本會變成新版本。資料庫由新版本在啟動時處理；備份仍保留在備份目錄。

### 「稍後」的語意

「稍後」只出現在**下載完成**的畫面（「重啟並安裝」旁邊）：

- 按了只影響**這次執行**：不會安裝；關閉 App 時也不會靜默安裝
  （`autoInstallOnAppQuit` 已明確關閉）。
- 畫面會顯示「已略過此版本」，**下次啟動 App** 會重新檢查並再次詢問；不會永久略過版本。
- 「有新版本」畫面沒有「稍後」；不想下載就不要按「下載更新」，下次啟動同樣會再檢查。

## 更新前備份

安裝前，App 會先關閉 Core 服務，再把 SQLite 資料庫檔案複製到備份目錄。
這是**更新前的一次性備份**，不是定期備份；日常備份仍請使用記憶的匯出功能。

- **位置**：`<userData>/backups/pre-update-<目前版本>-to-<新版本>/`
  - Linux：`~/.config/Mnemoshelf/backups/…`（`XDG_CONFIG_HOME` 有設定時依該值）
  - macOS：`~/Library/Application Support/Mnemoshelf/backups/…`
  - Windows：`%APPDATA%\Mnemoshelf\backups\…`
  - 若用 `MNEMOSHELF_DESKTOP_USER_DATA` 覆寫 userData，備份跟著該目錄走。
- **內容**：只複製資料庫檔，存在才複製，檔名不變：
  - `mnemoshelf.db`
  - `mnemoshelf.db-wal`
  - `mnemoshelf.db-shm`
- **不含**：模型快取（`models/`，可重新下載）、`runtime.json`（含連線 token）、token 檔、
  使用者加入 root 的原始檔案。備份內容是**明文 SQLite**，可能含記憶與索引中繼資料，
  請比照資料庫本身保管，不要放進版本控制或共用目錄。
- **權限**：POSIX（Linux／macOS）備份目錄 `0700`、檔案 `0600`；Windows 沿用使用者設定檔
  目錄的 ACL（不套用 POSIX mode）。
- **原子性**：先寫入同層的暫存目錄，全部成功後才更名為正式備份目錄；失敗會清掉暫存目錄，
  不會留下半套備份。
- **保留**：只保留最近 **3** 份 `pre-update-*` 備份（依目錄修改時間），更舊的會自動刪除。
  其他名稱的目錄、檔案與 symlink 不會被動到。
- **失敗**：
  - 沒有資料庫（`no-db`）、複製失敗（`copy-failed`）或沒有權限（`permission`）時，
    預設**取消安裝**，目前版本不變，UI 顯示固定訊息（原因代碼只寫入 App log）。
  - 備份失敗時 Core 服務已經關閉，**重試不會恢復服務**；請按畫面上的「重新啟動應用程式」
    （或手動重開）以恢復服務。目前**不提供**「略過備份仍安裝」的入口；backend 的 `force`
    僅供進階／程式化使用，不是一般使用者的選項。

### 從備份還原資料庫

1. 從系統匣選單**完全結束** Mnemoshelf，確認沒有殘留的 App 行程。
2. 先備份「目前」的資料目錄（例如把整個 `data/` 複製到別處），以免還原錯檔案時兩邊都失去。
3. 進入 `<userData>/data/`，把目前的 `mnemoshelf.db`、`mnemoshelf.db-wal`、
   `mnemoshelf.db-shm` 移出或刪除（三個都要處理；只換主檔會混到舊的 WAL）。
4. 從 `<userData>/backups/pre-update-<from>-to-<to>/` 把三個檔案複製回 `data/`，檔名保持不變。
   備份裡沒有的檔案（例如原本就沒有 `-wal`）就不要放。
5. POSIX 上把 `data/` 設為 `0700`、三個檔案設為 `0600`：
   `chmod 700 <userData>/data`、`chmod 600 <userData>/data/mnemoshelf.db*`。
6. 重新啟動 App，確認版本與資料（roots、記憶、搜尋結果）符合預期。

> 備份只保證「更新前的資料庫檔案」；更新後才寫入的資料不在這份備份裡。要保留更新後的資料，
> 請在還原前先另外複製一份目前的 `data/`。

## 回滾（手動）

本專案**沒有**一鍵回滾，也不會自動降級。需要回到舊版時：

1. 完全結束 App。
2. 到 GitHub Releases 下載**上一個版本**的安裝檔。舊版 Release 與其下載連結會保留
   （發版時不要刪除上一版 Release 與安裝檔，回滾要靠它），
   請認明 `Mnemoshelf-<版本>-<平台>-<架構>.<副檔名>`。
3. 用該次更新前的備份還原資料庫（步驟同上）。**回滾要同時換回舊版 App 與舊版 DB**：
   資料庫只有向前遷移，把新版 DB 直接給舊版 App 可能讀不動。
4. 安裝舊版：
   - **Linux AppImage**：把目前（新版）AppImage 換成下載的舊版檔案，`chmod +x` 後執行。
     若檔名不同，舊捷徑／自啟項要改指舊檔名。
   - **Windows NSIS**：執行舊版安裝檔；安裝程式會覆蓋目前版本，使用者資料在
     `%APPDATA%\Mnemoshelf`，不會被移除。
   - **macOS**：打開舊版 dmg，把 `Mnemoshelf.app` 拖進「應用程式」取代目前版本。
5. 啟動後確認版本，並確認服務正常：
   `curl -s http://127.0.0.1:<埠>/health`（免 token；回應含 `appVersion` 與 `build`）。
   桌面版的埠由系統指派，可從 App 設定頁的連線資訊或 `data/runtime.json`（若開啟
   Agent 連線發現）取得實際位址。
6. 舊版重新啟動後，自動更新仍會再次提示新版本；若不想更新，下載完成後按「稍後」即可，
   下次啟動會再問。

若回滾後無法啟動，先用步驟 2 另存的「目前資料」還原、重新安裝最新版，再尋求協助；
不要同時混用不同版本的 DB 檔。

## AppImage 的檔名與捷徑

Linux 產物的檔名含版本（`Mnemoshelf-<版本>-linux-<架構>.AppImage`）。electron-updater
更新時會刪除目前 AppImage、把新檔放到同一個目錄，**檔名會變成新版本**。

- App 自己寫的 XDG 開機自啟項目（`~/.config/autostart/`）會在更新後自動改指新檔名。
- **外部參照不會自動修正**：手動建立的 `.desktop`、AppImageLauncher 的註冊、dock 釘選、
  symlink、桌面捷徑等，更新後可能指向已不存在的舊檔名，需要手動改指新檔或重新建立。
- 更新前 AppImage 所在目錄必須**可寫**（更新流程會在同目錄刪舊檔、放新檔）。放在唯讀位置
  （例如系統管理的 `/opt`、唯讀掛載）會得到 `read-only` 錯誤；請把 AppImage 移到使用者可寫
  的目錄，或改用手動下載替換。
- 回滾時下載的是舊版檔名；上面的捷徑與自啟項也要一併改回。

## Windows：未簽章的 App 內更新

目前的 Windows 安裝檔**沒有程式碼簽章**。在 electron-updater 6.8.11 的行為下：

- 打包設定的 `app-update.yml` 沒有 `publisherName`，因此 `NsisUpdater` **不會驗證
  Authenticode 簽章**；它有驗的是更新檔的 **SHA512 checksum**（見下一節）。
- 第一次執行下載的安裝檔時，Windows SmartScreen 可能顯示警告：選「**更多資訊**」→
  「**仍要執行**」。請先確認檔案來自本專案的 GitHub Release。
- 本專案**沒有**、也不需要設定 `verifyUpdateCodeSignature: false`；6.8.11 的 setter 對
  `false` 是 no-op，關不掉真正的驗證。未來若升級到 electron-updater v27 之前，必須重新
  評估簽章與 `publisherName` 的行為，不要假設現在的「不驗 Authenticode」會一直成立。
- 未簽章代表**無法用 Authenticode 證明發行者的身分**；信任來源是 GitHub Release
  （見「信任模型」）。

## macOS：只檢查、開啟下載頁（B 案）

macOS 版使用 **ad-hoc 簽章、未公證**，不具備 Squirrel.Mac 自動更新所需的 Developer ID
簽章，因此：

- App 只透過 GitHub API 檢查最新 Release，有新版本時顯示版本與「開啟下載頁」按鈕。
- **不會**在 App 內下載或安裝，也**不會**驗證更新檔簽章（根本沒有把更新檔交給 updater）。
- 使用者從瀏覽器下載 dmg 後手動安裝；資料目錄不變。瀏覽器下載的檔案不經過 App 的
  checksum 驗證，請只從本專案的 GitHub Releases 下載。
- Gatekeeper 會阻擋未公證的 App。第一次開啟時：
  1. 系統設定 → 隱私權與安全性 → 捲到「安全性」，按「**仍要打開**」並輸入密碼；
  2. 若顯示「已損毀，無法打開」或沒有按鈕，在終端機移除隔離屬性後再開：
     `xattr -dr com.apple.quarantine /Applications/Mnemoshelf.app`
     （路徑依實際放置位置調整）。
- macOS 的更新檢查會打 `api.github.com`；未認證請求以來源 IP 計，每小時 60 次。
  短時間反覆手動檢查可能得到 `rate-limit`，稍後再試即可。

## 信任模型與 SHA512 的界線

- **信任根是 GitHub repo 的寫入權限**（`j7708git/mnemoshelf`）。能修改 Release 的人
  就能發布更新；請只從本專案的 GitHub Releases 下載。
- 維護者帳號**建議開啟 2FA**（TOTP 或安全金鑰），避免帳號被盜後被發布惡意更新。
- `latest*.yml` 內的 `sha512` 是更新檔的 SHA-512（base64）。electron-updater 下載完成後
  會比對檔案與 metadata；不符就丟 `checksum` 錯誤，**不會進入安裝**。
- **SHA512 只保證「下載到的檔案與 metadata 一致」**。metadata 本身沒有 App 簽章；
  若 GitHub repo／Release 被篡改，攻擊者可以同時換掉檔案與 checksum。因此它不是
  程式碼簽章，也不能取代 Authenticode／Developer ID。
- 目前 Windows 未簽章、macOS 只有 ad-hoc 簽章；**作業系統層級無法驗證發行者**。
  這是已知限制，不是更新流程的 bug。

## 錯誤與排查

更新狀態只帶穩定的錯誤代碼與固定訊息（不含路徑、token 或下載 URL）：

| 代碼 | 意義 | 可以做什麼 |
|---|---|---|
| `offline` | 網路不可用、DNS 或連線失敗 | 確認網路後重試；離線不影響目前版本 |
| `not-found` | 找不到 Release 或 `latest*.yml` | 這個版本可能尚未發布；稍後再試或到 Release 頁確認 |
| `rate-limit` | GitHub API 流量上限（macOS 檢查） | 等一段時間再試；也可直接開 Release 頁 |
| `checksum` | 更新檔與 metadata 的 SHA512 不符 | 重新下載；若持續失敗，到 Release 頁手動下載 |
| `read-only` | 更新檔位置或安裝目錄無法寫入 | AppImage 目錄需可寫；必要時移到使用者目錄或手動替換 |
| `unsupported-appimage` | 目前不是可自動更新的 AppImage 形式 | 使用 AppImage 執行，或手動下載替換 |
| `unsupported-tarball` | 目前是 tar.gz／解壓目錄 | 手動下載新版本替換 |
| `invalid-signature` | 更新檔簽章驗證失敗（目前未簽章環境不會出現） | 不要安裝；改從 Release 頁手動下載並確認來源 |
| `invalid-version` | 版本字串無法比較 | 回報問題；目前版本不變 |
| `check-failed` | 其他檢查失敗（含 GitHub 回應異常） | 稍後重試 |
| `download-failed` | 下載中斷或磁碟寫入失敗 | 檢查磁碟空間與網路後重試 |
| `install-failed` | 安裝流程未能完成 | 按畫面上的「重新啟動應用程式」（或手動重開）以恢復服務 |
| `backup-failed` | 更新前備份失敗，已取消安裝 | 按畫面上的「重新啟動應用程式」（或手動重開）以恢復服務；不提供略過備份的 UI |
| `unexpected` | 未預期的錯誤 | 重新啟動 App；持續發生請附上啟動 log（不含 token）回報 |

其他常見狀況：

- **按了下載卻沒反應**：確認目前狀態是「有新版本」；`downloading`／`downloaded` 期間不會重複下載。
- **更新後舊捷徑失效**：AppImage 檔名已變，請依「AppImage 的檔名與捷徑」一節修正。
- **想回到舊版**：沒有自動回滾，請依「回滾（手動）」操作。
- **經過代理伺服器時顯示 `check-failed`**：若網路需經 proxy 而 proxy 連不上，錯誤可能落在
  `check-failed` 而不是 `offline`（分類器目前只認常見的網路錯誤碼）。兩者都只影響這次檢查，
  目前版本不變；確認 proxy 設定後再試即可。
- **備份佔空間**：只保留 3 份；較舊的會在下次備份時自動刪除。也可以手動刪除不需要的
  `pre-update-*` 目錄（App 不會刪除其他名稱的目錄）。
- **Windows 備份失敗**：資料庫檔案可能被防毒、同步或備份工具暫時鎖住；關閉該程式或
  稍後再試。備份失敗時安裝會被取消，目前版本不變。
- **log 會不會含 token**：更新流程只記固定文案與狀態代碼，不記錄 token、資料庫內容或
  使用者目錄路徑。

## 資料位置速查

| 平台 | userData（含 `data/`、`backups/`、`models/`） |
|---|---|
| Linux | `~/.config/Mnemoshelf`（或 `$XDG_CONFIG_HOME/Mnemoshelf`） |
| macOS | `~/Library/Application Support/Mnemoshelf` |
| Windows | `%APPDATA%\Mnemoshelf` |

`data/` 存 SQLite 資料庫與執行期連線資訊；`backups/` 是更新前備份；`models/` 是
embedding 模型快取（不在更新備份內，可重新下載）。
