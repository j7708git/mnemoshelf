/**
 * 影片解碼 port（MediaDecoder）與共用型別。
 *
 * 本模組只做「已通過 root 守衛的檔案 → 已解碼資料」，不負責 root 驗證、快照建立、
 * 索引寫入、embedding 或 UI。輸入是呼叫端已驗證過的絕對路徑（原始檔或本輪有界快照）。
 *
 * 抽樣政策（B1 凍結）：每 4 秒一段、每段 1 幀（0.25 fps）；本 port 保留 2／4 幀參數
 * 只為測試與未來政策，不得在產品路徑自行改變。
 */

/** 已通過 root 守衛的來源；呼叫端負責提供原始檔或本輪快照。 */
export interface MediaSource {
  /** 絕對路徑。不得是 URL、相對路徑或未經驗證的輸入。 */
  readonly path: string;
}

/** 影片視覺流的可觀測資訊（來自 ffprobe，不是猜測）。 */
export interface VideoStreamInfo {
  readonly codec: string;
  readonly profile?: string;
  readonly width: number;
  readonly height: number;
  readonly pixFmt?: string;
  /** 顯示矩陣旋轉角度（0／90／180／270）；ffmpeg 預設 autorotate 解碼後尺寸已套用。 */
  readonly rotationDegrees: 0 | 90 | 180 | 270;
  readonly avgFrameRate: string;
  readonly rFrameRate: string;
  /** 視覺流自身起點（秒）；缺時 fallback `VideoProbe.sourceStartSeconds`，用於播放時間軸正規化。 */
  readonly startTimeSeconds?: number;
  /** 視覺流自身時長（秒）；缺時 fallback `VideoProbe.durationSeconds`。 */
  readonly durationSeconds?: number;
}

/** 音軌資訊；selectedAudio 的選軌規則見 selectAudioTrack。 */
export interface AudioStreamInfo {
  /** 容器內的 stream index（不是「第幾個音軌」）。 */
  readonly streamIndex: number;
  readonly codec: string;
  readonly sampleRate?: number;
  readonly channels?: number;
  readonly hasDefault: boolean;
  /** 音軌自身起點（秒）；缺時 fallback `VideoProbe.sourceStartSeconds`（ffprobe stream.start_time）。 */
  readonly startTimeSeconds?: number;
  /** 音軌自身時長（秒）；缺時 fallback `VideoProbe.durationSeconds`（ffprobe stream.duration）。 */
  readonly durationSeconds?: number;
  /** AAC priming 樣本數（ffprobe `initial_padding`）；供時間線與容差診斷。 */
  readonly initialPaddingSamples?: number;
}

/** 選定音軌（第一個 default AAC，否則第一個 AAC；沒有 AAC 時為 null）。 */
export interface SelectedAudioStream extends AudioStreamInfo {
  /** 是否為本版支援的 AAC（第 1 版只索引 AAC）。 */
  readonly isAac: boolean;
}

/** probe 結果。失敗才拋 MediaDecoderError；「沒有影片流」不是 probe 失敗。 */
export interface VideoProbe {
  readonly container: string;
  readonly durationSeconds: number;
  /** 容器時間軸起點（秒）；ChunkMedia 的時間以此為基準，不做平均 FPS 虛構。 */
  readonly sourceStartSeconds: number;
  readonly video: VideoStreamInfo | null;
  readonly audioStreams: readonly AudioStreamInfo[];
  /** 依選軌規則選出的音軌；沒有音軌或沒有 AAC 時欄位為 null 或 isAac=false。 */
  readonly selectedAudio: SelectedAudioStream | null;
  readonly hasVideo: boolean;
  readonly hasAudio: boolean;
}

/** 一個已解碼的視覺幀（RGB24、row-major）。 */
export interface VisualFrame {
  /** RGB 或 RGBA？本 port 固定 RGB24：bytes = width * height * 3。 */
  readonly pixels: Uint8Array;
  readonly width: number;
  readonly height: number;
  /** 實際來源時間（秒），來自 ffmpeg 輸出幀的 pts，不是「段號 × 平均 FPS」。 */
  readonly timestampSeconds: number;
}

/** 視覺片段；frames 至少 1 幀，時間覆蓋 [startSeconds, endSeconds)。 */
export interface VisualSegment {
  readonly startSeconds: number;
  readonly endSeconds: number;
  readonly frames: readonly VisualFrame[];
  /** 產生這個片段的抽樣政策版本（增量索引身分用）。 */
  readonly preprocessingVersion: string;
}

/** 一段 16 kHz mono PCM（產品音訊契約格式）。 */
export interface AudioSegment {
  readonly samples: Float32Array;
  readonly sampleRate: 16000;
  readonly startSeconds: number;
  readonly endSeconds: number;
  /** 產生這個片段的解碼／前處理版本（增量索引身分用）。 */
  readonly preprocessingVersion: string;
}

/** 解碼器可用性；缺失／損毀不拋例外，回 available=false 讓服務能啟動。 */
export interface DecoderAvailability {
  readonly available: boolean;
  readonly ffmpegVersion?: string;
  readonly ffprobeVersion?: string;
  readonly reason?: "missing-ffmpeg" | "missing-ffprobe" | "ffmpeg-failed" | "ffprobe-failed";
}

/** 解碼器硬限制（比對 A2 契約草案；PM／B3 可調整後重新凍結）。 */
export interface MediaDecoderLimits {
  /** 來源最長秒數，預設 600。 */
  readonly maxDurationSeconds: number;
  /** 來源最大位元組，預設 512 MiB。 */
  readonly maxSourceBytes: number;
  /** 最大等價像素（寬 × 高），預設 1920×1080。 */
  readonly maxPixels: number;
}

/** 每個方法的共通選項。 */
export interface DecodeCallOptions {
  readonly signal?: AbortSignal;
  /** 此操作的硬 deadline（毫秒）。probe 預設 15,000；decode 由呼叫端依 probe 時長給。 */
  readonly timeoutMs?: number;
}

/** 視覺解碼選項。 */
export interface DecodeVisualOptions extends DecodeCallOptions {
  /** 段長（秒），凍結值 4；僅測試可改。 */
  readonly segmentSeconds?: number;
  /** 每段幀數，凍結值 1；僅測試可用 2／4。 */
  readonly framesPerSegment?: 1 | 2 | 4;
  /** 縮圖後最長邊像素，凍結值 384。 */
  readonly longestSide?: number;
  /** 重用已做的 probe，避免每段重新 probe。 */
  readonly probe?: VideoProbe;
}

/** 音訊解碼選項。 */
export interface DecodeAudioOptions extends DecodeCallOptions {
  /** 音訊段長（秒），預設 10（沿用既有 WAV 政策）。 */
  readonly segmentSeconds?: number;
  /** 重用已做的 probe；沒有時 adapter 自行 probe。 */
  readonly probe?: VideoProbe;
}

/** 具名錯誤碼（B1 提案；PM／B3 凍結正式名稱）。 */
export type MediaDecoderErrorCode =
  | "video-decoder-unavailable"
  | "video-not-found"
  | "invalid-video"
  | "unsupported-video-container"
  | "unsupported-video-codec"
  | "unsupported-video-audio-track"
  | "no-audio-track"
  | "video-duration-exceeded"
  | "video-resolution-exceeded"
  | "video-source-too-large"
  | "video-output-limit-exceeded"
  | "video-decode-timeout"
  | "video-decode-cancelled"
  /** 時間線無法可靠定義（空幀列、段內無幀、重複／亂序 PTS、decoder 選幀與 ffprobe 不一致）。 */
  | "unsupported-video-timeline";

/** 解碼器錯誤；訊息固定、不含本機路徑或 stderr 原文（路徑只放欄位）。 */
export class MediaDecoderError extends Error {
  readonly code: MediaDecoderErrorCode;
  /** 相關來源路徑（僅供內部診斷，不進訊息）。 */
  readonly sourcePath?: string;

  constructor(code: MediaDecoderErrorCode, sourcePath?: string) {
    super(MEDIA_DECODER_ERROR_MESSAGES[code]);
    this.name = "MediaDecoderError";
    this.code = code;
    if (sourcePath !== undefined) this.sourcePath = sourcePath;
  }
}

/** 固定中文錯誤訊息（不得含路徑、檔名或 stderr 原文）。 */
export const MEDIA_DECODER_ERROR_MESSAGES: Readonly<Record<MediaDecoderErrorCode, string>> = {
  "video-decoder-unavailable": "影片解碼器不可用（缺少或損毀的 ffmpeg／ffprobe）",
  "video-not-found": "找不到影片來源",
  "invalid-video": "影片容器或媒體資料無效",
  "unsupported-video-container": "不支援的影片容器（僅支援本機 .mp4／MOV）",
  "unsupported-video-codec": "不支援的影片編碼（僅支援 H.264 8-bit SDR）",
  "unsupported-video-audio-track": "不支援的影片音軌（僅支援 AAC）",
  "no-audio-track": "影片沒有可解碼的音軌",
  "video-duration-exceeded": "影片時長超過上限",
  "video-resolution-exceeded": "影片解析度超過上限",
  "video-source-too-large": "影片來源大小超過上限",
  "video-output-limit-exceeded": "解碼輸出超過上限",
  "video-decode-timeout": "影片解碼逾時",
  "video-decode-cancelled": "影片解碼已取消",
  "unsupported-video-timeline": "影片時間線無法可靠定義（不支援的 PTS／幀分佈）",
};

/** 凍結的抽樣政策常數（B1；改變時必須換 preprocessingVersion）。 */
export const VIDEO_SEGMENT_SECONDS = 4;
export const VIDEO_FRAMES_PER_SEGMENT = 1;
export const VIDEO_LONGEST_SIDE = 384;
export const VIDEO_AUDIO_SEGMENT_SECONDS = 10;
export const VIDEO_AUDIO_SAMPLE_RATE = 16_000;

/**
 * 視覺前處理版本；含段長、每段幀數、縮圖最長邊與「來源 PTS」政策。
 *
 * v2（波次一 D1）：取幀改為 select 保留來源 PTS（srcpts-v1），不再用 fps 輸出格；
 * 舊索引必須重建。改變選幀規則時必須再換版。
 */
export function visualPreprocessingVersion(segmentSeconds = VIDEO_SEGMENT_SECONDS, framesPerSegment = VIDEO_FRAMES_PER_SEGMENT, longestSide = VIDEO_LONGEST_SIDE): string {
  return `mp4-h264-rgb24-v2:${segmentSeconds}s:${framesPerSegment}f:${longestSide}:srcpts-v1`;
}

/**
 * 影片音軌前處理版本（波次一 D2 起為 v2）。
 *
 * - clamp-v1：AAC 解碼的 float PCM 可能超出 [-1, 1]（codec 過衝），在 decoder 邊界夾住。
 * - stream-align-v1：以 ffprobe 的 per-stream start／duration 對齊播放時間軸（leading offset 補靜音）。
 * 舊索引必須重建。
 */
export function videoAudioPreprocessingVersion(segmentSeconds = VIDEO_AUDIO_SEGMENT_SECONDS): string {
  return `mp4-aac-mono16k-v2:${segmentSeconds}s:clamp-v1:stream-align-v1`;
}

/** 影像解碼器介面。 */
export interface MediaDecoder {
  /** 檢查 binary 可用性（缺失／損毀回 available=false，不拋）。 */
  checkAvailability(): Promise<DecoderAvailability>;
  /** 讀取容器與 stream 資訊；違反硬限制時拋具名錯誤。 */
  probe(source: MediaSource, options?: DecodeCallOptions): Promise<VideoProbe>;
  /** 序列解碼並依段輸出視覺幀；正常無競爭時不 seek，僅在讓出解碼程序名額後於段界以 -ss 恢復。 */
  decodeVisualSegments(source: MediaSource, options?: DecodeVisualOptions): AsyncGenerator<VisualSegment>;
  /** 單次解出選定 AAC 音軌為 16 kHz mono，串流切段。 */
  decodeAudioSegments(source: MediaSource, options?: DecodeAudioOptions): AsyncGenerator<AudioSegment>;
}

/** 預設硬限制。 */
export const DEFAULT_MEDIA_DECODER_LIMITS: MediaDecoderLimits = {
  maxDurationSeconds: 600,
  maxSourceBytes: 512 * 1024 * 1024,
  maxPixels: 1920 * 1080,
};