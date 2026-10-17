# Mnemoshelf

> 狀態：v0.2.0（開發進行中，功能仍可能變動）。本版重點＝裝置偵測＋Mac 內建自我測試（自動測 CoreML，失敗自動回 CPU）；桌面版安裝檔與版本請見 GitHub Releases。

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

## 進階環境變數（選用）

一般使用不需要設定。以下是嵌入模型執行裝置與診斷相關的開關（裝置與退回的完整語意，
見 [docs/embedder-contract.md](docs/embedder-contract.md)）：

| 變數 | 值 | 預設 | 說明 |
|---|---|---|---|
| `MNEMOSHELF_EMBED_DEVICE` | `auto`／`cpu`／`dml`／`coreml` | `auto` | `auto`＝Windows 嘗試 DirectML GPU（`dml`）、macOS 嘗試 CoreML（`coreml`，**先自我測試：通過才採用**）、其他平台維持 CPU。`dml`／`coreml` 載入或推論失敗會自動退回 CPU，不中斷索引。 |
| `MNEMOSHELF_EMBED_DML_DEVICE_ID` | 非負整數 | `0` | DirectML adapter 索引（`0`＝預設顯示卡；多顯卡筆電常用來指定獨顯）。非法值會直接拒絕啟動。 |
| `MNEMOSHELF_EMBED_ORT_LOG` | `0`–`4` | 未設定（不覆寫） | ONNX Runtime 的 log 等級（`0`＝verbose、`4`＝fatal），只用於除錯：`0` 會印出內部配置訊息（含 arena 的擴張量），可診斷「單一配置有多大」。訊息量大、會拖慢啟動，平時不要開；非法值會直接拒絕啟動。 |

**明示 `coreml` 的提醒**：設定 `MNEMOSHELF_EMBED_DEVICE=coreml` 表示「**忽略已快取的決定、
強制嘗試 CoreML**」（不自我測試、也不寫回快取），由使用者自負後果。macOS 的 CoreML EP
目前對這種量化模型沒有實測過的加速證據，且上游仍有未修的當機風險
（onnxruntime 的 CoreML EP＋外部資料檔以檔案路徑載入曾造成 SIGBUS）；要驗證請以
`MNEMOSHELF_EMBED_DEVICE=coreml` 單獨跑一次，**不要**當成日常設定。

## 授權

尚未決定。
