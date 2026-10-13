// SQLite 驅動抽象：better-sqlite3 與 node:sqlite，兩者 API 子集相容
// （exec / prepare / loadExtension 皆同名），故直接回傳原生 handle。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getLoadablePath, load as loadVecExtension } from "sqlite-vec";

export const DRIVERS = ["better-sqlite3", "node:sqlite"];

/**
 * 開啟資料庫。node:sqlite 必須在建立連線時就開 allowExtension（事後無法開）。
 */
export async function openDb({ driver, file = ":memory:", readonly = false }) {
  if (driver === "better-sqlite3") {
    const { default: Database } = await import("better-sqlite3");
    return new Database(file, readonly ? { readonly: true, fileMustExist: true } : {});
  }
  if (driver === "node:sqlite") {
    const { DatabaseSync } = await import("node:sqlite");
    return new DatabaseSync(file, { allowExtension: true, readOnly: readonly });
  }
  throw new Error(`unknown driver: ${driver}`);
}

/** 載入 sqlite-vec 擴充，回傳實際的載入路徑與版本。 */
export function loadVec(db) {
  const loadablePath = getLoadablePath();
  loadVecExtension(db);
  const version = db.prepare("select vec_version() as v").get().v;
  return { loadablePath, version };
}

export function sqliteVersion(db) {
  return db.prepare("select sqlite_version() as v").get().v;
}

/** 由套件解析後的入口檔反推 package.json 版本（套件有 exports 限制，不能直接 require package.json）。 */
function resolvedVersion(specifier) {
  try {
    const entry = fileURLToPath(import.meta.resolve(specifier));
    let dir = path.dirname(entry);
    for (let i = 0; i < 6; i += 1) {
      const pkg = path.join(dir, "package.json");
      if (fs.existsSync(pkg)) return JSON.parse(fs.readFileSync(pkg, "utf8")).version;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    /* 未安裝 */
  }
  return null;
}

export function installedVersions() {
  const versions = {
    node: process.version,
    betterSqlite3: resolvedVersion("better-sqlite3"),
    sqliteVec: resolvedVersion("sqlite-vec"),
  };
  // sqlite-vec 的平台二進位在 .pnpm 內，改由載入路徑字串取出（例：sqlite-vec-linux-x64@0.1.9）
  try {
    const m = /sqlite-vec-[a-z0-9-]+@(\d+\.\d+\.\d+[^/]*)/.exec(getLoadablePath());
    versions.sqliteVecPlatformBinary = m ? `${process.platform}-${process.arch}@${m[1]}` : null;
  } catch {
    versions.sqliteVecPlatformBinary = null;
  }
  return versions;
}
