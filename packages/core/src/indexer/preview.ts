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

export interface RootPreview {
  totalFiles: number;
  totalBytes: number;
  byKind: Record<Modality, PreviewKindStat>;
  skipped: SkippedEntry[];
  /** **粗估**的 chunk 數（見下方常數）。 */
  estimatedChunks: number;
  /** **粗估**的索引秒數（見下方常數）。 */
  estimatedSeconds: number;
}

/** 預覽未指定 modalities 時的預設值。 */
export const DEFAULT_PREVIEW_MODALITIES: readonly Modality[] = ["text", "code"];

/** 粗估：每個文字／程式碼 chunk 約 900 bytes（落在 600–1200 的區間中值）。 */
const ESTIMATED_BYTES_PER_CHUNK = 900;
/** 粗估：每秒可嵌入的 chunk 數（CPU 上的保守值，僅供 UI 顯示，非承諾）。 */
const ESTIMATED_CHUNKS_PER_SECOND = 8;

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
 * `estimatedChunks` 與 `estimatedSeconds` 是粗略模型，非精確值。
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

  for (const file of scan.files) {
    totalBytes += file.size;
    byKind[file.kind].count += 1;
    byKind[file.kind].bytes += file.size;
    if (file.kind === "text" || file.kind === "code") {
      estimatedChunks += Math.max(1, Math.ceil(file.size / ESTIMATED_BYTES_PER_CHUNK));
    } else {
      estimatedChunks += 1; // 媒體檔每檔一塊
    }
  }

  return {
    totalFiles: scan.files.length,
    totalBytes,
    byKind,
    skipped: scan.skipped,
    estimatedChunks,
    estimatedSeconds: Math.ceil(estimatedChunks / ESTIMATED_CHUNKS_PER_SECOND),
  };
}
