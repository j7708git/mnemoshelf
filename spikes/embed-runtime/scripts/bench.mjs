// 主量測腳本（A–E）：載入 → 文字 → 圖片 → 檢索探測 → 截斷。
//
// 用法：
//   node scripts/bench.mjs --dtype q8  --vision   --label q8      # 文字+圖片
//   node scripts/bench.mjs --dtype q4  --vision   --label q4
//   node scripts/bench.mjs --dtype fp32 --text-only --label fp32 # 只跑文字（下載量較小）
//
// 每個 dtype 一個獨立的 HF 快取目錄，首次執行會下載模型。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  MODEL_ID,
  configureCache,
  cpuSummary,
  documentPrefix,
  loadEmbedder,
  loadImageFile,
  queryPrefix,
  runModel,
  truncateAndNormalize,
  vectorStats,
} from "../lib/embedder.mjs";
import { DOCUMENTS, LONG_DOCUMENT, QUERIES } from "../lib/corpus.mjs";
import { IMAGES } from "../lib/corpus-images.mjs";
import { retrievalReport, textRetrievalReport } from "../lib/retrieval.mjs";
import { ASSET_OUT_DIR, RESULTS_DIR, dirSizeBytes, humanBytes, jsonWrite, SPIKE_ROOT } from "../lib/paths.mjs";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};
const has = (name) => args.includes(`--${name}`);

const dtype = flag("dtype", "q8");
const label = flag("label", dtype);
const withVision = !has("text-only");
const imageSoftTokenBudgets = [70, 280];

const mib = (bytes) => Number((bytes / 1024 / 1024).toFixed(1));
const ms = (nanos) => Number((nanos).toFixed(1));
const now = () => performance.now();
const rss = () => process.memoryUsage().rss;
const peakRss = () => process.resourceUsage().maxRSS * 1024; // Linux: KB

async function embedText(processor, model, texts) {
  const started = now();
  const inputs = await processor(texts);
  const processedMs = now() - started;
  const seqLen = inputs.input_ids?.dims?.[1] ?? null;
  const batch = inputs.input_ids?.dims?.[0] ?? null;
  const inferStarted = now();
  const { data, attempts } = await runModel(model, inputs);
  const inferMs = now() - inferStarted;
  return { embeddings: data, seqLen, batch, processedMs, inferMs, attempts, totalMs: processedMs + inferMs };
}

async function embedImages(processor, model, rawImages) {
  // rawImages 為單一輸入的圖片清單：[[img]] 表示 1 個輸入（1 張圖），
  // [[i1],[i2],[i3],[i4]] 表示 4 個輸入（官方模型卡：一個 list 一個輸入）。
  const started = now();
  const inputs = await processor(null, rawImages);
  const processedMs = now() - started;
  const softTokens = inputs.num_soft_tokens_per_image ?? null;
  const pixelValuesDims = inputs.pixel_values?.dims ?? null;
  const inferStarted = now();
  const { data, attempts } = await runModel(model, inputs);
  const inferMs = now() - inferStarted;
  return { embeddings: data, softTokens, pixelValuesDims, processedMs, inferMs, attempts, totalMs: processedMs + inferMs };
}

async function main() {
  const cacheDir = configureCache(dtype);
  const cacheBefore = dirSizeBytes(cacheDir);
  const meta = {
    label,
    dtype,
    dtypeMap: null,
    modalities: withVision ? "text+image" : "text",
    modelId: MODEL_ID,
    date: new Date().toISOString(),
    node: process.version,
    pnpm: null,
    transformers: null,
    platform: `${os.platform()} ${os.release()} ${os.arch()}`,
    cpu: cpuSummary(),
    totalMemBytes: os.totalmem(),
    loadAvgAtStart: os.loadavg(),
    cacheDir: path.relative(SPIKE_ROOT, cacheDir).split(path.sep).join("/"),
    cacheBytesBefore: cacheBefore,
  };
  meta.transformers = JSON.parse(
    fs.readFileSync(path.join(SPIKE_ROOT, "node_modules", "@huggingface", "transformers", "package.json"), "utf8"),
  ).version;
  try {
    meta.pnpm = JSON.parse(fs.readFileSync(path.join(SPIKE_ROOT, "package.json"), "utf8")).packageManager ?? null;
  } catch {
    meta.pnpm = null;
  }

  console.log(`[bench] label=${label} dtype=${dtype} modalities=${meta.modalities} cache=${meta.cacheDir}`);

  // ---------- A. 載入（含首次下載）----------
  const loadStarted = now();
  const { processor, model, loadMs, dtypeMap, components } = await loadEmbedder({
    dtype,
    modalities: withVision ? "text+image" : "text",
  });
  const loadWallMs = now() - loadStarted;
  const cacheAfter = dirSizeBytes(cacheDir);
  const rssAfterLoad = rss();
  meta.dtypeMap = dtypeMap;
  meta.loadMs = ms(loadMs);
  meta.loadWallMs = ms(loadWallMs);
  meta.cacheBytesAfter = cacheAfter;
  meta.downloadedBytes = Math.max(0, cacheAfter - cacheBefore);
  meta.downloadedHuman = humanBytes(meta.downloadedBytes);
  meta.downloadWasCold = cacheBefore === 0;
  meta.rssAfterLoadBytes = rssAfterLoad;
  meta.rssAfterLoadMiB = mib(rssAfterLoad);
  meta.sessions = components;
  console.log(
    `[bench] loaded in ${meta.loadWallMs} ms; 下載 ${meta.downloadedHuman} (cold=${meta.downloadWasCold}); RSS ${meta.rssAfterLoadMiB} MiB`,
  );

  // ---------- B. 文字 ----------
  // 暖機（不計入延遲量測）
  await embedText(processor, model, queryPrefix(QUERIES[0].text));

  const textRows = [];
  const sentenceList = [
    ...QUERIES.map((item) => ({ ...item, role: "query", prefixed: queryPrefix(item.text) })),
    ...DOCUMENTS.map((item) => ({ ...item, role: "document", prefixed: documentPrefix(item.text, item.title) })),
  ];
  for (const item of sentenceList) {
    const result = await embedText(processor, model, item.prefixed);
    textRows.push({
      id: item.id,
      role: item.role,
      lang: item.lang,
      kind: item.kind,
      chars: item.text.length,
      tokens: result.seqLen,
      latencyMs: ms(result.totalMs),
      processedMs: ms(result.processedMs),
      inferMs: ms(result.inferMs),
      embedding: result.embeddings[0],
      stats: vectorStats(result.embeddings[0]),
    });
  }

  // 長文（約 500 token）
  const longDocPrefixed = documentPrefix(LONG_DOCUMENT, "indexing-notes");
  const longResult = await embedText(processor, model, longDocPrefixed);
  const longDoc = {
    id: "d_long_zh",
    role: "document",
    lang: "zh",
    chars: LONG_DOCUMENT.length,
    tokens: longResult.seqLen,
    latencyMs: ms(longResult.totalMs),
    processedMs: ms(longResult.processedMs),
    inferMs: ms(longResult.inferMs),
    embedding: longResult.embeddings[0],
    stats: vectorStats(longResult.embeddings[0]),
  };

  // 批次（12 句同批；另加含長文的 13 句，用來看 padding 的影響）
  const batchTexts = sentenceList.map((item) => item.prefixed);
  const batchResult = await embedText(processor, model, batchTexts);
  const textBatch = {
    count: batchTexts.length,
    totalMs: ms(batchResult.totalMs),
    processedMs: ms(batchResult.processedMs),
    inferMs: ms(batchResult.inferMs),
    maxTokensPerItem: batchResult.seqLen,
  };
  const batchWithLongResult = await embedText(processor, model, [...batchTexts, longDocPrefixed]);
  const textBatchWithLong = {
    count: batchTexts.length + 1,
    totalMs: ms(batchWithLongResult.totalMs),
    inferMs: ms(batchWithLongResult.inferMs),
    maxTokensPerItem: batchWithLongResult.seqLen,
  };

  const textAvg = textRows.reduce((acc, row) => acc + row.latencyMs, 0) / textRows.length;
  console.log(
    `[bench] 文字：單句平均 ${textAvg.toFixed(1)} ms（${textRows.length} 句）；長文 ${longDoc.tokens} token ${longDoc.latencyMs} ms；批次 ${textBatch.count} 句 ${textBatch.totalMs} ms`,
  );

  const textSection = {
    rows: textRows,
    longDoc,
    batch: textBatch,
    batchWithLong: textBatchWithLong,
    avgLatencyMs: ms(textAvg),
    shortAvgLatencyMs: ms(
      textRows.filter((row) => (row.tokens ?? 0) <= 40).reduce((acc, row) => acc + row.latencyMs, 0) /
        Math.max(1, textRows.filter((row) => (row.tokens ?? 0) <= 40).length),
    ),
  };

  // ---------- C. 圖片 + D. 檢索探測 ----------
  let imageSection = null;
  let retrievalSection = null;
  if (withVision) {
    if (!fs.existsSync(path.join(ASSET_OUT_DIR, IMAGES[0].file))) {
      throw new Error(`找不到測試圖片，請先執行 pnpm run assets（缺 ${path.join(ASSET_OUT_DIR, IMAGES[0].file)}）`);
    }
    const rawImages = new Map();
    for (const image of IMAGES) {
      rawImages.set(image.id, await loadImageFile(path.join(ASSET_OUT_DIR, image.file)));
    }

    imageSection = { budgets: {}, batchTimings: [] };
    for (const budget of imageSoftTokenBudgets) {
      processor.image_processor.max_soft_tokens = budget;
      const rows = [];
      let softTokenCounts = null;
      for (const image of IMAGES) {
        const result = await embedImages(processor, model, [[rawImages.get(image.id)]]);
        softTokenCounts = result.softTokens;
        rows.push({
          id: image.id,
          latencyMs: ms(result.totalMs),
          processedMs: ms(result.processedMs),
          inferMs: ms(result.inferMs),
          softTokens: result.softTokens,
          pixelValuesDims: result.pixelValuesDims,
          embedding: result.embeddings[0],
          stats: vectorStats(result.embeddings[0]),
        });
      }
      // 重複一次（暖機後的穩定值）；第一次的呼叫含 kernel 暖機
      const warmRows = [];
      for (const image of IMAGES) {
        const result = await embedImages(processor, model, [[rawImages.get(image.id)]]);
        warmRows.push({
          id: image.id,
          latencyMs: ms(result.totalMs),
          inferMs: ms(result.inferMs),
          softTokens: result.softTokens,
          pixelValuesDims: result.pixelValuesDims,
        });
      }
      const means = (list) => ms(list.reduce((acc, row) => acc + row.latencyMs, 0) / list.length);
      imageSection.budgets[`budget${budget}`] = {
        budget,
        softTokensSample: softTokenCounts,
        rows,
        warmRows,
        meanLatencyMsFirstPass: means(rows),
        meanLatencyMsWarm: means(warmRows),
      };
      console.log(
        `[bench] 圖片 budget=${budget}：首輪平均 ${means(rows).toFixed(1)} ms、暖機後平均 ${means(warmRows).toFixed(1)} ms（soft tokens ${JSON.stringify(softTokenCounts)}）`,
      );
    }

    // 批次 4 張（70 與 280）
    for (const budget of imageSoftTokenBudgets) {
      processor.image_processor.max_soft_tokens = budget;
      const four = IMAGES.slice(0, 4).map((image) => [rawImages.get(image.id)]);
      const timings = [];
      for (let i = 0; i < 2; i += 1) {
        const result = await embedImages(processor, model, four);
        timings.push({
          batch: 4,
          budget,
          totalMs: ms(result.totalMs),
          inferMs: ms(result.inferMs),
          softTokens: result.softTokens,
          pixelValuesDims: result.pixelValuesDims,
        });
      }
      imageSection.batchTimings.push(...timings);
      const best = timings.reduce((acc, row) => Math.min(acc, row.totalMs), Number.POSITIVE_INFINITY);
      console.log(`[bench] 圖片批次 4 張 budget=${budget}：最佳 ${best.toFixed(1)} ms`);
    }

    // ---- D. 檢索探測（圖 × 描述）----
    const queryMeta = [];
    for (const image of IMAGES) {
      queryMeta.push({ id: `${image.id}#en`, imageId: image.id, lang: "en", text: image.descEn });
      queryMeta.push({ id: `${image.id}#zh`, imageId: image.id, lang: "zh", text: image.descZh });
    }
    const queryEmbeddingResult = await embedText(processor, model, queryMeta.map((item) => queryPrefix(item.text)));
    const queryEmbeddings = queryMeta.map((item, index) => ({ ...item, embedding: queryEmbeddingResult.embeddings[index] }));

    const buildRetrieval = (dim, budget = 280) => {
      const imageEmbs = imageSection.budgets[`budget${budget}`].rows.map((row) => ({
        id: row.id,
        embedding: dim ? truncateAndNormalize(row.embedding, dim) : row.embedding,
      }));
      const queryRows = queryEmbeddings.map((item) => ({
        ...item,
        embedding: dim ? truncateAndNormalize(item.embedding, dim) : item.embedding,
      }));
      return retrievalReport(imageEmbs, queryRows);
    };

    retrievalSection = {
      dim768: buildRetrieval(null),
      dim512: buildRetrieval(512),
      dim256: buildRetrieval(256),
      // 額外：低 token 預算（70）在 768 維下的檢索品質，用來判斷 max_soft_tokens 的取捨
      dim768Budget70: buildRetrieval(null, 70),
    };
    for (const [name, report] of Object.entries(retrievalSection)) {
      console.log(
        `[bench] 檢索 ${name}：圖 Top-1 ${(report.summary.imageTop1Accuracy * 100).toFixed(0)}%、查詢 Top-1(raw) ${(report.summary.queryTop1RawAccuracy * 100).toFixed(0)}%、中文查詢 Top-1(raw) ${(report.summary.queryTop1RawAccuracyZh * 100).toFixed(0)}%、最小邊界 ${report.summary.minMargin.toFixed(3)}`,
      );
    }
    imageSection.retrievalQueryTokens = queryEmbeddingResult.seqLen;
  }

  // 文字 ↔ 文字 檢索（用 768 維）
  const textQueries = textRows.filter((row) => row.role === "query").map((row) => ({ id: row.id, embedding: row.embedding }));
  const textDocs = textRows.filter((row) => row.role === "document").map((row) => ({ id: row.id, embedding: row.embedding }));
  const textRetrieval = textRetrievalReport(textQueries, textDocs);

  // ---------- 記憶體 ----------
  meta.rssAfterBenchBytes = rss();
  meta.rssAfterBenchMiB = mib(rss());
  meta.peakRssBytes = peakRss();
  meta.peakRssMiB = mib(peakRss());
  meta.loadAvgAtEnd = os.loadavg();

  const output = {
    meta,
    text: textSection,
    textRetrieval,
    images: imageSection,
    retrieval: retrievalSection,
    errors: [],
  };
  const outFile = path.join(RESULTS_DIR, `bench-${label}.json`);
  jsonWrite(outFile, output);
  console.log(`[bench] RSS：載入後 ${meta.rssAfterLoadMiB} MiB、量測後 ${meta.rssAfterBenchMiB} MiB、峰值 ${meta.peakRssMiB} MiB`);
  console.log(`[bench] 結果寫入 ${path.relative(SPIKE_ROOT, outFile)}`);
}

try {
  await main();
} catch (error) {
  // 中途失敗也要留下已完成的部分，方便除錯與回報
  const failedFile = path.join(RESULTS_DIR, `bench-${label}.failed.json`);
  jsonWrite(failedFile, {
    meta: {
      label, dtype, modalities: withVision ? "text+image" : "text", date: new Date().toISOString(),
      node: process.version, platform: `${os.platform()} ${os.release()} ${os.arch()}`, cpu: cpuSummary(),
    },
    error: { message: String(error?.message ?? error), stack: String(error?.stack ?? "") },
  });
  console.error(`[bench] 失敗：${error?.message ?? error}`);
  console.error(`[bench] 已寫入 ${path.relative(SPIKE_ROOT, failedFile)}`);
  process.exitCode = 1;
}
