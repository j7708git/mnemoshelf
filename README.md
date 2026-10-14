# Mnemoshelf

> 狀態：規劃與可行性驗證階段，尚無可用版本。

Mnemoshelf 是一個本機桌面應用程式，目標有兩個：

1. **多模態語意檔案總管**：由使用者自己挑選要納入的資料夾，之後可以用文字
   搜尋文件、程式碼、圖片（之後包含音訊與影片），並瀏覽與預覽檔案。
2. **多個 AI agent 共用記憶**：不同的 agent（透過 MCP、REST 或 CLI）可以讀寫
   同一份記憶，並且搜尋已納入的資料夾內容。

## 設計原則

- **預設不掃任何目錄。** 安裝後是空的；必須由使用者逐一加入資料夾（root）。
  詳見 [docs/roots-and-privacy.md](docs/roots-and-privacy.md)。
- **只使用多模態 embedding 模型。** 文字與圖片必須落在同一個向量空間。
  詳見 [docs/embedder-contract.md](docs/embedder-contract.md)。
- **儲存可替換。** 預設 SQLite，資料量大時可換成其他後端。
  詳見 [docs/storage-ports.md](docs/storage-ports.md)。
- **搜尋預設向量優先。** `/search` 不帶 `mode` 時只跑向量那一路（M1 實測優於混合與關鍵字）；
  `hybrid`（RRF 合併）與 `keyword` 為選用。詳見 [docs/storage-ports.md](docs/storage-ports.md)。
- **本機優先。** 服務只綁 `127.0.0.1`，並以 token 保護；資料不離開本機，
  除非使用者明確選用雲端 embedding。

## 架構

見 [docs/architecture.html](docs/architecture.html)（以瀏覽器開啟）。

## 技術棧

TypeScript、Node.js、pnpm、Electron、React。預設儲存為 SQLite（FTS5 + sqlite-vec）。

## 授權

尚未決定。
