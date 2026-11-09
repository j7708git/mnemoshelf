import { describe, expect, it } from "vitest";
import { MediaDecoderError, MEDIA_DECODER_ERROR_MESSAGES, videoAudioPreprocessingVersion, visualPreprocessingVersion } from "../../src/media/types.js";
import {
  buildScaleFilter,
  displayDimensions,
  frameOffsetsSeconds,
  normalizeAudioSegmentSeconds,
  normalizeRotationDegrees,
  normalizeVisualSegmentSeconds,
  parseProbeJson,
  scaledDimensions,
  selectAudioTrack,
  selectFrameIndices,
  ShowinfoPtsParser,
  toVideoProbe,
} from "../../src/media/parse.js";
import { classifyProcessFailure, classifyProbeJsonProblem, classifySpawnError } from "../../src/media/classify.js";

function probeJson(overrides: {
  duration?: string;
  start?: string;
  streams?: unknown[];
} = {}): string {
  return JSON.stringify({
    format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: overrides.duration ?? "4.000000", start_time: overrides.start ?? "0.000000" },
    streams: overrides.streams ?? [
      { index: 0, codec_type: "video", codec_name: "h264", profile: "Constrained Baseline", width: 320, height: 240, pix_fmt: "yuv420p", avg_frame_rate: "25/1", r_frame_rate: "25/1", side_data_list: [] },
      { index: 1, codec_type: "audio", codec_name: "aac", sample_rate: "44100", channels: 1, disposition: { default: 1 } },
    ],
  });
}

const video = { codec_type: "video", codec_name: "h264", width: 320, height: 240, pix_fmt: "yuv420p", avg_frame_rate: "25/1", r_frame_rate: "25/1" };

describe("parseProbeJson / toVideoProbe", () => {
  it("解析 H.264 + AAC 並保留 duration 與 sourceStartSeconds", () => {
    const parsed = parseProbeJson(probeJson());
    expect(parsed.container).toContain("mp4");
    expect(parsed.durationSeconds).toBe(4);
    expect(parsed.sourceStartSeconds).toBe(0);
    expect(parsed.video).toMatchObject({ codec: "h264", width: 320, height: 240, rotationDegrees: 0 });
    expect(parsed.audioStreams).toHaveLength(1);
    expect(parsed.selectedAudio).toMatchObject({ streamIndex: 1, codec: "aac", isAac: true, hasDefault: true });
    const probe = toVideoProbe(parsed);
    expect(probe.hasVideo).toBe(true);
    expect(probe.hasAudio).toBe(true);
  });

  it("非零 start_time 會保留在 sourceStartSeconds（播放時間軸另為 0-based）", () => {
    const parsed = parseProbeJson(probeJson({ start: "5.000000" }));
    expect(parsed.sourceStartSeconds).toBe(5);
    expect(parsed.durationSeconds).toBe(4);
  });

  it("沒有影片流時 hasVideo=false，不是 probe 失敗", () => {
    const parsed = parseProbeJson(probeJson({ streams: [{ index: 0, codec_type: "audio", codec_name: "aac", sample_rate: "48000", channels: 1, disposition: { default: 1 } }] }));
    const probe = toVideoProbe(parsed);
    expect(probe.hasVideo).toBe(false);
    expect(probe.hasAudio).toBe(true);
  });

  it("沒有音軌時 selectedAudio=null、hasAudio=false", () => {
    const probe = toVideoProbe(parseProbeJson(probeJson({ streams: [video] })));
    expect(probe.hasAudio).toBe(false);
    expect(probe.selectedAudio).toBeNull();
  });

  it("display matrix 旋轉會正規化為 0/90/180/270", () => {
    const withRotation = JSON.stringify({ format: { format_name: "mp4", duration: "4", start_time: "0" }, streams: [{ ...video, side_data_list: [{ rotation: -90 }] }] });
    expect(parseProbeJson(withRotation).video?.rotationDegrees).toBe(270); // -90 ≡ 270（mod 360；奇數倍 90 都會交換寬高）
    for (const [raw, expected] of [[0, 0], [90, 90], [180, 180], [270, 270], [-180, 180], [360, 0], [45, 0]] as const) {
      expect(normalizeRotationDegrees(raw)).toBe(expected);
    }
  });

  it("壞 JSON、缺 duration、影片缺尺寸都是 invalid-video", () => {
    expect(() => parseProbeJson("not json")).toThrow(MediaDecoderError);
    expect(() => parseProbeJson(JSON.stringify({ format: { format_name: "mp4" }, streams: [] }))).toThrow(MediaDecoderError);
    expect(() => parseProbeJson(JSON.stringify({ format: { format_name: "mp4", duration: "4" }, streams: [{ ...video, width: 0 }] }))).toThrow(MediaDecoderError);
    try { parseProbeJson("not json"); } catch (error) { expect((error as MediaDecoderError).code).toBe("invalid-video"); }
  });
});

describe("selectAudioTrack（第一個 default AAC，否則第一個 AAC）", () => {
  const aacA = { streamIndex: 1, codec: "aac", hasDefault: false };
  const aacB = { streamIndex: 2, codec: "aac", hasDefault: true };
  const ac3 = { streamIndex: 3, codec: "ac3", hasDefault: true };

  it("優先 default AAC，而不是第一個音軌", () => {
    expect(selectAudioTrack([ac3, aacA, aacB])).toMatchObject({ streamIndex: 2, isAac: true });
  });

  it("沒有 default AAC 時取第一個 AAC", () => {
    expect(selectAudioTrack([ac3, aacA])).toMatchObject({ streamIndex: 1, isAac: true });
  });

  it("完全沒有 AAC 時回傳第一個 default 音軌並標 isAac=false（給 indexer 具名跳過）", () => {
    expect(selectAudioTrack([ac3, { streamIndex: 4, codec: "ac3", hasDefault: false }])).toMatchObject({ streamIndex: 3, codec: "ac3", isAac: false });
  });

  it("沒有音軌回 null", () => {
    expect(selectAudioTrack([])).toBeNull();
  });
});

describe("尺寸與縮圖政策", () => {
  it("旋轉 90/270 會交換顯示寬高", () => {
    expect(displayDimensions({ width: 320, height: 240, rotationDegrees: 0 })).toEqual({ width: 320, height: 240 });
    expect(displayDimensions({ width: 320, height: 240, rotationDegrees: 90 })).toEqual({ width: 240, height: 320 });
    expect(displayDimensions({ width: 320, height: 240, rotationDegrees: 270 })).toEqual({ width: 240, height: 320 });
    expect(displayDimensions({ width: 320, height: 240, rotationDegrees: 180 })).toEqual({ width: 320, height: 240 });
  });

  it("最長邊超過 384 才縮；不放大來源", () => {
    expect(buildScaleFilter(1920, 1080)).toBe("scale=384:-2");
    expect(scaledDimensions(1920, 1080)).toEqual({ width: 384, height: 216 });
    expect(buildScaleFilter(320, 240)).toBeNull();
    expect(scaledDimensions(320, 240)).toEqual({ width: 320, height: 240 });
    expect(buildScaleFilter(240, 320)).toBeNull();
    expect(scaledDimensions(240, 320)).toEqual({ width: 240, height: 320 });
    expect(buildScaleFilter(2160, 3840)).toBe("scale=-2:384");
    expect(scaledDimensions(2160, 3840)).toEqual({ width: 216, height: 384 });
  });
});

describe("抽取幀規則（4 秒一段、每段 1 幀；尾段取最後幀）", () => {
  it("偏移：1 幀取中間；2／4 幀取等分", () => {
    expect(frameOffsetsSeconds(4, 1)).toEqual([2]);
    expect(frameOffsetsSeconds(4, 2)).toEqual([0, 2]);
    expect(frameOffsetsSeconds(4, 4)).toEqual([0, 1, 2, 3]);
    expect(() => frameOffsetsSeconds(4, 3 as never)).toThrow(RangeError);
  });

  it("完整段取段起+2s 的那一幀", () => {
    expect(selectFrameIndices([0, 1, 2, 3], 0, 4, 4, 1)).toEqual([2]);
    expect(selectFrameIndices([4, 5, 6, 7], 4, 8, 4, 1)).toEqual([2]);
    expect(selectFrameIndices([0, 1, 2, 3], 0, 4, 4, 2)).toEqual([0, 2]);
    expect(selectFrameIndices([0, 1, 2, 3], 0, 4, 4, 4)).toEqual([0, 1, 2, 3]);
  });

  it("尾段（不足 4 秒）取最後一幀", () => {
    expect(selectFrameIndices([8, 9], 8, 10, 4, 1)).toEqual([1]);
    expect(selectFrameIndices([8], 8, 10, 4, 1)).toEqual([0]);
  });

  it("目標偏移缺幀時退回片段內最後一幀，而不是空白", () => {
    expect(selectFrameIndices([0, 1], 0, 4, 4, 1)).toEqual([1]);
  });
});

describe("ShowinfoPtsParser", () => {
  it("跨 chunk 的半行與多行都能解析，且每時間只回傳一次", () => {
    const parser = new ShowinfoPtsParser();
    parser.push("[Parsed_showinfo_1 @ 0x1] n:   0 pts:      0 pts_time:0\n[Parsed_showinfo_1 @ 0x1] n:   1 pts:   1280 pts_time:1\n[Parsed_showinfo_1 @ 0x1] n:   2 pts:   2560 pts_time:2");
    expect(parser.drainNew()).toEqual([0, 1]);
    parser.push(".5\n[Parsed_showinfo_1 @ 0x1] n:   3 pts:   3840 pts_time:3\n");
    expect(parser.drainNew()).toEqual([2.5, 3]);
    parser.push("[Parsed_showinfo_1 @ 0x1] n:   4 pts:   5120 pts_time:4");
    parser.flush();
    expect(parser.drainNew()).toEqual([4]);
    expect(parser.count).toBe(5);
  });

  it("忽略其他 log 行與負時間", () => {
    const parser = new ShowinfoPtsParser();
    parser.push("Input #0, mov,mp4...\n[Parsed_showinfo_1 @ 0x1] n:   0 pts:0 pts_time:-0.5\nStream #0:0: Video: h264\n");
    parser.push("[Parsed_showinfo_1 @ 0x1] n:   1 pts:0 pts_time:0.000000\n");
    expect(parser.drainNew()).toEqual([0]);
  });
});

describe("錯誤分類與訊息", () => {
  const base = { killed: { deadline: false, abort: false, outputCap: false }, spawnError: null as string | null, code: 1 as number | null, signal: null as NodeJS.Signals | null, stdoutTruncated: false, stderrTruncated: false, stderr: "" };

  it("取消優先於 deadline 與 output cap", () => {
    expect(classifyProcessFailure({ ...base, killed: { deadline: true, abort: true, outputCap: true } })).toBe("video-decode-cancelled");
    expect(classifyProcessFailure({ ...base, killed: { deadline: true, abort: false, outputCap: true } })).toBe("video-decode-timeout");
    expect(classifyProcessFailure({ ...base, killed: { deadline: false, abort: false, outputCap: true } })).toBe("video-output-limit-exceeded");
  });

  it("spawn 失敗對應 decoder unavailable", () => {
    for (const message of ["ENOENT", "EFTYPE", "EACCES"]) expect(classifySpawnError(message)).toBe("video-decoder-unavailable");
    expect(classifyProcessFailure({ ...base, spawnError: "ENOENT" })).toBe("video-decoder-unavailable");
  });

  it("找不到檔與壞容器分開", () => {
    expect(classifyProcessFailure({ ...base, stderr: "x: No such file or directory" })).toBe("video-not-found");
    expect(classifyProcessFailure({ ...base, stderr: "moov atom not found" })).toBe("invalid-video");
    expect(classifyProcessFailure({ ...base, code: 0, signal: null })).toBe("invalid-video");
  });

  it("probe JSON 截斷歸類 output limit", () => {
    expect(classifyProbeJsonProblem(true)).toBe("video-output-limit-exceeded");
    expect(classifyProbeJsonProblem(false)).toBe("invalid-video");
  });

  it("錯誤訊息固定且不含路徑；code 可由欄位取得", () => {
    const error = new MediaDecoderError("invalid-video", "/some/absolute/file.mp4");
    expect(error.message).toBe(MEDIA_DECODER_ERROR_MESSAGES["invalid-video"]);
    expect(error.message).not.toContain("/some/absolute");
    expect(error.sourcePath).toBe("/some/absolute/file.mp4");
    expect(error.name).toBe("MediaDecoderError");
  });

  it("前處理版本字串穩定且含抽樣政策", () => {
    expect(visualPreprocessingVersion()).toBe("mp4-h264-rgb24-v4:4s:1f:384:srcpts-v3");
    expect(visualPreprocessingVersion(4, 2, 384)).toBe("mp4-h264-rgb24-v4:4s:2f:384:srcpts-v3");
    expect(videoAudioPreprocessingVersion()).toBe("mp4-aac-mono16k-v2:10s:clamp-v1:stream-align-v1");
  });

  it("段長驗證：音訊需整數 16 kHz 樣本", () => {
    expect(normalizeAudioSegmentSeconds(10)).toBe(10);
    expect(() => normalizeAudioSegmentSeconds(0.0001)).toThrow(RangeError);
    expect(normalizeVisualSegmentSeconds(4)).toBe(4);
    expect(() => normalizeVisualSegmentSeconds(0)).toThrow(RangeError);
  });
});