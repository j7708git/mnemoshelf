import type { Modality } from "../ports/types.js";
import {
  DEFAULT_VIDEO_MAX_FILE_BYTES,
  VIDEO_MAX_DURATION_SECONDS,
  walkRoot,
  type ScanOptions,
  type ScanRoot,
  type SkippedEntry,
} from "./scan.js";

/** 預覽一個「尚未加入」的 root 設定時可提供的欄位（id／createdAt 等由加入時才產生）。 */
export interface PreviewRootInput {
  path: string;
  /** 預設只有 `text` 與 `code`（對齊 docs/roots-and-privacy.md）。 */
  modalities?: Modality[];
  include?: string[];
  exclude?: string[];
  respectGitignore?: boolean;
  /** 非影片單檔大小上限（bytes）；影片另見 `videoMaxFileBytes`。 */
  maxFileBytes?: number;
  /**
   * 影片單檔大小上限（bytes）；預設 `DEFAULT_VIDEO_MAX_FILE_BYTES`（512 MiB）。
   *
   * 影片**不套用** `maxFileBytes`（通用 10 MiB 對影片太小）。per-root 持久化值由呼叫端
   * 從 `Root.videoMaxFileBytes` 帶入；預覽會把超出上限者記 `video-too-large` 顯示出來。
   */
  videoMaxFileBytes?: number;
}

export interface PreviewKindStat {
  count: number;
  bytes: number;
}

/**
 * 估時的分解（讓 UI／診斷能解釋「時間是從哪來的」，而不是只給一個黑箱秒數）。
 *
 * 三個欄位皆為**整數秒**且**相加等於 `seconds`**（無條件進位，寧可高估一點）。
 * 模型刻意保守：寧可讓實際比預估快，也不要讓使用者被低估的數字騙進去跑幾小時。
 *
 * **影片不在這個總計內**：預覽不讀媒體、時長未知，用「600 秒上限」硬乘會把 5 秒短片
 * 估成數百秒（比實際大兩個數量級），因此影片的候選段數上界與估時上界一律放在
 * `RootPreview.video`（`durationKnown:false`），不污染 `estimatedSeconds`。
 */
export interface PreviewEstimate {
  /** 文字／程式碼（依 chunk 數）。 */
  textSeconds: number;
  /** 圖片（每張一個固定成本；模型不細分像素數與檔案大小）。 */
  imageSeconds: number;
  /** 音訊（依檔案大小推估的片段上界）；不是讀取音訊標頭取得的精確時長。 */
  otherSeconds: number;
  /** 三者相加，等於 `RootPreview.estimatedSeconds`；不含影片。 */
  seconds: number;
}

/**
 * 影片候選的預覽語意：**不讀媒體、不啟動 probe、不由壓縮大小換算時長**。
 *
 * 預覽只能說「最多可能有多少段」：以凍結的上限（最長 600 秒）除以抽樣段長推算上界。
 * 實際時長、實際片段數、codec 是否支援都要在確認索引後由受控探測才知道；
 * UI 文案（例如「時長待確認」與抽樣限制說明）由 PM／C 決定，這裡只給資料。
 */
export interface VideoPreviewEstimate {
  /** 候選影片檔數（掃描納入者；`video-too-large` 等跳過的不計）。 */
  files: number;
  /** 預覽不讀媒體，時長一律未知（不得由壓縮大小換算）。 */
  durationKnown: false;
  /** 是否計入影片音軌：`video` 與 `audio` 模態都開啟、且呼叫端都宣告支援時才計入。 */
  includesAudioTrack: boolean;
  /** 每檔畫面片段數上界（`VIDEO_MAX_DURATION_SECONDS / 4`，即 600 秒上限／4 秒抽樣）。 */
  visualSegmentsPerFileMax: number;
  /** 每檔音軌片段數上界（600 秒上限／10 秒音訊片段）；未計入音軌時為 0。 */
  audioSegmentsPerFileMax: number;
  /** 全部候選片段數上界；**不是**實際片段數。 */
  estimatedSegmentCountMax: number;
  /** 以片段數上界推估的索引秒數上界；**不是**實際耗時、也不是時長。 */
  estimatedSecondsMax: number;
}

export interface RootPreview {
  totalFiles: number;
  totalBytes: number;
  byKind: Record<Modality, PreviewKindStat>;
  skipped: SkippedEntry[];
  /**
   * **粗估**的 chunk 數（見下方常數）。
   * 影片每檔只計 **1**（可解釋的最小量）；實際段數未知，見 `video.estimatedSegmentCountMax`。
   */
  estimatedChunks: number;
  /** **粗估**的索引秒數（見下方常數）；等於 `estimated.seconds`，**不含影片**（見 `video`）。 */
  estimatedSeconds: number;
  /** 估時的分解（文字、圖片、音訊；影片另見 `video`；見 `PreviewEstimate`）。 */
  estimated: PreviewEstimate;
  /** 影片候選的預覽語意；沒有影片候選時為 `null`。 */
  video: VideoPreviewEstimate | null;
}

/** 預覽未指定 modalities 時的預設值。 */
export const DEFAULT_PREVIEW_MODALITIES: readonly Modality[] = ["text", "code"];

/** 粗估：每個文字／程式碼 chunk 約 900 bytes（落在 600–1200 的區間中值）。 */
const ESTIMATED_BYTES_PER_CHUNK = 900;
/**
 * 文字／程式碼：每個 chunk 的嵌入秒數。
 *
 * 依據（2026-10-16，使用者機器實測、x86 CPU、q4）：四次索引執行的實測吞吐為
 * **2.6–2.9 塊/秒**（換算 0.34–0.38 秒/塊，見研究筆記的吞吐換算）。
 * 這裡取 **0.4 秒/塊（＝2.5 塊/秒）**：偏慢的一端。舊常數（8 塊/秒）對同一批資料
 * 樂觀約 2.8 倍（顯示 9.3 分鐘、實際 25.7 分鐘）；寧可高估，讓預估變成「上界」。
 */
const TEXT_CHUNK_SECONDS = 0.4;
/**
 * 圖片：每張圖片的嵌入秒數。
 *
 * 依據（同上，x86 實測）：單張 2.4–4.9 秒，含「全解析度解碼＋前處理＋推論」；
 * 推論與檔案大小脫鉤（同解析度下 5 MB 與 50 KB 的 JPEG 成本相近，每張固定 630 patch、
 * 1 個 chunk、1 個向量），**解碼成本則與像素數成正比**——本模型不細分像素數。
 * 這裡取 **5 秒**＝量測區間的上界：1,000 張 ≈ 83 分鐘，與實測推算的 40–85 分鐘一致；
 * 舊模型對圖片是「每張 1 塊 ÷ 8 塊/秒 = 0.125 秒」，低估 20–40 倍。
 *
 * 沒有更細的裝置區分（GPU、Apple Silicon）：那些機型**沒有實測數字**，憑感覺乘一個
 * 係數等於編造；等有量測再依裝置分級。
 */
const IMAGE_SECONDS = 5;
/**
 * 音訊每個十秒片段的保守估值；預覽不讀內容，不能得知精確 codec、取樣率或時長。
 * 以首批支援的最小每秒位元組數（8kHz／PCM16／mono）估計片段數上界。
 * 這是規模提示而非裝置效能保證；實際時長／片段數在索引解碼後才可確定。
 */
const OTHER_MEDIA_SECONDS = IMAGE_SECONDS;
/** 影片視覺抽樣段長（秒）：A 關卡凍結為每 4 秒一段、每段 1 幀。 */
export const VIDEO_VISUAL_SEGMENT_SECONDS = 4;
/** 影片音軌沿用既有 10 秒音訊片段。 */
export const VIDEO_AUDIO_SEGMENT_SECONDS = 10;
/**
 * 每個影片視覺片段的保守估時（秒）。
 *
 * 依據（A1 實測，1 幀／4 秒段、1080p、CPU）：60／300／600 秒影片的首筆可搜尋時間
 * 約 0.55／2.5／4.9 分鐘（純畫面），換算每段約 2.0–2.2 秒；取 **2.5 秒**當上界。
 */
const VIDEO_VISUAL_SEGMENT_SECONDS_ESTIMATE = 2.5;

const ALL_MODALITIES: readonly Modality[] = ["text", "code", "image", "audio", "video"];

function emptyStats(): Record<Modality, PreviewKindStat> {
  const stats = {} as Record<Modality, PreviewKindStat>;
  for (const modality of ALL_MODALITIES) stats[modality] = { count: 0, bytes: 0 };
  return stats;
}

/**
 * 對一個尚未加入的 root 做乾跑（dry run）。
 *
 * 只掃描、統計，**不寫入任何 DB**，也**不讀取任何檔案的內容**（被跳過的檔案亦然）。
 * `estimatedChunks` 與 `estimatedSeconds`（及 `estimated` 的分解）是粗略模型，非精確值；
 * 常數與依據見上方各常數註解，模型刻意偏保守。
 *
 * 影片只在呼叫端**明確宣告支援**（`options.supportedModalities` 含 `video`）時才納入；
 * 未宣告時沿用既有行為，以 `unsupported-modality` 跳過。影片的時長一律未知，
 * 片段數只回上界（`video` 欄位），不從壓縮大小換算時長。
 */
export async function previewRoot(input: PreviewRootInput, options: ScanOptions = {}): Promise<RootPreview> {
  const root: ScanRoot = {
    path: input.path,
    modalities: [...(input.modalities ?? DEFAULT_PREVIEW_MODALITIES)],
    include: input.include ?? [],
    exclude: input.exclude ?? [],
    respectGitignore: input.respectGitignore ?? true,
  };

  // 服務端可依實際 embedder 就緒狀態縮小集合；單獨預覽使用產品格式能力。
  const supportedModalities: readonly Modality[] = options.supportedModalities ?? ["text", "code", "image", "audio"];
  const scanOptions: ScanOptions = { supportedModalities };
  if (input.videoMaxFileBytes !== undefined) scanOptions.videoMaxFileBytes = input.videoMaxFileBytes;
  else if (options.videoMaxFileBytes !== undefined) scanOptions.videoMaxFileBytes = options.videoMaxFileBytes;
  if (options.signal !== undefined) scanOptions.signal = options.signal;
  if (input.maxFileBytes !== undefined) scanOptions.maxFileBytes = input.maxFileBytes;
  else if (options.maxFileBytes !== undefined) scanOptions.maxFileBytes = options.maxFileBytes;

  const scan = await walkRoot(root, scanOptions);

  const byKind = emptyStats();
  let totalBytes = 0;
  let estimatedChunks = 0;
  let textChunks = 0;
  let imageFiles = 0;
  let otherMediaFiles = 0;
  let videoFiles = 0;

  // 影片片段數上界：不讀媒體、不用壓縮大小換算時長，只用凍結的來源上限推「最多幾段」。
  const videoAudioEnabled = root.modalities.includes("audio") && supportedModalities.includes("audio");
  const visualSegmentsPerFileMax = Math.ceil(VIDEO_MAX_DURATION_SECONDS / VIDEO_VISUAL_SEGMENT_SECONDS);
  const audioSegmentsPerFileMax = videoAudioEnabled
    ? Math.ceil(VIDEO_MAX_DURATION_SECONDS / VIDEO_AUDIO_SEGMENT_SECONDS)
    : 0;
  const segmentsPerVideoFileMax = visualSegmentsPerFileMax + audioSegmentsPerFileMax;

  for (const file of scan.files) {
    totalBytes += file.size;
    byKind[file.kind].count += 1;
    byKind[file.kind].bytes += file.size;
    if (file.kind === "text" || file.kind === "code") {
      const chunks = Math.max(1, Math.ceil(file.size / ESTIMATED_BYTES_PER_CHUNK));
      estimatedChunks += chunks;
      textChunks += chunks;
    } else if (file.kind === "audio") {
      const segments = Math.max(1, Math.ceil(Math.min(600, file.size / 16000) / 10));
      estimatedChunks += segments;
      otherMediaFiles += segments;
    } else if (file.kind === "video") {
      // 影片的實際時長／片段數未知：總計只加「可解釋的最小量」1 段，
      // 上界另見 `video.estimatedSegmentCountMax`（不污染 estimatedChunks／estimatedSeconds）。
      videoFiles += 1;
      estimatedChunks += 1;
    } else {
      estimatedChunks += 1; // 圖片每檔一塊
      imageFiles += 1;
    }
  }

  // 文字與圖片**分開估**：兩者的單位成本差約 26–53 倍（見常數註解），
  // 用同一個「塊/秒」去乘必然失真——這正是舊模型對圖片低估 20–40 倍的原因。
  const textSeconds = Math.ceil(textChunks * TEXT_CHUNK_SECONDS);
  const imageSeconds = imageFiles * IMAGE_SECONDS;
  const otherSeconds = otherMediaFiles * OTHER_MEDIA_SECONDS;
  // `estimatedSeconds` 刻意不含影片（時長未知，硬乘上限會失真兩個數量級）；
  // 影片的上界只出現在 `video.estimatedSecondsMax`，且明示不是實際值。
  const seconds = textSeconds + imageSeconds + otherSeconds;
  const videoSecondsMax = Math.ceil(
    videoFiles *
      (visualSegmentsPerFileMax * VIDEO_VISUAL_SEGMENT_SECONDS_ESTIMATE +
        audioSegmentsPerFileMax * OTHER_MEDIA_SECONDS),
  );

  const video: VideoPreviewEstimate | null =
    videoFiles === 0
      ? null
      : {
          files: videoFiles,
          durationKnown: false,
          includesAudioTrack: videoAudioEnabled,
          visualSegmentsPerFileMax,
          audioSegmentsPerFileMax,
          estimatedSegmentCountMax: videoFiles * segmentsPerVideoFileMax,
          estimatedSecondsMax: videoSecondsMax,
        };

  return {
    totalFiles: scan.files.length,
    totalBytes,
    byKind,
    skipped: scan.skipped,
    estimatedChunks,
    estimatedSeconds: seconds,
    estimated: { textSeconds, imageSeconds, otherSeconds, seconds },
    video,
  };
}
