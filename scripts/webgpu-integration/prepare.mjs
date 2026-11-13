/** 產生合成磁碟素材與內容指紋；不載入模型、不接觸產品資料。 */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile, readdir, lstat, copyFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { deflateSync } from "node:zlib";

const repo = process.cwd();
const base = path.join(repo, ".tmp", "webgpu-integration");
const cache = path.join(base, "cache");
const fixtures = path.join(base, "fixtures");
await mkdir(fixtures, { recursive: true });
async function hash(file) {
  const value = createHash("sha256");
  for await (const chunk of createReadStream(file)) value.update(chunk);
  return value.digest("hex");
}
async function filesIn(directory, prefix = []) {
  const files = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    assert(!item.isSymbolicLink(), "驗收資產不得使用 symlink");
    if (item.isDirectory()) files.push(...await filesIn(path.join(directory, item.name), [...prefix, item.name]));
    else if (item.isFile()) files.push([...prefix, item.name]);
  }
  return files.sort((left, right) => left.join(":").localeCompare(right.join(":")));
}
if (process.env.WEBGPU_CACHE_SOURCE) {
  const source = path.resolve(process.env.WEBGPU_CACHE_SOURCE);
  assert(source !== cache, "來源必須與副本分開");
  for (const parts of await filesIn(source)) {
    const target = path.join(cache, ...parts);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(path.join(source, ...parts), target);
    assert.equal(await hash(target), await hash(path.join(source, ...parts)), "模型副本指紋不符");
  }
}
const models = [];
for (const parts of await filesIn(cache)) {
  const file = path.join(cache, ...parts);
  models.push({ parts, bytes: (await lstat(file)).size, sha256: await hash(file) });
}
assert(models.some((item) => item.parts.at(-1) === "model_q4.onnx"), "缺少 q4 模型副本");
await writeFile(path.join(base, "verified-models.json"), JSON.stringify(models, null, 2));

const topics = [
  ["firewall", "Network firewall rules block incoming connections and permit trusted outbound requests. Inspect packet filters and audit security policy."],
  ["orchard", "Apple trees in the orchard need careful pruning, spring blossoms, compost, and regular watering for a healthy fruit harvest."],
  ["ocean", "Ocean researchers study coral reefs, tropical fish, tides, salt water, and marine ecosystems with underwater cameras."],
  ["railway", "Railway timetables list train departures, platform numbers, ticket reservations, and passenger connections between stations."],
  ["bread", "Bread dough rises with yeast and flour. Knead the dough, let it ferment, then bake a golden crust in a hot oven."],
  ["telescope", "A telescope observes distant galaxies, planets, nebulae, and stars. Astronomers measure light from the night sky."],
  ["database", "A relational database stores records in tables. Transactions preserve consistency, indexes speed up SQL queries, and backups support recovery."],
  ["hiking", "A hiking trail crosses mountains, forests, and streams. Pack a map, water bottle, boots, and rain jacket for a safe outdoor journey."],
];
for (const [topic, text] of topics) {
  await writeFile(path.join(fixtures, `${topic}.txt`), Array.from({ length: 12 }, (_, index) => `Paragraph ${index + 1}: ${text}`).join("\n\n"));
}
await writeFile(path.join(fixtures, "source.ts"), "export const sum = (left: number, right: number): number => left + right;\n");
await writeFile(path.join(fixtures, "binary.txt"), Buffer.from([0, 1, 2, 3]));
await writeFile(path.join(fixtures, ".DS_Store"), "synthetic system file skipped by scanner");

// PNG、PCM 與影片都只含程式產生的色塊／波形。
function png() {
  const crc = (data) => { let value = 0xffffffff; for (const byte of data) { value ^= byte; for (let index = 0; index < 8; index++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0); } return (value ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const tag = Buffer.from(type); const size = Buffer.alloc(4); size.writeUInt32BE(data.length); const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(Buffer.concat([tag, data]))); return Buffer.concat([size, tag, data, sum]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(32, 0); header.writeUInt32BE(32, 4); header[8] = 8; header[9] = 2;
  const pixels = Buffer.concat(Array.from({ length: 32 }, () => Buffer.from([0, ...Array.from({ length: 32 }, () => [220, 30, 20]).flat()])));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]);
}
await writeFile(path.join(fixtures, "red.png"), png());
const wav = Buffer.alloc(44 + 16000 * 2);
wav.write("RIFF"); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
wav.write("data", 36); wav.writeUInt32LE(wav.length - 44, 40);
for (let index = 0; index < 16000; index++) wav.writeInt16LE(Math.round(Math.sin(index * 440 * 2 * Math.PI / 16000) * 5000), 44 + index * 2);
await writeFile(path.join(base, "tone.wav"), wav);
async function resolveExecutable(name, setting) {
  if (setting) { assert(path.isAbsolute(setting), "decoder 必須是絕對路徑"); return setting; }
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    const file = path.join(directory, process.platform === "win32" ? `${name}.exe` : name);
    try { if ((await lstat(file)).isFile() || (await lstat(file)).isSymbolicLink()) return file; } catch { /* 繼續找 PATH 的下一項。 */ }
  }
  return null;
}
const ffmpeg = await resolveExecutable("ffmpeg", process.env.MNEMOSHELF_FFMPEG_PATH);
const ffprobe = await resolveExecutable("ffprobe", process.env.MNEMOSHELF_FFPROBE_PATH);
const ffmpegVersion = ffmpeg ? spawnSync(ffmpeg, ["-version"], { encoding: "utf8" }) : { status: null };
const ffprobeVersion = ffprobe ? spawnSync(ffprobe, ["-version"], { encoding: "utf8" }) : { status: null };
const decoder = { available: ffmpegVersion.status === 0 && ffprobeVersion.status === 0, ffmpeg: ffmpegVersion.stdout?.split("\n")[0] ?? null, ffprobe: ffprobeVersion.stdout?.split("\n")[0] ?? null };
// 絕對執行路徑只放忽略的執行設定，不寫進可分享的 manifest。
await writeFile(path.join(base, "decoder-local.json"), JSON.stringify({ ffmpegPath: ffmpeg, ffprobePath: ffprobe }));
if (decoder.available) {
  const generated = spawnSync(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=red:s=96x64:r=4:d=5", "-an", "-c:v", "libx264", "-threads", "1", "-pix_fmt", "yuv420p", "-movflags", "+faststart", path.join(fixtures, "red.mp4")], { encoding: "utf8" });
  assert.equal(generated.status, 0, "合成影片產生失敗");
}
const files = [];
for (const name of await readdir(fixtures)) files.push({ name, sha256: await hash(path.join(fixtures, name)) });
await writeFile(path.join(base, "fixtures.json"), JSON.stringify({ version: 1, files, topics: topics.map(([name, query]) => ({ target: `${name}.txt`, query })), decoder }, null, 2));
console.log(JSON.stringify({ prepared: true, modelFiles: models.length, files: files.length, decoder }));
