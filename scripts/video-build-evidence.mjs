#!/usr/bin/env node
// 保存受測工作樹與成品身分；只讀來源，報告只包含 repo 相對路徑。
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const repo = process.cwd();
const runId = process.env.VIDEO_BUILD_EVIDENCE_ID ?? `build-${Date.now()}-${randomBytes(4).toString("hex")}`;
if (!/^[a-zA-Z0-9_-]+$/.test(runId)) throw new Error("驗收名稱無效");
const out = path.join(repo, ".tmp", "video-acceptance", "builds", runId);
await mkdir(path.dirname(out), { recursive: true });
await mkdir(out);

async function hashFile(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function collect(relativeDir) {
  const result = [];
  async function visit(relative) {
    for (const entry of await readdir(path.join(repo, relative), { withFileTypes: true })) {
      const child = path.join(relative, entry.name);
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile()) result.push({ path: child, bytes: (await stat(path.join(repo, child))).size, sha256: await hashFile(path.join(repo, child)) });
      else throw new Error("驗收樹含非一般檔案，無法固定身分");
    }
  }
  await visit(relativeDir);
  result.sort((a, b) => a.path.localeCompare(b.path, "en"));
  return { sha256: createHash("sha256").update(JSON.stringify(result)).digest("hex"), files: result };
}

const packageNames = ["core", "embedder-transformers", "server", "web", "desktop"];
const report = {
  generatedAt: new Date().toISOString(),
  branch: execFileSync("git", ["branch", "--show-current"], { encoding: "utf8" }).trim(),
  head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  dirty: execFileSync("git", ["status", "--porcelain=v1"], { encoding: "utf8" }).trim() !== "",
  platform: process.platform,
  arch: process.arch,
  node: process.version,
  source: {}, dist: {}, packaged: {}, packagedMatchesDist: {},
  note: "HEAD 不是未提交工作樹身分；請以各檔 hash 與彙總 hash 對照。hash 相符不代表已完成執行驗收。",
};
for (const name of packageNames) {
  report.source[name] = await collect(path.join("packages", name, "src"));
  report.dist[name] = await collect(path.join("packages", name, "dist"));
}
const resources = path.join("packages", "desktop", "dist-app", "win-unpacked", "resources");
for (const relative of [path.join(resources, "app.asar"), path.join(resources, "bin", "ffmpeg.exe"), path.join(resources, "bin", "ffprobe.exe"), path.join(resources, "bin", "manifest.json")]) {
  report.packaged[relative] = { bytes: (await stat(path.join(repo, relative))).size, sha256: await hashFile(path.join(repo, relative)) };
}
report.packaged.web = await collect(path.join(resources, "web"));
// 使用現有 electron-builder 的傳遞相依，不新增套件；extractFile 回傳封存檔內容。
const desktopRequire = createRequire(path.join(repo, "packages", "desktop", "package.json"));
const builderRequire = createRequire(desktopRequire.resolve("electron-builder/package.json"));
const appBuilderRequire = createRequire(builderRequire.resolve("app-builder-lib/package.json"));
const asar = appBuilderRequire("@electron/asar");
const asarPath = path.join(repo, resources, "app.asar");
const desktopDist = path.join("packages", "desktop", "dist");
if (!report.dist.desktop.files.some((file) => path.relative(desktopDist, file.path) === "main.js")) throw new Error("desktop dist 缺少主程式，不能驗收空產物");
report.packaged.desktop = { files: [] };
for (const sourceFile of report.dist.desktop.files.filter((file) => !file.path.endsWith(".map") && !file.path.endsWith(".d.ts"))) {
  const relative = path.relative(desktopDist, sourceFile.path);
  const content = asar.extractFile(asarPath, path.join("dist", relative));
  report.packaged.desktop.files.push({ path: relative, bytes: content.length, sha256: createHash("sha256").update(content).digest("hex") });
}
report.packagedMatchesDist.desktop = report.packaged.desktop.files.every((file) => report.dist.desktop.files.find((sourceFile) => path.relative(desktopDist, sourceFile.path) === file.path)?.sha256 === file.sha256);
report.desktopArchiveCheck = "逐檔核對 dist 執行期檔案在 ASAR 的內容；不把來源檔 hash 當成編譯結果證明。";
for (const name of ["core", "embedder-transformers", "server"]) {
  report.packaged[name] = await collect(path.join(resources, "app.asar.unpacked", "node_modules", "@mnemoshelf", name, "dist"));
}
// 打包設定排除 sourcemap；app-builder-lib 26.17.0 的 excludedExts 也排除 d.ts。
// 比對實際配送的執行期檔案；完整 dist 清單仍保留在報告，不隱藏差異。
for (const name of ["core", "embedder-transformers", "server", "web"]) {
  const packagedBase = name === "web" ? path.join(resources, "web") : path.join(resources, "app.asar.unpacked", "node_modules", "@mnemoshelf", name, "dist");
  const distBase = path.join("packages", name, "dist");
  const normalized = (tree, base) => tree.files.filter((file) => !file.path.endsWith(".map") && !file.path.endsWith(".d.ts")).map((file) => ({ path: path.relative(base, file.path), sha256: file.sha256 })).sort((a, b) => a.path.localeCompare(b.path, "en"));
  report.packagedMatchesDist[name] = JSON.stringify(normalized(report.dist[name], distBase)) === JSON.stringify(normalized(report.packaged[name], packagedBase));
}
await writeFile(path.join(out, "manifest.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ runId, head: report.head, dirty: report.dirty, packagedMatchesDist: report.packagedMatchesDist, source: Object.fromEntries(Object.entries(report.source).map(([name, tree]) => [name, tree.sha256])), manifest: path.relative(repo, path.join(out, "manifest.json")) }));
if (Object.values(report.packagedMatchesDist).some((matches) => !matches)) process.exitCode = 1;
