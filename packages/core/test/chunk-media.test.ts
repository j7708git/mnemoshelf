import { describe, expect, it } from "vitest";
import {
  assignChunkMediaSeq,
  CHUNK_MEDIA_CONTAINERS,
  CHUNK_MEDIA_MAX_FRAME_TIMES,
  CHUNK_MEDIA_TRACKS,
  compareChunkMediaOrder,
  normalizeChunkMedia,
} from "../src/ports/metadata-store.js";
import type { ChunkMedia } from "../src/ports/types.js";

/** 舊音訊資料（音訊里程碑寫入的形狀）：沒有 container／streamIndex／frameTimesSeconds。 */
const LEGACY_AUDIO: ChunkMedia = {
  startSeconds: 10,
  endSeconds: 20.125,
  track: "audio",
  preprocessVersion: "wav-pcm-mono16k-sinc-v1:10s:audio-pad160-v1",
  embedderId: "audio-test",
  embeddingDim: 512,
};

function visual(overrides: Partial<ChunkMedia> = {}): ChunkMedia {
  return {
    startSeconds: 0,
    endSeconds: 4,
    track: "video",
    container: "mp4",
    frameTimesSeconds: [2],
    preprocessVersion: "video-1fps-4s-384:decoder-test",
    embedderId: "video-test",
    embeddingDim: 512,
    ...overrides,
  };
}

function videoAudio(overrides: Partial<ChunkMedia> = {}): ChunkMedia {
  return {
    startSeconds: 0,
    endSeconds: 10,
    track: "video-audio",
    container: "mp4",
    streamIndex: 1,
    preprocessVersion: "audio-mono16k-v1:10s",
    embedderId: "audio-test",
    embeddingDim: 512,
    ...overrides,
  };
}

describe("normalizeChunkMedia：舊資料相容", () => {
  it("只帶舊欄位的 audio 列可讀，且不補新鍵（不得變成 container: undefined）", () => {
    const normalized = normalizeChunkMedia(LEGACY_AUDIO);
    expect(normalized).toEqual(LEGACY_AUDIO);
    expect(normalized).not.toHaveProperty("container");
    expect(normalized).not.toHaveProperty("streamIndex");
    expect(normalized).not.toHaveProperty("frameTimesSeconds");
    expect(normalized).not.toBe(LEGACY_AUDIO);
  });

  it("undefined／null 代表舊版或非時間型 chunk", () => {
    expect(normalizeChunkMedia(undefined)).toBeUndefined();
    expect(normalizeChunkMedia(null)).toBeUndefined();
  });
});

describe("normalizeChunkMedia：影片欄位", () => {
  it("track 三值白名單與 container 白名單是 runtime 契約", () => {
    expect(CHUNK_MEDIA_TRACKS).toEqual(["audio", "video", "video-audio"]);
    expect(CHUNK_MEDIA_CONTAINERS).toEqual(["wav", "mp4"]);
    expect(normalizeChunkMedia(visual())).toEqual(visual());
    expect(normalizeChunkMedia(videoAudio())).toEqual(videoAudio());
    expect(normalizeChunkMedia({ ...LEGACY_AUDIO, container: "wav" })).toEqual({ ...LEGACY_AUDIO, container: "wav" });
  });

  it("畫面片段接受多幀、非遞減、落在片段區間內", () => {
    const media = visual({ startSeconds: 0, endSeconds: 4, frameTimesSeconds: [0, 2, 2, 4] });
    expect(normalizeChunkMedia(media)).toEqual(media);
  });

  it("幀時間陣列會複製，呼叫端之後改動不影響已驗證結果", () => {
    const media = visual();
    const normalized = normalizeChunkMedia(media);
    expect(normalized?.frameTimesSeconds).not.toBe(media.frameTimesSeconds);
    media.frameTimesSeconds?.push(99);
    expect(normalized?.frameTimesSeconds).toEqual([2]);
  });

  it("畫面片段缺 frameTimesSeconds 一律拒絕（不得只靠不明確的時間推測）", () => {
    const { frameTimesSeconds: _omitted, ...withoutFrames } = visual();
    expect(() => normalizeChunkMedia(withoutFrames)).toThrow(TypeError);
  });

  it("音軌片段不得帶 frameTimesSeconds；影片音軌必填 streamIndex", () => {
    expect(() => normalizeChunkMedia(visual({ track: "video-audio", streamIndex: 1 }))).toThrow(TypeError);
    expect(() => normalizeChunkMedia(videoAudio({ frameTimesSeconds: [1] }))).toThrow(TypeError);
    const { streamIndex: _omitted, ...withoutStream } = videoAudio();
    expect(() => normalizeChunkMedia(withoutStream)).toThrow(TypeError);
  });

  it("非法影片欄位（時間、幀數、streamIndex、container、track）全部拒絕", () => {
    const invalid: unknown[] = [
      visual({ startSeconds: -1 }),
      visual({ endSeconds: 0 }),
      visual({ endSeconds: Number.POSITIVE_INFINITY }),
      visual({ startSeconds: Number.NaN }),
      visual({ frameTimesSeconds: [] }),
      visual({ frameTimesSeconds: [5] }),
      visual({ frameTimesSeconds: [-1] }),
      visual({ frameTimesSeconds: [3, 1] }),
      visual({ frameTimesSeconds: [Number.NaN] }),
      visual({ frameTimesSeconds: Array.from({ length: CHUNK_MEDIA_MAX_FRAME_TIMES + 1 }, () => 1) }),
      visual({ streamIndex: -1 }),
      visual({ streamIndex: 1.5 }),
      visual({ container: "webm" as never }),
      visual({ track: "bogus" as never }),
      videoAudio({ streamIndex: -1 }),
      videoAudio({ streamIndex: 2.5 }),
      videoAudio({ container: "mkv" as never }),
      { ...LEGACY_AUDIO, frameTimesSeconds: [11] },
      { ...LEGACY_AUDIO, track: "video" },
    ];
    for (const item of invalid) expect(() => normalizeChunkMedia(item)).toThrow(TypeError);
    expect(() => normalizeChunkMedia("audio")).toThrow(TypeError);
    expect(() => normalizeChunkMedia([])).toThrow(TypeError);
  });
});

describe("seq 規則：同檔跨軌唯一且可重現", () => {
  it("compareChunkMediaOrder：startSeconds 升冪，同時刻畫面先於音軌", () => {
    const early = visual({ startSeconds: 0, endSeconds: 4 });
    const late = visual({ startSeconds: 4, endSeconds: 8, frameTimesSeconds: [6] });
    expect(compareChunkMediaOrder(early, late)).toBeLessThan(0);
    expect(compareChunkMediaOrder(late, early)).toBeGreaterThan(0);
    // 同起點：video(0) → video-audio(1) → audio(2)
    expect(compareChunkMediaOrder(visual(), videoAudio())).toBeLessThan(0);
    // 同起點時音軌（video-audio）先於舊音訊（audio）。
    const sameStartAudio = { ...LEGACY_AUDIO, startSeconds: 0, endSeconds: 5 };
    expect(compareChunkMediaOrder(videoAudio(), sameStartAudio)).toBeLessThan(0);
    expect(compareChunkMediaOrder(sameStartAudio, videoAudio())).toBeGreaterThan(0);
    expect(compareChunkMediaOrder(LEGACY_AUDIO, LEGACY_AUDIO)).toBe(0);
    // endSeconds 決勝；再相同時比第一個幀時間。
    const shorter = visual({ endSeconds: 3, frameTimesSeconds: [1] });
    expect(compareChunkMediaOrder(shorter, visual())).toBeLessThan(0);
    const laterFrame = visual({ frameTimesSeconds: [3] });
    expect(compareChunkMediaOrder(visual(), laterFrame)).toBeLessThan(0);
  });

  it("assignChunkMediaSeq：交錯的畫面與音軌片段得到 0..n-1、不重複", () => {
    const chunks = assignChunkMediaSeq([
      { seq: 99, kind: "audio", media: videoAudio({ startSeconds: 10, endSeconds: 20 }) },
      { seq: 99, kind: "video", media: visual({ startSeconds: 8, endSeconds: 12, frameTimesSeconds: [10] }) },
      { seq: 99, kind: "audio", media: videoAudio() },
      { seq: 99, kind: "video", media: visual() },
      { seq: 99, kind: "video", media: visual({ startSeconds: 4, endSeconds: 8, frameTimesSeconds: [6] }) },
    ]);
    expect(chunks.map((chunk) => chunk.seq)).toEqual([0, 1, 2, 3, 4]);
    expect(chunks.map((chunk) => chunk.media.track)).toEqual(["video", "video-audio", "video", "video", "video-audio"]);
    expect(new Set(chunks.map((chunk) => chunk.seq)).size).toBe(chunks.length);
    // 重跑（傳入已編號的結果）必須得到相同順序：穩定、可重現。
    expect(assignChunkMediaSeq(chunks).map((chunk) => chunk.media.startSeconds)).toEqual(
      chunks.map((chunk) => chunk.media.startSeconds),
    );
  });

  it("純音訊檔的結果與現行 seq=片段索引 相同（舊資料不必重編號）", () => {
    const chunks = Array.from({ length: 5 }, (_, index) => ({
      seq: 0,
      kind: "audio" as const,
      media: { ...LEGACY_AUDIO, startSeconds: index * 10, endSeconds: index * 10 + 10 },
    }));
    expect(assignChunkMediaSeq(chunks).map((chunk) => chunk.seq)).toEqual([0, 1, 2, 3, 4]);
  });

  it("不改傳入物件；空陣列回空陣列", () => {
    const input = [
      { seq: 7, kind: "audio", media: videoAudio() },
      { seq: 7, kind: "video", media: visual() },
    ];
    const output = assignChunkMediaSeq(input);
    expect(output.map((chunk) => chunk.seq)).toEqual([0, 1]);
    expect(input.map((chunk) => chunk.seq)).toEqual([7, 7]);
    expect(assignChunkMediaSeq([])).toEqual([]);
  });
});
