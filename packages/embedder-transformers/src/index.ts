/**
 * Mnemoshelf embedder：以 `@huggingface/transformers`（ONNX）實作多模態 Embedder。
 *
 * 公開入口只匯出實作與其選項型別；契約（port）型別由 `@mnemoshelf/core` 提供。
 */
export {
  DEFAULT_DIM,
  DEFAULT_MAX_SOFT_TOKENS,
  DEFAULT_MODEL_ID,
  MAX_BATCH_SIZE,
  SUPPORTED_DTYPES,
  TransformersEmbedder,
  defaultModelCacheDir,
  type DtypeOption,
  type PerComponentDtype,
  type TransformersDtype,
  type TransformersEmbedderOptions,
} from "./embedder.js";

export {
  CPU_BATCH_SIZE,
  DEFAULT_DML_DEVICE_ID,
  DML_BATCH_SIZE,
  EMBED_DEVICE_ENV,
  EMBED_DEVICE_OPTIONS,
  EMBED_DML_DEVICE_ID_ENV,
  deviceBatchSize,
  isDmlPlatform,
  parseDmlDeviceId,
  parseEmbedDeviceOption,
  requiresSerializedInference,
  resolveEmbedDevice,
  summarizeFailure,
  type EmbedDevice,
  type EmbedDeviceOption,
  type EmbedDevicePlan,
} from "./device.js";

export {
  EmbedderInputError,
  EmptyImageInputError,
  InvalidEmbedderOptionError,
  ModelInferenceError,
  ModelLoadError,
  UnsupportedDimensionError,
  UnsupportedDtypeError,
  VectorTruncationError,
} from "./errors.js";

export {
  PROBE_MARGIN_THRESHOLD,
  runProbe,
  type ProbeOptions,
} from "./probe.js";

export {
  createProbeImages,
  encodePngRgb,
  type SyntheticProbeImage,
} from "./test-images.js";

export {
  MRL_DIMENSIONS,
  assertMrlDimension,
  l2Normalize,
  truncateAndNormalize,
  type MrlDimension,
} from "./vector.js";
