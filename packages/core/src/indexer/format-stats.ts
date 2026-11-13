/**
 * Stage 2 混合目錄格式統計與受控容器 probe。
 *
 * 設計邊界：
 * - 複用 `walkRoot` 與 `classifyExtensionDetail`，不改動產品索引與白名單。
 * - 預設不讀檔案內容；僅在顯式啟用 `probeUnknownHeaders` 時讀未知副檔名前 64 bytes magic header，
 *   或在啟用 `probeMedia`／`ffprobePath` 時只讀影音容器標頭與串流 metadata（不解碼幀、不抽字）。
 * - 回報結構完全匿名化：只含副檔名、`SkipReason`、編碼分佈與彙總數量／位元組，不含任何檔名或路徑。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { runProcess } from "../media/process.js";
import type { Modality, Root } from "../ports/types.js";
import { resolveInsideRoot } from "../roots/path-guard.js";
import {
  classifyExtensionDetail,
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_VIDEO_MAX_FILE_BYTES,
  VIDEO_MAX_DURATION_SECONDS,
  walkRoot,
  type ExtensionBucket,
  type ScanOptions,
  type ScanRoot,
  type SkipReason,
} from "./scan.js";

/** `sharp` prebuilt 在本專案已知會進入 `undecodable` 的圖片副檔名（見 `indexer.ts`）。 */
export const SHARP_UNSUPPORTED_IMAGE_EXTS: ReadonlySet<string> = new Set([".heic", ".bmp", ".ico"]);

const AUDIO_FILE_MAX_HARD_BYTES = 64 * 1024 * 1024;
const SUPPORTED_VIDEO_PIX_FMTS = new Set(["yuv420p", "yuvj420p", "yuv422p", "yuv444p"]);
const SUPPORTED_WAV_CODECS = new Set(["pcm_s16le", "pcm_f32le"]);
const HEADER_SNIFF_BYTES = 64;
const PROBE_TIMEOUT_MS = 10_000;
const PROBE_MAX_STDOUT_BYTES = 1024 * 1024;
const PROBE_MAX_STDERR_BYTES = 256 * 1024;

export type UnknownHeaderKind =
  | "zip-container"
  | "pdf-magic"
  | "rtf-markup"
  | "caf-audio"
  | "isobmff-media"
  | "svg-xml"
  | "binary-magic"
  | "text-like"
  | "unreadable";

export type DurationBucket = "unknown" | "<=60s" | "60-600s" | ">600s";

export interface MediaContainerProbe {
  ok: boolean;
  error: string | null;
  formatName: string | null;
  durationSeconds: number | null;
  videoCodec: string | null;
  pixFmt: string | null;
  width: number | null;
  height: number | null;
  audioCodec: string | null;
  audioChannels: number | null;
  audioSampleRate: number | null;
}

export type MediaProbeFn = (absPath: string) => Promise<MediaContainerProbe>;

export interface FormatStatsInput {
  /** 匿名標記，只用來區分報告來源（例如 `"synthetic-macos-mix"`）；不應含真實目錄路徑。 */
  label: string;
  path: string;
  modalities?: Modality[];
  include?: string[];
  exclude?: string[];
  respectGitignore?: boolean;
  maxFileBytes?: number;
  videoMaxFileBytes?: number;
}

export interface FormatStatsOptions {
  /** 模擬支援的模態；預設包含全部五種模態以反映格式本身缺口。 */
  supportedModalities?: readonly Modality[];
  /** 是否對被 `walkRoot` 歸為 `unknown-default-text` 的檔案讀前 64 bytes 辨識 magic header。 */
  probeUnknownHeaders?: boolean;
  /** 可執行檔路徑（或自訂 `probeMedia` 函式）；提供任一即對影音檔做容器與 codec probe。 */
  ffprobePath?: string;
  probeMedia?: MediaProbeFn;
  signal?: AbortSignal;
}

export interface SkipReasonStat {
  reason: SkipReason;
  count: number;
  fileShare: number;
  bytes: number;
  byteShare: number;
  knownByteCount: number;
}

export interface ExtensionStat {
  ext: string;
  bucket: ExtensionBucket;
  count: number;
  fileShare: number;
  bytes: number;
  byteShare: number;
  acceptedCount: number;
  acceptedBytes: number;
  skippedCount: number;
  skippedBytes: number;
  skippedByReason: Partial<Record<SkipReason, number>>;
  sharpUnsupportedImage: boolean;
  unknownHeaderCounts: Partial<Record<UnknownHeaderKind, number>>;
}

export interface MediaProfileStat {
  mediaKind: "audio" | "video";
  ext: string;
  scanStatus: "accepted" | SkipReason;
  probeOk: boolean;
  probeError: string | null;
  formatName: string | null;
  videoCodec: string | null;
  pixFmt: string | null;
  audioCodec: string | null;
  durationBucket: DurationBucket;
  v1Compatible: boolean;
  incompatibilityReasons: string[];
  count: number;
  bytes: number;
}

export interface FormatStatsReport {
  label: string;
  modalities: Modality[];
  supportedModalities: Modality[];
  maxFileBytes: number;
  videoMaxFileBytes: number;
  totals: {
    scannedFiles: number;
    acceptedFiles: number;
    acceptedBytes: number;
    skippedFiles: number;
    knownSkippedBytes: number;
    unknownSizeSkippedCount: number;
    sharpUnsupportedImageCount: number;
    sharpUnsupportedImageBytes: number;
    unknownDefaultTextCount: number;
    unknownDefaultTextBytes: number;
  };
  acceptedByModality: Record<Modality, { count: number; bytes: number; fileShare: number; byteShare: number }>;
  skipReasons: SkipReasonStat[];
  extensions: ExtensionStat[];
  mediaProfiles: MediaProfileStat[];
}

const ALL_MODALITIES: readonly Modality[] = ["text", "code", "image", "audio", "video"];
const STAT_SAFE_SKIP_REASONS: ReadonlySet<SkipReason> = new Set([
  "excluded",
  "modality-off",
  "unsupported-modality",
  "unsupported-audio-format",
  "unsupported-video-format",
  "too-large",
  "video-too-large",
  "unsupported-type",
]);

function normalizedExt(relPath: string): string {
  const ext = path.posix.extname(path.posix.basename(relPath).toLowerCase());
  return ext === "" ? "<no-ext>" : ext;
}

function share(part: number, total: number): number {
  return total > 0 ? part / total : 0;
}

function durationBucketOf(seconds: number | null): DurationBucket {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return "unknown";
  if (seconds <= 60) return "<=60s";
  if (seconds <= VIDEO_MAX_DURATION_SECONDS) return "60-600s";
  return ">600s";
}

/** 僅讀前 64 bytes magic header 辨識未知副檔名是否實為二進位／容器格式。 */
export async function detectUnknownHeaderKind(absPath: string): Promise<UnknownHeaderKind> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(absPath, "r");
    const buf = Buffer.alloc(HEADER_SNIFF_BYTES);
    const { bytesRead } = await handle.read(buf, 0, HEADER_SNIFF_BYTES, 0);
    const slice = buf.subarray(0, bytesRead);
    if (bytesRead >= 4 && slice[0] === 0x50 && slice[1] === 0x4b && slice[2] === 0x03 && slice[3] === 0x04) {
      return "zip-container";
    }
    if (slice.subarray(0, 5).toString("ascii") === "%PDF-") return "pdf-magic";
    if (slice.subarray(0, 5).toString("ascii") === "{\\rtf") return "rtf-markup";
    if (slice.subarray(0, 4).toString("ascii") === "caff") return "caf-audio";
    if (bytesRead >= 8 && slice.subarray(4, 8).toString("ascii") === "ftyp") return "isobmff-media";
    const headText = slice.toString("utf8").trimStart().toLowerCase();
    if (headText.startsWith("<svg") || (headText.startsWith("<?xml") && headText.includes("<svg"))) {
      return "svg-xml";
    }
    if (slice.includes(0)) return "binary-magic";
    return "text-like";
  } catch {
    return "unreadable";
  } finally {
    await handle?.close().catch(() => {});
  }
}

interface RawFfprobeJson {
  format?: { format_name?: unknown; duration?: unknown };
  streams?: Array<{
    codec_type?: unknown;
    codec_name?: unknown;
    pix_fmt?: unknown;
    width?: unknown;
    height?: unknown;
    channels?: unknown;
    sample_rate?: unknown;
    duration?: unknown;
    disposition?: { default?: unknown };
  }>;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** 以只讀 `ffprobe` 讀取容器與串流 metadata（不解碼影像幀、不追蹤外部參照）。 */
export async function probeMediaWithFfprobe(
  absPath: string,
  ffprobePath: string,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<MediaContainerProbe> {
  const args = [
    "-v",
    "error",
    "-protocol_whitelist",
    "file",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    absPath,
  ];
  const result = await runProcess(ffprobePath, args, {
    timeoutMs,
    maxStdoutBytes: PROBE_MAX_STDOUT_BYTES,
    maxStderrBytes: PROBE_MAX_STDERR_BYTES,
  });
  if (result.spawnError !== null) {
    return {
      ok: false, error: "ffprobe-spawn-error", formatName: null, durationSeconds: null,
      videoCodec: null, pixFmt: null, width: null, height: null,
      audioCodec: null, audioChannels: null, audioSampleRate: null,
    };
  }
  if (result.killed.deadline) {
    return {
      ok: false, error: "ffprobe-timeout", formatName: null, durationSeconds: null,
      videoCodec: null, pixFmt: null, width: null, height: null,
      audioCodec: null, audioChannels: null, audioSampleRate: null,
    };
  }
  if (result.code !== 0) {
    return {
      ok: false, error: "ffprobe-failed", formatName: null, durationSeconds: null,
      videoCodec: null, pixFmt: null, width: null, height: null,
      audioCodec: null, audioChannels: null, audioSampleRate: null,
    };
  }
  let parsed: RawFfprobeJson;
  try {
    parsed = JSON.parse(result.stdout.toString("utf8")) as RawFfprobeJson;
  } catch {
    return {
      ok: false, error: "ffprobe-invalid-json", formatName: null, durationSeconds: null,
      videoCodec: null, pixFmt: null, width: null, height: null,
      audioCodec: null, audioChannels: null, audioSampleRate: null,
    };
  }
  const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
  const videoStream = streams.find((s) => s.codec_type === "video");
  const audioStreams = streams.filter((s) => s.codec_type === "audio");
  const audioStream = audioStreams.find((s) => s.disposition?.default === 1) ?? audioStreams[0];
  return {
    ok: true,
    error: null,
    formatName: asString(parsed.format?.format_name),
    durationSeconds: asNumber(parsed.format?.duration) ?? asNumber(videoStream?.duration) ?? asNumber(audioStream?.duration),
    videoCodec: asString(videoStream?.codec_name),
    pixFmt: asString(videoStream?.pix_fmt),
    width: asNumber(videoStream?.width),
    height: asNumber(videoStream?.height),
    audioCodec: asString(audioStream?.codec_name),
    audioChannels: asNumber(audioStream?.channels),
    audioSampleRate: asNumber(audioStream?.sample_rate),
  };
}

function evaluateMediaV1Compatibility(
  mediaKind: "audio" | "video",
  ext: string,
  size: number,
  maxFileBytes: number,
  videoMaxFileBytes: number,
  probe: MediaContainerProbe,
): { compatible: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!probe.ok) {
    reasons.push(probe.error ?? "probe-failed");
    return { compatible: false, reasons };
  }
  if (mediaKind === "video") {
    if (ext !== ".mp4") reasons.push(`container:${ext}`);
    if (probe.videoCodec === null) reasons.push("no-video-stream");
    else if (probe.videoCodec !== "h264") reasons.push(`video-codec:${probe.videoCodec}`);
    if (probe.pixFmt !== null && !SUPPORTED_VIDEO_PIX_FMTS.has(probe.pixFmt)) reasons.push(`pix-fmt:${probe.pixFmt}`);
    if (probe.audioCodec !== null && probe.audioCodec !== "aac") reasons.push(`video-audio-codec:${probe.audioCodec}`);
    if (probe.durationSeconds !== null && probe.durationSeconds > VIDEO_MAX_DURATION_SECONDS) reasons.push("duration>600s");
    if (size > videoMaxFileBytes) reasons.push("size>videoMaxFileBytes");
  } else {
    if (ext !== ".wav") reasons.push(`container:${ext}`);
    if (probe.audioCodec === null) reasons.push("no-audio-stream");
    else if (!SUPPORTED_WAV_CODECS.has(probe.audioCodec)) reasons.push(`audio-codec:${probe.audioCodec}`);
    if (probe.audioChannels !== null && (probe.audioChannels < 1 || probe.audioChannels > 2)) {
      reasons.push(`channels:${probe.audioChannels}`);
    }
    if (probe.audioSampleRate !== null && (probe.audioSampleRate < 8000 || probe.audioSampleRate > 192000)) {
      reasons.push(`sample-rate:${probe.audioSampleRate}`);
    }
    if (probe.durationSeconds !== null && probe.durationSeconds > VIDEO_MAX_DURATION_SECONDS) reasons.push("duration>600s");
    if (size > Math.min(maxFileBytes, AUDIO_FILE_MAX_HARD_BYTES)) reasons.push("size>limit");
  }
  return { compatible: reasons.length === 0, reasons };
}

/**
 * 收集混合目錄的格式統計與可選的容器 probe 統計。
 */
export async function collectFormatStats(
  input: FormatStatsInput,
  options: FormatStatsOptions = {},
): Promise<FormatStatsReport> {
  const modalities: Modality[] = input.modalities ? [...input.modalities] : [...ALL_MODALITIES];
  const supportedModalities: Modality[] = options.supportedModalities
    ? [...options.supportedModalities]
    : [...ALL_MODALITIES];
  const maxFileBytes = input.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const videoMaxFileBytes = input.videoMaxFileBytes ?? DEFAULT_VIDEO_MAX_FILE_BYTES;

  const scanRoot: ScanRoot = {
    path: input.path,
    modalities,
    include: input.include ?? [],
    exclude: input.exclude ?? [],
    respectGitignore: input.respectGitignore ?? true,
  };
  const scanOptions: ScanOptions = {
    supportedModalities,
    maxFileBytes,
    videoMaxFileBytes,
  };
  if (options.signal !== undefined) scanOptions.signal = options.signal;

  const scan = await walkRoot(scanRoot, scanOptions);
  const rootAbs = path.resolve(input.path);
  const guardRoot: Root = {
    id: 0,
    path: input.path,
    mode: "index",
    modalities,
    include: scanRoot.include,
    exclude: scanRoot.exclude,
    respectGitignore: scanRoot.respectGitignore,
    watch: false,
    createdAt: "",
    allowAgentSearch: false,
  };

  const probeFn: MediaProbeFn | null = options.probeMedia
    ? options.probeMedia
    : options.ffprobePath
      ? (absPath) => probeMediaWithFfprobe(absPath, options.ffprobePath!)
      : null;

  const extMap = new Map<string, ExtensionStat>();
  const ensureExt = (relPath: string): ExtensionStat => {
    const ext = normalizedExt(relPath);
    let stat = extMap.get(ext);
    if (stat === undefined) {
      const bucket = classifyExtensionDetail(path.posix.basename(relPath));
      stat = {
        ext,
        bucket,
        count: 0,
        fileShare: 0,
        bytes: 0,
        byteShare: 0,
        acceptedCount: 0,
        acceptedBytes: 0,
        skippedCount: 0,
        skippedBytes: 0,
        skippedByReason: {},
        sharpUnsupportedImage: bucket === "image" && SHARP_UNSUPPORTED_IMAGE_EXTS.has(ext),
        unknownHeaderCounts: {},
      };
      extMap.set(ext, stat);
    }
    return stat;
  };

  const acceptedByModality = {} as FormatStatsReport["acceptedByModality"];
  for (const modality of ALL_MODALITIES) {
    acceptedByModality[modality] = { count: 0, bytes: 0, fileShare: 0, byteShare: 0 };
  }

  let acceptedBytes = 0;
  let sharpUnsupportedImageCount = 0;
  let sharpUnsupportedImageBytes = 0;
  let unknownDefaultTextCount = 0;
  let unknownDefaultTextBytes = 0;

  const mediaTargets: Array<{ mediaKind: "audio" | "video"; ext: string; absPath: string; size: number; scanStatus: "accepted" | SkipReason }> = [];

  for (const file of scan.files) {
    acceptedBytes += file.size;
    acceptedByModality[file.kind].count += 1;
    acceptedByModality[file.kind].bytes += file.size;

    const extStat = ensureExt(file.relPath);
    extStat.count += 1;
    extStat.bytes += file.size;
    extStat.acceptedCount += 1;
    extStat.acceptedBytes += file.size;

    if (extStat.sharpUnsupportedImage) {
      sharpUnsupportedImageCount += 1;
      sharpUnsupportedImageBytes += file.size;
    }
    if (extStat.bucket === "unknown-default-text") {
      unknownDefaultTextCount += 1;
      unknownDefaultTextBytes += file.size;
      if (options.probeUnknownHeaders) {
        const headerKind = await detectUnknownHeaderKind(file.absPath);
        extStat.unknownHeaderCounts[headerKind] = (extStat.unknownHeaderCounts[headerKind] ?? 0) + 1;
      }
    }
    if (probeFn !== null && (file.kind === "audio" || file.kind === "video")) {
      mediaTargets.push({ mediaKind: file.kind, ext: extStat.ext, absPath: file.absPath, size: file.size, scanStatus: "accepted" });
    }
  }

  const skipMap = new Map<SkipReason, { count: number; bytes: number; knownByteCount: number }>();
  let knownSkippedBytes = 0;
  let unknownSizeSkippedCount = 0;

  for (const entry of scan.skipped) {
    let size: number | null = null;
    let resolvedAbs: string | null = null;
    if (STAT_SAFE_SKIP_REASONS.has(entry.reason)) {
      try {
        const resolved = await resolveInsideRoot([guardRoot], path.join(rootAbs, ...entry.relPath.split("/")));
        const st = await fs.stat(resolved.abs);
        if (st.isFile()) {
          size = st.size;
          resolvedAbs = resolved.abs;
        }
      } catch {
        // 無法取得大小時維持未知，不阻斷統計。
      }
    }
    if (size === null) {
      unknownSizeSkippedCount += 1;
    } else {
      knownSkippedBytes += size;
    }

    const skipStat = skipMap.get(entry.reason) ?? { count: 0, bytes: 0, knownByteCount: 0 };
    skipStat.count += 1;
    if (size !== null) {
      skipStat.bytes += size;
      skipStat.knownByteCount += 1;
    }
    skipMap.set(entry.reason, skipStat);

    const extStat = ensureExt(entry.relPath);
    extStat.count += 1;
    extStat.skippedCount += 1;
    extStat.skippedByReason[entry.reason] = (extStat.skippedByReason[entry.reason] ?? 0) + 1;
    if (size !== null) {
      extStat.bytes += size;
      extStat.skippedBytes += size;
    }

    if (probeFn !== null && resolvedAbs !== null && size !== null && (extStat.bucket === "audio" || extStat.bucket === "video" || extStat.ext === ".caf")) {
      const mediaKind: "audio" | "video" = extStat.bucket === "video" ? "video" : "audio";
      mediaTargets.push({ mediaKind, ext: extStat.ext, absPath: resolvedAbs, size, scanStatus: entry.reason });
    }
  }

  const profileMap = new Map<string, MediaProfileStat>();
  for (const target of mediaTargets) {
    const probe = await probeFn!(target.absPath);
    const durationBucket = durationBucketOf(probe.durationSeconds);
    const compat = evaluateMediaV1Compatibility(
      target.mediaKind,
      target.ext,
      target.size,
      maxFileBytes,
      videoMaxFileBytes,
      probe,
    );
    const key = JSON.stringify([
      target.mediaKind,
      target.ext,
      target.scanStatus,
      probe.ok,
      probe.error,
      probe.formatName,
      probe.videoCodec,
      probe.pixFmt,
      probe.audioCodec,
      durationBucket,
      compat.compatible,
      compat.reasons,
    ]);
    const existing = profileMap.get(key);
    if (existing !== undefined) {
      existing.count += 1;
      existing.bytes += target.size;
    } else {
      profileMap.set(key, {
        mediaKind: target.mediaKind,
        ext: target.ext,
        scanStatus: target.scanStatus,
        probeOk: probe.ok,
        probeError: probe.error,
        formatName: probe.formatName,
        videoCodec: probe.videoCodec,
        pixFmt: probe.pixFmt,
        audioCodec: probe.audioCodec,
        durationBucket,
        v1Compatible: compat.compatible,
        incompatibilityReasons: compat.reasons,
        count: 1,
        bytes: target.size,
      });
    }
  }

  const scannedFiles = scan.files.length + scan.skipped.length;
  const totalKnownBytes = acceptedBytes + knownSkippedBytes;

  for (const modality of ALL_MODALITIES) {
    acceptedByModality[modality].fileShare = share(acceptedByModality[modality].count, scannedFiles);
    acceptedByModality[modality].byteShare = share(acceptedByModality[modality].bytes, totalKnownBytes);
  }

  const skipReasons: SkipReasonStat[] = [...skipMap.entries()]
    .map(([reason, stat]) => ({
      reason,
      count: stat.count,
      fileShare: share(stat.count, scannedFiles),
      bytes: stat.bytes,
      byteShare: share(stat.bytes, totalKnownBytes),
      knownByteCount: stat.knownByteCount,
    }))
    .sort((a, b) => b.count - a.count || b.bytes - a.bytes || a.reason.localeCompare(b.reason));

  const extensions: ExtensionStat[] = [...extMap.values()]
    .map((stat) => ({
      ...stat,
      fileShare: share(stat.count, scannedFiles),
      byteShare: share(stat.bytes, totalKnownBytes),
    }))
    .sort((a, b) => b.count - a.count || b.bytes - a.bytes || a.ext.localeCompare(b.ext));

  const mediaProfiles = [...profileMap.values()]
    .sort((a, b) => b.count - a.count || b.bytes - a.bytes || a.ext.localeCompare(b.ext));

  return {
    label: input.label,
    modalities,
    supportedModalities,
    maxFileBytes,
    videoMaxFileBytes,
    totals: {
      scannedFiles,
      acceptedFiles: scan.files.length,
      acceptedBytes,
      skippedFiles: scan.skipped.length,
      knownSkippedBytes,
      unknownSizeSkippedCount,
      sharpUnsupportedImageCount,
      sharpUnsupportedImageBytes,
      unknownDefaultTextCount,
      unknownDefaultTextBytes,
    },
    acceptedByModality,
    skipReasons,
    extensions,
    mediaProfiles,
  };
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function mib(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

/** 產出完全匿名化的 Stage 2 Markdown 統計摘要。 */
export function formatStatsMarkdown(report: FormatStatsReport): string {
  const lines: string[] = [
    `# Stage 2 格式統計：${report.label}`,
    "",
    `- 掃描總檔數：${report.totals.scannedFiles}（納入 ${report.totals.acceptedFiles}、跳過 ${report.totals.skippedFiles}）`,
    `- 已知總容量：${mib(report.totals.acceptedBytes + report.totals.knownSkippedBytes)}（納入 ${mib(report.totals.acceptedBytes)}、跳過 ${mib(report.totals.knownSkippedBytes)}）`,
    `- 掃描納入但 sharp 不支援解碼之圖片（.heic/.bmp/.ico）：${report.totals.sharpUnsupportedImageCount} 檔（${mib(report.totals.sharpUnsupportedImageBytes)}）`,
    `- 未知副檔名預設歸 text 者：${report.totals.unknownDefaultTextCount} 檔（${mib(report.totals.unknownDefaultTextBytes)}）`,
    "",
    "## SkipReason 分佈",
    "",
    "| SkipReason | 檔數 | 檔數佔比 | 已知容量 | 容量佔比 |",
    "| --- | ---: | ---: | ---: | ---: |",
  ];
  for (const row of report.skipReasons) {
    lines.push(`| ${row.reason} | ${row.count} | ${pct(row.fileShare)} | ${mib(row.bytes)} | ${pct(row.byteShare)} |`);
  }
  lines.push(
    "",
    "## 副檔名明細（前 30 項）",
    "",
    "| 副檔名 | 歸類 | 檔數 | 佔比 | 納入 | 跳過 | 跳過原因 / 風險 |",
    "| --- | --- | ---: | ---: | ---: | ---: | --- |",
  );
  for (const ext of report.extensions.slice(0, 30)) {
    const reasons = Object.entries(ext.skippedByReason).map(([k, v]) => `${k}:${v}`).join(", ");
    const headers = Object.entries(ext.unknownHeaderCounts).map(([k, v]) => `${k}:${v}`).join(", ");
    const risk = [ext.sharpUnsupportedImage ? "sharp-undecodable" : "", reasons, headers].filter(Boolean).join(" ; ") || "-";
    lines.push(`| ${ext.ext} | ${ext.bucket} | ${ext.count} | ${pct(ext.fileShare)} | ${ext.acceptedCount} | ${ext.skippedCount} | ${risk} |`);
  }
  if (report.mediaProfiles.length > 0) {
    lines.push(
      "",
      "## 影音容器與編碼 Probe 分佈",
      "",
      "| 類別 | 副檔名 | 掃描狀態 | 容器 | Video / PixFmt | Audio | 時長區間 | v1 相容 | 不相容原因 | 檔數 |",
      "| --- | --- | --- | --- | --- | --- | --- | --- | --- | ---: |",
    );
    for (const mp of report.mediaProfiles) {
      const v = mp.videoCodec ? `${mp.videoCodec}${mp.pixFmt ? `/${mp.pixFmt}` : ""}` : "-";
      lines.push(
        `| ${mp.mediaKind} | ${mp.ext} | ${mp.scanStatus} | ${mp.formatName ?? "-"} | ${v} | ${mp.audioCodec ?? "-"} | ${mp.durationBucket} | ${mp.v1Compatible ? "yes" : "no"} | ${mp.incompatibilityReasons.join(", ") || "-"} | ${mp.count} |`,
      );
    }
  }
  return lines.join("\n") + "\n";
}
