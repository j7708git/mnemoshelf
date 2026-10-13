// 共用路徑工具。所有路徑以 node:path 處理，不硬寫分隔符。
import fs from "node:fs";
import path from "node:path";

/** spikes/embed-runtime（本 spike 專案根） */
export const SPIKE_ROOT = path.resolve(import.meta.dirname, "..");
/** mnemoshelf/（程式碼 repo 根） */
export const REPO_ROOT = path.resolve(SPIKE_ROOT, "..", "..");
/** mnemoshelf/.tmp（暫存：模型快取、下載的圖片、log） */
export const TMP_DIR = path.join(REPO_ROOT, ".tmp");
/** 合成測試圖輸出位置（.tmp，不進版控） */
export const ASSET_OUT_DIR = path.join(TMP_DIR, "assets");
/** 合成測試圖的 SVG 來源（進版控） */
export const ASSET_SRC_DIR = path.join(SPIKE_ROOT, "assets");
/** 量測結果 JSON 輸出位置 */
export const RESULTS_DIR = path.join(SPIKE_ROOT, "results");

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 每個 dtype 一個獨立的 HF 快取目錄，方便分開量測下載量與冷啟動。 */
export function cacheDirFor(dtype) {
  return path.join(TMP_DIR, `hf-cache-${dtype}`);
}

/** 目錄大小（bytes），用於量測下載量。 */
export function dirSizeBytes(dir) {
  let total = 0;
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
      const full = path.join(cur, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) {
        try {
          total += fs.statSync(full).size;
        } catch {
          /* ignore */
        }
      }
    }
  }
  return total;
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
