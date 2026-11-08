/** 固定合成語料；TTS 先以相鄰 PowerShell 腳本產生，所有產物留在 .tmp。 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const output = path.join(root, ".tmp", "audio-indexing-acceptance");
const fixtures = path.join(output, "fixtures");
await mkdir(fixtures, { recursive: true });
const { inspectWav } = await import(pathToFileURL(path.join(root, "packages", "core", "dist", "audio", "wav.js")).href);
const rate = 16000;

function encode(samples: Float32Array): Buffer {
  const bytes = Buffer.alloc(44 + samples.length * 2);
  bytes.write("RIFF", 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write("WAVE", 8);
  bytes.write("fmt ", 12); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write("data", 36);
  bytes.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) bytes.writeInt16LE(Math.round(Math.max(-1, Math.min(32767 / 32768, samples[i])) * 32768), 44 + i * 2);
  return bytes;
}

const manifest: Record<string, unknown>[] = [];
async function save(name: string, bytes: Uint8Array, label: string): Promise<void> {
  const info = inspectWav(bytes);
  manifest.push({ name, label, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.byteLength, sampleRate: info.sampleRate, frames: info.frameCount, seconds: info.durationSeconds });
  await writeFile(path.join(fixtures, name), bytes);
}
for (const [name, label] of [["f01.wav", "cooking"], ["f02.wav", "meeting"], ["f03.wav", "train"]]) {
  await save(name, await readFile(path.join(output, "tts", name)), label);
}

let seed = 0x13579bdf;
function noise(): number { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 0xffffffff * 2 - 1; }
const knock = new Float32Array(rate * 5);
for (let second = 0; second < 5; second++) {
  for (const beat of [0.1, 0.3, 0.5]) {
    const start = Math.round((second + beat) * rate);
    for (let i = 0; i < rate * 0.14; i++) {
      const t = i / rate;
      knock[start + i] += 0.65 * Math.exp(-t * 45) * (0.65 * Math.sin(2 * Math.PI * 180 * t) + 0.2 * Math.sin(2 * Math.PI * 420 * t) + 0.15 * noise());
    }
  }
}
await save("f04.wav", encode(knock), "knocking");
const rain = new Float32Array(rate * 5);
for (let i = 0; i < rain.length; i++) {
  const t = i / rate;
  rain[i] = noise() * (0.15 + 0.025 * Math.sin(2 * Math.PI * 0.7 * t));
  if (i % 1871 < 90) rain[i] += 0.15 * Math.exp(-(i % 1871) / 15) * noise();
}
await save("f05.wav", encode(rain), "rainfall");
const alarm = new Float32Array(rate * 5);
for (let i = 0; i < alarm.length; i++) {
  const t = i / rate;
  const cycle = t % 0.4;
  if (cycle < 0.2) {
    const gain = Math.min(cycle / 0.01, (0.2 - cycle) / 0.01, 1);
    const frequency = Math.floor(t / 0.4) % 2 ? 1320 : 880;
    alarm[i] = 0.4 * gain * Math.sin(2 * Math.PI * frequency * t);
  }
}
await save("f06.wav", encode(alarm), "alarm");
await save("f07.wav", encode(new Float32Array(rate * 5)), "silence");

const tail = await readFile(path.join(output, "tts", "tail.wav"));
const tailInfo = inspectWav(tail);
if (tailInfo.encoding !== "pcm16" || tailInfo.sampleRate !== rate || tailInfo.channels !== 1) throw new Error("TTS 格式與固定語料契約不同");
const timeline = new Float32Array(rate * 30 + Math.max(rate * 5, tailInfo.frameCount));
for (let i = 0; i < tailInfo.frameCount; i++) timeline[rate * 30 + i] = tail.readInt16LE(tailInfo.dataOffset + i * 2) / 32768;
await save("long.wav", encode(timeline), "30 seconds silence then complete cooking speech");
await save("replacement.wav", encode(alarm.subarray(0, rate * 3)), "replacement alarm");
const edge = new Float32Array(rate * 10 + 1); edge[edge.length - 1] = 0.5;
await save("tail-edge.wav", encode(edge), "regression: ten seconds plus one nonzero sample");
await writeFile(path.join(output, "fixture-manifest.json"), JSON.stringify({
  version: 1, preparedAt: new Date().toISOString(), thresholdsFrozenAt: "2026-11-07T23:46:02Z",
  generator: "xorshift32 seed 0x13579bdf; scripts/audio-indexing-acceptance-prepare.ts",
  tts: { zh: "Microsoft Hanhan Desktop", en: "Microsoft David Desktop", format: "16000 Hz mono PCM16", tailSpeechSeconds: tailInfo.durationSeconds, tailSpeechFrames: tailInfo.frameCount },
  files: manifest,
}, null, 2));
console.log(JSON.stringify({ generated: manifest.length, tailSpeechSeconds: tailInfo.durationSeconds }));
