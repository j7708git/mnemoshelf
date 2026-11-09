// 生成 6 支品質 MP4 與 4 支負對照 MP4（H.264 + AAC，固定 seed，全程程式繪製）。
// 產物：quality/v01..v06.mp4、negative/n01..n04.mp4、wav/*.wav、labels/scenes.json、reports/quality-encode.json
import fsp from "node:fs/promises";
import path from "node:path";
import {
  COLORS, CORPUS_ROOT, FPS, HEIGHT, SAMPLE_RATE, WIDTH, Canvas, hash32, mixInto, mulberry32,
  probe, readWavPcm16, relFromCorpus, resolveMediaTools, sha256File, startRawVideoEncoder,
  synthEnv, writeJson, writeWavPcm16,
} from "./lib.mjs";
import { NEGATIVE_CONTROLS, TTS_LINES, VIDEOS } from "./definitions.mjs";

const QUALITY_DIR = path.join(CORPUS_ROOT, "quality");
const NEGATIVE_DIR = path.join(CORPUS_ROOT, "negative");
const WAV_DIR = path.join(CORPUS_ROOT, "wav");
const TTS_DIR = path.join(CORPUS_ROOT, "tts");
const LABELS_DIR = path.join(CORPUS_ROOT, "labels");
const REPORTS_DIR = path.join(CORPUS_ROOT, "reports");

const round3 = (v) => Math.round(v * 1000) / 1000;

// ---------- 固定 seed 的偽隨機（不配置物件，依 hash） ----------
function prand(seed, i) {
  const a = hash32(seed, i) >>> 0;
  let t = a;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function starPoints(cx, cy, outer, inner, points, rotation) {
  const out = [];
  for (let i = 0; i < points * 2; i += 1) {
    const r = i % 2 === 0 ? outer : inner;
    const a = rotation + (Math.PI * i) / points - Math.PI / 2;
    out.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  return out;
}

function heartPoints(cx, cy, scale) {
  const pts = [];
  for (let i = 0; i < 72; i += 1) {
    const t = (Math.PI * 2 * i) / 72;
    const x = 16 * Math.sin(t) ** 3;
    const y = -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t));
    pts.push([cx + x * scale, cy + y * scale]);
  }
  return pts;
}

// ---------- 視覺場景 renderer（tLocal 秒） ----------
const RENDERERS = {
  "starry-moon": (cv, ctx) => {
    cv.fill(COLORS.navy);
    const seed = ctx.seed + 11;
    for (let i = 0; i < 70; i += 1) {
      const x = (prand(seed, i) * WIDTH + ctx.tLocal * 4) % WIDTH;
      const y = prand(seed, i + 1000) * HEIGHT * 0.92;
      const r = 1.2 + prand(seed, i + 2000) * 1.8;
      cv.circle(x, y, r, COLORS.white);
    }
    const mx = 80 + (ctx.tLocal / 8) * 470;
    const my = 120 + 22 * Math.sin(ctx.tLocal * 1.2);
    cv.circle(mx, my, 40, COLORS.yellow);
    cv.circle(mx - 12, my - 8, 6, [235, 195, 40]);
    cv.circle(mx + 14, my + 10, 4, [235, 195, 40]);
  },
  "navy-heart": (cv, ctx) => {
    cv.fill(COLORS.navy);
    const pulse = 1 + 0.18 * Math.sin(2 * Math.PI * 1.4 * ctx.tLocal);
    cv.polygon(heartPoints(WIDTH / 2, HEIGHT / 2 + 10, 7.6 * pulse * 1.06), COLORS.darkRed);
    cv.polygon(heartPoints(WIDTH / 2, HEIGHT / 2 + 10, 7.6 * pulse), [245, 55, 70]);
  },
  "red-triangles": (cv, ctx) => {
    cv.fill(COLORS.black);
    for (let i = 0; i < 3; i += 1) {
      const cx = [150, 450, 320][i];
      const cy = [120, 190, 300][i];
      const size = 70 + 24 * Math.sin(2 * Math.PI * 1.1 * ctx.tLocal + i * 1.7);
      const rot = ctx.tLocal * 0.8 + i;
      cv.polygon([[0, 1, 2].map((k) => {
        const a = rot + (Math.PI * 2 * k) / 3 - Math.PI / 2;
        return [cx + Math.cos(a) * size, cy + Math.sin(a) * size];
      })].flat(), COLORS.red);
    }
  },
  "green-checker": (cv, ctx) => {
    cv.checker(40, [20, 120, 50], [50, 200, 80], ctx.tLocal * 70, 0);
  },
  "blue-bars": (cv, ctx) => {
    cv.fill(COLORS.white);
    for (let i = 0; i < 7; i += 1) {
      const y = ((i * 55 + ctx.tLocal * 160) % (HEIGHT + 80)) - 80;
      cv.rect(0, y, WIDTH, 26, COLORS.blue);
    }
  },
  "hazard-stripes": (cv, ctx) => {
    cv.fill(COLORS.black);
    const offset = (ctx.tLocal * 160) % 72;
    for (let i = -1; i < HEIGHT / 72 + 1; i += 1) {
      cv.rect(0, offset + i * 72, WIDTH, 36, COLORS.yellow);
    }
  },
  rainbow: (cv, ctx) => { cv.rainbow(ctx.tLocal * 0.06); },
  "purple-circles": (cv, ctx) => {
    cv.fill([40, 10, 60]);
    for (let i = 0; i < 5; i += 1) {
      const cx = 90 + i * 115;
      const cy = 170 + 40 * Math.sin(i * 1.3);
      const r = 30 + 14 * Math.sin(2 * Math.PI * 1.6 * ctx.tLocal + i);
      cv.circle(cx, cy, r, COLORS.purple);
    }
  },
  "tomato-circles": (cv, ctx) => {
    cv.fill(COLORS.cream);
    for (let i = 0; i < 7; i += 1) {
      const cx = 100 + (i % 4) * 150;
      const cy = 110 + Math.floor(i / 4) * 150;
      const r = 26 + 8 * Math.sin(2 * Math.PI * 1.4 * ctx.tLocal + i * 0.8);
      cv.circle(cx, cy, r, COLORS.red);
      cv.circle(cx - 6, cy - 6, r * 0.28, [255, 130, 120]);
    }
  },
  "falling-white-dots": (cv, ctx) => {
    cv.fill(COLORS.black);
    const seed = ctx.seed + 22;
    for (let i = 0; i < 90; i += 1) {
      const x = prand(seed, i) * WIDTH;
      const y = ((prand(seed, i + 500) * HEIGHT + ctx.tLocal * 110) % (HEIGHT + 16)) - 8;
      cv.circle(x, y, 1.6 + prand(seed, i + 900) * 1.8, COLORS.white);
    }
  },
  "green-triangles-rising": (cv, ctx) => {
    cv.fill(COLORS.black);
    for (let i = 0; i < 5; i += 1) {
      const cx = 80 + i * 120;
      const cy = HEIGHT - ((ctx.tLocal * 80 + i * 90) % (HEIGHT + 120));
      const size = 34;
      const rot = ctx.tLocal * 1.5 + i;
      cv.polygon([0, 1, 2].map((k) => {
        const a = rot + (Math.PI * 2 * k) / 3 - Math.PI / 2;
        return [cx + Math.cos(a) * size, cy + Math.sin(a) * size];
      }), COLORS.green);
    }
  },
  "rain-lines": (cv, ctx) => {
    cv.fill([10, 20, 60]);
    const seed = ctx.seed + 33;
    for (let i = 0; i < 100; i += 1) {
      const x = prand(seed, i) * WIDTH;
      const y = ((prand(seed, i + 500) * HEIGHT + ctx.tLocal * 260) % (HEIGHT + 100)) - 60;
      cv.thickLine(x, y, x - 7, y + 34, 2, COLORS.lightBlue);
    }
  },
  "gray-flat": (cv) => { cv.fill(COLORS.gray); },
  "flashing-circles": (cv, ctx) => {
    cv.fill(COLORS.white);
    const on = Math.floor(ctx.tGlobal * 8) % 2 === 0;
    if (!on) return;
    for (let i = 0; i < 8; i += 1) {
      const cx = 90 + (i % 4) * 150;
      const cy = 110 + Math.floor(i / 4) * 140;
      cv.circle(cx, cy, 30, [25, 25, 30]);
    }
  },
  "purple-waves": (cv, ctx) => {
    cv.fill([30, 8, 50]);
    for (let i = 0; i < 4; i += 1) {
      const pts = [];
      for (let x = 0; x <= WIDTH; x += 16) {
        pts.push([x, 80 + i * 62 + 18 * Math.sin(x / 42 + ctx.tLocal * 2.2 + i)]);
      }
      for (let k = 0; k + 1 < pts.length; k += 1) {
        cv.thickLine(pts[k][0], pts[k][1], pts[k + 1][0], pts[k + 1][1], 5, COLORS.cyan);
      }
    }
  },
  black: (cv) => { cv.fill(COLORS.black); },
  "orange-flames": (cv, ctx) => {
    cv.fill(COLORS.black);
    for (let i = 0; i < 5; i += 1) {
      const baseX = 90 + i * 115;
      const flick = 1 + 0.22 * Math.sin(2 * Math.PI * 9 * ctx.tLocal + i * 2.1) + 0.1 * (prand(ctx.frameSeed, i) - 0.5);
      const h = 150 * flick;
      const layers = [[180, 70, 10, 1.25], [255, 140, 20, 1.0], [255, 220, 90, 0.55]];
      for (const [r, g, b, k] of layers) {
        cv.polygon([
          [baseX - 42 * k, HEIGHT - 24],
          [baseX, HEIGHT - 24 - h * k],
          [baseX + 42 * k, HEIGHT - 24],
        ], [r, g, b]);
      }
    }
  },
  lightning: (cv, ctx) => {
    cv.fill(COLORS.black);
    for (let i = 0; i < 2; i += 1) {
      if (prand(ctx.frameSeed, i) < 0.3) continue;
      const startX = 170 + i * 280;
      cv.zigzag(startX, 20, 7, 32, 44, 20, [70, 180, 255]);
      cv.zigzag(startX, 20, 7, 32, 44, 10, COLORS.white);
    }
  },
  "black-diagonals": (cv, ctx) => {
    cv.fill(COLORS.white);
    for (let i = 0; i < 6; i += 1) {
      const x0 = ((i * 170 + ctx.tLocal * 220) % (WIDTH + 420)) - 210;
      cv.thickLine(x0, -60, x0 + 320, HEIGHT + 60, 22, COLORS.black);
    }
  },
  "purple-stars": (cv, ctx) => {
    cv.fill([120, 50, 190]);
    for (let i = 0; i < 5; i += 1) {
      const cx = 90 + (i % 3) * 220;
      const cy = 100 + Math.floor(i / 3) * 150;
      cv.polygon(starPoints(cx, cy, 42, 18, 5, ctx.tLocal * 0.8 + i), COLORS.yellow);
    }
  },
  "redblue-squares": (cv, ctx) => {
    const phase = Math.floor(ctx.tGlobal * 6) % 2;
    cv.fill(COLORS.white);
    for (let i = 0; i < 4; i += 1) {
      const cx = 90 + (i % 2) * 300;
      const cy = 90 + Math.floor(i / 2) * 160;
      const color = (i + phase) % 2 === 0 ? COLORS.red : COLORS.blue;
      cv.rect(cx, cy, 130, 130, color);
    }
  },
  "squares-diagonal": (cv, ctx) => {
    cv.fill(COLORS.blue);
    for (let i = 0; i < 6; i += 1) {
      const x = ((i * 130 + ctx.tLocal * 120) % (WIDTH + 120)) - 60;
      const y = ((i * 90 + ctx.tLocal * 100) % (HEIGHT + 120)) - 60;
      cv.rect(x, y, 60, 60, COLORS.yellow);
    }
  },
  "slow-gradient": (cv, ctx) => {
    const shade = 90 + 50 * Math.sin((Math.PI * 2 * ctx.tLocal) / 40);
    for (let y = 0; y < HEIGHT; y += 1) {
      const v = Math.round(shade - 25 + (50 * y) / HEIGHT);
      cv.rect(0, y, WIDTH, 1, [v, v, v]);
    }
  },
};

function renderFrame(canvas, video, frameIndex) {
  const tGlobal = frameIndex / FPS;
  const scene = video.visual.find((s) => tGlobal >= s.start && tGlobal < s.end) ?? video.visual[video.visual.length - 1];
  const renderer = RENDERERS[scene.motif];
  if (!renderer) throw new Error("missing renderer: " + scene.motif);
  const ctx = {
    tGlobal,
    tLocal: tGlobal - scene.start,
    frameIndex,
    seed: video.seed,
    frameSeed: hash32(video.seed, scene.id, frameIndex),
  };
  renderer(canvas, ctx);
  return scene;
}

// ---------- 音軌組裝 ----------
async function buildAudio(video, outWav) {
  const total = Math.round(video.durationSeconds * SAMPLE_RATE);
  const buf = new Float32Array(total);
  const events = [];
  for (const ev of video.audio) {
    if (ev.kind === "speech") {
      const wavPath = path.join(TTS_DIR, ev.tts + ".wav");
      const wav = readWavPcm16(wavPath);
      if (wav.sampleRate !== SAMPLE_RATE) throw new Error("TTS sample rate mismatch: " + wavPath);
      const dur = wav.samples.length / wav.sampleRate;
      const spanStart = ev.chunk * 10;
      const spanEnd = Math.min(video.durationSeconds, spanStart + 10);
      const span = spanEnd - spanStart;
      if (dur > span - 0.8) throw new Error("TTS too long for chunk: " + ev.id + " " + dur);
      const place = round3(spanStart + Math.max(0.4, (span - dur - 0.4) / 2));
      mixInto(buf, wav.samples, place);
      events.push({
        ...ev,
        start: place,
        end: round3(place + dur),
        ttsDurationSeconds: round3(dur),
        ttsText: TTS_LINES[ev.tts].text,
        ttsVoice: TTS_LINES[ev.tts].voice,
      });
    } else if (ev.kind === "env") {
      const samples = synthEnv(ev.env, ev.end - ev.start, hash32(video.seed, ev.id));
      mixInto(buf, samples, ev.start);
      events.push({ ...ev, sampleRate: SAMPLE_RATE });
    } else {
      events.push({ ...ev });
    }
  }
  writeWavPcm16(outWav, buf);
  return events;
}

// ---------- 編碼 ----------
function encodeArgs(outFile, wavPath, withAudio, extra = []) {
  const args = [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", WIDTH + "x" + HEIGHT, "-r", String(FPS), "-i", "pipe:0",
  ];
  if (withAudio) {
    args.push("-i", wavPath, "-map", "0:v:0", "-map", "1:a:0");
  }
  args.push("-c:v", "libopenh264", "-b:v", "900k", "-pix_fmt", "yuv420p", "-g", "48");
  if (withAudio) args.push("-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "1", "-shortest");
  args.push("-movflags", "+faststart", ...extra, outFile);
  return args;
}

function summarizeProbe(p) {
  if (!p.ok) return { ok: false, error: p.error };
  const streams = p.json.streams.map((s) => ({
    index: s.index,
    codecType: s.codec_type,
    codecName: s.codec_name,
    codecTag: s.codec_tag_string,
    width: s.width,
    height: s.height,
    rFrameRate: s.r_frame_rate,
    avgFrameRate: s.avg_frame_rate,
    nbFrames: s.nb_frames,
    duration: s.duration,
    sampleRate: s.sample_rate,
    channels: s.channels,
    startTime: s.start_time,
  }));
  return {
    ok: true,
    format: {
      formatName: p.json.format.format_name,
      duration: p.json.format.duration,
      size: p.json.format.size,
      startTime: p.json.format.start_time,
    },
    streams,
  };
}

async function encodeOne({ id, outFile, durationSeconds, seed, wavPath, withAudio, visualKey, video }) {
  await resolveMediaTools();
  const frameCount = durationSeconds * FPS;
  const useVideo = video ?? { seed, visual: [{ id: id + "-s0", start: 0, end: durationSeconds, motif: visualKey }] };
  const enc = await startRawVideoEncoder(encodeArgs(outFile, wavPath, withAudio));
  const canvas = new Canvas(WIDTH, HEIGHT);
  const sceneHits = {};
  for (let f = 0; f < frameCount; f += 1) {
    const scene = renderFrame(canvas, useVideo, f);
    sceneHits[scene.id] = (sceneHits[scene.id] ?? 0) + 1;
    await enc.writeFrame(canvas.buf);
  }
  enc.endInput();
  const done = await enc.done;
  if (done.code !== 0) throw new Error("ffmpeg failed for " + id + ": " + done.stderr.slice(0, 4000));
  const p = await probe(outFile);
  const summary = summarizeProbe(p);
  const size = (await fsp.stat(outFile)).size;
  const sha256 = await sha256File(outFile);
  const args = encodeArgs("<out.mp4>", "<audio.wav>", withAudio).map((a) => (a === outFile ? "<out.mp4>" : a));
  return {
    id,
    relPath: relFromCorpus(outFile),
    durationSeconds,
    frameCount,
    sceneFrameCounts: sceneHits,
    sizeBytes: size,
    sha256,
    probe: summary,
    encode: {
      encoder: "ffmpeg libopenh264 (H.264 Constrained Baseline) + aac",
      args,
    },
  };
}

function assertProbe(entry, { expectAudio, durationSeconds }) {
  const p = entry.probe;
  if (!p.ok) throw new Error(entry.id + " probe failed: " + p.error);
  const v = p.streams.find((s) => s.codecType === "video");
  if (!v || v.codecName !== "h264" || v.width !== WIDTH || v.height !== HEIGHT) {
    throw new Error(entry.id + " unexpected video stream: " + JSON.stringify(v));
  }
  const a = p.streams.find((s) => s.codecType === "audio");
  if (expectAudio && (!a || a.codecName !== "aac")) throw new Error(entry.id + " missing aac audio: " + JSON.stringify(p.streams));
  if (!expectAudio && a) throw new Error(entry.id + " unexpected audio track");
  const dur = Number(p.format.duration);
  if (!(Math.abs(dur - durationSeconds) <= 0.2)) throw new Error(entry.id + " duration mismatch: " + dur);
  if (v.nbFrames !== undefined && Number(v.nbFrames) !== entry.frameCount) {
    throw new Error(entry.id + " frame count mismatch: " + v.nbFrames + " vs " + entry.frameCount);
  }
}

async function main() {
  // 每個 run 只能產生一次，避免覆蓋既有結果。
  for (const dir of [QUALITY_DIR, NEGATIVE_DIR, WAV_DIR, LABELS_DIR, REPORTS_DIR]) {
    await fsp.mkdir(dir);
  }
  const tools = await resolveMediaTools();
  const startedAt = new Date().toISOString();
  console.log("ffmpeg:", path.basename(tools.ffmpeg), "| ffprobe:", path.basename(tools.ffprobe));

  const quality = [];
  const labels = { generatedAt: startedAt, fps: FPS, width: WIDTH, height: HEIGHT, sampleRate: SAMPLE_RATE, videos: [] };

  for (const video of VIDEOS) {
    const wavPath = path.join(WAV_DIR, video.id + ".wav");
    const events = await buildAudio(video, wavPath);
    const outFile = path.join(QUALITY_DIR, video.id + ".mp4");
    console.log("encoding", video.id, video.durationSeconds + "s ...");
    const entry = await encodeOne({
      id: video.id,
      outFile,
      durationSeconds: video.durationSeconds,
      seed: video.seed,
      wavPath,
      withAudio: true,
      video,
    });
    assertProbe(entry, { expectAudio: true, durationSeconds: video.durationSeconds });
    quality.push(entry);

    // 音訊事件實際範圍（speech 依 TTS 實測長度置中；env 為指定區間；silence 為指定區間）。
    const eventById = new Map(events.map((ev) => [ev.id, ev]));
    labels.videos.push({
      id: video.id,
      file: video.id + ".mp4",
      durationSeconds: video.durationSeconds,
      seed: video.seed,
      visual: video.visual.map((s) => ({ id: s.id, start: s.start, end: s.end, motif: s.motif, desc: s.desc })),
      audio: video.audio.map((ev) => {
        const actual = eventById.get(ev.id);
        return {
          id: ev.id,
          kind: ev.kind,
          env: ev.env,
          chunk: ev.chunk,
          start: actual.start,
          end: actual.end,
          desc: ev.desc,
          tts: actual.tts,
          ttsText: actual.ttsText,
          ttsVoice: actual.ttsVoice,
        };
      }),
    });
    console.log("  ok:", entry.sizeBytes, "bytes", entry.sha256.slice(0, 16));
  }

  // 負對照 fixture：無事件死內容。
  const negative = [];
  for (const neg of NEGATIVE_CONTROLS) {
    const outFile = path.join(NEGATIVE_DIR, neg.file);
    let wavPath = null;
    let withAudio = neg.audio !== "none";
    if (withAudio) {
      const total = Math.round(neg.durationSeconds * SAMPLE_RATE);
      const buf = new Float32Array(total);
      if (neg.audio === "tone440") {
        const tone = synthEnv("tone440", neg.durationSeconds, hash32(neg.seed, "tone"));
        mixInto(buf, tone, 0, 0.8);
      }
      wavPath = path.join(WAV_DIR, neg.id + ".wav");
      writeWavPcm16(wavPath, buf);
    }
    console.log("encoding negative", neg.id, "...");
    const entry = await encodeOne({
      id: neg.id,
      outFile,
      durationSeconds: neg.durationSeconds,
      seed: neg.seed,
      wavPath,
      withAudio,
      visualKey: neg.visual,
    });
    assertProbe(entry, { expectAudio: withAudio, durationSeconds: neg.durationSeconds });
    negative.push({ ...entry, negativeControl: true, desc: neg.desc, audioKind: neg.audio, visualMotif: neg.visual });
    console.log("  ok:", entry.sizeBytes, "bytes");
  }

  labels.negativeControls = negative.map((n) => ({
    id: n.id,
    file: path.basename(n.relPath),
    durationSeconds: n.durationSeconds,
    visualMotif: n.visualMotif,
    audioKind: n.audioKind,
    desc: n.desc,
  }));
  labels.quality = quality.map((q) => ({ id: q.id, relPath: q.relPath, durationSeconds: q.durationSeconds, sha256: q.sha256 }));

  const report = {
    stage: "A2 synthetic quality corpus encode",
    generatedAt: startedAt,
    finishedAt: new Date().toISOString(),
    tools: { ffmpeg: path.basename(tools.ffmpeg), ffmpegDirHint: "decoder/bin 候選", ffprobe: path.basename(tools.ffprobe) },
    seedPolicy: "每個 fixture 固定 seed；所有隨機只來自 mulberry32/hash32，無外部素材",
    quality,
    negative,
  };
  await writeJson(path.join(REPORTS_DIR, "quality-encode.json"), report);
  await writeJson(path.join(LABELS_DIR, "scenes.json"), labels);
  console.log("done. quality:", quality.length, "negative:", negative.length);
}

main().catch((error) => {
  console.error("FAILED:", error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
