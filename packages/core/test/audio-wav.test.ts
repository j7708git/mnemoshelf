import { describe, expect, it } from "vitest";
import {
  AUDIO_SAMPLE_RATE,
  decodeWavSegments,
  inspectWav,
  MAX_WAV_BYTES,
  WAV_PREPROCESSING_VERSION,
  WavDecodeError,
  type WavSegment,
} from "../src/audio/wav.js";

/** 全部是程式產生的合成波形，不讀使用者檔案。 */
function wav(options: {
  sampleRate?: number;
  channels?: 1 | 2;
  frames?: number;
  float?: boolean;
  sample?: (frame: number, channel: number) => number;
  extra?: Uint8Array;
} = {}): Uint8Array {
  const rate = options.sampleRate ?? 16000;
  const channels = options.channels ?? 1;
  const frames = options.frames ?? 160;
  const sampleBytes = options.float ? 4 : 2;
  const fmtSize = options.float ? 18 : 16;
  const extra = options.extra ?? new Uint8Array();
  const dataHeader = 20 + fmtSize + extra.length;
  const bytes = new Uint8Array(dataHeader + 8 + frames * channels * sampleBytes);
  const view = new DataView(bytes.buffer);
  const text = (position: number, value: string) => {
    for (let i = 0; i < value.length; i++) bytes[position + i] = value.charCodeAt(i);
  };
  text(0, "RIFF"); view.setUint32(4, bytes.length - 8, true); text(8, "WAVE");
  text(12, "fmt "); view.setUint32(16, fmtSize, true);
  view.setUint16(20, options.float ? 3 : 1, true);
  view.setUint16(22, channels, true); view.setUint32(24, rate, true);
  view.setUint32(28, rate * channels * sampleBytes, true);
  view.setUint16(32, channels * sampleBytes, true); view.setUint16(34, sampleBytes * 8, true);
  bytes.set(extra, 20 + fmtSize);
  text(dataHeader, "data"); view.setUint32(dataHeader + 4, frames * channels * sampleBytes, true);
  for (let frame = 0; frame < frames; frame++) {
    for (let channel = 0; channel < channels; channel++) {
      const value = options.sample?.(frame, channel) ?? 0;
      const offset = dataHeader + 8 + (frame * channels + channel) * sampleBytes;
      if (options.float) view.setFloat32(offset, value, true);
      else view.setInt16(offset, Math.round(Math.max(-1, Math.min(32767 / 32768, value)) * 32768), true);
    }
  }
  return bytes;
}

async function decode(bytes: Uint8Array, segmentSeconds?: number): Promise<WavSegment[]> {
  const result: WavSegment[] = [];
  for await (const segment of decodeWavSegments(bytes, { segmentSeconds })) result.push(segment);
  return result;
}

function errorCode(bytes: Uint8Array): string {
  try { inspectWav(bytes); } catch (error) {
    expect(error).toBeInstanceOf(WavDecodeError);
    return (error as WavDecodeError).code;
  }
  throw new Error("預期拒絕無效檔案");
}

describe("inspectWav", () => {
  it("解析 PCM16 並尊重 Uint8Array 的 byteOffset", () => {
    const input = wav({ channels: 2, sampleRate: 44100, frames: 441 });
    const backing = new Uint8Array(input.length + 19);
    backing.set(input, 7);
    expect(inspectWav(backing.subarray(7, 7 + input.length))).toEqual({
      encoding: "pcm16", channels: 2, sampleRate: 44100, frameCount: 441,
      durationSeconds: 0.01, dataOffset: 44, dataBytes: 1764, blockAlign: 4,
    });
  });

  it("接受帶偶數填補的未知 metadata，不把固定 44 bytes 當作音訊起點", async () => {
    const extra = Uint8Array.from([74, 85, 78, 75, 3, 0, 0, 0, 1, 2, 3, 0]);
    const input = wav({ extra, sample: () => 0.5 });
    expect(inspectWav(input).dataOffset).toBe(56);
    expect((await decode(input))[0].samples[0]).toBe(0.5);
  });

  it("解析 IEEE float32", () => {
    expect(inspectWav(wav({ float: true })).encoding).toBe("float32");
  });

  it.each([0, 11, 13, 43])("拒絕截斷標頭 (%i bytes)", (length) => {
    expect(errorCode(wav().subarray(0, length))).toBe("invalid-audio");
  });

  it.each(["RF64", "RIFX", "OggS"])("拒絕非 RIFF 格式 %s", (magic) => {
    const bytes = wav(); bytes.set(new TextEncoder().encode(magic), 0);
    expect(errorCode(bytes)).toBe("unsupported-audio-format");
  });

  it.each([
    [20, 6], [20, 65534], [22, 3], [34, 24],
  ])("拒絕未支援的 codec/聲道/位深 %i=%i", (offset, value) => {
    const bytes = wav(); new DataView(bytes.buffer).setUint16(offset, value, true);
    expect(errorCode(bytes)).toBe("unsupported-audio-format");
  });

  it.each([0, 7999, 192001])("拒絕取樣率 %i", (rate) => {
    const bytes = wav(); new DataView(bytes.buffer).setUint32(24, rate, true);
    expect(errorCode(bytes)).toBe("unsupported-audio-format");
  });

  it.each([28, 32, 40])("拒絕不一致的 byteRate/blockAlign/data 大小欄位 %i", (offset) => {
    const bytes = wav(); new DataView(bytes.buffer).setUint16(offset, 1, true);
    expect(errorCode(bytes)).toBe("invalid-audio");
  });

  it("拒絕空 data 與超過容器的 chunk 長度", () => {
    expect(errorCode(wav({ frames: 0 }))).toBe("invalid-audio");
    const bytes = wav(); new DataView(bytes.buffer).setUint32(40, 0xffffffff, true);
    expect(errorCode(bytes)).toBe("invalid-audio");
  });

  it("拒絕重複 fmt/data、data 先於 fmt、缺必要 chunk", () => {
    const input = wav();
    const duplicateFmt = wav({ extra: input.slice(12, 36) });
    expect(errorCode(duplicateFmt)).toBe("invalid-audio");
    const duplicateData = wav({ extra: input.slice(36) });
    expect(errorCode(duplicateData)).toBe("invalid-audio");
    const noFmt = input.slice(); noFmt.set(new TextEncoder().encode("JUNK"), 12);
    expect(errorCode(noFmt)).toBe("invalid-audio");
    const noData = input.slice(); noData.set(new TextEncoder().encode("JUNK"), 36);
    expect(errorCode(noData)).toBe("invalid-audio");
  });

  it("拒絕 RIFF 外尾隨資料及太多結構 chunks", () => {
    const input = wav(); const trailing = new Uint8Array(input.length + 2); trailing.set(input);
    expect(errorCode(trailing)).toBe("invalid-audio");
    const extra = new Uint8Array(4096 * 8);
    for (let i = 0; i < extra.length; i += 8) extra.set(new TextEncoder().encode("JUNK"), i);
    expect(errorCode(wav({ extra }))).toBe("audio-limit-exceeded");
  });

  it("在解碼配置之前拒絕位元組與時長上限", () => {
    expect(errorCode(new Uint8Array(MAX_WAV_BYTES + 1))).toBe("audio-limit-exceeded");
    expect(errorCode(wav({ sampleRate: 8000, frames: 8000 * 600 + 1 }))).toBe("audio-limit-exceeded");
  });
});

describe("decodeWavSegments", () => {
  it("16k PCM16 保持每個樣本與 -1/正峰值，雙聲道算術平均", async () => {
    const input = wav({ channels: 2, frames: 3, sample: (i, c) => [[-1, -1], [0.5, -0.25], [1, 1]][i][c] });
    const [segment] = await decode(input);
    expect([...segment.samples]).toEqual([-1, 0.125, 32767 / 32768]);
    expect(segment.sampleRate).toBe(AUDIO_SAMPLE_RATE);
    expect(segment.preprocessingVersion).toBe(WAV_PREPROCESSING_VERSION);
  });

  it("float32 保持有效值，沒有把位元當整數解讀", async () => {
    const [segment] = await decode(wav({ float: true, frames: 3, sample: (i) => [-0.75, 0, 0.5][i] }));
    expect([...segment.samples]).toEqual([-0.75, 0, 0.5]);
  });

  it.each([NaN, Infinity, -Infinity, 1.01, -1.01])("拒絕不合法 float32 樣本 %s（包含非輸出取樣位置）", async (value) => {
    const input = wav({ float: true, sampleRate: 48000, frames: 480, sample: (i) => i === 317 ? value : 0 });
    await expect(decode(input)).rejects.toMatchObject({ code: "invalid-audio" });
  });

  it("超過 30 秒完整分成 10 秒片段，保留最後一個樣本與正確時刻", async () => {
    const length = 31 * 16000 + 1;
    const segments = await decode(wav({ frames: length, sample: (i) => i === length - 1 ? 0.75 : 0 }));
    expect(segments.map((s) => [s.startSeconds, s.endSeconds, s.samples.length])).toEqual([
      [0, 10, 160000], [10, 20, 160000], [20, 30, 160000], [30, 31 + 1 / 16000, 16001],
    ]);
    expect(segments.at(-1)!.samples.at(-1)).toBe(0.75);
    expect(segments.reduce((sum, s) => sum + s.samples.length, 0)).toBe(length);
  });

  it.each([8000, 11025, 22050, 44100, 48000, 96000, 192000])("%i Hz 重採樣維持 DC 音量與時間覆蓋", async (sampleRate) => {
    const frames = Math.floor(sampleRate * 0.01) + 1;
    const [segment] = await decode(wav({ sampleRate, frames, sample: () => 0.25 }));
    expect(segment.samples.length).toBe(Math.ceil(frames * 16000 / sampleRate));
    expect(segment.endSeconds).toBe(frames / sampleRate);
    for (const value of segment.samples) expect(value).toBeCloseTo(0.25, 5);
  });

  it("48kHz 降採樣保留 1kHz、抑制 12kHz 混疊", async () => {
    const rms = (samples: Float32Array) => {
      const middle = samples.subarray(128, samples.length - 128);
      return Math.sqrt(middle.reduce((sum, value) => sum + value * value, 0) / middle.length);
    };
    const makeTone = (hz: number) => wav({ sampleRate: 48000, frames: 4800, sample: (i) => 0.5 * Math.sin(2 * Math.PI * hz * i / 48000) });
    const low = rms((await decode(makeTone(1000)))[0].samples);
    const high = rms((await decode(makeTone(12000)))[0].samples);
    expect(low).toBeGreaterThan(0.34);
    expect(low).toBeLessThan(0.36);
    expect(high / low).toBeLessThan(0.01);
  });

  it("不同切段大小不改變重採樣相位與輸出", async () => {
    const input = wav({ sampleRate: 44100, frames: 4410, sample: (i) => Math.sin(i * 0.1) * 0.5 });
    const one = (await decode(input))[0].samples;
    const many = await decode(input, 0.025);
    expect(many.flatMap((s) => [...s.samples])).toEqual([...one]);
    expect(many.at(-1)!.endSeconds).toBe(0.1);
  });

  it("非整數倍率恰好 10 秒時不因浮點誤差新增零長尾段", async () => {
    const segments = await decode(wav({ sampleRate: 8008, frames: 80080 }));
    expect(segments).toHaveLength(1);
    expect(segments[0].samples).toHaveLength(160000);
    expect(segments[0].endSeconds).toBe(10);
  });

  it.each([0, -1, 30.0001, Infinity, NaN, 1 / 17000])("拒絕不合法片段秒數 %s", async (seconds) => {
    await expect(decode(wav(), seconds)).rejects.toBeInstanceOf(RangeError);
  });

  it("支援 30 秒上限且不產生空尾段", async () => {
    const segments = await decode(wav({ frames: 30 * 16000 }), 30);
    expect(segments).toHaveLength(1);
    expect(segments[0].samples).toHaveLength(480000);
  });

  it("已取消時不解碼；處理中會讓出 event loop 供取消生效", async () => {
    const before = new AbortController(); before.abort();
    await expect(decodeWavSegments(wav(), { signal: before.signal }).next()).rejects.toMatchObject({ name: "AbortError" });
    const during = new AbortController();
    const iterator = decodeWavSegments(wav({ sampleRate: 48000, frames: 48000 }), { signal: during.signal });
    const pending = iterator.next();
    setImmediate(() => during.abort());
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("消費者可在片段間取消或提前結束，不啟動下一段", async () => {
    const controller = new AbortController();
    const iterator = decodeWavSegments(wav({ frames: 16000 }), { signal: controller.signal, segmentSeconds: 0.5 });
    expect((await iterator.next()).value?.endSeconds).toBe(0.5);
    controller.abort();
    await expect(iterator.next()).rejects.toMatchObject({ name: "AbortError" });
    const stopped = decodeWavSegments(wav({ frames: 16000 }), { segmentSeconds: 0.5 });
    await stopped.next(); await stopped.return(undefined);
    expect((await stopped.next()).done).toBe(true);
  });
});
