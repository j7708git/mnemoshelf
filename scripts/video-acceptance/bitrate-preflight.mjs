#!/usr/bin/env node
// 短碼率探索僅評估編碼參數，不代表長片大小或索引效能。
import { spawn } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
if (process.env.VIDEO_BITRATE_PREFLIGHT !== "1") throw new Error("必須明確設定 VIDEO_BITRATE_PREFLIGHT=1");
const id = process.env.VIDEO_BITRATE_RUN_ID ?? `run-${Date.now()}-${randomBytes(4).toString("hex")}`;
if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("runId 無效");
const root = process.cwd();
const dir = path.join(root, ".tmp", "video-acceptance", "bitrate-preflight", id);
const source = path.join(root, ".tmp", "video-a", "corpus", "eval-root", "v01.mp4");
const h = createHash("sha256"); for await (const part of createReadStream(source)) h.update(part);
if (h.digest("hex") !== "11ff9ea4e75d39e9f797e715043d3fd924305998299ffea8ac7e64f00015a313") throw new Error("來源 hash 不符");
const bin = path.join(root, ".tmp", "video-a", "decoder", "bin", "ffmpeg-n9.0.2-48-gd4070a14ce-win64-lgpl-9.0", "bin");
const ffmpeg = process.env.MNEMOSHELF_FFMPEG ?? path.join(bin, process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
const ffprobe = process.env.MNEMOSHELF_FFPROBE ?? path.join(bin, process.platform === "win32" ? "ffprobe.exe" : "ffprobe");
await mkdir(path.dirname(dir), { recursive: true }); await mkdir(dir);
const report = { id, status: "running", source: "v01 frozen", duration: 10, targetVideoBitrate: "6900k", results: [] };
async function save() { await writeFile(path.join(dir, "report.json"), JSON.stringify(report, null, 2)); }
async function run(exe, args) {
  return await new Promise((resolve, reject) => {
    const c = spawn(exe, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }); let out = "", err = "";
    c.stdout.on("data", (p) => { out += p; }); c.stderr.on("data", (p) => { err = (err + p).slice(-4096); });
    c.on("error", reject); c.on("close", (code) => code === 0 ? resolve(out) : reject(new Error(`exit ${code}: ${err}`)));
  });
}
await save();
try {
  for (const strength of [0, 3, 6, 12]) {
    const file = path.join(dir, `noise-${strength}.mp4`);
    const filter = strength ? `scale=1920:1080,noise=alls=${strength}:allf=t+u:all_seed=123457` : "scale=1920:1080";
    await run(ffmpeg, ["-nostdin", "-n", "-v", "error", "-i", source, "-t", "10", "-vf", filter, "-c:v", "libopenh264", "-b:v", "6900k", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", file]);
    const probe = JSON.parse(await run(ffprobe, ["-v", "error", "-show_entries", "format=duration,size,bit_rate:stream=codec_type,codec_name,bit_rate,width,height", "-of", "json", file]));
    report.results.push({ strength, filter, bytes: (await stat(file)).size, probe }); await save();
  }
  report.status = "complete";
} catch (error) { report.status = "error"; report.error = String(error); process.exitCode = 1; }
await save(); console.log(JSON.stringify(report));
