import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { deflateSync } from "node:zlib";

export type CorpusProfile = "smoke" | "focus" | "mixed";
export interface CorpusEntry { name: string; kind: string; bytes: number; sha256: string }

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(name: string, data: Buffer): Buffer {
  const type = Buffer.from(name);
  const size = Buffer.alloc(4); size.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([type, data])));
  return Buffer.concat([size, type, data, crc]);
}

function png(red: number, green: number, blue: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(32, 0); header.writeUInt32BE(32, 4); header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc(32 * 97);
  for (let y = 0; y < 32; y += 1) {
    for (let x = 0; x < 32; x += 1) {
      const offset = y * 97 + 1 + x * 3;
      pixels[offset] = red; pixels[offset + 1] = green; pixels[offset + 2] = blue;
    }
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk("IHDR", header), pngChunk("IDAT", deflateSync(pixels)), pngChunk("IEND", Buffer.alloc(0))]);
}

function wav(): Buffer {
  const bytes = Buffer.alloc(44 + 1600);
  bytes.write("RIFF", 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(16000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36); bytes.writeUInt32LE(1600, 40);
  for (let i = 0; i < 800; i += 1) bytes.writeInt16LE(Math.round(Math.sin(i * Math.PI * 2 * 440 / 8000) * 4000), 44 + i * 2);
  return bytes;
}

function riffChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4); length.writeUInt32LE(data.length);
  return Buffer.concat([Buffer.from(type), length, data, Buffer.alloc(data.length % 2)]);
}

function avi(): Buffer {
  // 單幀、2×2、未壓縮 RGB 的合成 AVI；只用來驗證不支援模態的誠實回報。
  const main = Buffer.alloc(56); main.writeUInt32LE(1000000, 0); main.writeUInt32LE(1, 16); main.writeUInt32LE(1, 24); main.writeUInt32LE(2, 32); main.writeUInt32LE(2, 36);
  const stream = Buffer.alloc(56); stream.write("vidsDIB ", 0); stream.writeUInt32LE(1, 20); stream.writeUInt32LE(1, 24); stream.writeUInt32LE(1, 32); stream.writeInt16LE(2, 52); stream.writeInt16LE(2, 54);
  const bitmap = Buffer.alloc(40); bitmap.writeUInt32LE(40, 0); bitmap.writeInt32LE(2, 4); bitmap.writeInt32LE(2, 8); bitmap.writeUInt16LE(1, 12); bitmap.writeUInt16LE(24, 14); bitmap.writeUInt32LE(16, 20);
  const list = (name: string, entries: Buffer[]): Buffer => riffChunk("LIST", Buffer.concat([Buffer.from(name), ...entries]));
  const body = Buffer.concat([Buffer.from("AVI "), list("hdrl", [riffChunk("avih", main), list("strl", [riffChunk("strh", stream), riffChunk("strf", bitmap)])]), list("movi", [riffChunk("00db", Buffer.alloc(16, 128))])]);
  return riffChunk("RIFF", body);
}

/** 建立固定內容的合成語料；呼叫端必須提供專用暫存目錄，不讀取私人檔案。 */
export async function createCorpus(directory: string, profile: CorpusProfile): Promise<CorpusEntry[]> {
  await fs.mkdir(directory, { recursive: true });
  const files: [string, string, string | Buffer][] = [];
  const paragraph = "Synthetic orchard notes explain red apples, blue skies, and reliable indexing. 合成資料驗證跨平台索引與搜尋。\n\n";
  const longRepeats = profile === "mixed" ? 450 : 45;
  // 檔名讓大檔先被掃到，查詢壓力測試才會涵蓋長批次等待。
  files.push(["00-long.md", "text", paragraph.repeat(profile === "focus" ? 500 : longRepeats)]);
  files.push(["01-long.ts", "code", Array.from({ length: longRepeats }, (_, i) => `export const syntheticValue${i} = ${i}; // synthetic blue sky\n`).join("")]);
  for (let i = 0; i < (profile === "mixed" ? 24 : 6); i += 1) files.push([`text-${String(i).padStart(2, "0")}.md`, "text", `# Orchard ${i}\n${paragraph.repeat(2)}`]);
  for (let i = 0; i < (profile === "mixed" ? 16 : 4); i += 1) files.push([`code-${String(i).padStart(2, "0")}.ts`, "code", `export function orchard${i}(value: number): number { return value + ${i}; }\n`]);
  files.push(["duplicate-a.txt", "text", paragraph], ["duplicate-b.txt", "text", paragraph]);
  for (let i = 0; i < (profile === "mixed" ? 8 : 2); i += 1) files.push([`image-${i}.png`, "image", png(i % 2 ? 0 : 255, 0, i % 2 ? 255 : 0)]);
  files.push(["audio.wav", "audio", wav()], ["video.avi", "video", avi()], ["bad.png", "bad-image", Buffer.from("synthetic corrupt image")], ["binary.txt", "binary-content", Buffer.from([0, 1, 2, 3])], ["archive.zip", "unsupported-type", Buffer.from([80, 75, 0, 0])]);
  const manifest: CorpusEntry[] = [];
  for (const [name, kind, content] of files) {
    const bytes = Buffer.from(content);
    await fs.writeFile(path.join(directory, name), bytes);
    manifest.push({ name, kind, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  return manifest;
}
