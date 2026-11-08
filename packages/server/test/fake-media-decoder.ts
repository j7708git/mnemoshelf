/**
 * 測試用 fake `MediaDecoder`（server 整合測試專用；**不 spawn 任何程序**）。
 *
 * 為什麼需要：C1 要驗證「server → indexer → decoder → embedVideo」的接線與 HTTP 行為，
 * 但 CI 不能依賴 ffmpeg binary。這個 fake 回傳合法的 probe 與 lazy 片段，讓整條產品流程
 * （preview／index／search／diagnostics）可以在沒有 binary 的環境跑完；真 decoder 另以
 * 環境變數 gated（見 `media-real-decoder.gated.test.ts`）。
 *
 * 邊界：這裡的資料是**合成**的（固定尺寸的純色幀），不含任何使用者媒體；fake 沒有語意，
 * 只用來驗證介面與流程，不代表檢索品質。
 */
import type {
  AudioSegment,
  DecoderAvailability,
  MediaDecoder,
  MediaSource,
  VideoProbe,
  VisualSegment,
} from "@mnemoshelf/core";
import { videoAudioPreprocessingVersion, visualPreprocessingVersion } from "@mnemoshelf/core";

/** fake decoder 回報的版本字串（進 preprocessVersion；不含真實路徑）。 */
export const FAKE_FFMPEG_VERSION = "ffmpeg version n9.0.2-fake";
export const FAKE_FFPROBE_VERSION = "ffprobe version n9.0.2-fake";

/** 影片視覺段長（與凍結政策一致；測試用 4 秒）。 */
const SEGMENT_SECONDS = 4;
/** 影片音軌段長（與既有音訊政策一致；測試用 10 秒）。 */
const AUDIO_SEGMENT_SECONDS = 10;
/** 每段 1 幀（凍結政策）。 */
const FRAMES_PER_SEGMENT = 1;

/** 一個合法 probe 的預設值：8 秒、H.264 64×36、無音軌。 */
export function makeVideoProbe(overrides: Partial<VideoProbe> = {}): VideoProbe {
  return {
    container: "mov,mp4,m4a,3gp,3g2,mj2",
    durationSeconds: 8,
    sourceStartSeconds: 0,
    video: {
      codec: "h264",
      width: 64,
      height: 36,
      rotationDegrees: 0,
      avgFrameRate: "25/1",
      rFrameRate: "25/1",
    },
    audioStreams: [],
    selectedAudio: null,
    hasVideo: true,
    hasAudio: false,
    ...overrides,
  };
}

/** 一個 AAC 音軌（選軌規則用）。 */
export function aacStream(streamIndex = 1) {
  return {
    streamIndex,
    codec: "aac",
    sampleRate: 48_000,
    channels: 2,
    hasDefault: true,
    isAac: true,
  } as const;
}

/** 依凍結政策產生視覺片段：完整段取段中（+2 秒），尾段取段內一半。 */
export function visualSegmentsFor(
  durationSeconds: number,
  options: { width?: number; height?: number; framesPerSegment?: 1 | 2 | 4 } = {},
): VisualSegment[] {
  const width = options.width ?? 16;
  const height = options.height ?? 16;
  const framesPerSegment = options.framesPerSegment ?? FRAMES_PER_SEGMENT;
  const segments: VisualSegment[] = [];
  for (let start = 0; start < durationSeconds; start += SEGMENT_SECONDS) {
    const endSeconds = Math.min(durationSeconds, start + SEGMENT_SECONDS);
    const offset = Math.min(SEGMENT_SECONDS / 2, (endSeconds - start) / 2);
    const frames = [];
    for (let frameIndex = 0; frameIndex < framesPerSegment; frameIndex += 1) {
      // 每幀一個可區分的灰色（只為了讓 fake embedder 的雜湊不同）。
      const level = (start * 16 + frameIndex * 32) % 256;
      const pixels = new Uint8Array(width * height * 3).fill(level);
      frames.push({
        pixels,
        width,
        height,
        timestampSeconds: start + offset + frameIndex * 0.001,
      });
    }
    segments.push({
      startSeconds: start,
      endSeconds,
      frames,
      preprocessingVersion: visualPreprocessingVersion(SEGMENT_SECONDS, framesPerSegment, 384),
    });
  }
  return segments;
}

/** 依既有音訊政策產生 16 kHz mono 片段（靜音）。 */
export function audioSegmentsFor(durationSeconds: number): AudioSegment[] {
  const segments: AudioSegment[] = [];
  for (let start = 0; start < durationSeconds; start += AUDIO_SEGMENT_SECONDS) {
    const endSeconds = Math.min(durationSeconds, start + AUDIO_SEGMENT_SECONDS);
    segments.push({
      samples: new Float32Array(Math.round((endSeconds - start) * 16_000)),
      sampleRate: 16_000,
      startSeconds: start,
      endSeconds,
      preprocessingVersion: videoAudioPreprocessingVersion(AUDIO_SEGMENT_SECONDS),
    });
  }
  return segments;
}

/** fake decoder 的可注入行為。 */
export interface FakeMediaDecoderOptions {
  /** 可用性；預設可用並帶版本。 */
  availability?: DecoderAvailability;
  /** probe 結果；預設 `makeVideoProbe()`（8 秒、無音軌）。 */
  probeResult?: VideoProbe;
  /** probe 要拋的錯誤（例如 `MediaDecoderError("invalid-video")`）。 */
  probeError?: unknown;
  /** 視覺解碼到第 index 段前要拋的錯誤。 */
  visualErrorBefore?: { index: number; error: unknown };
  /** 音訊解碼到第 index 段前要拋的錯誤。 */
  audioErrorBefore?: { index: number; error: unknown };
  /** 每 yield 一段前的延遲（驗證取消／並行；預設 0）。 */
  yieldDelayMs?: number;
}

/** 測試用 decoder：可注入 probe／segment／錯誤與可用性；不讀檔、不 spawn。 */
export class FakeMediaDecoder implements MediaDecoder {
  readonly calls = { availability: 0, probe: 0, visual: 0, audio: 0 };
  /** decoder 實際收到的來源路徑（用來確認拿到的是本輪快照，而不是原始 root 路徑）。 */
  readonly sources: string[] = [];

  constructor(private readonly options: FakeMediaDecoderOptions = {}) {}

  async checkAvailability(): Promise<DecoderAvailability> {
    this.calls.availability += 1;
    return (
      this.options.availability ?? {
        available: true,
        ffmpegVersion: FAKE_FFMPEG_VERSION,
        ffprobeVersion: FAKE_FFPROBE_VERSION,
      }
    );
  }

  async probe(source: MediaSource): Promise<VideoProbe> {
    this.calls.probe += 1;
    this.sources.push(source.path);
    if (this.options.probeError !== undefined) throw this.options.probeError;
    return this.options.probeResult ?? makeVideoProbe();
  }

  async *decodeVisualSegments(source: MediaSource): AsyncGenerator<VisualSegment> {
    this.calls.visual += 1;
    this.sources.push(source.path);
    const probe = this.options.probeResult ?? makeVideoProbe();
    const segments = visualSegmentsFor(probe.durationSeconds);
    for (let index = 0; index < segments.length; index += 1) {
      if (this.options.yieldDelayMs !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, this.options.yieldDelayMs));
      }
      if (this.options.visualErrorBefore?.index === index) throw this.options.visualErrorBefore.error;
      yield segments[index]!;
    }
  }

  async *decodeAudioSegments(source: MediaSource): AsyncGenerator<AudioSegment> {
    this.calls.audio += 1;
    this.sources.push(source.path);
    const probe = this.options.probeResult ?? makeVideoProbe();
    const segments = audioSegmentsFor(probe.durationSeconds);
    for (let index = 0; index < segments.length; index += 1) {
      if (this.options.audioErrorBefore?.index === index) throw this.options.audioErrorBefore.error;
      yield segments[index]!;
    }
  }
}