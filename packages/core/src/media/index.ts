/**
 * media 模組的公開入口（模組內用；root `src/index.ts` 的 exports 由 PM 統一加）。
 */
export {
  DEFAULT_MEDIA_DECODER_LIMITS,
  MEDIA_DECODER_ERROR_MESSAGES,
  MediaDecoderError,
  VIDEO_AUDIO_SAMPLE_RATE,
  VIDEO_AUDIO_SEGMENT_SECONDS,
  VIDEO_FRAMES_PER_SEGMENT,
  VIDEO_LONGEST_SIDE,
  VIDEO_SEGMENT_SECONDS,
  videoAudioPreprocessingVersion,
  visualPreprocessingVersion,
} from "./types.js";
export type {
  AudioSegment,
  AudioStreamInfo,
  DecodeAudioOptions,
  DecodeCallOptions,
  DecodeVisualOptions,
  DecoderAvailability,
  MediaDecoder,
  MediaDecoderErrorCode,
  MediaDecoderLimits,
  MediaSource,
  ProbeOptions,
  SelectedAudioStream,
  VideoProbe,
  VideoStreamInfo,
  VisualFrame,
  VisualSegment,
} from "./types.js";
export {
  audioSampleTolerance,
  buildFrameSelectExpression,
  buildGridSelectExpression,
  buildScaleFilter,
  computeAudioTimeline,
  displayDimensions,
  frameOffsetsSeconds,
  normalizeAudioSegmentSeconds,
  normalizeRotationDegrees,
  normalizeVisualSegmentSeconds,
  parseFramePtsList,
  parseFrameTimeline,
  parseProbeJson,
  planVisualFrames,
  scaledDimensions,
  selectAudioTrack,
  selectFrameIndices,
  ShowinfoPtsParser,
  toVideoProbe,
} from "./parse.js";
export type { ParsedProbe, RawProbeJson, VideoAudioTimeline, VisualFramePick } from "./parse.js";
export { classifyProcessFailure, classifyProbeJsonProblem, classifySpawnError } from "./classify.js";
export { DecodeProcessBudget } from "./decode-budget.js";
export type { DecodeBudgetStats, DecodeProcessLease } from "./decode-budget.js";
export { FfmpegMediaDecoder } from "./ffmpeg-decoder.js";
export type { FfmpegMediaDecoderOptions } from "./ffmpeg-decoder.js";
