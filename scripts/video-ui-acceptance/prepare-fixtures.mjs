#!/usr/bin/env node
/** 以已凍結的合成影片與 A2 TTS 建立 D2 混合 root；不覆寫任何來源或既有 run。 */
import { createHash, randomBytes } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const runId = process.env.VIDEO_UI_FIXTURE_ID ?? `${Date.now()}-${randomBytes(4).toString("hex")}`;
if (!/^[a-zA-Z0-9_-]+$/.test(runId)) throw new Error("VIDEO_UI_FIXTURE_ID 只接受英數、底線、連字號");
const evalRoot = process.env.VIDEO_UI_EVAL_ROOT ?? path.join(repo, ".tmp", "video-a", "corpus", "eval-root");
const ttsFile = process.env.VIDEO_UI_TTS_FILE ?? path.join(repo, ".tmp", "video-a", "corpus", "tts", "t01.wav");
const labelFile = path.join(repo, "scripts", "video-acceptance", "queries-frozen-v1.json");
const labelsHash = "846c102b582045a264388baed8ef458d5e7b1bb9278a368c73d2a564d2bece56";
const ttsHash = "af0ef951034398e87c82f844288afa93a846d2d14f93e49eef6249e2561d6385";
const expectedPixels = "5101c2b167cb26dac73b59bb7e10336eb4622e51f178d9b9cef84536a1ac9d51";
const hashBuffer = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function hashFile(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
const labelsBytes = await readFile(labelFile);
if (hashBuffer(labelsBytes) !== labelsHash) throw new Error("凍結標籤 hash 不符");
const labels = JSON.parse(labelsBytes.toString("utf8"));
const names = ["v01.mp4", "v02.mp4", "v03.mp4", "n02.mp4"];
const sources = [];
for (const name of names) {
  const matches = labels.evaluationRoot.files.filter((item) => item.file === name);
  if (matches.length !== 1 || !/^[a-f0-9]{64}$/.test(matches[0].sha256)) throw new Error(`凍結標籤缺少唯一 ${name}`);
  const source = path.join(evalRoot, name);
  if (await hashFile(source) !== matches[0].sha256) throw new Error(`${name} 不符凍結 hash`);
  sources.push({ name, source, sha256: matches[0].sha256 });
}
if (await hashFile(ttsFile) !== ttsHash) throw new Error("A2 t01 WAV 與原始合成聲音 hash 不符；不可換成不同聲音冒充原素材");

// 依現存 D2 圖像的 RGB 像素逆向確認：漸層及中心圓，並非 MP4 截幀；無取樣時間。
const width = 320, height = 200;
const pixels = Buffer.alloc(width * height * 3);
const scanlines = Buffer.alloc((width * 3 + 1) * height);
for (let y = 0; y < height; y += 1) {
  for (let x = 0; x < width; x += 1) {
    const color = (x - 160) ** 2 + (y - 100) ** 2 < 70 ** 2
      ? [240, 200, 40] : [Math.round(15 + y * 40 / height), Math.round(20 + x * 32 / width), 90];
    const offset = (y * width + x) * 3;
    const rowOffset = y * (width * 3 + 1) + 1 + x * 3;
    for (let channel = 0; channel < 3; channel += 1) pixels[offset + channel] = scanlines[rowOffset + channel] = color[channel];
  }
}
if (hashBuffer(pixels) !== expectedPixels) throw new Error("合成圖片 RGB hash 不符 D2 像素");
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const value of bytes) {
    crc ^= value;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const name = Buffer.from(type, "ascii");
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length, 0); name.copy(result, 4); data.copy(result, 8);
  result.writeUInt32BE(crc32(Buffer.concat([name, data])), data.length + 8);
  return result;
}
const header = Buffer.alloc(13);
header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk("IHDR", header), pngChunk("IDAT", deflateSync(scanlines)), pngChunk("IEND", Buffer.alloc(0))]);
const notes = Buffer.from("Mnemoshelf 影片 D2 驗收用文字檔。\r\n\r\n這段文字包含關鍵字：星空、番茄炒蛋、列車月台、黃色圓形。\r\n用途是驗證混合目錄中的文字模態索引與搜尋，不是私人資料。", "utf8");
if (hashBuffer(notes) !== "093b45b38cc6ab98e4accb7ec35defb2d000362d41849f05539eb84126015351") throw new Error("合成文字 hash 不符 D2");

const parent = path.join(repo, ".tmp", "video-ui-acceptance", "fixtures");
const run = path.join(parent, runId);
const root = path.join(run, "root");
await mkdir(parent, { recursive: true });
await mkdir(run); // 不得重用或覆寫既有 run。
await mkdir(root);
await mkdir(path.join(root, "audio"));
await mkdir(path.join(root, "images"));
for (const item of sources) {
  const destination = path.join(root, item.name);
  await copyFile(item.source, destination, constants.COPYFILE_EXCL);
  if (await hashFile(destination) !== item.sha256) throw new Error(`${item.name} 複製後 hash 不符`);
}
const copiedTts = path.join(root, "audio", "t01.wav");
await copyFile(ttsFile, copiedTts, constants.COPYFILE_EXCL);
if (await hashFile(copiedTts) !== ttsHash) throw new Error("t01 複製後 hash 不符");
await writeFile(path.join(root, "images", "starry-circle.png"), png, { flag: "wx" });
await writeFile(path.join(root, "notes.txt"), notes, { flag: "wx" });
const manifest = {
  status: "complete", runId,
  frozenLabelsSha256: labelsHash,
  videos: sources.map(({ name, sha256 }) => ({ name, sha256 })),
  audio: { file: "t01.wav", sha256: ttsHash, source: "A2 TTS: Microsoft Hanhan Desktop, 16 kHz PCM16 mono" },
  image: { file: "starry-circle.png", pixelsSha256: expectedPixels, pngSha256: hashBuffer(png), width, height, provenance: "D2 合成圖的像素等價重建，非影片截幀" },
  notes: { file: "notes.txt", sha256: hashBuffer(notes) },
};
await writeFile(path.join(run, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
console.log(JSON.stringify({ status: "complete", runId, root: path.relative(repo, root), manifest: path.relative(repo, path.join(run, "manifest.json")) }));
