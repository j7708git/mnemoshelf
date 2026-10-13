# @mnemoshelf/embedder-transformers

以 `@huggingface/transformers`（ONNX、CPU）實作 `@mnemoshelf/core` 的 `Embedder` port。
預設基線來自 M0 spike 實測：EmbeddingGemma 2、dtype `q4`（逐元件）、輸出截斷成 512 維後
重新 L2 正規化、圖片 `max_soft_tokens=70`。

## 用法

```ts
import { TransformersEmbedder } from "@mnemoshelf/embedder-transformers";

const embedder = new TransformersEmbedder();          // lazy：建構子不載模型
await embedder.probe();                               // 啟動探測（契約要求，未過不得啟用）
const vec = await embedder.embedQuery("向量檢索");     // Float32Array(512)，已正規化
await embedder.dispose();                             // 冪等；之後再 embed 會自動重載
```

選項：`{ modelId?, dtype?, dim?, cacheDir?, maxSoftTokens? }`。`dim` 僅允許 128/256/512/768；
`dtype` 允許 `fp32/q8/q4/q4f16`（**`fp16` 依契約明確拒絕**）。`info.id` 含 dtype
（如 `embeddinggemma-2@onnx-q4`），換 dtype 即換 id。

模型快取目錄解析序：`cacheDir` 選項 → 環境變數 `MNEMOSHELF_MODEL_DIR` →
OS 使用者資料目錄下的 `mnemoshelf/models`。

## 已知相依與限制

- **圖片解碼走 sharp**（`@huggingface/transformers` 的 `load_image`）：sharp 依平台提供 prebuild；
  在沒有對應 prebuild 的平台／架構上，**圖片嵌入能力會失效**。`probe()` 的圖片子項會抓到這個
  失敗（probe 回傳 `{ok:false}`）。部署前請在目標平台跑一次 `probe()` 確認。
- 模型下載約 300 MB（q4 文字＋視覺＋tokenizer），首次使用時下載到快取目錄。
- 音訊／影片未支援（`audio_config=null`，`capabilities` 如實宣告）。
- `dispose()` 在模型載入進行中被呼叫時，載入完成後才會實際釋放（競態視窗已知，
  單一寫入者架構下無實際影響；見 `embedder.ts` 的 doc comment）。

## 測試

- `pnpm test`：預設套件**不下載模型**（真實模型契約以 `MNEMOSHELF_E2E=1` 閘控）。
- `pnpm run e2e`：下載模型（快取 `.tmp/models`）→ probe → 量延遲與 RSS。
