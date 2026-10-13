// Q1：兩個 SQLite 驅動能否載入 sqlite-vec、FTS5 與 trigram tokenizer 是否可用。
// 產生結果：results/drivers.json
import {
  DRIVERS,
  installedVersions,
  loadVec,
  openDb,
  sqliteVersion,
} from "../lib/vecdb.mjs";
import { jsonWrite, RESULTS_DIR } from "../lib/paths.mjs";

// 合成測試字串（非語料內容；用來探測各 tokenizer 對 2 字／4 字的行為）
const PROBE_ROWS = ["儲存介面與向量測試字串", "trigram tokenizer 測試資料", "root_id 過濾測試鍵"];

function probeFts(db, tokenizer) {
  const table = `probe_${tokenizer.replace(/[^a-z0-9]/gi, "_")}`;
  db.exec(`create virtual table ${table} using fts5(body, tokenize=${tokenizer})`);
  const ins = db.prepare(`insert into ${table}(rowid, body) values (?, ?)`);
  PROBE_ROWS.forEach((row, i) => ins.run(i + 1, row));
  const match = (q) => {
    try {
      const rows = db.prepare(`select rowid from ${table} where ${table} match ?`).all(`"${q.replace(/"/g, '""')}"`);
      return rows.length;
    } catch (err) {
      return `error: ${err.message}`;
    }
  };
  return {
    available: true,
    matches: {
      "儲存介面": match("儲存介面"), // 4 字
      "儲存": match("儲存"), // 2 字
      "root": match("root"), // 4 字元
      "向量": match("向量"), // 2 字
    },
  };
}

async function probeDriver(driver) {
  const record = { driver };
  try {
    const db = await openDb({ driver, file: ":memory:" });
    record.sqliteVersion = sqliteVersion(db);
    const vec = loadVec(db);
    record.vecVersion = { call: vec.version, installedPackage: installedVersions()["sqlite-vec"] };
    record.loadablePathHasHome = /(\/home\/|\/Users\/)/.test(vec.loadablePath);
    record.loadablePathKind = "sqlite-vec getLoadablePath()";

    // sqlite-vec 功能探測：建表、寫入、KNN
    // 注意：vec0 的 integer primary key 綁定必須用 BigInt（JS number 會被拒：
    //「Only integers are allows for primary key values」）——兩驅動實測一致。
    db.exec("create virtual table probe_vec using vec0(id integer primary key, embedding float[4])");
    const ins = db.prepare("insert into probe_vec(id, embedding) values (?, ?)");
    for (let i = 0; i < 5; i += 1) {
      const v = new Float32Array([i, 1, 0, 0]);
      ins.run(BigInt(i), Buffer.from(v.buffer));
    }
    const knn = db
      .prepare("select id, distance from probe_vec where embedding match ? and k = 2 order by distance")
      .all(Buffer.from(new Float32Array([2, 1, 0, 0]).buffer));
    record.vecKnn = knn.map((r) => ({ id: Number(r.id), distance: Number(r.distance.toFixed(3)) }));

    record.fts5 = {
      unicode61: probeFts(db, "unicode61"),
      trigram: probeFts(db, "trigram"),
    };
    db.close();
  } catch (err) {
    record.error = err.message;
  }
  return record;
}

async function probeAllowExtensionRequirement() {
  const { DatabaseSync } = await import("node:sqlite");
  const out = {};
  // 未開 allowExtension
  try {
    const db = new DatabaseSync(":memory:");
    db.loadExtension("/nonexistent.so");
    out.withoutAllowExtension = "loadExtension 竟然成功（非預期）";
  } catch (err) {
    out.withoutAllowExtension = err.message;
  }
  // 開 allowExtension 但指向不存在的檔案
  try {
    const db = new DatabaseSync(":memory:", { allowExtension: true });
    db.loadExtension("/nonexistent.so");
    out.withAllowExtension = "成功（非預期）";
  } catch (err) {
    out.withAllowExtension = err.message;
  }
  return out;
}

const result = {
  date: new Date().toISOString().slice(0, 10),
  environment: {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cpus: (await import("node:os")).cpus().length,
    installed: installedVersions(),
  },
  drivers: [],
  nodeSqliteAllowExtension: await probeAllowExtensionRequirement(),
};

for (const driver of DRIVERS) {
  const rec = await probeDriver(driver);
  result.drivers.push(rec);
  console.log(`[${driver}] sqlite=${rec.sqliteVersion} vec=${rec.vecVersion?.call ?? "-"} ${rec.error ? `ERROR: ${rec.error}` : "OK"}`);
}

jsonWrite(`${RESULTS_DIR}/drivers.json`, result);
console.log(`\nwrote results/drivers.json`);
console.log(JSON.stringify(result, null, 2));
