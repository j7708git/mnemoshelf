/** 非零來源起點且影音起點不同：共同播放時間原點、讓出續播及增量的真解碼回歸。 */
import { createHash } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { indexRoot, openDatabase, SqliteMetadataStore, SqliteVectorIndex } from "../../src/index.js";
import { FfmpegMediaDecoder } from "../../src/media/index.js";
import { FakeEmbedder } from "../../src/testing/fake-embedder.js";
import type { AudioSegment, VisualSegment } from "../../src/media/index.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const ffmpegPath = process.env.MNEMOSHELF_FFMPEG_PATH ?? "";
const ffprobePath = process.env.MNEMOSHELF_FFPROBE_PATH ?? "";
const enabled = process.env.MNEMOSHELF_VIDEO_NONZERO === "1";
const file = path.join(repo, ".tmp", "video-a", "corpus", "security", "sec07-nonzero-pts.mp4");
if (enabled && ![file, ffmpegPath, ffprobePath].every((value) => value !== "" && existsSync(value))) {
  throw new Error("非零 PTS 回歸需指定真 decoder 並先生成 A2 sec07 合成素材。");
}
const decoder = () => new FfmpegMediaDecoder({ ffmpegPath, ffprobePath });
function signature(segments: VisualSegment[]) {
  return segments.map((segment) => ({
    start: segment.startSeconds, end: segment.endSeconds,
    frames: segment.frames.map((frame) => ({ time: frame.timestampSeconds, hash: createHash("sha256").update(frame.pixels).digest("hex") })),
  }));
}

describe.skipIf(!enabled)("非零 PTS 的影音共同原點", () => {
  it("A2 sec07：視覺保留 21.333ms 偏移，音軌與容器共用原點，空尾格有實際覆蓋證明", async () => {
    expect(createHash("sha256").update(await fs.readFile(file)).digest("hex")).toBe("409a89dc509514fe83a0eeaecfa1a61c0b9cdff1884a25111d7c9905b82fb87f");
    const instance = decoder();
    const probe = await instance.probe({ path: file });
    expect(probe.sourceStartSeconds).toBeCloseTo(9.978667, 6);
    expect(probe.video!.startTimeSeconds! - probe.sourceStartSeconds).toBeCloseTo(0.021333, 6);
    expect(probe.selectedAudio!.startTimeSeconds! - probe.sourceStartSeconds).toBe(0);
    const visual: VisualSegment[] = [];
    for await (const segment of instance.decodeVisualSegments({ path: file }, { probe })) visual.push(segment);
    expect(visual.map((segment) => [segment.startSeconds, segment.endSeconds])).toEqual([[0, 4], [4, 8], [8, 12]]);
    for (const [index, segment] of visual.entries()) {
      // 來源 PTS 為 12、16、20，必須共同減去 format start；不能各軌自行歸零。
      expect(probe.visualTimeline![index]!.frameTimeSeconds).toBeCloseTo(12 + index * 4 - probe.sourceStartSeconds, 6);
      // seek 原點需量化至此素材的 video time_base=1/12288；只允許一個 tick，遠小於 21.333ms 原點差。
      expect(Math.abs(segment.frames[0]!.timestampSeconds - (12 + index * 4 - probe.sourceStartSeconds))).toBeLessThan(1 / 12288);
    }
    const audio: AudioSegment[] = [];
    for await (const segment of instance.decodeAudioSegments({ path: file }, { probe })) audio.push(segment);
    expect(audio).toHaveLength(2);
    expect(audio[0]!.startSeconds).toBe(0);
    expect(audio[0]!.endSeconds).toBe(10);
    expect(audio[1]!.startSeconds).toBe(10);
    // PCM 以 16 kHz 整數樣本表示，終點取最近樣本（誤差至多半樣本）。
    expect(audio[1]!.endSeconds).toBe(Math.round(12.021333 * 16000) / 16000);
    expect(instance.budgetStats()).toMatchObject({ active: 0, waiting: 0 });
  }, 60_000);

  it("段界讓出以共同原點 seek，恢復後 PTS／像素一致；取消釋放後能重用", async () => {
    const instance = decoder();
    const probe = await instance.probe({ path: file });
    const baseline: VisualSegment[] = [];
    for await (const segment of instance.decodeVisualSegments({ path: file }, { probe })) baseline.push(segment);
    const left = instance.decodeVisualSegments({ path: file }, { probe });
    const right = instance.decodeVisualSegments({ path: file }, { probe });
    try {
      const first = await left.next();
      expect(first.done).toBe(false);
      const competing = await right.next();
      expect(competing.done).toBe(false);
      await right.return(undefined);
      const resumed = [first.value!];
      for await (const segment of left) resumed.push(segment);
      expect(signature(resumed)).toEqual(signature(baseline));
    } finally { await left.return(undefined); await right.return(undefined); }
    const controller = new AbortController();
    const cancelled = instance.decodeVisualSegments({ path: file }, { probe, signal: controller.signal });
    await cancelled.next();
    controller.abort();
    await cancelled.return(undefined);
    expect(instance.budgetStats()).toMatchObject({ active: 0, waiting: 0 });
    const retried: VisualSegment[] = [];
    for await (const segment of instance.decodeVisualSegments({ path: file }, { probe })) retried.push(segment);
    expect(signature(retried)).toEqual(signature(baseline));
  }, 60_000);

  it("真索引保留影音定位、未變零嵌入、舊 v3 強制重建", async () => {
    const work = await fs.mkdtemp(path.join(repo, ".tmp", "nonzero-origin-"));
    const db = openDatabase(":memory:");
    try {
      await fs.copyFile(file, path.join(work, "clip.mp4"));
      const store = new SqliteMetadataStore(db); await store.migrate();
      const vec = new SqliteVectorIndex(db);
      const root = await store.addRoot({ path: work, mode: "index", modalities: ["video", "audio"], include: [], exclude: [], respectGitignore: false, watch: false });
      const instance = decoder();
      const embedder = new FakeEmbedder({ video: true, audio: true });
      const visual = vi.spyOn(embedder, "embedVideo");
      const audio = vi.spyOn(embedder, "embedAudio");
      const deps = { store, vec, decoder: instance, embedder };
      expect(await indexRoot(root, deps)).toMatchObject({ processed: 1, failedFiles: [], skippedFiles: [] });
      expect(visual).toHaveBeenCalledTimes(3); expect(audio).toHaveBeenCalledTimes(2);
      const chunks = await store.listChunksByPath(root.id, "clip.mp4");
      expect(chunks.filter((chunk) => chunk.media!.track === "video").map((chunk) => chunk.media!.frameTimesSeconds![0])).toEqual(expect.arrayContaining([expect.closeTo(2.021322, 6), expect.closeTo(6.021322, 6), expect.closeTo(10.021322, 6)]));
      expect(chunks.filter((chunk) => chunk.media!.track === "video-audio").map((chunk) => chunk.media!.startSeconds)).toEqual([0, 10]);
      expect(await indexRoot(root, deps)).toMatchObject({ skippedUnchanged: 1 });
      expect(visual).toHaveBeenCalledTimes(3); expect(audio).toHaveBeenCalledTimes(2);
      db.prepare("update chunks set media_json=json_set(media_json, '$.preprocessVersion', replace(replace(json_extract(media_json, '$.preprocessVersion'), 'rgb24-v4', 'rgb24-v3'), 'srcpts-v3', 'srcpts-v2')) where kind='video'").run();
      expect(await indexRoot(root, deps)).toMatchObject({ processed: 1, failedFiles: [], skippedFiles: [] });
      expect(visual).toHaveBeenCalledTimes(6); expect(audio).toHaveBeenCalledTimes(4);
      expect((await store.listChunksByPath(root.id, "clip.mp4")).filter((chunk) => chunk.kind === "video").every((chunk) => chunk.media!.preprocessVersion.includes("rgb24-v4"))).toBe(true);
    } finally { db.close(); await fs.rm(work, { recursive: true, force: true }); }
  }, 60_000);
});
