// WAL 併發讀取端：由 scripts/wal.mjs 以 child_process 啟動（唯讀連線）。
// 在寫入端持續寫入期間反覆查詢，並額外測試「長時間讀取快照」是否會被阻塞。
import Database from "better-sqlite3";
import { loadVec } from "../lib/vecdb.mjs";

const file = process.argv[2];
const durationMs = Number(process.argv[3] || 3000);

const db = new Database(file, { readonly: true, fileMustExist: true });
loadVec(db);

const now = () => process.hrtime.bigint();
const ms = (a) => Number(process.hrtime.bigint() - a) / 1e6;

const times = [];
const errors = [];
const vecErrors = [];
let queries = 0;
let vecQueries = 0;

const countStmt = db.prepare("select count(*) as c from writes");
const idStmt = db.prepare("select id from writes where id = ?");
let knnStmt = null;
try {
  knnStmt = db.prepare("select id from vec_w where embedding match ? and k = 5");
} catch (err) {
  vecErrors.push(`prepare: ${err.message}`);
}
const probe = new Float32Array(8).fill(0.1);

const started = Date.now();
while (Date.now() - started < durationMs) {
  try {
    const s = now();
    countStmt.get();
    idStmt.get(1 + Math.floor(Math.random() * 1000));
    times.push(ms(s));
    queries += 1;
  } catch (err) {
    errors.push(err.message);
  }
  if (knnStmt) {
    try {
      const s = now();
      knnStmt.all(Buffer.from(probe.buffer));
      times.push(ms(s));
      vecQueries += 1;
    } catch (err) {
      vecErrors.push(err.message);
    }
  }
  await new Promise((r) => setTimeout(r, 5));
}

// 長時間讀取快照：BEGIN 後讀一次，等一段時間（寫入端仍在寫）再讀一次。
// WAL 下這不應被阻塞，且兩次讀到的列數應相同（快照隔離）。
let snapshot = null;
try {
  db.exec("begin");
  const before = countStmt.get().c;
  await new Promise((r) => setTimeout(r, 1500));
  const after = countStmt.get().c;
  db.exec("commit");
  const later = countStmt.get().c;
  snapshot = { before, duringAfterWait: after, sameSnapshot: before === after, afterCommit: later };
} catch (err) {
  snapshot = { error: err.message };
}

const sorted = [...times].sort((a, b) => a - b);
const p = (q) => (sorted.length ? Number(sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)].toFixed(2)) : null);

console.log(
  JSON.stringify({
    event: "reader-done",
    queries,
    errors: errors.slice(0, 5),
    errorCount: errors.length,
    vecQueries,
    vecErrors: vecErrors.slice(0, 5),
    vecErrorCount: vecErrors.length,
    readLatencyMs: { p50: p(0.5), p95: p(0.95), max: sorted.length ? Number(sorted[sorted.length - 1].toFixed(2)) : null },
    snapshot,
  }),
);
db.close();
