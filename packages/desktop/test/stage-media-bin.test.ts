import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 波次一 D7（STD-2）：staging 輸出目錄的所有權、清理範圍與原子替換。
 *
 * 原始反例是 .tmp/standards-review 的 staging-cleanup.cjs：從真腳本抽出
 * assertOutputDirSafe＋cleanOutputDir，證明「不相關的 sentinel 檔會被遞迴刪掉」。
 * 這裡改成直接 spawn 真 CLI（原反例的 gated 版）＋直接呼叫 CLI 實際使用的同一份
 * helper（media-bin-staging.mjs）來鎖住所有權、未知子目錄、原子替換與回滾。
 *
 * 真 binary 的 CLI 端到端測試為 gated：MNEMOSHELF_FFMPEG_PATH／MNEMOSHELF_FFPROBE_PATH
 * 成對指向已驗證候選，或 packages/desktop/media-bin 內已有既有 binary；缺 binary 時 skip
 * 並在 console 註明。正常 staging 的 --out 一律指到 .tmp/wave1/ 臨時目錄，不污染 repo 的 media-bin。
 * 測試清理前會驗證解析後路徑在 .tmp/wave1 內才刪。
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(here, "..");
const repoRoot = path.resolve(packageDir, "..", "..");
const scriptPath = path.join(packageDir, "scripts", "stage-media-bin.mjs");
const helperPath = path.join(packageDir, "scripts", "media-bin-staging.mjs");
const tmpRoot = path.join(repoRoot, ".tmp", "wave1");

const binaryName = (base: "ffmpeg" | "ffprobe"): string => (process.platform === "win32" ? base + ".exe" : base);

interface GatedSource {
  ffmpeg: string;
  ffprobe: string;
  origin: "env" | "media-bin";
}

function resolveGatedSource(): GatedSource | null {
  const envFfmpeg = process.env.MNEMOSHELF_FFMPEG_PATH?.trim() ?? "";
  const envFfprobe = process.env.MNEMOSHELF_FFPROBE_PATH?.trim() ?? "";
  if (envFfmpeg !== "" && envFfprobe !== "" && existsSync(envFfmpeg) && existsSync(envFfprobe)) {
    return { ffmpeg: envFfmpeg, ffprobe: envFfprobe, origin: "env" };
  }
  const stagedFfmpeg = path.join(packageDir, "media-bin", binaryName("ffmpeg"));
  const stagedFfprobe = path.join(packageDir, "media-bin", binaryName("ffprobe"));
  if (existsSync(stagedFfmpeg) && existsSync(stagedFfprobe)) {
    return { ffmpeg: stagedFfmpeg, ffprobe: stagedFfprobe, origin: "media-bin" };
  }
  return null;
}

const gated = resolveGatedSource();

interface Inspection {
  resolvedOutDir: string;
  exists: boolean;
  owned: boolean;
  entries: string[];
  markerPresent: boolean;
  manifest: Record<string, unknown> | null;
}

interface StagingHelper {
  StagingError: new (message: string, exitCode?: number) => Error & { exitCode?: number };
  exitUsage: number;
  exitVerify: number;
  manifestFileName: string;
  stagedLicenseFileName: string;
  stagingMarkerFileName: string;
  stagingGenerator: string;
  sha256File: (file: string) => Promise<string>;
  assertSafeOutputPath: (input: Record<string, unknown>) => Promise<string>;
  inspectOutputDirectory: (input: Record<string, unknown>) => Promise<Inspection>;
  validateStagingManifest: (manifest: unknown, options?: Record<string, unknown>) => { ok: boolean; reason?: string };
  stageArtifactsAtomic: (input: Record<string, unknown>) => Promise<{
    resolvedOutDir: string;
    stagedBinaries: { fileName: string; bytes: number; sha256: string }[];
    license: { fileName: string; bytes: number; sha256: string };
    backupRemoved: boolean;
    markerPreserved: boolean;
    replacedExisting: boolean;
  }>;
}

let helper: StagingHelper | null = null;

async function loadHelper(): Promise<StagingHelper> {
  if (helper !== null) return helper;
  const moduleUrl = pathToFileURL(helperPath).href;
  helper = (await import(moduleUrl)) as unknown as StagingHelper;
  return helper;
}

/** 驗證路徑解析後仍在 .tmp/wave1 內（測試清理只准刪這裡）。 */
function assertInsideTmp(target: string): void {
  const resolved = path.resolve(target);
  const relative = path.relative(tmpRoot, resolved);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("測試 cleanup 目標不在 .tmp/wave1 內：" + resolved);
  }
}

async function makeTempDir(label: string): Promise<string> {
  await fs.mkdir(tmpRoot, { recursive: true });
  const dir = await fs.mkdtemp(path.join(tmpRoot, label));
  assertInsideTmp(dir);
  return dir;
}

async function removeTempDir(dir: string): Promise<void> {
  assertInsideTmp(dir);
  await fs.rm(dir, { recursive: true, force: true });
}

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

async function runCli(args: string[], extraEnv: NodeJS.ProcessEnv = {}): Promise<CliResult> {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extraEnv };
  for (const key of ["MNEMOSHELF_FFMPEG_PATH", "MNEMOSHELF_FFPROBE_PATH", "MNEMOSHELF_FFMPEG_DIR"]) {
    if (!(key in extraEnv)) delete env[key];
  }
  return await new Promise<CliResult>((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: repoRoot,
      env,
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function gatedEnv(): NodeJS.ProcessEnv {
  if (gated === null) return {};
  return { MNEMOSHELF_FFMPEG_PATH: gated.ffmpeg, MNEMOSHELF_FFPROBE_PATH: gated.ffprobe };
}

async function sha256(file: string): Promise<string> {
  const mod = await loadHelper();
  return await mod.sha256File(file);
}

/** 目錄快照：名稱→bytes＋sha256（用來斷言「失敗不毀舊產物」）。 */
async function snapshotDir(dir: string): Promise<Record<string, string>> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const snapshot: Record<string, string> = {};
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isFile()) snapshot[entry.name] = "file:" + String((await fs.stat(full)).size) + ":" + (await sha256(full));
    else if (entry.isDirectory()) snapshot[entry.name] = "dir";
    else snapshot[entry.name] = "other";
  }
  return snapshot;
}

/** 失敗時暫存目錄（sibling .staging-／.old-）不得殘留。 */
async function listSiblingLeftovers(dir: string): Promise<string[]> {
  const parent = path.dirname(dir);
  const base = path.basename(dir);
  const entries = await fs.readdir(parent);
  return entries.filter((name) => name.startsWith(base + ".staging-") || name.startsWith(base + ".old-"));
}

describe("stage-media-bin：輸出目錄所有權（D7／STD-2）", () => {
  it("未知檔案不被刪除：CLI 拒絕且 sentinel 內容完好（原反例，gated）", async () => {
    if (gated === null) {
      console.log("[stage-media-bin] 略過：找不到已驗證 binary（設 MNEMOSHELF_FFMPEG_PATH／MNEMOSHELF_FFPROBE_PATH 或先 staging media-bin）");
      return;
    }
    const outDir = await makeTempDir("sentinel-out-");
    const sentinel = path.join(outDir, "unrelated-user-file.txt");
    const sentinelContent = "synthetic sentinel only；不得被 staging 刪除";
    try {
      await fs.writeFile(sentinel, sentinelContent, "utf8");
      const before = await snapshotDir(outDir);
      const result = await runCli(["--out", outDir], gatedEnv());
      expect(result.code, "未知檔案存在時必須以驗證失敗（2）拒絕。stdout=" + result.stdout + " stderr=" + result.stderr).toBe(2);
      expect(result.stderr).toContain("未知");
      expect(await snapshotDir(outDir)).toEqual(before);
      expect(await fs.readFile(sentinel, "utf8")).toBe(sentinelContent);
    } finally {
      await removeTempDir(outDir);
    }
  });

  it("不需 binary：未知檔案也要先被拒絕（exit 2，且不改動目錄）", async () => {
    const outDir = await makeTempDir("sentinel-ungated-");
    const sentinel = path.join(outDir, "unrelated-user-file.txt");
    try {
      await fs.writeFile(sentinel, "synthetic sentinel only", "utf8");
      const result = await runCli(["--out", outDir]);
      expect(result.code, "stdout=" + result.stdout + " stderr=" + result.stderr).toBe(2);
      expect(result.stderr).toContain("未知");
      expect((await fs.readdir(outDir)).sort()).toEqual(["unrelated-user-file.txt"]);
    } finally {
      await removeTempDir(outDir);
    }
  });

  it("不需 binary：未知子目錄也被拒絕並列出項目，內容不動", async () => {
    const outDir = await makeTempDir("unknown-subdir-");
    try {
      await fs.mkdir(path.join(outDir, "nested"));
      await fs.writeFile(path.join(outDir, "nested", "keep.txt"), "keep", "utf8");
      const before = await snapshotDir(outDir);
      const result = await runCli(["--out", outDir]);
      expect(result.code, "stdout=" + result.stdout + " stderr=" + result.stderr).toBe(2);
      expect(result.stderr).toContain("未知");
      expect(result.stderr).toContain("nested");
      expect(await snapshotDir(outDir)).toEqual(before);
    } finally {
      await removeTempDir(outDir);
    }
  });

  it("不需 binary：--out 指向含既有檔案的一般資料夾時完整保留並拒絕", async () => {
    const outDir = await makeTempDir("user-folder-");
    try {
      await fs.writeFile(path.join(outDir, "notes.md"), "user content", "utf8");
      await fs.mkdir(path.join(outDir, "nested"));
      await fs.writeFile(path.join(outDir, "nested", "keep.txt"), "keep", "utf8");
      const before = await snapshotDir(outDir);
      const result = await runCli(["--out", outDir]);
      expect(result.code, "stdout=" + result.stdout + " stderr=" + result.stderr).toBe(2);
      expect(result.stderr).toContain("未知");
      expect(await snapshotDir(outDir)).toEqual(before);
      expect(await fs.readFile(path.join(outDir, "nested", "keep.txt"), "utf8")).toBe("keep");
    } finally {
      await removeTempDir(outDir);
    }
  });

  it("不需 binary：空目錄通過 guard，但缺來源時仍以用法錯誤（1）退出", async () => {
    const outDir = await makeTempDir("empty-usage-");
    try {
      const result = await runCli(["--out", outDir]);
      expect(result.code, "stdout=" + result.stdout + " stderr=" + result.stderr).toBe(1);
      expect(result.stderr).toContain("沒有指定解碼器來源");
      expect(await fs.readdir(outDir)).toEqual([]);
    } finally {
      await removeTempDir(outDir);
    }
  });

  it("不需 binary：--check 遇到未知項目時拒絕且不改動", async () => {
    const outDir = await makeTempDir("check-unknown-");
    try {
      await fs.writeFile(path.join(outDir, "sentinel.bin"), "sentinel", "utf8");
      const before = await snapshotDir(outDir);
      const result = await runCli(["--check", "--out", outDir]);
      expect(result.code, "stdout=" + result.stdout + " stderr=" + result.stderr).toBe(2);
      expect(result.stderr).toContain("未知");
      expect(await snapshotDir(outDir)).toEqual(before);
    } finally {
      await removeTempDir(outDir);
    }
  });

  it("不需 binary：--check 缺 manifest 時具名失敗（2）", async () => {
    const outDir = await makeTempDir("check-missing-");
    try {
      const result = await runCli(["--check", "--out", outDir]);
      expect(result.code, "stdout=" + result.stdout + " stderr=" + result.stderr).toBe(2);
      expect(result.stderr).toContain("manifest.json");
    } finally {
      await removeTempDir(outDir);
    }
  });

  it("CLI 參數錯誤維持用法錯誤（1）", async () => {
    const result = await runCli(["--bogus"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("不認得的參數");
  });
});

describe("media-bin-staging helper：所有權判斷", () => {
  const expected = ["ffmpeg.exe", "ffprobe.exe", "LICENSE.txt", "manifest.json"];

  function validManifest(mod: StagingHelper): Record<string, unknown> {
    return {
      schemaVersion: 1,
      generatedBy: mod.stagingGenerator,
      platform: process.platform,
      arch: process.arch,
      binaries: [],
      license: { fileName: "LICENSE.txt" },
    };
  }

  it("目錄不存在＝owned；空目錄＝owned；只有 marker 的預設目錄＝owned", async () => {
    const mod = await loadHelper();
    const missingParent = await makeTempDir("owned-missing-");
    try {
      const missing = path.join(missingParent, "media-bin");
      const missingInspection = await mod.inspectOutputDirectory({
        outDir: missing,
        defaultOutDir: missing,
        expectedFileNames: expected,
      });
      expect(missingInspection.exists).toBe(false);
      expect(missingInspection.owned).toBe(true);
    } finally {
      await removeTempDir(missingParent);
    }

    const empty = await makeTempDir("owned-empty-");
    try {
      const emptyInspection = await mod.inspectOutputDirectory({
        outDir: empty,
        defaultOutDir: empty,
        expectedFileNames: expected,
      });
      expect(emptyInspection.owned).toBe(true);
      await fs.writeFile(path.join(empty, mod.stagingMarkerFileName), "# marker\n", "utf8");
      const markerInspection = await mod.inspectOutputDirectory({
        outDir: empty,
        defaultOutDir: empty,
        expectedFileNames: expected,
      });
      expect(markerInspection.owned).toBe(true);
      expect(markerInspection.markerPresent).toBe(true);
    } finally {
      await removeTempDir(empty);
    }
  });

  it("未知檔案／未知子目錄：拒絕且列出前幾項、不改動任何內容", async () => {
    const mod = await loadHelper();
    const outDir = await makeTempDir("owned-unknown-");
    try {
      for (let index = 0; index < 7; index += 1) {
        await fs.writeFile(path.join(outDir, "sentinel-" + String(index) + ".txt"), "s", "utf8");
      }
      await fs.mkdir(path.join(outDir, "subdir"));
      const before = await snapshotDir(outDir);
      await expect(
        mod.inspectOutputDirectory({ outDir, defaultOutDir: outDir, expectedFileNames: expected }),
      ).rejects.toThrow(/未知/);
      expect(await snapshotDir(outDir)).toEqual(before);
      await expect(
        mod.inspectOutputDirectory({ outDir, defaultOutDir: outDir, expectedFileNames: expected }),
      ).rejects.toThrow(/另有 3 項/);
    } finally {
      await removeTempDir(outDir);
    }
  });

  it("已知產物但沒有有效 manifest：拒絕（不刪、不覆蓋）", async () => {
    const mod = await loadHelper();
    const outDir = await makeTempDir("owned-nomanifest-");
    try {
      await fs.writeFile(path.join(outDir, "ffmpeg.exe"), "fake", "utf8");
      const before = await snapshotDir(outDir);
      await expect(
        mod.inspectOutputDirectory({ outDir, defaultOutDir: outDir, expectedFileNames: expected }),
      ).rejects.toThrow(/沒有有效 manifest/);
      expect(await snapshotDir(outDir)).toEqual(before);
    } finally {
      await removeTempDir(outDir);
    }
  });

  it("manifest 的 schemaVersion／generatedBy／platform 不符：拒絕", async () => {
    const mod = await loadHelper();
    const outDir = await makeTempDir("owned-badmanifest-");
    try {
      const cases = [
        { ...validManifest(mod), schemaVersion: 2 },
        { ...validManifest(mod), generatedBy: "someone/else.mjs" },
        { ...validManifest(mod), platform: process.platform === "win32" ? "linux" : "win32" },
      ];
      for (const manifest of cases) {
        await fs.writeFile(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
        await fs.writeFile(path.join(outDir, "ffmpeg.exe"), "fake", "utf8");
        await expect(
          mod.inspectOutputDirectory({ outDir, defaultOutDir: outDir, expectedFileNames: expected }),
        ).rejects.toThrow(/沒有有效 manifest/);
      }
    } finally {
      await removeTempDir(outDir);
    }
  });

  it("有效 manifest＋只有已知產物＝owned", async () => {
    const mod = await loadHelper();
    const outDir = await makeTempDir("owned-valid-");
    try {
      await fs.writeFile(path.join(outDir, "manifest.json"), JSON.stringify(validManifest(mod), null, 2) + "\n", "utf8");
      await fs.writeFile(path.join(outDir, "ffmpeg.exe"), "fake", "utf8");
      const inspection = await mod.inspectOutputDirectory({ outDir, defaultOutDir: outDir, expectedFileNames: expected });
      expect(inspection.owned).toBe(true);
      expect(inspection.manifest).not.toBeNull();
    } finally {
      await removeTempDir(outDir);
    }
  });

  it("非預設目錄出現 .gitignore：視為未知項目拒絕（marker 只屬於預設目錄）", async () => {
    const mod = await loadHelper();
    const outDir = await makeTempDir("owned-marker-custom-");
    try {
      await fs.writeFile(path.join(outDir, mod.stagingMarkerFileName), "# marker\n", "utf8");
      await expect(
        mod.inspectOutputDirectory({
          outDir,
          defaultOutDir: path.join(path.dirname(outDir), "some-other-default"),
          expectedFileNames: expected,
        }),
      ).rejects.toThrow(/未知/);
    } finally {
      await removeTempDir(outDir);
    }
  });

  it("outDir 是 junction／symlink：拒絕", async () => {
    const mod = await loadHelper();
    const parent = await makeTempDir("link-parent-");
    const target = await makeTempDir("link-target-");
    const link = path.join(parent, "media-bin-link");
    try {
      try {
        await fs.symlink(target, link, process.platform === "win32" ? "junction" : "dir");
      } catch (error) {
        console.log("[stage-media-bin] 略過 symlink 測試：環境不允許建立連結（" + String(error) + "）");
        return;
      }
      const before = await snapshotDir(target);
      await expect(
        mod.inspectOutputDirectory({ outDir: link, defaultOutDir: link, expectedFileNames: expected }),
      ).rejects.toThrow(/symlink|junction|解析後/);
      expect(await snapshotDir(target)).toEqual(before);
    } finally {
      await fs.rm(link, { recursive: true, force: true }).catch(() => undefined);
      await removeTempDir(target);
      await removeTempDir(parent);
    }
  });
});

describe("media-bin-staging helper：原子替換", () => {
  const expected = ["ffmpeg.exe", "ffprobe.exe", "LICENSE.txt", "manifest.json"];

  async function makeSources(dir: string): Promise<{
    ffmpeg: string;
    ffprobe: string;
    license: string;
    plan: { binaries: unknown[]; license: unknown; manifest: Record<string, unknown> };
  }> {
    const mod = await loadHelper();
    const ffmpeg = path.join(dir, "src-ffmpeg.exe");
    const ffprobe = path.join(dir, "src-ffprobe.exe");
    const license = path.join(dir, "src-LICENSE.txt");
    await fs.writeFile(ffmpeg, "fake ffmpeg binary", "utf8");
    await fs.writeFile(ffprobe, "fake ffprobe binary", "utf8");
    await fs.writeFile(license, "GNU LESSER GENERAL PUBLIC LICENSE\nVersion 3, 29 June 2007\n", "utf8");
    return {
      ffmpeg,
      ffprobe,
      license,
      plan: {
        binaries: [
          { sourcePath: ffmpeg, fileName: binaryName("ffmpeg"), bytes: (await fs.stat(ffmpeg)).size, sha256: await sha256(ffmpeg) },
          { sourcePath: ffprobe, fileName: binaryName("ffprobe"), bytes: (await fs.stat(ffprobe)).size, sha256: await sha256(ffprobe) },
        ],
        license: { sourcePath: license, fileName: "LICENSE.txt", bytes: (await fs.stat(license)).size, sha256: await sha256(license) },
        manifest: {
          schemaVersion: 1,
          generatedBy: mod.stagingGenerator,
          platform: process.platform,
          arch: process.arch,
          binaries: [],
          license: { fileName: "LICENSE.txt" },
        },
      },
    };
  }

  async function stageInto(outDir: string, sources: Awaited<ReturnType<typeof makeSources>>, hooks: Record<string, unknown> = {}) {
    const mod = await loadHelper();
    return await mod.stageArtifactsAtomic({
      outDir,
      defaultOutDir: outDir,
      expectedFileNames: expected,
      binaries: sources.plan.binaries,
      license: sources.plan.license,
      manifest: sources.plan.manifest,
      hooks,
    });
  }

  it("目錄不存在：建立在 sibling 暫存目錄後 swap；產物與 manifest 正確、無殘留", async () => {
    const parent = await makeTempDir("atomic-fresh-parent-");
    try {
      const sourcesDir = await makeTempDir("atomic-src-");
      const sources = await makeSources(sourcesDir);
      const outDir = path.join(parent, "media-bin");
      try {
        const result = await stageInto(outDir, sources);
        expect(result.replacedExisting).toBe(false);
        expect(result.backupRemoved).toBe(false);
        const files = (await fs.readdir(outDir)).sort();
        expect(files).toEqual([binaryName("ffmpeg"), binaryName("ffprobe"), "LICENSE.txt", "manifest.json"].sort());
        expect(await sha256(path.join(outDir, binaryName("ffmpeg")))).toBe(String((sources.plan.binaries[0] as { sha256: string }).sha256));
        const manifest = JSON.parse(await fs.readFile(path.join(outDir, "manifest.json"), "utf8")) as Record<string, unknown>;
        expect(manifest.schemaVersion).toBe(1);
        expect(await listSiblingLeftovers(outDir)).toEqual([]);
      } finally {
        await removeTempDir(sourcesDir);
      }
    } finally {
      await removeTempDir(parent);
    }
  });

  it("既有 owned 目錄：原子替換、marker 保留、成功後不殘留備份", async () => {
    const outDir = await makeTempDir("atomic-replace-");
    try {
      const mod = await loadHelper();
      const sourcesDir = await makeTempDir("atomic-src-replace-");
      const sources = await makeSources(sourcesDir);
      try {
        // 先建立一份舊的 owned 產物（含 marker，模擬預設目錄）
        const oldManifest = { ...sources.plan.manifest, generatedAt: "old" };
        await fs.writeFile(path.join(outDir, mod.manifestFileName), JSON.stringify(oldManifest, null, 2) + "\n", "utf8");
        await fs.writeFile(path.join(outDir, binaryName("ffmpeg")), "old ffmpeg", "utf8");
        await fs.writeFile(path.join(outDir, mod.stagingMarkerFileName), "# marker\n", "utf8");
        const result = await stageInto(outDir, sources);
        expect(result.replacedExisting).toBe(true);
        expect(result.markerPreserved).toBe(true);
        const files = (await fs.readdir(outDir)).sort();
        expect(files).toContain(mod.stagingMarkerFileName);
        expect(await fs.readFile(path.join(outDir, mod.stagingMarkerFileName), "utf8")).toBe("# marker\n");
        expect(await sha256(path.join(outDir, binaryName("ffmpeg")))).toBe(String((sources.plan.binaries[0] as { sha256: string }).sha256));
        expect(await listSiblingLeftovers(outDir)).toEqual([]);
      } finally {
        await removeTempDir(sourcesDir);
      }
    } finally {
      await removeTempDir(outDir);
    }
  });

  it("複製失敗（模擬 copy 錯誤）：舊產物完全保留、不殘留暫存目錄", async () => {
    const outDir = await makeTempDir("atomic-copy-fail-");
    try {
      const mod = await loadHelper();
      const sourcesDir = await makeTempDir("atomic-src-copyfail-");
      const sources = await makeSources(sourcesDir);
      try {
        await fs.writeFile(path.join(outDir, mod.manifestFileName), JSON.stringify(sources.plan.manifest, null, 2) + "\n", "utf8");
        await fs.writeFile(path.join(outDir, binaryName("ffmpeg")), "old ffmpeg", "utf8");
        const before = await snapshotDir(outDir);
        await expect(
          stageInto(outDir, sources, {
            copyFile: async (source: string, destination: string) => {
              if (String(source).includes("src-ffprobe")) throw new Error("synthetic copy failure");
              await fs.copyFile(source, destination);
            },
          }),
        ).rejects.toThrow(/synthetic copy failure/);
        expect(await snapshotDir(outDir)).toEqual(before);
        expect(await listSiblingLeftovers(outDir)).toEqual([]);
      } finally {
        await removeTempDir(sourcesDir);
      }
    } finally {
      await removeTempDir(outDir);
    }
  });

  it("複製後 SHA256 不一致：舊產物保留、不 swap、不殘留", async () => {
    const outDir = await makeTempDir("atomic-hash-fail-");
    try {
      const mod = await loadHelper();
      const sourcesDir = await makeTempDir("atomic-src-hashfail-");
      const sources = await makeSources(sourcesDir);
      try {
        await fs.writeFile(path.join(outDir, mod.manifestFileName), JSON.stringify(sources.plan.manifest, null, 2) + "\n", "utf8");
        await fs.writeFile(path.join(outDir, binaryName("ffmpeg")), "old ffmpeg", "utf8");
        const before = await snapshotDir(outDir);
        await expect(
          stageInto(outDir, sources, {
            sha256File: async (file: string) => {
              const real = await sha256(String(file));
              return String(file).includes(binaryName("ffmpeg")) && !String(file).includes("src-") ? "0".repeat(64) : real;
            },
          }),
        ).rejects.toThrow(/SHA256 不一致/);
        expect(await snapshotDir(outDir)).toEqual(before);
        expect(await listSiblingLeftovers(outDir)).toEqual([]);
      } finally {
        await removeTempDir(sourcesDir);
      }
    } finally {
      await removeTempDir(outDir);
    }
  });

  it("swap 失敗（模擬 rename 錯誤）：回滾舊產物、不殘留", async () => {
    const outDir = await makeTempDir("atomic-swap-fail-");
    try {
      const mod = await loadHelper();
      const sourcesDir = await makeTempDir("atomic-src-swapfail-");
      const sources = await makeSources(sourcesDir);
      try {
        await fs.writeFile(path.join(outDir, mod.manifestFileName), JSON.stringify(sources.plan.manifest, null, 2) + "\n", "utf8");
        await fs.writeFile(path.join(outDir, binaryName("ffmpeg")), "old ffmpeg", "utf8");
        const before = await snapshotDir(outDir);
        let stagingRenames = 0;
        await expect(
          stageInto(outDir, sources, {
            rename: async (source: string, destination: string) => {
              if (String(source).includes(".staging-")) {
                stagingRenames += 1;
                if (stagingRenames === 1) throw new Error("synthetic rename failure");
              }
              await fs.rename(source, destination);
            },
          }),
        ).rejects.toThrow(/已回滾/);
        expect(await snapshotDir(outDir)).toEqual(before);
        expect(await listSiblingLeftovers(outDir)).toEqual([]);
      } finally {
        await removeTempDir(sourcesDir);
      }
    } finally {
      await removeTempDir(outDir);
    }
  });

  it("replace 期間舊目錄冒出未知檔案（競態）：回滾並拒絕，sentinel 留在原目錄", async () => {
    const outDir = await makeTempDir("atomic-race-");
    try {
      const mod = await loadHelper();
      const sourcesDir = await makeTempDir("atomic-src-race-");
      const sources = await makeSources(sourcesDir);
      try {
        await fs.writeFile(path.join(outDir, mod.manifestFileName), JSON.stringify(sources.plan.manifest, null, 2) + "\n", "utf8");
        await fs.writeFile(path.join(outDir, binaryName("ffmpeg")), "old ffmpeg", "utf8");
        await expect(
          stageInto(outDir, sources, {
            rename: async (source: string, destination: string) => {
              await fs.rename(source, destination);
              // 模擬 swap 前檢查之後、備份 rename 之後，有別的程式把檔案放進舊目錄。
              if (String(destination).includes(".old-")) {
                await fs.writeFile(path.join(destination, "late-sentinel.txt"), "late sentinel", "utf8");
              }
            },
          }),
        ).rejects.toThrow(/未知/);
        // 回滾後原目錄仍在：競態檔案與原本舊產物都保留（未被備份清理刪掉）
        expect(await fs.readFile(path.join(outDir, "late-sentinel.txt"), "utf8")).toBe("late sentinel");
        expect(await fs.readFile(path.join(outDir, binaryName("ffmpeg")), "utf8")).toBe("old ffmpeg");
        expect(await listSiblingLeftovers(outDir)).toEqual([]);
      } finally {
        await removeTempDir(sourcesDir);
      }
    } finally {
      await removeTempDir(outDir);
    }
  }, 60_000);

  it("未知檔名（含路徑分隔／..）在寫入前就拒絕", async () => {
    const mod = await loadHelper();
    const parent = await makeTempDir("atomic-badname-parent-");
    const sourcesDir = await makeTempDir("atomic-src-badname-");
    const sources = await makeSources(sourcesDir);
    try {
      await expect(
        mod.stageArtifactsAtomic({
          outDir: path.join(parent, "media-bin"),
          defaultOutDir: path.join(parent, "media-bin"),
          expectedFileNames: expected,
          binaries: [{ sourcePath: sources.ffmpeg, fileName: "../escape.exe", bytes: 1, sha256: "0".repeat(64) }],
          license: sources.plan.license,
          manifest: sources.plan.manifest,
        }),
      ).rejects.toThrow(/檔名不合法/);
      expect(await fs.readdir(parent)).toEqual([]);
    } finally {
      await removeTempDir(sourcesDir);
      await removeTempDir(parent);
    }
  });
});

describe("stage-media-bin CLI：真候選端到端（gated）", () => {
  it("正常 staging→--check→未知項目拒絕→再 staging 仍拒絕且舊產物完好", async () => {
    if (gated === null) {
      console.log("[stage-media-bin] 略過真候選 CLI 端到端：找不到已驗證 binary（設 MNEMOSHELF_FFMPEG_PATH／MNEMOSHELF_FFPROBE_PATH 或先 staging media-bin）");
      return;
    }
    const mod = await loadHelper();
    const outDir = await makeTempDir("cli-e2e-");
    try {
      // 1) 第一次 staging：成功
      const first = await runCli(["--out", outDir], gatedEnv());
      expect(first.code, "stdout=" + first.stdout + " stderr=" + first.stderr).toBe(0);
      const firstFiles = (await fs.readdir(outDir)).sort();
      expect(firstFiles).toEqual([binaryName("ffmpeg"), binaryName("ffprobe"), "LICENSE.txt", "manifest.json"].sort());
      const manifest = JSON.parse(await fs.readFile(path.join(outDir, "manifest.json"), "utf8")) as {
        schemaVersion: number;
        generatedBy: string;
        platform: string;
        arch: string;
        binaries: { name: string; fileName: string; bytes: number; sha256: string }[];
        license: { fileName: string; bytes: number; sha256: string };
      };
      expect(manifest.schemaVersion).toBe(1);
      expect(manifest.generatedBy).toBe(mod.stagingGenerator);
      expect(manifest.platform).toBe(process.platform);
      expect(manifest.arch).toBe(process.arch);
      expect(manifest.binaries.length).toBe(2);
      for (const entry of manifest.binaries) {
        expect(await fs.stat(path.join(outDir, entry.fileName)).then((info) => info.size)).toBe(entry.bytes);
        expect(await sha256(path.join(outDir, entry.fileName))).toBe(entry.sha256);
      }
      expect(await sha256(path.join(outDir, "LICENSE.txt"))).toBe(manifest.license.sha256);
      expect(await listSiblingLeftovers(outDir)).toEqual([]);

      // 2) --check：綠
      const check = await runCli(["--check", "--out", outDir]);
      expect(check.code, "stdout=" + check.stdout + " stderr=" + check.stderr).toBe(0);
      expect(check.stdout).toContain("check 通過");

      // 3) 第二次 staging（owned，原子替換）：成功
      const second = await runCli(["--out", outDir], gatedEnv());
      expect(second.code, "stdout=" + second.stdout + " stderr=" + second.stderr).toBe(0);
      expect(await listSiblingLeftovers(outDir)).toEqual([]);

      // 4) 加入未知檔案後：--check 與 staging 都拒絕，舊產物完全保留
      const sentinel = path.join(outDir, "user-notes.txt");
      await fs.writeFile(sentinel, "user sentinel", "utf8");
      const before = await snapshotDir(outDir);
      const checkUnknown = await runCli(["--check", "--out", outDir]);
      expect(checkUnknown.code, "stdout=" + checkUnknown.stdout + " stderr=" + checkUnknown.stderr).toBe(2);
      expect(checkUnknown.stderr).toContain("未知");
      const stageUnknown = await runCli(["--out", outDir], gatedEnv());
      expect(stageUnknown.code, "stdout=" + stageUnknown.stdout + " stderr=" + stageUnknown.stderr).toBe(2);
      expect(stageUnknown.stderr).toContain("未知");
      expect(await snapshotDir(outDir)).toEqual(before);
    } finally {
      await removeTempDir(outDir);
    }
  }, 180_000);

  it("成功 staging 後 manifest 若被改壞：--check 拒絕且不改動", async () => {
    if (gated === null) {
      console.log("[stage-media-bin] 略過：找不到已驗證 binary");
      return;
    }
    const outDir = await makeTempDir("cli-check-tampered-");
    try {
      const first = await runCli(["--out", outDir], gatedEnv());
      expect(first.code, "stdout=" + first.stdout + " stderr=" + first.stderr).toBe(0);
      await fs.writeFile(path.join(outDir, "manifest.json"), "{ not valid json", "utf8");
      const before = await snapshotDir(outDir);
      const check = await runCli(["--check", "--out", outDir]);
      expect(check.code, "stdout=" + check.stdout + " stderr=" + check.stderr).toBe(2);
      expect(check.stderr).toContain("沒有有效 manifest");
      expect(await snapshotDir(outDir)).toEqual(before);
    } finally {
      await removeTempDir(outDir);
    }
  }, 180_000);
});
