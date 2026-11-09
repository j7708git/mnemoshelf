# 混合索引基準（里程碑 1）

只生成合成資料；語料、SQLite、報告均放在 `.tmp/indexing-benchmark/`。不新增依賴，
不掃描任何既有 root。`accounting` 使用無語意的固定雜湊向量，只驗證切塊、計數、交易、
取消與恢復，不能作速度／品質宣稱。`real` 使用正式 `WorkerEmbedder`、正式索引器與 SQLite；
先通過正式 probe，且 worker 明確設定 `env.allowRemoteModels=false`，沒有快取即失敗，
不下載模型。

先依專案既有方式建置 core、embedder-transformers、server。以下指令在 repo 根目錄執行，
Node 需支援 TypeScript stripping（本機實測 Node 24.13.0；Node 22 請使用 22.18 以上）：

```powershell
node --experimental-strip-types scripts/indexing-benchmark/run.ts --mode accounting --profile mixed --repetitions 3 --label accounting
node --experimental-strip-types scripts/indexing-benchmark/freeze-baseline.ts HEAD baseline
node --experimental-strip-types scripts/indexing-benchmark/run.ts --mode real --profile focus --device cpu --repetitions 6 --label baseline --indexer-module .tmp/indexing-benchmark/frozen-baseline/indexer.js --worker-module .tmp/indexing-benchmark/frozen-baseline/worker-embedder.js --worker-entry-module .tmp/indexing-benchmark/frozen-baseline/embedder-worker.js
node --experimental-strip-types scripts/indexing-benchmark/run.ts --mode real --profile focus --device cpu --repetitions 6 --label candidate
node --experimental-strip-types scripts/indexing-benchmark/compare.ts <baseline-report.json> <candidate-report.json> <comparison.json>
pnpm --filter @mnemoshelf/core exec tsc -p ../../scripts/indexing-benchmark/tsconfig.json
pnpm --filter @mnemoshelf/core exec vitest run --config ../../scripts/indexing-benchmark/vitest.config.ts
```

所有實際輸出路徑都由 `node:path` 計算。`--indexer-module <module>` 可以指向比較前保存的
baseline 模組；模組內相對匯入須仍能解析。預設使用當前 `dist`，所以來源有變時必須重建，
不可把舊 build 當候選結果。比較的 profile、模式、語料 digest 必須相同。可用
`--device cpu|dml|auto` 明示裝置，需比較相同實際裝置、dtype 與 runtime。避免同時跑其他推論。
`freeze-baseline.ts` 從指定 Git ref 擷取原 indexer、scan、WorkerEmbedder proxy 與 worker 入口，
以既有 TypeScript 編譯器去型別後保存至暫存；manifest 同時記錄 commit、原碼 hash 與可執行
hash。儲存、切塊、路徑安全與模型本體使用現有 build，報告會列出其 hash；不可在兩組間改動
這些共用元件。必須一起指定三個 module 選項，只有原 indexer 搭配新 proxy 不是正確基線。

`smoke` 有 21 檔：長／短中英文文字、長／短 TypeScript、兩份相同文字不同檔名、兩張 PNG、
一個 PCM WAV、一個單幀未壓縮 AVI、壞 PNG、偽裝文字的二進位與 ZIP。`mixed` 擴大長檔與
短檔數量。`focus` 保留 smoke 的 21 檔，只把長文字增加至 42 個實際 core chunks，確保預設
16 筆排程窗至少讓出兩次，避免把小於一窗的 smoke 當成長批次回應性測試。
音訊／影片只測不支援時的回報，沒有音訊／影片語意檢索品質主張；壞媒體不能
算成功。相同內容不同檔名仍是不同檔案，不能誤當同一個來源去重。

每個 repetition 都建立新的 embedder，先記錄 `probeMs`（冷初始化＋正式語意 probe），再以
新 DB 量測 `first-after-probe`；`warm` 是同一 loaded 模型的後續全新 DB。**兩組索引都在
模型載入後開始，沒有量到直接從冷模型開始的索引時間。**沒有清空 OS page cache，也不是
下載冷啟動。冷初始化與兩組 loaded-model 索引各至少三次。每次包含 first-build、unchanged、
只改一檔 partial-edit；另有一次取消後重新索引。取消要求在第一個檔案完成提交的進度邊界
發出，不能據此宣稱 native 推論可即時中斷；重新索引前會 drain worker。
取消專用情境明示檔案併發為 1，避免舊版 indexer 的 fail-fast 讓另一個檔案 worker 在下一
階段繼續回報。first/start/counters/progress 觀察者逐階段隔離。需要獨立補驗時可用
`--scenario cancel-only --repetitions 1`，其報告不能冒充完整效能樣本。

`firstSearchableMs` 以向量入庫後實際 KNN 自我向量命中為準，非語意相關性判斷；從索引
呼叫開始計時，包含掃描。每 250ms 嘗試一個 `unifiedSearch`（包含查詢 embedding、查詢、
讀取與呈現），前一查詢未完成時不再排隊；記錄略過 tick 及錯誤數。比較只取 warm first-build
期間**發出**的查詢，回應可在索引完成後結束；P95 採 nearest-rank。這不是 HTTP／MCP 端到端
延遲。總時間包含量測掛鉤，所有比較均使用相同掛鉤。RSS 是整個 Node 行程（包含 worker），
20ms 取樣加上進度邊界取樣，可能漏掉極短峰值；不包含 GPU VRAM。
總時間中位數的偶數樣本取中央兩值平均；比較器亦保留 nearest-rank P50 的下中位數供核對。
此定義在候選比較前修正，對兩組完全相同；不能依門檻結果選算法。

## 比較前凍結的判準

以下於 2026-11-08、候選比較前凍結，重點是長檔索引時的查詢回應性：

- 正確性：檔案結果可對帳；缺向量與孤兒向量皆零；chunk 數等於向量數；unchanged 不重做
  有效檔案且文字重嵌零；partial-edit 恰處理一檔；取消後重跑與完整初建的 chunk 數相同。
  壞媒體每輪重試不算有效檔案重嵌。
- 同一合成 chunk 的真實向量 cosine ≥ 0.999，來源鍵集合完全相同。
- 真模型至少三次冷初始化、first-after-probe／warm，warm first-build 的查詢樣本合計至少
  20 筆，才評效能。建議 focus 六次，因單一在途查詢在舊排程的長批次下樣本較少。
- warm 查詢 P95 至少改善 25%；warm 索引總時間中位數不得增加超過 10%。25% 用以超過少量
  計時雜訊並代表可感受的改善；10% 保留排程與跨平台變動空間。
- RSS 不超過 baseline × 1.20 + 256 MiB：允許 worker／native 配置變動，同時拒絕無界輸入緩衝。

任何 failedFiles／查詢錯誤、空品質集合、預期合成來源鍵／chunk 數不符、實際 runtime／
模型維度身分／套件版本不相符，皆不得通過；實際 trial 數也必須足夠，不能只相信命令參數。
模型本體、切塊、SQLite metadata／vector 的共用實作 hash 亦須完全相同；取消紀錄必須恰有
一組具名 cancel／cancel-rerun、併發1，空集合不能憑空通過。
樣本不足或只有假模型時，效能判準輸出 `null`，不能算通過。未通過的數據照實保留，不降低
門檻來配合結果。first-per-kind 與 stage 時間只作診斷，不強制提升每個模態的第一筆時間；
逐檔交易意味着公平批次不保證長檔更早完整可搜尋。若索引器提供可選 `onTiming`，報告會
合計 scan/read/prepare/embed/write；平行 stage 累加可以大於 wall time。
