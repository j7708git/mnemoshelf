import type { Modality } from "../ports/types.js";
import { walkRoot, type ScanOptions, type ScanRoot, type SkippedEntry } from "./scan.js";

/** 預覽一個「尚未加入」的 root 設定時可提供的欄位（id／createdAt 等由加入時才產生）。 */
export interface PreviewRootInput {
  path: string;
  /** 預設只有 `text` 與 `code`（對齊 docs/roots-and-privacy.md）。 */
  modalities?: Modality[];
  include?: string[];
  exclude?: string[];
  respectGitignore?: boolean;
  maxFileBytes?: number;
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
 */
export interface PreviewEstimate {
  /** 文字／程式碼（依 chunk 數）。 */
  textSeconds: number;
  /** 圖片（每張一個固定成本；模型不細分像素數與檔案大小）。 */
  imageSeconds: number;
  /** 其他媒體（音訊／影片；embedder 尚未支援，見常數註解）。 */
  otherSeconds: number;
  /** 三者相加，等於 `RootPreview.estimatedSeconds`。 */
  seconds: number;
}

export interface RootPreview {
  totalFiles: number;
  totalBytes: number;
  byKind: Record<Modality, PreviewKindStat>;
  skipped: SkippedEntry[];
  /** **粗估**的 chunk 數（見下方常數）。 */
  estimatedChunks: number;
  /** **粗估**的索引秒數（見下方常數）；等於 `estimated.seconds`。 */
  estimatedSeconds: number;
  /** 估時的分解（文字與圖片分開；見 `PreviewEstimate`）。 */
  estimated: PreviewEstimate;
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
 * 其他媒體（音訊／影片）：目前的 embedder 宣告不支援（`capabilities.audio／video` 為 false），
 * 因此這些檔案實際上不會產生向量。這裡仍給保守值，避免「勾了模態卻顯示零成本」；
 * 取與圖片同級＝已知最慢的媒體成本。
 */
const OTHER_MEDIA_SECONDS = IMAGE_SECONDS;

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
 */
export async function previewRoot(input: PreviewRootInput, options: ScanOptions = {}): Promise<RootPreview> {
  const root: ScanRoot = {
    path: input.path,
    modalities: [...(input.modalities ?? DEFAULT_PREVIEW_MODALITIES)],
    include: input.include ?? [],
    exclude: input.exclude ?? [],
    respectGitignore: input.respectGitignore ?? true,
  };

  const scanOptions: ScanOptions = {};
  if (input.maxFileBytes !== undefined) scanOptions.maxFileBytes = input.maxFileBytes;
  else if (options.maxFileBytes !== undefined) scanOptions.maxFileBytes = options.maxFileBytes;

  const scan = await walkRoot(root, scanOptions);

  const byKind = emptyStats();
  let totalBytes = 0;
  let estimatedChunks = 0;
  let textChunks = 0;
  let imageFiles = 0;
  let otherMediaFiles = 0;

  for (const file of scan.files) {
    totalBytes += file.size;
    byKind[file.kind].count += 1;
    byKind[file.kind].bytes += file.size;
    if (file.kind === "text" || file.kind === "code") {
      const chunks = Math.max(1, Math.ceil(file.size / ESTIMATED_BYTES_PER_CHUNK));
      estimatedChunks += chunks;
      textChunks += chunks;
    } else {
      estimatedChunks += 1; // 媒體檔每檔一塊
      if (file.kind === "image") imageFiles += 1;
      else otherMediaFiles += 1;
    }
  }

  // 文字與圖片**分開估**：兩者的單位成本差約 26–53 倍（見常數註解），
  // 用同一個「塊/秒」去乘必然失真——這正是舊模型對圖片低估 20–40 倍的原因。
  const textSeconds = Math.ceil(textChunks * TEXT_CHUNK_SECONDS);
  const imageSeconds = imageFiles * IMAGE_SECONDS;
  const otherSeconds = otherMediaFiles * OTHER_MEDIA_SECONDS;
  const seconds = textSeconds + imageSeconds + otherSeconds;

  return {
    totalFiles: scan.files.length,
    totalBytes,
    byKind,
    skipped: scan.skipped,
    estimatedChunks,
    estimatedSeconds: seconds,
    estimated: { textSeconds, imageSeconds, otherSeconds, seconds },
  };
}
