/**
 * gated 真 binary 整合測試（B1）。
 *
 * 條件：Windows x64、環境變數 MNEMOSHELF_FFMPEG_PATH／MNEMOSHELF_FFPROBE_PATH 指向
 * 已下載的候選（A1 的 .tmp/video-a/decoder static 候選），fixtures 預設用
 * code repo .tmp/video-a/decoder/fixtures（可用 MNEMOSHELF_VIDEO_FIXTURES_DIR 覆寫）。
 * 缺 env 或非 Windows 時整組 skip（不把 spike 成功當產品驗收；CI 不會因缺 binary 失敗）。
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import childProcess from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FfmpegMediaDecoder, MediaDecoderError, videoAudioPreprocessingVersion, visualPreprocessingVersion, type VisualSegment } from "../../src/media/index.js";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, "../../../..");
const ffmpegPath = process.env.MNEMOSHELF_FFMPEG_PATH ?? "";
const ffprobePath = process.env.MNEMOSHELF_FFPROBE_PATH ?? "";
const fixturesDir = process.env.MNEMOSHELF_VIDEO_FIXTURES_DIR ?? path.join(repoRoot, ".tmp/video-a/decoder/fixtures");
const wave1FixturesDir = process.env.MNEMOSHELF_WAVE1_FIXTURES ?? path.join(repoRoot, ".tmp", "wave1", "fixtures");
const workDir = path.join(repoRoot, ".tmp/video-b-b1");
const evidencePath = path.join(workDir, "reports", "gated-evidence.json");
const gated = process.platform === "win32"
  && ffmpegPath.length > 0 && ffprobePath.length > 0
  && existsSync(ffmpegPath) && existsSync(ffprobePath) && existsSync(fixturesDir);

const evidence: { id: string; ok: boolean; detail: string }[] = [];
function record(id: string, detail: string): void { evidence.push({ id, ok: true, detail }); }
function fixture(name: string): string { return path.join(fixturesDir, name); }
function wave1Fixture(name: string): string { return path.join(wave1FixturesDir, name); }

/** 用真 ffmpeg 產生暫存 remux fixture（測試生成，不進版控、不新增依賴）。 */
function remux(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(ffmpegPath, args, { windowsHide: true, shell: false, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => { stderr += String(chunk); });
    child.once("error", (error) => { reject(error); });
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error("remux 失敗 code=" + String(code) + " " + stderr.slice(-500)));
    });
  });
}
function segmentFrameHash(segment: VisualSegment): string {
  return createHash("sha256").update(segment.frames[0]!.pixels).digest("hex");
}

async function codeOf(operation: Promise<unknown>): Promise<string | undefined> {
  try { await operation; return undefined; } catch (error) { return error instanceof MediaDecoderError ? error.code : `unexpected:${String(error)}`; }
}
async function collect(iterator: AsyncGenerator<VisualSegment>): Promise<VisualSegment[]> { const all: VisualSegment[] = []; for await (const segment of iterator) all.push(segment); return all; }
function approxHz(samples: Float32Array): number {
  let crossings = 0;
  for (let i = 1; i < samples.length; i += 1) if ((samples[i - 1]! < 0) !== (samples[i]! < 0)) crossings += 1;
  return crossings / 2 / (samples.length / 16000);
}
function nonBlackRatio(pixels: Uint8Array): number {
  let nonBlack = 0;
  const count = Math.floor(pixels.length / 3);
  for (let i = 0; i < count; i += 1) if (pixels[i * 3]! + pixels[i * 3 + 1]! + pixels[i * 3 + 2]! > 24) nonBlack += 1;
  return nonBlack / count;
}
/**
 * 只追蹤「這個 vitest worker 自己 spawn 的解碼 ffmpeg」pid，避免平行測試程序的全機
 * tasklist 被誤認為自己的殘留（Astra 退出條件 5 指出的既有測試缺陷）。
 */
const liveDecodeChildren = new Map<number, ChildProcess>();
const baseSpawn = childProcess.spawn;
childProcess.spawn = ((command: Parameters<typeof baseSpawn>[0], args?: Parameters<typeof baseSpawn>[1], options?: Parameters<typeof baseSpawn>[2]) => {
  const child = baseSpawn(command as never, args as never, options as never);
  const ownDecoder = ffmpegPath.length > 0
    && typeof command === "string" && command.toLowerCase() === ffmpegPath.toLowerCase()
    && Array.isArray(args) && (args.includes("rawvideo") || args.includes("f32le"));
  if (ownDecoder && child.pid !== undefined) {
    const pid = child.pid;
    liveDecodeChildren.set(pid, child);
    child.once("close", () => { liveDecodeChildren.delete(pid); });
  }
  return child;
}) as typeof baseSpawn;
// process.ts 以 ESM named import 取 spawn；sync 後才會拿到上面這個 wrapper。
syncBuiltinESMExports();
function liveDecodePids(): number[] { return [...liveDecodeChildren.keys()]; }
async function delay(ms: number): Promise<void> { await new Promise((resolve) => setTimeout(resolve, ms)); }

describe.skipIf(!gated)("FfmpegMediaDecoder（gated 真 binary；Windows x64）", () => {
  let decoder: FfmpegMediaDecoder;
  let limitedDuration: FfmpegMediaDecoder;
  let limitedPixels: FfmpegMediaDecoder;
  let limitedBytes: FfmpegMediaDecoder;
  let corruptFfprobePath = "";

  beforeAll(async () => {
    await mkdir(path.join(workDir, "reports"), { recursive: true });
    await mkdir(path.join(workDir, "corrupt"), { recursive: true });
    const head = await readFile(ffprobePath);
    corruptFfprobePath = path.join(workDir, "corrupt", "ffprobe-corrupt.exe");
    await writeFile(corruptFfprobePath, head.subarray(0, 4096));
    decoder = new FfmpegMediaDecoder({ ffmpegPath, ffprobePath });
    limitedDuration = new FfmpegMediaDecoder({ ffmpegPath, ffprobePath, limits: { maxDurationSeconds: 30 } });
    limitedPixels = new FfmpegMediaDecoder({ ffmpegPath, ffprobePath, limits: { maxPixels: 640 * 360 } });
    limitedBytes = new FfmpegMediaDecoder({ ffmpegPath, ffprobePath, limits: { maxSourceBytes: 1024 * 1024 } });
  }, 30_000);

  afterAll(async () => {
    if (!gated) return;
    const availability = await decoder.checkAvailability().catch(() => null);
    await writeFile(evidencePath, JSON.stringify({
      generatedAt: new Date().toISOString(),
      runtime: { node: process.version, platform: process.platform, arch: process.arch },
      env: { ffmpegPath, ffprobePath, fixturesDir },
      availability,
      summary: { total: evidence.length, passed: evidence.filter((entry) => entry.ok).length },
      evidence,
    }, null, 2) + "\n");
  }, 30_000);

  it("checkAvailability：真 binary 可用並回報版本", async () => {
    const availability = await decoder.checkAvailability();
    expect(availability.available).toBe(true);
    expect(availability.ffmpegVersion ?? "").toContain("ffmpeg version n9.0.2-48");
    expect(availability.ffprobeVersion ?? "").toContain("ffprobe version n9.0.2-48");
    record("availability-ok", availability.ffmpegVersion ?? "");
  });

  it("checkAvailability：缺少 ffmpeg → available=false 且不拋", async () => {
    const missing = new FfmpegMediaDecoder({ ffmpegPath: path.join(fixturesDir, "no-such-ffmpeg.exe"), ffprobePath });
    const availability = await missing.checkAvailability();
    expect(availability.available).toBe(false);
    expect(availability.reason).toBe("missing-ffmpeg");
    record("availability-missing", JSON.stringify(availability));
  });

  it("checkAvailability：損毀的 ffprobe → available=false 且不拋", async () => {
    const corrupt = new FfmpegMediaDecoder({ ffmpegPath, ffprobePath: corruptFfprobePath });
    const availability = await corrupt.checkAvailability();
    expect(availability.available).toBe(false);
    expect(availability.reason).toBeTruthy();
    record("availability-corrupt", JSON.stringify(availability));
  });

  it("probe：moov 在尾端與 faststart 都能解析（含音軌與時長）", async () => {
    for (const name of ["h264-aac-4s.mp4", "h264-aac-4s-faststart.mp4"]) {
      const probe = await decoder.probe({ path: fixture(name) });
      expect(probe.durationSeconds).toBeCloseTo(4, 3);
      expect(probe.sourceStartSeconds).toBe(0);
      expect(probe.video).toMatchObject({ codec: "h264", width: 320, height: 240, rotationDegrees: 0 });
      expect(probe.hasVideo).toBe(true);
      expect(probe.hasAudio).toBe(true);
      expect(probe.selectedAudio).toMatchObject({ codec: "aac", isAac: true, hasDefault: true });
      record("probe-" + name, "duration=4 selected=" + JSON.stringify(probe.selectedAudio));
    }
  });

  it("probe：無音軌、AC-3、雙 AAC、AAC-only、旋轉、非零 PTS、VFR、1080p", async () => {
    const noAudio = await decoder.probe({ path: fixture("h264-only-4s.mp4") });
    expect(noAudio.hasAudio).toBe(false);
    expect(noAudio.selectedAudio).toBeNull();
    record("probe-no-audio", "hasAudio=false");

    const ac3 = await decoder.probe({ path: fixture("h264-ac3-4s.mp4") });
    expect(ac3.hasAudio).toBe(true);
    expect(ac3.selectedAudio?.codec).toBe("ac3");
    expect(ac3.selectedAudio?.isAac).toBe(false);
    record("probe-ac3", "selected=" + JSON.stringify(ac3.selectedAudio));

    const twoAac = await decoder.probe({ path: fixture("two-aac-4s.mp4") });
    expect(twoAac.audioStreams).toHaveLength(2);
    expect(twoAac.selectedAudio?.hasDefault).toBe(true);
    expect(twoAac.selectedAudio?.isAac).toBe(true);
    expect(twoAac.selectedAudio?.streamIndex).toBe(twoAac.audioStreams.find((stream) => stream.hasDefault)?.streamIndex);
    record("probe-two-aac", "selected=" + JSON.stringify(twoAac.selectedAudio));

    const aacOnly = await decoder.probe({ path: fixture("aac-only.mp4") });
    expect(aacOnly.hasVideo).toBe(false);
    expect(aacOnly.hasAudio).toBe(true);
    record("probe-aac-only", "hasVideo=false");

    const rotated = await decoder.probe({ path: fixture("rotate90-4s.mp4") });
    expect(rotated.video?.rotationDegrees).toBe(90);
    record("probe-rotation", "rotation=90");

    const nonzero = await decoder.probe({ path: fixture("nonzero-start-4s.mp4") });
    expect(nonzero.sourceStartSeconds).toBeCloseTo(5, 3);
    expect(nonzero.durationSeconds).toBeCloseTo(4, 3);
    record("probe-nonzero-start", "sourceStart=" + nonzero.sourceStartSeconds);

    const vfr = await decoder.probe({ path: fixture("vfr-4s.mp4") });
    expect(vfr.video?.avgFrameRate).not.toBe(vfr.video?.rFrameRate);
    record("probe-vfr", "avg=" + vfr.video?.avgFrameRate + " r=" + vfr.video?.rFrameRate);

    const hd = await decoder.probe({ path: fixture("hd-1080p-10s.mp4") });
    expect(hd.video).toMatchObject({ width: 1920, height: 1080 });
    record("probe-hd1080p", "1920x1080");
  }, 60_000);

  it("probe：外部 data reference（url 型）被忽略，不讀外部檔", async () => {
    const dref = await decoder.probe({ path: fixture("external-dref-canary.mp4") });
    expect(dref.durationSeconds).toBeCloseTo(4, 3);
    expect(dref.video?.codec).toBe("h264");
    record("probe-external-dref-ignored", "duration=" + dref.durationSeconds);
  });

  it("probe：截斷／垃圾／空檔／偽副檔名／concat 內容都是 invalid-video", async () => {
    for (const name of ["corrupt-truncated.mp4", "corrupt-garbage.mp4", "empty.mp4", "wav-renamed-as.mp4", "attack-external-as.mp4"]) {
      expect(await codeOf(decoder.probe({ path: fixture(name) }))).toBe("invalid-video");
      record("probe-invalid-" + name, "invalid-video");
    }
  });

  it("probe：不存在的來源與超過限制都是具名錯誤", async () => {
    expect(await codeOf(decoder.probe({ path: fixture("does-not-exist.mp4") }))).toBe("video-not-found");
    expect(await codeOf(limitedDuration.probe({ path: fixture("long-60s-360p.mp4") }))).toBe("video-duration-exceeded");
    expect(await codeOf(limitedPixels.probe({ path: fixture("hd-1080p-10s.mp4") }))).toBe("video-resolution-exceeded");
    expect(await codeOf(limitedBytes.probe({ path: fixture("hd-1080p-10s.mp4") }))).toBe("video-source-too-large");
    record("probe-limits", "not-found / duration / resolution / size");
  });

  it("probe：相對路徑與 URL 是程式誤用（TypeError，不是具名媒體錯誤）", async () => {
    await expect(decoder.probe({ path: "relative/file.mp4" })).rejects.toBeInstanceOf(TypeError);
    await expect(decoder.probe({ path: "http://127.0.0.1/x.mp4" })).rejects.toBeInstanceOf(TypeError);
    record("probe-rejects-relative-and-url", "TypeError");
  });

  it("decodeVisualSegments：4 秒／1 幀，段起+2s、縮到最長邊 384、實際 pts", async () => {
    const segments = await collect(decoder.decodeVisualSegments({ path: fixture("h264-aac-4s-faststart.mp4") }));
    expect(segments).toHaveLength(1);
    const segment = segments[0]!;
    expect(segment.startSeconds).toBe(0);
    expect(segment.endSeconds).toBeCloseTo(4, 3);
    expect(segment.frames).toHaveLength(1);
    // 320x240 已小於最長邊 384 → 不放大，維持來源尺寸（B1 政策：只縮不放）。
    expect(segment.frames[0]).toMatchObject({ width: 320, height: 240, timestampSeconds: 2 });
    expect(segment.frames[0]!.pixels.length).toBe(320 * 240 * 3);
    expect(nonBlackRatio(segment.frames[0]!.pixels)).toBeGreaterThan(0.5);
    expect(segment.preprocessingVersion).toBe(visualPreprocessingVersion());
    record("visual-4s-1frame", JSON.stringify({ start: segment.startSeconds, end: segment.endSeconds, ts: segment.frames[0]!.timestampSeconds, dims: [320, 240] }));
  });

  it("decodeVisualSegments：1080p 10 秒 → 3 段（含 2 秒尾段取最後幀）", async () => {
    const segments = await collect(decoder.decodeVisualSegments({ path: fixture("hd-1080p-10s.mp4") }));
    expect(segments.map((segment) => [segment.startSeconds, segment.endSeconds])).toEqual([[0, 4], [4, 8], [8, 10]]);
    // 尾段取「段內最後一幀」：30 fps 在 [8,10) 的最後一幀是 9.966667，不是整數秒。
    expect(segments.map((segment) => segment.frames[0]!.timestampSeconds)).toEqual([2, 6, 9.966667]);
    for (const segment of segments) expect(segment.frames[0]).toMatchObject({ width: 384, height: 216 });
    record("visual-hd1080p-10s", "starts=[0,4,8] ts=[2,6,9]");
  }, 60_000);

  it("decodeVisualSegments：旋轉以 display 尺寸輸出、非零 PTS 用播放時間軸", async () => {
    const rotated = await collect(decoder.decodeVisualSegments({ path: fixture("rotate90-4s.mp4") }));
    expect(rotated).toHaveLength(1);
    expect(rotated[0]!.frames[0]).toMatchObject({ width: 240, height: 320, timestampSeconds: 2 });
    record("visual-rotation", "240x320 ts=2");

    const nonzeroProbe = await decoder.probe({ path: fixture("nonzero-start-4s.mp4") });
    expect(nonzeroProbe.sourceStartSeconds).toBeCloseTo(5, 3);
    const nonzero = await collect(decoder.decodeVisualSegments({ path: fixture("nonzero-start-4s.mp4") }, { probe: nonzeroProbe }));
    expect(nonzero).toHaveLength(1);
    expect(nonzero[0]!.startSeconds).toBe(0);
    expect(nonzero[0]!.endSeconds).toBeCloseTo(4, 3);
    expect(nonzero[0]!.frames[0]!.timestampSeconds).toBe(2);
    record("visual-nonzero-start-playback-timeline", "sourceStart=5 start=0 ts=2");
  }, 60_000);

  it("decodeVisualSegments：VFR 與含 AC-3 音軌的 H.264 視覺仍可解（只解影片流）", async () => {
    const vfr = await collect(decoder.decodeVisualSegments({ path: fixture("vfr-4s.mp4") }));
    expect(vfr).toHaveLength(1);
    // VFR 取「實際來源 PTS」：本 fixture 第一個 ≥2 秒的幀是 2.04，不是 fps 輸出格的 2。
    expect(vfr[0]!.frames[0]!.timestampSeconds).toBeCloseTo(2.04, 6);
    const withAc3 = await collect(decoder.decodeVisualSegments({ path: fixture("h264-ac3-4s.mp4") }));
    expect(withAc3).toHaveLength(1);
    expect(withAc3[0]!.frames[0]!.timestampSeconds).toBe(2);
    record("visual-vfr-and-ac3", "ok");
  }, 60_000);

  it("decodeVisualSegments：generator lazy（只取前 2 段就停，不等整檔）", async () => {
    const started = Date.now();
    const iterator = decoder.decodeVisualSegments({ path: fixture("hd-1080p-60s.mp4") });
    const first = await iterator.next();
    const second = await iterator.next();
    expect(first.done).toBe(false);
    expect(second.done).toBe(false);
    const segments = [first.value!, second.value!];
    expect(segments.map((segment) => segment.startSeconds)).toEqual([0, 4]);
    expect(segments.map((segment) => segment.frames[0]!.timestampSeconds)).toEqual([2, 6]);
    expect(Date.now() - started).toBeLessThan(15_000);
    await iterator.return(undefined);
    record("visual-lazy", "2 segments in " + (Date.now() - started) + "ms");
  }, 60_000);

  it("decodeAudioSegments：AAC → 16 kHz mono、10 秒段、時間 0-based", async () => {
    const segments = [];
    for await (const segment of decoder.decodeAudioSegments({ path: fixture("h264-aac-4s-faststart.mp4") })) segments.push(segment);
    expect(segments).toHaveLength(1);
    const segment = segments[0]!;
    expect(segment.sampleRate).toBe(16000);
    expect(segment.samples.length).toBe(64000);
    expect(segment.startSeconds).toBe(0);
    expect(segment.endSeconds).toBeCloseTo(4, 2);
    expect(segment.samples.every((value) => Number.isFinite(value) && Math.abs(value) <= 1)).toBe(true);
    expect(approxHz(segment.samples)).toBeGreaterThan(420);
    expect(approxHz(segment.samples)).toBeLessThan(460);
    expect(segment.preprocessingVersion).toBe(videoAudioPreprocessingVersion());
    record("audio-aac-4s", "samples=64000 approxHz=" + approxHz(segment.samples).toFixed(1));
  }, 60_000);

  it("decodeAudioSegments：雙 AAC 取 default 音軌（440 Hz 而不是 880 Hz）", async () => {
    const probe = await decoder.probe({ path: fixture("two-aac-4s.mp4") });
    const segments = [];
    for await (const segment of decoder.decodeAudioSegments({ path: fixture("two-aac-4s.mp4") }, { probe })) segments.push(segment);
    expect(segments).toHaveLength(1);
    expect(approxHz(segments[0]!.samples)).toBeGreaterThan(420);
    expect(approxHz(segments[0]!.samples)).toBeLessThan(460);
    record("audio-two-aac-selected-default", "selected=" + JSON.stringify(probe.selectedAudio) + " approxHz=" + approxHz(segments[0]!.samples).toFixed(1));
  }, 60_000);

  it("decodeAudioSegments：無音軌與 AC-3 是具名錯誤", async () => {
    expect(await codeOf(collect2(decoder.decodeAudioSegments({ path: fixture("h264-only-4s.mp4") })))).toBe("no-audio-track");
    expect(await codeOf(collect2(decoder.decodeAudioSegments({ path: fixture("h264-ac3-4s.mp4") })))).toBe("unsupported-video-audio-track");
    record("audio-named-errors", "no-audio-track / unsupported-video-audio-track");
  });

  it("取消：視覺解碼中途 abort → video-decode-cancelled 且程序被回收", async () => {
    const controller = new AbortController();
    const iterator = decoder.decodeVisualSegments({ path: fixture("long-600s-360p.mp4") }, { signal: controller.signal });
    const first = await iterator.next();
    expect(first.done).toBe(false);
    // 只追蹤自己的解碼程序：parked（等待嵌入）時應恰有 1 個，證明追蹤器有效。
    expect(liveDecodePids()).toHaveLength(1);
    controller.abort();
    expect(await drainUntilError(iterator)).toBe("video-decode-cancelled");
    await delay(500);
    expect(liveDecodePids()).toEqual([]);
    record("cancel-visual", "cancelled, no leftover ffmpeg");
  }, 60_000);

  it("deadline：視覺解碼逾時 → video-decode-timeout 且程序被回收", async () => {
    const iterator = decoder.decodeVisualSegments({ path: fixture("long-600s-360p.mp4") }, { timeoutMs: 300 });
    expect(await drainUntilError(iterator)).toBe("video-decode-timeout");
    await delay(500);
    expect(liveDecodePids()).toEqual([]);
    record("deadline-visual", "timeout, no leftover ffmpeg");
  }, 60_000);

  it("音訊 lazy：只取前 2 段就停（不把 600 秒 PCM 全放記憶體）", async () => {
    const started = Date.now();
    const iterator = decoder.decodeAudioSegments({ path: fixture("long-600s-360p.mp4") });
    const first = await iterator.next();
    const second = await iterator.next();
    expect(first.value?.startSeconds).toBe(0);
    expect(second.value?.startSeconds).toBe(10);
    expect(first.value?.samples.length).toBe(160000);
    expect(second.value?.samples.length).toBe(160000);
    await iterator.return(undefined);
    expect(Date.now() - started).toBeLessThan(30_000);
    record("audio-lazy", "2 segments in " + (Date.now() - started) + "ms");
  }, 90_000);

  it("D4：最後一段在 EOF／parser 驗證後才 yield；取得最後一段時程序名額已釋放", async () => {
    const instance = decoder;
    const file = fixture("hd-1080p-10s.mp4");
    const iterator = instance.decodeVisualSegments({ path: file });
    const segments: VisualSegment[] = [];
    for (let index = 0; index < 3; index += 1) {
      const next = await iterator.next();
      expect(next.done).toBe(false);
      segments.push(next.value!);
      if (index < 2) {
        // 非最後一段：yield 時程序仍存活、名額仍持有（跨 yield 保留程序）。
        expect(instance.budgetStats().active).toBe(1);
      }
    }
    expect(segments).toHaveLength(3);
    // 最後一段交出前已做完 EOF／parser 驗證並關程序、釋放名額。
    expect(instance.budgetStats()).toMatchObject({ active: 0, waiting: 0 });
    expect(instance.budgetStats().granted).toBeGreaterThanOrEqual(1);
    expect((await iterator.next()).done).toBe(true);
    record("d4-final-segment-verified-before-yield", JSON.stringify(instance.budgetStats()));
  }, 60_000);

  it.skipIf(!existsSync(fixture("hd-1080p-60s.mp4")))("D4：兩個 iterator 競爭 → 段界讓出、恢復後 PTS／像素與單次全程解碼一致、名額歸零", async () => {
    const file = fixture("hd-1080p-60s.mp4");
    const hash = (segment: VisualSegment): string => createHash("sha256").update(segment.frames[0]!.pixels).digest("hex");
    const reference = new FfmpegMediaDecoder({ ffmpegPath, ffprobePath });
    const referenceSegments: VisualSegment[] = [];
    for await (const segment of reference.decodeVisualSegments({ path: file })) referenceSegments.push(segment);
    expect(referenceSegments.length).toBeGreaterThanOrEqual(5);

    const iteratorA = decoder.decodeVisualSegments({ path: file });
    const a0 = await iteratorA.next();
    const a1 = await iteratorA.next();
    expect(a0.done).toBe(false);
    expect(a1.done).toBe(false);
    expect(a1.value!.startSeconds).toBe(4);
    expect(decoder.budgetStats().active).toBe(1);
    expect(liveDecodePids()).toHaveLength(1);

    // A 在 parked（等待嵌入）時 B 取用名額：A 應被讓出、B 取得第一個片段。
    const iteratorB = decoder.decodeVisualSegments({ path: file });
    const b0 = await iteratorB.next();
    expect(b0.done).toBe(false);
    expect(b0.value!.startSeconds).toBe(0);
    expect(decoder.budgetStats().preemptions).toBeGreaterThanOrEqual(1);
    await iteratorB.return(undefined);

    const resumed: VisualSegment[] = [];
    for (let index = 0; index < 3; index += 1) {
      const next = await iteratorA.next();
      if (next.done) break;
      resumed.push(next.value!);
    }
    expect(resumed.map((segment) => segment.startSeconds)).toEqual([8, 12, 16]);
    for (let index = 0; index < resumed.length; index += 1) {
      const actual = resumed[index]!;
      const expected = referenceSegments[index + 2]!;
      expect(actual.startSeconds).toBe(expected.startSeconds);
      expect(actual.endSeconds).toBe(expected.endSeconds);
      expect(actual.frames[0]!.timestampSeconds).toBe(expected.frames[0]!.timestampSeconds);
      expect(actual.frames[0]!.width).toBe(expected.frames[0]!.width);
      expect(actual.frames[0]!.height).toBe(expected.frames[0]!.height);
      expect(hash(actual)).toBe(hash(expected));
    }
    await iteratorA.return(undefined);
    await delay(300);
    const finalStats = decoder.budgetStats();
    expect(finalStats).toMatchObject({ active: 0, waiting: 0 });
    expect(finalStats.preemptions).toBeGreaterThanOrEqual(1);
    expect(liveDecodePids()).toEqual([]);
    record("d4-preempt-resume", "resumed=3 preemptions=" + finalStats.preemptions);
  }, 120_000);

  // 契約 §4.7：段界恢復的 offset／短尾覆蓋。0.2 秒只有一段，無法在段界讓出，故不覆蓋。
  it.skipIf(!existsSync(wave1FixturesDir))("D4：短尾段 4.2 秒讓出→恢復：剩餘尾段（explicit select）與單次全程解碼一致", async () => {
    const file = wave1Fixture("tail-4.2.mp4");
    const reference = new FfmpegMediaDecoder({ ffmpegPath, ffprobePath });
    const referenceSegments: VisualSegment[] = [];
    for await (const segment of reference.decodeVisualSegments({ path: file })) referenceSegments.push(segment);
    expect(referenceSegments).toHaveLength(2);

    const iteratorA = decoder.decodeVisualSegments({ path: file });
    const first = await iteratorA.next();
    expect(first.done).toBe(false);
    expect(first.value!.startSeconds).toBe(0);
    const iteratorB = decoder.decodeVisualSegments({ path: file });
    const forced = await iteratorB.next();
    expect(forced.done).toBe(false);
    expect(forced.value!.startSeconds).toBe(0);
    await iteratorB.return(undefined);

    const resumed: VisualSegment[] = [];
    for (;;) {
      const next = await iteratorA.next();
      if (next.done) break;
      resumed.push(next.value!);
    }
    expect(resumed).toHaveLength(1);
    expect(resumed[0]!.startSeconds).toBe(4);
    const expected = referenceSegments[1]!;
    expect(resumed[0]!.endSeconds).toBe(expected.endSeconds);
    expect(resumed[0]!.frames[0]!.timestampSeconds).toBe(expected.frames[0]!.timestampSeconds);
    expect(segmentFrameHash(resumed[0]!)).toBe(segmentFrameHash(expected));
    expect(decoder.budgetStats()).toMatchObject({ active: 0, waiting: 0 });
    record("d4-resume-tail-4.2", JSON.stringify({ ts: resumed[0]!.frames[0]!.timestampSeconds }));
  }, 120_000);

  it.skipIf(!existsSync(wave1FixturesDir))("D4：短尾段 8.2 秒讓出→恢復：跨完整段＋尾段（平移 select）與單次全程解碼一致", async () => {
    const file = wave1Fixture("tail-8.2.mp4");
    const reference = new FfmpegMediaDecoder({ ffmpegPath, ffprobePath });
    const referenceSegments: VisualSegment[] = [];
    for await (const segment of reference.decodeVisualSegments({ path: file })) referenceSegments.push(segment);
    expect(referenceSegments).toHaveLength(3);

    const iteratorA = decoder.decodeVisualSegments({ path: file });
    const first = await iteratorA.next();
    expect(first.done).toBe(false);
    const iteratorB = decoder.decodeVisualSegments({ path: file });
    const forced = await iteratorB.next();
    expect(forced.done).toBe(false);
    await iteratorB.return(undefined);

    const resumed: VisualSegment[] = [];
    for (;;) {
      const next = await iteratorA.next();
      if (next.done) break;
      resumed.push(next.value!);
    }
    expect(resumed).toHaveLength(2);
    for (let index = 0; index < resumed.length; index += 1) {
      const actual = resumed[index]!;
      const expected = referenceSegments[index + 1]!;
      expect(actual.startSeconds).toBe(expected.startSeconds);
      expect(actual.endSeconds).toBe(expected.endSeconds);
      expect(actual.frames[0]!.timestampSeconds).toBe(expected.frames[0]!.timestampSeconds);
      expect(segmentFrameHash(actual)).toBe(segmentFrameHash(expected));
    }
    expect(decoder.budgetStats()).toMatchObject({ active: 0, waiting: 0 });
    record("d4-resume-tail-8.2", JSON.stringify(resumed.map((segment) => segment.frames[0]!.timestampSeconds)));
  }, 120_000);

  it.skipIf(!existsSync(wave1FixturesDir))("D4：非零 video start（remux -output_ts_offset 2）讓出→恢復：絕對 -ss／PTS 平移與單次全程解碼一致", async () => {
    const source = wave1Fixture("tail-8.2.mp4");
    const offsetDir = path.join(workDir, "offset-start");
    await mkdir(offsetDir, { recursive: true });
    const file = path.join(offsetDir, "offset-start-8.2.mp4");
    await remux(["-y", "-v", "error", "-i", source, "-c", "copy", "-output_ts_offset", "2", file]);

    const probe = await decoder.probe({ path: file });
    const videoStart = probe.video?.startTimeSeconds ?? probe.sourceStartSeconds;
    expect(videoStart).toBeGreaterThan(1.5);
    const reference = new FfmpegMediaDecoder({ ffmpegPath, ffprobePath });
    const referenceSegments: VisualSegment[] = [];
    for await (const segment of reference.decodeVisualSegments({ path: file }, { probe })) referenceSegments.push(segment);
    expect(referenceSegments).toHaveLength(3);

    const iteratorA = decoder.decodeVisualSegments({ path: file }, { probe });
    const first = await iteratorA.next();
    expect(first.done).toBe(false);
    const iteratorB = decoder.decodeVisualSegments({ path: file }, { probe });
    const forced = await iteratorB.next();
    expect(forced.done).toBe(false);
    await iteratorB.return(undefined);

    const resumed: VisualSegment[] = [];
    for (;;) {
      const next = await iteratorA.next();
      if (next.done) break;
      resumed.push(next.value!);
    }
    expect(resumed).toHaveLength(2);
    for (let index = 0; index < resumed.length; index += 1) {
      const actual = resumed[index]!;
      const expected = referenceSegments[index + 1]!;
      expect(actual.startSeconds).toBe(expected.startSeconds);
      expect(actual.endSeconds).toBe(expected.endSeconds);
      expect(actual.frames[0]!.timestampSeconds).toBe(expected.frames[0]!.timestampSeconds);
      expect(segmentFrameHash(actual)).toBe(segmentFrameHash(expected));
    }
    expect(decoder.budgetStats()).toMatchObject({ active: 0, waiting: 0 });
    record("d4-resume-offset-start", JSON.stringify({ videoStart, ts: resumed.map((segment) => segment.frames[0]!.timestampSeconds) }));
  }, 120_000);
});

async function collect2(iterator: AsyncGenerator<unknown>): Promise<unknown[]> { const all: unknown[] = []; for await (const item of iterator) all.push(item); return all; }

/** 一直取到下一個錯誤或結束，回傳錯誤碼（測試取消／timeout 用；段可能先成功）。 */
async function drainUntilError(iterator: AsyncGenerator<unknown>): Promise<string | undefined> {
  try {
    for (;;) {
      const result = await iterator.next();
      if (result.done) return undefined;
    }
  } catch (error) {
    return error instanceof MediaDecoderError ? error.code : `unexpected:${String(error)}`;
  }
}