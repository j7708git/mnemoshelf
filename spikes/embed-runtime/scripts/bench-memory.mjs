// 記憶體與延遲探測：逐階段量 RSS（找出峰值出現在哪個階段），並在「同一台機器、同一時間、
// 沒有其他下載」的條件下量各 dtype 的暖機延遲，用來公平比較 q8 與 q4。
// 與 bench.mjs 分開：bench 是完整量測（含下載與冷啟動），這支是受控的對照。
//
// 用法：node scripts/bench-memory.mjs [--dtype q8|q4|fp32]
import {
  configureCache,
  loadEmbedder,
  loadImageFile,
  queryPrefix,
  runModel,
  documentPrefix,
} from "../lib/embedder.mjs";
import { DOCUMENTS, QUERIES } from "../lib/corpus.mjs";
import { IMAGES } from "../lib/corpus-images.mjs";
import { ASSET_OUT_DIR, RESULTS_DIR, jsonWrite } from "../lib/paths.mjs";
import path from "node:path";
import os from "node:os";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};
const dtype = flag("dtype", "q8");
const modalities = args.includes("--text-only") ? "text" : "text+image";

const mib = (bytes) => Number((bytes / 1024 / 1024).toFixed(1));
const samples = [];
const stages = [];
const record = (stage, ms = null) => {
  const usage = process.memoryUsage();
  const entry = {
    stage,
    ms,
    rssMiB: mib(usage.rss),
    heapUsedMiB: mib(usage.heapUsed),
    externalMiB: mib(usage.external),
    peakRssMiB: mib(process.resourceUsage().maxRSS * 1024),
  };
  samples.push(entry);
  if (ms !== null) stages.push({ stage, ms });
  console.log(
    `[mem] ${stage.padEnd(34)} ${ms === null ? "" : `${String(ms).padStart(9)} ms`}  rss=${String(entry.rssMiB).padStart(8)} MiB  peak=${String(entry.peakRssMiB).padStart(8)} MiB`,
  );
};

async function timed(stage, fn) {
  const started = performance.now();
  const value = await fn();
  record(stage, Number((performance.now() - started).toFixed(1)));
  return value;
}

configureCache(dtype);
record("start");
const { processor, model } = await timed("load (cache 已暖)", () => loadEmbedder({ dtype, modalities }));

const textInputs = await processor([
  ...QUERIES.map((item) => queryPrefix(item.text)),
  ...DOCUMENTS.map((item) => documentPrefix(item.text, item.title)),
]);
const textResult = await timed(`text batch ${textInputs.input_ids.dims[0]} 句（max ${textInputs.input_ids.dims[1]} token）`, () =>
  runModel(model, textInputs),
);

// 逐句延遲（單句一次呼叫）：這是「文字單句延遲」的正式數字，12 句都用同一個 process 暖機後量。
const perSentence = [];
for (const item of [
  ...QUERIES.map((entry) => ({ id: entry.id, role: "query", text: queryPrefix(entry.text) })),
  ...DOCUMENTS.map((entry) => ({ id: entry.id, role: "document", text: documentPrefix(entry.text, entry.title) })),
]) {
  const started = performance.now();
  const inputs = await processor([item.text]);
  const result = await runModel(model, inputs);
  perSentence.push({
    id: item.id,
    role: item.role,
    tokens: inputs.input_ids.dims[1],
    embedDims: result.dims,
    latencyMs: Number((performance.now() - started).toFixed(1)),
  });
}
const sentenceMean = perSentence.reduce((acc, row) => acc + row.latencyMs, 0) / perSentence.length;
record(`12 句逐句平均 ${sentenceMean.toFixed(1)} ms`, Number(sentenceMean.toFixed(1)));
for (const row of perSentence) {
  console.log(`[mem]   ${row.id.padEnd(18)} ${String(row.tokens).padStart(3)} tok  ${String(row.latencyMs).padStart(8)} ms`);
}

let imageSection = null;
if (modalities === "text+image") {
  const raw = [];
  for (const image of IMAGES) raw.push(await loadImageFile(path.join(ASSET_OUT_DIR, image.file)));
  record("decode 6 images");

  imageSection = {};
  for (const budget of [70, 280]) {
    processor.image_processor.max_soft_tokens = budget;
    // 切換 token 預算後第一次呼叫（可能觸發圖形重編譯）
    await timed(`1 image first call (budget ${budget})`, async () => runModel(model, await processor(null, [[raw[0]]])));
    await timed(`1 image warm (budget ${budget})`, async () => runModel(model, await processor(null, [[raw[0]]])));
    await timed(`batch 4 images (budget ${budget})`, async () => runModel(model, await processor(null, raw.slice(0, 4).map((image) => [image]))));
    record(`peak after budget ${budget} stage`);
  }
}

jsonWrite(path.join(RESULTS_DIR, `memory-${dtype}.json`), {
  dtype,
  modalities,
  date: new Date().toISOString(),
  node: process.version,
  platform: `${os.platform()} ${os.release()} ${os.arch()}`,
  loadAvg: os.loadavg(),
  perSentence,
  sentenceMeanMs: Number(sentenceMean.toFixed(1)),
  textBatchDims: textInputs.input_ids.dims,
  textDims: textResult.dims,
  samples,
  stages,
});
console.log(`[mem] 結果寫入 results/memory-${dtype}.json`);
