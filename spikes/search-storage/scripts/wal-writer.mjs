// WAL 併發寫入端：由 scripts/wal.mjs 以 child_process 啟動。
// 持續寫入直到收到 SIGTERM/SIGINT，最後把統計以 JSON 印到 stdout。
import Database from "better-sqlite3";
import { loadVec } from "../lib/vecdb.mjs";

const file = process.argv[2];
const db = new Database(file);
loadVec(db);
db.exec("pragma journal_mode = wal");
db.exec("pragma synchronous = normal");
db.exec("create table if not exists writes(id integer primary key autoincrement, payload text)");
db.exec("create virtual table if not exists vec_w using vec0(id integer primary key, embedding float[8])");

const ins = db.prepare("insert into writes(payload) values (?)");
const insVec = db.prepare("insert into vec_w(id, embedding) values (?, ?)");
db.exec("begin");
for (let i = 0; i < 100; i += 1) ins.run(`seed-${i}`);
db.exec("commit");

let written = 0;
let stop = false;
let busyErrors = 0;
process.on("SIGTERM", () => {
  stop = true;
});
process.on("SIGINT", () => {
  stop = true;
});

console.log(JSON.stringify({ event: "writer-ready" }));

while (!stop) {
  try {
    db.exec("begin");
    for (let i = 0; i < 200; i += 1) {
      ins.run(`row-${written}-${"x".repeat(64)}`);
      // 同步寫入一筆向量（模擬產品：文字列與向量列一起寫）
      const v = new Float32Array(8);
      for (let d = 0; d < 8; d += 1) v[d] = Math.sin(written + d);
      insVec.run(BigInt(written), Buffer.from(v.buffer));
      written += 1;
    }
    db.exec("commit");
  } catch (err) {
    try {
      db.exec("rollback");
    } catch {
      /* ignore */
    }
    if (/busy|locked/i.test(err.message)) busyErrors += 1;
    else throw err;
  }
  await new Promise((r) => setTimeout(r, 25));
}

console.log(JSON.stringify({ event: "writer-done", written, busyErrors }));
db.close();
