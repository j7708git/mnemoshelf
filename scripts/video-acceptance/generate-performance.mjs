#!/usr/bin/env node
// 僅在取得獨占時段後產生合成效能素材；每次只能建立新 run。
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { repeatedIntervals } from "./relevance.mjs";

const root = process.cwd();
if (process.env.VIDEO_PERF_GENERATE !== "1") throw new Error("設定 VIDEO_PERF_GENERATE=1 才能產生長片");
const id = process.env.VIDEO_PERF_RUN_ID ?? `run-${Date.now()}-${randomBytes(4).toString("hex")}`;
if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("runId 無效");
const dir = path.join(root, ".tmp", "video-acceptance", "performance", id);
const bins = path.join(root, ".tmp", "video-a", "decoder", "bin", "ffmpeg-n9.0.2-48-gd4070a14ce-win64-lgpl-9.0", "bin");
const ffmpeg = process.env.MNEMOSHELF_FFMPEG ?? path.join(bins, process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
const ffprobe = process.env.MNEMOSHELF_FFPROBE ?? path.join(bins, process.platform === "win32" ? "ffprobe.exe" : "ffprobe");
await mkdir(path.dirname(dir), { recursive: true });
await mkdir(dir);
async function run(exe, args) {
  return await new Promise((resolve, reject) => {
    const child = spawn(exe, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (part) => { out += part; });
    child.stderr.on("data", (part) => { err = (err + part).slice(-4096); });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(out) : reject(new Error(`程序失敗 ${code}: ${err}`)));
  });
}
async function hash(file) {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(file)) h.update(chunk);
  return h.digest("hex");
}
const source = path.join(root, ".tmp", "video-a", "corpus", "eval-root", "v01.mp4");
if (await hash(source) !== "11ff9ea4e75d39e9f797e715043d3fd924305998299ffea8ac7e64f00015a313") throw new Error("v01 來源雜湊不符");
const noiseStrength = Number(process.env.VIDEO_PERF_NOISE_STRENGTH ?? "0");
if (![0, 3, 6, 12].includes(noiseStrength)) throw new Error("雜訊強度必須為 0、3、6 或 12");
const cases = [
  { name: "1080p-60", duration: 60 },
  { name: "1080p-300", duration: 300 },
  { name: "1080p-600", duration: 600 },
  { name: "1080p-tail", duration: 60.2 },
  // 目標 496 MiB；檔案大小須實測，編碼器不保證精確達到目標。
  { name: "1080p-near-limit", duration: 600, bitrate: "6900k" },
];
const selection = process.env.VIDEO_PERF_CASES?.split(",") ?? cases.map((item) => item.name);
if (selection.length === 0 || new Set(selection).size !== selection.length || selection.some((name) => !cases.some((item) => item.name === name))) throw new Error("素材選擇無效");
const selectedCases = cases.filter((item) => selection.includes(item.name));
const result = { source: "frozen v01, 640x360 upscaled to 1920x1080, looped", runId: id, startedAt: new Date().toISOString(), cases: [], status: "running" };
async function save() { await writeFile(path.join(dir, "manifest.json"), JSON.stringify(result, null, 2)); }
await save();
try {
  for (const item of selectedCases) {
    const file = path.join(dir, `${item.name}.mp4`);
    const rate = item.bitrate ?? "2500k";
    const strength = item.bitrate ? noiseStrength : 0;
    const filter = strength ? `scale=1920:1080,noise=alls=${strength}:allf=t+u:all_seed=123457` : "scale=1920:1080";
    await run(ffmpeg, ["-nostdin", "-n", "-v", "error", "-stream_loop", "-1", "-i", source, "-t", String(item.duration), "-vf", filter, "-c:v", "libopenh264", "-b:v", rate, "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", file]);
    const probe = JSON.parse(await run(ffprobe, ["-v", "error", "-show_entries", "format=duration,size,bit_rate:stream=codec_type,codec_name,width,height,bit_rate", "-of", "json", file]));
    const bytes = (await stat(file)).size;
    const video = probe.streams.find((s) => s.codec_type === "video");
    const audio = probe.streams.find((s) => s.codec_type === "audio");
    const ok = video?.width === 1920 && video?.height === 1080 && video?.codec_name === "h264" && audio?.codec_name === "aac" && Math.abs(Number(probe.format.duration) - item.duration) <= 0.1 && bytes <= 512 * 1024 * 1024 && (!item.bitrate || bytes >= 480 * 1024 * 1024);
    result.cases.push({ ...item, filter, noiseStrength: strength, relevantQueryId: "V01", relevantIntervals: repeatedIntervals(item.duration), bytes, sha256: await hash(file), probe, ok });
    await save();
    if (!ok) throw new Error(`${item.name} 未達素材條件；保留檔案與報告供檢查`);
  }
  result.status = "complete";
} catch (error) { result.status = "error"; result.error = String(error); process.exitCode = 1; }
await save();
console.log(JSON.stringify({ runId: id, status: result.status, cases: result.cases.map(({ name, bytes, ok }) => ({ name, bytes, ok })) }));
