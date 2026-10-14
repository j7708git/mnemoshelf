/**
 * asar 路徑修正（spike 的已知上游問題繞道）。
 *
 * `sqlite-vec` 的 `getLoadablePath()` 用 `import.meta.resolve()` 算出擴充檔路徑，
 * 打包後會得到 `…/app.asar/node_modules/sqlite-vec-<os>-<arch>/vec0.so`。
 * 但 `better-sqlite3` 的 `loadExtension()` 最後交給 SQLite 的 C 層 `sqlite3_load_extension()`
 * 直接開檔——**不經過 Electron 的 asar fs 補丁**，所以 `app.asar` 這個「檔案」被當成目錄開，
 * 得到 `ENOTDIR`（`無法開啟共用物件: 並不是一個目錄`）。
 *
 * `asarUnpack` 已經把 `vec0.so` 放到 `app.asar.unpacked/…`，缺的只是把路徑指過去。
 * 上游同一個問題：electron-builder issue #8824（社群結論即為改指 `app.asar.unpacked`）。
 *
 * 因此這裡在 `Database.prototype.loadExtension` 上包一層：只要傳進來的是 asar 內、
 * 而 `app.asar.unpacked` 有對應檔案，就改寫成真實路徑。**沒有動任何套件的檔案或打包佈局。**
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

/** asar 內路徑的特徵片段。 */
const ASAR_SEGMENT = `${path.sep}app.asar${path.sep}`;
/** 解包目錄的特徵片段（避免把已經正確的路徑再改一次）。 */
const UNPACKED_SEGMENT = `${path.sep}app.asar.unpacked${path.sep}`;

/**
 * 把 `…/app.asar/…` 改寫成 `…/app.asar.unpacked/…`；不需要改寫時回 null。
 *
 * 純字串轉換：呼叫端負責確認改寫後的路徑真的存在。
 */
export function toUnpackedPath(target: string): string | null {
  if (!target.includes(ASAR_SEGMENT)) return null;
  if (target.includes(UNPACKED_SEGMENT)) return null;
  return target.split(ASAR_SEGMENT).join(UNPACKED_SEGMENT);
}

/** 若 `app.asar.unpacked` 有對應的真實檔案，回傳該路徑；否則回傳原路徑。 */
export function resolveRealPath(target: string): string {
  const unpacked = toUnpackedPath(target);
  if (unpacked === null) return target;
  try {
    return fs.statSync(unpacked).isFile() ? unpacked : target;
  } catch {
    return target;
  }
}

/** 安裝結果（供啟動 log 說明有沒有生效）。 */
export interface ShimReport {
  installed: boolean;
  reason: string;
}

let installed = false;

/**
 * 包裝 `better-sqlite3` 的 `loadExtension`，把 asar 內的路徑改指到 `app.asar.unpacked`。
 *
 * 必須在 Core 服務開啟資料庫**之前**呼叫（`createServer()` 內會載入 sqlite-vec）。
 * 開發模式（沒有 asar）不需要也不會生效：`require("better-sqlite3")` 解析不到時只是回報原因。
 *
 * 為什麼改在 `loadExtension` 這一層：`sqlite-vec` 走的是 `import.meta.resolve()`（ESM），
 * 沒辦法用 CJS 的 resolver 補丁攔到；而 `db.loadExtension()` 是執行期在實例上查找的方法，
 * 攔這裡最可靠，也不必改動 `packages/core`（本卡不得改動既有套件）。
 */
export function installLoadExtensionAsarShim(): ShimReport {
  if (installed) return { installed: true, reason: "已安裝過" };
  const requireFromApp = createRequire(import.meta.url);
  let Database: unknown;
  try {
    Database = requireFromApp("better-sqlite3") as unknown;
  } catch (error) {
    return { installed: false, reason: `解析不到 better-sqlite3：${error instanceof Error ? error.message : String(error)}` };
  }
  const prototype = (Database as { prototype?: Record<string, unknown> }).prototype;
  const original = prototype?.loadExtension;
  if (prototype === undefined || typeof original !== "function") {
    return { installed: false, reason: "better-sqlite3 的 loadExtension 形狀不如預期" };
  }
  prototype.loadExtension = function patchedLoadExtension(this: unknown, file: unknown, ...rest: unknown[]): unknown {
    const target = typeof file === "string" ? resolveRealPath(file) : file;
    return (original as (...args: unknown[]) => unknown).call(this, target, ...rest);
  };
  installed = true;
  return { installed: true, reason: "已把 loadExtension 的 asar 路徑改指到 app.asar.unpacked" };
}
