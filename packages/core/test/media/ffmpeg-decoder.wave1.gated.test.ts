/**
 * 波次一 D1／D2 回歸（gated 真 ffmpeg）：短尾段、來源 PTS、稀疏時間線、音軌 stream 時間線。
 *
 * 契約：project-notes/projects/mnemoshelf/research/2026-11-08-video-wave1-fix-contract.md D1／D2。
 * 缺 env／非 Windows／缺 fixture 整組 skip；fixture 由 `generate-wave1-fixtures.mjs` 合成到
 * `.tmp/wave1/fixtures`（已忽略），不得依賴私人媒體。
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FfmpegMediaDecoder, MediaDecoderError } from "../../src/media/index.js";
import type { VideoProbe, VisualSegment } from "../../src/media/index.js";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, "../../../..");
const ffmpegPath = process.env.MNEMOSHELF_FFMPEG_PATH ?? "";
const ffprobePath = process.env.MNEMOSHELF_FFPROBE_PATH ?? "";
const fixtureDir = process.env.MNEMOSHELF_WAVE1_FIXTURES ?? path.join(repoRoot, ".tmp", "wave1", "fixtures");
const gated = process.platform === "win32"
  && ffmpegPath.length > 0 && ffprobePath.length > 0
  && existsSync(ffmpegPath) && existsSync(ffprobePath) && existsSync(fixtureDir);

function fixture(name: string): string { return path.join(fixtureDir, name); }
function decoder(): FfmpegMediaDecoder { return new FfmpegMediaDecoder({ ffmpegPath, ffprobePath }); }

/** 用 ffprobe 取權威的來源 frame pts（影音共用播放時間軸：減去 format start）。 */
function sourceFrameTimes(file: string): number[] {
  const stream = spawnSync(ffprobePath, ["-v", "error", "-show_entries", "format=start_time", "-of", "csv=p=0", file], { encoding: "utf8", windowsHide: true });
  const start = Number(stream.stdout.trim()) || 0;
  const result = spawnSync(ffprobePath, ["-v", "error", "-select_streams", "v:0", "-show_frames", "-show_entries", "frame=pts_time", "-of", "csv=p=0", file], { encoding: "utf8", windowsHide: true });
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^-?\d+(?:\.\d+)?$/.test(line))
    .map((line) => Number(line) - start)
    .filter((value) => Number.isFinite(value));
}

/** 依 D1 規則計算預期片段與選幀（測試端獨立重算，不呼叫實作）。 */
function expectedSegments(probe: VideoProbe, times: number[]): { start: number; end: number; frame: number }[] {
  const segmentSeconds = 4;
  const duration = probe.durationSeconds;
  const count = Math.max(1, Math.ceil(duration / segmentSeconds));
  const segments: { start: number; end: number; frame: number }[] = [];
  for (let index = 0; index < count; index += 1) {
    const start = index * segmentSeconds;
    const end = Math.min(duration, start + segmentSeconds);
    const inSegment = times.filter((time) => time >= start - 1e-6 && time < end - 1e-6);
    const isTail = end - start < segmentSeconds - 1e-6;
    let frame: number | undefined;
    if (isTail) frame = inSegment.at(-1);
    else frame = inSegment.find((time) => time >= start + segmentSeconds / 2 - 1e-6) ?? inSegment.at(-1);
    expect(frame, "segment 至少一幀").toBeTypeOf("number");
    segments.push({ start, end, frame: frame! });
  }
  return segments;
}

async function collect(decoderInstance: FfmpegMediaDecoder, file: string, probe: VideoProbe): Promise<VisualSegment[]> {
  const segments: VisualSegment[] = [];
  for await (const segment of decoderInstance.decodeVisualSegments({ path: file }, { probe })) segments.push(segment);
  return segments;
}

describe.skipIf(!gated)("波次一 D1：短尾段與來源 PTS（真 ffmpeg）", () => {
  it.each(["tail-0.2.mp4", "tail-4.2.mp4", "tail-4.8.mp4", "tail-8.2.mp4"])("正常短尾段 %s 全成功且段數＝ceil(duration/4)", async (name) => {
    const instance = decoder();
    const file = fixture(name);
    const probe = await instance.probe({ path: file });
    const times = sourceFrameTimes(file);
    expect(times.length).toBeGreaterThan(0);
    const expected = expectedSegments(probe, times);
    const segments = await collect(instance, file, probe);
    expect(segments).toHaveLength(expected.length);
    for (let index = 0; index < expected.length; index += 1) {
      const actual = segments[index]!;
      expect(actual.startSeconds).toBeCloseTo(expected[index]!.start, 6);
      expect(actual.endSeconds).toBeCloseTo(expected[index]!.end, 6);
      expect(actual.frames).toHaveLength(1);
      const frame = actual.frames[0]!;
      expect(Math.abs(frame.timestampSeconds - expected[index]!.frame)).toBeLessThanOrEqual(1e-3);
      expect(frame.timestampSeconds).toBeGreaterThanOrEqual(actual.startSeconds - 1e-6);
      expect(frame.timestampSeconds).toBeLessThanOrEqual(actual.endSeconds + 1e-6);
    }
    const tail = segments.at(-1)!;
    expect(Number.isInteger(tail.frames[0]!.timestampSeconds)).toBe(false);
  }, 60_000);

  // Lead 複驗 P1：尾段內含中點格點時，grid 條件不得多選尾段內的格點。
  it.each(["tail-grid-3.9.mp4", "tail-grid-6.2.mp4", "tail-grid-7.9.mp4", "tail-grid-10.2.mp4", "tail-grid-12.2.mp4", "tail-grid-16.2.mp4"])(
    "尾段格點回歸 %s：段數＝ceil(duration/4)、每段 PTS＝實際來源 PTS",
    async (name) => {
      const instance = decoder();
      const file = fixture(name);
      const probe = await instance.probe({ path: file });
      const times = sourceFrameTimes(file);
      const expected = expectedSegments(probe, times);
      const segments = await collect(instance, file, probe);
      expect(segments).toHaveLength(expected.length);
      expect(segments).toHaveLength(Math.ceil(probe.durationSeconds / 4));
      for (let index = 0; index < expected.length; index += 1) {
        const actual = segments[index]!;
        expect(actual.startSeconds).toBeCloseTo(expected[index]!.start, 6);
        expect(actual.endSeconds).toBeCloseTo(expected[index]!.end, 6);
        expect(actual.frames).toHaveLength(1);
        expect(Math.abs(actual.frames[0]!.timestampSeconds - expected[index]!.frame)).toBeLessThanOrEqual(1e-3);
      }
    },
    60_000,
  );

  it("599 秒（mod 4 = 3，尾段含 598 格點）：150 段完整、尾段取實際最後一幀", async () => {
    const instance = decoder();
    const file = fixture("long-599s-grid.mp4");
    const probe = await instance.probe({ path: file });
    const times = sourceFrameTimes(file);
    const expected = expectedSegments(probe, times);
    const segments = await collect(instance, file, probe);
    expect(segments).toHaveLength(150);
    expect(segments).toHaveLength(expected.length);
    expect(expected.at(-1)!.frame).toBeCloseTo(598.933333, 3);
    for (let index = 0; index < expected.length; index += 1) {
      expect(segments[index]!.startSeconds).toBeCloseTo(expected[index]!.start, 6);
      expect(segments[index]!.endSeconds).toBeCloseTo(expected[index]!.end, 6);
      expect(Math.abs(segments[index]!.frames[0]!.timestampSeconds - expected[index]!.frame)).toBeLessThanOrEqual(1e-3);
    }
  }, 180_000);
  it("稀疏時間線（0/5/10 秒有幀）：每段以 fallback 取段內最後一幀", async () => {
    const instance = decoder();
    const file = fixture("sparse-12s.mp4");
    const probe = await instance.probe({ path: file });
    const segments = await collect(instance, file, probe);
    expect(segments).toHaveLength(Math.ceil(probe.durationSeconds / 4));
    expect(segments.map((segment) => segment.frames[0]!.timestampSeconds)).toEqual([0, 5, 10]);
  }, 60_000);

  it("時間線有缺口（segment 完全沒有幀）→ 具名 unsupported-video-timeline，不是 invalid-video", async () => {
    const instance = decoder();
    const file = fixture("sparse-gap-13s.mp4");
    let code: string | undefined;
    try {
      const probe = await instance.probe({ path: file });
      for await (const _ of instance.decodeVisualSegments({ path: file }, { probe })) { /* consume */ }
    } catch (error) {
      code = error instanceof MediaDecoderError ? error.code : "unexpected:" + String(error);
    }
    expect(code).toBe("unsupported-video-timeline");
  }, 60_000);

  it("非零 container start_time：時間軸正規化到播放時間軸 0-based，probe 保留 sourceStartSeconds", async () => {
    const instance = decoder();
    const file = path.join(repoRoot, ".tmp", "video-a", "decoder", "fixtures", "nonzero-start-4s.mp4");
    const probe = await instance.probe({ path: file });
    expect(probe.sourceStartSeconds).toBeCloseTo(5, 3);
    const segments = await collect(instance, file, probe);
    expect(segments).toHaveLength(1);
    expect(segments[0]!.startSeconds).toBe(0);
    expect(segments[0]!.frames[0]!.timestampSeconds).toBeCloseTo(2, 3);
  }, 60_000);

  it("edit list／-ss copy 重包：時間軸仍可定義 → 1 段、最後幀是實際 PTS 1.96", async () => {
    const instance = decoder();
    const file = fixture("editlist-2s.mp4");
    const probe = await instance.probe({ path: file });
    expect(probe.durationSeconds).toBeCloseTo(2, 3);
    const segments = await collect(instance, file, probe);
    expect(segments).toHaveLength(1);
    expect(segments[0]!.startSeconds).toBe(0);
    expect(segments[0]!.endSeconds).toBeCloseTo(2, 3);
    // 來源是 30 fps 的 tail-4.8 重包；尾段最後一幀＝1.966667（不是抽樣格線的整數秒）。
    expect(segments[0]!.frames[0]!.timestampSeconds).toBeCloseTo(1.966667, 3);
  }, 60_000);

  it.skipIf(!existsSync(path.join(repoRoot, ".tmp", "video-a", "decoder", "fixtures", "long-600s-360p.mp4")))("600 秒長片：格線壓縮 select 完整輸出 150 段、時間軸連續", async () => {
    const file = path.join(repoRoot, ".tmp", "video-a", "decoder", "fixtures", "long-600s-360p.mp4");
    const instance = decoder();
    const probe = await instance.probe({ path: file });
    const segments = await collect(instance, file, probe);
    expect(segments).toHaveLength(150);
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index]!;
      expect(segment.startSeconds).toBeCloseTo(index * 4, 6);
      expect(segment.endSeconds).toBeCloseTo(Math.min(600, index * 4 + 4), 6);
      expect(segment.frames).toHaveLength(1);
      expect(segment.frames[0]!.timestampSeconds).toBeGreaterThanOrEqual(segment.startSeconds - 1e-6);
      expect(segment.frames[0]!.timestampSeconds).toBeLessThan(segment.endSeconds - 1e-6 + 1e-6);
      if (index > 0) expect(segment.frames[0]!.timestampSeconds).toBeGreaterThan(segments[index - 1]!.frames[0]!.timestampSeconds);
    }
    expect(segments[0]!.frames[0]!.timestampSeconds).toBeCloseTo(2, 3);
  }, 180_000);

  it("視覺前處理版本已 bump 到 v2（srcpts）", async () => {
    const probe = await decoder().probe({ path: fixture("tail-4.8.mp4") });
    const segments = await collect(decoder(), fixture("tail-4.8.mp4"), probe);
    expect(segments[0]!.preprocessingVersion).toBe("mp4-h264-rgb24-v4:4s:1f:384:srcpts-v3");
  }, 60_000);
});

describe.skipIf(!gated)("波次一 D2：音軌 stream 時間線（真 ffmpeg）", () => {
  it("probe 帶 per-stream start／duration／initial_padding（11.8 秒 AAC）", async () => {
    const probe = await decoder().probe({ path: fixture("video12-audio11.8.mp4") });
    expect(probe.durationSeconds).toBeCloseTo(12, 3);
    const audio = probe.selectedAudio;
    expect(audio).not.toBeNull();
    expect(audio!.durationSeconds).toBeCloseTo(11.8, 3);
    expect(audio!.startTimeSeconds).toBeCloseTo(0, 3);
    expect(audio!.initialPaddingSamples).toBe(1024);
  }, 60_000);

  it("11.8 秒 AAC 解碼：段界 [0,10]、[10,11.8]，總樣本 188800（priming 容差內）", async () => {
    const instance = decoder();
    const file = fixture("video12-audio11.8.mp4");
    const probe = await instance.probe({ path: file });
    const segments = [];
    for await (const segment of instance.decodeAudioSegments({ path: file }, { probe })) segments.push(segment);
    expect(segments).toHaveLength(2);
    expect(segments[0]!.startSeconds).toBe(0);
    expect(segments[0]!.endSeconds).toBe(10);
    expect(segments[0]!.samples).toHaveLength(160_000);
    expect(segments[1]!.startSeconds).toBe(10);
    expect(segments[1]!.endSeconds).toBeCloseTo(11.8, 3);
    expect(segments[1]!.samples).toHaveLength(28_800);
    expect(segments.map((segment) => segment.preprocessingVersion)).toEqual(["mp4-aac-mono16k-v2:10s:clamp-v1:stream-align-v1", "mp4-aac-mono16k-v2:10s:clamp-v1:stream-align-v1"]);
  }, 60_000);

  it("音軌延遲 2 秒：以靜音補齊 leading offset，輸出仍覆蓋 [0,12] 播放時間軸", async () => {
    const instance = decoder();
    const file = fixture("audio-offset-2s.mp4");
    const probe = await instance.probe({ path: file });
    const audio = probe.selectedAudio!;
    const offset = audio.startTimeSeconds! - probe.sourceStartSeconds;
    expect(offset).toBeGreaterThan(1.9);
    expect(offset).toBeLessThan(2.05);
    const segments = [];
    for await (const segment of instance.decodeAudioSegments({ path: file }, { probe })) segments.push(segment);
    expect(segments).toHaveLength(2);
    expect(segments[0]!.startSeconds).toBe(0);
    expect(segments[0]!.endSeconds).toBe(10);
    expect(segments[0]!.samples).toHaveLength(160_000);
    expect(segments[1]!.samples).toHaveLength(32_000);
    const leading = segments[0]!.samples.subarray(0, 30_000);
    expect(leading.every((value) => Math.abs(value) < 1e-6)).toBe(true);
    const tone = segments[0]!.samples.subarray(33_000, 40_000);
    const rms = Math.sqrt(tone.reduce((sum, value) => sum + value * value, 0) / tone.length);
    expect(rms).toBeGreaterThan(0.05);
  }, 60_000);
});
