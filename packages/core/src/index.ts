/**
 * Mnemoshelf core 的公開 API。
 *
 * 契約測試（`runMetadataStoreContract` / `runVectorIndexContract`）刻意不從這裡匯出：
 * 它們相依於 vitest，放在 `@mnemoshelf/core/testing` 子路徑，避免主入口拉進測試框架。
 */

export type {
  Chunk,
  ChunkKind,
  ChunkMedia,
  ChunkMediaContainer,
  ChunkMediaTrack,
  Memory,
  MemoryEmbeddingState,
  MemoryKind,
  MemoryPatch,
  MemoryScope,
  Modality,
  NewChunk,
  NewMemory,
  NewRoot,
  RankedHit,
  Root,
  RootMode,
  RootPatch,
  SearchFilter,
} from "./ports/types.js";

export type { MetadataStore } from "./ports/metadata-store.js";
export { memoryContentHash, normalizeMemoryContentForHash } from "./memory/content-normalize.js";
export {
  assertMemorySourceChunks,
  chunkMemorySourceMessages,
  MemorySourceConflictError,
  memorySourceEventHash,
  memorySourceRequestHash,
  normalizeMemorySourceEventCheck,
  normalizeMemorySourceRequest,
  normalizeMemorySourceScope,
  RAW_MEMORY_CHUNK_VERSION,
  readMemoryPolicy,
  validateMemorySourceWrite,
} from "./memory/source.js";
export type {
  MemoryPolicy,
  MemorySource,
  MemorySourceEventCheck,
  MemorySourceMessage,
  MemorySourceWriteResult,
  NewMemorySource,
  NewMemorySourceChunk,
} from "./memory/source.js";
export {
  assertMemoryEmbeddingCursor,
  assertMemoryEmbeddingFailure,
  assertMemoryEmbeddingInput,
  assertMemoryQueryVector,
  MEMORY_EMBEDDING_STATES,
  MEMORY_LIST_DEFAULT_LIMIT,
  MEMORY_LIST_MAX_LIMIT,
  MEMORY_SCOPES,
  MEMORY_SEARCH_MAX_K,
  normalizeMemoryLimit,
  normalizeChunkMedia,
  normalizeRootMaxFileBytes,
  normalizeRootVideoMaxFileBytes,
  MAX_FILE_BYTES_MIN,
  MAX_FILE_BYTES_MAX,
  VIDEO_MAX_FILE_BYTES_MIN,
  VIDEO_MAX_FILE_BYTES_MAX,
  assignChunkMediaSeq,
  CHUNK_MEDIA_CONTAINERS,
  CHUNK_MEDIA_MAX_FRAME_TIMES,
  CHUNK_MEDIA_TRACKS,
  compareChunkMediaOrder,
  normalizeMemoryPatch,
  normalizeMemorySearchFilter,
  normalizeMemorySearchK,
} from "./ports/metadata-store.js";
export type {
  MemoryEmbeddingFailure,
  MemoryEmbeddingStats,
  MemoryFilter,
  MemoryKeywordHit,
  MemorySearchBucket,
  MemorySearchFilter,
  MemoryVectorHit,
  NormalizedMemorySearchBucket,
  NormalizedMemorySearchFilter,
} from "./ports/metadata-store.js";
export type { VectorIndex, VectorItem } from "./ports/vector-index.js";
export { inspectWav, decodeWavSegments, WAV_PREPROCESSING_VERSION } from "./audio/wav.js";
export type { WavInfo, WavSegment } from "./audio/wav.js";
export type {
  AudioInput,
  DocumentInput,
  Embedder,
  EmbedderFallbackReason,
  EmbedderInfo,
  EmbedderRuntimeStatus,
  EmbedderSelfTestStatus,
  EmbedDocumentsOptions,
  ImageInput,
  ProbeResult,
  VideoFrameInput,
  VideoInput,
} from "./ports/embedder.js";
export { MAX_VIDEO_FRAME_EDGE, MAX_VIDEO_FRAMES, MAX_VIDEO_PIXELS } from "./ports/embedder.js";

export {
  DuplicateRootError,
  PathBlockedError,
  PathOutsideRootError,
  RootTooBroadError,
  VectorDimensionError,
  VectorNotNormalizedError,
} from "./errors.js";

export { rrfMerge, RRF_DEFAULT_K } from "./search/rrf.js";

// 機密遮罩（記憶與檔案索引共用同一組 curated 規則；卡 C1）
export { containsRedacted, mapMaskedRange, maskSecrets, maskSecretsWithSpans, REDACTED_PREFIX } from "./privacy/secret-masking.js";
export type { MaskedSecretSpan, MaskSecretsResult, MaskSecretsWithSpansResult, SecretKind } from "./privacy/secret-masking.js";

export { blockedReason, isBlocked } from "./roots/blacklist.js";
export {
  assertRootAllowed,
  defaultCaseInsensitive,
  isInsideRoot,
  realpathAllowMissing,
  resolveInsideRoot,
  type ResolvedPath,
} from "./roots/path-guard.js";

export { DEFAULT_DIM, loadVectorExtension, openDatabase, runMigrations } from "./adapters/sqlite/db.js";
export type { SqliteDatabase, SqliteStatement } from "./adapters/sqlite/driver.js";
export { SqliteMetadataStore } from "./adapters/sqlite/metadata-store.js";
export {
  MAX_KNN_K,
  NORMALIZATION_TOLERANCE,
  SqliteVectorIndex,
  vectorNorm,
} from "./adapters/sqlite/vector-index.js";

// Indexer 與 root 預覽（M1）
export {
  CHUNK_MAX_CHARS,
  CHUNK_MAX_TOKENS,
  CHUNK_MIN_CHARS,
  chunkCode,
  chunkText,
  estimateTokens,
  type TextChunk,
} from "./indexer/chunk-text.js";
export { RootNotIndexableError } from "./indexer/errors.js";
export {
  globToRegExp,
  matchesAnyGlob,
  matchesGlob,
} from "./indexer/glob.js";
export {
  hashBytes,
  indexRoot,
  isMediaDecodeError,
  looksBinary,
  BINARY_SNIFF_BYTES,
  type FailedFileEntry,
  type IndexProgress,
  type IndexRootOptions,
  type IndexRootResult,
  type IndexTimingEvent,
} from "./indexer/indexer.js";
export {
  DEFAULT_PREVIEW_MODALITIES,
  previewRoot,
  type PreviewEstimate,
  type PreviewKindStat,
  type PreviewRootInput,
  type RootPreview,
  type VideoPreviewEstimate,
} from "./indexer/preview.js";
export {
  DEFAULT_MEDIA_DECODER_LIMITS,
  FfmpegMediaDecoder,
  MEDIA_DECODER_ERROR_MESSAGES,
  MediaDecoderError,
  VIDEO_AUDIO_SAMPLE_RATE,
  VIDEO_AUDIO_SEGMENT_SECONDS,
  VIDEO_FRAMES_PER_SEGMENT,
  VIDEO_LONGEST_SIDE,
  VIDEO_SEGMENT_SECONDS,
  videoAudioPreprocessingVersion,
  visualPreprocessingVersion,
  type AudioSegment,
  type AudioStreamInfo,
  type DecodeAudioOptions,
  type DecodeCallOptions,
  type DecodeVisualOptions,
  type DecoderAvailability,
  type FfmpegMediaDecoderOptions,
  type MediaDecoder,
  type MediaDecoderErrorCode,
  type MediaDecoderLimits,
  type MediaSource,
  type ProbeOptions,
  type SelectedAudioStream,
  type VideoProbe,
  type VideoStreamInfo,
  type VisualFrame,
  type VisualFramePick,
  type VisualSegment,
} from "./media/index.js";
export {
  classifyExtensionDetail,
  classifyFile,
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_VIDEO_MAX_FILE_BYTES,
  isJunkFile,
  isSupportedVideoFileName,
  mimeTypeFor,
  VIDEO_MAX_DURATION_SECONDS,
  walkRoot,
  type ExtensionBucket,
  type ScanEntry,
  type ScanOptions,
  type ScanResult,
  type ScanRoot,
  type SkippedEntry,
  type SkipReason,
} from "./indexer/scan.js";
export {
  collectFormatStats,
  detectUnknownHeaderKind,
  formatStatsMarkdown,
  probeMediaWithFfprobe,
  SHARP_UNSUPPORTED_IMAGE_EXTS,
  type DurationBucket,
  type ExtensionStat,
  type FormatStatsInput,
  type FormatStatsOptions,
  type FormatStatsReport,
  type MediaContainerProbe,
  type MediaProbeFn,
  type MediaProfileStat,
  type SkipReasonStat,
  type UnknownHeaderKind,
} from "./indexer/format-stats.js";
