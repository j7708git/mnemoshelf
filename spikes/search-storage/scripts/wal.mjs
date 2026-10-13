// Q7：WAL 下一寫多讀。啟動一個持續寫入的子行程，同時在另一個唯讀子行程查詢。
// 產生結果：results/wal.json
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ensureDir, jsonWrite, RESULTS_DIR, SPIKE_TMP_DIR } from "../lib/paths.mjs";
import { installedVersions, openDb, sqliteVersion } from "../lib/vecdb.mjs";

const spawnNode = (script, args) =>
  spawn(process.execPath, [path.join(import.meta.dirname, script), ...args], {
    stdio: ["ignore", "pipe", "inherit"],
  });

const waitFor = (child, predicate) =>
  new Promise((resolve, reject) => {
    let buf = "";
    child.stdout.on("data", (d) => {
      buf += d.toString();
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (predicate(msg)) resolve(msg);
      }
    });
    child.on("error", reject);
  });

const readAll = (child) =>
  new Promise((resolve) => {
    let buf = "";
    child.stdout.on("data", (d) => {
      buf += d.toString();
    });
    child.on("exit", () => {
      let last = null;
      for (const line of buf.split("\n")) {
        if (!line.trim()) continue;
        try {
          last = JSON.parse(line);
        } catch {
          /* 非 JSON 行 */
        }
      }
      resolve(last);
    });
  });

const stop = (child) => {
  child.kill("SIGTERM");
  return new Promise((resolve) => child.on("exit", resolve));
};

ensureDir(SPIKE_TMP_DIR);
const file = path.join(SPIKE_TMP_DIR, "wal-test.db");
for (const suffix of ["", "-wal", "-shm"]) {
  try {
    fs.rmSync(file + suffix);
  } catch {
    /* 不存在 */
  }
}

// 初始化資料庫與表
const init = await openDb({ driver: "better-sqlite3", file });
init.exec("pragma journal_mode = wal");
const journalMode = init.prepare("pragma journal_mode").get().journal_mode;
const versions = { ...installedVersions(), sqlite: sqliteVersion(init) };
init.close();

const dir = import.meta.dirname;
const writer = spawnNode("wal-writer.mjs", [file]);
await waitFor(writer, (m) => m.event === "writer-ready");

const reader = spawnNode("wal-reader.mjs", [file, "3000"]);
const [readerResult, writerResult] = await Promise.all([readAll(reader), (async () => {
  await new Promise((r) => setTimeout(r, 3400));
  const done = readAll(writer);
  await stop(writer);
  return done;
})()]);

// 寫入端停止後，再讀一次確認資料已持久化
const after = await openDb({ driver: "better-sqlite3", file });
const finalCount = after.prepare("select count(*) as c from writes").get().c;
const walSize = fs.existsSync(`${file}-wal`) ? fs.statSync(`${file}-wal`).size : 0;
after.close();

const result = {
  date: new Date().toISOString().slice(0, 10),
  versions,
  journalMode,
  writer: writerResult,
  reader: readerResult,
  finalRowCount: finalCount,
  walSizeDuringWrite: walSize,
  conclusion: {
    readerQueriesSucceeded: readerResult && readerResult.errorCount === 0,
    writerBusyErrors: writerResult ? writerResult.busyErrors : null,
    snapshotIsolated: readerResult?.snapshot?.sameSnapshot ?? null,
  },
};

jsonWrite(`${RESULTS_DIR}/wal.json`, result);
console.log(JSON.stringify(result, null, 2));
