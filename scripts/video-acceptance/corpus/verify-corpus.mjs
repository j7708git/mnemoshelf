// 驗證語料：音軌分段 RMS／靜音、視覺畫面統計（黑畫面 vs 有事件）、串流格式。
// 產物：labels/scenes.json 不變、reports/verification.json
import fsp from "node:fs/promises";
import path from "node:path";
import {
  CORPUS_ROOT, FPS, HEIGHT, SAMPLE_RATE, WIDTH, probe, relFromCorpus, resolveMediaTools, runBuffer, writeJson,
} from "./lib.mjs";

const LABELS_DIR = path.join(CORPUS_ROOT, "labels");
const REPORTS_DIR = path.join(CORPUS_ROOT, "reports");
const QUALITY_DIR = path.join(CORPUS_ROOT, "quality");
const NEGATIVE_DIR = path.join(CORPUS_ROOT, "negative");

function parseWavPcm16(buf) {
  let pos = 12;
  let fmt = null;
  let data = null;
  while (pos + 8 <= buf.length) {
    const id = buf.toString("ascii", pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === "fmt ") {
      fmt = { audioFormat: buf.readUInt16LE(body), channels: buf.readUInt16LE(body + 2), sampleRate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) };
    } else if (id === "data") data = buf.subarray(body, body + size);
    pos = body + size + (size % 2);
  }
  if (!fmt || !data) throw new Error("bad wav");
  return { ...fmt, data };
}

async function decodePcm(file) {
  const { ffmpeg } = await resolveMediaTools();
  const buf = await runBuffer(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-i", file, "-vn", "-f", "f32le", "-ac", "1", "-ar", String(SAMPLE_RATE), "pipe:1",
  ], { timeoutMs: 120000 });
  const n = Math.floor(buf.length / 4);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 1) out[i] = buf.readFloatLE(i * 4);
  return out;
}

function rmsStats(samples, startSec, endSec) {
  const a = Math.max(0, Math.round(startSec * SAMPLE_RATE));
  const b = Math.min(samples.length, Math.round(endSec * SAMPLE_RATE));
  if (b <= a) return { maxRms: 0, meanRms: 0, windows: 0 };
  const win = Math.round(0.1 * SAMPLE_RATE);
  let maxRms = 0;
  let sum = 0;
  let count = 0;
  for (let s = a; s + win <= b; s += win) {
    let acc = 0;
    for (let i = s; i < s + win; i += 1) acc += samples[i] * samples[i];
    const r = Math.sqrt(acc / win);
    maxRms = Math.max(maxRms, r);
    sum += r;
    count += 1;
  }
  return { maxRms: Math.round(maxRms * 1e6) / 1e6, meanRms: Math.round((count ? sum / count : 0) * 1e6) / 1e6, windows: count };
}

async function frameStats(file, timeSec) {
  const { ffmpeg } = await resolveMediaTools();
  const buf = await runBuffer(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-ss", String(timeSec), "-i", file,
    "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1",
  ], { timeoutMs: 60000 });
  if (buf.length < WIDTH * HEIGHT * 3) throw new Error("short frame from " + file + " @ " + timeSec + " bytes=" + buf.length);
  let sum = 0;
  let sumSq = 0;
  const n = WIDTH * HEIGHT * 3;
  for (let i = 0; i < n; i += 1) {
    const v = buf[i];
    sum += v;
    sumSq += v * v;
  }
  const mean = sum / n;
  const variance = Math.max(0, sumSq / n - mean * mean);
  return { mean: Math.round(mean * 100) / 100, stdDev: Math.round(Math.sqrt(variance) * 100) / 100, bytes: buf.length };
}

const EXPECT_CONTENT = new Set([
  "starry-moon", "navy-heart", "red-triangles", "green-checker", "blue-bars", "hazard-stripes",
  "rainbow", "purple-circles", "tomato-circles", "falling-white-dots", "green-triangles-rising",
  "rain-lines", "flashing-circles", "purple-waves", "orange-flames", "lightning",
  "black-diagonals", "purple-stars", "redblue-squares", "squares-diagonal",
]);
const EXPECT_DEAD = new Set(["black", "gray-flat"]);

async function main() {
  const labels = JSON.parse(await fsp.readFile(path.join(LABELS_DIR, "scenes.json"), "utf8"));
  const report = {
    stage: "A2 synthetic quality corpus verification",
    verifiedAt: new Date().toISOString(),
    checks: [],
    failures: [],
    videos: [],
    negativeFitures: [],
  };

  for (const video of labels.videos) {
    const file = path.join(QUALITY_DIR, video.file);
    const p = await probe(file);
    if (!p.ok) throw new Error("probe failed: " + file);
    const v = p.json.streams.find((s) => s.codec_type === "video");
    const a = p.json.streams.find((s) => s.codec_type === "audio");
    const pcm = await decodePcm(file);
    const decodedDuration = pcm.length / SAMPLE_RATE;

    const visualChecks = [];
    for (const scene of video.visual) {
      const midpoint = Math.round(((scene.start + scene.end) / 2) * 10) / 10;
      const stats = await frameStats(file, midpoint);
      const isDead = EXPECT_DEAD.has(scene.motif);
      let ok;
      if (isDead) ok = stats.stdDev <= 3;
      else if (scene.motif === "slow-gradient") ok = stats.stdDev > 1;
      else ok = EXPECT_CONTENT.has(scene.motif) && stats.stdDev >= 10;
      visualChecks.push({ sceneId: scene.id, motif: scene.motif, midpoint, ...stats, expect: isDead ? "dead" : "content", ok });
      if (!ok) report.failures.push({ kind: "visual", video: video.id, sceneId: scene.id, motif: scene.motif, stats });
    }

    const audioChecks = [];
    for (const ev of video.audio) {
      const stats = rmsStats(pcm, ev.start, ev.end);
      let ok = true;
      if (ev.kind === "silence") ok = stats.maxRms <= 0.002;
      else ok = stats.maxRms >= 0.02;
      audioChecks.push({ eventId: ev.id, kind: ev.kind, env: ev.env, start: ev.start, end: ev.end, ...stats, expect: ev.kind === "silence" ? "silent" : "audible", ok });
      if (!ok) report.failures.push({ kind: "audio", video: video.id, eventId: ev.id, kind2: ev.kind, stats });
    }

    report.videos.push({
      id: video.id,
      file: relFromCorpus(file),
      probe: {
        duration: p.json.format.duration,
        videoCodec: v && v.codec_name,
        width: v && v.width,
        height: v && v.height,
        avgFrameRate: v && v.avg_frame_rate,
        audioCodec: a && a.codec_name,
        audioSampleRate: a && a.sample_rate,
      },
      decodedAudioDuration: Math.round(decodedDuration * 1000) / 1000,
      visualChecks,
      audioChecks,
    });
  }

  for (const neg of labels.negativeControls) {
    const file = path.join(NEGATIVE_DIR, neg.file);
    const p = await probe(file);
    if (!p.ok) throw new Error("probe failed: " + file);
    const stats = await frameStats(file, neg.durationSeconds / 2);
    const a = p.json.streams.find((s) => s.codec_type === "audio");
    const rms = a ? rmsStats(await decodePcm(file), 0, neg.durationSeconds) : { maxRms: 0, meanRms: 0 }
    const flatLimit = neg.visualMotif === "slow-gradient" ? 25 : 3;
    const checks = {
      blackOrFlatStdDev: stats.stdDev <= flatLimit,
      audioAsExpected:
        neg.audioKind === "none" ? !a : neg.audioKind === "silent" ? rms.maxRms <= 0.002 : rms.maxRms >= 0.02,
      hasAudioTrack: Boolean(a) === (neg.audioKind !== "none"),
    };
    if (!checks.blackOrFlatStdDev || !checks.audioAsExpected || !checks.hasAudioTrack) {
      report.failures.push({ kind: "negative", id: neg.id, checks });
    }
    report.negativeFitures.push({
      id: neg.id,
      file: relFromCorpus(file),
      visualMotif: neg.visualMotif,
      audioKind: neg.audioKind,
      durationSeconds: Number(p.json.format.duration),
      frameStats: stats,
      audioMaxRms: a ? rms.maxRms : null,
      checks,
    });
  }

  report.summary = {
    videos: report.videos.length,
    negativeFixtures: report.negativeFitures.length,
    failuredCount: report.failures.length,
    pass: report.failures.length === 0,
  };
  await writeJson(path.join(REPORTS_DIR, "verification.json"), report);
  console.log(JSON.stringify(report.summary));
  if (report.failures.length) {
    console.log(JSON.stringify(report.failures, null, 2));
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("FAILED:", error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
