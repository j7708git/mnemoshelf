#!/usr/bin/env node
// 與既有音訊驗收相同的固定種子敲門 WAV；只建立新 run。
import { createHash, randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
const id = process.env.VIDEO_AUDIO_FIXTURE_RUN_ID ?? `run-${Date.now()}-${randomBytes(4).toString("hex")}`;
if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("runId 無效");
const dir = path.join(process.cwd(), ".tmp", "video-acceptance", "audio", id);
const rate = 16000;
let seed = 0x13579bdf;
function noise() { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 0xffffffff * 2 - 1; }
const samples = new Float32Array(rate * 5);
for (let second = 0; second < 5; second++) for (const beat of [0.1, 0.3, 0.5]) {
  const start = Math.round((second + beat) * rate);
  for (let i = 0; i < rate * 0.14; i++) {
    const t = i / rate;
    samples[start + i] += 0.65 * Math.exp(-t * 45) * (0.65 * Math.sin(2 * Math.PI * 180 * t) + 0.2 * Math.sin(2 * Math.PI * 420 * t) + 0.15 * noise());
  }
}
const bytes = Buffer.alloc(44 + samples.length * 2);
bytes.write("RIFF"); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write("WAVE", 8); bytes.write("fmt ", 12);
bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(rate, 24);
bytes.writeUInt32LE(rate * 2, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write("data", 36); bytes.writeUInt32LE(samples.length * 2, 40);
for (let i = 0; i < samples.length; i++) bytes.writeInt16LE(Math.round(Math.max(-1, Math.min(32767 / 32768, samples[i])) * 32768), 44 + i * 2);
const sha256 = createHash("sha256").update(bytes).digest("hex");
if (sha256 !== "c0fdef41a0af25c5bc4a16472c9cda1028ee150049c8293b715ea8712e6a0904") throw new Error("固定合成 WAV hash 不符");
await mkdir(path.dirname(dir), { recursive: true }); await mkdir(dir);
await writeFile(path.join(dir, "f04.wav"), bytes, { flag: "wx" });
await writeFile(path.join(dir, "manifest.json"), JSON.stringify({ label: "knocking", bytes: bytes.length, sha256 }, null, 2), { flag: "wx" });
console.log(JSON.stringify({ id, sha256, bytes: bytes.length }));
