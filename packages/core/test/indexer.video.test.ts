/**
 * 影片索引主流程（B3b）測試：fake decoder／fake embedder，不依賴 ffmpeg binary。
 *
 * 真 decoder 的端到端整合另有一段 gated（Windows＋MNEMOSHELF_FFMPEG_PATH／FFPROBE_PATH／
 * fixtures）；缺 env 時整段 skip，CI 不依賴 binary。
 */
import { createHash } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  indexRoot, openDatabase, SqliteMetadataStore, SqliteVectorIndex,
  type Modality, type Root, type SqliteDatabase,
} from "../src/index.js";
import {
  FfmpegMediaDecoder, MediaDecoderError,
  type AudioSegment, type DecoderAvailability, type MediaDecoder, type MediaSource,
  type VideoProbe, type VisualSegment,
} from "../src/media/index.js";
import { FakeEmbedder } from "../src/testing/fake-embedder.js";
import { assertVideoVisualCoverage, videoAudioPreprocessVersion, videoVisualPreprocessVersion } from "../src/indexer/video.js";
import type { AudioInput, EmbedDocumentsOptions, VideoInput } from "../src/ports/embedder.js";

const FIXED_DECODER_VERSION = "n9.0.2-test";
type IndexOptions = Parameters<typeof indexRoot>[1];

/** 組一個合法的 probe（預設 8 秒、H.264 64×36、無音軌）。 */
function makeProbe(overrides: Partial<VideoProbe> = {}): VideoProbe {
  return {
    container: "mov,mp4,m4a,3gp,3g2,mj2",
    durationSeconds: 8,
    sourceStartSeconds: 0,
    video: { codec: "h264", width: 64, height: 36, rotationDegrees: 0, avgFrameRate: "25/1", rFrameRate: "25/1" },
    audioStreams: [],
    selectedAudio: null,
    hasVideo: true,
    hasAudio: false,
    visualTimeline: visualSegments(overrides.durationSeconds ?? 8).map((segment, segmentIndex) => ({
      segmentIndex, startSeconds: segment.startSeconds, endSeconds: segment.endSeconds,
      frameTimeSeconds: segment.frames[0]!.timestampSeconds, rule: "midpoint" as const,
    })),
    ...overrides,
  };
}

function aacStream(streamIndex = 1) {
  return { streamIndex, codec: "aac", sampleRate: 48000, channels: 2, hasDefault: true, isAac: true };
}

function ac3Stream(streamIndex = 2) {
  return { streamIndex, codec: "ac3", sampleRate: 48000, channels: 2, hasDefault: true, isAac: false };
}

/** 16×16 的純黑 RGB 幀；fake embedder 只做結構雜湊，內容不重要。 */
function blackPixels(): Uint8Array {
  return new Uint8Array(16 * 16 * 3);
}

/** 依凍結政策產生視覺片段：完整段取段中，尾段取段內的一半。 */
function visualSegment(startSeconds: number, endSeconds: number): VisualSegment {
  const timestampSeconds = startSeconds + Math.min(2, (endSeconds - startSeconds) / 2);
  return {
    startSeconds,
    endSeconds,
    frames: [{ pixels: blackPixels(), width: 16, height: 16, timestampSeconds }],
    preprocessingVersion: "mp4-h264-rgb24-v4:4s:1f:384:srcpts-v3",
  };
}

function visualSegments(durationSeconds: number): VisualSegment[] {
  const segments: VisualSegment[] = [];
  for (let start = 0; start < durationSeconds; start += 4) {
    segments.push(visualSegment(start, Math.min(durationSeconds, start + 4)));
  }
  return segments;
}

function audioSegments(durationSeconds: number): AudioSegment[] {
  const segments: AudioSegment[] = [];
  for (let start = 0; start < durationSeconds; start += 10) {
    const endSeconds = Math.min(durationSeconds, start + 10);
    segments.push({
      samples: new Float32Array(Math.round((endSeconds - start) * 16000)),
      sampleRate: 16000,
      startSeconds: start,
      endSeconds,
      preprocessingVersion: "mp4-aac-mono16k-v2:10s:clamp-v1:stream-align-v1",
    });
  }
  return segments;
}

interface FakeDecoderOptions {
  availability?: DecoderAvailability;
  probeResult?: VideoProbe;
  probeError?: unknown;
  visuals?: VisualSegment[];
  audios?: AudioSegment[];
  visualErrorBefore?: { index: number; error: unknown };
  audioErrorBefore?: { index: number; error: unknown };
  yieldDelayMs?: number;
}

/** 控制行為的 fake decoder：不 spawn 任何程序，可注入 probe／segment／錯誤與延遲。 */
class FakeDecoder implements MediaDecoder {
  readonly calls = { availability: 0, probe: 0, visual: 0, audio: 0 };
  /** adapter 實際收到的來源（用來確認拿到的是本輪快照）。 */
  readonly sources: string[] = [];
  activeVisual = 0;
  peakVisual = 0;
  /** 同時執行中的 decoder next() 數（名額粒度契約 D4）。 */
  activeNext = 0;
  peakNext = 0;

  constructor(private readonly options: FakeDecoderOptions = {}) {}

  async checkAvailability(): Promise<DecoderAvailability> {
    this.calls.availability += 1;
    return this.options.availability ?? {
      available: true,
      ffmpegVersion: FIXED_DECODER_VERSION,
      ffprobeVersion: FIXED_DECODER_VERSION,
    };
  }

  async probe(source: MediaSource): Promise<VideoProbe> {
    this.calls.probe += 1;
    this.sources.push(source.path);
    if (this.options.probeError !== undefined) throw this.options.probeError;
    return this.options.probeResult ?? makeProbe();
  }

  async *decodeVisualSegments(source: MediaSource): AsyncGenerator<VisualSegment> {
    this.calls.visual += 1;
    this.sources.push(source.path);
    this.activeVisual += 1;
    this.peakVisual = Math.max(this.peakVisual, this.activeVisual);
    try {
      const segments = this.options.visuals ?? [];
      for (let index = 0; index < segments.length; index += 1) {
        if (this.options.visualErrorBefore?.index === index) throw this.options.visualErrorBefore.error;
        this.activeNext += 1;
        this.peakNext = Math.max(this.peakNext, this.activeNext);
        try {
          if (this.options.yieldDelayMs !== undefined) await new Promise((resolve) => setTimeout(resolve, this.options.yieldDelayMs));
        } finally {
          this.activeNext -= 1;
        }
        yield segments[index]!;
      }
    } finally {
      this.activeVisual -= 1;
    }
  }

  async *decodeAudioSegments(source: MediaSource): AsyncGenerator<AudioSegment> {
    this.calls.audio += 1;
    this.sources.push(source.path);
    const segments = this.options.audios ?? [];
    for (let index = 0; index < segments.length; index += 1) {
      if (this.options.audioErrorBefore?.index === index) throw this.options.audioErrorBefore.error;
      yield segments[index]!;
    }
  }
}

/**
 * 模擬真實 embedder（WorkerEmbedder／TransformersEmbedder）：方法內部依賴 `this`。
 *
 * 若 indexer 把 class method 脫鉤呼叫，這裡會拋 TypeError；用來鎖住 D1 產品鏈抓到的回歸。
 */
class ThisSensitiveEmbedder extends FakeEmbedder {
  private calls = 0;

  constructor() {
    super({ audio: true, video: true });
  }

  override async embedVideo(video: VideoInput, opts?: EmbedDocumentsOptions): Promise<Float32Array> {
    if (!(this instanceof ThisSensitiveEmbedder)) throw new TypeError("embedVideo 被脫鉤呼叫");
    this.calls += 1;
    return super.embedVideo(video, opts);
  }

  override async embedAudio(audio: AudioInput, opts?: EmbedDocumentsOptions): Promise<Float32Array> {
    if (!(this instanceof ThisSensitiveEmbedder)) throw new TypeError("embedAudio 被脫鉤呼叫");
    this.calls += 1;
    return super.embedAudio(audio, opts);
  }

  get callCount(): number {
    return this.calls;
  }
}

let dir = "";
let db: SqliteDatabase;
let store: SqliteMetadataStore;
let vec: SqliteVectorIndex;
let embedder: FakeEmbedder;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "mnemoshelf-video-index-"));
  db = openDatabase(":memory:");
  store = new SqliteMetadataStore(db);
  await store.migrate();
  vec = new SqliteVectorIndex(db);
  embedder = new FakeEmbedder({ audio: true, video: true });
});

afterEach(async () => {
  vi.restoreAllMocks();
  db.close();
  await fs.rm(dir, { recursive: true, force: true });
});

async function addRoot(modalities: Modality[]): Promise<Root> {
  return store.addRoot({ path: dir, mode: "index", modalities, include: [], exclude: [], respectGitignore: false, watch: false });
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function baseOptions(decoder: MediaDecoder, extra: Partial<IndexOptions> = {}): IndexOptions {
  return { store, vec, embedder, ...(decoder === undefined ? {} : { decoder }), ...extra };
}

describe("影片索引主流程（fake decoder）", () => {
  it("覆蓋不一致使用unsupported-video-timeline；相符時不拋錯", () => {
    expect(() => assertVideoVisualCoverage(2, 2)).not.toThrow();
    try { assertVideoVisualCoverage(1, 2); throw new Error("應拒絕缺段"); }
    catch (error) { expect(error).toMatchObject({ code: "unsupported-video-timeline" }); }
  });

  it("來源PTS佈局省略空尾格，首建與未變重跑使用相同段數", async () => {
    await fs.writeFile(path.join(dir, "clip.mp4"), Buffer.from("empty-tail"));
    const decoder = new FakeDecoder({
      probeResult: makeProbe({ durationSeconds: 8.008, visualTimeline: makeProbe().visualTimeline! }),
      visuals: visualSegments(8),
    });
    const root = await addRoot(["video"]);
    const calls = vi.spyOn(embedder, "embedVideo");
    expect((await indexRoot(root, baseOptions(decoder))).processed).toBe(1);
    expect((await store.listChunksByPath(root.id, "clip.mp4")).map((chunk) => chunk.media?.endSeconds)).toEqual([4, 8]);
    expect((await indexRoot(root, baseOptions(decoder))).skippedUnchanged).toBe(1);
    expect(calls).toHaveBeenCalledTimes(2);
  });

  it.each(["missing", "gap", "nan", "empty"])("畸形probe佈局%s在嵌入前具名拒絕", async (problem) => {
    await fs.writeFile(path.join(dir, "clip.mp4"), Buffer.from("malformed-layout"));
    const original = makeProbe();
    const { visualTimeline, ...withoutTimeline } = original;
    const probe: VideoProbe = problem === "missing" ? withoutTimeline : {
      ...original,
      visualTimeline: problem === "empty" ? [] : visualTimeline!.map((pick, index) => ({
        ...pick,
        ...(problem === "gap" && index === 1 ? { startSeconds: 5 } : {}),
        ...(problem === "nan" && index === 0 ? { frameTimeSeconds: Number.NaN } : {}),
      })),
    };
    const calls = vi.spyOn(embedder, "embedVideo");
    const result = await indexRoot(await addRoot(["video"]), baseOptions(new FakeDecoder({ probeResult: probe, visuals: visualSegments(8) })));
    expect(result.skippedFiles).toEqual([{ relPath: "clip.mp4", reason: "unsupported-video-timeline" }]);
    expect(result.failedFiles).toEqual([]);
    expect(calls).not.toHaveBeenCalled();
  });

  it.each(["start", "end", "pts", "count"])("decoder的%s與probe不一致不能發布部分索引", async (problem) => {
    await fs.writeFile(path.join(dir, "clip.mp4"), Buffer.from("wrong-output"));
    const segments = visualSegments(8);
    const segment = segments[1]!;
    const wrong = {
      ...segment,
      ...(problem === "start" ? { startSeconds: 4.5 } : {}),
      ...(problem === "end" ? { endSeconds: 7.5 } : {}),
      ...(problem === "pts" ? { frames: [{ ...segment.frames[0]!, timestampSeconds: 6.5 }] } : {}),
    };
    const decoder = new FakeDecoder({ probeResult: makeProbe(), visuals: problem === "count" ? [segments[0]!] : [segments[0]!, wrong] });
    const root = await addRoot(["video"]);
    const result = await indexRoot(root, baseOptions(decoder));
    expect(result.skippedFiles).toEqual([{ relPath: "clip.mp4", reason: "unsupported-video-timeline" }]);
    expect(result.failedFiles).toEqual([]);
    expect(await store.listChunksByPath(root.id, "clip.mp4")).toEqual([]);
    expect(await vec.count()).toBe(0);
  });

  it("增量比較來源PTS：同段內舊時間不同也必須重嵌", async () => {
    await fs.writeFile(path.join(dir, "clip.mp4"), Buffer.from("pts-identity"));
    const root = await addRoot(["video"]);
    const decoder = new FakeDecoder({ probeResult: makeProbe(), visuals: visualSegments(8) });
    expect((await indexRoot(root, baseOptions(decoder))).processed).toBe(1);
    const read = store.listChunksByPath.bind(store);
    vi.spyOn(store, "listChunksByPath").mockImplementationOnce(async (rootId, relPath) => {
      const chunks = await read(rootId, relPath);
      return chunks.map((chunk, index) => index === 0 ? { ...chunk, media: { ...chunk.media!, frameTimesSeconds: [2.5] } } : chunk);
    });
    expect((await indexRoot(root, baseOptions(decoder))).processed).toBe(1);
    expect(decoder.calls.visual).toBe(2);
  });

  it("成功：視覺 4 秒 1 幀＋音軌 10 秒，ChunkMedia／seq 跨軌正確、快照用完即刪", async () => {
    const bytes = Buffer.from("synthetic-video-bytes");
    await fs.writeFile(path.join(dir, "clip.mp4"), bytes);
    const decoder = new FakeDecoder({
      probeResult: makeProbe({
        durationSeconds: 8, hasAudio: true,
        audioStreams: [aacStream()], selectedAudio: aacStream(),
      }),
      visuals: visualSegments(8),
      audios: audioSegments(8),
    });
    const root = await addRoot(["video", "audio"]);
    const embedVideo = vi.spyOn(embedder, "embedVideo");
    const embedAudio = vi.spyOn(embedder, "embedAudio");

    const result = await indexRoot(root, baseOptions(decoder));

    expect(result.processed).toBe(1);
    expect(result.failedFiles).toEqual([]);
    expect(result.skippedFiles).toEqual([]);
    const chunks = await store.listChunksByPath(root.id, "clip.mp4");
    expect(chunks.map((chunk) => chunk.seq)).toEqual([0, 1, 2]);
    expect(chunks.map((chunk) => chunk.kind)).toEqual(["video", "audio", "video"]);
    expect(chunks.map((chunk) => chunk.media?.track)).toEqual(["video", "video-audio", "video"]);
    expect(chunks.map((chunk) => [chunk.media?.startSeconds, chunk.media?.endSeconds])).toEqual([[0, 4], [0, 8], [4, 8]]);
    expect(chunks[0]?.media?.container).toBe("mp4");
    expect(chunks[0]?.media?.frameTimesSeconds).toEqual([2]);
    expect(chunks[2]?.media?.frameTimesSeconds).toEqual([6]);
    expect(chunks[1]?.media?.streamIndex).toBe(1);
    expect(chunks[0]?.media?.preprocessVersion).toBe(videoVisualPreprocessVersion(FIXED_DECODER_VERSION));
    expect(chunks[1]?.media?.preprocessVersion).toBe(videoAudioPreprocessVersion(FIXED_DECODER_VERSION));
    expect(chunks.every((chunk) => chunk.contentHash === sha256(bytes))).toBe(true);
    expect(await vec.count()).toBe(3);
    expect(embedVideo).toHaveBeenCalledTimes(2);
    expect(embedAudio).toHaveBeenCalledTimes(1);
    expect(decoder.calls.availability).toBe(1);
    expect(decoder.calls.probe).toBe(1);

    // 快照：不是來源檔、在系統暫存目錄、索引結束後已刪除。
    const snapshotPath = decoder.sources[0]!;
    expect(snapshotPath).not.toBe(path.join(dir, "clip.mp4"));
    expect(snapshotPath.startsWith(os.tmpdir())).toBe(true);
    expect(existsSync(snapshotPath)).toBe(false);
    expect(existsSync(path.dirname(snapshotPath))).toBe(false);
  });

  it("embedder 方法依賴 this 時仍可索引（回歸：不可脫鉤呼叫）", async () => {
    await fs.writeFile(path.join(dir, "clip.mp4"), Buffer.from("this-sensitive"));
    const decoder = new FakeDecoder({
      probeResult: makeProbe({
        durationSeconds: 8, hasAudio: true,
        audioStreams: [aacStream()], selectedAudio: aacStream(),
      }),
      visuals: visualSegments(8),
      audios: audioSegments(8),
    });
    const root = await addRoot(["video", "audio"]);
    const sensitive = new ThisSensitiveEmbedder();
    const result = await indexRoot(root, { ...baseOptions(decoder), embedder: sensitive });

    expect(result.processed).toBe(1);
    expect(result.failedFiles).toEqual([]);
    expect(sensitive.callCount).toBe(3);
  });

  it("無音軌：audio 開啟也正常成功，只產生畫面片段", async () => {
    await fs.writeFile(path.join(dir, "clip.mp4"), Buffer.from("no-audio"));
    const decoder = new FakeDecoder({ probeResult: makeProbe({ durationSeconds: 8 }), visuals: visualSegments(8) });
    const root = await addRoot(["video", "audio"]);

    expect((await indexRoot(root, baseOptions(decoder))).processed).toBe(1);
    const chunks = await store.listChunksByPath(root.id, "clip.mp4");
    expect(chunks).toHaveLength(2);
    expect(chunks.every((chunk) => chunk.kind === "video" && chunk.media?.track === "video")).toBe(true);
    expect(decoder.calls.audio).toBe(0);
  });

  it("AC-3 整檔具名跳過：不做部分成功、清掉舊索引、不呼叫 embed", async () => {
    await fs.writeFile(path.join(dir, "clip.mp4"), Buffer.from("ac3-video"));
    const root = await addRoot(["video", "audio"]);
    const ok = new FakeDecoder({
      probeResult: makeProbe({ durationSeconds: 8, hasAudio: true, audioStreams: [aacStream()], selectedAudio: aacStream() }),
      visuals: visualSegments(8), audios: audioSegments(8),
    });
    expect((await indexRoot(root, baseOptions(ok))).processed).toBe(1);
    expect(await vec.count()).toBe(3);

    const ac3 = new FakeDecoder({
      probeResult: makeProbe({ durationSeconds: 8, hasAudio: true, audioStreams: [ac3Stream()], selectedAudio: ac3Stream() }),
      visuals: visualSegments(8), audios: audioSegments(8),
    });
    const embedVideo = vi.spyOn(embedder, "embedVideo");
    const result = await indexRoot(root, baseOptions(ac3));

    expect(result.skippedFiles).toEqual([{ relPath: "clip.mp4", reason: "unsupported-video-audio-track" }]);
    expect(result.failedFiles).toEqual([]);
    expect(embedVideo).not.toHaveBeenCalled();
    expect(ac3.calls.visual).toBe(0);
    expect(await store.listChunksByPath(root.id, "clip.mp4")).toEqual([]);
    expect(await vec.count()).toBe(0);
  });

  it("audio 關閉時不讀音軌：AC-3 音軌不影響畫面索引", async () => {
    await fs.writeFile(path.join(dir, "clip.mp4"), Buffer.from("visual-only"));
    const decoder = new FakeDecoder({
      probeResult: makeProbe({ durationSeconds: 8, hasAudio: true, audioStreams: [ac3Stream()], selectedAudio: ac3Stream() }),
      visuals: visualSegments(8), audios: audioSegments(8),
    });
    const root = await addRoot(["video"]);

    expect((await indexRoot(root, baseOptions(decoder))).processed).toBe(1);
    expect(decoder.calls.audio).toBe(0);
    const chunks = await store.listChunksByPath(root.id, "clip.mp4");
    expect(chunks).toHaveLength(2);
    expect(chunks.every((chunk) => chunk.media?.track === "video")).toBe(true);
  });

  it("增量：未變重跑只做快照＋probe，不重新解碼嵌入", async () => {
    await fs.writeFile(path.join(dir, "clip.mp4"), Buffer.from("unchanged-video"));
    const decoder = new FakeDecoder({
      probeResult: makeProbe({ durationSeconds: 8 }),
      visuals: visualSegments(8),
    });
    const root = await addRoot(["video"]);
    const embedVideo = vi.spyOn(embedder, "embedVideo");

    expect((await indexRoot(root, baseOptions(decoder))).processed).toBe(1);
    expect((await indexRoot(root, baseOptions(decoder))).skippedUnchanged).toBe(1);

    expect(decoder.calls.probe).toBe(2);
    expect(decoder.calls.visual).toBe(1);
    expect(embedVideo).toHaveBeenCalledTimes(2);
    expect(existsSync(decoder.sources[0]!)).toBe(false);
  });

  it("缺一個向量就整檔重建（不能把剩餘向量齊全當作完整）", async () => {
    await fs.writeFile(path.join(dir, "clip.mp4"), Buffer.from("missing-vector"));
    const decoder = new FakeDecoder({ probeResult: makeProbe({ durationSeconds: 8 }), visuals: visualSegments(8) });
    const root = await addRoot(["video"]);
    await indexRoot(root, baseOptions(decoder));
    const chunks = await store.listChunksByPath(root.id, "clip.mp4");
    await vec.deleteByKeys([`c:${chunks[1]!.id}`]);

    expect((await indexRoot(root, baseOptions(decoder))).processed).toBe(1);
    expect(await vec.count()).toBe(2);
  });

  it("decoder 版本或 embedder 身分改變都重建（前處理版本納入增量身分）", async () => {
    await fs.writeFile(path.join(dir, "clip.mp4"), Buffer.from("version-video"));
    const root = await addRoot(["video"]);
    const first = new FakeDecoder({ probeResult: makeProbe({ durationSeconds: 8 }), visuals: visualSegments(8) });
    expect((await indexRoot(root, baseOptions(first))).processed).toBe(1);

    const newerDecoder = new FakeDecoder({
      availability: { available: true, ffmpegVersion: "n9.0.3-test", ffprobeVersion: "n9.0.3-test" },
      probeResult: makeProbe({ durationSeconds: 8 }), visuals: visualSegments(8),
    });
    expect((await indexRoot(root, baseOptions(newerDecoder))).processed).toBe(1);
    expect((await store.listChunksByPath(root.id, "clip.mp4"))[0]?.media?.preprocessVersion).toBe(
      videoVisualPreprocessVersion("n9.0.3-test"),
    );

    embedder.info.id = "fake-embedder@test-2";
    expect((await indexRoot(root, baseOptions(newerDecoder))).processed).toBe(1);
    expect((await store.listChunksByPath(root.id, "clip.mp4"))[0]?.media?.embedderId).toBe("fake-embedder@test-2");
  });

  it("音軌開啟後重跑：從只有畫面重建為畫面＋音軌", async () => {
    await fs.writeFile(path.join(dir, "clip.mp4"), Buffer.from("toggle-audio"));
    const root = await addRoot(["video"]);
    const decoder = new FakeDecoder({
      probeResult: makeProbe({ durationSeconds: 8, hasAudio: true, audioStreams: [aacStream()], selectedAudio: aacStream() }),
      visuals: visualSegments(8), audios: audioSegments(8),
    });
    expect((await indexRoot(root, baseOptions(decoder))).processed).toBe(1);
    expect(await store.listChunksByPath(root.id, "clip.mp4")).toHaveLength(2);

    const updated = { ...root, modalities: ["video", "audio"] as Modality[] };
    expect((await indexRoot(updated, baseOptions(decoder))).processed).toBe(1);
    const chunks = await store.listChunksByPath(root.id, "clip.mp4");
    expect(chunks.map((chunk) => chunk.media?.track)).toEqual(["video", "video-audio", "video"]);
  });

  it("取消：不發布部分索引，快照清除，重跑補齊", async () => {
    await fs.writeFile(path.join(dir, "clip.mp4"), Buffer.from("cancel-video"));
    const controller = new AbortController();
    const decoder = new FakeDecoder({ probeResult: makeProbe({ durationSeconds: 8 }), visuals: visualSegments(8) });
    const root = await addRoot(["video"]);
    const original = embedder.embedVideo.bind(embedder);
    let calls = 0;
    const spy = vi.spyOn(embedder, "embedVideo").mockImplementation(async (input, opts) => {
      const vector = await original(input, opts);
      calls += 1;
      if (calls === 1) controller.abort();
      return vector;
    });

    await expect(indexRoot(root, baseOptions(decoder, { signal: controller.signal }))).rejects.toMatchObject({ name: "AbortError" });
    expect(await store.listChunksByPath(root.id, "clip.mp4")).toEqual([]);
    expect(await vec.count()).toBe(0);
    expect(existsSync(decoder.sources[0]!)).toBe(false);

    spy.mockRestore();
    expect((await indexRoot(root, baseOptions(decoder))).processed).toBe(1);
    expect(await vec.count()).toBe(2);
  });

  it("deterministic 解碼錯誤記 skipped 並清除舊索引，不記 failed", async () => {
    await fs.writeFile(path.join(dir, "clip.mp4"), Buffer.from("decode-error"));
    const root = await addRoot(["video"]);
    const good = new FakeDecoder({ probeResult: makeProbe({ durationSeconds: 8 }), visuals: visualSegments(8) });
    expect((await indexRoot(root, baseOptions(good))).processed).toBe(1);
    // 內容改變（hash 不同）才會進解碼；否則增量會先判定 unchanged、根本不會解碼。
    await fs.writeFile(path.join(dir, "clip.mp4"), Buffer.from("decode-error-v2"));

    const bad = new FakeDecoder({
      probeResult: makeProbe({ durationSeconds: 8 }),
      visuals: visualSegments(8),
      visualErrorBefore: { index: 1, error: new MediaDecoderError("invalid-video") },
    });
    const result = await indexRoot(root, baseOptions(bad));
    expect(result.skippedFiles).toEqual([{ relPath: "clip.mp4", reason: "invalid-video" }]);
    expect(result.failedFiles).toEqual([]);
    expect(await store.listChunksByPath(root.id, "clip.mp4")).toEqual([]);
    expect(await vec.count()).toBe(0);
    expect(existsSync(bad.sources[0]!)).toBe(false);
  });

  it("推論失敗：整檔 failed 不寫部分資料，失敗檔保留舊索引，其他檔案照常", async () => {
    await fs.writeFile(path.join(dir, "clip.mp4"), Buffer.from("model-failure"));
    await fs.writeFile(path.join(dir, "note.txt"), "獨立的文字資料");
    const root = await addRoot(["video", "text"]);
    const decoder = new FakeDecoder({ probeResult: makeProbe({ durationSeconds: 8 }), visuals: visualSegments(8) });
    const original = embedder.embedVideo.bind(embedder);
    let calls = 0;
    vi.spyOn(embedder, "embedVideo").mockImplementation(async (input, opts) => {
      if (++calls === 2) throw Object.assign(new Error("模型失敗"), { code: "EMODELFAIL" });
      return original(input, opts);
    });

    const result = await indexRoot(root, baseOptions(decoder));
    expect(result.processed).toBe(1);
    expect(result.failedFiles).toEqual([{ relPath: "clip.mp4", reason: "EMODELFAIL" }]);
    expect(await store.listChunksByPath(root.id, "clip.mp4")).toEqual([]);
    expect(await vec.count()).toBe(1);
    expect(existsSync(decoder.sources[0]!)).toBe(false);
  });

  it("decoder 不可用：影片檔逐檔 failed（可重試），其他模態照常完成", async () => {
    await fs.writeFile(path.join(dir, "clip.mp4"), Buffer.from("no-decoder"));
    await fs.writeFile(path.join(dir, "note.txt"), "文字仍要索引");
    const root = await addRoot(["video", "text"]);
    const decoder = new FakeDecoder({ availability: { available: false, reason: "missing-ffmpeg" } });

    const result = await indexRoot(root, baseOptions(decoder));
    expect(result.processed).toBe(1);
    expect(result.failedFiles).toEqual([{ relPath: "clip.mp4", reason: "video-decoder-unavailable" }]);
    expect(result.skippedFiles).toEqual([]);
    expect(decoder.calls.probe).toBe(0);
    expect(await store.listChunksByPath(root.id, "clip.mp4")).toEqual([]);
  });

  it("未提供 decoder 或 embedder 無 video 能力：影片照舊 unsupported-modality", async () => {
    await fs.writeFile(path.join(dir, "clip.mp4"), Buffer.from("not-wired"));
    const root = await addRoot(["video"]);
    const decoder = new FakeDecoder();

    const noDecoder = await indexRoot(root, { store, vec, embedder });
    expect(noDecoder.total).toBe(0);
    expect(noDecoder.scanSkippedFiles).toEqual([{ relPath: "clip.mp4", reason: "unsupported-modality" }]);

    embedder.info.capabilities.video = false;
    const noCapability = await indexRoot(root, { store, vec, embedder, decoder });
    expect(noCapability.total).toBe(0);
    expect(noCapability.scanSkippedFiles).toEqual([{ relPath: "clip.mp4", reason: "unsupported-modality" }]);
    expect(decoder.calls.availability).toBe(0);
  });

  it("probe 政策：無影像流／解析度／時長／不支援容器各有具名 skip", async () => {
    await fs.writeFile(path.join(dir, "clip.mp4"), Buffer.from("policy"));
    const root = await addRoot(["video"]);

    const noStream = await indexRoot(root, baseOptions(new FakeDecoder({
      probeResult: makeProbe({ hasVideo: false, video: null }),
    })));
    expect(noStream.skippedFiles).toEqual([{ relPath: "clip.mp4", reason: "video-no-stream" }]);

    const tooBig = await indexRoot(root, baseOptions(new FakeDecoder({
      probeResult: makeProbe({ video: { codec: "h264", width: 2000, height: 2000, rotationDegrees: 0, avgFrameRate: "25/1", rFrameRate: "25/1" } }),
    })));
    expect(tooBig.skippedFiles).toEqual([{ relPath: "clip.mp4", reason: "video-resolution-exceeded" }]);

    const tooLong = await indexRoot(root, baseOptions(new FakeDecoder({
      probeResult: makeProbe({ durationSeconds: 601 }),
    })));
    expect(tooLong.skippedFiles).toEqual([{ relPath: "clip.mp4", reason: "video-duration-exceeded" }]);

    const container = await indexRoot(root, baseOptions(new FakeDecoder({
      probeError: new MediaDecoderError("unsupported-video-container"),
    })));
    expect(container.skippedFiles).toEqual([{ relPath: "clip.mp4", reason: "unsupported-video-format" }]);

    const codec = await indexRoot(root, baseOptions(new FakeDecoder({
      probeResult: makeProbe({ video: { codec: "hevc", width: 64, height: 36, rotationDegrees: 0, avgFrameRate: "25/1", rFrameRate: "25/1" } }),
    })));
    expect(codec.skippedFiles).toEqual([{ relPath: "clip.mp4", reason: "unsupported-video-codec" }]);
  });

  it("掃描後檔案變大：快照前就以 video-too-large 擋下，不進 probe", async () => {
    const file = path.join(dir, "grow.mp4");
    await fs.writeFile(file, Buffer.alloc(100, 1));
    const root = await addRoot(["video"]);
    const decoder = new FakeDecoder({ probeResult: makeProbe({ durationSeconds: 4 }), visuals: visualSegments(4) });
    const list = store.listRelPaths.bind(store);
    vi.spyOn(store, "listRelPaths").mockImplementationOnce(async (id) => {
      await fs.writeFile(file, Buffer.alloc(2000, 1));
      return list(id);
    });

    const result = await indexRoot(root, baseOptions(decoder, { videoMaxFileBytes: 1000 }));
    expect(result.skippedFiles).toEqual([{ relPath: "grow.mp4", reason: "video-too-large" }]);
    expect(decoder.calls.probe).toBe(0);
    expect(await vec.count()).toBe(0);
  });

  it("decoder 名額：多個影片檔同時排隊時，視覺解碼同時最多 1 個", async () => {
    for (let index = 0; index < 3; index += 1) {
      await fs.writeFile(path.join(dir, `v${index}.mp4`), Buffer.alloc(50, index + 1));
    }
    const root = await addRoot(["video"]);
    const decoder = new FakeDecoder({
      probeResult: makeProbe({ durationSeconds: 8 }),
      visuals: visualSegments(8),
      yieldDelayMs: 5,
    });

    const result = await indexRoot(root, baseOptions(decoder, { concurrency: 20 }));
    expect(result.processed).toBe(3);
    // D4：名額以每次 next() 為單位，因此兩個檔案的 generator 可以同時存活（peakVisual 可 >1），
    // 但同時執行中的 next() 必須 ≤ 1。
    expect(decoder.peakNext).toBe(1);
    expect(decoder.peakVisual).toBeLessThanOrEqual(2);
  });

  it("階段計時沿用既有 5 種 stage（不新增 server 不認得的階段）", async () => {
    await fs.writeFile(path.join(dir, "clip.mp4"), Buffer.from("timing"));
    const root = await addRoot(["video"]);
    const decoder = new FakeDecoder({ probeResult: makeProbe({ durationSeconds: 8 }), visuals: visualSegments(8) });
    const stages: string[] = [];
    await indexRoot(root, baseOptions(decoder, { onTiming: (event) => stages.push(event.stage) }));
    expect(stages).toContain("read");
    expect(stages).toContain("prepare");
    expect(stages).toContain("embed");
    expect(stages).toContain("write");
    expect(stages.every((stage) => ["scan", "read", "prepare", "embed", "write"].includes(stage))).toBe(true);
  });
});

// 真 decoder 端到端（gated）：Windows x64＋A1 的 LGPL static 候選；缺 env 整段 skip，CI 不依賴。
const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, "../../..");
const ffmpegPath = process.env.MNEMOSHELF_FFMPEG_PATH ?? "";
const ffprobePath = process.env.MNEMOSHELF_FFPROBE_PATH ?? "";
const fixturesDir = process.env.MNEMOSHELF_VIDEO_FIXTURES_DIR ?? path.join(repoRoot, ".tmp/video-a/decoder/fixtures");
const gated = process.platform === "win32"
  && ffmpegPath.length > 0 && ffprobePath.length > 0
  && existsSync(ffmpegPath) && existsSync(ffprobePath) && existsSync(fixturesDir);

describe.skipIf(!gated)("影片索引（gated 真 decoder）", () => {
  async function copyFixture(name: string, target: string): Promise<Buffer> {
    const bytes = await fs.readFile(path.join(fixturesDir, name));
    await fs.writeFile(path.join(dir, target), bytes);
    return bytes;
  }

  function realDecoder(): FfmpegMediaDecoder {
    return new FfmpegMediaDecoder({ ffmpegPath, ffprobePath });
  }

  it("h264-aac-4s：畫面＋音軌端到端，來回定位，重跑未變不重解碼", async () => {
    const bytes = await copyFixture("h264-aac-4s-faststart.mp4", "clip.mp4");
    const root = await addRoot(["video", "audio"]);
    const embedVideo = vi.spyOn(embedder, "embedVideo");
    const embedAudio = vi.spyOn(embedder, "embedAudio");

    const result = await indexRoot(root, { store, vec, embedder, decoder: realDecoder() });
    expect(result.processed).toBe(1);
    expect(result.failedFiles).toEqual([]);
    expect(result.skippedFiles).toEqual([]);

    const chunks = await store.listChunksByPath(root.id, "clip.mp4");
    expect(chunks.map((chunk) => chunk.kind)).toEqual(["video", "audio"]);
    expect(chunks.map((chunk) => chunk.media?.track)).toEqual(["video", "video-audio"]);
    expect(chunks[0]?.media?.frameTimesSeconds).toHaveLength(1);
    expect(chunks[0]?.media?.preprocessVersion?.startsWith("mp4-h264-rgb24-v4:4s:1f:384:srcpts-v3:ffmpeg-")).toBe(true);
    expect(chunks[1]?.media?.preprocessVersion?.startsWith("mp4-aac-mono16k-v2:10s:clamp-v1:stream-align-v1:audio-pad160-v1:ffmpeg-")).toBe(true);
    expect(chunks[1]?.media?.streamIndex).toBeTypeOf("number");
    expect(chunks.every((chunk) => chunk.contentHash === sha256(bytes))).toBe(true);
    expect(await vec.count()).toBe(2);
    expect(embedVideo).toHaveBeenCalledTimes(1);
    expect(embedAudio).toHaveBeenCalledTimes(1);

    expect((await indexRoot(root, { store, vec, embedder, decoder: realDecoder() })).skippedUnchanged).toBe(1);
    expect(embedVideo).toHaveBeenCalledTimes(1);
  }, 120_000);

  it("h264-only-4s：無音軌仍成功（audio 模態開啟）", async () => {
    await copyFixture("h264-only-4s.mp4", "visual.mp4");
    const root = await addRoot(["video", "audio"]);
    const result = await indexRoot(root, { store, vec, embedder, decoder: realDecoder() });
    expect(result.processed).toBe(1);
    expect(result.failedFiles).toEqual([]);
    const chunks = await store.listChunksByPath(root.id, "visual.mp4");
    expect(chunks.map((chunk) => chunk.kind)).toEqual(["video"]);
  }, 120_000);

  it("h264-ac3-4s：audio 開啟時整檔具名跳過，不寫部分索引", async () => {
    await copyFixture("h264-ac3-4s.mp4", "ac3.mp4");
    const root = await addRoot(["video", "audio"]);
    const result = await indexRoot(root, { store, vec, embedder, decoder: realDecoder() });
    expect(result.skippedFiles).toEqual([{ relPath: "ac3.mp4", reason: "unsupported-video-audio-track" }]);
    expect(result.failedFiles).toEqual([]);
    expect(await store.listChunksByPath(root.id, "ac3.mp4")).toEqual([]);
    expect(await vec.count()).toBe(0);
  }, 120_000);

  it("aac-only.mp4：沒有影像流記 video-no-stream，不是 decode failed", async () => {
    await copyFixture("aac-only.mp4", "audio-only.mp4");
    const root = await addRoot(["video"]);
    const result = await indexRoot(root, { store, vec, embedder, decoder: realDecoder() });
    expect(result.skippedFiles).toEqual([{ relPath: "audio-only.mp4", reason: "video-no-stream" }]);
    expect(result.failedFiles).toEqual([]);
    expect(await vec.count()).toBe(0);
  }, 120_000);

  it("corrupt-garbage.mp4：壞檔記 invalid-video，不讓整輪 failed", async () => {
    await copyFixture("corrupt-garbage.mp4", "bad.mp4");
    const root = await addRoot(["video"]);
    const result = await indexRoot(root, { store, vec, embedder, decoder: realDecoder() });
    expect(result.skippedFiles).toEqual([{ relPath: "bad.mp4", reason: "invalid-video" }]);
    expect(result.failedFiles).toEqual([]);
  }, 120_000);
});
