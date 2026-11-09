#!/usr/bin/env node
/**
 * 把已驗證的 FFmpeg／ffprobe 複製到 packages/desktop/media-bin/，並寫出 manifest.json。
 *
 * 為什麼要 staging：binary 不進版控，建置前才從已驗證來源複製；electron-builder 再由
 * electron-builder.yml 的 extraResources（from: media-bin、to: bin）放進產物的
 * resources/bin（asar 之外：Node 的 spawn 讀不到 asar 內的執行檔，A1 已實測）。
 *
 * 用法（在 repo 根目錄或 packages/desktop 皆可）：
 *   MNEMOSHELF_FFMPEG_PATH=<候選目錄>/ffmpeg.exe \
 *   MNEMOSHELF_FFPROBE_PATH=<候選目錄>/ffprobe.exe \
 *   node packages/desktop/scripts/stage-media-bin.mjs
 *
 * 來源（照優先序；本腳本不自動下載、不改 PATH、不經 shell）：
 * 1. MNEMOSHELF_FFMPEG_PATH＋MNEMOSHELF_FFPROBE_PATH：必須成對，與 Core 服務的環境變數同名。
 * 2. MNEMOSHELF_FFMPEG_DIR：內含平台檔名（Windows 為 ffmpeg.exe／ffprobe.exe）。
 *
 * 驗證（預期值來自 scripts/media-bin.lock.json；只放版本、大小、SHA256，不含路徑）：
 * - 來源存在、是檔案、大小相符、SHA256 相符；
 * - 執行檔能跑 -version（無 shell、有 deadline），且版本行開頭符合 lock；
 * - LGPL 授權全文存在且內容含必要標記（授權是配送證據，缺了不 staging）。
 * 任一項不符就非 0 退出並給出明確原因；缺檔與雜湊不符都不會「自動修正」。
 *
 * 輸出目錄所有權（波次一 D7；helper 見 media-bin-staging.mjs）：
 * - 只有「目錄不存在／空目錄／只含預設目錄的 .gitignore、或不完整但 manifest 無效之外的
 *   已知 staging 產物」才算 staging 擁有；任何未知檔案或未知子目錄一律拒絕，且不改動內容。
 * - outDir 本身不得是 symlink／junction（上層目錄的 symlink 不誤擋）。
 * - staging 是原子的：先在 sibling 暫存目錄複製並驗證 SHA256／manifest，成功才 swap；
 *   任何失敗都保留上一份可用產物。--check 同樣拒絕未知項目，且只讀不刪。
 *
 * 其他旗標：
 * - --check：不複製，只驗證現有 media-bin/ 與 lock／manifest 一致（打包前或 CI 查核用）。
 * - --out <dir>：覆寫輸出目錄（測試用；預設 packages/desktop/media-bin）。
 * - --help：顯示用法。
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  StagingError,
  assertSafeOutputPath,
  defaultExpectedFileNames,
  exitUsage,
  exitVerify,
  inspectOutputDirectory,
  manifestFileName,
  sha256File,
  stagedLicenseFileName,
  stageArtifactsAtomic,
  stagingGenerator,
} from "./media-bin-staging.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(here, "..");
const repoRoot = path.resolve(packageDir, "..", "..");
const lockFile = path.join(here, "media-bin.lock.json");
const defaultOutDir = path.join(packageDir, "media-bin");
const versionTimeoutMs = 15_000;
const licenseMaxBytes = 1024 * 1024;

function info(message) {
  process.stdout.write("[media-bin] " + message + "\n");
}

function warn(message) {
  process.stderr.write("[media-bin] 警告：" + message + "\n");
}

function fail(message, exitCode = exitVerify) {
  throw new StagingError(message, exitCode);
}

function hasSetting(value) {
  return typeof value === "string" && value.trim() !== "";
}

function formatBytes(bytes) {
  const mib = bytes / (1024 * 1024);
  return String(bytes) + " bytes（" + mib.toFixed(1) + " MiB）";
}

function usage() {
  return [
    "用法：node packages/desktop/scripts/stage-media-bin.mjs [--check] [--out <dir>] [--help]",
    "來源（擇一，照優先序）：",
    "  MNEMOSHELF_FFMPEG_PATH＋MNEMOSHELF_FFPROBE_PATH（必須成對）",
    "  MNEMOSHELF_FFMPEG_DIR（目錄內放平台檔名 ffmpeg(.exe)／ffprobe(.exe)）",
    "選用：MNEMOSHELF_MEDIA_BIN_LICENSE 明確指定 LGPL 全文（預設在來源目錄及其上層自動找 LICENSE.txt）。",
    "行為：只複製與驗證，不自動下載、不改 PATH；預期版本／大小／SHA256 見 scripts/media-bin.lock.json。",
  ].join("\n");
}

function parseArgs(argv) {
  const options = { check: false, outDir: null, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--check") options.check = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--out") {
      const value = argv[index + 1];
      if (!hasSetting(value)) fail("--out 需要一個目錄參數", exitUsage);
      options.outDir = value;
      index += 1;
    } else fail("不認得的參數：" + arg + "（可用：--check、--out <dir>、--help）", exitUsage);
  }
  return options;
}

async function loadLock(platform, arch) {
  let lock;
  try {
    lock = JSON.parse(await readFile(lockFile, "utf8"));
  } catch (error) {
    fail("讀不到候選鎖檔 scripts/media-bin.lock.json：" + (error instanceof Error ? error.message : String(error)), exitUsage);
  }
  if (lock.schemaVersion !== 1) fail("scripts/media-bin.lock.json 的 schemaVersion 不是 1", exitUsage);
  const target = (lock.targets ?? {})[platform + "-" + arch];
  if (target === undefined) {
    const available = Object.keys(lock.targets ?? {}).join("、");
    fail(
      "scripts/media-bin.lock.json 沒有 " + platform + "-" + arch + " 的凍結候選（目前有：" + available + "）。" +
        "其他平台要配送 FFmpeg 前，須先由 PM 決定候選並在 lock 檔登錄版本／大小／SHA256。",
      exitUsage,
    );
  }
  return { lock, target };
}

/** 解析來源目錄；不讀 PATH、不做任何推測性搜尋。 */
function resolveSource(target) {
  const ffmpegSetting = process.env.MNEMOSHELF_FFMPEG_PATH;
  const ffprobeSetting = process.env.MNEMOSHELF_FFPROBE_PATH;
  const dirSetting = process.env.MNEMOSHELF_FFMPEG_DIR;
  const pairRequested = hasSetting(ffmpegSetting) || hasSetting(ffprobeSetting);
  if (pairRequested) {
    if (!hasSetting(ffmpegSetting) || !hasSetting(ffprobeSetting)) {
      fail(
        "MNEMOSHELF_FFMPEG_PATH 與 MNEMOSHELF_FFPROBE_PATH 必須成對設定（只設一個無法 staging；也可改用 MNEMOSHELF_FFMPEG_DIR）",
        exitUsage,
      );
    }
    const ffmpeg = path.resolve(ffmpegSetting);
    const ffprobe = path.resolve(ffprobeSetting);
    return {
      description: "MNEMOSHELF_FFMPEG_PATH／MNEMOSHELF_FFPROBE_PATH",
      paths: { ffmpeg, ffprobe },
      searchDirs: [path.dirname(ffmpeg), path.dirname(ffprobe)],
    };
  }
  if (hasSetting(dirSetting)) {
    const directory = path.resolve(dirSetting);
    return {
      description: "MNEMOSHELF_FFMPEG_DIR",
      paths: {
        ffmpeg: path.join(directory, target.binaries.ffmpeg.fileName),
        ffprobe: path.join(directory, target.binaries.ffprobe.fileName),
      },
      searchDirs: [directory],
    };
  }
  fail("沒有指定解碼器來源。\n" + usage(), exitUsage);
}

/** 找 FFmpeg 授權全文：來源目錄、上一層（BtbN zip 的 LICENSE.txt 在 bin/ 上一層）、上兩層。 */
function findLicenseFile(source, lock) {
  const explicit = process.env.MNEMOSHELF_MEDIA_BIN_LICENSE;
  if (hasSetting(explicit)) {
    const file = path.resolve(explicit);
    if (!existsSync(file)) fail("MNEMOSHELF_MEDIA_BIN_LICENSE 指定的授權檔不存在：" + file);
    return file;
  }
  const candidates = [];
  const seen = new Set();
  const add = (file) => {
    const key = path.resolve(file);
    if (!seen.has(key)) {
      seen.add(key);
      candidates.push(key);
    }
  };
  for (const directory of source.searchDirs) {
    for (const name of lock.license.fileNames) {
      add(path.join(directory, name));
      add(path.join(directory, "..", name));
      add(path.join(directory, "..", "..", name));
    }
  }
  const found = candidates.find((file) => existsSync(file));
  if (found === undefined) {
    fail(
      "找不到 FFmpeg 授權全文（在來源目錄及其上兩層找過：" + lock.license.fileNames.join("、") + "）。" +
        "授權全文是配送證據，不能略過；請把 bundle 的 LICENSE 放回來源目錄，或用 MNEMOSHELF_MEDIA_BIN_LICENSE 明確指定。",
    );
  }
  return found;
}

/** 跑一次 -version 取第一行；無 shell、參數陣列、有 deadline。 */
function readVersionLine(label, executable) {
  const result = spawnSync(executable, ["-version"], {
    shell: false,
    windowsHide: true,
    timeout: versionTimeoutMs,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error !== undefined) {
    fail(
      label + " 無法執行（" + executable + "）：" + result.error.message +
        "。請確認來源是此平台的可用 build，且目前使用者有執行權限。",
    );
  }
  if (result.status !== 0) {
    const firstStderr = String(result.stderr ?? "").split(/\r?\n/, 1)[0].trim();
    fail(
      label + " -version 退出碼 " + String(result.status) + "（" + executable + "）" +
        (firstStderr === "" ? "" : "；stderr 第一行：" + firstStderr),
    );
  }
  const firstLine = String(result.stdout ?? "").split(/\r?\n/, 1)[0].trim();
  if (firstLine === "") fail(label + " -version 沒有輸出（" + executable + "）：不是可用的 FFmpeg 執行檔。");
  return firstLine;
}

/** 驗證單一執行檔：存在、大小、SHA256、-version。 */
async function verifyBinary(name, expected, executable) {
  const fileStat = await stat(executable).catch(() => null);
  if (fileStat === null) {
    fail(
      "來源 " + name + " 不存在：" + executable +
        "。請用 MNEMOSHELF_FFMPEG_PATH／MNEMOSHELF_FFPROBE_PATH 或 MNEMOSHELF_FFMPEG_DIR 指向已驗證的候選目錄（本腳本不自動下載）。",
    );
  }
  if (!fileStat.isFile()) fail("來源 " + name + " 不是檔案：" + executable);
  if (fileStat.size !== expected.bytes) {
    fail(
      "來源 " + name + " 大小不符：預期 " + String(expected.bytes) + " bytes，實際 " + String(fileStat.size) +
        " bytes（" + executable + "）。候選看起來不是 scripts/media-bin.lock.json 凍結的版本。",
    );
  }
  const sha256 = await sha256File(executable);
  if (sha256 !== expected.sha256) {
    fail(
      "來源 " + name + " SHA256 不符：預期 " + expected.sha256 + "，實際 " + sha256 + "（" + executable + "）。" +
        "請確認候選沒有被替換；要換候選須由 PM 決定並更新 lock 檔，不要直接改雜湊。",
    );
  }
  const versionLine = readVersionLine(name, executable);
  if (!versionLine.startsWith(expected.versionLinePrefix)) {
    fail(
      "來源 " + name + " 版本不符：預期版本行開頭「" + expected.versionLinePrefix + "」，實際「" + versionLine + "」（" + executable + "）。",
    );
  }
  return { name, bytes: fileStat.size, sha256, versionLine };
}

async function readLicenseEvidence(licenseFile, lock) {
  const licenseStat = await stat(licenseFile);
  if (!licenseStat.isFile()) fail("授權檔不是檔案：" + licenseFile);
  if (licenseStat.size > licenseMaxBytes) {
    fail("授權檔過大（" + String(licenseStat.size) + " bytes > " + String(licenseMaxBytes) + "）：" + licenseFile);
  }
  const text = await readFile(licenseFile, "utf8");
  const missing = lock.license.licenseTextMarkers.filter((marker) => !text.includes(marker));
  if (missing.length > 0) {
    fail(
      "授權檔內容不含必要標記（缺少：" + missing.join("、") + "）：" + licenseFile +
        "。bundle 內附的 LGPL 全文是唯一授權證據，不能用別的檔案充數。",
    );
  }
  return { fileName: stagedLicenseFileName, bytes: licenseStat.size, sha256: await sha256File(licenseFile), spdx: lock.license.spdx };
}

function buildManifest({ lock, binaries, license }) {
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    generatedBy: stagingGenerator,
    platform: process.platform,
    arch: process.arch,
    target: process.platform + "-" + process.arch,
    packagedResourcesPath: "resources/bin",
    source: {
      kind: lock.source.kind,
      provider: lock.source.provider,
      releaseTag: lock.source.releaseTag,
      asset: lock.source.asset,
      assetSha256: lock.source.assetSha256,
      build: lock.source.build,
      verifiedBy: lock.source.verifiedBy,
    },
    license: { fileName: license.fileName, spdx: license.spdx, bytes: license.bytes, sha256: license.sha256 },
    binaries: binaries.map((entry) => ({
      name: entry.name,
      fileName: entry.fileName,
      bytes: entry.bytes,
      sha256: entry.sha256,
      versionLine: entry.versionLine,
    })),
    notes: "本檔由 staging 腳本產生、不進版控；刻意不含本機路徑。打包後可用 manifest 的雜湊核對 resources/bin。",
  };
}

/** 檢查看起來像 staging 目錄的檔案是否真的被 git 忽略（best effort；沒有 git 時只警告）。 */
function warnIfStagingTracked(outDir) {
  const probe = spawnSync("git", ["-C", repoRoot, "check-ignore", "-q", path.join(outDir, "__probe__.bin")], {
    shell: false,
    windowsHide: true,
    timeout: 10_000,
  });
  if (probe.error !== undefined || probe.status === null) {
    warn("無法確認 " + path.relative(repoRoot, outDir) + " 是否被 git 忽略（找不到 git？）；請勿手動 git add 這個目錄。");
    return;
  }
  if (probe.status !== 0) {
    warn(path.relative(repoRoot, outDir) + " 沒有被 .gitignore 忽略：請先修好 media-bin/.gitignore，避免 binary 進版控。");
  }
}

async function stage(options) {
  const { lock, target } = await loadLock(process.platform, process.arch);
  const outDir = await assertSafeOutputPath({
    outDir: options.outDir === null ? defaultOutDir : path.resolve(options.outDir),
    repoRoot,
    packageDir,
  });
  // 先做所有權檢查（只讀）：未知檔案／子目錄、symlink／junction、不完整 staging 一律在這裡拒絕，
  // 不會先碰來源、更不會先清目錄。真正的清理只發生在 stageArtifactsAtomic 的原子替換。
  const expectedFileNames = defaultExpectedFileNames(target);
  await inspectOutputDirectory({ outDir, defaultOutDir, expectedFileNames });
  const source = resolveSource(target);
  info("staging（來源：" + source.description + "；目標平台 " + process.platform + "-" + process.arch + "）");

  const licenseFile = findLicenseFile(source, lock);
  const verified = [];
  for (const [name, expected] of Object.entries(target.binaries)) {
    const record = await verifyBinary(name, expected, source.paths[name]);
    info(
      "驗證通過：" + name + "（" + formatBytes(record.bytes) + "，sha256 " + record.sha256.slice(0, 16) +
        "…，版本行：" + record.versionLine.split(" Copyright")[0] + "）",
    );
    verified.push({ ...record, fileName: expected.fileName });
  }
  const license = await readLicenseEvidence(licenseFile, lock);
  info("授權全文：" + path.basename(licenseFile) + "（" + formatBytes(license.bytes) + "，" + license.spdx + "）");

  const manifest = buildManifest({ lock, binaries: verified, license });
  const staged = await stageArtifactsAtomic({
    outDir,
    defaultOutDir,
    expectedFileNames,
    binaries: verified.map((entry) => ({
      sourcePath: source.paths[entry.name],
      fileName: entry.fileName,
      bytes: entry.bytes,
      sha256: entry.sha256,
    })),
    license: { sourcePath: licenseFile, fileName: stagedLicenseFileName, bytes: license.bytes, sha256: license.sha256 },
    manifest,
  });
  for (const entry of staged.stagedBinaries) info("staged：" + entry.fileName);
  info("staged：" + stagedLicenseFileName + "（" + license.spdx + " 全文）");
  warnIfStagingTracked(outDir);
  info("完成：" + path.relative(repoRoot, outDir) + "（" + verified.map((entry) => entry.fileName).join("、") + "、" + stagedLicenseFileName + "、" + manifestFileName + "）");
  info("下一步：pnpm --filter @mnemoshelf/desktop run build 後跑 electron-builder（或 run dist:win:media）；打包後位置是 resources/bin。");
}

async function checkStaged(options) {
  const { lock, target } = await loadLock(process.platform, process.arch);
  const outDir = await assertSafeOutputPath({
    outDir: options.outDir === null ? defaultOutDir : path.resolve(options.outDir),
    repoRoot,
    packageDir,
  });
  // 與 staging 同一份所有權判斷：未知項目（含未知子目錄）、symlink／junction、
  // manifest 無效一律拒絕；--check 只讀、不刪任何東西。
  const expectedFileNames = defaultExpectedFileNames(target);
  const inspection = await inspectOutputDirectory({ outDir, defaultOutDir, expectedFileNames });
  const manifestPath = path.join(outDir, manifestFileName);
  if (!inspection.exists || !existsSync(manifestPath)) {
    fail("找不到 " + path.relative(repoRoot, manifestPath) + "；請先跑 pnpm --filter @mnemoshelf/desktop run prepare:media");
  }
  const manifest = inspection.manifest;
  if (manifest === null) fail("manifest.json 不是合法 JSON：" + path.relative(repoRoot, manifestPath));

  for (const [name, expected] of Object.entries(target.binaries)) {
    const record = await verifyBinary(name, expected, path.join(outDir, expected.fileName));
    const manifestEntry = (manifest.binaries ?? []).find((entry) => entry.name === name);
    if (manifestEntry === undefined) fail("manifest.json 沒有 " + name + " 的記錄；請重新 staging");
    if (manifestEntry.sha256 !== record.sha256 || manifestEntry.bytes !== record.bytes) {
      fail("manifest.json 與實際檔案不一致（" + name + "）；請重新 staging");
    }
  }

  const licensePath = path.join(outDir, stagedLicenseFileName);
  const license = await readLicenseEvidence(licensePath, lock);
  if (manifest.license?.sha256 !== license.sha256 || manifest.license?.bytes !== license.bytes) {
    fail("manifest.json 與授權檔不一致；請重新 staging");
  }

  const totalBytes = [...Object.values(target.binaries).map((entry) => entry.bytes), license.bytes].reduce(
    (sum, bytes) => sum + bytes,
    0,
  );
  info("check 通過：" + path.relative(repoRoot, outDir) + "（" + formatBytes(totalBytes) + "）；版本：" + target.binaries.ffmpeg.versionLinePrefix + " / " + target.binaries.ffprobe.versionLinePrefix);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    info("用法說明：\n" + usage());
    return;
  }
  if (options.check) await checkStaged(options);
  else await stage(options);
}

main().catch((error) => {
  const exitCode = error instanceof StagingError ? error.exitCode : 1;
  process.stderr.write("[media-bin] 失敗：" + (error instanceof Error ? error.message : String(error)) + "\n");
  process.exitCode = exitCode;
});
