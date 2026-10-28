#!/usr/bin/env node
/**
 * 驗證 electron-builder 產生的更新 metadata（`latest*.yml`）。
 *
 * 為什麼需要這支腳本：Release 少一個 `latest-linux.yml`（或 yml 裡的 `path`／`sha512`
 * 與實際附件對不上）時，electron-updater 只會在**使用者端**更新失敗；在發佈流程中先驗，
 * 才能把問題擋在 Release 之前。
 *
 * 用法：
 *
 *   node packages/desktop/scripts/verify-update-metadata.mjs
 *   node packages/desktop/scripts/verify-update-metadata.mjs --dir packages/desktop/dist-app
 *   node packages/desktop/scripts/verify-update-metadata.mjs --dir dist \
 *     --require latest.yml latest-linux.yml latest-linux-arm64.yml
 *
 * 規則：
 * - 驗證目錄內**所有** `latest*.yml`；`--require` 指定的檔案必須存在（CI 用）。
 * - 每個 metadata 的 `path`（向後相容欄位）與 `files[].url` 都要對應到真實檔案。
 * - `sha512` 以 base64 編碼比對（electron-builder 的寫法）。
 * - `files[].url` 結尾是 `.exe` 時，同目錄必須有非空的 `<url>.blockmap`（Windows NSIS 的
 *   差異下載用）；Linux AppImage 不要求獨立 `.blockmap`（blockmap 內嵌，靠 `blockMapSize` 驗）。
 * - 退出碼：0＝全部通過、1＝有任何缺檔／欄位缺漏／checksum 不符（訊息會指出哪一個）。
 *
 * 刻意**不引入 YAML 套件**：Release job 不安裝 node_modules，這支腳本必須在乾淨的
 * checkout 上直接跑。electron-builder 產生的 `latest*.yml` 結構固定（頂層純量 +
 * `files:` 清單），下面只解析這個子集；遇到不認得的結構會直接失敗（不猜、不放過）。
 */

import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const defaultDir = path.resolve(scriptDir, "..", "dist-app");

/** 解析 electron-builder 的 `latest*.yml` 子集；不支援的結構直接丟錯。 */
function parseUpdateMetadata(text, fileName) {
  const result = { files: [] };
  let current = null; // 目前正在收集的 files[] 項目
  let inFiles = false;

  const unquote = (raw) => {
    const value = raw.trim();
    if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
      return value.slice(1, -1).replaceAll("''", "'");
    }
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      return JSON.parse(value);
    }
    return value;
  };

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const lineNumber = i + 1;
    if (line.trim() === "" || line.trimStart().startsWith("#")) {
      continue;
    }

    // 清單項目：`  - url: ...`
    const itemMatch = /^\s*-\s+([A-Za-z0-9_.-]+):(?:\s+(.*))?$/.exec(line);
    if (itemMatch) {
      if (!inFiles) {
        throw new Error(`${fileName}:${lineNumber}: 不預期的清單項目（不在 files: 之下）`);
      }
      current = {};
      result.files.push(current);
      const [, key, rawValue] = itemMatch;
      if (rawValue === undefined) {
        throw new Error(`${fileName}:${lineNumber}: files[] 的 ${key} 沒有值`);
      }
      current[key] = unquote(rawValue);
      continue;
    }

    // 頂層或清單項目的欄位：`key: value`
    const keyMatch = /^(\s*)([A-Za-z0-9_.-]+):(?:\s+(.*))?$/.exec(line);
    if (!keyMatch) {
      throw new Error(`${fileName}:${lineNumber}: 無法解析的 YAML 行：${line.trim()}`);
    }
    const [, indent, key, rawValue] = keyMatch;

    if (indent.length === 0) {
      current = null;
      if (key === "files") {
        inFiles = true;
        if (rawValue !== undefined && rawValue.trim() !== "") {
          throw new Error(`${fileName}:${lineNumber}: files 必須是清單`);
        }
        continue;
      }
      inFiles = false;
      if (rawValue === undefined) {
        throw new Error(`${fileName}:${lineNumber}: 不支援的巢狀欄位 ${key}`);
      }
      result[key] = unquote(rawValue);
      continue;
    }

    // 清單項目底下的欄位（縮排）
    if (!inFiles || current == null) {
      throw new Error(`${fileName}:${lineNumber}: 不預期的縮排欄位 ${key}`);
    }
    if (rawValue === undefined) {
      throw new Error(`${fileName}:${lineNumber}: 不支援的巢狀欄位 ${key}`);
    }
    current[key] = unquote(rawValue);
  }

  return result;
}

async function sha512Base64(filePath) {
  const data = await readFile(filePath);
  return createHash("sha512").update(data).digest("base64");
}

async function verifyMetadataFile(dir, fileName, errors, verifiedFiles) {
  const errorsBefore = errors.length;
  const successMessages = [];
  const metadataPath = path.join(dir, fileName);
  let text;
  try {
    text = await readFile(metadataPath, "utf8");
  } catch (error) {
    errors.push(`${fileName}: 讀取失敗（${error.code ?? error.message}）`);
    return;
  }

  let metadata;
  try {
    metadata = parseUpdateMetadata(text, fileName);
  } catch (error) {
    errors.push(error.message);
    return;
  }

  if (!metadata.version) {
    errors.push(`${fileName}: 缺少 version 欄位`);
  }

  /** @type {{ source: string, url: string, sha512: string, blockMapSize?: string, isFileEntry?: boolean }[]} */
  const references = [];
  if (metadata.path !== undefined || metadata.sha512 !== undefined) {
    references.push({
      source: "頂層 path/sha512",
      url: metadata.path,
      sha512: metadata.sha512,
    });
  }
  for (const [index, file] of metadata.files.entries()) {
    references.push({
      source: `files[${index}]`,
      url: file.url,
      sha512: file.sha512,
      blockMapSize: file.blockMapSize,
      isFileEntry: true,
    });
  }

  if (references.length === 0) {
    errors.push(`${fileName}: 找不到任何 path／files[] 參照`);
    return;
  }

  for (const reference of references) {
    if (!reference.url) {
      errors.push(`${fileName}: ${reference.source} 缺少 url／path`);
      continue;
    }
    if (!reference.sha512) {
      errors.push(`${fileName}: ${reference.source}（${reference.url}）缺少 sha512`);
      continue;
    }
    // AppImage 的 blockmap 直接嵌在檔案內（electron-builder 會在 files[] 寫 blockMapSize）；
    // 沒有這個欄位就代表差異更新不可用，和缺少獨立 .blockmap 同等嚴重。
    if (
      reference.source.startsWith("files[") &&
      reference.url.endsWith(".AppImage") &&
      !(Number(reference.blockMapSize) > 0)
    ) {
      errors.push(
        `${fileName}: ${reference.source}（${reference.url}）缺少 blockMapSize（AppImage 的 blockmap 應內嵌在檔案內）`,
      );
      continue;
    }
    if (/[/\\]/.test(reference.url) || reference.url.includes("..")) {
      errors.push(`${fileName}: ${reference.source} 的檔名不是單一檔名：${reference.url}`);
      continue;
    }

    // Windows NSIS 的差異下載需要獨立的 `<installer>.exe.blockmap`；Linux AppImage 的
    // blockmap 內嵌在 AppImage 內（上一段以 blockMapSize 驗），不要求獨立檔。
    if (reference.isFileEntry && reference.url.endsWith(".exe")) {
      const blockMapName = `${reference.url}.blockmap`;
      let blockMapStat;
      try {
        blockMapStat = await stat(path.join(dir, blockMapName));
      } catch {
        errors.push(
          `${fileName}: ${reference.source}（${reference.url}）缺少 blockmap：${blockMapName}`,
        );
        continue;
      }
      if (!blockMapStat.isFile() || blockMapStat.size === 0) {
        errors.push(
          `${fileName}: ${reference.source}（${reference.url}）的 blockmap 是空檔或不是檔案：${blockMapName}`,
        );
        continue;
      }
    }

    // 同一個安裝檔常同時被頂層 path 與 files[0] 引用；同 url＋同 sha512 只驗一次，
    // 避免在 CI 對數百 MB 的安裝檔重複讀取。
    if (verifiedFiles.get(reference.url) === reference.sha512) {
      continue;
    }

    const artifactPath = path.join(dir, reference.url);
    let artifactStat;
    try {
      artifactStat = await stat(artifactPath);
    } catch {
      errors.push(`${fileName}: ${reference.source} 指到的檔案不存在：${reference.url}`);
      continue;
    }
    if (!artifactStat.isFile()) {
      errors.push(`${fileName}: ${reference.source} 指到的不是檔案：${reference.url}`);
      continue;
    }

    let actualSha512;
    try {
      actualSha512 = await sha512Base64(artifactPath);
    } catch (error) {
      errors.push(`${fileName}: 無法讀取 ${reference.url}（${error.code ?? error.message}）`);
      continue;
    }
    if (actualSha512 !== reference.sha512) {
      errors.push(
        `${fileName}: ${reference.source}（${reference.url}）sha512 不符：` +
          `metadata=${reference.sha512} 實際=${actualSha512}`,
      );
      continue;
    }

    verifiedFiles.set(reference.url, reference.sha512);
    successMessages.push(`[ok] ${fileName}: ${reference.url}（sha512 相符）`);
  }

  // 同一個檔案只要有任何一項失敗，就不印它的成功訊息，避免 log 前後矛盾。
  if (errors.length === errorsBefore) {
    for (const message of successMessages) {
      console.log(message);
    }
    console.log(`[ok] ${fileName}: version=${metadata.version}`);
  }
}

function printUsage() {
  console.log(
    [
      "用法：node packages/desktop/scripts/verify-update-metadata.mjs [--dir <目錄>] [--require <檔名...>]",
      "",
      "  --dir       metadata 與安裝檔所在目錄（預設 packages/desktop/dist-app）",
      "  --require   必須存在的 metadata 檔名（CI 用；可重複指定，例如 --require latest.yml latest-linux.yml）",
      "",
      "未指定 --require 時：驗證目錄內所有 latest*.yml，且至少要有一個。",
    ].join("\n"),
  );
}

async function main(argv) {
  let dir = defaultDir;
  const required = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dir") {
      const value = argv[i + 1];
      if (!value) {
        console.error("錯誤：--dir 需要一個目錄");
        return 1;
      }
      dir = path.resolve(value);
      i += 1;
      continue;
    }
    if (arg === "--require") {
      i += 1;
      while (i < argv.length && !argv[i].startsWith("--")) {
        required.push(argv[i]);
        i += 1;
      }
      i -= 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printUsage();
      return 0;
    }
    console.error(`錯誤：不認得的參數 ${arg}`);
    printUsage();
    return 1;
  }

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    console.error(`錯誤：無法讀取目錄 ${path.relative(process.cwd(), dir) || "."}（${error.code ?? error.message}）`);
    return 1;
  }

  const discovered = entries
    .filter((entry) => entry.isFile() && /^latest.*\.yml$/.test(entry.name))
    .map((entry) => entry.name)
    .sort();

  if (required.length === 0 && discovered.length === 0) {
    console.error(`錯誤：${path.relative(process.cwd(), dir) || "."} 內沒有任何 latest*.yml`);
    return 1;
  }

  const errors = [];
  for (const fileName of required) {
    if (!discovered.includes(fileName)) {
      errors.push(`${fileName}: 找不到必要檔案（--require）`);
    }
  }

  const verifiedFiles = new Map();
  for (const fileName of discovered) {
    await verifyMetadataFile(dir, fileName, errors, verifiedFiles);
  }

  if (errors.length > 0) {
    console.error("");
    console.error("更新 metadata 驗證失敗：");
    for (const message of errors) {
      console.error(`  - ${message}`);
    }
    return 1;
  }

  console.log("");
  console.log(
    `驗證通過：${discovered.length} 個 metadata 檔、${verifiedFiles.size} 個參照檔案（目錄：${
      path.relative(process.cwd(), dir) || "."
    }）`,
  );
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error(`錯誤：${error.stack ?? error.message}`);
    process.exitCode = 1;
  },
);
