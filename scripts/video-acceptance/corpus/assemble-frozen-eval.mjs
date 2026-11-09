#!/usr/bin/env node
// 僅在重生十檔完全符合 frozen hash 時，建立全新的品質 eval-root。
import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
const id = process.env.VIDEO_CORPUS_RUN_ID;
if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("必須設定有效 VIDEO_CORPUS_RUN_ID");
const root = process.cwd();
const dir = path.join(root, ".tmp", "video-acceptance", "corpus", id);
const labels = JSON.parse(await readFile(path.join(root, "scripts", "video-acceptance", "queries-frozen-v1.json"), "utf8"));
async function hash(file) { const h = createHash("sha256"); for await (const part of createReadStream(file)) h.update(part); return h.digest("hex"); }
const entries = [];
for (const item of labels.evaluationRoot.files) {
  if (!/^[vn]\d{2}\.mp4$/.test(item.file)) throw new Error("凍結檔名不合法");
  const source = path.join(dir, item.role === "quality" ? "quality" : "negative", item.file);
  if (await hash(source) !== item.sha256) throw new Error(`${item.file} 與凍結語料 hash 不同，不能宣稱重現`);
  entries.push({ source, ...item });
}
const target = path.join(dir, "eval-root"); await mkdir(target);
for (const entry of entries) {
  const dest = path.join(target, entry.file); await copyFile(entry.source, dest, constants.COPYFILE_EXCL);
  if (await hash(dest) !== entry.sha256) throw new Error(`${entry.file} 複本 hash 不符`);
}
await writeFile(path.join(dir, "eval-root-manifest.json"), JSON.stringify({ status: "complete", files: entries.map(({ file, sha256 }) => ({ file, sha256 })) }, null, 2), { flag: "wx" });
console.log(JSON.stringify({ status: "complete", files: entries.length }));
