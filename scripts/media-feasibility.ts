/** 隔離的合成媒體探測；只讀模型快取，不下載、不接觸資料庫。從 repo 根執行。 */
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { mkdir, writeFile, stat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const root = process.cwd();
const require = createRequire(join(root, 'packages', 'embedder-transformers', 'package.json'));
const moduleFile = require.resolve('@huggingface/transformers');
const tf = await import(pathToFileURL(join(dirname(moduleFile), 'transformers.node.mjs')).href);
const { AutoConfig, AutoProcessor, AutoModel, RawImage, RawVideo, RawVideoFrame, env } = tf;
const dataDir = process.platform === 'win32'
  ? (process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'))
  : process.platform === 'darwin' ? join(homedir(), 'Library', 'Application Support')
    : (process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'));
env.cacheDir = process.env.MNEMOSHELF_MODEL_DIR ?? join(dataDir, 'mnemoshelf', 'models');
env.allowRemoteModels = false;
const modelId = 'onnx-community/embeddinggemma-2-ONNX';
const outputDir = join(root, '.tmp', 'media-feasibility');
await mkdir(outputDir, { recursive: true });
const report: Record<string, unknown> = {
  runtime: { node: process.versions.node, electron: process.versions.electron ?? null, platform: process.platform, arch: process.arch },
  model: modelId, remoteModelsAllowed: false,
};
const cleanError = (error: unknown) => String(error).replaceAll(homedir(), '<home>').replaceAll(root, '<repo>');
const shape = (inputs: Record<string, any>) => Object.fromEntries(Object.entries(inputs).map(([key, value]) => [key, value?.dims ?? value]));
const tone = (seconds: number) => Float32Array.from({ length: seconds * 16_000 }, (_, i) => 0.1 * Math.sin(2 * Math.PI * 440 * i / 16_000));
const localOptions = { local_files_only: true };
const processor = await AutoProcessor.from_pretrained(modelId, localOptions);
report.processor = { samplingRate: processor.feature_extractor.config.sampling_rate, videoMaxFrames: processor.video_processor.max_frames };
const selectedFrames = processor.video_processor.sample_frames(Array.from({ length: 40 }, (_, i) => i));
assert.equal(selectedFrames.length, 32);
report.video40FrameSelection = selectedFrames;
for (const [label, call] of [
  ['loadAudio', () => tf.load_audio(join(outputDir, 'synthetic.wav'), 16_000)],
  ['loadVideo', () => tf.load_video(join(outputDir, 'synthetic.mp4'), { num_frames: 2 })],
] as const) {
  try { await call(); report[label] = 'unexpected-success'; } catch (error) { report[label] = cleanError(error); }
}
const audio: Record<string, unknown>[] = [];
let firstAudio: any;
let thirtySeconds: any;
for (const seconds of [1, 10, 30, 31]) {
  const started = performance.now();
  const inputs = await processor(null, null, tone(seconds));
  assert(inputs.input_features.data.every(Number.isFinite));
  audio.push({ seconds, processingMs: performance.now() - started, shapes: shape(inputs) });
  if (seconds === 1) firstAudio = inputs;
  if (seconds === 30) thirtySeconds = inputs;
  if (seconds === 31) {
    report.audio31Equals30 = inputs.input_features.data.length === thirtySeconds.input_features.data.length
      && inputs.input_features.data.every((x: number, i: number) => x === thirtySeconds.input_features.data[i]);
  }
}
report.audioPreprocess = audio;
const assets: Record<string, number | null> = {};
for (const name of ['audio_encoder_q4.onnx', 'audio_encoder_q4.onnx_data', 'model_q4.onnx', 'model_q4.onnx_data', 'vision_encoder_q4.onnx', 'vision_encoder_q4.onnx_data']) {
  try { assets[name] = (await stat(join(env.cacheDir, 'onnx-community', 'embeddinggemma-2-ONNX', 'onnx', name))).size; }
  catch { assets[name] = null; }
}
report.cachedAssets = assets;
const config = await AutoConfig.from_pretrained(modelId, localOptions);
const hasAudioEncoder = assets['audio_encoder_q4.onnx'] !== null && assets['audio_encoder_q4.onnx_data'] !== null;
if (!hasAudioEncoder) config.audio_config = null;
const started = performance.now();
const model = await AutoModel.from_pretrained(modelId, {
  ...localOptions, config, device: 'cpu', dtype: { model: 'q4', vision_encoder: 'q4', audio_encoder: 'q4' },
  session_options: { enableCpuMemArena: false, enableMemPattern: false, intraOpNumThreads: 4 },
});
report.modelLoadMs = performance.now() - started;
try {
  try {
    const audioRuns: Record<string, unknown>[] = [];
    for (const seconds of hasAudioEncoder ? [1, 10] : [1]) {
      const inputs = seconds === 1 ? firstAudio : await processor(null, null, tone(seconds));
      const start = performance.now();
      const result = await model(inputs);
      const values = Array.from(result.sentence_embedding.data) as number[];
      assert.equal(values.length, 768);
      assert(values.every(Number.isFinite));
      const norm = Math.hypot(...values);
      assert(Math.abs(norm - 1) < 0.001);
      audioRuns.push({ seconds, inferenceMs: performance.now() - start, outputDims: result.sentence_embedding.dims, norm });
    }
    report.audioInference = { status: 'passed', runs: audioRuns };
  }
  catch (error) {
    if (hasAudioEncoder) throw error;
    report.audioInference = { status: 'blocked-missing-audio-encoder', error: cleanError(error) };
  }
  const frames = Array.from({ length: 4 }, (_, frame) => {
    const pixels = new Uint8Array(64 * 64 * 3);
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
      const at = (y * 64 + x) * 3;
      pixels[at] = frame % 2 === 0 ? 220 : 20;
      pixels[at + 1] = x * 4;
      pixels[at + 2] = frame % 2 === 1 ? 220 : y * 4;
    }
    return new RawVideoFrame(new RawImage(pixels, 64, 64, 3), frame);
  });
  const vectors: number[][] = [];
  const video: Record<string, unknown>[] = [];
  for (const [name, clip] of [
    ['forward', new RawVideo(frames, 4)],
    ['reverse', new RawVideo([...frames].reverse(), 4)],
    ['different-timestamps', new RawVideo(frames.map((f: any, i: number) => new RawVideoFrame(f.image, i * 10)), 40)],
  ]) {
    const preStart = performance.now();
    const inputs = await processor(null, null, null, clip);
    assert(inputs.input_ids.dims[1] <= 8192);
    const preprocessMs = performance.now() - preStart;
    const runStart = performance.now();
    const output = await model(inputs);
    const inferenceMs = performance.now() - runStart;
    const vec = Array.from(output.sentence_embedding.data) as number[];
    assert.equal(vec.length, 768);
    assert(vec.every(Number.isFinite));
    const norm = Math.hypot(...vec);
    assert(Math.abs(norm - 1) < 0.001);
    vectors.push(vec);
    video.push({ name, preprocessMs, inferenceMs, shapes: shape(inputs), outputDims: output.sentence_embedding.dims, norm });
  }
  const cosine = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0) / (Math.hypot(...a) * Math.hypot(...b));
  report.videoInference = video;
  report.temporalChecks = { reverseCosine: cosine(vectors[0], vectors[1]), changedTimestampCosine: cosine(vectors[0], vectors[2]), timestampVectorExactlyEqual: vectors[0].every((x, i) => x === vectors[2][i]) };
  report.memory = { rssBytes: process.memoryUsage().rss, maxRssKiB: process.resourceUsage().maxRSS };
} finally { await model.dispose(); }
const outputName = process.versions.electron ? 'electron-report.json' : 'node-report.json';
await writeFile(join(outputDir, outputName), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
