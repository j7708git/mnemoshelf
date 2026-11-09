/**
 * FfmpegMediaDecoder：以固定版本的 ffmpeg／ffprobe 外部程序實作 MediaDecoder port。
 *
 * 安全與穩定性邊界（B1／波次一）：
 * - 一律只吃絕對路徑；不經 shell；Windows 不開 console；不讀系統 PATH。
 * - 固定 -f mov、-protocol_whitelist file；不開 -enable_drefs／-use_absolute_path，
 *   也不傳 -safe 0；不允許外部 data reference 或文字型 demuxer 被自動選中。
 * - probe stdout／stderr 各 1 MiB 上限、預設 15 秒 deadline。
 * - 視覺解碼：先用 ffprobe 取來源 frame pts，Node 端依 D1 規則算好每段要哪一幀，
 *   再用單一 ffmpeg select 保留來源 PTS（不用 fps 輸出格）；正常無競爭時一個程序跨 yield 解完整檔，
 *   僅在需要讓出程序名額時於段界以 -ss 恢復（t' = t - 段起點）。
 * - 解碼程序生命週期名額（D4 補修）：decoder 實例內建容量 1 的 DecodeProcessBudget，
 *   spawn 前 acquire、程序 close 後 release；跨所有 roots 同時最多 1 個解碼 ffmpeg。
 *   probe／readVideoFrameTimes 的 ffprobe 是每檔一次前置探測，不納入此預算。
 * - 音軌解碼：ffprobe per-stream start／duration 對齊播放時間軸（leading offset 補靜音），
 *   段界與 indexer 共用 computeAudioTimeline。
 * - 時間一律是播放時間軸（0-based）；probe 另保留 sourceStartSeconds 供除錯／來源映射。
 * - 程序樹在成功／失敗／取消／deadline 後都回收；本 adapter 不建立暫存檔。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  MediaDecoderError,
  VIDEO_AUDIO_SAMPLE_RATE,
  VIDEO_AUDIO_SEGMENT_SECONDS,
  VIDEO_FRAMES_PER_SEGMENT,
  VIDEO_LONGEST_SIDE,
  VIDEO_SEGMENT_SECONDS,
  DEFAULT_MEDIA_DECODER_LIMITS,
  visualPreprocessingVersion,
  videoAudioPreprocessingVersion,
  type AudioSegment,
  type DecodeAudioOptions,
  type DecodeCallOptions,
  type DecodeVisualOptions,
  type DecoderAvailability,
  type MediaDecoder,
  type MediaDecoderLimits,
  type MediaSource,
  type ProbeOptions,
  type VideoProbe,
  type VisualFrame,
  type VisualSegment,
} from "./types.js";
import {
  audioSampleTolerance,
  buildFrameSelectExpression,
  buildScaleFilter,
  computeAudioTimeline,
  buildGridSelectExpression,
  MAX_FRAME_SELECT_TERMS,
  displayDimensions,
  normalizeAudioSegmentSeconds,
  normalizeVisualSegmentSeconds,
  parseFrameTimeline,
  parseProbeJson,
  planVisualFrames,
  scaledDimensions,
  selectFrameIndices,
  ShowinfoPtsParser,
  toVideoProbe,
  type VisualFramePick,
} from "./parse.js";
import { classifyProcessFailure, classifyProbeJsonProblem } from "./classify.js";
import { DecodeProcessBudget, type DecodeBudgetStats, type DecodeProcessLease } from "./decode-budget.js";
import { runProcess, startProcess, type StartedProcess } from "./process.js";

const DEFAULT_PROBE_TIMEOUT_MS = 15_000;
const DEFAULT_VERSION_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_PROBE_BYTES = 1024 * 1024;
const DEFAULT_MAX_STDERR_BYTES = 1024 * 1024;
/** ffprobe -show_frames 的清單上限（600 秒、120 fps 也遠小於此）。 */
const MAX_FRAME_LIST_BYTES = 4 * 1024 * 1024;
/** 選幀結果與 showinfo 實際 PTS 的最大允許差（秒）：只吸收 6 位小數誤差。 */
const FRAME_PTS_MATCH_TOLERANCE = 0.002;
/** 8-bit SDR 的 H.264 pixel format 白名單（10-bit／HDR 不在首版範圍）。 */
const SUPPORTED_PIX_FMTS = new Set(["yuv420p", "yuvj420p", "yuv422p", "yuv444p"]);

export interface FfmpegMediaDecoderOptions {
  /** ffmpeg 執行檔絕對路徑（不由 PATH 解析）。 */
  readonly ffmpegPath: string;
  /** ffprobe 執行檔絕對路徑（不由 PATH 解析）。 */
  readonly ffprobePath: string;
  /** 覆寫硬限制（預設 600 秒／512 MiB／1920×1080 等價像素）。 */
  readonly limits?: Partial<MediaDecoderLimits>;
  readonly probeTimeoutMs?: number;
  readonly versionTimeoutMs?: number;
  readonly maxProbeBytes?: number;
  readonly maxStderrBytes?: number;
  readonly visualTimeoutMs?: (durationSeconds: number) => number;
  readonly audioTimeoutMs?: (durationSeconds: number) => number;
  /** 測試可注入專屬程序名額；預設每個 decoder 實例一個容量 1 的 budget。 */
  readonly budget?: DecodeProcessBudget;
}

function assertSource(source: MediaSource): string {
  const candidate = source?.path;
  if (typeof candidate !== "string" || candidate.length === 0) throw new TypeError("MediaSource.path 必須是非空字串");
  if (!path.isAbsolute(candidate)) throw new TypeError("MediaSource.path 必須是絕對路徑（呼叫端負責 root 驗證）");
  if (candidate.includes("://")) throw new TypeError("MediaSource.path 不得是 URL");
  return candidate;
}

interface ProcessSnapshot {
  killed: { deadline: boolean; abort: boolean; outputCap: boolean };
  spawnError: string | null;
  code: number | null;
  signal: NodeJS.Signals | null;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  stderr: string;
}

function snapshotOf(proc: StartedProcess, code: number | null, signal: NodeJS.Signals | null = null): ProcessSnapshot {
  return {
    killed: proc.killed,
    spawnError: proc.spawnError(),
    code,
    signal,
    stdoutTruncated: proc.stdoutTruncated(),
    stderrTruncated: proc.stderrTruncated(),
    stderr: proc.stderrText(),
  };
}

/** 視覺解碼 session 的讓出狀態（D4 補修）。 */
interface VisualSessionState {
  /** 目前是否暫停在 yield（等待嵌入）——此時收到 preempt 可立即關程序。 */
  parked: boolean;
  /** handler 在解碼中抵達：目前片段完成、yield 前讓出。 */
  closeRequested: boolean;
  /** 已被主動讓出而 kill；不算失敗。 */
  preempted: boolean;
}

/** 一次 ffmpeg 解碼 session；正常解到 EOF，或於段界被讓出後重建。 */
interface VisualDecodeSession {
  readonly lease: DecodeProcessLease;
  readonly proc: StartedProcess;
  readonly parser: ShowinfoPtsParser;
  /** 這一輪從哪個全域 pick index 開始（必為段起點）。 */
  readonly localStartIndex: number;
  /** 這一輪的 -ss 對應播放時間軸秒數（段起點）。 */
  readonly startSeconds: number;
  /** 這一輪預期輸出幾個 pick。 */
  readonly localPickCount: number;
  /** 這一輪已消費幾個 pick（驗證 PTS 用）。 */
  localFramesSeen: number;
  readonly state: VisualSessionState;
  closed: boolean;
  closing: Promise<void> | null;
  exited: boolean;
  aborted: boolean;
  removeAbort: () => void;
}

function failed(result: ProcessSnapshot): boolean {
  return result.spawnError !== null || result.killed.abort || result.killed.deadline || result.killed.outputCap || result.code !== 0 || result.signal !== null;
}

function unsupportedTimeline(sourcePath: string): never {
  throw new MediaDecoderError("unsupported-video-timeline", sourcePath);
}

export class FfmpegMediaDecoder implements MediaDecoder {
  private readonly ffmpegPath: string;
  private readonly ffprobePath: string;
  private readonly limits: MediaDecoderLimits;
  private readonly probeTimeoutMs: number;
  private readonly versionTimeoutMs: number;
  private readonly maxProbeBytes: number;
  private readonly maxStderrBytes: number;
  private readonly visualTimeoutMs: (durationSeconds: number) => number;
  private readonly audioTimeoutMs: (durationSeconds: number) => number;
  /** 跨所有 roots 的解碼程序名額（此 decoder 實例共用；server 只建一個實例）。 */
  readonly decodeBudget: DecodeProcessBudget;
  private availability: Promise<DecoderAvailability> | null = null;
  /** 綁在本輪 probe 物件；快照釋放後可回收，不以路徑快取可能過期的時間線。 */
  private readonly frameTimelines = new WeakMap<VideoProbe, ReturnType<typeof parseFrameTimeline>>();

  constructor(options: FfmpegMediaDecoderOptions) {
    this.ffmpegPath = options.ffmpegPath;
    this.ffprobePath = options.ffprobePath;
    this.limits = { ...DEFAULT_MEDIA_DECODER_LIMITS, ...options.limits };
    this.probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    this.versionTimeoutMs = options.versionTimeoutMs ?? DEFAULT_VERSION_TIMEOUT_MS;
    this.maxProbeBytes = options.maxProbeBytes ?? DEFAULT_MAX_PROBE_BYTES;
    this.maxStderrBytes = options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES;
    this.visualTimeoutMs = options.visualTimeoutMs ?? ((duration) => Math.min(180_000, Math.max(15_000, Math.ceil(duration * 100))));
    this.audioTimeoutMs = options.audioTimeoutMs ?? ((duration) => Math.min(150_000, Math.max(15_000, Math.ceil(duration * 50))));
    this.decodeBudget = options.budget ?? new DecodeProcessBudget(1);
  }

  /** 程序生命週期名額的即時統計（測試與診斷用）。 */
  budgetStats(): DecodeBudgetStats {
    return this.decodeBudget.stats();
  }

  /** 檢查兩個 binary 是否可用；缺失／損毀回 available=false（不拋）。結果快取。 */
  checkAvailability(): Promise<DecoderAvailability> {
    this.availability ??= this.probeAvailability();
    return this.availability;
  }

  private async probeAvailability(): Promise<DecoderAvailability> {
    const [ffmpeg, ffprobe] = await Promise.all([
      runProcess(this.ffmpegPath, ["-version"], { timeoutMs: this.versionTimeoutMs, maxStdoutBytes: 64 * 1024, maxStderrBytes: 64 * 1024 }),
      runProcess(this.ffprobePath, ["-version"], { timeoutMs: this.versionTimeoutMs, maxStdoutBytes: 64 * 1024, maxStderrBytes: 64 * 1024 }),
    ]);
    const ffmpegOk = ffmpeg.code === 0 && /ffmpeg version/i.test(ffmpeg.stdout.toString("utf8"));
    const ffprobeOk = ffprobe.code === 0 && /ffprobe version/i.test(ffprobe.stdout.toString("utf8"));
    if (ffmpegOk && ffprobeOk) {
      return { available: true, ffmpegVersion: firstLine(ffmpeg.stdout.toString("utf8")), ffprobeVersion: firstLine(ffprobe.stdout.toString("utf8")) };
    }
    if (!ffmpegOk) return { available: false, reason: ffmpeg.spawnError !== null && /ENOENT/i.test(ffmpeg.spawnError) ? "missing-ffmpeg" : "ffmpeg-failed" };
    return { available: false, reason: ffprobe.spawnError !== null && /ENOENT/i.test(ffprobe.spawnError) ? "missing-ffprobe" : "ffprobe-failed" };
  }

  async probe(source: MediaSource, options: ProbeOptions = {}): Promise<VideoProbe> {
    const sourcePath = assertSource(source);
    const availability = await this.checkAvailability();
    if (!availability.available) throw new MediaDecoderError("video-decoder-unavailable", sourcePath);
    let stat;
    try { stat = await fs.stat(sourcePath); } catch { throw new MediaDecoderError("video-not-found", sourcePath); }
    if (!stat.isFile()) throw new MediaDecoderError("invalid-video", sourcePath);
    if (stat.size > this.limits.maxSourceBytes) throw new MediaDecoderError("video-source-too-large", sourcePath);
    const result = await runProcess(
      this.ffprobePath,
      ["-v", "error", "-hide_banner", "-f", "mov", "-protocol_whitelist", "file", "-print_format", "json", "-show_streams", "-show_format", sourcePath],
      { timeoutMs: options.timeoutMs ?? this.probeTimeoutMs, ...(options.signal !== undefined ? { signal: options.signal } : {}), maxStdoutBytes: this.maxProbeBytes, maxStderrBytes: this.maxStderrBytes },
    );
    const snapshot: ProcessSnapshot = {
      killed: result.killed, spawnError: result.spawnError, code: result.code, signal: result.signal,
      stdoutTruncated: result.stdoutTruncated, stderrTruncated: result.stderrTruncated, stderr: result.stderr,
    };
    if (failed(snapshot)) throw new MediaDecoderError(classifyProcessFailure(snapshot), sourcePath);
    if (result.stdoutTruncated) throw new MediaDecoderError(classifyProbeJsonProblem(true), sourcePath);
    let probe: VideoProbe;
    try { probe = toVideoProbe(parseProbeJson(result.stdout.toString("utf8"))); }
    catch (error) {
      if (error instanceof MediaDecoderError) throw new MediaDecoderError(error.code, sourcePath);
      throw new MediaDecoderError("invalid-video", sourcePath);
    }
    const container = probe.container.toLowerCase();
    if (!container.includes("mov") && !container.includes("mp4")) throw new MediaDecoderError("unsupported-video-container", sourcePath);
    if (probe.durationSeconds > this.limits.maxDurationSeconds) throw new MediaDecoderError("video-duration-exceeded", sourcePath);
    if (probe.video && probe.video.width * probe.video.height > this.limits.maxPixels) throw new MediaDecoderError("video-resolution-exceeded", sourcePath);
    if (options.includeVisualTimeline !== false && probe.video?.codec === "h264"
      && (probe.video.pixFmt === undefined || SUPPORTED_PIX_FMTS.has(probe.video.pixFmt))) {
      const frames = await this.readVideoFrameTimes(sourcePath, probe, options);
      const visualTimeline = planVisualFrames(frames.times, probe.durationSeconds, VIDEO_SEGMENT_SECONDS, VIDEO_FRAMES_PER_SEGMENT, frames.lastFrameDurationSeconds);
      probe = { ...probe, visualTimeline };
      this.frameTimelines.set(probe, frames);
    }
    return probe;
  }

  /**
   * 用 ffprobe 取權威來源 frame pts，換算成播放時間軸（0-based）。
   *
   * 這是每檔一次的前置探測：不跨嵌入保留、輸出有界（MAX_FRAME_LIST_BYTES），
   * 因此**不納入** decoder 程序生命週期名額（契約 §6）。probe() 同理。
   */
  private async readVideoFrameTimes(sourcePath: string, probe: VideoProbe, options: DecodeCallOptions): Promise<ReturnType<typeof parseFrameTimeline>> {
    const result = await runProcess(
      this.ffprobePath,
      // 前置完整 PTS 探測固定四個解碼執行緒，避免自動策略在長片超過期限；不略過任何幀。
      ["-v", "error", "-hide_banner", "-threads", "4", "-select_streams", "v:0", "-show_frames", "-show_entries", "frame=pts_time,duration_time", "-of", "compact=p=1:nk=0", "-f", "mov", "-protocol_whitelist", "file", sourcePath],
      { timeoutMs: options.timeoutMs ?? this.probeTimeoutMs, ...(options.signal !== undefined ? { signal: options.signal } : {}), maxStdoutBytes: MAX_FRAME_LIST_BYTES, maxStderrBytes: this.maxStderrBytes },
    );
    const snapshot: ProcessSnapshot = {
      killed: result.killed, spawnError: result.spawnError, code: result.code, signal: result.signal,
      stdoutTruncated: result.stdoutTruncated, stderrTruncated: result.stderrTruncated, stderr: result.stderr,
    };
    if (snapshot.killed.abort || snapshot.killed.deadline) throw new MediaDecoderError(classifyProcessFailure(snapshot), sourcePath);
    if (failed(snapshot) || result.stdoutTruncated) unsupportedTimeline(sourcePath);
    const frames = parseFrameTimeline(result.stdout.toString("utf8"));
    // 影音與容器必須共用原點；以 video stream 自行歸零會丟掉相對音軌的起始偏移。
    const start = probe.sourceStartSeconds;
    if (!Number.isFinite(start)) unsupportedTimeline(sourcePath);
    const duration = probe.durationSeconds;
    const times: number[] = [];
    for (const value of frames.times) {
      const normalized = value - start;
      if (!Number.isFinite(normalized)) unsupportedTimeline(sourcePath);
      if (normalized < -1e-6) unsupportedTimeline(sourcePath);
      if (normalized >= duration + 1e-6) unsupportedTimeline(sourcePath);
      times.push(normalized);
    }
    if (times.length === 0) unsupportedTimeline(sourcePath);
    return { ...frames, times };
  }

  /**
   * 視覺解碼（D1＋D4 補修）：
   * 1. ffprobe 取來源 PTS；Node 端依段規則算出每段要哪一幀（權威計畫）。
   * 2. 每次實際啟動 ffmpeg 前先取 decoder 程序名額（容量 1、跨所有 roots 共用）；程序 close
   *    後才 release。無競爭時一個程序跨 yield 解完整檔；有其他 root 等待時，於段界關閉
   *    程序讓出，下一次 next() 從 picks[framesSeen].startSeconds 以 -ss 重新解碼，
   *    select 表達式只含剩餘 picks 且時間軸平移（t′ = t - 段起點）。
   * 3. PTS 驗證：parser 輸出（相對 seek 起點）≈ pick.frameTimeSeconds - 段起點；
   *    timestampSeconds 仍寫播放時間軸絕對值。EOF／退出碼／parser 幀數／全域段覆蓋
   *    驗證不得放寬；被主動讓出而 kill 的程序不算失敗。
   */
  async *decodeVisualSegments(source: MediaSource, options: DecodeVisualOptions = {}): AsyncGenerator<VisualSegment> {
    const sourcePath = assertSource(source);
    const segmentSeconds = normalizeVisualSegmentSeconds(options.segmentSeconds ?? VIDEO_SEGMENT_SECONDS);
    const framesPerSegment = options.framesPerSegment ?? VIDEO_FRAMES_PER_SEGMENT;
    if (framesPerSegment !== 1 && framesPerSegment !== 2 && framesPerSegment !== 4) throw new RangeError("framesPerSegment 必須是 1、2 或 4");
    const longestSide = options.longestSide ?? VIDEO_LONGEST_SIDE;
    if (!Number.isInteger(longestSide) || longestSide <= 0) throw new RangeError("longestSide 必須是正整數");
    const probe = options.probe ?? (await this.probe(source, { ...(options.signal !== undefined ? { signal: options.signal } : {}), timeoutMs: this.probeTimeoutMs }));
    if (!probe.video) throw new MediaDecoderError("invalid-video", sourcePath);
    if (probe.video.codec !== "h264") throw new MediaDecoderError("unsupported-video-codec", sourcePath);
    if (probe.video.pixFmt !== undefined && !SUPPORTED_PIX_FMTS.has(probe.video.pixFmt)) throw new MediaDecoderError("unsupported-video-codec", sourcePath);

    const frames = this.frameTimelines.get(probe) ?? await this.readVideoFrameTimes(sourcePath, probe, options);
    let picks: VisualFramePick[];
    try {
      picks = segmentSeconds === VIDEO_SEGMENT_SECONDS && framesPerSegment === VIDEO_FRAMES_PER_SEGMENT && this.frameTimelines.has(probe)
        ? [...probe.visualTimeline!]
        : planVisualFrames(frames.times, probe.durationSeconds, segmentSeconds, framesPerSegment, frames.lastFrameDurationSeconds);
    }
    catch (error) {
      if (error instanceof MediaDecoderError) throw new MediaDecoderError(error.code, sourcePath);
      throw error;
    }
    // 最多 600 個 pick；非格線使用有界平衡加法樹，不再因線性樹深度拒絕長片。
    if (picks.length > MAX_FRAME_SELECT_TERMS) unsupportedTimeline(sourcePath);

    const display = displayDimensions(probe.video);
    const scaleFilter = buildScaleFilter(display.width, display.height, longestSide);
    const output = scaledDimensions(display.width, display.height, longestSide);
    const frameBytes = output.width * output.height * 3;
    const duration = probe.durationSeconds;
    const timelineStart = probe.sourceStartSeconds;
    if (!Number.isFinite(timelineStart)) unsupportedTimeline(sourcePath);
    const preprocessingVersion = visualPreprocessingVersion(segmentSeconds, framesPerSegment, longestSide);
    const signal = options.signal;
    const budget = this.decodeBudget;
    // 整檔 deadline 只從 decodeVisualSegments 開始算一次；多次讓出／恢復不得各自重設計時
    // （否則被讓出 N 次可把總 wall time 放大 N 倍）。
    const visualDeadlineAt = Date.now() + (options.timeoutMs ?? this.visualTimeoutMs(duration));

    let framesSeen = 0;
    let currentSegmentIndex = -1;
    let currentSegmentFirstPick = -1;
    let framesForSegment: VisualFrame[] = [];
    const segmentsOut: VisualSegment[] = [];
    let completed = false;
    let session: VisualDecodeSession | null = null;
    let needResume = false;

    const flushSegment = (): void => {
      if (framesForSegment.length === 0) return;
      const firstPick = picks[currentSegmentFirstPick];
      if (firstPick === undefined) unsupportedTimeline(sourcePath);
      segmentsOut.push({
        startSeconds: firstPick.startSeconds,
        endSeconds: firstPick.endSeconds,
        frames: framesForSegment.splice(0, framesForSegment.length),
        preprocessingVersion,
      });
    };

    const closeSession = async (target: VisualDecodeSession): Promise<void> => {
      if (target.closing !== null) return target.closing;
      target.closing = (async () => {
        target.state.parked = false;
        try {
          if (!target.exited) {
            await target.proc.kill();
            // 程序被 kill 時 stdout 可能還有未讀緩衝；不 destroy 會讓 child 的 close 事件等不到 EOF，
            // 導致 parked 期間取消／讓出卡在 await proc.done。
            target.proc.child?.stdout?.destroy();
            target.proc.child?.stderr?.destroy();
          }
          await target.proc.done;
        } finally {
          target.exited = true;
          target.closed = true;
          target.removeAbort();
          target.lease.release();
        }
      })();
      return target.closing;
    };

    const startSession = async (): Promise<VisualDecodeSession> => {
      const localStartIndex = framesSeen;
      const startPick = picks[localStartIndex];
      if (startPick === undefined) unsupportedTimeline(sourcePath);
      const startSeconds = startPick.startSeconds;
      const segmentOffset = startSeconds / segmentSeconds;
      if (!Number.isFinite(segmentOffset) || Math.abs(segmentOffset - Math.round(segmentOffset)) > 1e-9) unsupportedTimeline(sourcePath);
      const localPicks = picks.slice(localStartIndex);
      const shifted = localPicks.map((pick) => ({
        segmentIndex: pick.segmentIndex,
        startSeconds: pick.startSeconds - startSeconds,
        endSeconds: pick.endSeconds - startSeconds,
        frameTimeSeconds: pick.frameTimeSeconds - startSeconds,
        rule: pick.rule,
      }));
      const compactLocal = buildGridSelectExpression(shifted, segmentSeconds);
      const expression = compactLocal ?? buildFrameSelectExpression(shifted);
      if (expression.length > 28_000) unsupportedTimeline(sourcePath);
      const filters = ["select=" + expression, ...(scaleFilter ? [scaleFilter] : []), "showinfo"].join(",");
      const seekSeconds = timelineStart + startSeconds;
      if (!Number.isFinite(seekSeconds) || seekSeconds < 0) unsupportedTimeline(sourcePath);
      const lease = await budget.acquire(signal);
      let proc: StartedProcess;
      try {
        proc = startProcess(
          this.ffmpegPath,
          [
            "-v", "info", "-hide_banner", "-f", "mov", "-protocol_whitelist", "file",
            // -ss 以來源絕對時間表示（format start + 段起點），與影音共用的播放原點一致。
            "-seek_timestamp", "1",
            "-ss", seekSeconds.toFixed(6),
            "-i", sourcePath, "-vf", filters, "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1",
          ],
          {
            // 每次 session 只拿「距離整檔 deadline 的剩餘時間」；不得重設。
            timeoutMs: Math.max(1, visualDeadlineAt - Date.now()),
            ...(signal !== undefined ? { signal } : {}),
            maxStdoutBytes: shifted.length * frameBytes + frameBytes + 1024 * 1024,
            maxStderrBytes: this.maxStderrBytes,
          },
        );
      } catch (error) {
        lease.release();
        throw error;
      }
      const parser = new ShowinfoPtsParser();
      proc.child?.stderr?.on("data", (chunk: Buffer) => { parser.push(chunk.toString("utf8")); });
      const created: VisualDecodeSession = {
        lease, proc, parser, localStartIndex, startSeconds, localPickCount: shifted.length, localFramesSeen: 0,
        state: { parked: false, closeRequested: false, preempted: false },
        closed: false, closing: null, exited: false, aborted: false, removeAbort: () => {},
      };
      void proc.done.then(() => {
        created.exited = true;
        if (!created.closed) void closeSession(created).catch(() => {});
      });
      const onAbort = (): void => { created.aborted = true; void closeSession(created).catch(() => {}); };
      if (signal !== undefined) {
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }
      created.removeAbort = () => { signal?.removeEventListener("abort", onAbort); };
      lease.setPreemptHandler(() => {
        if (created.closed) return;
        // 所有 picks 都已消費：最後一段正在做 EOF／parser 驗證，忽略讓出請求（有界延遲）。
        if (framesSeen >= picks.length) return;
        if (created.state.parked) {
          // 已 yield、等待嵌入：立即關程序讓出（release 在 close 後由 closeSession 執行）。
          created.state.preempted = true;
          void closeSession(created).catch(() => {});
        } else {
          // 解碼中：只設請求，讓目前片段完成後、yield 前讓出。
          created.state.closeRequested = true;
        }
      });
      return created;
    };

    try {
      while (framesSeen < picks.length) {
        if (signal?.aborted) throw new MediaDecoderError("video-decode-cancelled", sourcePath);
        session = await startSession();
        const active = session;
        needResume = false;
        try {
          const stdout = active.proc.child?.stdout;
          if (!stdout) unsupportedTimeline(sourcePath);
          const pending: Buffer[] = [];
          let pendingBytes = 0;
          const takeFrame = (): Buffer => {
            const first = pending[0]!;
            if (first.length >= frameBytes) {
              const frame = Buffer.from(first.subarray(0, frameBytes));
              if (first.length === frameBytes) pending.shift();
              else pending[0] = first.subarray(frameBytes);
              pendingBytes -= frameBytes;
              return frame;
            }
            const parts: Buffer[] = [];
            let need = frameBytes;
            while (need > 0) {
              const head = pending[0]!;
              if (head.length <= need) { parts.push(head); pending.shift(); need -= head.length; }
              else { parts.push(head.subarray(0, need)); pending[0] = head.subarray(need); need = 0; }
            }
            pendingBytes -= frameBytes;
            return Buffer.concat(parts, frameBytes);
          };
          let waitStarted = 0;
          let finalReady = false;
          for await (const chunk of stdout as AsyncIterable<Buffer>) {
            pending.push(chunk);
            pendingBytes += chunk.length;
            while (pendingBytes >= frameBytes) {
              // 只有在這一輪已消費至少一個 pick 時才在邊界讓出；否則會出現「一取得名額就讓出」的
              // 零進度迴圈（多個 root 同時等待時互相搶名額、沒人前進）。
              if (framesForSegment.length === 0 && active.state.closeRequested && active.localFramesSeen > 0) {
                needResume = true;
                break;
              }
              if (waitStarted === 0) waitStarted = Date.now();
              while (active.parser.count <= active.localFramesSeen) {
                if (active.proc.killed.abort) throw new MediaDecoderError("video-decode-cancelled", sourcePath);
                if (active.proc.killed.deadline) throw new MediaDecoderError("video-decode-timeout", sourcePath);
                if (active.proc.killed.outputCap) throw new MediaDecoderError("video-output-limit-exceeded", sourcePath);
                if (active.closed) { needResume = true; break; }
                if (Date.now() - waitStarted > 10_000) unsupportedTimeline(sourcePath);
                await new Promise((resolve) => setTimeout(resolve, 1));
              }
              if (needResume) break;
              waitStarted = 0;
              const planIndex = framesSeen;
              const plan = picks[planIndex];
              if (plan === undefined) unsupportedTimeline(sourcePath);
              const buffer = takeFrame();
              const localPts = active.parser.all[active.localFramesSeen]!;
              active.localFramesSeen += 1;
              framesSeen += 1;
              const expectedLocal = plan.frameTimeSeconds - active.startSeconds;
              if (Math.abs(localPts - expectedLocal) > FRAME_PTS_MATCH_TOLERANCE) unsupportedTimeline(sourcePath);
              const actualTimestamp = active.startSeconds + localPts;
              if (framesForSegment.length > 0) {
                if (picks[planIndex - 1]!.segmentIndex === plan.segmentIndex) {
                  if (framesForSegment.length >= framesPerSegment) unsupportedTimeline(sourcePath);
                } else {
                  flushSegment();
                  currentSegmentFirstPick = -1;
                }
              }
              if (framesForSegment.length === 0) {
                currentSegmentIndex = plan.segmentIndex;
                currentSegmentFirstPick = planIndex;
              }
              framesForSegment.push({ pixels: new Uint8Array(buffer.subarray(0, frameBytes)), width: output.width, height: output.height, timestampSeconds: actualTimestamp });
              if (framesForSegment.length >= framesPerSegment) {
                flushSegment();
                currentSegmentFirstPick = -1;
                // 最後一段先不 yield：必須先完成 EOF／退出碼／parser 幀數／段覆蓋驗證，
                // 才把最後一段交出去（consumer 取完最後一段就 return() 時不得跳過驗證）。
                if (framesSeen === picks.length) {
                  finalReady = true;
                  break;
                }
                if (active.state.closeRequested) {
                  // 目前片段完成、yield 前讓出：close 後才把已完成段交出去。
                  needResume = true;
                  await closeSession(active);
                }
                active.state.parked = true;
                try {
                  while (segmentsOut.length > 0) yield segmentsOut.shift()!;
                } finally {
                  active.state.parked = false;
                }
                if (active.closing !== null) await active.closing;
                if (active.proc.killed.abort) throw new MediaDecoderError("video-decode-cancelled", sourcePath);
                if (active.proc.killed.deadline) throw new MediaDecoderError("video-decode-timeout", sourcePath);
                if (active.proc.killed.outputCap) throw new MediaDecoderError("video-output-limit-exceeded", sourcePath);
                if (active.state.preempted) { needResume = true; break; }
                if (active.state.closeRequested && !active.closed) { needResume = true; await closeSession(active); break; }
                if (framesSeen < picks.length && active.closed) { needResume = true; break; }
              }
              if (needResume) break;
            }
            if (needResume) break;
            if (finalReady) break;
          }
          if (!needResume) {
            active.parser.flush();
            const exit = await active.proc.done;
            const snapshot = snapshotOf(active.proc, exit.code, exit.signal);
            if (snapshot.killed.abort) throw new MediaDecoderError("video-decode-cancelled", sourcePath);
            if (snapshot.killed.deadline) throw new MediaDecoderError("video-decode-timeout", sourcePath);
            if (snapshot.killed.outputCap) throw new MediaDecoderError("video-output-limit-exceeded", sourcePath);
            const allPicksConsumed = framesSeen === picks.length;
            if (!allPicksConsumed && (active.state.preempted || active.state.closeRequested)) {
              needResume = true;
            } else if (failed(snapshot)) {
              throw new MediaDecoderError(classifyProcessFailure(snapshot), sourcePath);
            } else if (!allPicksConsumed) {
              // 程序自然結束但還有 pick 沒處理：選幀輸出與計畫不一致，不得放寬。
              unsupportedTimeline(sourcePath);
            } else {
              // 所有 picks 都已消費：這裡才驗證完整並交出（含）最後一段。
              if (active.parser.count !== active.localPickCount || active.localFramesSeen !== active.localPickCount) unsupportedTimeline(sourcePath);
              if (framesForSegment.length !== 0) unsupportedTimeline(sourcePath);
              const expectedSegments = picks.at(-1)!.segmentIndex + 1;
              const segmentIndexes = new Set(picks.map((pick) => pick.segmentIndex));
              if (segmentIndexes.size !== expectedSegments) unsupportedTimeline(sourcePath);
              if (framesSeen === 0 || currentSegmentIndex < 0) unsupportedTimeline(sourcePath);
              while (segmentsOut.length > 0) yield segmentsOut.shift()!;
              completed = true;
            }
          }
        } finally {
          if (!active.closed) await closeSession(active);
          session = null;
        }
        if (completed) break;
      }
      if (!completed) {
        // 所有 picks 都在最後一個 session 內完成並通過 EOF 驗證後才設 completed；
        // 走到這裡代表有段沒被驗證過，fail closed（不得回報成功）。
        unsupportedTimeline(sourcePath);
      }
    } finally {
      if (session !== null) {
        const active = session;
        session = null;
        if (!active.closed) await closeSession(active);
      }
    }
  }
  /**
   * 單次解出選定 AAC 音軌為 16 kHz mono PCM，依 computeAudioTimeline 對齊播放時間軸後切段。
   * 記憶體有界：最多 600 秒×16 kHz×float32 ≈ 38 MiB（duration limit 已先擋掉更長的來源）。
   */
  async *decodeAudioSegments(source: MediaSource, options: DecodeAudioOptions = {}): AsyncGenerator<AudioSegment> {
    const sourcePath = assertSource(source);
    const segmentSeconds = normalizeAudioSegmentSeconds(options.segmentSeconds ?? VIDEO_AUDIO_SEGMENT_SECONDS);
    const probe = options.probe ?? (await this.probe(source, { includeVisualTimeline: false, ...(options.signal !== undefined ? { signal: options.signal } : {}), timeoutMs: this.probeTimeoutMs }));
    if (!probe.hasAudio) throw new MediaDecoderError("no-audio-track", sourcePath);
    const selected = probe.selectedAudio;
    if (!selected) throw new MediaDecoderError("no-audio-track", sourcePath);
    if (!selected.isAac) throw new MediaDecoderError("unsupported-video-audio-track", sourcePath);
    let timeline;
    try { timeline = computeAudioTimeline(probe); }
    catch (error) {
      if (error instanceof MediaDecoderError) throw new MediaDecoderError(error.code, sourcePath);
      throw error;
    }
    if (timeline === null) throw new MediaDecoderError("no-audio-track", sourcePath);

    // 音訊程序同樣計入 decoder 程序名額；它整軌讀完才 yield，不跨嵌入保留程序，
    // 因此不需要 preempt handler——自然結束（或取消／deadline）就釋放。
    const lease = await this.decodeBudget.acquire(options.signal);
    let budgetReleased = false;
    const releaseBudget = (): void => {
      if (budgetReleased) return;
      budgetReleased = true;
      lease.release();
    };
    const maxStdoutBytes = timeline.expectedDecodedSamples * 4 + segmentSeconds * VIDEO_AUDIO_SAMPLE_RATE * 4 + 1024 * 1024;
    let proc: StartedProcess;
    try {
      proc = startProcess(
        this.ffmpegPath,
        ["-v", "error", "-hide_banner", "-f", "mov", "-protocol_whitelist", "file", "-i", sourcePath, "-map", "0:" + selected.streamIndex, "-vn", "-f", "f32le", "-ac", "1", "-ar", String(VIDEO_AUDIO_SAMPLE_RATE), "pipe:1"],
        {
          timeoutMs: options.timeoutMs ?? this.audioTimeoutMs(probe.durationSeconds),
          ...(options.signal !== undefined ? { signal: options.signal } : {}),
          maxStdoutBytes,
          maxStderrBytes: this.maxStderrBytes,
        },
      );
    } catch (error) {
      releaseBudget();
      throw error;
    }
    const chunks: Buffer[] = [];
    let carry = Buffer.alloc(0);
    let completed = false;
    try {
      const stdout = proc.child?.stdout;
      if (!stdout) throw new MediaDecoderError("invalid-video", sourcePath);
      for await (const chunk of stdout as AsyncIterable<Buffer>) {
        const data = carry.length > 0 ? Buffer.concat([carry, chunk]) : chunk;
        const usable = data.length - (data.length % 4);
        carry = usable === data.length ? Buffer.alloc(0) : Buffer.from(data.subarray(usable));
        if (usable > 0) chunks.push(Buffer.from(data.subarray(0, usable)));
      }
      const exit = await proc.done;
      // 程序已 close：先釋放程序名額（音訊不跨 yield 持有解碼程序）。
      releaseBudget();
      const snapshot = snapshotOf(proc, exit.code, exit.signal);
      if (failed(snapshot)) throw new MediaDecoderError(classifyProcessFailure(snapshot), sourcePath);
      if (carry.length !== 0) throw new MediaDecoderError("invalid-video", sourcePath);
      const joined = Buffer.concat(chunks);
      const decodedTotal = Math.floor(joined.length / 4);
      const tolerance = audioSampleTolerance(timeline.expectedDecodedSamples);
      if (Math.abs(decodedTotal - timeline.expectedDecodedSamples) > tolerance) unsupportedTimeline(sourcePath);
      const view = new DataView(joined.buffer, joined.byteOffset, joined.length);
      const usableStart = timeline.cropStartSamples;
      const usableEnd = decodedTotal - timeline.cropEndSamples;
      if (usableEnd <= usableStart) unsupportedTimeline(sourcePath);
      const totalAligned = timeline.timelineSamples;
      const aligned = new Float32Array(totalAligned);
      let sourceSample = usableStart;
      for (let alignedIndex = timeline.alignStartSample; alignedIndex < totalAligned && sourceSample < usableEnd; alignedIndex += 1, sourceSample += 1) {
        const raw = view.getFloat32(sourceSample * 4, true);
        if (!Number.isFinite(raw)) unsupportedTimeline(sourcePath);
        aligned[alignedIndex] = raw < -1 ? -1 : raw > 1 ? 1 : raw;
      }
      const segmentSamples = segmentSeconds * VIDEO_AUDIO_SAMPLE_RATE;
      for (let index = 0; index < timeline.segmentCount; index += 1) {
        const startSample = index * segmentSamples;
        const endSample = Math.min(totalAligned, (index + 1) * segmentSamples);
        if (endSample <= startSample) break;
        yield {
          samples: aligned.subarray(startSample, endSample),
          sampleRate: VIDEO_AUDIO_SAMPLE_RATE as 16000,
          startSeconds: startSample / VIDEO_AUDIO_SAMPLE_RATE,
          endSeconds: endSample / VIDEO_AUDIO_SAMPLE_RATE,
          preprocessingVersion: videoAudioPreprocessingVersion(segmentSeconds),
        };
      }
      completed = true;
    } finally {
      if (!completed) {
        await proc.kill("abort");
        await proc.done;
      }
      releaseBudget();
    }
  }
}

function firstLine(text: string): string {
  return text.split(/\r?\n/, 1)[0]?.trim() ?? "";
}
