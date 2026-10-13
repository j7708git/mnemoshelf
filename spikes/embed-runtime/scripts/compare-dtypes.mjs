// Q3：比較各 dtype 的向量與 fp32 的餘弦相似度（文字）。讀 results/bench-*.json，不重新載入模型。
import fs from "node:fs";
import path from "node:path";
import { cosine } from "../lib/embedder.mjs";
import { RESULTS_DIR, jsonWrite } from "../lib/paths.mjs";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};
const baselineLabel = flag("baseline", "fp32");
const labels = flag("labels", "q8,q4").split(",").filter(Boolean);

function readResult(label) {
  const file = path.join(RESULTS_DIR, `bench-${label}.json`);
  if (!fs.existsSync(file)) return null;
  return { file, data: JSON.parse(fs.readFileSync(file, "utf8")) };
}

function textRowsMap(result) {
  const map = new Map();
  for (const row of result.text.rows) map.set(row.id, row);
  return map;
}

function summarize(pairs) {
  const cosines = pairs.map((pair) => pair.cosine);
  const sorted = [...cosines].sort((a, b) => a - b);
  return {
    count: cosines.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean: cosines.reduce((acc, value) => acc + value, 0) / cosines.length,
    worstItem: pairs.find((pair) => pair.cosine === sorted[0])?.id ?? null,
  };
}

const baseline = readResult(baselineLabel);
if (!baseline) {
  console.log(`[compare] 找不到 baseline results/bench-${baselineLabel}.json；先跑 pnpm run bench:${baselineLabel}`);
  process.exitCode = 1;
} else {
  const baselineRows = textRowsMap(baseline.data);
  const report = { baseline: baselineLabel, generatedAt: new Date().toISOString(), dtypes: {}, missing: [] };
  for (const label of labels) {
    const other = readResult(label);
    if (!other) {
      report.missing.push(label);
      continue;
    }
    const rows = textRowsMap(other.data);
    const textPairs = [];
    for (const [id, baseRow] of baselineRows) {
      const row = rows.get(id);
      if (!row) continue;
      textPairs.push({ id, cosine: cosine(baseRow.embedding, row.embedding) });
    }
    const perDimension = {};
    for (const dim of [512, 256]) {
      const pairs = [];
      for (const [id, baseRow] of baselineRows) {
        const row = rows.get(id);
        if (!row) continue;
        const a = baseRow.embedding.slice(0, dim);
        const b = row.embedding.slice(0, dim);
        const norm = (v) => {
          const n = Math.sqrt(v.reduce((acc, x) => acc + x * x, 0));
          return v.map((x) => x / n);
        };
        pairs.push({ id, cosine: cosine(norm(a), norm(b)) });
      }
      perDimension[`dim${dim}`] = summarize(pairs);
    }
    report.dtypes[label] = {
      text768: summarize(textPairs),
      perDimension,
      worstRows: [...textPairs].sort((a, b) => a.cosine - b.cosine).slice(0, 3),
      meta: {
        dtype: other.data.meta.dtype,
        modalities: other.data.meta.modalities,
        cacheDir: other.data.meta.cacheDir,
        loadWallMs: other.data.meta.loadWallMs,
        rssAfterLoadMiB: other.data.meta.rssAfterLoadMiB,
      },
    };
  }
  const outFile = path.join(RESULTS_DIR, "compare-dtypes.json");
  jsonWrite(outFile, report);
  for (const [label, value] of Object.entries(report.dtypes)) {
    console.log(
      `[compare] ${label} vs ${baselineLabel}（文字 768d）：min ${value.text768.min.toFixed(4)}、mean ${value.text768.mean.toFixed(4)}、最差：${value.text768.worstItem}`,
    );
    console.log(
      `          512d min ${value.perDimension.dim512.min.toFixed(4)}；256d min ${value.perDimension.dim256.min.toFixed(4)}`,
    );
  }
  console.log(`[compare] 結果寫入 results/compare-dtypes.json`);
}
