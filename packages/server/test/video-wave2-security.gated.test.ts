/** 波次二：REST、真 indexer／FFmpeg／SQLite 的合成安全案例。顯式啟用時缺素材或 binary 必須失敗。 */
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import http from "node:http";
import { createHash } from "node:crypto";
import { FfmpegMediaDecoder } from "@mnemoshelf/core";
import { DecodeProcessBudget } from "../../core/src/media/decode-budget.js";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import type { EmbedDocumentsOptions, IndexRootResult, VideoInput } from "@mnemoshelf/core";
import { FakeEmbedder } from "@mnemoshelf/core/testing";
import { api, makeTempDir, removeTempDir, startTestServer, type TestServer } from "./helpers.js";

const enabled = process.env.MNEMOSHELF_VIDEO_SECURITY === "1";
const ffmpeg = process.env.MNEMOSHELF_FFMPEG_PATH ?? "";
const ffprobe = process.env.MNEMOSHELF_FFPROBE_PATH ?? "";
const corpus = process.env.MNEMOSHELF_VIDEO_SECURITY_CORPUS ?? path.resolve("../../.tmp/video-a/corpus/security");
let server: TestServer | undefined;
const dirs: string[] = [];

class GateEmbedder extends FakeEmbedder {
  readonly runtimeStatus = { requestedDevice: "cpu", device: "cpu", loaded: true, fallbackReason: null, batchSize: 1, serializedInference: true, dmlDeviceId: null };
  private releaseGate!: () => void;
  private enteredGate!: () => void;
  readonly entered = new Promise<void>((resolve) => { this.enteredGate = resolve; });
  private readonly gate = new Promise<void>((resolve) => { this.releaseGate = resolve; });
  release(): void { this.releaseGate(); }
  override async embedVideo(video: VideoInput, opts?: EmbedDocumentsOptions): Promise<Float32Array> {
    this.enteredGate();
    await this.gate;
    return super.embedVideo(video, opts);
  }
}

async function setup(fixture: string, embedder = new FakeEmbedder({ video: true }), modalities = ["video"]): Promise<{ root: number; dir: string }> {
  for (const file of [ffmpeg, ffprobe, path.join(corpus, fixture)]) {
    if (!file || !existsSync(file)) throw new Error("安全驗收缺少指定 binary 或合成素材");
  }
  const dir = await makeTempDir("wave2-security-root-");
  dirs.push(dir);
  await fs.copyFile(path.join(corpus, fixture), path.join(dir, "clip.mp4"));
  server = await startTestServer({ embedder, env: { MNEMOSHELF_FFMPEG_PATH: ffmpeg, MNEMOSHELF_FFPROBE_PATH: ffprobe } });
  const response = await api(server.instance, "POST", "/roots", { body: { path: dir, modalities } });
  expect(response.status).toBe(201);
  return { root: (response.body as { id: number }).id, dir };
}

async function snapshotDirs(): Promise<Set<string>> {
  return new Set((await fs.readdir(os.tmpdir())).filter((name) => name.startsWith("mnemoshelf-video-")));
}

async function assertNoPublished(root: number): Promise<void> {
  expect(await server!.instance.store.listChunksByPath(root, "clip.mp4")).toEqual([]);
  const response = await api(server!.instance, "POST", "/search", { body: { query: "test", mode: "vector", rootIds: [root], k: 20 } });
  expect(response.status).toBe(200);
  expect((response.body as { hits: unknown[] }).hits).toEqual([]);
}

afterEach(async () => {
  await server?.close();
  server = undefined;
  while (dirs.length) await removeTempDir(dirs.pop()!);
});

(enabled ? describe : describe.skip)("波次二安全端到端（真 FFmpeg）", () => {
  it.each([
    ["sec10-text-as-mp4.mp4", "invalid-video"],
    ["sec12-webm-as-mp4.mp4", "invalid-video"],
    ["sec13-zero-bytes.mp4", "invalid-video"],
    ["sec14-truncated-no-moov.mp4", "invalid-video"],
    ["sec15-truncated-mdat.mp4", "unsupported-video-timeline"],
    ["sec16-corrupt-moov.mp4", "invalid-video"],
    ["sec19-overres-1440p.mp4", "video-resolution-exceeded"],
  ])("%s 具名跳過、不發布片段，且回收快照", async (fixture, reason) => {
    const before = await snapshotDirs();
    const { root } = await setup(fixture);
    const response = await api(server!.instance, "POST", `/roots/${root}/index`);
    expect(response.status).toBe(200);
    const result = response.body as IndexRootResult;
    expect(result.processed).toBe(0);
    expect(result.skippedFiles).toContainEqual({ relPath: "clip.mp4", reason });
    await assertNoPublished(root);
    expect([...await snapshotDirs()].filter((entry) => !before.has(entry))).toEqual([]);
  }, 120_000);

  it("第一段完成解碼後取消，不發布部分片段並回收快照，可重新索引", async () => {
    const before = await snapshotDirs();
    const embedder = new GateEmbedder({ video: true });
    const { root } = await setup("sec01-noaudio.mp4", embedder);
    const pending = api(server!.instance, "POST", `/roots/${root}/index`);
    try {
      await Promise.race([embedder.entered, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("未進入影片嵌入")), 60_000))]);
      const cancel = await api(server!.instance, "POST", `/roots/${root}/index/cancel`);
      expect(cancel.body).toMatchObject({ cancelled: true });
    } finally { embedder.release(); }
    expect((await pending).body).toMatchObject({ cancelled: true });
    await assertNoPublished(root);
    expect([...await snapshotDirs()].filter((entry) => !before.has(entry))).toEqual([]);
    const again = await api(server!.instance, "POST", `/roots/${root}/index`);
    expect((again.body as IndexRootResult).processed).toBe(1);
    expect((await server!.instance.store.listChunksByPath(root, "clip.mp4")).length).toBeGreaterThan(0);
  }, 120_000);
  it("外部 dref 不發送 HTTP 請求，內嵌資料可正常索引", async () => {
    let requests = 0;
    const listener = http.createServer((_req, res) => { requests += 1; res.end("external-canary"); });
    await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
    try {
      const { root, dir } = await setup("sec09-external-dref.mp4");
      const address = listener.address();
      if (address === null || typeof address === "string") throw new Error("測試 listener 未啟動");
      const oldUrl = "https://example.invalid/a2-external-ref.mdat";
      const newUrl = `http://127.0.0.1:${address.port}/`;
      expect(newUrl.length).toBeLessThanOrEqual(oldUrl.length);
      expect(await (await fetch(newUrl)).text()).toBe("external-canary");
      expect(requests).toBe(1);
      requests = 0;
      const bytes = await fs.readFile(path.join(dir, "clip.mp4"));
      let offset = 0;
      let replacements = 0;
      while ((offset = bytes.indexOf(oldUrl, offset)) >= 0) {
        bytes.fill(0, offset, offset + oldUrl.length);
        bytes.write(newUrl, offset);
        offset += oldUrl.length;
        replacements += 1;
      }
      expect(replacements).toBeGreaterThan(0);
      await fs.writeFile(path.join(dir, "clip.mp4"), bytes);
      const indexed = await api(server!.instance, "POST", `/roots/${root}/index`);
      expect((indexed.body as IndexRootResult).processed).toBe(1);
      expect((await server!.instance.store.listChunksByPath(root, "clip.mp4")).length).toBeGreaterThan(0);
      expect(requests).toBe(0);
    } finally { await new Promise<void>((resolve, reject) => listener.close((err) => err ? reject(err) : resolve())); }
  }, 120_000);

  it("解碼後來源被替換：索引只記錄原快照 hash，重跑改用新來源", async () => {
    const embedder = new GateEmbedder({ video: true });
    const { root, dir } = await setup("sec01-noaudio.mp4", embedder);
    const file = path.join(dir, "clip.mp4");
    const originalHash = createHash("sha256").update(await fs.readFile(file)).digest("hex");
    const pending = api(server!.instance, "POST", `/roots/${root}/index`);
    try {
      await Promise.race([embedder.entered, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("未進入影片嵌入")), 60_000))]);
      await fs.copyFile(path.join(corpus, "sec04-moov-end.mp4"), file);
    } finally { embedder.release(); }
    expect((await pending).status).toBe(200);
    const chunks = await server!.instance.store.listChunksByPath(root, "clip.mp4");
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every((chunk) => chunk.contentHash === originalHash)).toBe(true);
    const replacementHash = createHash("sha256").update(await fs.readFile(file)).digest("hex");
    expect(replacementHash).not.toBe(originalHash);
    const rerun = await api(server!.instance, "POST", `/roots/${root}/index`);
    expect((rerun.body as IndexRootResult).processed).toBe(1);
    expect((await server!.instance.store.listChunksByPath(root, "clip.mp4")).every((chunk) => chunk.contentHash === replacementHash)).toBe(true);
  }, 120_000);

  it("root 內 junction 指向 root 外時不索引外部影片", async () => {
    const { root, dir } = await setup("sec01-noaudio.mp4");
    await fs.unlink(path.join(dir, "clip.mp4"));
    const outside = await makeTempDir("wave2-security-outside-");
    dirs.push(outside);
    await fs.copyFile(path.join(corpus, "sec01-noaudio.mp4"), path.join(outside, "clip.mp4"));
    const link = path.join(dir, "escape");
    await fs.symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
    try {
      const indexed = await api(server!.instance, "POST", `/roots/${root}/index`);
      expect((indexed.body as IndexRootResult).processed).toBe(0);
      expect(await server!.instance.store.listChunksByPath(root, path.posix.join("escape", "clip.mp4"))).toEqual([]);
      await assertNoPublished(root);
    } finally { await fs.unlink(link); }
  }, 120_000);

  it("真 FFmpeg 持有程序名額時取消，close 後名額歸零且無片段", async () => {
    const before = await snapshotDirs();
    const { root, dir } = await setup("sec01-noaudio.mp4");
    await server!.close();
    server = undefined;
    const budget = new DecodeProcessBudget(1);
    const decoder = new FfmpegMediaDecoder({ ffmpegPath: ffmpeg, ffprobePath: ffprobe, budget });
    server = await startTestServer({ embedder: new FakeEmbedder({ video: true }), decoder });
    const created = await api(server.instance, "POST", "/roots", { body: { path: dir, modalities: ["video"] } });
    const newRoot = (created.body as { id: number }).id;
    expect(root).toBeGreaterThan(0);
    const originalSpawn = childProcess.spawn;
    let childPid: number | undefined;
    let closed = false;
    const started = new Promise<void>((resolve) => {
      childProcess.spawn = ((...args: unknown[]) => {
        const spawned = Reflect.apply(originalSpawn, childProcess, args) as childProcess.ChildProcess;
        const commandArgs = args[1];
        if (args[0] === ffmpeg && Array.isArray(commandArgs) && commandArgs.includes("-i")) {
          childPid = spawned.pid;
          spawned.once("close", () => { closed = true; });
          resolve();
        }
        return spawned;
      }) as typeof childProcess.spawn;
      syncBuiltinESMExports();
    });
    const pending = api(server.instance, "POST", `/roots/${newRoot}/index`);
    let observed = false;
    try {
      await Promise.race([started, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("未觀察到 FFmpeg spawn")), 10_000))]);
      observed = budget.stats().active === 1 && childPid !== undefined && !closed;
      expect(observed).toBe(true);
      expect(() => process.kill(childPid!, 0)).not.toThrow();
      expect((await api(server.instance, "POST", `/roots/${newRoot}/index/cancel`)).body).toMatchObject({ cancelled: true });
    } finally {
      childProcess.spawn = originalSpawn;
      syncBuiltinESMExports();
      if (!observed) await api(server.instance, "POST", `/roots/${newRoot}/index/cancel`);
    }
    expect((await pending).body).toMatchObject({ cancelled: true });
    expect(closed).toBe(true);
    expect(() => process.kill(childPid!, 0)).toThrow();
    expect(budget.stats()).toMatchObject({ active: 0, waiting: 0 });
    await assertNoPublished(newRoot);
    expect([...await snapshotDirs()].filter((entry) => !before.has(entry))).toEqual([]);
  }, 120_000);

  it("掃描完成後父目錄換成 root 外 junction，後續影片被拒絕", async () => {
    const embedder = new GateEmbedder({ video: true });
    const { root, dir } = await setup("sec01-noaudio.mp4", embedder);
    await fs.rename(path.join(dir, "clip.mp4"), path.join(dir, "a.mp4"));
    const sub = path.join(dir, "z-sub");
    const outside = await makeTempDir("wave2-security-swap-");
    dirs.push(outside);
    await fs.mkdir(sub);
    await fs.copyFile(path.join(corpus, "sec01-noaudio.mp4"), path.join(sub, "clip.mp4"));
    await fs.copyFile(path.join(corpus, "sec04-moov-end.mp4"), path.join(outside, "clip.mp4"));
    const pending = api(server!.instance, "POST", `/roots/${root}/index`);
    let linked = false;
    try {
      await Promise.race([embedder.entered, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("未進入影片嵌入")), 60_000))]);
      await fs.rm(sub, { recursive: true });
      await fs.symlink(outside, sub, process.platform === "win32" ? "junction" : "dir");
      linked = true;
    } finally { embedder.release(); }
    try {
      const result = (await pending).body as IndexRootResult;
      expect(result.processed).toBe(1);
      expect(result.skippedFiles.some((entry) => entry.relPath === path.posix.join("z-sub", "clip.mp4"))).toBe(true);
      expect(await server!.instance.store.listChunksByPath(root, path.posix.join("z-sub", "clip.mp4"))).toEqual([]);
    } finally { if (linked) await fs.unlink(sub); }
  }, 120_000);

  it.each(["sec01-noaudio.mp4", "sec04-moov-end.mp4", "sec05-vfr.mp4", "sec06-rotate90.mp4", "sec07-nonzero-pts.mp4", "sec08-editlist.mp4", "sec20-mixed-audio.mp4"])("A2 正向 %s 完整索引", async (fixture) => {
    const { root } = await setup(fixture, new FakeEmbedder({ video: true, audio: true }), ["video", "audio"]);
    const result = (await api(server!.instance, "POST", `/roots/${root}/index`)).body as IndexRootResult;
    expect(result).toMatchObject({ processed: 1, skippedFiles: [], failedFiles: [] });
    expect((await server!.instance.store.listChunksByPath(root, "clip.mp4")).length).toBeGreaterThan(0);
  }, 120_000);

  it.each(["sec02-ac3.mp4", "sec03-dts.mp4"])("%s 要求音訊時整檔拒絕且不發布視覺片段", async (fixture) => {
    const { root } = await setup(fixture, new FakeEmbedder({ video: true, audio: true }), ["video", "audio"]);
    const result = (await api(server!.instance, "POST", `/roots/${root}/index`)).body as IndexRootResult;
    expect(result.processed).toBe(0);
    expect(result.skippedFiles).toContainEqual({ relPath: "clip.mp4", reason: "unsupported-video-audio-track" });
    await assertNoPublished(root);
  }, 120_000);

  it("A2 601 秒影片在 probe 限制處拒絕", async () => {
    const { root } = await setup("sec18-duration-601s.mp4");
    const result = (await api(server!.instance, "POST", `/roots/${root}/index`)).body as IndexRootResult;
    expect(result.processed).toBe(0);
    expect(result.skippedFiles).toContainEqual({ relPath: "clip.mp4", reason: "video-duration-exceeded" });
    await assertNoPublished(root);
  }, 120_000);

  it("A2 超大檔案掃描時拒絕，不建立快照或片段", async () => {
    const before = await snapshotDirs();
    const { root, dir } = await setup("sec01-noaudio.mp4");
    const file = await fs.open(path.join(dir, "clip.mp4"), "w");
    try { await file.truncate(513 * 1024 * 1024 + 1); } finally { await file.close(); }
    const result = (await api(server!.instance, "POST", `/roots/${root}/index`)).body as IndexRootResult;
    expect(result.processed).toBe(0);
    expect(result.scanSkippedFiles).toContainEqual({ relPath: "clip.mp4", reason: "video-too-large" });
    await assertNoPublished(root);
    expect([...await snapshotDirs()].filter((entry) => !before.has(entry))).toEqual([]);
  }, 120_000);

  it("外部檔案 concat 偽裝 MP4 被拒絕，root 外目標不發布", async () => {
    const { root, dir } = await setup("sec01-noaudio.mp4");
    const outside = await makeTempDir("wave2-security-concat-");
    dirs.push(outside);
    const target = path.join(outside, "outside.mp4");
    await fs.copyFile(path.join(corpus, "sec01-noaudio.mp4"), target);
    const safeTarget = target.replaceAll("'", "'\\''");
    await fs.writeFile(path.join(dir, "clip.mp4"), `ffconcat version 1.0\nfile '${safeTarget}'\n`);
    const result = (await api(server!.instance, "POST", `/roots/${root}/index`)).body as IndexRootResult;
    expect(result.processed).toBe(0);
    expect(result.skippedFiles).toContainEqual({ relPath: "clip.mp4", reason: "invalid-video" });
    await assertNoPublished(root);
  }, 120_000);

  it("A2 MP4 偽裝成文字時不產生影片片段", async () => {
    const { root, dir } = await setup("sec11-mp4-as-txt.txt");
    await fs.rename(path.join(dir, "clip.mp4"), path.join(dir, "clip.txt"));
    const result = (await api(server!.instance, "POST", `/roots/${root}/index`)).body as IndexRootResult;
    expect(result.processed).toBe(0);
    expect(await server!.instance.store.listChunksByPath(root, "clip.txt")).toEqual([]);
    await assertNoPublished(root);
  }, 120_000);

});
