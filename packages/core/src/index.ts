/**
 * Mnemoshelf core 的公開 API。
 *
 * 契約測試（`runMetadataStoreContract` / `runVectorIndexContract`）刻意不從這裡匯出：
 * 它們相依於 vitest，放在 `@mnemoshelf/core/testing` 子路徑，避免主入口拉進測試框架。
 */

export type {
  Chunk,
  ChunkKind,
  Memory,
  MemoryKind,
  MemoryScope,
  Modality,
  NewChunk,
  NewMemory,
  NewRoot,
  RankedHit,
  Root,
  RootMode,
  SearchFilter,
} from "./ports/types.js";

export type { MetadataStore } from "./ports/metadata-store.js";
export {
  MEMORY_LIST_DEFAULT_LIMIT,
  MEMORY_LIST_MAX_LIMIT,
  normalizeMemoryLimit,
} from "./ports/metadata-store.js";
export type { MemoryFilter } from "./ports/metadata-store.js";
export type { VectorIndex, VectorItem } from "./ports/vector-index.js";
export type {
  DocumentInput,
  Embedder,
  EmbedderInfo,
  EmbedDocumentsOptions,
  ImageInput,
  ProbeResult,
} from "./ports/embedder.js";

export {
  DuplicateRootError,
  PathBlockedError,
  PathOutsideRootError,
  RootTooBroadError,
  VectorDimensionError,
  VectorNotNormalizedError,
} from "./errors.js";

export { rrfMerge, RRF_DEFAULT_K } from "./search/rrf.js";

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
  CHUNK_MIN_CHARS,
  chunkCode,
  chunkText,
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
  type IndexProgress,
  type IndexRootOptions,
  type IndexRootResult,
} from "./indexer/indexer.js";
export {
  DEFAULT_PREVIEW_MODALITIES,
  previewRoot,
  type PreviewKindStat,
  type PreviewRootInput,
  type RootPreview,
} from "./indexer/preview.js";
export {
  classifyFile,
  DEFAULT_MAX_FILE_BYTES,
  mimeTypeFor,
  walkRoot,
  type ScanEntry,
  type ScanOptions,
  type ScanResult,
  type ScanRoot,
  type SkippedEntry,
  type SkipReason,
} from "./indexer/scan.js";
