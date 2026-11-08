/**
 * staging 輸出目錄的「所有權、guard 與原子替換」helper（波次一 D7／STD-2）。
 *
 * 為什麼抽出來：CLI（stage-media-bin.mjs）需要可被 vitest 直接測的同一份程式碼，
 * 不能讓測試另寫一套假的 guard／cleanup。本檔只做檔案系統層的判斷與替換，
 * 不懂 ffmpeg 版本／SHA256 預期值（那是 CLI 與 media-bin.lock.json 的責任）。
 *
 * 契約（PM 波次一 D7）：
 * - 只有以下情況才算 staging 擁有輸出目錄：目錄不存在、空目錄、只含預設目錄的
 *   .gitignore marker、或含有效 manifest.json（schemaVersion 1、generatedBy 本腳本、
 *   platform/arch 相符）且所有項目都是已知產物。
 * - 任何未知檔案或未知子目錄一律拒絕，且不改動任何內容；只刪／取代已知產物。
 * - outDir 本身不得是 symlink／junction；realpath(outDir) 必須等於
 *   realpath(parent) + basename（上層目錄的 symlink 不誤擋，例如 macOS /var→/private/var）。
 * - 原子 staging：先在 sibling 暫存目錄產生並驗證，成功才 swap；失敗回滾，
 *   上一份可用產物保持原樣。--check 只讀，不刪任何東西。
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

/** manifest 檔名（輸出目錄內）。 */
export const manifestFileName = "manifest.json";
/** 授權全文在輸出目錄內的檔名。 */
export const stagedLicenseFileName = "LICENSE.txt";
/** 預設輸出目錄（packages/desktop/media-bin）的 git 忽略佔位檔。 */
export const stagingMarkerFileName = ".gitignore";
/** 寫進 manifest 的產生者標記；--check 以此驗證擁有權。 */
export const stagingGenerator = "packages/desktop/scripts/stage-media-bin.mjs";

/** 用法／環境錯誤（維持原 CLI 的 exit code 語意）。 */
export const exitUsage = 1;
/** 驗證／所有權失敗。 */
export const exitVerify = 2;

/** staging 失敗：exitCode 區分「用法／環境錯誤」與「驗證失敗」。 */
export class StagingError extends Error {
  constructor(message, exitCode = exitVerify) {
    super(message);
    this.name = "StagingError";
    this.exitCode = exitCode;
  }
}

function fail(message, exitCode = exitVerify) {
  throw new StagingError(message, exitCode);
}

/** 串流算檔案的 SHA256（binary 很大，不整檔讀進記憶體）。 */
export function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(file);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function describeError(error) {
  return error instanceof Error ? error.message : String(error);
}

/** 列出前幾個項目（錯誤訊息用；不一次把整個使用者目錄倒進 log）。 */
export function formatEntryList(entries, max = 5) {
  const shown = entries.slice(0, max);
  const rest = entries.length - shown.length;
  return shown.join("、") + (rest > 0 ? "（另有 " + String(rest) + " 項）" : "");
}

/**
 * 輸出目錄路徑本身是否為 reparse point（symlink／junction）。
 * 不存在時回 false（讓呼叫端建立新目錄）。上層目錄的 symlink 不算。
 */
export async function isOutputPathReparsePoint(outDir) {
  const resolved = path.resolve(outDir);
  const info = await lstat(resolved).catch((error) => {
    if (error !== null && typeof error === "object" && error.code === "ENOENT") return null;
    throw error;
  });
  if (info === null) return false;
  if (info.isSymbolicLink()) return true;
  const parentReal = await realpath(path.dirname(resolved));
  const expected = path.join(parentReal, path.basename(resolved));
  const actual = await realpath(resolved).catch(() => null);
  return actual !== null && path.resolve(actual) !== path.resolve(expected);
}

/**
 * 路徑安全 guard：拒絕寫到 repo 根、package 根或磁碟根（用法錯誤）。
 * 只回傳解析後路徑，不建立任何東西。
 */
export async function assertSafeOutputPath({ outDir, repoRoot, packageDir }) {
  const resolved = path.resolve(outDir);
  if (resolved === path.resolve(repoRoot) || resolved === path.resolve(packageDir)) {
    fail("拒絕把 staging 輸出寫到 " + resolved + "（會覆蓋專案目錄）", exitUsage);
  }
  if (path.dirname(resolved) === resolved) fail("拒絕把 staging 輸出寫到磁碟根目錄", exitUsage);
  return resolved;
}

/** 讀 manifest；不存在或不是合法 JSON 時回 null（讓所有權判定給出清楚訊息）。 */
export async function readStagingManifest(file) {
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/** manifest 是否為本腳本、此平台此架構產生的有效 staging 產物。 */
export function validateStagingManifest(manifest, { platform = process.platform, arch = process.arch } = {}) {
  if (manifest === null || typeof manifest !== "object") return { ok: false, reason: "manifest 不存在或不是物件" };
  if (manifest.schemaVersion !== 1) {
    return { ok: false, reason: "schemaVersion 不是 1（實際 " + String(manifest.schemaVersion) + "）" };
  }
  if (manifest.generatedBy !== stagingGenerator) {
    return { ok: false, reason: "generatedBy 不是 " + stagingGenerator };
  }
  if (manifest.platform !== platform || manifest.arch !== arch) {
    return {
      ok: false,
      reason: "platform/arch 不符（manifest " + String(manifest.platform) + "-" + String(manifest.arch) + "，目前 " + platform + "-" + arch + "）",
    };
  }
  return { ok: true };
}

/**
 * 檢查輸出目錄所有權；**只讀**，不建立、不刪除、不改動任何內容。
 *
 * @returns {Promise<{
 *   resolvedOutDir: string,
 *   exists: boolean,
 *   owned: boolean,
 *   entries: string[],
 *   markerPresent: boolean,
 *   manifest: object | null,
 *   isDefaultDir: boolean,
 * }>}
 */
export async function inspectOutputDirectory({
  outDir,
  defaultOutDir,
  expectedFileNames,
  platform = process.platform,
  arch = process.arch,
}) {
  const resolvedOutDir = path.resolve(outDir);
  const expected = new Set(expectedFileNames);
  const info = await lstat(resolvedOutDir).catch((error) => {
    if (error !== null && typeof error === "object" && error.code === "ENOENT") return null;
    throw error;
  });
  if (info === null) {
    return { resolvedOutDir, exists: false, owned: true, entries: [], markerPresent: false, manifest: null, isDefaultDir: false };
  }
  if (info.isSymbolicLink()) {
    fail("輸出目錄本身是 symlink／junction（" + resolvedOutDir + "）：拒絕 staging，避免寫到連結目標。");
  }
  if (!info.isDirectory()) fail("輸出目錄不是目錄：" + resolvedOutDir);

  const parentReal = await realpath(path.dirname(resolvedOutDir));
  const outReal = await realpath(resolvedOutDir);
  const expectedReal = path.join(parentReal, path.basename(resolvedOutDir));
  if (path.resolve(outReal) !== path.resolve(expectedReal)) {
    fail(
      "輸出目錄解析後與預期位置不同（可能是 symlink／junction）：" + resolvedOutDir +
        "（realpath=" + outReal + "）。拒絕 staging。",
    );
  }

  const dirEntries = await readdir(resolvedOutDir, { withFileTypes: true });
  const entries = dirEntries.map((entry) => entry.name).sort();
  const isDefaultDir = path.resolve(defaultOutDir) === resolvedOutDir;
  const markerPresent = entries.includes(stagingMarkerFileName);
  const unknown = [];
  for (const entry of dirEntries) {
    const knownArtifact = expected.has(entry.name) && entry.isFile();
    const knownMarker = entry.name === stagingMarkerFileName && entry.isFile() && isDefaultDir;
    if (!knownArtifact && !knownMarker) unknown.push(entry.name);
  }
  if (unknown.length > 0) {
    fail(
      "輸出目錄含有未知（不屬於 staging 的）項目，拒絕清理且不改動任何內容：" + formatEntryList(unknown) +
        "（目錄：" + resolvedOutDir + "）。請改用新的 --out，或先人工清掉這些項目。",
    );
  }

  const manifest = await readStagingManifest(path.join(resolvedOutDir, manifestFileName));
  const manifestCheck = validateStagingManifest(manifest, { platform, arch });
  const onlyMarker = entries.length === 0 || (entries.length === 1 && markerPresent);
  if (onlyMarker) {
    return { resolvedOutDir, exists: true, owned: true, entries, markerPresent, manifest: null, isDefaultDir };
  }
  if (!manifestCheck.ok) {
    fail(
      "輸出目錄含 staging 產物但沒有有效 manifest，無法確認擁有權：" + manifestCheck.reason +
        "（目錄：" + resolvedOutDir + "）。不覆蓋、不刪除；請人工確認或改用新的 --out。",
    );
  }
  return { resolvedOutDir, exists: true, owned: true, entries, markerPresent, manifest, isDefaultDir };
}

/** 已知產物的檔名必須是單純檔名（不可含分隔、不可為 . / ..），避免寫出目錄外。 */
function assertSafeFileName(fileName) {
  if (
    typeof fileName !== "string" ||
    fileName.trim() === "" ||
    fileName === "." ||
    fileName === ".." ||
    fileName.includes("/") ||
    fileName.includes("\\") ||
    path.isAbsolute(fileName)
  ) {
    fail("staging 產物檔名不合法：" + String(fileName), exitUsage);
  }
}

/**
 * 原子 staging：在 outDir 的 sibling 暫存目錄產生全部產物並驗證，成功後才替換。
 *
 * - 任何失敗（複製錯誤、複製後雜湊不符、替換失敗）都會清掉暫存目錄；
 *   上一份可用產物保持原樣（替換失敗時回滾；回滾失敗會把備份位置寫進錯誤訊息）。
 * - 只寫入已知產物檔名；manifest 最後寫。預設目錄的 .gitignore marker 會保留。
 *
 * hooks 只給測試注入失敗用；正式流程用真實 fs 實作。
 */
export async function stageArtifactsAtomic({
  outDir,
  defaultOutDir,
  expectedFileNames,
  binaries,
  license,
  manifest,
  platform = process.platform,
  arch = process.arch,
  hooks = {},
}) {
  const copyFileImpl = hooks.copyFile ?? copyFile;
  const renameImpl = hooks.rename ?? rename;
  const rmImpl = hooks.rm ?? rm;
  const readdirImpl = hooks.readdir ?? readdir;
  const mkdirImpl = hooks.mkdir ?? mkdir;
  const writeFileImpl = hooks.writeFile ?? writeFile;
  const readFileImpl = hooks.readFile ?? readFile;
  const sha256Impl = hooks.sha256File ?? sha256File;
  const warnImpl = hooks.warn ?? ((message) => process.stderr.write("[media-bin] 警告：" + message + "\n"));

  if (!Array.isArray(binaries) || binaries.length === 0) fail("staging 產物清單是空的（內部錯誤）", exitUsage);
  assertSafeFileName(license.fileName);
  for (const binary of binaries) assertSafeFileName(binary.fileName);

  const resolvedOutDir = path.resolve(outDir);
  const inspection = await inspectOutputDirectory({
    outDir: resolvedOutDir,
    defaultOutDir,
    expectedFileNames,
    platform,
    arch,
  });
  const parentDir = path.dirname(resolvedOutDir);
  await mkdirImpl(parentDir, { recursive: true });
  const token = String(process.pid) + "-" + Math.random().toString(16).slice(2, 10);
  const tempDir = path.join(parentDir, path.basename(resolvedOutDir) + ".staging-" + token);
  const backupDir = path.join(parentDir, path.basename(resolvedOutDir) + ".old-" + token);
  let tempCreated = false;
  let backupCreated = false;
  let swapped = false;
  try {
    await mkdirImpl(tempDir, { recursive: true });
    tempCreated = true;

    const stagedBinaries = [];
    for (const binary of binaries) {
      const destination = path.join(tempDir, binary.fileName);
      await copyFileImpl(binary.sourcePath, destination);
      const digest = await sha256Impl(destination);
      if (digest !== binary.sha256) {
        fail(
          "複製後 " + binary.fileName + " SHA256 不一致（預期 " + binary.sha256 + "，實際 " + String(digest) +
            "）：保留上一份可用產物，未替換輸出目錄。",
        );
      }
      stagedBinaries.push({ fileName: binary.fileName, bytes: binary.bytes, sha256: digest });
    }

    const licenseDestination = path.join(tempDir, license.fileName);
    await copyFileImpl(license.sourcePath, licenseDestination);
    if ((await sha256Impl(licenseDestination)) !== license.sha256) {
      fail("複製後授權檔 SHA256 不一致：保留上一份可用產物，未替換輸出目錄。");
    }

    await writeFileImpl(path.join(tempDir, manifestFileName), JSON.stringify(manifest, null, 2) + "\n", "utf8");

    if (inspection.markerPresent) {
      const markerText = await readFileImpl(path.join(resolvedOutDir, stagingMarkerFileName), "utf8");
      await writeFileImpl(path.join(tempDir, stagingMarkerFileName), markerText, "utf8");
    }

    if (inspection.exists) {
      try {
        await renameImpl(resolvedOutDir, backupDir);
        backupCreated = true;
      } catch (error) {
        fail(
          "無法把舊 staging 目錄移到備份位置：" + describeError(error) +
            "；舊產物保持原樣，未替換（目錄：" + resolvedOutDir + "）。",
        );
      }
      // 縮小 TOCTOU 窗口：swap 前的檢查與 rename 之間若有人放了未知項目，這裡會看到。
      // 一律回滾（把舊目錄移回）並拒絕，不讓未知內容跟著備份被刪掉。
      const expectedNames = new Set(expectedFileNames);
      const lateUnknown = [];
      for (const entry of await readdirImpl(backupDir, { withFileTypes: true })) {
        const knownArtifact = expectedNames.has(entry.name) && entry.isFile();
        const knownMarker = entry.name === stagingMarkerFileName && entry.isFile() && inspection.markerPresent;
        if (!knownArtifact && !knownMarker) lateUnknown.push(entry.name);
      }
      if (lateUnknown.length > 0) {
        try {
          await renameImpl(backupDir, resolvedOutDir);
          backupCreated = false;
        } catch (rollbackError) {
          fail(
            "staging 期間輸出目錄出現未知項目（" + formatEntryList(lateUnknown.sort()) + "），且回滾失敗：" +
              describeError(rollbackError) + "。上一份產物保留在：" + backupDir + "（請人工確認後移回）。",
          );
        }
        fail(
          "staging 期間輸出目錄出現未知項目，拒絕替換且不改動任何內容：" + formatEntryList(lateUnknown.sort()) +
            "（目錄：" + resolvedOutDir + "）。請確認沒有其他程序正在寫這個目錄。",
        );
      }
    }

    try {
      await renameImpl(tempDir, resolvedOutDir);
      swapped = true;
      tempCreated = false;
    } catch (error) {
      let rolledBack = false;
      if (backupCreated) {
        try {
          await renameImpl(backupDir, resolvedOutDir);
          rolledBack = true;
          backupCreated = false;
        } catch {
          rolledBack = false;
        }
      }
      if (backupCreated && !rolledBack) {
        fail(
          "新 staging 目錄無法取代輸出目錄（" + describeError(error) + "），且回滾失敗。" +
            "上一份可用產物保留在：" + backupDir + "（請人工確認後移回）。",
        );
      }
      fail(
        "新 staging 目錄無法取代輸出目錄（" + describeError(error) + "）：已回滾，上一份可用產物保持原樣。",
      );
    }

    let backupRemoved = false;
    if (backupCreated) {
      try {
        await rmImpl(backupDir, { recursive: true, force: true });
        backupRemoved = true;
        backupCreated = false;
      } catch (error) {
        warnImpl(
          "staging 已成功，但無法刪除舊產物備份 " + backupDir + "：" + describeError(error) + "；請人工刪除。",
        );
      }
    }

    return {
      resolvedOutDir,
      stagedBinaries,
      license: { fileName: license.fileName, bytes: license.bytes, sha256: license.sha256 },
      backupRemoved,
      markerPreserved: inspection.markerPresent,
      replacedExisting: inspection.exists,
    };
  } finally {
    // 失敗路徑清掉暫存目錄（成功時 tempDir 已被 rename 掉）；備份目錄只在回滾失敗時保留，
    // 錯誤訊息會指出它的位置，方便人工移回。
    if (!swapped && tempCreated) {
      await rmImpl(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

/** 供 CLI 與測試使用的預設檔名集合（目前 target 的 binary＋授權＋manifest）。 */
export function defaultExpectedFileNames(target) {
  const names = Object.values(target.binaries ?? {}).map((entry) => entry.fileName);
  return [...names, stagedLicenseFileName, manifestFileName];
}
