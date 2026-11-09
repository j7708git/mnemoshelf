// 影片 A2 合成語料：共用工具（固定 seed、無外部素材、只寫 .tmp/video-a/corpus/）。
// 執行環境：Node 22+ ESM；ffmpeg/ffprobe 由 decoder-a 的候選 manifest 目錄提供。
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(SCRIPT_DIR, "..", "..", "..");
const runId = process.env.VIDEO_CORPUS_RUN_ID;
if (!runId || !/^[a-zA-Z0-9_-]+$/.test(runId)) throw new Error("必須設定有效 VIDEO_CORPUS_RUN_ID");
export const CORPUS_ROOT = path.join(REPO_ROOT, ".tmp", "video-acceptance", "corpus", runId);
export const DECODER_DIR = path.join(REPO_ROOT, ".tmp", "video-a", "decoder");

export const FPS = 24;
export const WIDTH = 640;
export const HEIGHT = 360;
export const SAMPLE_RATE = 16000;

// ---------- 固定 seed 的 PRNG ----------

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hash32(...values) {
  let h = 0x811c9dc5;
  for (const v of values) {
    let x = typeof v === "number" ? v >>> 0 : 0;
    for (const ch of String(v)) x = (Math.imul(x, 31) + ch.charCodeAt(0)) >>> 0;
    h ^= x;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

// ---------- 逐幀繪圖（RGB24 framebuffer） ----------

export class Canvas {
  constructor(width = WIDTH, height = HEIGHT) {
    this.width = width;
    this.height = height;
    this.buf = new Uint8Array(width * height * 3);
  }

  fill([r, g, b]) {
    const { buf, width, height } = this;
    for (let i = 0; i < width * height; i += 1) {
      buf[i * 3] = r;
      buf[i * 3 + 1] = g;
      buf[i * 3 + 2] = b;
    }
  }

  set(x, y, [r, g, b]) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const i = (y * this.width + x) * 3;
    this.buf[i] = r;
    this.buf[i + 1] = g;
    this.buf[i + 2] = b;
  }

  rect(x, y, w, h, color) {
    const [r, g, b] = color;
    const x0 = Math.max(0, Math.round(x));
    const y0 = Math.max(0, Math.round(y));
    const x1 = Math.min(this.width, Math.round(x + w));
    const y1 = Math.min(this.height, Math.round(y + h));
    for (let yy = y0; yy < y1; yy += 1) {
      for (let xx = x0; xx < x1; xx += 1) {
        const i = (yy * this.width + xx) * 3;
        this.buf[i] = r;
        this.buf[i + 1] = g;
        this.buf[i + 2] = b;
      }
    }
  }

  circle(cx, cy, radius, color) {
    if (radius <= 0) return;
    const [r, g, b] = color;
    const y0 = Math.max(0, Math.floor(cy - radius));
    const y1 = Math.min(this.height - 1, Math.ceil(cy + radius));
    const rr = radius * radius;
    for (let yy = y0; yy <= y1; yy += 1) {
      const dy = yy + 0.5 - cy;
      const dx = Math.sqrt(Math.max(0, rr - dy * dy));
      const x0 = Math.max(0, Math.floor(cx - dx));
      const x1 = Math.min(this.width - 1, Math.ceil(cx + dx));
      for (let xx = x0; xx <= x1; xx += 1) {
        const i = (yy * this.width + xx) * 3;
        this.buf[i] = r;
        this.buf[i + 1] = g;
        this.buf[i + 2] = b;
      }
    }
  }

  ring(cx, cy, radius, thickness, color) {
    const outer = radius + thickness / 2;
    const inner = Math.max(0, radius - thickness / 2);
    const [r, g, b] = color;
    const y0 = Math.max(0, Math.floor(cy - outer));
    const y1 = Math.min(this.height - 1, Math.ceil(cy + outer));
    for (let yy = y0; yy <= y1; yy += 1) {
      const dy = yy + 0.5 - cy;
      const outerDx = Math.sqrt(Math.max(0, outer * outer - dy * dy));
      const innerDx = dy * dy < inner * inner ? Math.sqrt(Math.max(0, inner * inner - dy * dy)) : 0;
      const spans = [[cx - outerDx, cx - innerDx], [cx + innerDx, cx + outerDx]];
      for (const [sx, ex] of spans) {
        const x0 = Math.max(0, Math.floor(sx));
        const x1 = Math.min(this.width - 1, Math.ceil(ex));
        for (let xx = x0; xx <= x1; xx += 1) {
          const i = (yy * this.width + xx) * 3;
          this.buf[i] = r;
          this.buf[i + 1] = g;
          this.buf[i + 2] = b;
        }
      }
    }
  }

  /** 多邊形填滿（even-odd scanline）；points = [[x,y],...]。 */
  polygon(points, color) {
    if (points.length < 3) return;
    const [r, g, b] = color;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const [, y] of points) { minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
    const y0 = Math.max(0, Math.floor(minY));
    const y1 = Math.min(this.height - 1, Math.ceil(maxY));
    for (let yy = y0; yy <= y1; yy += 1) {
      const yc = yy + 0.5;
      const xs = [];
      for (let i = 0; i < points.length; i += 1) {
        const [ax, ay] = points[i];
        const [bx, by] = points[(i + 1) % points.length];
        if ((ay <= yc && by > yc) || (by <= yc && ay > yc)) {
          xs.push(ax + ((yc - ay) / (by - ay)) * (bx - ax));
        }
      }
      xs.sort((a, b2) => a - b2);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const xa = Math.max(0, Math.floor(xs[k]));
        const xb = Math.min(this.width - 1, Math.ceil(xs[k + 1]));
        for (let xx = xa; xx <= xb; xx += 1) {
          const idx = (yy * this.width + xx) * 3;
          this.buf[idx] = r;
          this.buf[idx + 1] = g;
          this.buf[idx + 2] = b;
        }
      }
    }
  }

  /** 粗線段：以四邊形填滿（points 依方向旋轉）。 */
  thickLine(x1, y1, x2, y2, thickness, color) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;
    const nx = (-dy / len) * (thickness / 2);
    const ny = (dx / len) * (thickness / 2);
    this.polygon([[x1 + nx, y1 + ny], [x2 + nx, y2 + ny], [x2 - nx, y2 - ny], [x1 - nx, y1 - ny]], color);
  }

  triangle(x1, y1, x2, y2, x3, y3, color) {
    this.polygon([[x1, y1], [x2, y2], [x3, y3]], color);
  }

  /** 鋸齒（閃電）折線，以粗線段串起。 */
  zigzag(startX, startY, segments, stepX, stepY, thickness, color) {
    let x = startX;
    let y = startY;
    const pts = [[x, y]];
    for (let i = 0; i < segments; i += 1) {
      x += stepX * (i % 2 === 0 ? 1 : -0.6);
      y += stepY;
      pts.push([x, y]);
    }
    for (let i = 0; i + 1 < pts.length; i += 1) {
      this.thickLine(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], thickness, color);
    }
  }

  checker(tile, colorA, colorB, offsetX = 0, offsetY = 0) {
    const [ar, ag, ab] = colorA;
    const [br, bg, bb] = colorB;
    const { width, height, buf } = this;
    for (let yy = 0; yy < height; yy += 1) {
      const row = Math.floor((yy + offsetY) / tile);
      for (let xx = 0; xx < width; xx += 1) {
        const col = Math.floor((xx + offsetX) / tile);
        const idx = (yy * width + xx) * 3;
        if ((row + col) % 2 === 0) { buf[idx] = ar; buf[idx + 1] = ag; buf[idx + 2] = ab; }
        else { buf[idx] = br; buf[idx + 1] = bg; buf[idx + 2] = bb; }
      }
    }
  }

  /** 彩虹漸層（水平 hue 分佈，phase 為 0..1 偏移）。 */
  rainbow(phase) {
    for (let xx = 0; xx < this.width; xx += 1) {
      const h = ((xx / this.width + phase) % 1) * 360;
      const [r, g, b] = hsv(h, 0.85, 1);
      for (let yy = 0; yy < this.height; yy += 1) {
        const idx = (yy * this.width + xx) * 3;
        this.buf[idx] = r; this.buf[idx + 1] = g; this.buf[idx + 2] = b;
      }
    }
  }

  /** 水平色條（給安全矩陣用的彩條畫面）。 */
  colorBars(timeSec) {
    const bars = [[255, 255, 255], [255, 220, 40], [40, 200, 230], [50, 200, 80], [230, 60, 200], [230, 40, 40], [40, 90, 230], [0, 0, 0]];
    const w = Math.floor(this.width / bars.length);
    for (let i = 0; i < bars.length; i += 1) {
      this.rect(i * w, 0, i === bars.length - 1 ? this.width - i * w : w, this.height, bars[(i + Math.floor(timeSec * 2)) % bars.length]);
    }
    this.rect(0, this.height - 40, this.width, 40, [0, 0, 0]);
    const x = (timeSec * 120) % (this.width + 100) - 100;
    this.circle(x, this.height - 20, 14, [255, 200, 60]);
  }
}

export function hsv(h, s, v) {
  const c = v * s;
  const hp = (h % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let rgb;
  if (hp < 1) rgb = [c, x, 0];
  else if (hp < 2) rgb = [x, c, 0];
  else if (hp < 3) rgb = [0, c, x];
  else if (hp < 4) rgb = [0, x, c];
  else if (hp < 5) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  const m = v - c;
  return rgb.map((u) => Math.round((u + m) * 255));
}

// ---------- WAV ----------

export function writeWavPcm16(file, samples, sampleRate = SAMPLE_RATE) {
  const n = samples.length;
  const dataBytes = n * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < n; i += 1) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  fs.writeFileSync(file, buf);
}

export function readWavPcm16(file) {
  const buf = fs.readFileSync(file);
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("not RIFF/WAVE: " + file);
  }
  let pos = 12;
  let fmt = null;
  let data = null;
  while (pos + 8 <= buf.length) {
    const id = buf.toString("ascii", pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === "fmt ") {
      fmt = {
        audioFormat: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bitsPerSample: buf.readUInt16LE(body + 14),
      };
    } else if (id === "data") {
      data = buf.subarray(body, Math.min(buf.length, body + size));
    }
    pos = body + size + (size % 2);
  }
  if (!fmt || !data) throw new Error("missing fmt/data: " + file);
  if (fmt.audioFormat !== 1 || fmt.bitsPerSample !== 16 || fmt.channels !== 1) {
    throw new Error("expected mono PCM16: " + JSON.stringify(fmt));
  }
  const count = Math.floor(data.length / 2);
  const out = new Float32Array(count);
  for (let i = 0; i < count; i += 1) out[i] = data.readInt16LE(i * 2) / 32768;
  return { sampleRate: fmt.sampleRate, samples: out };
}

// ---------- 合成環境聲（固定 seed） ----------

/**
 * 合成環境聲；回傳 Float32Array（sampleRate）。
 * kind: rain | knock | alarm | waves | birds | heartbeat | tone440
 */
export function synthEnv(kind, seconds, seed, sampleRate = SAMPLE_RATE) {
  const n = Math.max(0, Math.round(seconds * sampleRate));
  const out = new Float32Array(n);
  const rng = mulberry32(seed);
  if (kind === "rain") {
    let lp = 0;
    for (let i = 0; i < n; i += 1) {
      const t = i / sampleRate;
      const white = rng() * 2 - 1;
      lp += 0.35 * (white - lp);
      const env = 0.26 + 0.05 * Math.sin(2 * Math.PI * 0.7 * t) + 0.03 * Math.sin(2 * Math.PI * 2.3 * t + 1.2);
      out[i] = (lp * 0.55 + white * 0.22) * env;
    }
  } else if (kind === "knock") {
    const period = 1.0;
    for (let k = 0; k * period < seconds; k += 1) {
      for (const offset of [0.08, 0.28, 0.46]) {
        const start = Math.round((k * period + offset) * sampleRate);
        if (start >= n) continue;
        const length = Math.round(0.06 * sampleRate);
        for (let j = 0; j < length && start + j < n; j += 1) {
          const tt = j / sampleRate;
          const env = Math.exp(-tt * 60);
          const body = Math.sin(2 * Math.PI * 95 * tt) + 0.6 * Math.sin(2 * Math.PI * 210 * tt);
          const click = (rng() * 2 - 1) * Math.exp(-tt * 220) * 0.8;
          out[start + j] += (body * 0.55 + click) * env;
        }
      }
    }
  } else if (kind === "alarm") {
    const period = 0.4;
    for (let i = 0; i < n; i += 1) {
      const t = i / sampleRate;
      const phase = (t % period) / period;
      const on = phase < 0.5;
      const fade = Math.min(1, Math.min(phase, 0.5 - phase) * 40 + 0.2);
      const freq = Math.floor(t / period) % 2 === 0 ? 880 : 1320;
      out[i] = on ? 0.32 * fade * Math.sin(2 * Math.PI * freq * t) : 0;
    }
  } else if (kind === "waves") {
    let lp = 0;
    let lp2 = 0;
    for (let i = 0; i < n; i += 1) {
      const t = i / sampleRate;
      const white = rng() * 2 - 1;
      lp += 0.05 * (white - lp);
      lp2 += 0.02 * (lp - lp2);
      const env = 0.18 + 0.16 * (0.5 + 0.5 * Math.sin(2 * Math.PI * t / 4.5 - Math.PI / 2));
      out[i] = lp2 * 3.2 * env;
    }
  } else if (kind === "birds") {
    let t = 0.15;
    while (t < seconds) {
      const dur = 0.06 + rng() * 0.05;
      const start = Math.round(t * sampleRate);
      const length = Math.round(dur * sampleRate);
      const f0 = 2200 + rng() * 800;
      const f1 = f0 + 900 + rng() * 700;
      for (let j = 0; j < length && start + j < n; j += 1) {
        const p = j / length;
        const freq = f0 + (f1 - f0) * p;
        const env = Math.sin(Math.PI * p);
        out[start + j] += 0.22 * env * Math.sin(2 * Math.PI * freq * (j / sampleRate));
      }
      t += 0.18 + rng() * 0.5;
    }
  } else if (kind === "heartbeat") {
    for (let k = 0; k * 0.9 < seconds; k += 1) {
      for (const [offset, gain] of [[0.0, 0.6], [0.22, 0.4]]) {
        const start = Math.round((k * 0.9 + offset) * sampleRate);
        const length = Math.round(0.18 * sampleRate);
        for (let j = 0; j < length && start + j < n; j += 1) {
          const tt = j / sampleRate;
          const env = Math.exp(-tt * 28);
          out[start + j] += gain * env * Math.sin(2 * Math.PI * 58 * tt);
        }
      }
    }
  } else if (kind === "tone440") {
    for (let i = 0; i < n; i += 1) out[i] = 0.25 * Math.sin(2 * Math.PI * 440 * (i / sampleRate));
  } else {
    throw new Error("unknown env kind: " + kind);
  }
  return out;
}

/** 把 buffer 疊加（含 gain），超出範圍自動裁切。 */
export function mixInto(target, source, atSeconds, gain = 1, sampleRate = SAMPLE_RATE) {
  const offset = Math.round(atSeconds * sampleRate);
  for (let i = 0; i < source.length; i += 1) {
    const idx = offset + i;
    if (idx < 0 || idx >= target.length) continue;
    target[idx] += source[i] * gain;
  }
}

// ---------- ffmpeg / ffprobe 定位與執行 ----------

async function listFilesRecursive(dir) {
  const out = [];
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFilesRecursive(abs)));
    else out.push(abs);
  }
  return out;
}

let cachedTools = null;

/** 依 env → decoder manifest 目錄順序找 ffmpeg/ffprobe；找不到就具名失敗。 */
export async function resolveMediaTools() {
  if (cachedTools) return cachedTools;
  const candidatesFfmpeg = [];
  const candidatesFfprobe = [];
  if (process.env.MNEMOSHELF_FFMPEG) candidatesFfmpeg.push(process.env.MNEMOSHELF_FFMPEG);
  if (process.env.MNEMOSHELF_FFPROBE) candidatesFfprobe.push(process.env.MNEMOSHELF_FFPROBE);
  const files = await listFilesRecursive(DECODER_DIR);
  for (const f of files) {
    const lower = f.toLowerCase();
    if (lower.endsWith("ffmpeg.exe")) candidatesFfmpeg.push(f);
    if (lower.endsWith("ffprobe.exe")) candidatesFfprobe.push(f);
  }
  const ffmpeg = candidatesFfmpeg.find((f) => fs.existsSync(f));
  const ffprobe = candidatesFfprobe.find((f) => fs.existsSync(f));
  if (!ffmpeg || !ffprobe) {
    throw new Error(
      "找不到 decoder-a 候選 ffmpeg/ffprobe；請確認 .tmp/video-a/decoder/bin/ 或設定 MNEMOSHELF_FFMPEG/MNEMOSHELF_FFPROBE",
    );
  }
  cachedTools = { ffmpeg, ffprobe };
  return cachedTools;
}

/** 以無 shell 的參數陣列執行；回傳 { code, stdout, stderr }。 */
export function run(exe, args, { stdin = null, timeoutMs = 120000, cwd = CORPUS_ROOT } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { cwd, windowsHide: true, stdio: [stdin === "pipe" ? "pipe" : "ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill("SIGKILL");
        reject(new Error("timeout: " + exe + " " + args.join(" ")));
      }
    }, timeoutMs);
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
    });
    if (stdin === "pipe") {
      child.stdin.on("error", () => {});
      resolve.pipe = child.stdin;
    }
  });
}

/** 以無 shell 的參數陣列執行，回傳 stdout 的 binary Buffer（給 PCM／rawvideo 解碼用）。 */
export function runBuffer(exe, args, { timeoutMs = 120000, cwd = CORPUS_ROOT } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill("SIGKILL");
        reject(new Error("timeout: " + exe + " " + args.join(" ")));
      }
    }, timeoutMs);
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const out = Buffer.concat(stdout);
      if (code !== 0) reject(new Error("exit " + code + ": " + Buffer.concat(stderr).toString("utf8").slice(0, 2000)));
      else resolve(out);
    });
  });
}

/** 啟動一個把 rawvideo 從 stdin 送進去的 ffmpeg，回傳 { stdin, done }。 */
export async function startRawVideoEncoder(args) {
  const { ffmpeg } = await resolveMediaTools();
  const child = spawn(ffmpeg, args, { cwd: CORPUS_ROOT, windowsHide: true, stdio: ["pipe", "ignore", "pipe"] });
  const stderr = [];
  child.stderr.on("data", (chunk) => {
    if (Buffer.concat(stderr).length < 64 * 1024) stderr.push(chunk);
  });
  const done = new Promise((resolve) => {
    child.on("error", (error) => resolve({ code: -1, stderr: String(error) }));
    child.on("close", (code) => resolve({ code, stderr: Buffer.concat(stderr).toString("utf8") }));
  });
  async function writeFrame(frameBytes) {
    // 用 write callback 確保資料已交給 OS 才重用同一個 frame buffer。
    await new Promise((resolve, reject) => {
      child.stdin.write(frameBytes, (error) => (error ? reject(error) : resolve()));
    });
  }
  function endInput() {
    child.stdin.end();
  }
  return { child, done, writeFrame, endInput };
}

export async function probe(file) {
  const { ffprobe } = await resolveMediaTools();
  const { code, stdout, stderr } = await run(ffprobe, [
    "-v", "error", "-print_format", "json",
    "-show_format", "-show_streams", "-show_entries", "format=filename,duration,size,format_name,start_time:stream=index,codec_name,codec_type,codec_tag_string,width,height,r_frame_rate,avg_frame_rate,nb_frames,duration,start_time,time_base,sample_rate,channels,channel_layout,bit_rate,disposition:stream_disposition=default:stream_side_data=rotation",
    file,
  ], { timeoutMs: 60000 });
  if (code !== 0) return { ok: false, error: stderr.trim().slice(0, 2000) };
  try {
    return { ok: true, json: JSON.parse(stdout) };
  } catch (error) {
    return { ok: false, error: "ffprobe JSON parse failed: " + String(error) };
  }
}

export async function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = fs.createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

export async function writeJson(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(value, null, 2) + "\n", "utf8");
}

export async function readJson(file) {
  return JSON.parse(await fsp.readFile(file, "utf8"));
}

export function relFromCorpus(file) {
  return path.relative(CORPUS_ROOT, file).split(path.sep).join("/");
}

/** 品質影片的編碼參數（所有影片共用）。 */
export function videoEncodeArgs(outFile, { withFaststart = true } = {}) {
  const args = [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", WIDTH + "x" + HEIGHT, "-r", String(FPS), "-i", "pipe:0",
  ];
  return { args, outFile, withFaststart };
}

export const COLORS = {
  black: [0, 0, 0],
  white: [245, 245, 245],
  navy: [8, 16, 48],
  gray: [128, 128, 128],
  red: [230, 40, 40],
  darkRed: [150, 20, 20],
  green: [50, 200, 80],
  blue: [40, 90, 230],
  lightBlue: [80, 170, 240],
  cyan: [40, 220, 230],
  magenta: [230, 60, 200],
  orange: [255, 140, 20],
  yellow: [255, 220, 40],
  purple: [140, 60, 220],
  cream: [250, 235, 200],
};
