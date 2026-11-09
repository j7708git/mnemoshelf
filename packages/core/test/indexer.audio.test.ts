import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  indexRoot, openDatabase, previewRoot, SqliteMetadataStore, SqliteVectorIndex,
  type Embedder, type Root, type SqliteDatabase,
  PathOutsideRootError,
} from "../src/index.js";
import * as pathGuard from "../src/roots/path-guard.js";
import { FakeEmbedder } from "../src/testing/fake-embedder.js";
import { WAV_PREPROCESSING_VERSION } from "../src/audio/wav.js";

/** 合成 PCM16 WAV：每十秒切換振幅，使尾段有可辨認的不同樣本。 */
function wav(seconds: number): Buffer {
  const frames = Math.round(seconds * 16000);
  const bytes = Buffer.alloc(44 + frames * 2);
  bytes.write("RIFF", 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write("data", 36);
  bytes.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i++) bytes.writeInt16LE((Math.floor(i / 160000) + 1) * 1000, 44 + i * 2);
  return bytes;
}

let dir: string;
let db: SqliteDatabase;
let store: SqliteMetadataStore;
let vec: SqliteVectorIndex;
let root: Root;
let embedder: FakeEmbedder;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "mnemoshelf-audio-index-"));
  db = openDatabase(":memory:");
  store = new SqliteMetadataStore(db);
  await store.migrate();
  vec = new SqliteVectorIndex(db);
  root = await store.addRoot({ path: dir, mode: "index", modalities: ["text", "audio"], include: [], exclude: [], respectGitignore: false, watch: false });
  embedder = new FakeEmbedder({ audio: true });
});
afterEach(async () => {
  vi.restoreAllMocks();
  db.close();
  await fs.rm(dir, { recursive: true, force: true });
});

describe("音訊檔案索引", () => {
  it("超過30秒完整覆蓋並保存尾段時間，未變重跑不再解碼嵌入", async () => {
    await fs.writeFile(path.join(dir, "long.wav"), wav(35.125));
    const embed = vi.spyOn(embedder, "embedAudio");
    const image = vi.spyOn(embedder, "embedImage");
    const first = await indexRoot(root, { store, vec, embedder });
    expect(first.processed).toBe(1);
    expect(first.failedFiles).toEqual([]);
    expect(embed.mock.calls.map(([audio]) => audio.samples.length)).toEqual([160000, 160000, 160000, 82000]);
    expect(embed.mock.calls[3]![0].samples[0]).toBeCloseTo(4000 / 32768);
    expect(image).not.toHaveBeenCalled();
    const chunks = await store.listChunksByPath(root.id, "long.wav");
    expect(chunks.map((chunk) => [chunk.media?.startSeconds, chunk.media?.endSeconds])).toEqual([
      [0, 10], [10, 20], [20, 30], [30, 35.125],
    ]);
    expect(chunks.every((chunk) => chunk.media?.preprocessVersion === `${WAV_PREPROCESSING_VERSION}:10s:audio-pad160-v1`)).toBe(true);
    expect(await vec.count()).toBe(4);
    expect((await indexRoot(root, { store, vec, embedder })).skippedUnchanged).toBe(1);
    expect(embed).toHaveBeenCalledTimes(4);
  });

  it("音訊來源可由向量結果定位回正確片段", async () => {
    await fs.writeFile(path.join(dir, "source.wav"), wav(21));
    const embed = vi.spyOn(embedder, "embedAudio");
    await indexRoot(root, { store, vec, embedder });
    const query = await embedder.embedAudio(embed.mock.calls[2]![0]);
    const hit = (await vec.searchVector(query, { rootIds: [root.id] }, 1))[0]!;
    const [chunk] = await store.getChunks([Number(hit.key.slice(2))]);
    expect(chunk?.relPath).toBe("source.wav");
    expect(chunk?.media).toMatchObject({ startSeconds: 20, endSeconds: 21, track: "audio" });
  });

  it("修改音訊會整檔替換且回收舊向量", async () => {
    const file = path.join(dir, "edit.wav");
    await fs.writeFile(file, wav(21));
    await indexRoot(root, { store, vec, embedder });
    const old = await store.listChunksByPath(root.id, "edit.wav");
    await fs.writeFile(file, wav(2));
    expect((await indexRoot(root, { store, vec, embedder })).processed).toBe(1);
    expect(await vec.count()).toBe(1);
    expect(await vec.existingKeys(old.map((chunk) => `c:${chunk.id}`))).toEqual(new Set());
    expect((await store.listChunksByPath(root.id, "edit.wav"))[0]?.media?.endSeconds).toBe(2);
  });

  it("缺少最後一片也會重建，不能把剩餘向量齊全當作完整", async () => {
    await fs.writeFile(path.join(dir, "missing.wav"), wav(21));
    await indexRoot(root, { store, vec, embedder });
    const chunks = await store.listChunksByPath(root.id, "missing.wav");
    const last = chunks[2]!;
    db.prepare("delete from chunks where id = ?").run(last.id);
    await vec.deleteByKeys([`c:${last.id}`]);
    expect((await indexRoot(root, { store, vec, embedder })).processed).toBe(1);
    expect(await store.listChunksByPath(root.id, "missing.wav")).toHaveLength(3);
    expect(await vec.count()).toBe(3);
  });

  it("掃描後檔案變大仍受讀取上限約束，不送進模型", async () => {
    const file = path.join(dir, "grow.wav");
    await fs.writeFile(file, wav(1));
    const list = store.listRelPaths.bind(store);
    vi.spyOn(store, "listRelPaths").mockImplementationOnce(async (id) => {
      await fs.truncate(file, 100000);
      return list(id);
    });
    const embed = vi.spyOn(embedder, "embedAudio");
    const result = await indexRoot(root, { store, vec, embedder, maxFileBytes: 64000 });
    expect(result.skippedFiles).toEqual([{ relPath: "grow.wav", reason: "audio-limit-exceeded" }]);
    expect(embed).not.toHaveBeenCalled();
  });

  it.each([128 * 1024 * 1024, NaN, Infinity])("通用檔案上限 %s 不能繞過64MiB音訊硬上限", async (maxFileBytes) => {
    const file = path.join(dir, "large.wav");
    await fs.writeFile(file, wav(1));
    await fs.truncate(file, 64 * 1024 * 1024 + 1);
    const result = await indexRoot(root, { store, vec, embedder, maxFileBytes });
    expect(result.skippedFiles).toEqual([{ relPath: "large.wav", reason: "audio-limit-exceeded" }]);
    expect(await vec.count()).toBe(0);
  });

  it("音訊混合root最多同時處理兩個檔案", async () => {
    for (let i = 0; i < 4; i++) await fs.writeFile(path.join(dir, `bounded-${i}.wav`), wav(0.1));
    const original = embedder.embedAudio.bind(embedder);
    let active = 0;
    let peak = 0;
    vi.spyOn(embedder, "embedAudio").mockImplementation(async (audio, opts) => {
      active++;
      peak = Math.max(peak, active);
      try {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return await original(audio, opts);
      } finally { active--; }
    });
    expect((await indexRoot(root, { store, vec, embedder, concurrency: 20 })).processed).toBe(4);
    expect(peak).toBe(2);
  });

  it("多個root共用讀取名額，等待取消不讀WAV且不耗掉名額", async () => {
    const roots: Root[] = [];
    for (let i = 0; i < 3; i++) {
      const folder = path.join(dir, `root-${i}`);
      await fs.mkdir(folder);
      await fs.writeFile(path.join(folder, "sample.wav"), wav(0.1));
      roots.push(await store.addRoot({ ...root, path: folder }));
    }
    const original = embedder.embedAudio.bind(embedder);
    let release!: () => void;
    let bothStarted!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { bothStarted = resolve; });
    let calls = 0;
    vi.spyOn(embedder, "embedAudio").mockImplementation(async (audio, opts) => {
      calls++;
      if (calls === 2) bothStarted();
      await held;
      return original(audio, opts);
    });
    const open = vi.spyOn(fs, "open");
    const first = indexRoot(roots[0]!, { store, vec, embedder });
    const second = indexRoot(roots[1]!, { store, vec, embedder });
    await started;
    const controller = new AbortController();
    let scanned!: () => void;
    const scanDone = new Promise<void>((resolve) => { scanned = resolve; });
    const waiting = indexRoot(roots[2]!, { store, vec, embedder, signal: controller.signal,
      onTiming: (event) => { if (event.stage === "scan") scanned(); },
    });
    const cancellation = expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    await scanDone;
    await new Promise((resolve) => setImmediate(resolve));
    expect(open.mock.calls.filter(([file]) => String(file).endsWith(".wav"))).toHaveLength(2);
    controller.abort();
    await cancellation;
    release();
    await Promise.all([first, second]);
    expect((await indexRoot(roots[2]!, { store, vec, embedder })).processed).toBe(1);
    expect(calls).toBe(3);
  });

  it("音訊讀取名額在錯誤後釋放，其他root不永久等待", async () => {
    await fs.writeFile(path.join(dir, "failure.wav"), wav(0.1));
    vi.spyOn(embedder, "embedAudio")
      .mockRejectedValueOnce(new Error("模型失敗"))
      .mockRejectedValueOnce(new Error("第二次模型失敗"));
    expect((await indexRoot(root, { store, vec, embedder })).failedFiles).toHaveLength(1);
    expect((await indexRoot(root, { store, vec, embedder })).failedFiles).toHaveLength(1);
    expect((await indexRoot(root, { store, vec, embedder })).processed).toBe(1);
    expect(await vec.count()).toBe(1);
  });

  it("掃描後音訊逃出root時清除舊索引且不讀取檔案", async () => {
    const file = path.join(dir, "guard.wav");
    await fs.writeFile(file, wav(1));
    await indexRoot(root, { store, vec, embedder });
    expect(await vec.count()).toBe(1);
    const original = pathGuard.resolveInsideRoot;
    let scanned = false;
    vi.spyOn(pathGuard, "resolveInsideRoot").mockImplementation(async (roots, requested) => {
      if (scanned && requested === file) throw new PathOutsideRootError(requested);
      return original(roots, requested);
    });
    const open = vi.spyOn(fs, "open");
    const result = await indexRoot(root, { store, vec, embedder, onTiming: (event) => { if (event.stage === "scan") scanned = true; } });
    expect(result.skippedFiles).toEqual([{ relPath: "guard.wav", reason: "unresolved-symlink" }]);
    expect(open).not.toHaveBeenCalled();
    expect(await store.listChunksByPath(root.id, "guard.wav")).toEqual([]);
    expect(await vec.count()).toBe(0);
  });

  it("同檔hash但前處理或模型身分不同仍重建；缺向量也自癒", async () => {
    await fs.writeFile(path.join(dir, "version.wav"), wav(2));
    await indexRoot(root, { store, vec, embedder });
    const old = (await store.listChunksByPath(root.id, "version.wav"))[0]!;
    const changed = await store.replaceChunks(root.id, "version.wav", [{
      seq: 0, kind: "audio", text: null, contentHash: old.contentHash,
      media: { ...old.media!, preprocessVersion: "obsolete-v0" },
    }]);
    await vec.deleteByKeys([`c:${old.id}`]);
    await vec.upsert([{ key: `c:${changed[0]!.id}`, rootId: root.id, embedderId: embedder.info.id, vec: await embedder.embedQuery("seed") }]);
    expect((await indexRoot(root, { store, vec, embedder })).processed).toBe(1);
    embedder.info.id = "audio-new-model";
    expect((await indexRoot(root, { store, vec, embedder })).processed).toBe(1);
    const current = await store.listChunksByPath(root.id, "version.wav");
    await vec.deleteByKeys(current.map((chunk) => `c:${chunk.id}`));
    expect((await indexRoot(root, { store, vec, embedder })).processed).toBe(1);
    expect(await vec.count()).toBe(1);
  });

  it("中途取消不發布部分片段，重跑補齊", async () => {
    await fs.writeFile(path.join(dir, "cancel.wav"), wav(21));
    const controller = new AbortController();
    const original = embedder.embedAudio.bind(embedder);
    const embed = vi.spyOn(embedder, "embedAudio").mockImplementation(async (audio, opts) => {
      const result = await original(audio, opts);
      controller.abort();
      return result;
    });
    await expect(indexRoot(root, { store, vec, embedder, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(embed).toHaveBeenCalledTimes(1);
    expect(await store.listChunksByPath(root.id, "cancel.wav")).toEqual([]);
    expect(await vec.count()).toBe(0);
    embed.mockRestore();
    expect((await indexRoot(root, { store, vec, embedder })).processed).toBe(1);
    expect(await vec.count()).toBe(3);
  });

  it("第二段推論失敗不寫部分資料，其他檔案照常完成", async () => {
    await fs.writeFile(path.join(dir, "fail.wav"), wav(21));
    await fs.writeFile(path.join(dir, "note.txt"), "獨立文字資料");
    const original = embedder.embedAudio.bind(embedder);
    let count = 0;
    vi.spyOn(embedder, "embedAudio").mockImplementation(async (audio, opts) => {
      if (++count === 2) throw Object.assign(new Error("模型失敗"), { code: "EMODELFAIL" });
      return original(audio, opts);
    });
    const result = await indexRoot(root, { store, vec, embedder });
    expect(result.processed).toBe(1);
    expect(result.failedFiles).toEqual([{ relPath: "fail.wav", reason: "EMODELFAIL" }]);
    expect(await store.listChunksByPath(root.id, "fail.wav")).toEqual([]);
    expect(await vec.count()).toBe(1);
  });

  it("壞WAV會清除舊索引，不支援格式在掃描列明原因", async () => {
    const file = path.join(dir, "bad.wav");
    await fs.writeFile(file, wav(1));
    await indexRoot(root, { store, vec, embedder });
    await fs.writeFile(file, "not a WAV");
    await fs.writeFile(path.join(dir, "song.mp3"), "fake mp3");
    const result = await indexRoot(root, { store, vec, embedder });
    expect(result.skippedFiles).toEqual([{ relPath: "bad.wav", reason: "invalid-audio" }]);
    expect(result.scanSkippedFiles).toEqual([{ relPath: "song.mp3", reason: "unsupported-audio-format" }]);
    expect(await vec.count()).toBe(0);
  });

  it("音訊能力與方法缺一不可，關閉模態後重跑回收索引", async () => {
    await fs.writeFile(path.join(dir, "clip.wav"), wav(1));
    embedder.info.capabilities.audio = false;
    expect((await indexRoot(root, { store, vec, embedder })).scanSkippedFiles).toContainEqual({ relPath: "clip.wav", reason: "unsupported-modality" });
    embedder.info.capabilities.audio = true;
    const noMethod: Embedder = {
      info: embedder.info, embedQuery: embedder.embedQuery.bind(embedder), embedDocument: embedder.embedDocument.bind(embedder),
      embedDocuments: embedder.embedDocuments.bind(embedder), embedImage: embedder.embedImage.bind(embedder),
      probe: embedder.probe.bind(embedder), dispose: embedder.dispose.bind(embedder),
    };
    expect((await indexRoot(root, { store, vec, embedder: noMethod })).total).toBe(0);
    await indexRoot(root, { store, vec, embedder });
    expect(await vec.count()).toBe(1);
    const disabled = { ...root, modalities: ["text" as const] };
    expect((await indexRoot(disabled, { store, vec, embedder })).removedFiles).toBe(1);
    expect(await vec.count()).toBe(0);
  });

  it("預覽只列WAV候選及資源上限，不宣稱已驗證codec", async () => {
    await fs.writeFile(path.join(dir, "audio.WAV"), wav(35));
    await fs.writeFile(path.join(dir, "audio.mp3"), "placeholder");
    const preview = await previewRoot({ path: dir, modalities: ["audio"] });
    expect(preview.byKind.audio.count).toBe(1);
    expect(preview.estimatedChunks).toBeGreaterThanOrEqual(4);
    expect(preview.skipped).toContainEqual({ relPath: "audio.mp3", reason: "unsupported-audio-format" });
    const limited = await previewRoot({ path: dir, modalities: ["audio"], maxFileBytes: 100 });
    expect(limited.skipped).toContainEqual({ relPath: "audio.WAV", reason: "too-large" });
    const unavailable = await previewRoot({ path: dir, modalities: ["audio"] }, { supportedModalities: ["text", "code", "image"] });
    expect(unavailable.byKind.audio.count).toBe(0);
  });
});
