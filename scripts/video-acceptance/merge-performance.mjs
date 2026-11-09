#!/usr/bin/env node
// 將已驗 hash 的獨立素材 run 複製至新 run，保留可追溯來源；不修改來源。
import { createHash, randomBytes } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
if (process.env.VIDEO_PERF_MERGE !== "1") throw new Error("設定 VIDEO_PERF_MERGE=1 才能執行");
const sources = (process.env.VIDEO_PERF_MERGE_SOURCE_IDS ?? "").split(",");
const id = process.env.VIDEO_PERF_MERGE_ID ?? `run-${Date.now()}-${randomBytes(4).toString("hex")}`;
if (![id, ...sources].every((value) => /^[a-zA-Z0-9_-]+$/.test(value)) || new Set(sources).size !== sources.length) throw new Error("來源或 runId 無效");
const root = path.join(process.cwd(), ".tmp", "video-acceptance", "performance");
const required = ["1080p-60", "1080p-300", "1080p-600", "1080p-tail", "1080p-near-limit"];
const selected = new Map();
async function sha256(file) { const h = createHash("sha256"); for await (const part of createReadStream(file)) h.update(part); return h.digest("hex"); }
for (const sourceId of sources) {
  const dir = path.join(root, sourceId);
  const manifest = JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8"));
  if (manifest.status !== "complete") throw new Error(`來源未完成：${sourceId}`);
  for (const item of manifest.cases) {
    if (!required.includes(item.name) || !item.ok || selected.has(item.name)) throw new Error(`素材不合法或重複：${item.name}`);
    const file = path.join(dir, `${item.name}.mp4`);
    if (await sha256(file) !== item.sha256) throw new Error(`來源 hash 不符：${item.name}`);
    selected.set(item.name, { item, file, sourceId });
  }
}
if (required.some((name) => !selected.has(name))) throw new Error("素材未齊");
const target = path.join(root, id); await mkdir(target);
const report = { runId: id, status: "running", source: "合併獨立生成 run，來源與輸出逐檔驗 hash", sourceRuns: sources, cases: [] };
const save = () => writeFile(path.join(target, "manifest.json"), JSON.stringify(report, null, 2));
await save();
try {
  for (const name of required) {
    const { item, file, sourceId } = selected.get(name);
    const dest = path.join(target, `${name}.mp4`);
    await copyFile(file, dest, constants.COPYFILE_EXCL);
    if (await sha256(dest) !== item.sha256) throw new Error(`複本 hash 不符：${name}`);
    report.cases.push({ ...item, sourceRunId: sourceId }); await save();
  }
  report.status = "complete";
} catch (error) { report.status = "error"; report.error = String(error); process.exitCode = 1; }
await save(); console.log(JSON.stringify({ id, status: report.status, files: report.cases.length }));
