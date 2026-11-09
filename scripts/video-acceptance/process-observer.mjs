import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { createInterface } from "node:readline";
import { performance } from "node:perf_hooks";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 安裝後再 dynamic import 產品，使 decoder 的 named spawn 取得同一個包裝。
export function observeMediaProcesses({ onSample, calibrateOwnProcess = false } = {}) {
  const originalSpawn = childProcess.spawn;
  const events = [];
  const live = new Map();
  const samples = [];
  const completePids = new Set();
  let sampledPeakRss = null;
  const pending = new Map();
  let counter = 0;
  let sampler = null;
  let closing = false;
  let priorityPending = false;
  let lastSamplerCpuMs = null;
  let resolveReady;
  const ready = new Promise((resolve) => { resolveReady = resolve; });
  let samplerFailure = null;
  let samplerError = process.platform !== "win32" ? "unsupported-platform" : null;
  if (process.platform === "win32") {
    const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "rss-sampler.ps1");
    sampler = originalSpawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-File", script], { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
    sampler.on("error", () => { samplerError = "sampler-start-failed"; });
    sampler.on("exit", () => { if (!closing && !samplerError) samplerError = "sampler-exited"; });
    createInterface({ input: sampler.stdout }).on("line", (line) => {
      try {
        const value = JSON.parse(line); if (value.error || value.cpuMs < 0) { samplerError = "sample-failed"; samplerFailure = { type: value.errorType ?? null, line: value.errorLine ?? null }; resolveReady(false); return; } const request = pending.get(value.id); pending.delete(value.id);
        if (!request) return;
        lastSamplerCpuMs = value.cpuMs;
        const observed = new Map(value.items.map((item) => [item.pid, item.rss]));
        const complete = request.pids.every((pid) => observed.has(pid));
        if (request.warmup) { resolveReady(complete); if (priorityPending) { priorityPending = false; requestSample(true); } return; }
        const ffmpegRss = request.pids.filter((pid) => request.kinds[pid] === "ffmpeg").reduce((sum, pid) => sum + (observed.get(pid) ?? 0), 0);
        const ffprobeRss = request.pids.filter((pid) => request.kinds[pid] === "ffprobe").reduce((sum, pid) => sum + (observed.get(pid) ?? 0), 0);
        const sample = { atMs: request.atMs, samplerCpuMs: value.cpuMs ?? null, roundTripMs: performance.now() - request.atMs, nodeRss: request.nodeRss, nodeExternal: request.nodeExternal, nodeArrayBuffers: request.nodeArrayBuffers, ffmpegRss, ffprobeRss, totalRss: request.nodeRss + ffmpegRss + ffprobeRss, complete, pids: request.pids, observedRss: value.items };
        samples.push(sample);
        if (complete) { for (const pid of sample.pids) completePids.add(pid); sampledPeakRss = Math.max(sampledPeakRss ?? 0, sample.totalRss); }
        onSample?.(sample);
        if (priorityPending) { priorityPending = false; requestSample(true); }
      } catch (error) { samplerError = "sample-invalid"; samplerFailure = { type: error?.name ?? "Error", line: null }; }
    });
  }
  childProcess.spawn = function (command, args, options) {
    const child = originalSpawn.call(this, command, args, options);
    const name = path.basename(String(command)).toLowerCase().replace(/\.exe$/, "");
    if (name !== "ffmpeg" && name !== "ffprobe") return child;
    const argv = Array.isArray(args) ? args : [];
    const phase = argv.includes("-show_frames") ? "show-frames" : argv.includes("-show_streams") ? "streams" : argv.includes("rawvideo") ? "visual" : argv.includes("f32le") ? "audio" : "other";
    const record = { kind: name, phase, pid: null, spawnMs: null, exitMs: null, closeMs: null };
    events.push(record);
    child.once("spawn", () => { record.pid = child.pid; record.spawnMs = performance.now(); live.set(child.pid, name); requestSample(true); });
    child.once("exit", (code, signal) => { record.exitMs = performance.now(); record.code = code; record.signal = signal; });
    child.once("close", () => { record.closeMs = performance.now(); live.delete(record.pid); });
    return child;
  };
  syncBuiltinESMExports();
  function requestSample(priority = false, warmup = false) {
    if (!sampler || samplerError || !sampler.stdin.writable) return;
    if (pending.size > 0) { if (priority) priorityPending = true; return; }
    const id = ++counter; const pids = warmup ? [process.pid] : [...live.keys(), ...(calibrateOwnProcess ? [process.pid] : [])]; const kinds = Object.fromEntries(live);
    const memory = process.memoryUsage();
    if (!warmup && pids.length === 0) {
      const sample = { atMs: performance.now(), samplerCpuMs: lastSamplerCpuMs, roundTripMs: 0, nodeRss: memory.rss, nodeExternal: memory.external, nodeArrayBuffers: memory.arrayBuffers, ffmpegRss: 0, ffprobeRss: 0, totalRss: memory.rss, complete: true, pids: [], observedRss: [] };
      samples.push(sample); sampledPeakRss = Math.max(sampledPeakRss ?? 0, sample.totalRss); onSample?.(sample); return;
    }
    pending.set(id, { atMs: performance.now(), nodeRss: memory.rss, nodeExternal: memory.external, nodeArrayBuffers: memory.arrayBuffers, pids, kinds, warmup });
    sampler.stdin.write([id, ...pids].join(",") + "\n");
  }
  const timer = setInterval(() => requestSample(), 100);
  requestSample(true, true);
  return {
    ready: () => process.platform === "win32" ? Promise.race([ready, new Promise((resolve) => { const timer = setTimeout(() => resolve(false), 5000); timer.unref(); })]) : Promise.resolve(false),
    snapshot: ({ includeSamples = true } = {}) => {
      const unsampledPids = events.filter((event) => event.pid && !completePids.has(event.pid)).map((event) => event.pid);
      return { events: events.map((event) => ({ ...event })), ...(includeSamples ? { samples: [...samples] } : {}), sampleCount: samples.length, samplerError, samplerFailure, pendingSamples: pending.size, intervalMs: 100, sampleOnSpawn: true, unsampledPids,
        sampledPeakRss,
        note: "Node RSS 含 worker threads；各媒體程序工作集是依 PID 序列採樣，roundTripMs 為往返時間，採樣峰值僅為下界。未採到的程序列於 unsampledPids。" };
    },
    close: async () => {
      closing = true; clearInterval(timer); childProcess.spawn = originalSpawn; syncBuiltinESMExports();
      if (sampler && sampler.stdin.writable) sampler.stdin.end();
      if (sampler && sampler.exitCode === null && sampler.signalCode === null) await new Promise((resolve) => {
        const timeout = setTimeout(() => { samplerError = "sampler-close-timeout"; sampler.kill(); resolve(); }, 5000);
        sampler.once("close", () => { clearTimeout(timeout); resolve(); });
      });
    },
  };
}
