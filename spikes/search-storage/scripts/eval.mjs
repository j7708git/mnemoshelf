// Q2/Q3：中文檢索評測（同一組語料與查詢，T/B/S 三 FTS × 向量 × RRF 混合，含 title A/B）。
// 產生結果：results/eval.json（聚合數字，不含語料原文）
//
// 用法：
//   CORPUS_DIR=<語料目錄> node scripts/eval.mjs [--max-pairs=300] [--limit-docs=N]
//   --limit-docs 只嵌入前 N 塊（預設 0 = 全部）；用於快速煙霧測試。
//   --refresh 忽略向量快取重新嵌入。
import fs from "node:fs";
import path from "node:path";
import {
  blobToFloat32,
  ensureDir,
  jsonWrite,
  RESULTS_DIR,
  SPIKE_TMP_DIR,
  toBlob,
} from "../lib/paths.mjs";
import { buildPairs, bucketSizes, loadCorpus, queryBucket, titleLengthStats } from "../lib/corpus.mjs";
import { buildFtsIndex, makeRankers } from "../lib/fts.mjs";
import { evaluate, rrf } from "../lib/metrics.mjs";
import {
  embedderInfo,
  embedAll,
  DOC_PREFIX_NO_TITLE,
  DOC_PREFIX_WITH_TITLE,
  health,
  QUERY_PREFIX,
} from "../lib/embed.mjs";
import { loadVec, openDb } from "../lib/vecdb.mjs";

const CORPUS_DIR = process.env.CORPUS_DIR;
if (!CORPUS_DIR) {
  console.error("錯誤：必須設定環境變數 CORPUS_DIR 指向語料目錄");
  process.exit(1);
}
const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? Number(hit.split("=")[1]) : dflt;
};
const MAX_PAIRS = arg("max-pairs", 300);
const LIMIT_DOCS = arg("limit-docs", 0);
const REFRESH = process.argv.includes("--refresh");
const TOPK = 50;
const DIM = 512;
const CACHE_FILE = path.join(SPIKE_TMP_DIR, "eval-embed-cache.json");

// ---- 語料與查詢對 ----
const healthBefore = await health();
const corpus = loadCorpus(CORPUS_DIR);
const { eligibleCount, pairs } = buildPairs(corpus.docs, MAX_PAIRS);
const docs = LIMIT_DOCS > 0 ? corpus.docs.slice(0, LIMIT_DOCS) : corpus.docs;
// 只保留目標仍在 docs 內的查詢對（--limit-docs 煙霧測試時）
const pairsInDocs = pairs.filter((p) => p.targetId < docs.length);

console.log(`[eval] files=${corpus.files.length} chunks=${corpus.docs.length} totalChars=${corpus.totalChars}`);
console.log(`[eval] eligiblePairs=${eligibleCount} usedPairs=${pairsInDocs.length} buckets=${JSON.stringify(bucketSizes(pairsInDocs))}`);

// ---- 嵌入（含快取）----
const cache = !REFRESH && fs.existsSync(CACHE_FILE) ? JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")) : {};
const getCached = (text) => (cache[text] ? blobToFloat32(Buffer.from(cache[text], "base64")) : null);

const docTextsNone = docs.map((d) => DOC_PREFIX_NO_TITLE(d.body.slice(0, 1100)));
const docTextsTitle = docs.map((d) => DOC_PREFIX_WITH_TITLE(d.title, d.body.slice(0, 1100)));
const queryTexts = pairsInDocs.map((p) => QUERY_PREFIX(p.query));

async function embedWithCache(texts, label) {
  const missing = [];
  const out = new Array(texts.length);
  texts.forEach((t, i) => {
    const hit = getCached(t);
    if (hit) out[i] = hit;
    else missing.push(i);
  });
  console.log(`[eval] ${label}: ${texts.length} 筆，快取命中 ${texts.length - missing.length}，需嵌入 ${missing.length}`);
  if (missing.length === 0) return { out, embedSeconds: 0 };
  const t0 = Date.now();
  const vecs = await embedAll(
    missing.map((i) => texts[i]),
    { onProgress: (done, total) => { if (done % 160 === 0 || done === total) process.stderr.write(`  ${label} ${done}/${total}\r`); } },
  );
  const secs = (Date.now() - t0) / 1000;
  missing.forEach((idx, j) => {
    out[idx] = vecs[j];
    cache[texts[idx]] = Buffer.from(vecs[j].buffer).toString("base64");
  });
  ensureDir(SPIKE_TMP_DIR);
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache), "utf8");
  process.stderr.write("\n");
  return { out, embedSeconds: secs };
}

const t0All = Date.now();
const docNone = await embedWithCache(docTextsNone, "doc(none)");
const docTitle = await embedWithCache(docTextsTitle, "doc(title)");
const queryVecs = await embedWithCache(queryTexts, "query");
const embedSeconds = (Date.now() - t0All) / 1000;

const vecNone = docNone.out;
const vecTitle = docTitle.out;
const vecQuery = queryVecs.out;

// ---- FTS（用 better-sqlite3）----
const ftsDb = await openDb({ driver: "better-sqlite3", file: ":memory:" });
buildFtsIndex(ftsDb, docs);
const rankers = makeRankers(ftsDb, docs);

// ---- sqlite-vec（真實 KNN 路徑）----
const vecDb = await openDb({ driver: "better-sqlite3", file: ":memory:" });
const vecInfo = loadVec(vecDb);
function buildVecTable(name, vectors) {
  vecDb.exec(`create virtual table ${name} using vec0(id integer primary key, embedding float[${DIM}])`);
  const ins = vecDb.prepare(`insert into ${name}(id, embedding) values (?, ?)`);
  vectors.forEach((v, i) => ins.run(BigInt(i), toBlob(v)));
}
buildVecTable("vec_none", vecNone);
buildVecTable("vec_title", vecTitle);
function knn(table, queryVec, k = TOPK) {
  const rows = vecDb
    .prepare(`select id from ${table} where embedding match ? and k = ? order by distance`)
    .all(toBlob(queryVec), Math.min(k, docs.length));
  return rows.map((r) => Number(r.id));
}

const rankVecNone = (pair) => knn("vec_none", vecQuery[pairsInDocs.indexOf(pair)]);
const rankVecTitle = (pair) => knn("vec_title", vecQuery[pairsInDocs.indexOf(pair)]);

const methods = {
  T: (p) => rankers.rankT(p.query, TOPK),
  B: (p) => rankers.rankB(p.query, TOPK),
  S: (p) => rankers.rankS(p.query, TOPK),
  "vec(none)": rankVecNone,
  "vec(title)": rankVecTitle,
  "vec(none)+T": (p) => rrf([rankVecNone(p), rankers.rankT(p.query, TOPK)]),
  "vec(title)+T": (p) => rrf([rankVecTitle(p), rankers.rankT(p.query, TOPK)]),
  "vec(none)+B": (p) => rrf([rankVecNone(p), rankers.rankB(p.query, TOPK)]),
  "vec(title)+B": (p) => rrf([rankVecTitle(p), rankers.rankB(p.query, TOPK)]),
  "vec(none)+S": (p) => rrf([rankVecNone(p), rankers.rankS(p.query, TOPK)]),
  "vec(title)+S": (p) => rrf([rankVecTitle(p), rankers.rankS(p.query, TOPK)]),
};

const report = evaluate(methods, pairsInDocs);

const result = {
  date: new Date().toISOString().slice(0, 10),
  embedder: embedderInfo(),
  corpus: {
    files: corpus.files.length,
    chunks: corpus.docs.length,
    totalChars: corpus.totalChars,
    eligiblePairs: eligibleCount,
    usedPairs: pairsInDocs.length,
    buckets: bucketSizes(pairsInDocs),
    titleLength: titleLengthStats(pairsInDocs),
  },
  settings: { topk: TOPK, dim: DIM, rrfK: 60, maxPairs: MAX_PAIRS, limitDocs: LIMIT_DOCS },
  versions: { sqliteVec: vecInfo.version },
  embedSeconds: Number(embedSeconds.toFixed(1)),
  healthBefore,
  healthAfter: await health(),
  report,
};

jsonWrite(`${RESULTS_DIR}/eval.json`, result);

// ---- 主控台表格 ----
const B = ["<=2", "3-6", ">6", "all"];
console.log(`\n=== 檢索評測  chunks=${corpus.docs.length} pairs=${pairsInDocs.length} embedSeconds=${embedSeconds.toFixed(0)} ===`);
console.log("| 方案 | " + B.map((b) => `${b} R@5/R@10/MRR`).join(" | ") + " |");
console.log("|---".repeat(B.length + 1) + "|");
for (const [name, cells] of Object.entries(report)) {
  console.log(`| ${name} | ` + B.map((b) => `${cells[b].r5}/${cells[b].r10}/${cells[b].mrr}`).join(" | ") + " |");
}
ftsDb.close();
vecDb.close();
console.log("\nwrote results/eval.json");
