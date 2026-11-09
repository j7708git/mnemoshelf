/**
 * ffprobe／ffmpeg 輸出的純解析與抽樣規則（不 spawn、不做 I/O），供單元測試直接驗證。
 * 所有時間都換算到**播放時間軸（0-based）**；來源起點另存 probe.sourceStartSeconds。
 */
import {
  MediaDecoderError,
  VIDEO_AUDIO_SAMPLE_RATE,
  VIDEO_AUDIO_SEGMENT_SECONDS,
  VIDEO_FRAMES_PER_SEGMENT,
  VIDEO_LONGEST_SIDE,
  VIDEO_SEGMENT_SECONDS,
  type AudioStreamInfo,
  type SelectedAudioStream,
  type VideoProbe,
  type VideoStreamInfo,
  type VisualFramePick,
} from "./types.js";
export type { VisualFramePick } from "./types.js";

/** ffprobe JSON 的最小可用形狀（不信任欄位存在與型別）。 */
export interface RawProbeJson {
  readonly format?: {
    readonly format_name?: unknown;
    readonly duration?: unknown;
    readonly start_time?: unknown;
  };
  readonly streams?: readonly RawProbeStream[];
}

interface RawProbeStream {
  readonly index?: unknown;
  readonly codec_type?: unknown;
  readonly codec_name?: unknown;
  readonly profile?: unknown;
  readonly width?: unknown;
  readonly height?: unknown;
  readonly pix_fmt?: unknown;
  readonly avg_frame_rate?: unknown;
  readonly r_frame_rate?: unknown;
  readonly sample_rate?: unknown;
  readonly channels?: unknown;
  readonly start_time?: unknown;
  readonly duration?: unknown;
  readonly initial_padding?: unknown;
  readonly disposition?: { readonly default?: unknown };
  readonly side_data_list?: readonly { readonly rotation?: unknown }[];
}

/** 解析出的容器與 stream 資訊（未套用產品限制）。 */
export interface ParsedProbe {
  readonly container: string;
  readonly durationSeconds: number;
  readonly sourceStartSeconds: number;
  readonly video: VideoStreamInfo | null;
  readonly audioStreams: readonly AudioStreamInfo[];
  readonly selectedAudio: SelectedAudioStream | null;
}

function asFiniteNumber(value: unknown, fallback: number | null = null): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

/** 把 ffprobe 的 display matrix rotation（可能為 90／-90／180／0）正規化成 0/90/180/270。 */
export function normalizeRotationDegrees(raw: number | null | undefined): 0 | 90 | 180 | 270 {
  if (raw === null || raw === undefined || !Number.isFinite(raw)) return 0;
  const wrapped = ((raw % 360) + 360) % 360;
  const snapped = Math.round(wrapped / 90) * 90;
  // 不是 90 度整數倍的垃圾值一律視為 0，不做四捨五入猜測。
  if (Math.abs(wrapped - snapped) > 1) return 0;
  const normalized = snapped % 360;
  return normalized === 90 || normalized === 180 || normalized === 270 ? normalized : 0;
}

function rotationOf(stream: RawProbeStream): 0 | 90 | 180 | 270 {
  for (const side of stream.side_data_list ?? []) {
    const value = asFiniteNumber(side.rotation, null);
    if (value !== null) return normalizeRotationDegrees(value);
  }
  return 0;
}

/**
 * 選音軌規則（B1 凍結）：第一個帶 default 標記的 AAC；否則第一個 AAC。
 * 完全沒有 AAC 時，回傳第一個 default 音軌（或第一個音軌）並標 isAac=false，
 * 讓 indexer 能以具名原因整檔跳過；完全沒有音軌時回 null。
 */
export function selectAudioTrack(audioStreams: readonly AudioStreamInfo[]): SelectedAudioStream | null {
  if (audioStreams.length === 0) return null;
  const aac = audioStreams.filter((stream) => stream.codec === "aac");
  const pick = aac.find((stream) => stream.hasDefault) ?? aac[0];
  if (pick) return { ...pick, isAac: true };
  const fallback = audioStreams.find((stream) => stream.hasDefault) ?? audioStreams[0];
  if (!fallback) return null;
  return { ...fallback, isAac: false };
}

/** 解析 ffprobe 的 `-print_format json -show_streams -show_format` 輸出。 */
export function parseProbeJson(text: string): ParsedProbe {
  let json: RawProbeJson;
  try {
    json = JSON.parse(text) as RawProbeJson;
  } catch {
    throw new MediaDecoderError("invalid-video");
  }
  const container = asString(json.format?.format_name);
  const durationSeconds = asFiniteNumber(json.format?.duration, null);
  const sourceStartSeconds = asFiniteNumber(json.format?.start_time, 0) ?? 0;
  if (durationSeconds === null || durationSeconds < 0) throw new MediaDecoderError("invalid-video");
  if (!Array.isArray(json.streams)) throw new MediaDecoderError("invalid-video");

  let video: VideoStreamInfo | null = null;
  const audioStreams: AudioStreamInfo[] = [];
  for (const stream of json.streams) {
    if (stream.codec_type === "video") {
      if (video) continue; // 只取第一個影像流；多影像流的政策不在 B1 範圍。
      const width = asFiniteNumber(stream.width, 0) ?? 0;
      const height = asFiniteNumber(stream.height, 0) ?? 0;
      if (width <= 0 || height <= 0) throw new MediaDecoderError("invalid-video");
      video = {
        codec: asString(stream.codec_name, "unknown"),
        ...(asString(stream.profile) ? { profile: asString(stream.profile) } : {}),
        width,
        height,
        ...(asString(stream.pix_fmt) ? { pixFmt: asString(stream.pix_fmt) } : {}),
        rotationDegrees: rotationOf(stream),
        avgFrameRate: asString(stream.avg_frame_rate, "0/0"),
        rFrameRate: asString(stream.r_frame_rate, "0/0"),
        ...(asFiniteNumber(stream.start_time, null) !== null ? { startTimeSeconds: asFiniteNumber(stream.start_time, null)! } : {}),
        ...(asFiniteNumber(stream.duration, null) !== null ? { durationSeconds: asFiniteNumber(stream.duration, null)! } : {}),
      };
    } else if (stream.codec_type === "audio") {
      const index = asFiniteNumber(stream.index, null);
      if (index === null || index < 0) continue;
      const sampleRate = asFiniteNumber(stream.sample_rate, null);
      const channels = asFiniteNumber(stream.channels, null);
      const streamStart = asFiniteNumber(stream.start_time, null);
      const streamDuration = asFiniteNumber(stream.duration, null);
      const initialPadding = asFiniteNumber(stream.initial_padding, null);
      audioStreams.push({
        streamIndex: index,
        codec: asString(stream.codec_name, "unknown"),
        ...(sampleRate !== null ? { sampleRate } : {}),
        ...(channels !== null ? { channels } : {}),
        hasDefault: stream.disposition?.default === 1 || stream.disposition?.default === true,
        ...(streamStart !== null ? { startTimeSeconds: streamStart } : {}),
        ...(streamDuration !== null ? { durationSeconds: streamDuration } : {}),
        ...(initialPadding !== null ? { initialPaddingSamples: initialPadding } : {}),
      });
    }
  }
  return { container, durationSeconds, sourceStartSeconds, video, audioStreams, selectedAudio: selectAudioTrack(audioStreams) };
}

/** 把 ParsedProbe 補成完整 VideoProbe。 */
export function toVideoProbe(parsed: ParsedProbe): VideoProbe {
  return {
    container: parsed.container,
    durationSeconds: parsed.durationSeconds,
    sourceStartSeconds: parsed.sourceStartSeconds,
    video: parsed.video,
    audioStreams: parsed.audioStreams,
    selectedAudio: parsed.selectedAudio,
    hasVideo: parsed.video !== null,
    hasAudio: parsed.audioStreams.length > 0,
  };
}

/**
 * 依 display matrix 旋轉後的可視尺寸（ffmpeg autorotate 解碼後所見）。
 * 90／270 度會交換寬高；其餘不變。
 */
export function displayDimensions(video: Pick<VideoStreamInfo, "width" | "height" | "rotationDegrees">): { width: number; height: number } {
  return video.rotationDegrees === 90 || video.rotationDegrees === 270
    ? { width: video.height, height: video.width }
    : { width: video.width, height: video.height };
}

/**
 * 縮圖濾鏡：縮到「最長邊 <= longestSide」且保持比例；不放大來源。
 * 由於 adapter 先做 probe，這裡用固定濾鏡（不用需要跳脫的 expression）。
 */
export function buildScaleFilter(displayWidth: number, displayHeight: number, longestSide = VIDEO_LONGEST_SIDE): string | null {
  if (displayWidth <= 0 || displayHeight <= 0) throw new MediaDecoderError("invalid-video");
  const longest = Math.max(displayWidth, displayHeight);
  if (longest <= longestSide) return null;
  return displayWidth >= displayHeight ? `scale=${longestSide}:-2` : `scale=-2:${longestSide}`;
}

/**
 * 縮圖後的輸出尺寸（與 buildScaleFilter 等價；ffmpeg 的 -2 會保持比例並對齊偶數）。
 * 用於配幀大小與輸出上限；不是猜測容器尺寸。
 */
export function scaledDimensions(displayWidth: number, displayHeight: number, longestSide = VIDEO_LONGEST_SIDE): { width: number; height: number } {
  const longest = Math.max(displayWidth, displayHeight);
  if (longest <= longestSide) return { width: displayWidth, height: displayHeight };
  if (displayWidth >= displayHeight) {
    const height = Math.round((displayHeight * longestSide) / displayWidth / 2) * 2;
    return { width: longestSide, height: Math.max(2, height) };
  }
  const width = Math.round((displayWidth * longestSide) / displayHeight / 2) * 2;
  return { width: Math.max(2, width), height: longestSide };
}

/** 每段取幀的目標偏移（秒）：1 幀取中間；2 幀取 0／半段；4 幀取四等分。 */
export function frameOffsetsSeconds(segmentSeconds = VIDEO_SEGMENT_SECONDS, framesPerSegment = VIDEO_FRAMES_PER_SEGMENT): number[] {
  if (framesPerSegment === 1) return [segmentSeconds / 2];
  if (framesPerSegment === 2) return [0, segmentSeconds / 2];
  if (framesPerSegment === 4) return [0, segmentSeconds / 4, segmentSeconds / 2, (segmentSeconds * 3) / 4];
  throw new RangeError(`每段幀數必須是 1、2 或 4（收到 ${framesPerSegment}）`);
}

/**
 * 在一個片段內選幀（純函式；供串流實作與單元測試共用）。
 * - 完整片段：每個目標偏移挑該偏移之後第一幀（1 fps 幀格上通常就是該秒）；沒有則用片段內最後一幀。
 * - 尾段（長度 < segmentSeconds）：依 B1 凍結規則**取最後一幀**。
 */
export function selectFrameIndices(frameTimestampsSeconds: readonly number[], startSeconds: number, endSeconds: number, segmentSeconds = VIDEO_SEGMENT_SECONDS, framesPerSegment = VIDEO_FRAMES_PER_SEGMENT): number[] {
  const indices: number[] = [];
  const isTail = endSeconds - startSeconds < segmentSeconds - 1e-6;
  if (isTail) {
    if (frameTimestampsSeconds.length > 0) indices.push(frameTimestampsSeconds.length - 1);
    return indices;
  }
  for (const offset of frameOffsetsSeconds(segmentSeconds, framesPerSegment)) {
    const target = startSeconds + offset;
    let picked = -1;
    for (let i = 0; i < frameTimestampsSeconds.length; i++) {
      if (frameTimestampsSeconds[i]! + 1e-6 >= target) { picked = i; break; }
    }
    if (picked < 0) picked = frameTimestampsSeconds.length - 1;
    if (picked >= 0 && !indices.includes(picked)) indices.push(picked);
  }
  return indices.sort((a, b) => a - b);
}

/** 600 秒／4 秒／最多 4 幀的有界選幀上限；加法樹採平衡括號避免 FFmpeg 深度上限。 */
export const MAX_FRAME_SELECT_TERMS = 600;

/**
 * 對「等距格線」的選幀計畫產生極短 select 表達式（D1 長片用）。
 *
 * 若所有非尾段 pick 都落在 `start + segmentSeconds/2` 的等距格線上（例如 600 秒 CFR 影片），
 * 用一個 `abs(t - 最近格點)` 條件即可選完，不必逐項列出 150 個 between（ffmpeg 的
 * select 表達式在約 100 項後會解析失敗）。尾段或離格線的 pick 仍以 between 逐項補上。
 * 一個格線項都沒有時回 null（由 caller 走一般路徑）。
 */
export function buildGridSelectExpression(
  picks: readonly VisualFramePick[],
  segmentSeconds: number = 4,
  toleranceSeconds = 0.001,
): string | null {
  const mid = segmentSeconds / 2;
  const extras: string[] = [];
  let gridCount = 0;
  let tailStart: number | undefined;
  for (const pick of picks) {
    if (pick.rule === "tail-last") {
      // 凍結政策只有最後一段可能是尾段；多個尾段不是合法形狀，不用猜。
      if (tailStart !== undefined) return null;
      tailStart = pick.startSeconds;
      extras.push(buildFrameSelectExpression([pick]));
      continue;
    }
    // 只有「完整段、rule=midpoint 且恰在段中點格線」才可用壓縮；fallback-last 或偏離格點
    // 一律走 explicit（避免稀疏影片的 fallback 段被誤選成格點）。
    if (pick.rule !== "midpoint") return null;
    const target = pick.startSeconds + mid;
    if (Math.abs(pick.frameTimeSeconds - target) > toleranceSeconds) return null;
    gridCount += 1;
  }
  if (gridCount === 0) return null;
  // 最近格點：mid + segmentSeconds * floor((t - mid)/segmentSeconds + 0.5)；逗號需跳脫給 filtergraph。
  const gridBase = "lt(abs(t-(" + mid + "+" + segmentSeconds + "*floor((t-" + mid + ")/" + segmentSeconds + "+0.5)))\\,0.002)";
  // 有尾段時格線只作用到尾段起點之前：尾段內可能含下一個格點（例如 6.2 秒的 6.0），
  // 不限制會多選一幀，framesSeen 與 picks.length 對不上就會被誤判 unsupported。
  const grid = tailStart === undefined ? gridBase : "lt(t\\," + tailStart + ")*" + gridBase;
  return [grid, ...extras].join("+");
}

/** showinfo 的 pts_time 增量解析器：處理跨 chunk 的半行；每個時間只回傳一次。 */
export class ShowinfoPtsParser {
  private remainder = "";
  private readonly values: number[] = [];
  private consumed = 0;

  private ingest(line: string): void {
    const match = /pts_time:\s*(-?\d+(?:\.\d+)?)/.exec(line);
    if (!match) return;
    const value = Number(match[1]);
    if (Number.isFinite(value) && value >= -1e-6) this.values.push(Math.max(0, value));
  }

  push(text: string): void {
    const combined = this.remainder + text;
    const lines = combined.split(/\r?\n/);
    this.remainder = lines.pop() ?? "";
    for (const line of lines) this.ingest(line);
  }

  /** flush 最後一行（若沒有換行）。 */
  flush(): void {
    if (this.remainder.length === 0) return;
    this.ingest(this.remainder);
    this.remainder = "";
  }

  /** 取出尚未取用的新時間。 */
  drainNew(): number[] {
    const fresh = this.values.slice(this.consumed);
    this.consumed = this.values.length;
    return fresh;
  }

  get count(): number { return this.values.length; }
  get all(): readonly number[] { return this.values; }
}

/** 音訊段長驗證。 */
export function normalizeAudioSegmentSeconds(seconds = VIDEO_AUDIO_SEGMENT_SECONDS): number {
  if (!Number.isFinite(seconds) || seconds <= 0) throw new RangeError("音訊段長必須大於零");
  const frames = seconds * 16000;
  if (!Number.isInteger(frames)) throw new RangeError("音訊段長必須對應整數個 16 kHz 樣本");
  return seconds;
}

/** 視覺段長驗證（凍結 4；僅測試可改）。 */
export function normalizeVisualSegmentSeconds(seconds = VIDEO_SEGMENT_SECONDS): number {
  if (!Number.isFinite(seconds) || seconds <= 0) throw new RangeError("視覺段長必須大於零");
  return seconds;
}
/** 由 ffprobe `-show_frames -show_entries frame=pts_time -of csv=p=0` 解析來源 frame pts（秒）。 */
export function parseFramePtsList(text: string): number[] {
  const times: number[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    // ffprobe 在 -show_frames 可能附帶 side_data（例如 display matrix），csv 第一欄才是 pts_time。
    const firstField = rawLine.split(",")[0]!.trim();
    if (!/^-?\d+(?:\.\d+)?$/.test(firstField)) continue;
    const value = Number(firstField);
    if (Number.isFinite(value)) times.push(value);
  }
  return times;
}

/** 解析具欄位名稱的 ffprobe compact 幀表；不依賴 show_entries 的欄位輸出順序。 */
export function parseFrameTimeline(text: string): { times: number[]; lastFrameDurationSeconds?: number } {
  const times: number[] = [];
  let lastFrameDurationSeconds: number | undefined;
  for (const line of text.split(/\r?\n/)) {
    // p=1 保留 section 名稱：side_data 等附屬行可略過，frame 行缺 PTS 必須拒絕。
    if (line !== "frame" && !line.startsWith("frame|")) continue;
    const fields = Object.fromEntries(line.split("|").slice(1).map((field) => field.split("=")));
    const pts = asFiniteNumber(fields["pts_time"]);
    if (pts === null) timelineReject();
    times.push(pts);
    const duration = asFiniteNumber(fields["duration_time"]);
    lastFrameDurationSeconds = duration !== null && duration > 0 ? duration : undefined;
  }
  if (times.length === 0) timelineReject();
  return { times, ...(lastFrameDurationSeconds !== undefined ? { lastFrameDurationSeconds } : {}) };
}

/** 選幀的固定誤差（秒）：只吸收浮點與 ffprobe 的 6 位小數誤差，不用來放寬規則。 */
const TIMELINE_EPSILON = 1e-6;

function timelineReject(): never {
  throw new MediaDecoderError("unsupported-video-timeline");
}

/**
 * 依 D1 規則由**來源 frame pts** 計算每段要取哪一幀（純函式）。
 *
 * - 段界：段 i = [i*segmentSeconds, min((i+1)*segmentSeconds, duration))；
 * - 完整段：每個目標偏移（1 幀＝中點）取「該偏移之後第一幀」，沒有則取段內最後一幀；
 * - 尾段（長度 < segmentSeconds）：取段內最後一幀；
 * - 只有最後的不足一段空格可省略，且最後影格的實際時長必須證明覆蓋結尾；
 *   容器時長只允許向上取整到毫秒的量化差，不推估 FPS、不容許中間缺段。
 * - 其餘空段、時間重複／亂序、或 duration 非有限 → unsupported-video-timeline。
 *
 * 這裡刻意不使用「段號 × 平均 FPS」推估：frameTimeSeconds 一律是輸入 frame pts 之一。
 */
export function planVisualFrames(
  frameTimesSeconds: readonly number[],
  durationSeconds: number,
  segmentSeconds = VIDEO_SEGMENT_SECONDS,
  framesPerSegment = VIDEO_FRAMES_PER_SEGMENT,
  lastFrameDurationSeconds?: number,
): VisualFramePick[] {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) timelineReject();
  if (!Number.isFinite(segmentSeconds) || segmentSeconds <= 0) throw new RangeError("segmentSeconds 必須大於零");
  if (frameTimesSeconds.length === 0) timelineReject();
  for (let index = 0; index < frameTimesSeconds.length; index += 1) {
    const time = frameTimesSeconds[index]!;
    if (!Number.isFinite(time) || time < -TIMELINE_EPSILON) timelineReject();
    if (index > 0 && time <= frameTimesSeconds[index - 1]! + TIMELINE_EPSILON) timelineReject();
  }
  const segmentCount = Math.max(1, Math.ceil(durationSeconds / segmentSeconds - TIMELINE_EPSILON));
  const picks: VisualFramePick[] = [];
  for (let segmentIndex = 0; segmentIndex < segmentCount; segmentIndex += 1) {
    const startSeconds = segmentIndex * segmentSeconds;
    const endSeconds = Math.min(durationSeconds, startSeconds + segmentSeconds);
    const candidates: number[] = [];
    for (const time of frameTimesSeconds) {
      if (time >= startSeconds - TIMELINE_EPSILON && time < endSeconds - TIMELINE_EPSILON) candidates.push(time);
    }
    const isTail = endSeconds - startSeconds < segmentSeconds - TIMELINE_EPSILON;
    if (candidates.length === 0) {
      const last = frameTimesSeconds.at(-1)!;
      const lastEnd = last + (lastFrameDurationSeconds ?? Number.NaN);
      const roundedEnd = Math.ceil((lastEnd - TIMELINE_EPSILON) * 1000) / 1000;
      if (segmentIndex === segmentCount - 1 && segmentIndex > 0 && isTail
        && last >= startSeconds - segmentSeconds && last < startSeconds
        && Number.isFinite(lastEnd) && lastEnd >= startSeconds - TIMELINE_EPSILON
        // ffprobe 兩個六位小數相加最多差一個微秒；整數比較避免 60 秒浮點加法再多出 ulp。
        && Math.round(lastEnd * 1e6) <= Math.round(durationSeconds * 1e6) + 1
        && durationSeconds <= roundedEnd + TIMELINE_EPSILON) continue;
      timelineReject();
    }
    const offsets = frameOffsetsSeconds(segmentSeconds, framesPerSegment);
    const picked: { time: number; rule: VisualFramePick["rule"] }[] = [];
    for (const offset of offsets) {
      if (isTail) {
        picked.push({ time: candidates[candidates.length - 1]!, rule: "tail-last" });
        continue;
      }
      const target = startSeconds + offset;
      const match = candidates.find((time) => time >= target - TIMELINE_EPSILON);
      if (match !== undefined) picked.push({ time: match, rule: offset === segmentSeconds / 2 && framesPerSegment === 1 ? "midpoint" : "midpoint" });
      else picked.push({ time: candidates[candidates.length - 1]!, rule: "fallback-last" });
    }
    const seen = new Set<number>();
    for (const item of picked) {
      if (seen.has(item.time)) continue;
      seen.add(item.time);
      picks.push({ segmentIndex, startSeconds, endSeconds, frameTimeSeconds: item.time, rule: item.rule });
    }
  }
  if (picks.length === 0) timelineReject();
  return picks;
}

/**
 * 產生 ffmpeg `select` 表達式：只選出計畫中的 PTS（容差內）。
 * 不要用 `eq(t,X)`（浮點相等不可靠）；用 between 組合。
 */
export function buildFrameSelectExpression(picks: readonly VisualFramePick[], toleranceSeconds = 0.001): string {
  if (picks.length === 0 || picks.length > MAX_FRAME_SELECT_TERMS) timelineReject();
  const terms = picks.map((pick) => {
    const low = Math.max(0, pick.frameTimeSeconds - toleranceSeconds).toFixed(6);
    const high = (pick.frameTimeSeconds + toleranceSeconds).toFixed(6);
    // filtergraph 以逗號分隔濾鏡；between 參數內的逗號必須以反斜線跳脫（不經 shell，反斜線會原樣傳給 ffmpeg）。
    return "between(t\\," + low + "\\," + high + ")";
  });
  // FFmpeg eval.c 的 MAX_DEPTH=100：線性加法樹會超限，平衡樹深度僅 O(log n)。
  const combine = (start: number, end: number): string => {
    if (end - start === 1) return terms[start]!;
    const mid = Math.floor((start + end) / 2);
    return "(" + combine(start, mid) + "+" + combine(mid, end) + ")";
  };
  const expression = combine(0, terms.length);
  if (expression.length > 28_000) timelineReject();
  return expression;
}

/** 音軌播放時間軸（D2）：indexer 預期佈局與 decoder 實際輸出共用同一份計算。 */
export interface VideoAudioTimeline {
  readonly streamIndex: number;
  /** 解碼音訊在播放時間軸的起點（秒，0-based）；之前補靜音。 */
  readonly offsetSeconds: number;
  /** 播放時間軸結尾（秒）；段界為 [i*10, min((i+1)*10, endSeconds)]。 */
  readonly endSeconds: number;
  readonly segmentCount: number;
  /** ffmpeg 解出的樣本數期望值（round(audioStreamDuration*16000)，未扣頭尾裁剪）。 */
  readonly expectedDecodedSamples: number;
  /** 解碼輸出頭部要丟棄的樣本數（音軌起點早於播放時間軸 0 時）。 */
  readonly cropStartSamples: number;
  /** 解碼輸出尾端要丟棄的樣本數（音軌超出容器結尾）。 */
  readonly cropEndSamples: number;
  /** 播放時間軸總樣本數（round(endSeconds*16000)，含 leading 靜音）。 */
  readonly timelineSamples: number;
  /** leading 靜音長度（樣本）：round(offsetSeconds*16000)。 */
  readonly alignStartSample: number;
}

/**
 * 由 probe 的 per-stream 時間計算音軌播放時間軸；沒有音軌回 null。
 *
 * 規則（契約 D2）：offset = max(0, audio.start - format.start)；end = min(format.duration, offset + audio.duration)。
 * 音軌起點早於播放時間軸 0（負 offset）→ 從解碼輸出頭部裁剪；超出容器結尾 → 裁尾。
 * 任何一項無法可靠定義 → unsupported-video-timeline（不放大容差、不猜測）。
 */
export function computeAudioTimeline(probe: VideoProbe): VideoAudioTimeline | null {
  const selected = probe.selectedAudio;
  if (!probe.hasAudio || selected === null) return null;
  const formatStart = probe.sourceStartSeconds;
  const formatDuration = probe.durationSeconds;
  const audioStart = selected.startTimeSeconds ?? formatStart;
  const audioDuration = selected.durationSeconds ?? formatDuration;
  if (!Number.isFinite(formatStart) || !Number.isFinite(formatDuration) || formatDuration <= 0) timelineReject();
  if (!Number.isFinite(audioStart) || !Number.isFinite(audioDuration) || audioDuration <= 0) timelineReject();
  const rawStart = audioStart - formatStart;
  const rawEnd = rawStart + audioDuration;
  if (!Number.isFinite(rawStart) || !Number.isFinite(rawEnd)) timelineReject();
  const offsetSeconds = Math.max(0, rawStart);
  const endSeconds = Math.min(formatDuration, rawEnd);
  if (!(endSeconds > offsetSeconds + TIMELINE_EPSILON)) timelineReject();
  const decodedTotal = Math.round(audioDuration * VIDEO_AUDIO_SAMPLE_RATE);
  const cropStartSamples = Math.round(Math.max(0, -rawStart) * VIDEO_AUDIO_SAMPLE_RATE);
  const cropEndSamples = Math.round(Math.max(0, rawEnd - endSeconds) * VIDEO_AUDIO_SAMPLE_RATE);
  if (cropStartSamples + cropEndSamples >= decodedTotal) timelineReject();
  const alignStartSample = Math.round(offsetSeconds * VIDEO_AUDIO_SAMPLE_RATE);
  const timelineSamples = Math.round(endSeconds * VIDEO_AUDIO_SAMPLE_RATE);
  if (alignStartSample < 0 || timelineSamples <= alignStartSample) timelineReject();
  const segmentCount = Math.max(1, Math.ceil(endSeconds / VIDEO_AUDIO_SEGMENT_SECONDS - TIMELINE_EPSILON));
  return { streamIndex: selected.streamIndex, offsetSeconds, endSeconds, segmentCount, expectedDecodedSamples: decodedTotal, cropStartSamples, cropEndSamples, timelineSamples, alignStartSample };
}

/** 音軌樣本數容差（D2）：只允許 AAC priming 級誤差，不可用舊的 0.2%／半秒級大容差。 */
export function audioSampleTolerance(expectedDecodedSamples: number): number {
  return Math.max(2048, Math.round(expectedDecodedSamples * 0.001));
}
