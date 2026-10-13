# Spike：EmbeddingGemma 2 在 Node / Electron CPU 的執行期可行性

這個 spike 回答一個問題：**在 Node.js（及 Electron）的 CPU 上，能不能用
`@huggingface/transformers` 載入 EmbeddingGemma 2 的文字 + 圖片、產出 768 維向量，
而且速度與記憶體可接受？** 這是 Mnemoshelf（本機多模態語意檔案總管）能否照原技術
路線走的關卡。

量測結果與結論寫在
`project-notes/projects/mnemoshelf/research/spike-embed-runtime.md`（private repo，不在此處）。

這裡的程式碼是一次性驗證用的 spike：可以醜，但**必須可重跑**。

## 環境需求

- Node.js ≥ 22（實測 v22.23.2）、pnpm 10（實測 10.34.5）。
- 對外網路（首次要從 huggingface.co 下載模型）。
- 圖片產生需要 ImageMagick 的 `convert`；文字圖另需要一個 CJK 字型
  （預設 `Noto-Sans-CJK-TC`，找不到會依序退到 JP／AR PL UMing／DejaVu）。
  若有 `rsvg-convert` 會優先用它把 SVG 轉 PNG。
- 不需要編譯任何原生模組：`onnxruntime-node` 的 Linux x64 預編譯二進位隨套件附上。

> **pnpm 10 會封鎖建置腳本**：`pnpm install` 會警告
> `Ignored build scripts: onnxruntime-node@1.30.0, protobufjs@7.7.6`。
> `onnxruntime-node` 的 postinstall 只負責另外下載 CUDA EP（GPU 用），
> CPU 二進位已內含在套件裡，**本 spike 的 CPU 路徑不受影響**（實測成功）。
> 反過來，`electron` 的 postinstall（下載 Electron 執行檔）也會被封鎖，
> 要跑 Q6 時得補一行 `pnpm exec install-electron`（見下）。

## 從乾淨狀態重跑（A–E）

```bash
cd mnemoshelf/spikes/embed-runtime
pnpm install
pnpm run bench        # = 產測試圖（若缺）→ q8 量測 → q4 量測 → dtype 比較
```

- 第一次跑會下載 q8（約 517 MB）與 q4（約 271 MB）到 `mnemoshelf/.tmp/hf-cache-<dtype>/`；
  第二次之後直接用快取（暖機載入約 5–6 秒）。
- 完整跑一輪（暖快取）大約 25–30 分鐘：圖片在 CPU 上很慢（見研究筆記）。
- 結果寫進 `results/bench-<label>.json`。

個別步驟：

```bash
pnpm run assets        # 只產生測試圖到 mnemoshelf/.tmp/assets/
pnpm run bench:q8      # 只跑 q8（文字+圖片）
pnpm run bench:q4      # 只跑 q4（文字+圖片）
pnpm run bench:fp32    # fp32「純文字」對照（額外下載約 1.1 GB）——Q3 的基準
pnpm run compare       # 讀 results/*.json 算 dtype 之間的餘弦
pnpm run memory        # 逐階段 RSS + 同負載下的逐句延遲（受控對照，q8 與 q4 各跑一次）
node scripts/run-all.mjs --with-fp32   # bench + fp32 + 比較（一次跑完）
```

`pnpm run compare` 預設以 `results/bench-fp32.json` 為基準；沒有那個檔案時會退成以 q8 為基準。

## 測試資料

- 文字：`lib/corpus.mjs`，**合成語料**（本 spike 自寫，不含任何使用者檔案內容）。
  查詢與文件各 6 句（各 4 句繁體中文 + 1 句英文 + 1 句程式碼片段），另有 1 段 465 token 的長文。
- 圖片：`lib/corpus-images.mjs` + `assets/*.svg`，共 6 張。
  `cats.jpg` 由公開測試資料集下載（Hugging Face `Xenova/transformers.js-docs`），
  其餘 5 張由 `assets/*.svg` 轉成 PNG（紅色圓形、藍色方形、綠色三角形、
  含「Hello 你好」文字的圖、長條圖）。產物在 `mnemoshelf/.tmp/assets/`，不進版控。
  > `text-hello.svg` 不存在：ImageMagick 內建的 MSVG renderer 缺 CJK 字型（實測會把中文吃掉），
  > 所以那張圖改由 `scripts/make-assets.mjs` 用 `convert -annotate -font Noto-Sans-CJK-TC` 直接排版。

## 腳本對照表

| 腳本 | 內容 |
|---|---|
| `scripts/make-assets.mjs` | 產生 6 張測試圖到 `.tmp/assets/` |
| `scripts/bench.mjs` | **A–E 主量測**：載入（冷啟動、下載量、RSS）、文字（逐句／批次／長文、prefix、token 數）、圖片（`max_soft_tokens` 70 與 280 的單張延遲、批次 4 張）、檢索探測（6 圖 × 12 描述相似度矩陣、Top-1、邊界）、截斷（768／512／256，各自重新 L2 正規化） |
| `scripts/compare-dtypes.mjs` | Q3：q8／q4 對 fp32 的餘弦（768／512／256 維） |
| `scripts/bench-memory.mjs` | 逐階段 RSS（找峰值）＋**同負載下的逐句延遲**；`--text-only` 可只跑文字（fp32 用） |
| `scripts/bench-electron.mjs` | Q6：跑 `electron-run.mjs` 與 `electron-control.mjs`（對照組） |
| `scripts/electron-run.mjs` | 在 Electron 內載入 q8、嵌入 1 句文字 + 2 張圖、檢查維度／NaN／Top-1 |
| `scripts/electron-control.mjs` | 對照組：只啟動 Electron，不載模型（用來區分「環境起不了 main process」與「模型載入卡住」） |
| `scripts/llama-mmproj.mjs` | Q8（選做）：自起 `llama-server`（port 18181）載 mmproj，逐一試各種圖片 embedding 請求格式 |

## Electron 測試（Q6）

```bash
cd mnemoshelf/spikes/embed-runtime
pnpm install                 # 已含 electron 44.7.0（devDependencies）
pnpm exec install-electron   # pnpm 10 封鎖了 electron 的 postinstall，必須補這行
pnpm run bench:electron      # 或 node scripts/bench-electron.mjs
```

- 會依序跑：對照組（run-as-node／main process）→ 真正載入模型（run-as-node／main process／
  沒有 DISPLAY 時再加一個 `DISPLAY=:0` 的嘗試）。
- main process 需要可用的 X/Wayland；本機這個 shell 起不了，會逾時（120–150 秒）並記錄錯誤，
  **對照組也會逾時**，所以可以判斷是環境問題。結果寫進 `results/electron-q6.json`。
- 這支重用 q8 快取，不會重新下載模型。

## llama.cpp mmproj 測試（Q8，選做）

```bash
cd mnemoshelf/spikes/embed-runtime
LLAMA_SERVER_BIN=~/workspace/llamacpp/build/bin/llama-server node scripts/llama-mmproj.mjs
```

- 只動**自己**在 `127.0.0.1:18181` 起的新實例，跑完 SIGTERM 關掉；
  **不會**碰既有的 `127.0.0.1:8181` 服務，也**不會**重新編譯 llama.cpp。
  （預設路徑是 `$HOME/workspace/llamacpp/build/bin/llama-server`，可用 `LLAMA_SERVER_BIN` 覆蓋。）
- 會下載 `embeddinggemma-2-Q8_0.gguf`（296 MB）與 `mmproj-embeddinggemma-2-Q8_0.gguf`（529 MB）
  到 `mnemoshelf/.tmp/models/`。
- 結果寫進 `results/llama-mmproj.json`：每種請求格式的 HTTP 狀態與回應、以及與路線 1（ONNX）
  向量的跨實作餘弦。結果檔會把本機絕對路徑換成 `<home>`／`<tmp>` placeholder。

## 輸出（`results/`）

| 檔案 | 內容 |
|---|---|
| `bench-cold-q8.json` | q8 **第一次**（含 517 MB 下載）的那一輪，冷啟動時間與下載量的證據 |
| `bench-q8.json`、`bench-q4.json` | `pnpm run bench` 產出的那一輪（含 768 維向量、相似度矩陣、截斷結果） |
| `bench-fp32.json` | fp32 純文字（Q3 的基準） |
| `compare-dtypes.json` | q8／q4 對 fp32 的餘弦統計 |
| `memory-q8.json`、`memory-q4.json`、`memory-fp32.json` | 逐階段 RSS、逐句延遲、`loadavg` |
| `electron-q6.json` | 5 種 Electron 模式的結果與錯誤 |
| `llama-mmproj.json` | llama.cpp 端點測試（已淨化路徑） |

`.tmp/` 下的模型快取、測試圖與 server log 都不進版控。

## 注意

- 本 spike 只寫 `spikes/embed-runtime/**` 與 `mnemoshelf/.tmp/**`，不碰產品程式碼。
- 所有路徑用 `node:path` 處理；結果檔與筆記不含個人本機絕對路徑。
- 量測期間本機同時有其他高負載工作（`:8181` 服務約佔 4.5–5.7 個執行緒、`loadavg` 9–15），
  因此**這裡的延遲數字偏保守**；每個結果檔都記了當時的 `loadavg`。
