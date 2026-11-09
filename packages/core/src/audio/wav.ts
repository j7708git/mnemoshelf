import { setImmediate as yieldToEventLoop } from "node:timers/promises";

/** WAV 前處理政策；改變混音、濾波或切段政策時必須換版。 */
export const WAV_PREPROCESSING_VERSION = "wav-pcm-mono16k-sinc-v1";
export const AUDIO_SAMPLE_RATE = 16_000;
export const DEFAULT_AUDIO_SEGMENT_SECONDS = 10;
export const MAX_AUDIO_SEGMENT_SECONDS = 30;
export const MAX_WAV_BYTES = 64 * 1024 * 1024;
export const MAX_WAV_DURATION_SECONDS = 600;
const MAX_RIFF_CHUNKS = 4096;

export type WavDecodeErrorCode = "unsupported-audio-format" | "invalid-audio" | "audio-limit-exceeded";

/** 只有固定訊息，不包含檔案內容、標頭文字或本機路徑。 */
export class WavDecodeError extends Error {
  constructor(readonly code: WavDecodeErrorCode, message: string) {
    super(message);
    this.name = "WavDecodeError";
  }
}

export interface WavInfo {
  encoding: "pcm16" | "float32";
  channels: 1 | 2;
  sampleRate: number;
  frameCount: number;
  durationSeconds: number;
  dataOffset: number;
  dataBytes: number;
  blockAlign: number;
}

export interface WavSegment {
  samples: Float32Array;
  sampleRate: 16000;
  startSeconds: number;
  endSeconds: number;
  preprocessingVersion: string;
}

export interface DecodeWavOptions {
  signal?: AbortSignal;
  /** 秒數需能精確換算為 16 kHz 的整數樣本數；預設 10，最多 30。 */
  segmentSeconds?: number;
}

function invalid(): never {
  throw new WavDecodeError("invalid-audio", "WAV 結構或樣本資料無效");
}

function unsupported(): never {
  throw new WavDecodeError("unsupported-audio-format", "僅支援 RIFF/WAVE PCM16 或 float32 單／雙聲道音訊（8–192 kHz）");
}

function limited(): never {
  throw new WavDecodeError("audio-limit-exceeded", "音訊超過解碼位元組、時長或結構上限");
}

function fourcc(view: DataView, offset: number, expected: string): boolean {
  for (let i = 0; i < 4; i++) if (view.getUint8(offset + i) !== expected.charCodeAt(i)) return false;
  return true;
}

/**
 * 檢查有界 RIFF 標頭；不讀檔、不解碼、不相信副檔名，也不追蹤 LIST／外部參照。
 * 呼叫端須先完成 root 驗證，且在 iterator 結束前不得修改傳入的位元組。
 */
export function inspectWav(bytes: Uint8Array): WavInfo {
  if (bytes.byteLength > MAX_WAV_BYTES) limited();
  if (bytes.byteLength < 12) invalid();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (!fourcc(view, 0, "RIFF") || !fourcc(view, 8, "WAVE")) unsupported();
  const riffEnd = view.getUint32(4, true) + 8;
  // 不接受截斷或 RIFF 之外的尾隨資料，避免解析與雜湊看見不同輸入。
  if (riffEnd !== bytes.byteLength) invalid();
  let format: Omit<WavInfo, "frameCount" | "durationSeconds" | "dataOffset" | "dataBytes"> | undefined;
  let dataOffset: number | undefined;
  let dataBytes = 0;
  let chunkCount = 0;
  for (let offset = 12; offset < riffEnd;) {
    if (++chunkCount > MAX_RIFF_CHUNKS) limited();
    if (offset + 8 > riffEnd) invalid();
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    const next = body + size + (size % 2);
    if (next > riffEnd) invalid();
    if (fourcc(view, offset, "fmt ")) {
      if (format || size < 16) invalid();
      const tag = view.getUint16(body, true);
      const channels = view.getUint16(body + 2, true);
      const sampleRate = view.getUint32(body + 4, true);
      const byteRate = view.getUint32(body + 8, true);
      const blockAlign = view.getUint16(body + 12, true);
      const bits = view.getUint16(body + 14, true);
      if (!((tag === 1 && bits === 16) || (tag === 3 && bits === 32))) unsupported();
      if (size !== 16 && size !== 18) unsupported();
      if (channels !== 1 && channels !== 2) unsupported();
      if (sampleRate < 8000 || sampleRate > 192000) unsupported();
      if (size === 18 && view.getUint16(body + 16, true) !== 0) unsupported();
      if (blockAlign !== channels * (bits / 8) || byteRate !== sampleRate * blockAlign) invalid();
      format = { encoding: tag === 1 ? "pcm16" : "float32", channels, sampleRate, blockAlign };
    } else if (fourcc(view, offset, "data")) {
      if (!format || dataOffset !== undefined || size === 0) invalid();
      dataOffset = body;
      dataBytes = size;
    }
    offset = next;
  }
  if (!format || dataOffset === undefined || dataBytes % format.blockAlign !== 0) invalid();
  const frameCount = dataBytes / format.blockAlign;
  const durationSeconds = frameCount / format.sampleRate;
  if (durationSeconds > MAX_WAV_DURATION_SECONDS) limited();
  return { ...format, frameCount, durationSeconds, dataOffset, dataBytes };
}

function checkAbort(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

async function yieldAndCheck(signal?: AbortSignal): Promise<void> {
  checkAbort(signal);
  await yieldToEventLoop();
  checkAbort(signal);
}

/**
 * 逐段解碼為 16 kHz mono。只配置目前片段與有限濾波表，不配置整檔 PCM。
 * PCM16 除以 32768；float32 必須 finite 且介於 [-1,1]；雙聲道取算術平均。
 * 重採樣用 Hann-windowed sinc 抗混疊濾波；邊界延伸端點，輸出夾到 [-1,1]。
 * 輸出時間沿用整檔樣本座標，分段不重設相位，尾段保持真正的結束時間。
 */
export async function* decodeWavSegments(bytes: Uint8Array, options: DecodeWavOptions = {}): AsyncGenerator<WavSegment> {
  checkAbort(options.signal);
  const seconds = options.segmentSeconds ?? DEFAULT_AUDIO_SEGMENT_SECONDS;
  const segmentFrames = seconds * AUDIO_SAMPLE_RATE;
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > MAX_AUDIO_SEGMENT_SECONDS || !Number.isInteger(segmentFrames)) {
    throw new RangeError("音訊片段需大於零、不超過 30 秒，且對應整數個 16 kHz 樣本");
  }
  const info = inspectWav(bytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // 先檢查每個 float 樣本，包含重採樣可能略過的樣本，不能把 NaN 悄悄漏掉。
  if (info.encoding === "float32") {
    for (let i = 0; i < info.dataBytes; i += 4) {
      const value = view.getFloat32(info.dataOffset + i, true);
      if (!Number.isFinite(value) || Math.abs(value) > 1) invalid();
      if (i % 65536 === 0) await yieldAndCheck(options.signal);
    }
  }
  const sampleBytes = info.encoding === "pcm16" ? 2 : 4;
  const readMono = (frame: number): number => {
    const bounded = Math.max(0, Math.min(info.frameCount - 1, frame));
    const offset = info.dataOffset + bounded * info.blockAlign;
    let sum = 0;
    for (let channel = 0; channel < info.channels; channel++) {
      sum += info.encoding === "pcm16"
        ? view.getInt16(offset + channel * sampleBytes, true) / 32768
        : view.getFloat32(offset + channel * sampleBytes, true);
    }
    return sum / info.channels;
  };
  const ratio = info.sampleRate / AUDIO_SAMPLE_RATE;
  // 先做有界整數乘法，避免先算 ratio 的浮點誤差在整段邊界多出一個零長尾段。
  const outputFrames = Math.ceil(info.frameCount * AUDIO_SAMPLE_RATE / info.sampleRate);
  // 512 個相位、16 個 sinc 波瓣；隨降採樣倍率展寬濾波器。
  const phases = 512;
  const cutoff = Math.min(1, 1 / ratio);
  const radius = Math.ceil(16 / cutoff);
  const taps = radius * 2;
  const filters = ratio === 1 ? undefined : new Float64Array(phases * taps);
  if (filters) {
    for (let phase = 0; phase < phases; phase++) {
      let total = 0;
      for (let tap = 0; tap < taps; tap++) {
        const distance = tap - radius + 1 - phase / phases;
        const argument = Math.PI * distance * cutoff;
        const sinc = Math.abs(argument) < 1e-12 ? 1 : Math.sin(argument) / argument;
        const window = Math.abs(distance) >= radius ? 0 : 0.5 + 0.5 * Math.cos(Math.PI * distance / radius);
        const weight = cutoff * sinc * window;
        filters[phase * taps + tap] = weight;
        total += weight;
      }
      for (let tap = 0; tap < taps; tap++) filters[phase * taps + tap] /= total;
      if (phase % 32 === 0) await yieldAndCheck(options.signal);
    }
  }
  for (let start = 0; start < outputFrames; start += segmentFrames) {
    checkAbort(options.signal);
    const count = Math.min(segmentFrames, outputFrames - start);
    const samples = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const position = (start + i) * info.sampleRate / AUDIO_SAMPLE_RATE;
      let value: number;
      if (!filters) {
        value = readMono(start + i);
      } else {
        const whole = Math.floor(position);
        const phase = Math.min(phases - 1, Math.floor((position - whole) * phases));
        value = 0;
        for (let tap = 0; tap < taps; tap++) value += readMono(whole + tap - radius + 1) * filters[phase * taps + tap];
      }
      samples[i] = Math.max(-1, Math.min(1, value));
      if (i % 1024 === 0) await yieldAndCheck(options.signal);
    }
    checkAbort(options.signal);
    yield {
      samples,
      sampleRate: AUDIO_SAMPLE_RATE,
      startSeconds: start / AUDIO_SAMPLE_RATE,
      endSeconds: Math.min((start + count) / AUDIO_SAMPLE_RATE, info.durationSeconds),
      preprocessingVersion: WAV_PREPROCESSING_VERSION,
    };
  }
}
