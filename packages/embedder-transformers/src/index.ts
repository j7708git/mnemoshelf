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
  MAX_INPUT_TOKENS,
  SUPPORTED_DTYPES,
  TransformersEmbedder,
  defaultDeviceDecisionPath,
  defaultModelCacheDir,
  type DtypeOption,
  type PerComponentDtype,
  type TransformersDtype,
  type TransformersEmbedderOptions,
} from "./embedder.js";

export {
  ACCEL_UNAVAILABLE_MESSAGE,
  COREML_MLPROGRAM_FLAG,
  DEVICE_DECISION_SCHEMA,
  MAX_SUSPECTED_LOAD_CRASHES,
  SELF_TEST_CRITERIA,
  SELF_TEST_REASONS,
  SELF_TEST_SAMPLES,
  classifyDecision,
  cosineSimilarity,
  decisionMatchesIdentity,
  describeLoadCrashRetry,
  describeSelfTestReason,
  evaluateSelfTest,
  measurementFieldsOf,
  minCosineOf,
  nextLoadCrashDecision,
  parseDecisionRecord,
  readDecisionRecord,
  runCoreMlSelfTest,
  selfTestFallbackCode,
  toSelfTestStatus,
  writeDecisionRecord,
  type CoreMlSelfTestOptions,
  type CoreMlSelfTestResult,
  type DecisionClassification,
  type DeviceDecisionIdentity,
  type DeviceDecisionOutcome,
  type DeviceDecisionPhase,
  type DeviceDecisionRecord,
  type SelfTestCriteria,
  type SelfTestMeasurement,
  type SelfTestMeasurementFields,
  type SelfTestReason,
} from "./self-test.js";

export {
  BATCH_TOKEN_BUDGET,
  CPU_BATCH_SIZE,
  DEFAULT_DML_DEVICE_ID,
  DML_BATCH_SIZE,
  EMBED_DEVICE_ENV,
  EMBED_DEVICE_OPTIONS,
  EMBED_DML_DEVICE_ID_ENV,
  EMBED_ORT_LOG_ENV,
  ORT_LOG_SEVERITY_LEVELS,
  deviceBatchSize,
  isCoreMlPlatform,
  isDmlPlatform,
  parseDmlDeviceId,
  parseEmbedDeviceOption,
  parseOrtLogLevel,
  requiresSerializedInference,
  resolveEmbedDevice,
  summarizeFailure,
  type EmbedDevice,
  type EmbedDeviceOption,
  type EmbedDevicePlan,
  type OrtLogSeverityLevel,
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
