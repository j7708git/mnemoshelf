# Spike：DirectML（GPU）vs CPU 的嵌入基準

這個資料夾是一個**可以帶去 Windows 機器執行**的量測工具，回答一個問題：
**Mnemoshelf 的嵌入（EmbeddingGemma 2，ONNX）在 DirectML GPU 上比 CPU 快多少？
向量結果一樣嗎？值不值得把 App 的預設改成 GPU、失敗時自動退回 CPU？**

- 只做量測，**不進產品程式碼**、不改任何契約。
- 模型、dtype、文件 prefix、512 維截斷正規化都與 App 相同
  （`packages/embedder-transformers/src/embedder.ts`），所以數字可以直接和 App 的索引速度比較。
- 量到的結果請把 `dml-bench-report.json` 回傳（回傳方式見下方「跑完怎麼回傳」）。

> 這是一次性驗證工具（spike）：可以醜，但**必須可重跑**，而且**失敗時不能崩潰**——DML 跑不起來時
> 要把原因與建議寫清楚，讓人可以判斷要不要退回 CPU。

---

## 你需要什麼

| 項目 | 說明 |
|---|---|
| Node.js | **LTS 版（≥ 22）**。[nodejs.org](https://nodejs.org/) 下載「LTS」安裝檔，一路下一步即可 |
| 網路 | 第一次執行要從 Hugging Face 下載模型，**約 200 MB**（文字 q4 模型；會存在本資料夾的 `.cache/`） |
| 磁碟 | 至少留 1 GB 空間（模型快取 + 依賴套件） |
| 顯示卡驅動 | 要量 GPU 的話請先更新到顯卡廠商官方的最新驅動；DirectML 需要 Windows 10 1903+ 與 DirectX 12 |

不需要編譯任何東西：`onnxruntime-node` 的 Windows 預編譯二進位（含 `DirectML.dll`）隨套件附上。

## 怎麼跑（三步）

1. **取得這個資料夾**（兩種方式擇一）：
   - 從 GitHub 下載 ZIP，解壓縮後找到 `spikes/dml-bench` 資料夾；或
   - 已經 clone 過 repo 的話：`cd mnemoshelf/spikes/dml-bench`
2. **安裝依賴**（在這個資料夾裡開終端機／PowerShell）：
   ```powershell
   npm install
   ```
   會下載約 50 個套件（實測 audited 49 個；`onnxruntime-node` 內含 GPU 相關 DLL，稍大，第一次要幾分鐘）。
3. **跑**：
   ```powershell
   npm run bench
   ```
   第一次會先下載模型（約 200 MB），之後就快了。整輪大約 3～20 分鐘（視機器，CPU 段最久）。

> **建議先關掉 Mnemoshelf App 和其他吃重的程式**，否則數字會被別的負載拖慢（一起跑 = 兩邊都變慢）。
> 跑完的結果在 `dml-bench-report.json`，把它（內容貼上或整檔）回傳即可——回傳對象與方式見「跑完怎麼回傳」。

### 先在對的位置開終端機（Windows）

最常見的卡關是「終端機開在別的資料夾」，指令就會說找不到 `package.json`。最保險的開法：

1. 用**檔案總管**打開 `spikes\dml-bench` 資料夾
   （這一層應該同時看得到 `package.json`、`bench.mjs`、`README.md`）。
2. 在位址列（顯示 `...\spikes\dml-bench` 的那一條）輸入 `powershell` 後按 Enter
   → 會直接**在這個資料夾**開好一個 PowerShell 視窗。
3. 先輸入 `dir`，確認畫面裡看得到 `package.json`。看得到就代表位置正確，可以接著做 `npm install`。

### 如果中文顯示亂碼

Windows 舊版主控台可能是非 UTF-8 編碼，先執行一次：

```powershell
chcp 65001
```

### 只想先確認環境（很快，不下載模型）

```powershell
npm run bench:quick
```

會列出 Node 版本、CPU、`onnxruntime-node` 的可用後端（有沒有 `dml`）、以及 DirectML 是否可用。
看到「DirectML：可用 ✅」就表示環境沒問題，可以接著跑完整量測。

## 跑完怎麼回傳

1. 在資料夾裡找到 **`dml-bench-report.json`**（跟 `bench.mjs` 同一層）。
2. 把**整份檔案**（或把檔案內容複製貼上）回傳給**交付這份工具給你的那個對話／負責人**即可——
   不用額外加工、也不用截圖。
3. `npm run bench:quick` 另外產生的 `dml-bench-report.quick.json`，只在「DirectML 回報不可用」
   或需要釐清環境時才需要一起附上。

報告裡沒有任何個人資訊（不含使用者名稱、電腦名稱、本機絕對路徑），可以直接貼上或整檔傳回。
如果跑的時候有出現錯誤訊息，把終端機畫面一起附上更有幫助。

## 指令一覽

| 指令 | 內容 | 大概要多久 |
|---|---|---|
| `npm run bench:quick` | 只快檢環境與 DirectML 可用性，**不載入模型** | 幾秒 |
| `npm run bench` | 完整：CPU 基準 → DML（batch 8/16/32/64）→ 向量一致性 | 約 3～20 分（視機器） |
| `npm run bench:cpu` | 只量 CPU（batch 16、256 塊×約 900 bytes） | 約 2～10 分（視機器） |
| `npm run bench:dml` | 只量 DML＋CPU↔DML 一致性（會額外載入一次 CPU 取參考向量） | 約 2～10 分（視機器） |

也可以直接呼叫 `node bench.mjs` 並加參數，例如：

```powershell
node bench.mjs --help                     # 全部參數說明
node bench.mjs --device cpu,cpu            # 同一裝置跑兩次：量「餘弦的噪音基準」
node bench.mjs --dml-batches 8,16          # DML 只試這兩種批次
node bench.mjs --batch 32 --chunks 128     # 換 CPU 段的批次與塊數
node bench.mjs --dml-device-id 1           # 指定另一張顯示卡（0 通常是預設卡；筆電常見 0＝內顯）
node bench.mjs --ort-verbose               # 印出 ORT verbose log（看節點被分到哪個 EP，輸出很多）
node bench.mjs --cache "D:\hf-cache"       # 指定模型快取位置（例如沿用 App 已下載的模型）
```

`--label 桌機` 這種標記可以幫你分辨不同機器的報告，但**請不要填姓名或其他個人資訊**。

## 它量什麼、怎麼看數字

每一段（每個裝置）會記錄：

- **載入時間**：模型載入（含首次下載量）與 session 建立時間。
- **批次效應**：每種批次大小各跑兩輪，**第一輪的第一個窗**含 pipeline 建置成本（DML 的動態 shape 需要重建），
  所以會分開報「首窗」與「穩態」——這也是「DML 到底吃不吃動態 shape 的虧」的關鍵數字。
- **吞吐**：塊/s、每塊 ms、每 KB ms、**每真實 token ms**（`attention_mask` 加總，不是 pad 後的長度）。
- **CPU 佔用**：該段的 `process.cpuUsage()`（user+system）除以實際時間；GPU 段若接近 0 表示 CPU 幾乎被釋放。
- **向量一致性**：同一批輸入（同樣的塊、同樣的批次、同樣的 prefix）在 CPU 與 DML 各算一次，
  逐塊算 cosine 的 min／mean，並判定是否 ≥ 0.999。

報告的 `conclusion.recommendation` 會給一句話結論（`use-dml`／`keep-cpu`／`cpu-baseline-only`／
`dml-only`／`insufficient-data`），細節都在 `results` 與 `errors` 裡。

### 判讀原則

- **加速倍率**至少看 **1.3× 以上**才值得切換（低於此的增益不值得增加一條產品路徑與 fallback 複雜度）。
- **一致性必須通過**（min cosine ≥ 0.999）。DirectML 是另一個運算路徑，數值可能有微小差異；
  未通過就代表不能拿它當預設（會出現「同一份文件用兩種向量」的靜默問題）。
- **CPU 佔用**要看 `cpu.perWallRatio`：CPU 段大約是 5～6（用滿實體核心），GPU 段應該明顯更低。

## 注意事項

- **量測期間請關掉 Mnemoshelf App**，不要同時索引：兩者搶同一顆 CPU，數字不可比。
- **第一次執行會下載模型**（約 200 MB）到本資料夾的 `.cache/`，需要網路；之後離線可跑。
  `.cache/` 與 `node_modules/` 都不進版控。
- **DirectML 只在 Windows 提供**：在 macOS／Linux 上跑 `--device dml` 會直接告訴你這件事（預期行為，不是壞掉）。
- **Windows 安裝時不會額外下載 GPU 二進位**：`onnxruntime-node` 的安裝腳本只在 Linux x64 另外抓 CUDA 檔案
  （`install-metadata.js` 的 `win32/x64` 需求清單為空），DirectML 相關 DLL 已隨套件附上。
- 只量**文字**：不載入視覺編碼器（官方模型卡的 Selective Encoder Loading），所以下載量與 App 的完整載入不同；
  文字嵌入的吞吐不受影響。
- 合成語料由固定種子產生（中英混合、每塊約 900 bytes），每台機器產生同一份，方便跨機比較；**不含任何真實檔案內容**。
- 報告不含你的使用者名稱、電腦名稱或本機絕對路徑（路徑一律以 `~/`、`<spike>/`、`<路徑>/檔名` 表示）。

## 產出檔

| 檔案 | 內容 |
|---|---|
| `dml-bench-report.json` | 完整量測報告（`npm run bench`／`bench:cpu`／`bench:dml`） |
| `dml-bench-report.quick.json` | `npm run bench:quick` 的環境快檢報告（不會蓋掉上一份完整報告） |

兩者都以 `--out <檔案>` 指定位置。

## 退出碼

| 碼 | 意義 |
|---|---|
| 0 | 要求的裝置都量成功（`npm run bench` 在沒有 DML 的機器上也是 0：自動退回 CPU 是預期行為） |
| 1 | 主要裝置失敗（**只指定 `--device dml` 而 DML 失敗**時算失敗）；報告仍會寫出。**在非 Windows 機器指定 `--device dml` 也會得到 1——這是預期行為，不是工具壞掉**（那些平台沒有 DirectML；報告的 `errors` 會寫明原因與建議） |
| 2 | 參數錯誤 |

## 這個工具不做什麼

- 不改產品程式碼、契約或 CI；App 端的 GPU 開關是後續另一張卡。
- 不量圖片嵌入、不量端到端索引（那只量文字模型的吞吐）。
- 不自動上傳任何東西：報告只寫在本機，要不要回傳由你決定。
