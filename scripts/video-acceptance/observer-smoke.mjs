#!/usr/bin/env node
// 只測觀測器，不載模型；短程序未採到時照實失敗。
import { randomBytes, createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { observeMediaProcesses } from "./process-observer.mjs";
if (process.env.VIDEO_OBSERVER_SMOKE !== "1") throw new Error("設定 VIDEO_OBSERVER_SMOKE=1 才能執行");
const sourceId = process.env.VIDEO_PERF_SOURCE_ID;
const id = process.env.VIDEO_OBSERVER_RUN_ID ?? `run-${Date.now()}-${randomBytes(4).toString("hex")}`;
if (![sourceId, id].every((value) => value && /^[a-zA-Z0-9_-]+$/.test(value))) throw new Error("runId 無效");
const root = process.cwd();
const sourceDir = path.join(root, ".tmp", "video-acceptance", "performance", sourceId);
const manifest = JSON.parse(await readFile(path.join(sourceDir, "manifest.json"), "utf8"));
const entry = manifest.cases.find((item) => item.name === "1080p-60" && item.ok);
if (manifest.status !== "complete" || !entry) throw new Error("素材尚未驗證");
const source = path.join(sourceDir, "1080p-60.mp4"); const hash = createHash("sha256");
for await (const part of createReadStream(source)) hash.update(part);
if (hash.digest("hex") !== entry.sha256) throw new Error("素材 hash 不符");
const out = path.join(root, ".tmp", "video-acceptance", "runs", id);
await mkdir(path.dirname(out), { recursive: true }); await mkdir(out);
const observer = observeMediaProcesses(); const ready = await observer.ready();
const report = { id, sourceId, executionEnvironment: process.env.VIDEO_ACCEPTANCE_ENVIRONMENT === "normal-permissions" ? "normal-permissions" : "sandbox-or-unspecified", sourceSha256: entry.sha256, samplerReady: ready, status: "running" };
const save = () => writeFile(path.join(out, "observer-smoke.json"), JSON.stringify(report, null, 2));
await save();
try {
  const { spawn } = await import("node:child_process");
  const bin = path.join(root, ".tmp", "video-a", "decoder", "bin", "ffmpeg-n9.0.2-48-gd4070a14ce-win64-lgpl-9.0", "bin");
  const ffmpeg = process.env.MNEMOSHELF_FFMPEG ?? path.join(bin, "ffmpeg.exe");
  const ffprobe = process.env.MNEMOSHELF_FFPROBE ?? path.join(bin, "ffprobe.exe");
  async function run(exe, args) { await new Promise((resolve, reject) => { const child = spawn(exe, args, { windowsHide: true, stdio: "ignore" }); child.on("error", reject); child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`exit ${code}`))); }); }
  await Promise.all([run(ffmpeg, ["-version"]), run(ffprobe, ["-version"])]);
  await run(ffprobe, ["-v", "error", "-select_streams", "v:0", "-show_frames", "-show_entries", "frame=pts_time", "-of", "csv=p=0", source]);
  for (let i = 0; i < 5; i++) await run(ffmpeg, ["-nostdin", "-v", "error", "-i", source, "-map", "0:a:0", "-vn", "-f", "f32le", "-ac", "1", "-ar", "16000", "pipe:1"]);
  await new Promise((resolve) => setTimeout(resolve, 500));
  report.observer = observer.snapshot();
  const audio = report.observer.events.filter((event) => event.phase === "audio");
  const captured = audio.filter((event) => report.observer.samples.some((sample) => sample.complete && sample.pids.includes(event.pid)));
  report.audioProcessCount = audio.length; report.audioSampledCount = captured.length;
  report.status = ready && audio.length === 5 && captured.length === 5 && !report.observer.samplerError ? "ok" : "incomplete";
  if (report.status !== "ok") process.exitCode = 1;
} catch (error) { report.status = "error"; report.error = { name: error?.name ?? "Error" }; process.exitCode = 1; }
finally { report.observer = observer.snapshot(); await observer.close(); await save(); }
console.log(JSON.stringify({ status: report.status, audioProcessCount: report.audioProcessCount, audioSampledCount: report.audioSampledCount, unsampledPids: report.observer.unsampledPids, samplerError: report.observer.samplerError }));
