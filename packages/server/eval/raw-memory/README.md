# 原文記憶合成基準

> 讀者｜正在驗證 Mnemoshelf 記憶召回的開發者。
> 一句話｜用相同題目與預算比較 dsh 回合卡、原文切塊及同回合鄰近展開。
> 現在要做｜選擇關鍵字或離線真向量模式，讀取逐題 JSON。
> 依據｜同目錄的 `fixture.ts`、`representations.ts` 與 `baseline.test.ts`。

在 repo 根目錄執行：

```sh
RAW_MEMORY_BENCH=1 RAW_MEMORY_BACKEND=keyword pnpm --filter @mnemoshelf/server exec vitest --config eval/raw-memory/vitest.config.ts run
RAW_MEMORY_BENCH=1 RAW_MEMORY_BACKEND=real pnpm --filter @mnemoshelf/server exec vitest --config eval/raw-memory/vitest.config.ts run
pnpm --filter @mnemoshelf/server exec tsc --noEmit -p eval/raw-memory/tsconfig.json
```

`RAW_MEMORY_SPLIT=tune` 或 `holdout` 可單跑一組。每次執行在 `.tmp/raw-memory-baseline/` 下建立一個獨立目錄，內有 SQLite 與逐題 JSON。只使用程式內建的合成語料。真向量模式使用既有 EmbeddingGemma 2 q4，明示 CPU 並禁止遠端模型下載。預設查找 `.tmp/speed-diagnosis/models/`，也可用 `RAW_MEMORY_MODEL_CACHE` 指定已存在的快取。關鍵字模式無需模型。只有找到可用的 EmbeddingGemma tokenizer 時才量 token。

`dsh-current` 套用現行卡片、搜尋及注入參數。其餘三組用同一個候選上限、封裝格式及預算，比較 900 Unicode 碼點與 192／384／768 個 EmbeddingGemma token。計數包含完整封裝。這些 token 數供同 tokenizer 的預算比較，實際回答模型的 token 另計。OpenCode 只測截斷後的摘要輸入能否看到證據。

JSON 內的 `retrieved` 是排名候選含幾段必要證據，`injected` 是封裝後含幾段。多段題須全部命中才算完整。無答案題另外統計帶入無關上下文的比例。回答正確率及拒答由 reader 評估，本工具只評檢索與封裝。

## 產品版

```sh
RAW_MEMORY_PRODUCT=1 RAW_MEMORY_BACKEND=real RAW_MEMORY_SPLIT=tune pnpm --filter @mnemoshelf/server exec vitest --config eval/raw-memory/vitest.config.ts run eval/raw-memory/product.test.ts
```

改用 `RAW_MEMORY_BACKEND=keyword` 可跑全文索引對照。完成調參後用 `RAW_MEMORY_SPLIT=holdout` 執行保留集。產品評測在隔離資料目錄啟動 loopback HTTP，實際呼叫來源寫入、分頁讀取、政策與召回 API，再使用 dsh、OpenCode 的實際封裝器。JSON 區分完整命中切塊、服務節錄與最終注入的證據，並列出向量工作狀態、容量與耗時。token 封裝比較透過外掛的字元上限搜尋合規輸出，維持相同的真正模型 token 預算。原型組改用評測專用的歷史擷取、排名與封裝，得以和產品版並行重跑。


## Stage 3：40 題未見題庫、Naive RAG 對照與固定 Reader 評估

- `unseen-fixture.ts`：獨立種子（`482913`）與 10 個全新合成專案，共 40 題未見題庫（30 題可答、10 題無答案拒答），不與 `tune`／`holdout` 共用題型或詞表。
- `naive-rag.ts`：純原始對話切片基線（`User: ...\nAssistant: ...`，512 Unicode code points / 重疊 64、純向量 cosine top-4 `minScore=0`、同一 900 字元裝箱預算）。
- `stage3-reader.ts` 與 `stage3-e2e.test.ts`：預設跳過；執行實測：

```bash
STAGE3_EVAL=1 RAW_MEMORY_BACKEND=real pnpm --filter @mnemoshelf/server exec vitest \
  --config eval/raw-memory/vitest.config.ts run eval/raw-memory/stage3-e2e.test.ts
```

若要同時跑固定 OpenAI 相容 Reader 模型計算端到端回答／拒答準確率，額外設定：

- `STAGE3_READER_BASE_URL`（例如 `http://127.0.0.1:8080/v1`）
- `STAGE3_READER_MODEL`
- `STAGE3_READER_API_KEY`（選填）

未設定 `STAGE3_READER_*` 時，報告僅產出檢索裝箱對照指標，Reader 欄位明確標記 `NOT_RUN`。
