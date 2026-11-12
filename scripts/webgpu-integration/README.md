# 可選 WebGPU 產品鏈驗收

> 讀者：熟悉 pnpm、Node 與 Electron 的實作者及驗證員。
> 一句話：用受控合成檔案比較 CPU／WebGPU 的真產品索引與搜尋。
> 現在要做：先建置與準備資產，再串行執行矩陣並檢查報告。
> 依據：`docs/embedder-contract.md`、`docs/roots-and-privacy.md`、`docs/operations.md`。

## 準備與執行

所有命令從此工作樹根執行。需要 Node >=22.14、pnpm、支援 WebGPU 的 macOS arm64、
本工作樹的 Electron 與可用 ffmpeg／ffprobe。不要連既有產品服務或使用者 DB。
同機同時只跑一組模型量測，避免 CPU／GPU／記憶體競爭改變結果。

```bash
pnpm install --frozen-lockfile
pnpm build
# 首次可從已核實、同模型 q4 的受控快取複製；省略時使用已備妥副本。
WEBGPU_CACHE_SOURCE=/controlled/model-cache node scripts/webgpu-integration/prepare.mjs
WEBGPU_INTEGRATION_RUN=1 node scripts/webgpu-integration/run.mjs
```

`prepare.mjs` 不載入模型；只複製／逐檔 SHA-256 核對資產、產生文字、PNG、1 秒合成波形 WAV
與 5 秒 H.264 色塊影片。來源快取應含 `onnx-community/embeddinggemma-2-ONNX` 的文字、視覺、
音訊 q4 權重與 processor／tokenizer。離線 worker 使用與產品 ESM export 相同的
`transformers.node.mjs` module instance 設定 `env.allowRemoteModels=false`，缺資產直接失敗。
可用 `MNEMOSHELF_FFMPEG_PATH`／`MNEMOSHELF_FFPROBE_PATH` 指定 decoder 的絕對路徑；
未指定時 prepare 會在 PATH 查找，將結果存成忽略的執行設定。缺 decoder 時 manifest 明記
`available=false`，不能把這輪當成影片驗收完成。

預設矩陣串行跑 Node 三輪 CPU／WebGPU，各輪是全新行程與隔離 DB／root；再跑真 Electron
main＋worker 的一組 CPU／WebGPU 代表案例。兩個宿主各補一案合法長輸入超 GPU 預算的 CPU 退回。
可用 `WEBGPU_ROUNDS=1` 做 Node 冒煙，或 `WEBGPU_RUNTIMES=node`／`electron` 分段排程；
完整結果仍需 Node 三輪與 Electron 代表案例都具備。

Electron 預設使用本工作樹 `packages/desktop` 解析出的執行檔，也可用 `WEBGPU_ELECTRON_PATH`
指定受控副本的絕對路徑。`electron-main.mjs` 會等 `app.whenReady()`、使用隔離 userData，
並移除 `ELECTRON_RUN_AS_NODE`，因此不是以 Electron binary 冒充 Node 執行。
Electron 與 Node 的 SQLite native ABI 必須各自可用；若環境只能保留一種建置，請分段執行並
先準備該宿主的依賴，再整理兩份結果，不能把 ABI 載入失敗解讀為 WebGPU 失敗。

單案診斷可直接執行；id 不可重用，避免覆蓋既有結果：

```bash
WEBGPU_INTEGRATION_RUN=1 WEBGPU_CASE_ID=node-gpu-smoke WEBGPU_CASE_DEVICE=webgpu node scripts/webgpu-integration/case.mjs
WEBGPU_INTEGRATION_RUN=1 WEBGPU_CASE_ID=node-gpu-budget WEBGPU_CASE_DEVICE=webgpu WEBGPU_CASE_SCENARIO=budget node scripts/webgpu-integration/case.mjs
```

## 驗證範圍與判讀

所有產物在 `.tmp/webgpu-integration`；`runs/<id>/report.json` 保留斷言、裝置快照、各階段 wall time
與 process CPU time、worker 呼叫數、主行程／可取得的媒體子程序 RSS；矩陣的
`matrices/<id>/summary.json` 保留退出碼、CPU／GPU 向量最低 cosine、索引速度比及三輪資源趨勢。
每案的輸出目錄拒絕覆蓋。case 最長 20 分鐘；單一 HTTP 要求最多 10 分鐘。父行程每 500ms 監看本案及可取得子程序的 RSS，
超過 6 GiB 或逾時即終止整個隔離程序群組；非 Windows 以 detached 群組加 SIGKILL 回收，
Windows 用 taskkill /T，但本輪沒有 Windows RSS 量測，不當成該平台驗收。

標準案由真 `createServer` 經 loopback REST 建立 root、preview、索引、查詢、增量與取消；
注入的實例仍是真 `WorkerEmbedder`，worker 直接載入正式 `embedder-worker.js`。
磁碟素材經真 scanner、PNG／WAV／影片解碼、模型、SQLite metadata、sqlite-vec 寫入與搜尋。
檢查逐檔 processed／unchanged／skipped／failed 對帳、每個 chunk 對應一條有限且正規化的 512 維向量、
搜尋目標命中、未變重跑零嵌入、單檔修改只重做該檔、在實際嵌入視窗發出 REST cancel 後整檔不留部分索引，
再恢復並完成。文字、圖片與影片階段必須仍為所要求裝置；WebGPU 需另有 probe passed 與 8／2700 限制。

音訊另列 `audioCpuIndex` 階段，檢查首次音訊後 `device=cpu`、音訊 ready、WebGPU 要求保留及
`audio-cpu` 原因；後續查詢仍成功。它不計入 `initialIndexSpeedup`。
長輸入另開新行程，使用真 processor 核對 batch×sequence 在 2,700–8,192 之間，
經 HTTP search 觸發 `token-budget` 退回，並驗證後續一般查詢成功。原操作由 backend 完整重試，
這個案子沒有把 CPU 處理後的時間混入 GPU 初始索引。

矩陣要求 CPU／GPU 相同檔案與 chunk 的向量數一致，最低 cosine >=0.999；速度比只記錄，
不預設 GPU 一定較快。資產與關鍵 build 輸出均留 SHA-256，便於核對獨立重跑是否使用同一份來源。
獨立驗證仍須自行 build，並另外以故障注入／原始碼反例驗證限制會抓到問題。

RSS 為採樣下界，主行程包含 worker threads；未採到的短命子程序記 null。沒有量到原生 GPU 驅動
獨立記憶體，三輪新行程也不能證明長期無洩漏。這份 harness 不注入原生硬崩潰；若 ORT 使整個
行程退出，只會保留非零退出／缺少報告，不能宣稱 JavaScript 已 catch 並成功退回。
