#!/usr/bin/env node
// 使用產品預設 deadline 的單次 decoder probe；不啟動模型。
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { observeMediaProcesses } from "./process-observer.mjs";
if (process.env.VIDEO_PROBE_RUN !== "1") throw new Error("設定 VIDEO_PROBE_RUN=1 才能執行");
const sourceId = process.env.VIDEO_PERF_SOURCE_ID;
const id = process.env.VIDEO_PROBE_RUN_ID ?? `run-${Date.now()}-${randomBytes(4).toString("hex")}`;
const name = process.env.VIDEO_PROBE_CASE ?? "1080p-600";
if (![sourceId, id].every((value) => value && /^[a-zA-Z0-9_-]+$/.test(value)) || !["1080p-60", "1080p-300", "1080p-600", "1080p-tail", "1080p-near-limit"].includes(name)) throw new Error("runId 或素材名稱無效");
const root = process.cwd();
const sourceDir = path.join(root, ".tmp", "video-acceptance", "performance", sourceId);
const manifest = JSON.parse(await readFile(path.join(sourceDir, "manifest.json"), "utf8"));
const entry = manifest.cases.find((item) => item.name === name && item.ok);
if (manifest.status !== "complete" || !entry) throw new Error("素材未通過生成驗證");
const source = path.join(sourceDir, `${name}.mp4`);
async function sha256(file) { const hash = createHash("sha256"); for await (const part of createReadStream(file)) hash.update(part); return hash.digest("hex"); }
if (await sha256(source) !== entry.sha256) throw new Error("素材 hash 不符");
const out = path.join(root, ".tmp", "video-acceptance", "runs", id);
await mkdir(path.dirname(out), { recursive: true }); await mkdir(out);
const observer = observeMediaProcesses();
const ready = await observer.ready();
const report = { id, sourceId, name, executionEnvironment: process.env.VIDEO_ACCEPTANCE_ENVIRONMENT === "normal-permissions" ? "normal-permissions" : "sandbox-or-unspecified", sourceSha256: entry.sha256, samplerReady: ready, status: "running" };
const save = () => writeFile(path.join(out, "probe.json"), JSON.stringify(report, null, 2));
await save();
try {
  const { FfmpegMediaDecoder } = await import("../../packages/core/dist/index.js");
  const bin = path.join(root, ".tmp", "video-a", "decoder", "bin", "ffmpeg-n9.0.2-48-gd4070a14ce-win64-lgpl-9.0", "bin");
  report.buildHashes = {};
  for (const parts of [["packages", "core", "src", "media", "ffmpeg-decoder.ts"], ["packages", "core", "src", "media", "parse.ts"], ["packages", "core", "dist", "media", "ffmpeg-decoder.js"], ["packages", "core", "dist", "media", "parse.js"]]) report.buildHashes[path.join(...parts)] = await sha256(path.join(root, ...parts));
  report.decoderHashes = { ffmpeg: await sha256(process.env.MNEMOSHELF_FFMPEG ?? path.join(bin, "ffmpeg.exe")), ffprobe: await sha256(process.env.MNEMOSHELF_FFPROBE ?? path.join(bin, "ffprobe.exe")) };
  await save();
  const decoder = new FfmpegMediaDecoder({ ffmpegPath: process.env.MNEMOSHELF_FFMPEG ?? path.join(bin, "ffmpeg.exe"), ffprobePath: process.env.MNEMOSHELF_FFPROBE ?? path.join(bin, "ffprobe.exe") });
  const start = performance.now();
  try {
    const result = await decoder.probe({ path: source });
    report.elapsedMs = performance.now() - start;
    const segments = result.visualTimeline?.length ?? null;
    const expectedSegments = Math.ceil(entry.duration / 4);
    const valid = result.video?.width === 1920 && result.video?.height === 1080 && Math.abs(result.durationSeconds - entry.duration) <= 0.1 && segments === expectedSegments;
    report.result = { durationSeconds: result.durationSeconds, width: result.video?.width, height: result.video?.height, segments, expectedSegments, valid };
    report.status = valid ? "ok" : "invalid-result";
    if (!valid) process.exitCode = 1;
  } catch (error) {
    report.elapsedMs = performance.now() - start;
    report.error = { name: error?.name ?? "Error", code: error?.code ?? null };
    report.status = "error"; process.exitCode = 1;
  }
} catch (error) { report.status = "error"; report.error = { name: error?.name ?? "Error" }; process.exitCode = 1; }
finally { report.observer = observer.snapshot(); await observer.close(); await save(); }
console.log(JSON.stringify({ status: report.status, elapsedMs: report.elapsedMs, result: report.result, error: report.error, sampledPhases: [...new Set(report.observer.events.filter((event) => report.observer.samples.some((sample) => sample.complete && sample.pids.includes(event.pid))).map((event) => event.phase))] }));
