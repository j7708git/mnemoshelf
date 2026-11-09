/**
 * 波次一 D2／D3／D4／D6 回歸（fake decoder，不需 ffmpeg binary）。
 *
 * 契約：project-notes/projects/mnemoshelf/research/2026-11-08-video-wave1-fix-contract.md。
 * - D2：音軌 stream 時間線短的檔案，未變重跑不得重新推論。
 * - D3：預期 chunk 佈局與 decoder 實際輸出一致。
 * - D4：影片名額以每次 next() 為單位；取消／錯誤要 iterator.return()。
 * - D6：快照先開 handle、再由 verifier 重走 root 邊界並比對身分。
 */
import { createHash } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promises as fsp } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  indexRoot, openDatabase, PathOutsideRootError, resolveInsideRoot, SqliteMetadataStore, SqliteVectorIndex,
  type Modality, type Root, type SqliteDatabase,
} from "../src/index.js";
import {
  MediaDecoderError,
  type AudioSegment,
  type DecoderAvailability,
  type MediaDecoder,
  type MediaSource,
  type VideoProbe,
  type VisualSegment,
} from "../src/media/index.js";
import { assertSameFileIdentity, sameVerifiedPath, snapshotVideoSource } from "../src/indexer/video.js";
import { FakeEmbedder } from "../src/testing/fake-embedder.js";

const WORKSPACE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const SEGMENT_SECONDS = 4;
const AUDIO_SEGMENT_SECONDS = 10;

function visualSegments(durationSeconds: number, level = 1): VisualSegment[] {
  const segments: VisualSegment[] = [];
  for (let start = 0; start < durationSeconds; start += SEGMENT_SECONDS) {
    const endSeconds = Math.min(durationSeconds, start + SEGMENT_SECONDS);
    const timestampSeconds = endSeconds - start < SEGMENT_SECONDS ? endSeconds - 0.04 : start + 2;
    segments.push({
      startSeconds: start,
      endSeconds,
      frames: [{ pixels: new Uint8Array(16 * 16 * 3).fill(level), width: 16, height: 16, timestampSeconds }],
      preprocessingVersion: "mp4-h264-rgb24-v4:4s:1f:384:srcpts-v3",
    });
  }
  return segments;
}

function audioSegments(endSeconds: number): AudioSegment[] {
  const segments: AudioSegment[] = [];
  for (let start = 0; start < endSeconds - 1e-9; start += AUDIO_SEGMENT_SECONDS) {
    const segmentEnd = Math.min(endSeconds, start + AUDIO_SEGMENT_SECONDS);
    segments.push({
      samples: new Float32Array(Math.round((segmentEnd - start) * 16_000)),
      sampleRate: 16_000,
      startSeconds: start,
      endSeconds: segmentEnd,
      preprocessingVersion: "mp4-aac-mono16k-v2:10s:clamp-v1:stream-align-v1",
    });
  }
  return segments;
}

function makeProbe(overrides: Partial<VideoProbe> = {}): VideoProbe {
  return {
    container: "mov,mp4,m4a,3gp,3g2,mj2",
    durationSeconds: 12,
    sourceStartSeconds: 0,
    video: { codec: "h264", width: 64, height: 36, rotationDegrees: 0, avgFrameRate: "25/1", rFrameRate: "25/1" },
    audioStreams: [],
    selectedAudio: null,
    hasVideo: true,
    hasAudio: false,
    visualTimeline: visualSegments(overrides.durationSeconds ?? 12).map((segment, segmentIndex) => ({
      segmentIndex, startSeconds: segment.startSeconds, endSeconds: segment.endSeconds,
      frameTimeSeconds: segment.frames[0]!.timestampSeconds, rule: "midpoint" as const,
    })),
    ...overrides,
  };
}

interface DecodeEvent { tag: number; kind: "nextStart" | "nextEnd" | "return"; at: number }
interface EmbedEvent { tag: number; start: number; end: number }

/**
 * 追蹤用的 fake decoder：以快照檔案大小區分「長片」（8 bytes）與「短片」（4 bytes），
 * 記錄每次 next()／return() 的時間與同時進行中的 next 數。
 */
class TrackingDecoder implements MediaDecoder {
  activeNext = 0;
  peakNext = 0;
  returns = 0;
  failed = false;
  readonly events: DecodeEvent[] = [];
  readonly embeds: EmbedEvent[] = [];

  private readonly availability: DecoderAvailability = { available: true, ffmpegVersion: "v-test", ffprobeVersion: "v-test" };

  async checkAvailability(): Promise<DecoderAvailability> { return this.availability; }

  async probe(source: MediaSource): Promise<VideoProbe> {
    const size = (await fs.stat(source.path)).size;
    const durationSeconds = size === 8 ? 8 : size === 4 ? 4 : 8;
    return makeProbe({ durationSeconds });
  }

  private tagOf(source: MediaSource): number {
    const size = Number(requireSize(source));
    return size === 4 ? 1 : 2;
  }

  decodeVisualSegments(source: MediaSource): AsyncGenerator<VisualSegment> {
    const tag = this.tagOf(source);
    const durationSeconds = tag === 1 ? 4 : 8;
    const segments = visualSegments(durationSeconds, tag);
    let index = 0;
    const self = this;
    const iterator: AsyncIterableIterator<VisualSegment> = {
      [Symbol.asyncIterator]() { return iterator; },
      async next() {
        self.activeNext += 1;
        self.peakNext = Math.max(self.peakNext, self.activeNext);
        self.events.push({ tag, kind: "nextStart", at: performance.now() });
        try {
          await new Promise((resolve) => setTimeout(resolve, 5));
          if (index >= segments.length) return { done: true, value: undefined };
          return { done: false, value: segments[index++]! };
        } finally {
          self.activeNext -= 1;
          self.events.push({ tag, kind: "nextEnd", at: performance.now() });
        }
      },
      async return() {
        self.returns += 1;
        self.events.push({ tag, kind: "return", at: performance.now() });
        return { done: true, value: undefined };
      },
    };
    return iterator as AsyncGenerator<VisualSegment>;
  }

  async *decodeAudioSegments(): AsyncGenerator<AudioSegment> {
    this.failed = true;
    yield* [];
  }
}

function requireSize(source: MediaSource): number {
  // 同步讀取（測試專用）：decodeVisualSegments 是同步函式，不能 await。
  return Number(requireSyncStatSize(source.path));
}

import { statSync } from "node:fs";
function requireSyncStatSize(filePath: string): number {
  return statSync(filePath).size;
}

let dir = "";
let db: SqliteDatabase;
let store: SqliteMetadataStore;
let vec: SqliteVectorIndex;

beforeEach(async () => {
  await fs.mkdir(path.join(WORKSPACE, ".tmp", "wave1"), { recursive: true });
  dir = await fs.mkdtemp(path.join(WORKSPACE, ".tmp", "wave1", "index-"));
  db = openDatabase(":memory:");
  store = new SqliteMetadataStore(db);
  await store.migrate();
  vec = new SqliteVectorIndex(db);
});

afterEach(async () => {
  vi.restoreAllMocks();
  db.close();
  await fs.rm(dir, { recursive: true, force: true });
});

async function addRoot(rootDir: string, modalities: Modality[]): Promise<Root> {
  return store.addRoot({ path: rootDir, mode: "index", modalities, include: [], exclude: [], respectGitignore: false, watch: false });
}

function sha256(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }

describe("波次一 D2／D3：音軌較短時增量一致（fake decoder）", () => {
  it("12.0 秒畫面＋11.8 秒音軌：首建成功、同 hash 重跑不重新推論", async () => {
    await fs.writeFile(path.join(dir, "short-audio.mp4"), Buffer.from("short-audio-video"));
    const embedder = new FakeEmbedder({ audio: true, video: true });
    const decoder = new FakeDecoderForAudio();
    const root = await addRoot(dir, ["video", "audio"]);
    const embedVideo = vi.spyOn(embedder, "embedVideo");
    const embedAudio = vi.spyOn(embedder, "embedAudio");

    const first = await indexRoot(root, { store, vec, embedder, decoder });
    expect(first.processed).toBe(1);
    expect(first.failedFiles).toEqual([]);
    const chunks = await store.listChunksByPath(root.id, "short-audio.mp4");
    expect(chunks.map((chunk) => [chunk.media?.track, chunk.media?.startSeconds, chunk.media?.endSeconds])).toEqual([
      ["video", 0, 4],
      ["video-audio", 0, 10],
      ["video", 4, 8],
      ["video", 8, 12],
      ["video-audio", 10, 11.8],
    ]);
    expect(embedVideo).toHaveBeenCalledTimes(3);
    expect(embedAudio).toHaveBeenCalledTimes(2);

    const second = await indexRoot(root, { store, vec, embedder, decoder });
    expect(second.skippedUnchanged).toBe(1);
    expect(second.processed).toBe(0);
    expect(embedVideo).toHaveBeenCalledTimes(3);
    expect(embedAudio).toHaveBeenCalledTimes(2);
  });

  it("音軌延遲起點（offset 2 秒、end 12）：預期佈局與實際輸出共用同一時間規則", async () => {
    await fs.writeFile(path.join(dir, "offset-audio.mp4"), Buffer.from("offset-audio-video"));
    const embedder = new FakeEmbedder({ audio: true, video: true });
    const decoder = new FakeDecoderForAudio({ audioStartSeconds: 2, audioDurationSeconds: 10 });
    const root = await addRoot(dir, ["video", "audio"]);
    const first = await indexRoot(root, { store, vec, embedder, decoder });
    expect(first.processed).toBe(1);
    const chunks = await store.listChunksByPath(root.id, "offset-audio.mp4");
    const audioChunks = chunks.filter((chunk) => chunk.media?.track === "video-audio");
    expect(audioChunks.map((chunk) => [chunk.media!.startSeconds, chunk.media!.endSeconds])).toEqual([[0, 10], [10, 12]]);
    const second = await indexRoot(root, { store, vec, embedder, decoder });
    expect(second.skippedUnchanged).toBe(1);
  });

  it("unsupported-video-timeline：具名 skip，不落回 invalid-video／failed", async () => {
    await fs.writeFile(path.join(dir, "bad-timeline.mp4"), Buffer.from("bad-timeline"));
    const embedder = new FakeEmbedder({ audio: true, video: true });
    const decoder = new FakeDecoderForAudio({ visualError: new MediaDecoderError("unsupported-video-timeline" as never) });
    const root = await addRoot(dir, ["video"]);
    const result = await indexRoot(root, { store, vec, embedder, decoder });
    expect(result.skippedFiles).toEqual([{ relPath: "bad-timeline.mp4", reason: "unsupported-video-timeline" }]);
    expect(result.failedFiles).toEqual([]);
  });
});

class FakeDecoderForAudio implements MediaDecoder {
  readonly calls = { probe: 0, visual: 0, audio: 0 };
  constructor(private readonly options: {
    audioStartSeconds?: number;
    audioDurationSeconds?: number;
    visualError?: unknown;
  } = {}) {}

  async checkAvailability(): Promise<DecoderAvailability> { return { available: true, ffmpegVersion: "v-test", ffprobeVersion: "v-test" }; }

  async probe(): Promise<VideoProbe> {
    this.calls.probe += 1;
    const duration = 12;
    const audioDuration = this.options.audioDurationSeconds ?? 11.8;
    const audioStart = this.options.audioStartSeconds ?? 0;
    const stream = { streamIndex: 1, codec: "aac", sampleRate: 48_000, channels: 2, hasDefault: true, isAac: true, startTimeSeconds: audioStart, durationSeconds: audioDuration, initialPaddingSamples: 1024 };
    return makeProbe({ durationSeconds: duration, hasAudio: true, audioStreams: [stream], selectedAudio: stream });
  }

  async *decodeVisualSegments(): AsyncGenerator<VisualSegment> {
    this.calls.visual += 1;
    if (this.options.visualError !== undefined) throw this.options.visualError;
    yield* visualSegments(12);
  }

  async *decodeAudioSegments(): AsyncGenerator<AudioSegment> {
    this.calls.audio += 1;
    const offset = this.options.audioStartSeconds ?? 0;
    const duration = this.options.audioDurationSeconds ?? 11.8;
    const endSeconds = Math.min(12, offset + duration);
    yield* audioSegments(endSeconds);
  }
}

describe("波次一 D4：影片名額以每次 next() 為單位", () => {
  it("兩個 root 共用 embedder：長片 embed 期間短片仍可解碼；同時進行中的 next() ≤ 1", async () => {
    const rootA = path.join(dir, "root-a");
    const rootB = path.join(dir, "root-b");
    await fs.mkdir(rootA, { recursive: true });
    await fs.mkdir(rootB, { recursive: true });
    await fs.writeFile(path.join(rootA, "long.mp4"), Buffer.alloc(8, 1));
    await fs.writeFile(path.join(rootB, "short.mp4"), Buffer.alloc(4, 2));
    const rootLong = await addRoot(rootA, ["video"]);
    const rootShort = await addRoot(rootB, ["video"]);

    const decoder = new TrackingDecoder();
    const embedder = new FakeEmbedder({ audio: true, video: true });
    const originalEmbed = embedder.embedVideo.bind(embedder);
    vi.spyOn(embedder, "embedVideo").mockImplementation(async (input, opts) => {
      const tag = input.frames[0]!.pixels[0] === 2 ? 2 : 1;
      const start = performance.now();
      if (tag === 2) await new Promise((resolve) => setTimeout(resolve, 120));
      const vector = await originalEmbed(input, opts);
      decoder.embeds.push({ tag, start, end: performance.now() });
      return vector;
    });

    // 先確定長片已開始（並完成第一次 next()），再啟動短片，避免兩者搶 permit 的順序不確定。
    const longPromise = indexRoot(rootLong, { store, vec, embedder, decoder });
    const waitDeadline = Date.now() + 5_000;
    while (!decoder.events.some((event) => event.tag === 2 && event.kind === "nextEnd") && Date.now() < waitDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    const shortPromise = indexRoot(rootShort, { store, vec, embedder, decoder });
    const [resultLong, resultShort] = await Promise.all([longPromise, shortPromise]);
    expect(resultLong.processed).toBe(1);
    expect(resultShort.processed).toBe(1);
    expect(decoder.peakNext).toBe(1);

    // 長片第 1 段 embed 期間，短片必須能完成一次 decode next()：證明名額不是整檔持有。
    const longEmbeds = decoder.embeds.filter((embed) => embed.tag === 2);
    expect(longEmbeds.length).toBe(2);
    const firstLongNextEnd = decoder.events.find((event) => event.tag === 2 && event.kind === "nextEnd")!;
    const shortNext = decoder.events.find((event) => event.tag === 1 && event.kind === "nextStart")!;
    expect(shortNext, "短片應有 decode 事件").toBeDefined();
    // 名額在 long 的第一次 next() 之後就釋放：短片可在 long 檔案整體完成之前開始解碼。
    expect(shortNext.at).toBeGreaterThan(firstLongNextEnd.at);
    expect(shortNext.at).toBeLessThan(longEmbeds[longEmbeds.length - 1]!.end);
  }, 30_000);

  it("取消時 decoder 迭代器被 return()、程序（fake）數歸零", async () => {
    const rootDir = path.join(dir, "root-cancel");
    await fs.mkdir(rootDir, { recursive: true });
    await fs.writeFile(path.join(rootDir, "clip.mp4"), Buffer.alloc(8, 1));
    const root = await addRoot(rootDir, ["video"]);
    const decoder = new TrackingDecoder();
    const embedder = new FakeEmbedder({ audio: true, video: true });
    const controller = new AbortController();
    const original = embedder.embedVideo.bind(embedder);
    let calls = 0;
    vi.spyOn(embedder, "embedVideo").mockImplementation(async (input, opts) => {
      const vector = await original(input, opts);
      if (++calls === 1) controller.abort();
      return vector;
    });
    await expect(indexRoot(root, { store, vec, embedder, decoder, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(decoder.returns).toBeGreaterThanOrEqual(1);
    expect(decoder.activeNext).toBe(0);
  }, 30_000);
});

describe("波次一 D6：快照先 open 再驗證身分（BigInt 身分＋realpath 穩定）", () => {
  const junctionSupported = process.platform === "win32" || process.platform === "linux" || process.platform === "darwin";

  function indexerStyleVerifier(root: Root, expectedTarget: string): (ctx: { handleStat: import("node:fs").BigIntStats; expectedPath: string }) => Promise<void> {
    return async ({ handleStat, expectedPath }) => {
      const resolved = await resolveInsideRoot([root], expectedPath);
      if (!sameVerifiedPath(resolved.abs, expectedTarget)) throw new MediaDecoderError("invalid-video");
      assertSameFileIdentity(handleStat, await fsp.stat(resolved.abs, { bigint: true }));
    };
  }

  async function expectSnapshotRejects(file: string, verifier: Parameters<typeof snapshotVideoSource>[3], code?: string): Promise<void> {
    let error: unknown;
    try { await snapshotVideoSource(file, 1024, undefined, verifier); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Error);
    if (code !== undefined) expect(error instanceof MediaDecoderError ? error.code : undefined).toBe(code);
  }

  it("正常路徑：verifier 收到 BigIntStats 與 expectedPath、複製內容與 hash 正確", async () => {
    const file = path.join(dir, "ok.mp4");
    await fs.writeFile(file, Buffer.from("snapshot-ok-content"));
    let seen: { bigint: boolean; expectedPath: string } | undefined;
    const snapshot = await snapshotVideoSource(file, 1024, undefined, async ({ handleStat, expectedPath }) => {
      seen = { bigint: typeof handleStat.size === "bigint", expectedPath };
      assertSameFileIdentity(handleStat, await fsp.stat(file, { bigint: true }));
    });
    expect(seen?.bigint).toBe(true);
    expect(seen?.expectedPath).toBe(file);
    expect(snapshot.contentHash).toBe(sha256(Buffer.from("snapshot-ok-content")));
    const copied = await fs.readFile(snapshot.path);
    expect(copied.toString()).toBe("snapshot-ok-content");
    await fs.rm(snapshot.dir, { recursive: true, force: true });
    expect(existsSync(snapshot.path)).toBe(false);
  });

  it.skipIf(!junctionSupported)("open 前父目錄換成 root 外連結：verifier 重走邊界失敗，不複製 root 外內容", async () => {
    const rootDir = path.join(dir, "junction-root");
    const sub = path.join(rootDir, "sub");
    const outside = path.join(dir, "outside");
    await fs.mkdir(sub, { recursive: true });
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(path.join(sub, "clip.mp4"), Buffer.from("inside-content"));
    await fs.writeFile(path.join(outside, "clip.mp4"), Buffer.from("OUTSIDE-SECRET"));
    const root = await addRoot(rootDir, ["video"]);
    const target = path.join(sub, "clip.mp4");
    // 模擬掃描後、process 前被換掉：先把父目錄換成指向 root 外的 junction，再交給快照。
    await fs.rm(sub, { recursive: true, force: true });
    await fs.symlink(outside, sub, "junction");
    await expect(snapshotVideoSource(target, 1024, undefined, async ({ handleStat, expectedPath }) => {
      expect(typeof handleStat.size).toBe("bigint");
      await indexerStyleVerifier(root, target)({ handleStat, expectedPath });
    })).rejects.toBeInstanceOf(PathOutsideRootError);
  });

  it.skipIf(!junctionSupported)("open 後、verifier 前換成 root 外連結：拒絕（不得讀到 OUTSIDE-SECRET）", async () => {
    const rootDir = path.join(dir, "junction-late");
    const sub = path.join(rootDir, "sub");
    const outside = path.join(dir, "outside-2");
    await fs.mkdir(sub, { recursive: true });
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(path.join(sub, "clip.mp4"), Buffer.from("inside-content"));
    await fs.writeFile(path.join(outside, "clip.mp4"), Buffer.from("OUTSIDE-SECRET"));
    const root = await addRoot(rootDir, ["video"]);
    const target = path.join(sub, "clip.mp4");
    const swap = async () => {
      await fs.rm(sub, { recursive: true, force: true });
      await fs.symlink(outside, sub, "junction");
    };
    let rejected = false;
    try {
      await snapshotVideoSource(target, 1024, undefined, async ({ handleStat, expectedPath }) => {
        await swap();
        await indexerStyleVerifier(root, target)({ handleStat, expectedPath });
      });
    } catch (error) {
      expect(error).toBeInstanceOf(PathOutsideRootError);
      rejected = true;
    }
    expect(rejected).toBe(true);
  });

  it("同大小內容替換（unlink＋重建，新 inode）：身分比對失敗 → invalid-video", async () => {
    const file = path.join(dir, "same-size-swap.mp4");
    const original = Buffer.from("AAAAAAAAAAAAAAAAAAAA");
    const replacement = Buffer.from("BBBBBBBBBBBBBBBBBBBB");
    expect(original.length).toBe(replacement.length);
    await fs.writeFile(file, original);
    let rejected = false;
    try {
      await snapshotVideoSource(file, 1024, undefined, async ({ handleStat }) => {
        await fs.unlink(file);
        await fs.writeFile(file, replacement);
        assertSameFileIdentity(handleStat, await fsp.stat(file, { bigint: true }));
      });
    } catch (error) {
      expect(error).toBeInstanceOf(MediaDecoderError);
      expect((error as MediaDecoderError).code).toBe("invalid-video");
      rejected = true;
    }
    expect(rejected).toBe(true);
  });

  it("複製期間同 inode 被截斷：total 不符 → invalid-video，暫存目錄刪除", async () => {
    const file = path.join(dir, "truncate.mp4");
    await fs.writeFile(file, Buffer.alloc(4096, 7));
    const snapshotTmp = path.join(dir, "snapshot-tmp");
    await fs.mkdir(snapshotTmp, { recursive: true });
    // 用測試專屬 tmpdir 隔離其他 worker 的快照，才能確定「本次」沒有殘留。
    vi.spyOn(os, "tmpdir").mockReturnValue(snapshotTmp);
    let rejected = false;
    try {
      await snapshotVideoSource(file, 1024 * 1024, undefined, async () => {
        await fsp.truncate(file, 1024);
      });
    } catch (error) {
      expect(error).toBeInstanceOf(MediaDecoderError);
      expect((error as MediaDecoderError).code).toBe("invalid-video");
      rejected = true;
    }
    expect(rejected).toBe(true);
    expect(await fs.readdir(snapshotTmp)).toEqual([]);
  });

  it("複製期間同 inode 被增長：finalStat 不符 → invalid-video", async () => {
    const file = path.join(dir, "grow.mp4");
    await fs.writeFile(file, Buffer.alloc(2048, 9));
    let rejected = false;
    try {
      await snapshotVideoSource(file, 1024 * 1024, undefined, async () => {
        await fsp.appendFile(file, Buffer.alloc(512, 1));
      });
    } catch (error) {
      expect(error).toBeInstanceOf(MediaDecoderError);
      expect((error as MediaDecoderError).code).toBe("invalid-video");
      rejected = true;
    }
    expect(rejected).toBe(true);
  });

  it("dev／ino 不可用（0n）時走 D6 fallback：size＋mtimeNs 相同才通過", () => {
    const base = { dev: 0n, ino: 0n, size: 123n, mtimeNs: 456n } as unknown as import("node:fs").BigIntStats;
    const same = { dev: 0n, ino: 0n, size: 123n, mtimeNs: 456n } as unknown as import("node:fs").BigIntStats;
    const differentSize = { dev: 0n, ino: 0n, size: 124n, mtimeNs: 456n } as unknown as import("node:fs").BigIntStats;
    const differentMtime = { dev: 0n, ino: 0n, size: 123n, mtimeNs: 457n } as unknown as import("node:fs").BigIntStats;
    expect(() => assertSameFileIdentity(base, same)).not.toThrow();
    expect(() => assertSameFileIdentity(base, differentSize)).toThrow(MediaDecoderError);
    expect(() => assertSameFileIdentity(base, differentMtime)).toThrow(MediaDecoderError);
  });

  it("sameVerifiedPath：Windows／macOS 大小寫不敏感、Linux 敏感", () => {
    expect(sameVerifiedPath("/tmp/A.mp4", "/tmp/a.mp4", true)).toBe(true);
    expect(sameVerifiedPath("/tmp/A.mp4", "/tmp/a.mp4", false)).toBe(false);
  });
});

function workspaceTmp(): string {
  return path.join(WORKSPACE, ".tmp");
}