/**
 * 波次一 D1／D2 純函式單元測試：來源 PTS 選幀計畫、select 表達式、音軌時間線。
 */
import { describe, expect, it } from "vitest";
import { MediaDecoderError } from "../../src/media/types.js";
import {
  audioSampleTolerance,
  buildFrameSelectExpression,
  buildGridSelectExpression,
  computeAudioTimeline,
  parseFramePtsList,
  parseFrameTimeline,
  planVisualFrames,
} from "../../src/media/parse.js";
import type { VideoProbe } from "../../src/media/types.js";

function probeWithAudio(overrides: { duration?: number; audioStart?: number; audioDuration?: number } = {}): VideoProbe {
  const duration = overrides.duration ?? 12;
  const stream = {
    streamIndex: 1,
    codec: "aac",
    sampleRate: 48000,
    channels: 2,
    hasDefault: true,
    isAac: true,
    startTimeSeconds: overrides.audioStart ?? 0,
    durationSeconds: overrides.audioDuration ?? 11.8,
    initialPaddingSamples: 1024,
  };
  return {
    container: "mp4",
    durationSeconds: duration,
    sourceStartSeconds: 0,
    video: { codec: "h264", width: 64, height: 36, rotationDegrees: 0, avgFrameRate: "25/1", rFrameRate: "25/1" },
    audioStreams: [stream],
    selectedAudio: stream,
    hasVideo: true,
    hasAudio: true,
  };
}

/** 產生 25 fps 的 frame pts 陣列（不含結尾）。 */
function frameTimes(duration: number, fps = 25): number[] {
  const list: number[] = [];
  for (let i = 0; i * (1 / fps) < duration - 1e-9; i += 1) list.push(i / fps);
  return list;
}

describe("parseFramePtsList", () => {
  it("忽略空行與 N/A，只留有限數字", () => {
    expect(parseFramePtsList("0.000000\n0.033333\nN/A\n\n2.5\n")).toEqual([0, 0.033333, 2.5]);
    expect(parseFramePtsList("")).toEqual([]);
    expect(parseFramePtsList("0.000000\r\n0.040000\r\n")).toEqual([0, 0.04]);
  });
});

describe("parseFrameTimeline", () => {
  it("依欄位名讀取來源 PTS 與最後影格時長，缺時長不推估", () => {
    expect(parseFrameTimeline("frame|duration_time=0.033367|pts_time=0.000000\nframe|pts_time=0.033367|duration_time=0.033367\nside_data|side_data_type=Display Matrix\n"))
      .toEqual({ times: [0, 0.033367], lastFrameDurationSeconds: 0.033367 });
    expect(parseFrameTimeline("frame|pts_time=0.000000|duration_time=N/A\n")).toEqual({ times: [0] });
    expect(() => parseFrameTimeline("frame|pts_time=N/A|duration_time=0.04\n")).toThrow(MediaDecoderError);
    expect(() => parseFrameTimeline("frame|pts_time=0\nframe|duration_time=0.04\n")).toThrow(MediaDecoderError);
    expect(() => parseFrameTimeline("frame|pts_time=0\nframe\n")).toThrow(MediaDecoderError);
  });
});

describe("planVisualFrames（D1：來源 PTS 選幀）", () => {
  it.each([30000 / 1001, 24000 / 1001])("%f fps：最後影格時長證明空尾格才省略，保留前段邊界", (fps) => {
    const count = Math.round(8 * fps);
    const times = Array.from({ length: count }, (_, index) => Number((index / fps).toFixed(6)));
    const duration = Math.ceil((count / fps - 1e-9) * 1000) / 1000;
    const picks = planVisualFrames(times, duration, 4, 1, Number((1 / fps).toFixed(6)));
    expect(picks.map((pick) => [pick.startSeconds, pick.endSeconds])).toEqual([[0, 4], [4, 8]]);
    expect(() => planVisualFrames(times, duration)).toThrow(MediaDecoderError);
    expect(() => planVisualFrames(times, duration + 0.01, 4, 1, 1 / fps)).toThrow(MediaDecoderError);
  });

  it("尾格內有 PTS 就保留；空的完整尾格／內部空格不能省略", () => {
    expect(planVisualFrames([0, 2, 4, 6, 8], 8.008, 4, 1, 0.008)).toHaveLength(3);
    expect(() => planVisualFrames([0, 2], 8, 4, 1, 6)).toThrow(MediaDecoderError);
    expect(() => planVisualFrames([0, 8], 12.008, 4, 1, 4.008)).toThrow(MediaDecoderError);
  });

  it("29.97fps 60秒：末幀PTS與時長各六位小數相加的一微秒差不因浮點ulp誤拒", () => {
    const times = Array.from({ length: 1799 }, (_, index) => Number((index * 1001 / 30000).toFixed(6)));
    expect(times.at(-1)).toBe(59.993267);
    expect(planVisualFrames(times, 60.026633, 4, 1, 0.033367)).toHaveLength(15);
    expect(() => planVisualFrames(times, 60.026630, 4, 1, 0.033367)).toThrow(MediaDecoderError);
  });
  it("0.2 秒短片：唯一尾段取最後一幀", () => {
    const times = frameTimes(0.2);
    const picks = planVisualFrames(times, 0.2, 4, 1);
    expect(picks).toHaveLength(1);
    expect(picks[0]!.segmentIndex).toBe(0);
    expect(picks[0]!.startSeconds).toBe(0);
    expect(picks[0]!.frameTimeSeconds).toBeCloseTo(times.at(-1)!, 9);
    expect(picks[0]!.rule).toBe("tail-last");
  });

  it("4.2 秒：完整段取中點之後第一幀、尾段取最後幀（皆為實際 PTS）", () => {
    const times = frameTimes(4.2);
    const picks = planVisualFrames(times, 4.2, 4, 1);
    expect(picks).toHaveLength(2);
    expect(picks[0]!.frameTimeSeconds).toBeGreaterThanOrEqual(2 - 1e-9);
    expect(picks[0]!.frameTimeSeconds).toBeLessThan(2 + 1 / 25);
    expect(picks[1]!.startSeconds).toBe(4);
    expect(picks[1]!.frameTimeSeconds).toBeCloseTo(times.at(-1)!, 9);
  });

  it("8.2 秒：三段的段起／段終與選幀都落在 [start,end)", () => {
    const times = frameTimes(8.2);
    const picks = planVisualFrames(times, 8.2, 4, 1);
    expect(picks.map((pick) => [pick.startSeconds, pick.endSeconds])).toEqual([[0, 4], [4, 8], [8, 8.2]]);
    for (const pick of picks) {
      expect(pick.frameTimeSeconds).toBeGreaterThanOrEqual(pick.startSeconds);
      expect(pick.frameTimeSeconds).toBeLessThan(pick.endSeconds);
    }
  });

  it("稀疏幀：沒有 ≥ 中點的幀時取段內最後一幀（fallback-last）", () => {
    const picks = planVisualFrames([0, 5, 10], 10.04, 4, 1);
    expect(picks.map((pick) => pick.frameTimeSeconds)).toEqual([0, 5, 10]);
    expect(picks[0]!.rule).toBe("fallback-last");
    expect(picks[1]!.rule).toBe("fallback-last");
    expect(picks[2]!.rule).toBe("tail-last");
  });

  it("段內完全沒有幀、重複時間、亂序、非有限值都具名拒絕 unsupported-video-timeline", () => {
    const code = (fn: () => unknown): string | undefined => {
      try { fn(); return undefined; } catch (error) { return error instanceof MediaDecoderError ? error.code : "unexpected"; }
    };
    expect(code(() => planVisualFrames([0, 1, 12], 12.04, 4, 1))).toBe("unsupported-video-timeline");
    expect(code(() => planVisualFrames([0, 2, 2], 4, 4, 1))).toBe("unsupported-video-timeline");
    expect(code(() => planVisualFrames([2, 1], 4, 4, 1))).toBe("unsupported-video-timeline");
    expect(code(() => planVisualFrames([], 4, 4, 1))).toBe("unsupported-video-timeline");
    expect(code(() => planVisualFrames([0, Number.NaN], 4, 4, 1))).toBe("unsupported-video-timeline");
  });

  it("framesPerSegment=2／4 時每段挑多個實際 PTS 且不重複", () => {
    const times = frameTimes(8);
    const two = planVisualFrames(times, 8, 4, 2);
    expect(two).toHaveLength(4); // 2 段 × 2 幀
    const four = planVisualFrames(times, 8, 4, 4);
    expect(four).toHaveLength(8);
    for (const pick of four) expect(Number.isFinite(pick.frameTimeSeconds)).toBe(true);
  });
});

describe("buildFrameSelectExpression", () => {
  it("150 個非格線 PTS 使用平衡樹且保持每一個 between，不因90項舊上限拒絕", () => {
    const picks = Array.from({ length: 150 }, (_, index) => ({
      segmentIndex: index, startSeconds: index * 4, endSeconds: index * 4 + 4,
      frameTimeSeconds: index * 4 + 2.012, rule: "midpoint" as const,
    }));
    const expression = buildFrameSelectExpression(picks);
    expect(expression.split("between(")).toHaveLength(151);
    expect(expression.length).toBeLessThan(28_000);
    expect(() => buildFrameSelectExpression(Array.from({ length: 601 }, () => picks[0]!))).toThrow(MediaDecoderError);
  });
  it("以 between 組合並跳脫 filtergraph 逗號（不經 shell）", () => {
    const expression = buildFrameSelectExpression([
      { segmentIndex: 0, startSeconds: 0, endSeconds: 4, frameTimeSeconds: 2, rule: "midpoint" },
      { segmentIndex: 1, startSeconds: 4, endSeconds: 4.2, frameTimeSeconds: 4.16, rule: "tail-last" },
    ]);
    expect(expression).toContain("between(t\\,1.999000\\,2.001000)");
    expect(expression).toContain("between(t\\,4.159000\\,4.161000)");
    expect(expression.split("between(")).toHaveLength(3);
    expect(expression).not.toContain("eq(t");
  });
});

describe("buildGridSelectExpression（D1 長片壓縮）", () => {
  /** 產生 600 秒／150 段的等距格線計畫（pick = 2 + 4k）。 */
  function alignedPicks(count: number) {
    return Array.from({ length: count }, (_, index) => ({
      segmentIndex: index,
      startSeconds: index * 4,
      endSeconds: index * 4 + 4,
      frameTimeSeconds: 2 + 4 * index,
      rule: "midpoint" as const,
    }));
  }

  it("150 段等距格線 → 單一短表達式（長度 < 200，不用逐項 between）", () => {
    const expression = buildGridSelectExpression(alignedPicks(150), 4);
    expect(expression).not.toBeNull();
    expect(expression!.length).toBeLessThan(200);
    expect(expression).toContain("floor");
    expect(expression).not.toContain("between");
    expect(expression!.split("lt(")).toHaveLength(2);
  });

  it("尾段（非格線）以一個 between 補上，且逗號已跳脫", () => {
    const picks = [...alignedPicks(2), {
      segmentIndex: 2, startSeconds: 8, endSeconds: 8.2, frameTimeSeconds: 8.166667, rule: "tail-last" as const,
    }];
    const expression = buildGridSelectExpression(picks, 4)!;
    expect(expression).toContain("between(t\\,8.165667\\,8.167667)");
    expect(expression.split("between(")).toHaveLength(2);
  });

  it("尾段內含格點（6.2 秒）：格線條件必須限制在 tailStart 之前，不得多選尾段內的格點", () => {
    const picks = [
      { segmentIndex: 0, startSeconds: 0, endSeconds: 4, frameTimeSeconds: 2, rule: "midpoint" as const },
      { segmentIndex: 1, startSeconds: 4, endSeconds: 6.2, frameTimeSeconds: 6.166667, rule: "tail-last" as const },
    ];
    const expression = buildGridSelectExpression(picks, 4)!;
    // 尾段含 6.0 格點：grid 項需乘上 lt(t,4)，否則會多選 6.0。
    expect(expression).toContain("lt(t\\,4)");
    expect(expression).toContain("between(t\\,6.165667\\,6.167667)");
  });

  it("任何非 tail 的 fallback-last pick → 不使用格線壓縮（return null）", () => {
    const picks = [
      { segmentIndex: 0, startSeconds: 0, endSeconds: 4, frameTimeSeconds: 2, rule: "midpoint" as const },
      { segmentIndex: 1, startSeconds: 4, endSeconds: 8, frameTimeSeconds: 5.5, rule: "fallback-last" as const },
    ];
    expect(buildGridSelectExpression(picks, 4)).toBeNull();
  });

  it("沒有 tail（duration 是 4 的倍數）：格線可用整段時間軸（不加 lt(t,tailStart)）", () => {
    const expression = buildGridSelectExpression([
      { segmentIndex: 0, startSeconds: 0, endSeconds: 4, frameTimeSeconds: 2, rule: "midpoint" as const },
      { segmentIndex: 1, startSeconds: 4, endSeconds: 8, frameTimeSeconds: 6, rule: "midpoint" as const },
    ], 4)!;
    expect(expression).not.toContain("lt(t");
  });
  it("完全不在格線（稀疏／VFR）→ null（caller 走一般或具名拒絕路徑）", () => {
    expect(buildGridSelectExpression([{ segmentIndex: 0, startSeconds: 0, endSeconds: 4, frameTimeSeconds: 2.04, rule: "fallback-last" }], 4)).toBeNull();
    expect(buildGridSelectExpression([], 4)).toBeNull();
  });
});

describe("computeAudioTimeline（D2）", () => {
  it("11.8 秒 AAC＋12 秒畫面：offset 0、end 11.8、2 段、期望樣本 188800", () => {
    const timeline = computeAudioTimeline(probeWithAudio());
    expect(timeline).not.toBeNull();
    expect(timeline!.offsetSeconds).toBe(0);
    expect(timeline!.endSeconds).toBeCloseTo(11.8, 6);
    expect(timeline!.segmentCount).toBe(2);
    expect(timeline!.expectedDecodedSamples).toBe(188_800);
    expect(timeline!.timelineSamples).toBe(188_800);
    expect(timeline!.alignStartSample).toBe(0);
    expect(timeline!.cropStartSamples).toBe(0);
  });

  it("音軌延遲 2 秒：offset≈1.9768、alignStartSample 對齊、end 12", () => {
    const timeline = computeAudioTimeline(probeWithAudio({ audioStart: 1.97678, audioDuration: 10.02322 }));
    expect(timeline!.offsetSeconds).toBeCloseTo(1.97678, 6);
    expect(timeline!.endSeconds).toBeCloseTo(12, 6);
    expect(timeline!.alignStartSample).toBe(Math.round(1.97678 * 16000));
    expect(timeline!.timelineSamples).toBe(192_000);
    expect(timeline!.segmentCount).toBe(2);
  });

  it("音軌起點早於播放時間軸：頭部裁剪，不放大 negative 時間", () => {
    const timeline = computeAudioTimeline(probeWithAudio({ audioStart: -1, audioDuration: 10 }));
    expect(timeline!.offsetSeconds).toBe(0);
    expect(timeline!.cropStartSamples).toBe(16_000);
    expect(timeline!.endSeconds).toBeCloseTo(9, 6);
  });

  it("沒有音軌回 null；時間無效／音軌完全在容器外具名拒絕", () => {
    const noAudio: VideoProbe = { ...probeWithAudio(), audioStreams: [], selectedAudio: null, hasAudio: false };
    expect(computeAudioTimeline(noAudio)).toBeNull();
    const code = (probe: VideoProbe): string | undefined => {
      try { computeAudioTimeline(probe); return undefined; } catch (error) { return error instanceof MediaDecoderError ? error.code : "unexpected"; }
    };
    expect(code(probeWithAudio({ audioStart: 20, audioDuration: 5 }))).toBe("unsupported-video-timeline");
    expect(code(probeWithAudio({ audioDuration: Number.NaN }))).toBe("unsupported-video-timeline");
  });

  it("樣本容差是 priming 級（2048 或 0.1%），不是舊的半秒級", () => {
    expect(audioSampleTolerance(188_800)).toBe(2048);
    expect(audioSampleTolerance(9_600_000)).toBe(9600);
  });
});
