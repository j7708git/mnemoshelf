# Mnemoshelf

本機桌面應用程式：把自己挑選的資料夾變成可語意搜尋的知識庫，並讓多個 AI agent 共用同一份記憶。

> **狀態**：最新釋出 **v0.5.0**（[GitHub Releases](https://github.com/j7708git/mnemoshelf/releases)）。本版重點＝**harness 記憶整合**（OpenCode 外掛與新的 dsh 外掛都能自動召回／寫入同一份本機記憶；契約與已知差異見 [docs/agent-integration.md](docs/agent-integration.md)）與**桌面版 App 內更新**（Linux AppImage／Windows NSIS 可在 App 內下載安裝，macOS 只檢查版本後開下載頁；見 [docs/updates.md](docs/updates.md)）。授權 [MIT](LICENSE)。

## 這是什麼

Mnemoshelf 的目標有兩個：

1. **多模態語意檔案總管**：由使用者自己挑選要納入的資料夾，之後可以用文字搜尋文件、程式碼與圖片，並瀏覽、預覽檔案。
2. **多個 AI agent 共用記憶**：不同的 agent（透過 MCP、REST 或 CLI）讀寫同一份記憶，也能搜尋已納入的資料夾內容。

<!-- 截圖位置：檔案總管（目錄樹、預覽、縮圖） -->

## 快速開始

**下載安裝檔**：從 [GitHub Releases](https://github.com/j7708git/mnemoshelf/releases) 取得四個平台的安裝檔（Linux x64／arm64、macOS arm64、Windows x64）。安裝檔是 ad-hoc 簽章、未公證，第一次開啟的系統警告與處理方式見 [docs/building.md](docs/building.md)。

**從原始碼建置**（需要 Node.js >= 22.14.0、pnpm 10.x）：

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm --filter @mnemoshelf/desktop dist
```

產出的是未封裝目錄；要產出各平台安裝檔、以及簽章與第三方授權（含 LGPL-3.0 libvips）的合規說明，見 [docs/building.md](docs/building.md)。

## 功能

| 功能 | 說明 |
|---|---|
| 檔案總管 | 自己挑選要納入的資料夾（root）；加入後先乾跑預覽統計（會納入什麼、會跳過什麼），確認後才開始索引。提供目錄樹、檔案預覽與圖片縮圖。 |
| 語意搜尋 | 文字與圖片落在同一個向量空間，可以用文字搜圖片；三種模式 `vector`（預設）、`keyword`、`hybrid`。 |
| 共用記憶 | 每則記憶有 `content`、`kind`（fact／decision／pitfall／preference）、`scope`（global／project／agent）、`project`、`agent`、`pinned`；支援 NDJSON 備份匯出／匯入。 |
| Agent 整合 | MCP 六個工具 `search`、`remember`、`recall`、`forget`、`list_roots`、`search_memories`（[docs/operations.md](docs/operations.md)）；OpenCode／OpenChamber 外掛在模型請求前檢查，於 session 的第一則 prompt 或訊息含明示線索時召回（預設 `first-turn+explicit`；[docs/opencode-plugin.md](docs/opencode-plugin.md)）；dsh 外掛在每個回合第一步召回，回合結束寫入一張回合卡（[docs/agent-integration.md](docs/agent-integration.md)）。 |
| 回合摘要（選用） | 外掛可把「使用者訊息＋助理最終回覆」交給指定模型，整理成回合紀錄與原子記憶寫回本機；**預設關閉**。怎麼選摘要模型見 [docs/opencode-plugin.md](docs/opencode-plugin.md) §13.1。 |
| 隱私與信任模型 | 預設不掃任何目錄；服務只綁 `127.0.0.1` 並以 token 保護；寫入與讀取都會遮蔽可辨識的機密。現行是**本機單一 owner 全權**：`agent` 只是來源標記、不是身分驗證，`scope=agent` 不是安全邊界（[docs/roots-and-privacy.md](docs/roots-and-privacy.md)）。 |

<!-- 截圖位置：語意搜尋結果（文字查圖片） -->

## 架構

TypeScript／Node.js／pnpm；桌面殼是 Electron＋React，Web UI 用 Vite＋Tailwind。推論引擎為 ONNX Runtime（經 `@huggingface/transformers`，預設模型 EmbeddingGemma 2）；預設儲存 SQLite（FTS5＋sqlite-vec），另有 PostgreSQL＋pgvector 後端。縮圖用 `sharp`（內含 libvips）、靜態檔用 `sirv`、SQLite 驅動為 `better-sqlite3`。

架構圖見 [docs/architecture.html](docs/architecture.html)（以瀏覽器開啟）。

| 套件 | 角色 |
|---|---|
| `packages/core` | 領域模型與 ports（儲存／向量／embedder 介面）、SQLite 實作、機密遮罩 |
| `packages/embedder-transformers` | 多模態 embedder（ONNX Runtime 經 `@huggingface/transformers`） |
| `packages/server` | 本機 HTTP 服務、索引流程、REST 與 MCP 入口 |
| `packages/storage-pg` | PostgreSQL＋pgvector 儲存後端 |
| `packages/web` | Web UI（Vite＋React＋Tailwind） |
| `packages/desktop` | Electron 桌面殼與打包 |
| `packages/opencode-plugin` | OpenCode／OpenChamber 自動召回與回合摘要外掛 |
| `packages/dsh-plugin` | dsh 自動召回與回合卡外掛（服務不可用時 spool 補送） |

## 設計原則

- **預設不掃任何目錄。** 安裝後是空的，必須由使用者逐一加入資料夾（root）。[docs/roots-and-privacy.md](docs/roots-and-privacy.md)
- **只使用多模態 embedding 模型。** 文字與圖片必須落在同一個向量空間；之後包含音訊與影片。[docs/embedder-contract.md](docs/embedder-contract.md)
- **儲存可替換。** 預設 SQLite，資料量大時可換成 PostgreSQL（pgvector）。[docs/storage-ports.md](docs/storage-ports.md)
- **搜尋預設向量優先。** 不帶 `mode` 時只跑向量那一路；`hybrid`（RRF 合併）與 `keyword` 為選用。[docs/storage-ports.md](docs/storage-ports.md)
- **本機優先。** 服務只綁 `127.0.0.1`，索引與 embedding 都在本機；但 agent 讀到的內容仍可能被帶進它所使用的雲端 LLM。[docs/roots-and-privacy.md](docs/roots-and-privacy.md)

## 文件索引

| 文件 | 內容 |
|---|---|
| [docs/building.md](docs/building.md) | 從原始碼建置、各平台產物、簽章與公證警告、LGPL 合規 |
| [docs/operations.md](docs/operations.md) | REST 端點速查、MCP 工具、環境變數總表、索引排隊與取消 |
| [docs/opencode-plugin.md](docs/opencode-plugin.md) | OpenCode／OpenChamber 外掛：安裝、召回行為、回合摘要 |
| [docs/agent-integration.md](docs/agent-integration.md) | `runtime.json` 連線資訊檔與 MCP 設定片段（入口會自動讀檔，不必手動貼 token）、各 harness 召回契約 |
| [docs/updates.md](docs/updates.md) | App 內更新：支援矩陣、更新前備份、還原與手動回滾、平台限制 |
| [docs/roots-and-privacy.md](docs/roots-and-privacy.md) | root 規則、路徑安全、機密遮罩、信任模型、資料刪除 |
| [docs/storage-ports.md](docs/storage-ports.md) | 搜尋模式、記憶欄位與檢索、匯出／匯入、PostgreSQL 後端 |
| [docs/embedder-contract.md](docs/embedder-contract.md) | embedder 能力宣告、執行裝置與退回、CoreML 風險 |
| [docs/architecture.html](docs/architecture.html) | 架構圖（以瀏覽器開啟） |

`docs/architecture.spec.json` 是架構圖的規格來源；第三方授權全文與 LGPL 合規說明在 `docs/licenses/`。

## 授權

MIT，見 [LICENSE](LICENSE)。
