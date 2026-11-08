/**
 * 影片播放與媒體命中的純邏輯（不碰 DOM，可單獨測試）。
 *
 * 播放路線（A1 已驗證）：
 * - **桌面版**：Electron Chromium 以同源 `GET /roots/:id/media?path=` 的 Range 播放；
 *   Authorization 由 main process 的 `webRequest` 注入，**token 不進 URL**。
 * - **瀏覽器 standalone**：`<video src>` 帶不了 `Authorization`，且不得把 token 拼進查詢字串；
 *   本輪明確顯示「播放需桌面版 App」，預覽與時間定位仍可用。之後若要支援，可換成
 *   service worker 代理（在 `videoPlaybackSupport` 加入新分支即可，UI 不必改）。
 */
import type { ChunkMedia, VideoCapability } from "./api";
import { formatMediaTime } from "./audio";
import { isDesktopMode } from "./desktop";

/** 影片視覺抽樣段長（秒）：A 關卡凍結每 4 秒一段、每段 1 幀。 */
export const VIDEO_SEGMENT_SECONDS = 4;

/** 影片來源時長上限（秒；與 server 的 `VIDEO_MAX_DURATION_SECONDS` 一致）。 */
export const VIDEO_MAX_DURATION_SECONDS = 600;

/** 影片單檔大小上限（bytes；舊版服務沒有 capability 時的顯示用預設）。 */
export const DEFAULT_VIDEO_MAX_FILE_BYTES = 512 * 1024 * 1024;

/** 影片播放是否可用（桌面版＝同源 Range＋webRequest 注入；瀏覽器版＝明確限制）。 */
export type VideoPlaybackSupport =
  | { kind: "available" }
  | { kind: "desktop-only"; message: string };

/** 瀏覽器 standalone 的播放限制說明（不提供 token query、也不整檔下載成 blob）。 */
export const DESKTOP_ONLY_PLAYBACK_MESSAGE =
  "瀏覽器模式無法在播放器附加授權標頭（token 不會放進網址），因此不支援影片播放。" +
  "請改用桌面版 App；這裡仍可查看命中時間與片段資訊。";

/**
 * 判斷目前環境能不能播放影片。
 *
 * `desktop` 參數讓測試不必模擬 `window`；預設取 `isDesktopMode()`。
 * 桌面版回 `available`（實際是否 200／206 由播放器與 probeMedia 驗證）。
 */
export function videoPlaybackSupport(desktop: boolean = isDesktopMode()): VideoPlaybackSupport {
  return desktop ? { kind: "available" } : { kind: "desktop-only", message: DESKTOP_ONLY_PLAYBACK_MESSAGE };
}

/** 命中的軌道標籤：「影片畫面」／「影片音軌」／「音訊片段」／「檔案」。 */
export function mediaTrackLabel(media: ChunkMedia | undefined): string {
  if (media === undefined) return "檔案";
  switch (media.track) {
    case "video":
      return "影片畫面";
    case "video-audio":
      return "影片音軌";
    case "audio":
      return "音訊片段";
  }
}

/** 命中片段的時間範圍（例如 `0:04.0–0:08.0`）。 */
export function formatMediaSpan(startSeconds: number, endSeconds: number): string {
  return `${formatMediaTime(startSeconds)}–${formatMediaTime(endSeconds)}`;
}

/**
 * 畫面命中的「取樣幀時間」；沒有 `frameTimesSeconds` 時回 `null`。
 *
 * 抽樣是每段 1 幀，所以通常只有一個值；仍以陣列第一個值回報，避免把多幀資料說成單幀。
 */
export function mediaFrameSeconds(media: ChunkMedia | undefined): number | null {
  const frames = media?.frameTimesSeconds;
  if (frames === undefined || frames.length === 0) return null;
  const first = frames[0]!;
  return Number.isFinite(first) && first >= 0 ? first : null;
}

/**
 * 播放器要跳到的秒數：畫面片段優先跳到實際採用的幀時間，其次片段起點。
 *
 * 只用伺服器回報的資料（不猜）；文字 chunk 不會呼叫這個函式。
 */
export function mediaSeekSeconds(media: ChunkMedia): number {
  const frame = mediaFrameSeconds(media);
  if (frame !== null) return frame;
  return Number.isFinite(media.startSeconds) && media.startSeconds >= 0 ? media.startSeconds : 0;
}

/**
 * 一行式的命中描述（搜尋結果用）：
 * 畫面＝「影片畫面 0:04.0–0:08.0（取樣幀 0:06.0）」；音軌／音訊＝「影片音軌 0:00.0–0:10.0」。
 *
 * 只用伺服器回報的時間；沒有 `frameTimesSeconds` 時不顯示幀時間、也不推算。
 */
export function describeMediaHit(media: ChunkMedia): string {
  const label = mediaTrackLabel(media);
  const span = formatMediaSpan(media.startSeconds, media.endSeconds);
  const frame = mediaFrameSeconds(media);
  return frame === null ? `${label} ${span}` : `${label} ${span}（取樣幀 ${formatMediaTime(frame)}）`;
}

/** 影片能力不可用的原因 → 可讀說明（`disabled` 與 `unavailable` 要分開說）。 */
export function videoUnavailableReason(capability: VideoCapability | null): string | null {
  if (capability === null) return "本機服務沒有回報影片能力（可能版本較舊），無法確認能否索引影片。";
  if (capability.state === "available" && capability.available) return null;
  if (capability.state === "disabled") {
    return "本機服務沒有設定影片解碼器（ffmpeg／ffprobe），影片索引未啟用。";
  }
  switch (capability.reason) {
    case "missing-ffmpeg":
    case "missing-ffprobe":
      return "找不到影片解碼器 ffmpeg／ffprobe；請確認桌面版安裝完整，或改用環境變數指定路徑。";
    case "ffmpeg-failed":
    case "ffprobe-failed":
      return "影片解碼器無法執行（可能檔案損毀或版本不符）。";
    case "embedder-video-unsupported":
      return "目前嵌入模型不支援影片入口，無法索引影片。";
    default:
      return "影片能力目前不可用。";
  }
}

/** 「含影片」開關的狀態：能不能開、不能開的原因、服務層能力摘要。 */
export interface VideoToggleState {
  /** 開關可否操作。 */
  enabled: boolean;
  /** 不能開的原因（可操作時為 `null`）。 */
  reason: string | null;
  /** 服務層能力摘要（給使用者看的短句，例如「解碼器可用（n9.0.2）；上限 …」）。 */
  summary: string;
}

/** 由 capability 組出「含影片」開關的顯示狀態（純函式）。 */
export function videoToggleState(capability: VideoCapability | null): VideoToggleState {
  const reason = videoUnavailableReason(capability);
  if (capability === null) return { enabled: false, reason, summary: "影片能力未知" };
  const version = capability.ffmpegVersion === null ? "" : `（${capability.ffmpegVersion}）`;
  return {
    enabled: capability.state === "available" && capability.available,
    reason,
    summary:
      capability.state === "available"
        ? `解碼器可用${version}；上限 ${formatVideoLimitSeconds(capability.durationLimitSeconds)} 秒／${formatVideoLimitBytes(capability.maxFileBytes)}`
        : (reason ?? "影片能力不可用"),
  };
}

/** 影片上限秒數的顯示（600 → 「600」；非法值回「—」）。 */
export function formatVideoLimitSeconds(seconds: number): string {
  return Number.isFinite(seconds) && seconds > 0 ? String(Math.round(seconds)) : "—";
}

/** 1 MiB 的位元組數（per-root 影片上限的 UI 輸入單位）。 */
export const BYTES_PER_MIB = 1024 * 1024;

/** 影片單檔大小上限的允許範圍（bytes；與 server／storage 契約一致：1 byte–16 GiB）。 */
export const VIDEO_LIMIT_MIN_BYTES = 1;

/** 影片單檔大小上限的允許上限（bytes；16 GiB）。 */
export const VIDEO_LIMIT_MAX_BYTES = 16 * 1024 * BYTES_PER_MIB;

/** UI 輸入單位（整數 MiB）的最小值。 */
export const VIDEO_LIMIT_MIN_MIB = 1;

/** UI 輸入單位（整數 MiB）的最大值（16 GiB＝16384 MiB）。 */
export const VIDEO_LIMIT_MAX_MIB = VIDEO_LIMIT_MAX_BYTES / BYTES_PER_MIB;

/** `parseVideoLimitMiB` 的結果：成功時帶換算後的 bytes。 */
export type VideoLimitParseResult =
  | { ok: true; bytes: number }
  | { ok: false; message: string };

/**
 * 解析使用者輸入的「影片單檔大小上限（MiB）」。
 *
 * 契約（PM 已定）：bytes 範圍 1–16 GiB；UI 以 **整數 MiB** 輸入（1–16384）。
 * 只接受十進位正整數字串：空字串、負數、小數、千分位、單位字尾都給可讀錯誤，
 * 由呼叫端阻擋送出（不默默四捨五入或截斷）。
 */
export function parseVideoLimitMiB(text: string): VideoLimitParseResult {
  const trimmed = text.trim();
  if (trimmed === "") return { ok: false, message: "請輸入影片單檔大小上限（MiB）。" };
  if (!/^\d+$/.test(trimmed)) return { ok: false, message: "請輸入正整數（MiB），例如 512。" };
  const mib = Number(trimmed);
  if (!Number.isSafeInteger(mib) || mib < VIDEO_LIMIT_MIN_MIB) {
    return { ok: false, message: `上限至少 ${VIDEO_LIMIT_MIN_MIB} MiB。` };
  }
  if (mib > VIDEO_LIMIT_MAX_MIB) {
    return { ok: false, message: `上限最多 16 GiB（${VIDEO_LIMIT_MAX_MIB} MiB）。` };
  }
  const bytes = mib * BYTES_PER_MIB;
  if (!Number.isSafeInteger(bytes) || bytes < VIDEO_LIMIT_MIN_BYTES || bytes > VIDEO_LIMIT_MAX_BYTES) {
    return { ok: false, message: "影片上限超出允許範圍（1 byte–16 GiB）。" };
  }
  return { ok: true, bytes };
}

/**
 * 影片上限位元組的顯示（例如 512 MiB → 「512 MiB」）。
 *
 * 非整數 MiB 時保留至多兩位小數（server 可能存了不是 MiB 對齊的值）；
 * 小於 1 MiB 時直接顯示 bytes，避免被四捨五入成「0 MiB」。
 */
export function formatVideoLimitBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "—";
  if (bytes < BYTES_PER_MIB) return `${Math.trunc(bytes)} B`;
  const mib = bytes / BYTES_PER_MIB;
  if (Number.isInteger(mib)) return `${mib} MiB`;
  const rounded = Number(mib.toFixed(2));
  return `${rounded} MiB`;
}

/**
 * 這個 root 實際生效的影片單檔大小上限（bytes）。
 *
 * 優先序：root 自己的 `videoMaxFileBytes` → 服務層預設（`videoCapability.maxFileBytes`）
 * → 產品預設 512 MiB。非法值（非正數）一律視為未設定，不讓壞資料變成 0 上限。
 */
export function effectiveVideoMaxFileBytes(
  root: { videoMaxFileBytes?: number | null },
  fallbackBytes: number | undefined,
): number {
  const own = root.videoMaxFileBytes;
  if (typeof own === "number" && Number.isFinite(own) && own > 0) return Math.trunc(own);
  if (typeof fallbackBytes === "number" && Number.isFinite(fallbackBytes) && fallbackBytes > 0) {
    return Math.trunc(fallbackBytes);
  }
  return DEFAULT_VIDEO_MAX_FILE_BYTES;
}

/** 編輯欄位的預設值（整數 MiB 字串）；非整數 MiB 的值四捨五入到兩位小數。 */
export function videoLimitMiBDefault(fallbackBytes: number | undefined): string {
  const bytes = effectiveVideoMaxFileBytes({ videoMaxFileBytes: null }, fallbackBytes);
  const mib = bytes / BYTES_PER_MIB;
  return Number.isInteger(mib) ? String(mib) : String(Number(mib.toFixed(2)));
}

/**
 * 影片相關 skip／failed 原因的中文說明（掃描階段與處理階段分開命名，可對帳）。
 *
 * 這些原因會出現在 preview 的 `skipped`、索引結果的 `skippedFiles`／`failedFiles`
 * 與 diagnostics 的 `video.indexing`；UI 一律以同一張表顯示。
 */
export const VIDEO_REASON_LABEL: Record<string, string> = {
  "unsupported-video-format": "不是支援的影片格式（v1 只支援 .mp4）",
  "video-too-large": "超過影片大小上限",
  "video-duration-exceeded": "超過影片時長上限（600 秒）",
  "video-resolution-exceeded": "解析度超出支援範圍",
  "video-no-stream": "沒有可索引的影像流",
  "invalid-video": "影片損毀或無法解析",
  "unsupported-video-codec": "不支援的影片編碼（v1 只支援 H.264 8-bit SDR）",
  "unsupported-video-timeline": "影片時間線無法可靠定義（影格時間不連續或無法對齊）",
  "unsupported-video-audio-track": "影片音軌不支援（已開啟音軌時整檔跳過）",
  "video-decoder-unavailable": "影片解碼器不可用",
  "video-decode-timeout": "影片解碼逾時",
  "video-decode-cancelled": "影片解碼已取消",
  "video-not-found": "影片來源在解碼前已不存在",
};

/** 取影片原因的顯示文字；未知原因原樣顯示，便於回報。 */
export function videoReasonLabel(reason: string): string {
  return VIDEO_REASON_LABEL[reason] ?? reason;
}

/** 這個 skip／failed 原因是否屬於影片（給 preview 與結果面板分組用）。 */
export function isVideoReason(reason: string): boolean {
  return Object.hasOwn(VIDEO_REASON_LABEL, reason);
}

/**
 * 把索引結果中的影片 skip／failed 檔整理成可讀清單（例如
 * 「clip.mp4（超過影片時長上限（600 秒））、b.mp4（不支援的影片編碼…）」）。
 *
 * 只列影片原因；其他檔案的原因仍由呼叫端以原有方式顯示。空清單回空字串。
 */
export function describeVideoEntries(entries: readonly { relPath: string; reason: string }[]): string {
  return entries
    .filter((entry) => isVideoReason(entry.reason))
    .map((entry) => `${entry.relPath}（${videoReasonLabel(entry.reason)}）`)
    .join("、");
}