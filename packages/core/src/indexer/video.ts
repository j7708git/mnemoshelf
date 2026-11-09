/**
 * 影片索引的共用小工具：有界快照、前處理版本、probe 政策、時間線佈局、增量比對。
 *
 * 契約依據：
 * - docs/storage-ports.md §影片片段的媒體定位與 seq 規則（ChunkMedia 欄位與 seq）
 * - docs/embedder-contract.md §影片幀序列（VideoInput：RGB／RGBA、1–32 幀）
 * - media/types.ts（MediaDecoder、固定錯誤碼、凍結抽樣政策）
 * - 波次一修正契約 D1／D2／D3／D6
 *
 * 時間規則（D1／D2）：視覺與音軌都使用播放時間軸（0-based）；預期 chunk 佈局
 * 與 decoder 實際輸出共用 visualTimeline／computeAudioTimeline，同時核對實際來源 PTS。
 */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import type { BigIntStats } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_MEDIA_DECODER_LIMITS,
  MediaDecoderError,
  VIDEO_AUDIO_SEGMENT_SECONDS,
  VIDEO_FRAMES_PER_SEGMENT,
  VIDEO_SEGMENT_SECONDS,
  computeAudioTimeline,
  videoAudioPreprocessingVersion,
  visualPreprocessingVersion,
} from "../media/index.js";
import type {
  MediaDecoderErrorCode,
  VideoProbe,
  VisualFramePick,
  VisualSegment,
} from "../media/index.js";
import type { VideoFrameInput } from "../ports/embedder.js";
import type { Chunk, ChunkMediaTrack } from "../ports/types.js";
import { defaultCaseInsensitive } from "../roots/path-guard.js";
import { DEFAULT_VIDEO_MAX_FILE_BYTES, type SkipReason } from "./scan.js";

/** v1 只支援的容器（與 scan 的 .mp4 白名單一致）；寫進 ChunkMedia.container。 */
export const VIDEO_CONTAINER = "mp4" as const;

/** 快照目錄前綴（實際目錄由 fs.mkdtemp 產生，結束一律刪除）。 */
const SNAPSHOT_DIR_PREFIX = "mnemoshelf-video-";
/** 快照的容器檔名；解碼器只拿得到這個本輪專屬路徑。 */
const SNAPSHOT_FILE_NAME = "source.mp4";
/** 複製＋雜湊的單次讀取大小（與 audio 的讀取迴圈同級）。 */
const SNAPSHOT_COPY_CHUNK_BYTES = 1024 * 1024;

/** 影片音軌共用的補零政策版本（與 WAV 相同；由 embedder 端執行）。 */
const AUDIO_PAD_VERSION = "audio-pad160-v1";

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal === undefined) return;
  if (typeof signal.throwIfAborted === "function") {
    signal.throwIfAborted();
    return;
  }
  if (signal.aborted) {
    const reason = signal.reason;
    if (reason instanceof Error) throw reason;
    const error = new Error("索引已取消");
    error.name = "AbortError";
    throw error;
  }
}

/** 本輪快照；dir 由呼叫端在 finally 刪除。 */
export interface VideoSnapshot {
  /** 專屬暫存目錄（只含本檔）。 */
  dir: string;
  /** 交給 decoder 的絕對路徑。 */
  path: string;
  /** 原始位元組的 sha256（增量索引的檔案級身分）。 */
  contentHash: string;
  /** 實際複製的位元組數。 */
  size: number;
}

/**
 * 快照驗證器（D6）：由 caller 提供；在 handle 開啟、handle.stat({bigint:true}) 之後、
 * 複製之前呼叫。
 *
 * 實作必須：
 * 1. 重新走 root 邊界（resolveInsideRoot），並確認解析後路徑與 expectedPath 相同
 *    （Windows／macOS 大小寫不敏感；見 sameVerifiedPath）；
 * 2. 用 fs.stat(resolved, { bigint: true }) 取路徑目前身分，交 assertSameFileIdentity 比對。
 * 失敗時拋錯（PathOutsideRootError／PathBlockedError／MediaDecoderError("invalid-video")）。
 */
export type VideoSnapshotVerifier = (context: { handleStat: BigIntStats; expectedPath: string }) => Promise<void>;

/** 比較兩條已解析路徑是否相同（依平台處理大小寫；不做 realpath，caller 已解析）。 */
export function sameVerifiedPath(left: string, right: string, caseInsensitive = defaultCaseInsensitive()): boolean {
  const resolvedLeft = path.resolve(left);
  const resolvedRight = path.resolve(right);
  return caseInsensitive ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase() : resolvedLeft === resolvedRight;
}

/**
 * 比對 handle 身分與重新解析路徑的 stat（皆為 BigIntStats）。
 *
 * 優先使用 dev／ino（兩者皆非 0n 才有辨識力；NTFS 的 inode 可能 > 2^53，因此必須用 BigInt，
 * 一般 Stats 的 Number 會有精度損失）。檔案系統不提供時，退回 D6 允許的 size＋mtimeNs
 * （caller 已先確認 realpath 相同）；兩者都不符合就 fail closed（拋 invalid-video）。
 */
export function assertSameFileIdentity(handleStat: BigIntStats, pathStat: BigIntStats): void {
  const hasDeviceInode = handleStat.ino !== 0n && pathStat.ino !== 0n;
  if (hasDeviceInode) {
    if (handleStat.dev !== pathStat.dev || handleStat.ino !== pathStat.ino || handleStat.size !== pathStat.size) {
      throw new MediaDecoderError("invalid-video");
    }
    return;
  }
  if (handleStat.size !== pathStat.size || handleStat.mtimeNs !== pathStat.mtimeNs) {
    throw new MediaDecoderError("invalid-video");
  }
}

function writeAll(handle: fs.FileHandle, chunk: Buffer): Promise<void> {
  return (async () => {
    let offset = 0;
    while (offset < chunk.length) {
      const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset, null);
      if (!(bytesWritten > 0)) throw new MediaDecoderError("invalid-video");
      offset += bytesWritten;
    }
  })();
}

/**
 * 建立有界快照（D6）：先 fs.open 取 handle、handle.stat()，再由 verifier 重新走 root
 * 邊界並比對 handle 身分；通過才從同一 handle 複製，並在複製結束後再確認 handle 的
 * 大小／mtime 未改變。任何一步失敗都不會把來源內容交給 decoder。
 *
 * 錯誤（固定碼、不含路徑）：video-source-too-large／invalid-video；verifier 的
 * PathOutsideRootError／PathBlockedError 會原樣往上拋，由 indexer 映射成 skip 原因。
 */
export async function snapshotVideoSource(
  absPath: string,
  maxBytes: number,
  signal: AbortSignal | undefined,
  verifier: VideoSnapshotVerifier,
): Promise<VideoSnapshot> {
  const limit = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : DEFAULT_VIDEO_MAX_FILE_BYTES;
  const handle = await fs.open(absPath, "r");
  let dir: string | undefined;
  try {
    // BigInt stat：Windows NTFS inode 可能超過 2^53，Number 版本會精度損失（提案 B）。
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile()) throw new MediaDecoderError("invalid-video");
    if (stat.size > BigInt(limit)) throw new MediaDecoderError("video-source-too-large");
    // D6：root 驗證與實際讀取綁定在同一個 handle 上（caller 重走 realpath／root 邊界）。
    await verifier({ handleStat: stat, expectedPath: absPath });
    dir = await fs.mkdtemp(path.join(os.tmpdir(), SNAPSHOT_DIR_PREFIX));
    const destination = path.join(dir, SNAPSHOT_FILE_NAME);
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(SNAPSHOT_COPY_CHUNK_BYTES);
    let total = 0;
    const out = await fs.open(destination, "w");
    try {
      for (;;) {
        throwIfAborted(signal);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (bytesRead === 0) break;
        total += bytesRead;
        if (total > limit) throw new MediaDecoderError("video-source-too-large");
        const slice = buffer.subarray(0, bytesRead);
        hash.update(slice);
        await writeAll(out, slice);
      }
    } finally {
      await out.close();
    }
    // 複製期間來源被截斷／變大／改寫：具名 invalid-video，不把半個快照交出去。
    if (BigInt(total) !== stat.size) throw new MediaDecoderError("invalid-video");
    const finalStat = await handle.stat({ bigint: true });
    if (finalStat.size !== stat.size || finalStat.mtimeNs !== stat.mtimeNs) throw new MediaDecoderError("invalid-video");
    return { dir, path: destination, contentHash: hash.digest("hex"), size: total };
  } catch (error) {
    if (dir !== undefined) await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  } finally {
    await handle.close();
  }
}

/** 刪除本輪快照目錄；失敗不影響索引結果（暫存目錄由 OS 另行清理）。 */
export async function removeVideoSnapshot(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
}

/**
 * 把 decoder 回報的版本字串正規化成可放進 preprocessVersion 的安全片段。
 *
 * ffmpeg 的 -version 第一行很長（含 copyright），直接塞進 preprocessVersion 會超過
 * ChunkMedia 的 128 字元上限；這裡只取版本 token（例如 n9.0.2-48-gd4070a14ce），
 * 取不到就用品質雜湊前綴，最終長度上限 32。
 */
export function safeDecoderVersion(version: string | undefined): string {
  const text = version ?? "unknown";
  const match = /(?:ffmpeg|ffprobe)\s+version\s+(\S+)/i.exec(text) ?? /\b(n?\d+\.\d+[A-Za-z0-9._+\-]*)/.exec(text);
  const token = match?.[1] ?? createHash("sha256").update(text).digest("hex").slice(0, 16);
  const cleaned = token.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 32);
  return cleaned.length > 0 ? cleaned : "unknown";
}

/** 視覺片段的前處理版本：D1 抽樣政策（段長／幀數／最長邊）＋decoder 版本。 */
export function videoVisualPreprocessVersion(decoderVersion: string | undefined): string {
  return visualPreprocessingVersion() + ":ffmpeg-" + safeDecoderVersion(decoderVersion);
}

/** 影片音軌片段的前處理版本：D2 音訊政策＋補零政策＋decoder 版本。 */
export function videoAudioPreprocessVersion(decoderVersion: string | undefined): string {
  return videoAudioPreprocessingVersion() + ":" + AUDIO_PAD_VERSION + ":ffmpeg-" + safeDecoderVersion(decoderVersion);
}

const TRACK_RANK: Record<ChunkMediaTrack, number> = { video: 0, "video-audio": 1, audio: 2 };

/** 每個 chunk 的預期身分（增量比對包含來源幀時間）。 */
export interface VideoChunkExpectation {
  kind: "video" | "audio";
  track: "video" | "video-audio";
  startSeconds: number;
  endSeconds: number;
  streamIndex?: number;
  preprocessVersion: string;
  frameTimesSeconds?: readonly number[];
}

/** 一個影片檔的預期 chunk 佈局；視覺部分由 decoder 的來源 PTS 計畫提供。 */
export interface VideoChunkLayout {
  durationSeconds: number;
  visualCount: number;
  visualTimeline: readonly VisualFramePick[];
  /** 已選定音軌時的片段數與播放時間軸結尾；音軌關閉或無音軌為 null。 */
  audio: { count: number; streamIndex: number; endSeconds: number; offsetSeconds: number } | null;
}

/**
 * 依 probe（含 per-stream 時間）推導預期片段佈局。
 *
 * 與 decoder 共用同一份來源 PTS 佈局，不從容器時長猜視覺段數；
 * 音軌段數與結尾由 computeAudioTimeline 決定（不是容器時長）。
 */
export function buildVideoChunkLayout(probe: VideoProbe, audioRequested: boolean): VideoChunkLayout {
  const durationSeconds = probe.durationSeconds;
  const visualTimeline = probe.visualTimeline;
  if (!Array.isArray(visualTimeline) || visualTimeline.length === 0 || visualTimeline.length > 150) {
    throw new MediaDecoderError("unsupported-video-timeline");
  }
  for (let index = 0; index < visualTimeline.length; index += 1) {
    const pick = visualTimeline[index]!;
    if (pick === null || typeof pick !== "object" || pick.segmentIndex !== index || pick.startSeconds !== index * VIDEO_SEGMENT_SECONDS
      || !Number.isFinite(pick.endSeconds) || pick.endSeconds <= pick.startSeconds
      || pick.endSeconds !== Math.min(durationSeconds, pick.startSeconds + VIDEO_SEGMENT_SECONDS)
      || !Number.isFinite(pick.frameTimeSeconds) || pick.frameTimeSeconds < pick.startSeconds
      || pick.frameTimeSeconds >= pick.endSeconds
      || !["midpoint", "tail-last", "fallback-last"].includes(pick.rule)) {
      throw new MediaDecoderError("unsupported-video-timeline");
    }
  }
  const finalEnd = visualTimeline.at(-1)!.endSeconds;
  // decoder 可省略末尾不足 4 秒的空格；不得省略完整格或中間格。
  if (!Number.isFinite(durationSeconds) || durationSeconds - finalEnd >= VIDEO_SEGMENT_SECONDS || finalEnd > durationSeconds) {
    throw new MediaDecoderError("unsupported-video-timeline");
  }
  const visualCount = visualTimeline.length;
  if (!audioRequested || !probe.hasAudio || probe.selectedAudio === null || !probe.selectedAudio.isAac) {
    return { durationSeconds, visualCount, visualTimeline, audio: null };
  }
  const timeline = computeAudioTimeline(probe);
  if (timeline === null) return { durationSeconds, visualCount, visualTimeline, audio: null };
  return {
    durationSeconds,
    visualCount,
    visualTimeline,
    audio: {
      count: timeline.segmentCount,
      streamIndex: timeline.streamIndex,
      endSeconds: timeline.endSeconds,
      offsetSeconds: timeline.offsetSeconds,
    },
  };
}

/** probe 的產品政策檢查；回傳要記的 skip 原因（undefined＝繼續）。 */
export function checkVideoProbePolicy(
  probe: VideoProbe,
  limits: { maxDurationSeconds: number; maxPixels: number } = DEFAULT_MEDIA_DECODER_LIMITS,
): SkipReason | undefined {
  if (!probe.hasVideo || probe.video === null) return "video-no-stream";
  if (probe.video.codec !== "h264") return "unsupported-video-codec";
  if (!Number.isFinite(probe.video.width) || !Number.isFinite(probe.video.height) || probe.video.width <= 0 || probe.video.height <= 0) {
    return "invalid-video";
  }
  if (probe.video.width * probe.video.height > limits.maxPixels) return "video-resolution-exceeded";
  if (!Number.isFinite(probe.durationSeconds) || probe.durationSeconds <= 0) return "invalid-video";
  if (probe.durationSeconds > limits.maxDurationSeconds) return "video-duration-exceeded";
  return undefined;
}

/** 音軌政策結果：不讀／無音軌／可用／不支援（整檔 skip）。 */
export type VideoAudioSelection =
  | { status: "off" }
  | { status: "none" }
  | { status: "ready"; streamIndex: number }
  | { status: "unsupported" };

/**
 * 影片音軌的選軌政策：
 * - audio 模態關閉 → 不讀音軌（off），畫面照常索引；
 * - 檔案沒有音軌 → 畫面照常成功（none）；
 * - 有音軌但選定軌不是 AAC → 整檔具名 skip（unsupported），不做部分成功。
 */
export function videoAudioSelection(probe: VideoProbe, audioRequested: boolean): VideoAudioSelection {
  if (!audioRequested) return { status: "off" };
  if (!probe.hasAudio || probe.audioStreams.length === 0) return { status: "none" };
  const selected = probe.selectedAudio;
  if (selected === null || !selected.isAac) return { status: "unsupported" };
  return { status: "ready", streamIndex: selected.streamIndex };
}

/** 把 decoder 的視覺片段轉成 embedder 的 VideoInput（固定 RGB24）。 */
export function videoFramesForSegment(segment: VisualSegment): VideoFrameInput[] {
  return segment.frames.map((frame) => ({
    pixels: frame.pixels,
    width: frame.width,
    height: frame.height,
    channels: 3,
    timestampSeconds: frame.timestampSeconds,
  }));
}

/** 視覺片段必須完整覆蓋 decoder 佈局的段數；少一段代表時間軸不完整，不寫入部分索引。 */
export function assertVideoVisualCoverage(actualCount: number, expectedCount: number): void {
  if (actualCount !== expectedCount) throw new MediaDecoderError("unsupported-video-timeline");
}

/** 每個解碼段的邊界與實際幀時間必須符合 decoder 的 probe 佈局；嵌入前驗證。 */
export function assertVideoVisualSegment(segment: VisualSegment, expected: VisualFramePick | undefined): void {
  if (expected === undefined || !closeEnough(segment.startSeconds, expected.startSeconds)
    || !closeEnough(segment.endSeconds, expected.endSeconds) || segment.frames.length !== VIDEO_FRAMES_PER_SEGMENT
    || !closeEnough(segment.frames[0]!.timestampSeconds, expected.frameTimeSeconds)) {
    throw new MediaDecoderError("unsupported-video-timeline");
  }
}

/** 增量比對用的身分（全部相同且向量齊全才可跳過重算）。 */
export interface VideoIndexIdentity {
  contentHash: string;
  visualPreprocessVersion: string;
  audioPreprocessVersion: string;
  embedderId: string;
  embeddingDim: number;
}

function closeEnough(left: number, right: number): boolean {
  return Math.abs(left - right) <= 1e-3;
}

function sortExpectations(list: VideoChunkExpectation[]): VideoChunkExpectation[] {
  return list.sort((left, right) =>
    left.startSeconds - right.startSeconds ||
    TRACK_RANK[left.track] - TRACK_RANK[right.track] ||
    left.endSeconds - right.endSeconds);
}

/** 由 decoder 佈局與版本身分建立「依 seq 排序」的預期 chunk 清單。 */
export function expectedVideoChunks(
  layout: VideoChunkLayout,
  identity: Pick<VideoIndexIdentity, "visualPreprocessVersion" | "audioPreprocessVersion">,
): VideoChunkExpectation[] {
  const expected: VideoChunkExpectation[] = [];
  for (const pick of layout.visualTimeline) {
    expected.push({
      kind: "video",
      track: "video",
      startSeconds: pick.startSeconds,
      endSeconds: pick.endSeconds,
      frameTimesSeconds: [pick.frameTimeSeconds],
      preprocessVersion: identity.visualPreprocessVersion,
    });
  }
  if (layout.audio !== null) {
    for (let index = 0; index < layout.audio.count; index += 1) {
      const startSeconds = index * VIDEO_AUDIO_SEGMENT_SECONDS;
      expected.push({
        kind: "audio",
        track: "video-audio",
        startSeconds,
        endSeconds: Math.min(layout.audio.endSeconds, startSeconds + VIDEO_AUDIO_SEGMENT_SECONDS),
        streamIndex: layout.audio.streamIndex,
        preprocessVersion: identity.audioPreprocessVersion,
      });
    }
  }
  return sortExpectations(expected);
}

function mediaMatchesExpectation(chunk: Chunk, expectation: VideoChunkExpectation, identity: VideoIndexIdentity): boolean {
  const media = chunk.media;
  if (media === undefined) return false;
  if (chunk.contentHash !== identity.contentHash) return false;
  if (chunk.kind !== expectation.kind) return false;
  if (media.track !== expectation.track) return false;
  if (media.container !== VIDEO_CONTAINER) return false;
  if (!closeEnough(media.startSeconds, expectation.startSeconds)) return false;
  if (!closeEnough(media.endSeconds, expectation.endSeconds)) return false;
  if (media.preprocessVersion !== expectation.preprocessVersion) return false;
  if (media.embedderId !== identity.embedderId || media.embeddingDim !== identity.embeddingDim) return false;
  if (expectation.track === "video-audio") {
    return media.streamIndex === expectation.streamIndex;
  }
  const frameTimes = media.frameTimesSeconds;
  if (!Array.isArray(frameTimes) || frameTimes.length !== VIDEO_FRAMES_PER_SEGMENT) return false;
  if (expectation.frameTimesSeconds === undefined
    || frameTimes.some((time, index) => !closeEnough(time, expectation.frameTimesSeconds![index]!))) return false;
  let previous = Number.NEGATIVE_INFINITY;
  for (const frameTime of frameTimes) {
    if (typeof frameTime !== "number" || !Number.isFinite(frameTime)) return false;
    if (frameTime < media.startSeconds - 1e-3 || frameTime > media.endSeconds + 1e-3) return false;
    if (frameTime < previous) return false;
    previous = frameTime;
  }
  return true;
}

/**
 * 既有索引是否已經等於本輪應有的結果（給定 hash、版本身分與 probe 佈局）。
 * 只判斷資料形狀與身分；向量是否齊全由呼叫端另外查。
 */
export function isVideoIndexUnchanged(
  existing: readonly Chunk[],
  identity: VideoIndexIdentity,
  layout: VideoChunkLayout,
): boolean {
  const expected = expectedVideoChunks(layout, identity);
  if (existing.length !== expected.length) return false;
  for (let index = 0; index < expected.length; index += 1) {
    const chunk = existing[index]!;
    if (chunk.seq !== index) return false;
    if (!mediaMatchesExpectation(chunk, expected[index]!, identity)) return false;
  }
  return true;
}

/**
 * decoder 具名錯誤 → 要記的 skip 原因（undefined＝不當成 deterministic skip，交給呼叫端決定 failed／取消）。
 *
 * deterministic 媒體問題一律 skipped（不讓整輪 failed）：容器／編碼／音軌不支援、時長／
 * 解析度／大小超限、壞檔、輸出上限、時間線無法可靠定義（D1）。
 * 可重試或環境問題（decoder 不可用、逾時、來源消失）與取消不在這裡。
 */
export function decoderSkipReason(error: unknown): SkipReason | undefined {
  if (!(error instanceof MediaDecoderError)) return undefined;
  const mapping: Partial<Record<MediaDecoderErrorCode, SkipReason>> = {
    "invalid-video": "invalid-video",
    "unsupported-video-container": "unsupported-video-format",
    "unsupported-video-codec": "unsupported-video-codec",
    "unsupported-video-audio-track": "unsupported-video-audio-track",
    "unsupported-video-timeline": "unsupported-video-timeline",
    "video-duration-exceeded": "video-duration-exceeded",
    "video-resolution-exceeded": "video-resolution-exceeded",
    "video-source-too-large": "video-too-large",
    "video-output-limit-exceeded": "invalid-video",
    "no-audio-track": "invalid-video",
  };
  return mapping[error.code];
}
