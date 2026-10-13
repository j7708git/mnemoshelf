// 共用路徑工具。所有路徑以 node:path 處理，不硬寫分隔符，也不硬寫本機絕對路徑。
// 語料目錄由環境變數 CORPUS_DIR 傳入；本檔案不預設任何本機路徑。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** spikes/search-storage（本 spike 專案根） */
export const SPIKE_ROOT = path.resolve(import.meta.dirname, "..");
/** mnemoshelf/（程式碼 repo 根） */
export const REPO_ROOT = path.resolve(SPIKE_ROOT, "..", "..");
/** mnemoshelf/.tmp（暫存：測試資料庫、log） */
export const TMP_DIR = path.join(REPO_ROOT, ".tmp");
/** 本 spike 的暫存子目錄 */
export const SPIKE_TMP_DIR = path.join(TMP_DIR, "search-storage");
/** 量測結果 JSON 輸出位置 */
export const RESULTS_DIR = path.join(SPIKE_ROOT, "results");

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 把字串中的家目錄前綴換成 `~`，避免任何本機絕對路徑寫進結果檔或 log。
 * 這是隱私護欄（public repo 不得出現個人本機路徑）。
 */
export function sanitize(value) {
  if (typeof value !== "string") return value;
  // 精確比對本機家目錄
  let out = value.split(os.homedir()).join("~");
  // 保險：任何形式的使用者家目錄前綴（跨 OS）都收斂成 ~
  out = out.replace(/\/(?:home|Users)\/[^/\s"']+/g, "~");
  out = out.replace(/[A-Za-z]:\\\\?Users\\\\[^\\\s"']+/g, "~");
  return out;
}

/** 遞迴走訪目錄，回傳所有符合副檔名的檔案（排序後，保證可重現）。 */
export function walkFiles(dir, ext = ".md") {
  const out = [];
  const stack = [dir];
  while (stack.length > 0) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const full = path.join(cur, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && full.endsWith(ext)) out.push(full);
    }
  }
  out.sort();
  return out;
}

/** 檔案或目錄大小（bytes）。 */
export function sizeBytes(target) {
  let st;
  try {
    st = fs.statSync(target);
  } catch {
    return 0;
  }
  if (st.isFile()) return st.size;
  let total = 0;
  for (const name of fs.readdirSync(target)) {
    total += sizeBytes(path.join(target, name));
  }
  return total;
}

/** 回傳 SQLite 資料庫含其 sidecar（-wal、-shm）的總大小。 */
export function dbSizeBytes(file) {
  return sizeBytes(file) + sizeBytes(`${file}-wal`) + sizeBytes(`${file}-shm`);
}

export function humanBytes(bytes) {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(1)} ${units[i]}`;
}

export function jsonWrite(file, data) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

/** 固定種子的 PRNG（mulberry32），保證規模測試可重現。 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 產生一個已 L2 正規化的 512 維 float32 向量。 */
export function randomUnitVector(rand, dim) {
  const v = new Float32Array(dim);
  let norm = 0;
  for (let i = 0; i < dim; i += 1) {
    // 均值 0 的近似常態（12 個均勻相加），比單一均勻更接近真實 embedding 分布
    let s = 0;
    for (let j = 0; j < 12; j += 1) s += rand();
    const g = s - 6;
    v[i] = g;
    norm += g * g;
  }
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < dim; i += 1) v[i] /= norm;
  return v;
}

export function toBlob(vec) {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

export function blobToFloat32(blob) {
  const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}
