// Q4/Q5/Q6：規模延遲、檔案大小、root_id 過濾、量化。
// 產生結果：results/scale.json
//
// 用法：
//   node scripts/scale.mjs [--sizes=10000,100000,500000,1000000] [--driver=better-sqlite3]
//   [--latency-runs=50] [--filter-size=100000] [--skip-quant]
// 向量為固定種子的隨機單位向量（512 維 float32）；root 以 id % 10 指派。
import fs from "node:fs";
import { freemem, totalmem } from "node:os";
import path from "node:path";
import {
  dbSizeBytes,
  ensureDir,
  jsonWrite,
  mulberry32,
  RESULTS_DIR,
  randomUnitVector,
  SPIKE_TMP_DIR,
  toBlob,
} from "../lib/paths.mjs";
import { percentile } from "../lib/corpus.mjs";
import { installedVersions, loadVec, openDb, sqliteVersion } from "../lib/vecdb.mjs";

const DIM = 512;
const SEED = 20261013;
const QUERY_SEED = 777001;
const ROOTS = 10;

const opt = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=")[1] : dflt;
};
const DRIVER = opt("driver", "better-sqlite3");
const SIZES = opt("sizes", "10000,100000,500000,1000000").split(",").map(Number);
const LATENCY_RUNS = Number(opt("latency-runs", 50));
const FILTER_SIZE = Number(opt("filter-size", 100000));
const OUT_FILE = opt("out", "scale.json");
const SKIP_QUANT = process.argv.includes("--skip-quant");

const log = (...a) => console.log(...a);
const now = () => process.hrtime.bigint();
const ms = (a, b) => Number(b - a) / 1e6;

function freshDb(file) {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.rmSync(file + suffix);
    } catch {
      /* 不存在 */
    }
  }
  return file;
}

function stats(times) {
  const s = [...times].sort((a, b) => a - b);
  return {
    runs: s.length,
    p50: Number(percentile(s, 50).toFixed(2)),
    p95: Number(percentile(s, 95).toFixed(2)),
    mean: Number((s.reduce((a, b) => a + b, 0) / s.length).toFixed(2)),
    min: Number(s[0].toFixed(2)),
    max: Number(s[s.length - 1].toFixed(2)),
  };
}

/** 固定種子隨機單位向量（第 i 筆由 seed+i 決定，可重現）。 */
const vectorAt = (i, seed = SEED) => randomUnitVector(mulberry32(seed + i), DIM);
const queryAt = (i) => randomUnitVector(mulberry32(QUERY_SEED + i), DIM);

async function runSize(n, { keepVectors }) {
  const file = freshDb(path.join(SPIKE_TMP_DIR, `scale-${DRIVER.replace(/[^\w]/g, "_")}-${n}.db`));
  const db = await openDb({ driver: DRIVER, file });
  db.exec("pragma journal_mode = wal");
  db.exec("pragma synchronous = normal");
  const vec = loadVec(db);

  db.exec(`create virtual table vec_plain using vec0(id integer primary key, embedding float[${DIM}])`);
  const ins = db.prepare("insert into vec_plain(id, embedding) values (?, ?)");
  const batchSize = 5000;
  // better-sqlite3 有 db.transaction；node:sqlite 用顯式 BEGIN/COMMIT
  const useTx = typeof db.transaction === "function";
  let kept = null;
  if (keepVectors) kept = new Array(n);
  const batch = (from, to) => {
    for (let i = from; i < to; i += 1) {
      const v = vectorAt(i);
      if (keepVectors) kept[i] = v;
      ins.run(BigInt(i), toBlob(v));
    }
  };
  const insertMany = useTx ? db.transaction((from, to) => batch(from, to)) : (from, to) => {
    db.exec("begin");
    try {
      batch(from, to);
      db.exec("commit");
    } catch (e) {
      db.exec("rollback");
      throw e;
    }
  };

  const t0 = now();
  for (let from = 0; from < n; from += batchSize) {
    const to = Math.min(from + batchSize, n);
    insertMany(from, to);
    if ((from / batchSize) % 20 === 0) process.stderr.write(`  insert ${to}/${n}\r`);
  }
  const insertMs = ms(t0, now());
  process.stderr.write("\n");

  const sqliteVer = sqliteVersion(db);
  db.exec("pragma wal_checkpoint(truncate)");
  const sizeBytes = dbSizeBytes(file);

  // KNN top-10 延遲
  const stmt = db.prepare("select id from vec_plain where embedding match ? and k = 10 order by distance");
  const queries = Array.from({ length: LATENCY_RUNS }, (_, i) => queryAt(i));
  for (let i = 0; i < Math.min(5, queries.length); i += 1) stmt.all(toBlob(queries[i])); // 暖機（不計）
  const times = [];
  for (const q of queries) {
    const s = now();
    stmt.all(toBlob(q));
    times.push(ms(s, now()));
  }
  const knn = stats(times);

  db.close();
  const result = {
    n,
    driver: DRIVER,
    sqliteVersion: sqliteVer,
    sqliteVecVersion: vec.version,
    insertSeconds: Number((insertMs / 1000).toFixed(1)),
    rowsPerSec: Math.round(n / (insertMs / 1000)),
    fileBytes: sizeBytes,
    bytesPerRow: Math.round(sizeBytes / n),
    knnTop10: knn,
  };
  log(
    `[scale] n=${n} insert=${result.insertSeconds}s (${result.rowsPerSec}/s) size=${(sizeBytes / 1024 / 1024).toFixed(0)}MB ` +
      `(${result.bytesPerRow} B/row) knn p50=${knn.p50}ms p95=${knn.p95}ms`,
  );
  // 檔案留著？測完就刪，節省磁碟
  freshDb(file);
  return { result, kept };
}

/** root_id 過濾：三種寫法延遲與正確性（精確 top-10 由暴力法算）。 */
async function runFilterTest(n) {
  const file = freshDb(path.join(SPIKE_TMP_DIR, `filter-${DRIVER.replace(/[^\w]/g, "_")}-${n}.db`));
  const db = await openDb({ driver: DRIVER, file });
  db.exec("pragma journal_mode = wal");
  db.exec("pragma synchronous = normal");
  loadVec(db);
  db.exec(`create virtual table vec_plain using vec0(id integer primary key, embedding float[${DIM}])`);
  db.exec(`create virtual table vec_meta using vec0(id integer primary key, root_id integer, embedding float[${DIM}])`);
  db.exec(`create virtual table vec_part using vec0(id integer primary key, root_id integer partition key, embedding float[${DIM}])`);
  const insPlain = db.prepare("insert into vec_plain(id, embedding) values (?, ?)");
  const insMeta = db.prepare("insert into vec_meta(id, root_id, embedding) values (?, ?, ?)");
  const insPart = db.prepare("insert into vec_part(id, root_id, embedding) values (?, ?, ?)");
  const vectors = new Array(n);
  const t0 = now();
  for (let i = 0; i < n; i += 1) {
    const v = vectorAt(i);
    vectors[i] = v;
    const root = i % ROOTS;
    insPlain.run(BigInt(i), toBlob(v));
    insMeta.run(BigInt(i), BigInt(root), toBlob(v));
    insPart.run(BigInt(i), BigInt(root), toBlob(v));
  }
  const insertSeconds = ms(t0, now()) / 1000;
  db.exec("pragma wal_checkpoint(truncate)");
  const sizeBytes = dbSizeBytes(file);

  const targets = Array.from({ length: 50 }, (_, i) => i % ROOTS);
  const queries = targets.map((_, i) => queryAt(3000 + i));

  const brute = (q, root) => {
    const scored = [];
    for (let i = root; i < n; i += ROOTS) {
      const v = vectors[i];
      let s = 0;
      for (let k = 0; k < DIM; k += 1) s += q[k] * v[k];
      scored.push([i, s]);
    }
    scored.sort((a, b) => b[1] - a[1]);
    return scored.slice(0, 10).map((x) => x[0]);
  };

  const metaStmt = db.prepare("select id from vec_meta where embedding match ? and k = 10 and root_id = ? order by distance");
  const partStmt = db.prepare("select id from vec_part where embedding match ? and k = 10 and root_id = ? order by distance");
  const plainStmt = db.prepare("select id from vec_plain where embedding match ? and k = ? order by distance");

  const out = {
    n,
    roots: ROOTS,
    perRoot: n / ROOTS,
    insertSeconds: Number(insertSeconds.toFixed(1)),
    fileBytes: sizeBytes,
    queries: targets.length,
    methods: {},
  };
  const acc = { meta: [], part: [], join1k: [], join4k: [] };
  const hits = { meta: 0, part: 0, join1k: 0, join4k: 0 };
  // 注意：sqlite-vec 0.1.9 的 KNN `k` 上限為 4096（實測 SQLITE_ERROR: k value in knn query too large）
  const joinK = { join1k: 1000, join4k: 4096 };

  for (let qi = 0; qi < queries.length; qi += 1) {
    const q = queries[qi];
    const root = targets[qi];
    const truth = brute(q, root);
    const truthSet = new Set(truth);
    const blob = toBlob(q);

    let s = now();
    const meta = metaStmt.all(blob, BigInt(root)).map((r) => Number(r.id));
    acc.meta.push(ms(s, now()));

    s = now();
    const part = partStmt.all(blob, BigInt(root)).map((r) => Number(r.id));
    acc.part.push(ms(s, now()));

    for (const key of ["join1k", "join4k"]) {
      const k = joinK[key];
      s = now();
      const rows = plainStmt.all(blob, k).map((r) => Number(r.id)).filter((id) => id % ROOTS === root).slice(0, 10);
      acc[key].push(ms(s, now()));
      if (rows.length === 10 && rows.every((id) => truthSet.has(id))) hits[key] += 1;
    }
    if (meta.length === 10 && meta.every((id) => truthSet.has(id))) hits.meta += 1;
    if (part.length === 10 && part.every((id) => truthSet.has(id))) hits.part += 1;
  }

  for (const key of Object.keys(acc)) {
    out.methods[key] = { latencyMs: stats(acc[key]), exactTop10Matches: `${hits[key]}/${queries.length}` };
  }
  out.note = "join* = KNN 取大 k 後在應用層過濾 root_id（k 上限 4096，sqlite-vec 0.1.9 限制）";

  db.close();
  freshDb(file);
  log(`[filter] n=${n} roots=${ROOTS} perRoot=${n / ROOTS}`);
  for (const [k, v] of Object.entries(out.methods)) {
    log(`  ${k}: p50=${v.latencyMs.p50}ms p95=${v.latencyMs.p95}ms 精確命中=${v.exactTop10Matches}`);
  }
  return out;
}

/** 量化：bit / int8 的大小、延遲、對 fp32 精確 top-10 的召回。 */
async function runQuant(n, vectors) {
  const file = freshDb(path.join(SPIKE_TMP_DIR, `quant-${DRIVER.replace(/[^\w]/g, "_")}-${n}.db`));
  const db = await openDb({ driver: DRIVER, file });
  db.exec("pragma journal_mode = wal");
  db.exec("pragma synchronous = normal");
  loadVec(db);
  db.exec(`create virtual table vec_bit using vec0(id integer primary key, embedding bit[${DIM}])`);
  db.exec(`create virtual table vec_i8 using vec0(id integer primary key, embedding int8[${DIM}])`);
  const insBit = db.prepare("insert into vec_bit(id, embedding) values (?, vec_quantize_binary(?))");
  const insI8 = db.prepare("insert into vec_i8(id, embedding) values (?, vec_quantize_int8(?, 'unit'))");
  const t0 = now();
  for (let i = 0; i < n; i += 1) {
    const blob = toBlob(vectors[i]);
    insBit.run(BigInt(i), blob);
    insI8.run(BigInt(i), blob);
  }
  const insertSeconds = ms(t0, now()) / 1000;
  db.exec("pragma wal_checkpoint(truncate)");
  const sizeBytes = dbSizeBytes(file);

  const GROUND_TRUTH_QUERIES = 20;
  const queries = Array.from({ length: GROUND_TRUTH_QUERIES }, (_, i) => queryAt(9000 + i));
  // fp32 精確 top-10（暴力）
  const exact = queries.map((q) => {
    let best = [];
    for (let i = 0; i < n; i += 1) {
      const v = vectors[i];
      let s = 0;
      for (let k = 0; k < DIM; k += 1) s += q[k] * v[k];
      if (best.length < 10) {
        best.push([i, s]);
        best.sort((a, b) => b[1] - a[1]);
      } else if (s > best[9][1]) {
        best[9] = [i, s];
        best.sort((a, b) => b[1] - a[1]);
      }
    }
    return new Set(best.map((x) => x[0]));
  });

  const run = (table, matchExpr) => {
    const stmt = db.prepare(`select id from ${table} where embedding match ${matchExpr} and k = 10 order by distance`);
    const times = [];
    let recall = 0;
    for (let i = 0; i < queries.length; i += 1) {
      const s = now();
      const rows = stmt.all(toBlob(queries[i])).map((r) => Number(r.id));
      times.push(ms(s, now()));
      recall += rows.filter((id) => exact[i].has(id)).length / 10;
    }
    return { latencyMs: stats(times), recallAt10: Number((recall / queries.length).toFixed(3)) };
  };

  // 查詢向量也必須量化成同型別（實測：int8 欄位吃 float32 會報錯）
  // 注意函式名是 vec_quantize_int8（不是文件裡的 vec_quantize_i8），且必須帶 'unit' 參數
  const bit = run("vec_bit", "vec_quantize_binary(?)");
  const i8 = run("vec_i8", "vec_quantize_int8(?, 'unit')");

  db.close();
  freshDb(file);
  const result = {
    n,
    insertSeconds: Number(insertSeconds.toFixed(1)),
    fileBytes: sizeBytes,
    bytesPerRow: Math.round(sizeBytes / n),
    groundTruthQueries: GROUND_TRUTH_QUERIES,
    fp32BytesPerRow: Math.round((n * DIM * 4) / n),
    bit,
    i8,
  };
  log(`[quant] n=${n} size=${(sizeBytes / 1024 / 1024).toFixed(0)}MB (${result.bytesPerRow} B/row for bit+i8 tables)`);
  log(`  bit : p50=${bit.latencyMs.p50}ms recall@10=${bit.recallAt10}`);
  log(`  int8: p50=${i8.latencyMs.p50}ms recall@10=${i8.recallAt10}`);
  return result;
}

// ---- 主流程 ----
ensureDir(SPIKE_TMP_DIR);
const result = {
  date: new Date().toISOString().slice(0, 10),
  driver: DRIVER,
  versions: installedVersions(),
  seed: SEED,
  dim: DIM,
  environment: { totalMemGB: Math.round(totalmem() / 1e9), freeMemGB: Math.round(freemem() / 1e9), platform: process.platform, arch: process.arch },
  sizes: [],
};
log(`[scale] driver=${DRIVER} sizes=${SIZES.join(",")} freeMem=${result.environment.freeMemGB}GB`);

let lastVectors = null;
const QUANT_MAX = 500000;
for (const n of SIZES) {
  const memGB = (n * DIM * 4) / 1e9;
  const keep = n <= QUANT_MAX && memGB < freemem() / 1e9 - 1.5;
  const { result: rec, kept } = await runSize(n, { keepVectors: keep });
  rec.vectorsKeptInMemory = keep;
  result.sizes.push(rec);
  if (keep) lastVectors = { n, vectors: kept };
}

result.filter = await runFilterTest(FILTER_SIZE);
if (!SKIP_QUANT && lastVectors) {
  result.quantization = await runQuant(lastVectors.n, lastVectors.vectors);
} else if (!SKIP_QUANT) {
  result.quantization = { skipped: "最大的 ≤500k 規模測試未保留向量於記憶體（記憶體不足）" };
}
result.healthNote = "本腳本不呼叫 :8181，也不修改任何既有服務";

jsonWrite(`${RESULTS_DIR}/${OUT_FILE}`, result);
log(`\nwrote results/${OUT_FILE}`);
