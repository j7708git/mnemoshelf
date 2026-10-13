// 語料切塊與查詢對生成。
// 方法沿用前一輪 spike（見研究筆記）：依 Markdown 標題切段、段內依空行切段、
// 每塊 ≤1200 字元；查詢 = 標題、目標 = 該塊內文（不含標題行）。
// 語料只在記憶體內分析，不複製進本 repo。
import fs from "node:fs";
import { walkFiles } from "./paths.mjs";

export const MAX_CHUNK_CHARS = 1200;
export const MIN_TARGET_CHARS = 200;

/** 讀取單一檔案，切成 {title, text} 區塊。 */
export function chunkFile(file) {
  const raw = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  const lines = raw.split("\n");
  const sections = [];
  let title = "";
  let body = [];
  const flush = () => {
    const text = body.join("\n").trim();
    if (text) sections.push({ title, text });
    body = [];
  };
  for (const line of lines) {
    const m = /^(#{1,6})\s+(.*)$/.exec(line);
    if (m) {
      flush();
      title = m[2].trim();
    } else {
      body.push(line);
    }
  }
  flush();

  const chunks = [];
  for (const section of sections) {
    const paras = section.text
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter(Boolean);
    if (paras.length === 0) {
      if (section.text.trim()) chunks.push({ title: section.title, text: section.text.trim() });
      continue;
    }
    let cur = "";
    for (const para of paras) {
      if (cur && cur.length + para.length + 2 > MAX_CHUNK_CHARS) {
        chunks.push({ title: section.title, text: cur });
        cur = para;
      } else {
        cur = cur ? `${cur}\n\n${para}` : para;
      }
    }
    if (cur) chunks.push({ title: section.title, text: cur });
  }
  return chunks;
}

function clean(text) {
  return text.replace(/\*\*/g, "").replace(/`/g, "").trim();
}

/**
 * 載入語料目錄下所有 .md 並切塊。
 * 回傳 { files, docs: [{id, fileIndex, title, body}], totalChars }。
 */
export function loadCorpus(corpusDir) {
  const files = walkFiles(corpusDir, ".md");
  const docs = [];
  let totalChars = 0;
  files.forEach((file, fileIndex) => {
    for (const chunk of chunkFile(file)) {
      const body = clean(chunk.text);
      if (!body) continue;
      totalChars += body.length;
      docs.push({ id: docs.length, fileIndex, title: clean(chunk.title), body });
    }
  });
  return { files, docs, totalChars };
}

export function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

/**
 * 生成評測對：標題非空且內文 ≥200 字元者為候選，查詢 = 標題、目標 = 該塊。
 * `sampleSize` 以等距抽樣（可重現，不用隨機）。回傳 [{targetId, query, title}]
 */
export function buildPairs(docs, sampleSize = 300) {
  let eligible = docs.filter((d) => d.title.length > 0 && d.body.length >= MIN_TARGET_CHARS);
  const eligibleCount = eligible.length;
  if (sampleSize > 0 && eligible.length > sampleSize) {
    const step = eligible.length / sampleSize;
    const sampled = [];
    for (let k = 0; k < sampleSize; k += 1) sampled.push(eligible[Math.floor(k * step)]);
    eligible = sampled;
  }
  return {
    eligibleCount,
    pairs: eligible.map((d) => ({ targetId: d.id, query: d.title, title: d.title })),
  };
}

/** 查詢長度分組（去掉空白後字元數）。 */
export function queryBucket(query) {
  const n = [...query.replace(/\s/g, "")].length;
  if (n <= 2) return "<=2";
  if (n <= 6) return "3-6";
  return ">6";
}

export function bucketSizes(pairs) {
  const out = { "<=2": 0, "3-6": 0, ">6": 0 };
  for (const p of pairs) out[queryBucket(p.query)] += 1;
  return out;
}

/** 標題長度分布（聚合數字，可安全寫進筆記）。 */
export function titleLengthStats(pairs) {
  const lens = pairs.map((p) => [...p.query.replace(/\s/g, "")].length).sort((a, b) => a - b);
  return {
    n: lens.length,
    min: lens[0],
    p50: percentile(lens, 50),
    p90: percentile(lens, 90),
    max: lens[lens.length - 1],
  };
}
