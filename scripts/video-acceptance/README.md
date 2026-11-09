# 影片驗收工具

這些工具是手動 gated 驗收，不會在普通 CI 啟動模型或產生影片。執行前要完成 build、保留一致 source／dist、備妥本機模型與 FFmpeg，並取得獨占量測時段。原始資料、模型與結果不進版控。

## 凍結品質

`queries-frozen-v1.json` 原封保留 SHA-256 `846c102b582045a264388baed8ef458d5e7b1bb9278a368c73d2a564d2bece56`。預設輸入為 `.tmp/video-a/corpus/eval-root` 的十支原始影片，runner 會逐一比對凍結 hash；另需 `.tmp/media-feasibility/models`、`.tmp/audio-indexing-acceptance/fixtures/f04.wav` 及既有 decoder 候選。於 repo 根目錄：

```powershell
$env:VIDEO_ACCEPTANCE_RUN = '1'
node scripts/video-acceptance/run-quality.mjs
```

可用 `VIDEO_ACCEPTANCE_RUN_ID` 指定只含英數、底線、連字號的名稱；否則產生隨機名稱。相同 runId 拒絕重用。輸出在 `.tmp/video-acceptance/runs/<runId>`，每輪使用獨立 data 與 mixed-root，不刪既有檔案。報告保留 24 題原區間、排序、命中區間及各影片兩軌片段數、source／dist hash。標準為 Recall@3 ≥18/24、兩軌各 ≥9/12、負對照 top-1 違規 0。品質報告中的 RSS 不包含子程序，不能視作長片效能驗收。

`corpus/definitions.mjs`、`lib.mjs`、`generate-quality.mjs`、`verify-corpus.mjs`、`tts.ps1` 保存原始合成規則。TTS 使用 Windows SAPI 指定聲音，依賴平台與版本；相同腳本不保證不同環境逐位一致。以全新 `VIDEO_CORPUS_RUN_ID` 啟動 tts，再執行生成及驗證；輸出只在 `.tmp/video-acceptance/corpus/<runId>`，既有 run 不可重用。生成後執行 `node scripts/video-acceptance/corpus/assemble-frozen-eval.mjs`，十檔 hash 全符才建立該 run 的 eval-root；以 `VIDEO_QUALITY_CORPUS_RUN_ID` 指定該 run 可讓品質 runner 使用。若 hash 不符，就不是原凍結語料，不可改題或降低門檻。安全 fixture 不得混進品質 root。

## 長片素材與效能量測

明確設定 `VIDEO_PERF_GENERATE=1` 後執行 `node scripts/video-acceptance/generate-performance.mjs`。該步耗時耗空間，應先排獨占時段；可指定 `VIDEO_PERF_RUN_ID`，同名拒絕重用。輸出、增量 manifest 留在 `.tmp/video-acceptance/performance/<runId>`，不刪其他資料。來源 v01 先驗 hash，36 秒週期重複、升頻到 1920×1080，輸出 H.264／AAC；60、300、600、60.2 秒，以及 600 秒高碼率接近 512 MiB。每檔以 ffprobe 核對解析度、時長、編碼、尺寸及 SHA-256；近上限樣本若不在 480–512 MiB 就明確失敗，不能以填充代替。可透過 `MNEMOSHELF_FFMPEG`／`MNEMOSHELF_FFPROBE` 指定工具。升頻素材可量 1080p 解碼，不代表原生高解析真實影片。

先設 `VIDEO_PERF_CASES=1080p-60` 可只生成 60 秒 smoke 素材；全矩陣生成需移除該變數，並使用新的 runId。單 root 初版以 `VIDEO_PERF_RUN=1`、`VIDEO_PERF_SCENARIO=smoke`、`VIDEO_PERF_SOURCE_ID=<素材 runId>` 執行 `node scripts/video-acceptance/run-performance.mjs`；smoke 只作診斷並標示 partial；完整矩陣才依資料完整性和時間界線評估。

V01 的原區間 0–8 秒按來源 36 秒循環複製至每一週期，最後一段裁切；報告包含所有區間。每筆相關命中須是同一影片、影片軌且與其中一個區間交疊超過 1 毫秒。產品在整檔視覺與音軌處理成功後才寫入片段及向量，首筆相關命中通常不會在同一檔案索引中途出現；片段替換與向量寫入不是同一個跨儲存交易。

長片效能 runner 已提供獨立冷媒體索引、至少三次暖跑、首筆相關 REST 命中、總時間、索引中查詢 P95、程序取樣、取消與 drain、ffprobe／AAC 程序成本及競爭觀測；每次結果仍須依保存證據判讀。本任務重負載串行，整機仍可能有其他使用者程式；記錄整機 CPU 累計快照、不枚舉或干預其他程序。Node RSS 已含 worker threads；只加本輪追蹤的 FFmpeg／ffprobe PID 工作集，不重複加 worker。Windows 取樣器以本程序 PID 預熱後每 100ms 並在媒體程序 spawn 時優先請求樣本；每次只允一筆在途，必須逐次核對媒體程序覆蓋率及負載下開銷，記錄往返延遲及未取樣 PID，峰值是下界；arrayBuffers 僅為主執行緒數值、理論 PCM 位元組不能當實際緩衝配置。程式 spawn 至 close 包含排程、管線背壓及等待，不可當成純解碼時間。首筆相關片段可搜尋目標：60 秒片 ≤60 秒、最長片 ≤600 秒，不外推或降低門檻。


完整量測使用 `VIDEO_PERF_RUN=1`、`VIDEO_PERF_SCENARIO=full`、`VIDEO_PERF_SOURCE_ID=<素材 runId>` 執行 `node scripts/video-acceptance/run-performance.mjs`。每輪保存結果後只移除該輪新建的 root 索引、核對向量歸零；不刪來源，模型保持已載入。`performance.json` 保存來源與執行版本 hash、CPU 診斷、每輪相關命中區間與查詢資料、取消和公平性；`rss-samples.ndjson` 保存原始取樣。完整 gate 同時檢查 60 秒片、正常 600 秒片與近上限 600 秒片各三暖輪的首筆相關命中：觀測區間整段在時限內才 pass，跨界為 inconclusive；另外檢查片段、取樣覆蓋、兩種取消、sampler 收尾及競爭下短工作是否先完成。原始 status 不能代替獨立驗證。

對完成且尚無 `validation.json` 的 run，獨立 verifier 以 exclusive create 寫入判定並記錄輸入及工具 hash，不覆寫原報告：

```powershell
$runDir = Join-Path (Join-Path (Join-Path ".tmp" "video-acceptance") "runs") "<runId>"
node scripts/video-performance-verifier.mjs $runDir
node --test scripts/video-performance-verifier.test.mjs
```

外部 sampler before／after 身分 sidecar 可補充同一程序退出證據；不存在或查詢失敗時視為未證明，不能用產品 FFmpeg close 代替。舊版量測若只保留每輪 P95 而沒有完整查詢延遲，不能由 verifier 重算 P95；新版 runner 另保存逐次延遲與公平性 monotonic 起點。runner 與 verifier 各自保存 hash，避免把後續程式修正誤認成舊 run 的執行版本。

## 輕測

```powershell
pnpm --filter @mnemoshelf/core exec vitest run --config ../../scripts/video-acceptance/vitest.config.ts
```

## 安全語料重生

安全生成必須選新的 `VIDEO_CORPUS_RUN_ID` 並設定 `VIDEO_SECURITY_GENERATE=1`，再執行 `node scripts/video-acceptance/corpus/generate-security.mjs`。它建立 `.tmp/video-acceptance/corpus/<runId>`，同名目錄已存在即拒絕；模型不會啟動，但會產生 601 秒、超解析度及邏輯大小 513 MiB 的邊界檔（實際磁碟配置依檔案系統而異），先協調時段及容量。安全案例只送給安全 runner，不得加入品質 root。`security-matrix-baseline.json` 是歷史 A2 生成的矩陣及 hash 記錄，不是現行產品契約；重生報告存 run 自身的 `labels/security-matrix.json` 與 `reports/security-fixtures.json`，重生後需逐檔核對，跨版本不保證位元組相同。不執行舊 freeze 腳本，也不覆寫原 frozen labels。

素材可分批生成：以 `VIDEO_PERF_CASES` 指定以逗號分隔的案例名稱，各次使用不同 runId。`VIDEO_PERF_MERGE=1`、`VIDEO_PERF_MERGE_SOURCE_IDS`（逗號分隔來源）與新的 `VIDEO_PERF_MERGE_ID` 執行 `node scripts/video-acceptance/merge-performance.mjs`，須五種案例各一個，來源與複本都驗 hash 並在新 manifest 記來源；不改來源。`probe-performance.mjs` 以 `VIDEO_PROBE_RUN=1`、`VIDEO_PERF_SOURCE_ID` 與 `VIDEO_PROBE_CASE` 執行產品預設 deadline 的單次 probe，資料保存新 run，不載模型。

執行權限由操作者設定 `VIDEO_ACCEPTANCE_ENVIRONMENT=normal-permissions` 標記，未設定時報告為 `sandbox-or-unspecified`；此欄是操作紀錄，不會自行驗證實際 sandbox。Windows sandbox 對程序終止可能有干擾，取消／deadline 的正式量測需使用一般程序權限，並保存執行脈絡。

WAV 敲門合成素材可用 `node scripts/video-acceptance/prepare-knock.mjs` 產生，`VIDEO_AUDIO_FIXTURE_RUN_ID` 可指定新 runId；此工具僅在新目錄寫合成 WAV，hash 必須為 `c0fdef41a0af25c5bc4a16472c9cda1028ee150049c8293b715ea8712e6a0904`。品質及效能 runner 使用相同變數可讀取這份素材；未指定時讀既有 `.tmp/audio-indexing-acceptance/fixtures/f04.wav`，兩種都驗 hash。既有 `scripts/audio-indexing-acceptance-prepare.ts` 會覆寫共用音訊驗收 fixture／manifest，不要直接以它重建而覆蓋現有資料。
