#!/usr/bin/env node
// 第一版：真 REST／模型的單 root 時間量測。其他效能項仍標為未量測。
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { finished } from "node:stream/promises";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { observeMediaProcesses } from "./process-observer.mjs";
import { cancellationAcknowledged, evaluateBound, fairnessObserved, samplerClosedCleanly } from "./performance-gates.mjs";
import { matchesRelevantHit, repeatedIntervals } from "./relevance.mjs";

if (process.env.VIDEO_PERF_RUN !== "1") throw new Error("設定 VIDEO_PERF_RUN=1 才能執行真模型");
const root = process.cwd();
const sourceId = process.env.VIDEO_PERF_SOURCE_ID;
const runId = process.env.VIDEO_PERF_RUN_ID ?? `run-${Date.now()}-${randomBytes(4).toString("hex")}`;
if (![sourceId, runId].every((id) => id && /^[a-zA-Z0-9_-]+$/.test(id))) throw new Error("必須指定有效 sourceId、runId");
const generated = path.join(root, ".tmp", "video-acceptance", "performance", sourceId);
const output = path.join(root, ".tmp", "video-acceptance", "runs", runId);
const manifest = JSON.parse(await readFile(path.join(generated, "manifest.json"), "utf8"));
const scenario = process.env.VIDEO_PERF_SCENARIO ?? "full";
if (!["smoke", "full"].includes(scenario)) throw new Error("scenario 無效");
const required = scenario === "smoke" ? ["1080p-60"] : ["1080p-60", "1080p-300", "1080p-600", "1080p-tail", "1080p-near-limit"];
if (manifest.status !== "complete" || required.some((name) => !manifest.cases.some((item) => item.name === name && item.ok)) || manifest.cases.some((item) => !item.ok)) throw new Error("素材 manifest 未通過");
async function hash(file) { const h = createHash("sha256"); for await (const part of createReadStream(file)) h.update(part); return h.digest("hex"); }
const audioRunId = process.env.VIDEO_AUDIO_FIXTURE_RUN_ID;
if (audioRunId && !/^[a-zA-Z0-9_-]+$/.test(audioRunId)) throw new Error("音訊 runId 無效");
const knockFixture = audioRunId ? path.join(root, ".tmp", "video-acceptance", "audio", audioRunId, "f04.wav") : path.join(root, ".tmp", "audio-indexing-acceptance", "fixtures", "f04.wav");
const audioFixtureSha256 = await hash(knockFixture);
if (audioFixtureSha256 !== "c0fdef41a0af25c5bc4a16472c9cda1028ee150049c8293b715ea8712e6a0904") throw new Error("WAV fixture hash 不符");
const frozen = path.join(root, "scripts", "video-acceptance", "queries-frozen-v1.json");
if (await hash(frozen) !== "846c102b582045a264388baed8ef458d5e7b1bb9278a368c73d2a564d2bece56") throw new Error("凍結標註 hash 不符");
const labels = JSON.parse(await readFile(frozen, "utf8"));
const query = labels.queries.find((item) => item.id === "V01").prompt;
for (const item of manifest.cases.filter((entry) => required.includes(entry.name))) if (await hash(path.join(generated, `${item.name}.mp4`)) !== item.sha256) throw new Error(`素材 hash 不符：${item.name}`);
await mkdir(path.dirname(output), { recursive: true }); await mkdir(output);
const report = { runId, sourceId, scenario, audioFixtureSha256, executionEnvironment: process.env.VIDEO_ACCEPTANCE_ENVIRONMENT === "normal-permissions" ? "normal-permissions" : "sandbox-or-unspecified", labelsSha256: await hash(frozen), sourceHashes: {}, status: "running", coldQueryMs: null, trials: [], missing: ["PID 歸屬 RSS 與 close 尚需 smoke 驗證", "ffprobe 與 AAC 獨立成本", "多 root 公平性對照與段界重啟成本分解"], caveats: ["素材由 640x360 升頻", "檔案原子發布", "本任務重負載串行，整機可能有其他使用者程式；RSS 只計本驗收 Node（含 worker）及本輪媒體子程序", "ffprobe/AAC wall time 為程序 spawn 至 close；Node arrayBuffers 是主執行緒值，估算 PCM 位元組不代表實際記憶體配置"] };
async function save() { await writeFile(path.join(output, "performance.json"), JSON.stringify(report, null, 2)); }
for (const parts of [["packages", "core", "src", "indexer", "video.ts"], ["packages", "core", "src", "indexer", "indexer.ts"], ["packages", "core", "src", "media", "types.ts"], ["packages", "core", "src", "media", "parse.ts"], ["packages", "core", "src", "media", "ffmpeg-decoder.ts"], ["packages", "core", "dist", "indexer", "video.js"], ["packages", "core", "dist", "indexer", "indexer.js"], ["packages", "core", "dist", "media", "types.js"], ["packages", "core", "dist", "media", "parse.js"], ["packages", "core", "dist", "media", "ffmpeg-decoder.js"], ["packages", "server", "dist", "index.js"], ["packages", "server", "dist", "search.js"], ["packages", "server", "dist", "embedder-worker.js"], ["packages", "server", "dist", "worker-embedder.js"], ["packages", "embedder-transformers", "dist", "index.js"], ["packages", "embedder-transformers", "dist", "embedder.js"], ["scripts", "video-acceptance", "run-performance.mjs"], ["scripts", "video-acceptance", "performance-gates.mjs"], ["scripts", "video-acceptance", "relevance.mjs"], ["scripts", "video-acceptance", "process-observer.mjs"], ["scripts", "video-acceptance", "rss-sampler.ps1"]]) report.sourceHashes[path.join(...parts)] = await hash(path.join(root, ...parts));
await save();
const modelBase = path.join(root, ".tmp", "media-feasibility", "models", "onnx-community", "embeddinggemma-2-ONNX", "onnx");
report.modelHashes = {};
for (const name of ["model_q4.onnx", "model_q4.onnx_data", "vision_encoder_q4.onnx", "vision_encoder_q4.onnx_data", "audio_encoder_q4.onnx", "audio_encoder_q4.onnx_data"]) report.modelHashes[name] = await hash(path.join(modelBase, name));
await save();
const binaries = path.join(root, ".tmp", "video-a", "decoder", "bin", "ffmpeg-n9.0.2-48-gd4070a14ce-win64-lgpl-9.0", "bin");
report.decoderHashes = { ffmpeg: await hash(process.env.MNEMOSHELF_FFMPEG ?? path.join(binaries, "ffmpeg.exe")), ffprobe: await hash(process.env.MNEMOSHELF_FFPROBE ?? path.join(binaries, "ffprobe.exe")) };
await save();
const sampleStream = createWriteStream(path.join(output, "rss-samples.ndjson"), { flags: "wx" });
let sampleWriteError = null;
sampleStream.on("error", () => { sampleWriteError = "sample-log-write-failed"; });
const observer = observeMediaProcesses({ onSample: (sample) => sampleStream.write(JSON.stringify(sample) + "\n") });
report.samplerReady = await observer.ready();
await save();
let createServer, FfmpegMediaDecoder;
try {
  ({ createServer } = await import("../../packages/server/dist/index.js"));
  ({ FfmpegMediaDecoder } = await import("../../packages/core/dist/index.js"));
} catch (error) { await observer.close(); sampleStream.end(); throw error; }
const token = randomBytes(24).toString("hex");
const decoder = new FfmpegMediaDecoder({ ffmpegPath: process.env.MNEMOSHELF_FFMPEG ?? path.join(binaries, "ffmpeg.exe"), ffprobePath: process.env.MNEMOSHELF_FFPROBE ?? path.join(binaries, "ffprobe.exe") });
let server;
function request(method, endpoint, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request(new URL(endpoint, server.url), { method, headers: { authorization: `Bearer ${token}`, ...(data ? { "content-type": "application/json", "content-length": data.length } : {}) } }, (res) => {
      const chunks = []; res.on("data", (c) => chunks.push(c)); res.on("end", () => {
        const text = Buffer.concat(chunks).toString();
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`${method} ${endpoint}: HTTP ${res.statusCode}`));
        try { resolve(text ? JSON.parse(text) : null); } catch (error) { reject(error); }
      });
    }); req.setTimeout(endpoint.endsWith("/index") ? 1800000 : 120000, () => req.destroy(new Error("HTTP timeout"))); req.on("error", reject); if (data) req.write(data); req.end();
  });
}
const ownedRoots = new Set();
function ownRoot(root) { ownedRoots.add(root.id); return root; }
async function removeOwnedRoot(rootId, expectedChunks, expectEmptyVectors = true) {
  if (!ownedRoots.has(rootId)) throw new Error("拒絕刪除非本次建立的 root");
  const removed = await request("DELETE", `/roots/${rootId}?deleteData=1`);
  if (removed.rootId !== rootId || removed.deletedData !== true || (expectedChunks !== null && removed.removedChunks !== expectedChunks)) throw new Error("root 移除結果不符");
  ownedRoots.delete(rootId);
  const remainingVectors = await server.vec.count();
  if (expectEmptyVectors && remainingVectors !== 0) throw new Error("單 root 清理後仍有向量");
  return { ...removed, remainingVectors };
}
function systemCpuTimes() {
  return os.cpus().reduce((sum, cpu) => { for (const [key, value] of Object.entries(cpu.times)) sum[key] = (sum[key] ?? 0) + value; return sum; }, {});
}
function p95(values) { return values.length ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1] : null; }
try {
  process.env.MNEMOSHELF_EMBED_DEVICE = "cpu";
  process.env.MNEMOSHELF_MODEL_DIR = path.join(root, ".tmp", "media-feasibility", "models");
  server = await createServer({ token, port: 0, dataDir: path.join(output, "data"), decoder, homeDir: os.homedir(), env: { MNEMOSHELF_MODEL_DIR: process.env.MNEMOSHELF_MODEL_DIR, MNEMOSHELF_EMBED_DEVICE: "cpu", MNEMOSHELF_MEMORY_BACKFILL: "off", MNEMOSHELF_AGENT_DISCOVERY: "off", MNEMOSHELF_INDEX_RATE: "off" } });
  let mediaCallsInFlight = 0;
  for (const name of ["embedAudio", "embedVideo"]) {
    const original = server.embedder[name]?.bind(server.embedder);
    if (original) server.embedder[name] = async (...args) => { mediaCallsInFlight++; try { return await original(...args); } finally { mediaCallsInFlight--; } };
  }
  const cold = performance.now(); await request("POST", "/search", { query, k: 10 }); report.coldQueryMs = performance.now() - cold;
  report.embedderRuntimeAfterColdQuery = (await request("GET", "/diagnostics")).embedderRuntime ?? null;
  await save();
  if (report.embedderRuntimeAfterColdQuery?.device !== "cpu" || report.embedderRuntimeAfterColdQuery?.loaded !== true) throw new Error("未確認真模型以 CPU 載入");
  const selected = manifest.cases.filter((item) => required.includes(item.name));
  const coldCase = selected.find((item) => item.name === "1080p-60");
  const schedule = [{ item: coldCase, iteration: 0, temperature: "cold-media" }, ...selected.flatMap((item) => Array.from({ length: scenario === "smoke" ? 1 : 3 }, (_, i) => ({ item, iteration: i + 1, temperature: "warm" })))];
  for (const { item, iteration, temperature } of schedule) {
    const trialDir = path.join(output, `root-${item.name}-${temperature}-${iteration}`); await mkdir(trialDir);
    const file = `${item.name}.mp4`; await copyFile(path.join(generated, file), path.join(trialDir, file));
    const added = ownRoot(await request("POST", "/roots", { path: trialDir, mode: "index", modalities: ["video", "audio"], videoMaxFileBytes: 512 * 1024 * 1024 }));
    report.current = { name: item.name, iteration, state: "indexing", elapsedMs: 0 };
    await save();
    console.log(`索引開始 ${item.name} 第 ${iteration} 次`);
    const systemCpuStart = systemCpuTimes();
    const start = performance.now(); const queries = []; let queryTicksSkipped = 0; let firstRelevantMs = null; let firstRelevantHit = null; let lastNegativeStartMs = 0; let active = true; let lastCheckpoint = 0; let wake = () => {};
    const index = request("POST", `/roots/${added.id}/index`);
    const polling = (async () => {
      while (active) {
        const before = performance.now();
        try {
          const result = await request("POST", "/search", { query, rootIds: [added.id], k: 10 });
          const end = performance.now(); queries.push(end - before);
          if (firstRelevantMs === null) {
            const hit = (result.hits ?? []).find((entry) => matchesRelevantHit(entry, file, repeatedIntervals(item.duration)));
            if (hit) { firstRelevantMs = end - start; firstRelevantHit = { rank: hit.rank, relPath: hit.relPath, seq: hit.seq, media: hit.media }; }
            else lastNegativeStartMs = before - start;
          }
        } catch { queries.push(null); }
        if (performance.now() - lastCheckpoint >= 15000) {
          lastCheckpoint = performance.now();
          report.current = { name: item.name, iteration, state: "indexing", elapsedMs: lastCheckpoint - start, querySamples: queries.length, queryLatenciesMs: [...queries] };
          report.observer = observer.snapshot({ includeSamples: false });
          report.sampleWriteError = sampleWriteError;
          await save();
        }
        const elapsed = performance.now() - before;
        queryTicksSkipped += Math.max(0, Math.ceil(elapsed / 2000) - 1);
        const delay = Math.max(0, Math.ceil(elapsed / 2000) * 2000 - elapsed);
        if (active) await new Promise((resolve) => { const timer = setTimeout(resolve, delay); wake = () => { clearTimeout(timer); resolve(); }; });
      }
    })();
    let indexed; let totalMs;
    try { indexed = await index; totalMs = performance.now() - start; } finally { active = false; wake(); await polling; }
    if (firstRelevantMs === null) {
      const result = await request("POST", "/search", { query, rootIds: [added.id], k: 10 });
      const hit = (result.hits ?? []).find((entry) => matchesRelevantHit(entry, file, repeatedIntervals(item.duration)));
      if (hit) { firstRelevantMs = performance.now() - start; firstRelevantHit = { rank: hit.rank, relPath: hit.relPath, seq: hit.seq, media: hit.media }; }
    }
    const chunks = await server.store.listChunksByPath(added.id, file);
    const videoChunks = chunks.filter((chunk) => chunk.media?.track === "video").length;
    const audioChunks = chunks.filter((chunk) => chunk.media?.track === "video-audio").length;
    const expectedVideo = Math.ceil(item.duration / 4);
    const expectedAudio = Math.ceil(item.duration / 10);
    const valid = indexed.processed === 1 && indexed.skippedUnchanged === 0 && indexed.skippedFiles?.length === 0 && indexed.failedFiles?.length === 0 && videoChunks === expectedVideo && audioChunks === expectedAudio && firstRelevantMs !== null;
    report.current = null;
    const embedderRuntime = (await request("GET", "/diagnostics")).embedderRuntime ?? null;
    if (embedderRuntime?.device !== "cpu" || embedderRuntime?.loaded !== true) throw new Error("索引後未確認真模型使用 CPU");
    const observed = observer.snapshot();
    report.observer = observer.snapshot({ includeSamples: false });
    const mediaEvents = observed.events.filter((event) => event.spawnMs >= start && event.spawnMs <= start + totalMs);
    const phaseDurations = Object.fromEntries(["show-frames", "streams", "visual", "audio"].map((phase) => [phase, mediaEvents.filter((event) => event.phase === phase && event.closeMs !== null).map((event) => event.closeMs - event.spawnMs)]));
    const sampled = observed.samples.filter((sample) => sample.atMs >= start && sample.atMs <= start + totalMs && sample.complete);
    const sampledPids = new Set(sampled.flatMap((sample) => sample.pids));
    const unsampledMediaPids = mediaEvents.filter((event) => event.pid !== null && !sampledPids.has(event.pid)).map((event) => event.pid);
    const sampledPhases = [...new Set(mediaEvents.filter((event) => sampledPids.has(event.pid)).map((event) => event.phase))];
    const sampledPeakRss = sampled.length ? Math.max(...sampled.map((sample) => sample.totalRss)) : null;
    const sampledPeakArrayBuffers = sampled.length ? Math.max(...sampled.map((sample) => sample.nodeArrayBuffers)) : null;
    report.trials.push({ embedderRuntime, systemCpuStart, systemCpuEnd: systemCpuTimes(), phaseDurations, sampledPhases, unsampledMediaPids, ffmpegSpawns: mediaEvents.filter((event) => event.kind === "ffmpeg").length, sampledPeakRss, sampledPeakArrayBuffers, estimatedPcmBytes: Math.ceil(item.duration * 16000) * 4, name: item.name, iteration, temperature, startMonotonicMs: start, endMonotonicMs: start + totalMs, totalMs, firstRelevantMs, firstRelevantHit, firstRelevantObservation: firstRelevantMs === null ? null : { afterMs: lastNegativeStartMs, byMs: firstRelevantMs }, videoChunks, audioChunks, expectedVideo, expectedAudio, valid, queryP95Ms: p95(queries.filter((x) => x !== null)), querySamples: queries.length, queryLatenciesMs: [...queries], queryIntervalMs: 2000, queryTicksSkipped, queryErrors: queries.filter((x) => x === null).length, indexed }); await save();
    if (!valid) throw new Error(`索引或相關命中驗證失敗：${item.name}`);
    report.trials.at(-1).cleanup = await removeOwnedRoot(added.id, chunks.length);
    await save();
  }
  // 等待本 decoder 真有程序佔用後才取消；無法觀測到時回 null，不能當成零。
  const item = manifest.cases.find((candidate) => candidate.name === "1080p-60");
  const cancelDir = path.join(output, "root-cancellation"); await mkdir(cancelDir);
  await copyFile(path.join(generated, `${item.name}.mp4`), path.join(cancelDir, `${item.name}.mp4`));
  const cancelRoot = ownRoot(await request("POST", "/roots", { path: cancelDir, mode: "index", modalities: ["video", "audio"], videoMaxFileBytes: 512 * 1024 * 1024 }));
  let finished = false;
  const cancelIndex = request("POST", `/roots/${cancelRoot.id}/index`).finally(() => { finished = true; });
  const deadline = performance.now() + 120000;
  while (!finished && decoder.budgetStats().active === 0 && performance.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  if (!finished && decoder.budgetStats().active > 0) {
    const t0 = performance.now();
    const atCancel = observer.snapshot().events;
    const livePidsAtCancel = atCancel.filter((event) => event.kind === "ffmpeg" && event.spawnMs !== null && event.spawnMs <= t0 && (event.closeMs === null || event.closeMs > t0)).map((event) => event.pid);
    let budgetClosedMs = null;
    const watchBudget = (async () => {
      while (decoder.budgetStats().active > 0) await new Promise((resolve) => setTimeout(resolve, 20));
      budgetClosedMs = performance.now() - t0;
    })();
    const response = await request("POST", `/roots/${cancelRoot.id}/index/cancel`);
    const cancelResponseMs = performance.now() - t0;
    const drainStart = performance.now();
    if (typeof server.embedder.drain !== "function") throw new Error("worker 不提供 drain");
    await server.embedder.drain();
    const nativeDrainFromRequestMs = performance.now() - t0;
    const drainCallMs = performance.now() - drainStart;
    const indexResult = await cancelIndex;
    const indexSettleMs = performance.now() - t0;
    await watchBudget;
    report.observer = observer.snapshot({ includeSamples: false });
    const closeObservations = livePidsAtCancel.map((pid) => { const event = report.observer.events.find((entry) => entry.pid === pid); return { pid, closeAfterRequestMs: event?.closeMs == null ? null : event.closeMs - t0 }; });
    report.cancellation = { rootId: cancelRoot.id, requestMonotonicMs: t0, livePidsAtCancel, closeObservations, response, cancelResponseMs, budgetClosedMs, nativeDrainFromRequestMs, drainCallMs, indexSettleMs, indexResult, note: "budget 只在 decoder FFmpeg 關閉後釋放；20ms 輪詢，不是個別 PID close 時戳，且不含 ffprobe。drain 從取消回應後呼叫。" };
  } else {
    if (!finished) await request("POST", `/roots/${cancelRoot.id}/index/cancel`);
    await cancelIndex;
    report.cancellation = { error: "未觀測到執行中的 FFmpeg；未測指定條件取消" };
  }
  await save();
  report.cancellation.cleanup = await removeOwnedRoot(cancelRoot.id, null);
  await save();
  // 第二案例等待媒體嵌入已排入且 worker active；不併發查詢，以免把文字推論誤當媒體。
  const nativeDir = path.join(output, "root-cancel-native"); await mkdir(nativeDir);
  await copyFile(path.join(generated, `${item.name}.mp4`), path.join(nativeDir, `${item.name}.mp4`));
  const nativeRoot = ownRoot(await request("POST", "/roots", { path: nativeDir, mode: "index", modalities: ["video", "audio"], videoMaxFileBytes: 512 * 1024 * 1024 }));
  let nativeFinished = false;
  const nativeIndex = request("POST", `/roots/${nativeRoot.id}/index`).finally(() => { nativeFinished = true; });
  const nativeDeadline = performance.now() + 120000;
  while (!nativeFinished && !(mediaCallsInFlight > 0 && server.embedder.schedulingStatus?.active > 0) && performance.now() < nativeDeadline) await new Promise((resolve) => setTimeout(resolve, 10));
  if (!nativeFinished && mediaCallsInFlight > 0 && server.embedder.schedulingStatus?.active > 0) {
    const t0 = performance.now();
    const response = await request("POST", `/roots/${nativeRoot.id}/index/cancel`);
    const cancelResponseMs = performance.now() - t0;
    const drainStart = performance.now(); await server.embedder.drain();
    const drainCallMs = performance.now() - drainStart;
    const drainSettleMs = performance.now() - t0;
    const indexResult = await nativeIndex;
    const indexSettleMs = performance.now() - t0;
    report.nativeCancellation = { rootId: nativeRoot.id, requestMonotonicMs: t0, response, cancelResponseMs, drainCallMs, drainSettleMs, indexSettleMs, indexResult, note: "確認媒體呼叫在途且 scheduler active；drain 在 cancel 回應後呼叫，是等待安全邊界的上界，不是 native Run 本身時長。" };
  } else {
    if (!nativeFinished) await request("POST", `/roots/${nativeRoot.id}/index/cancel`);
    await nativeIndex;
    report.nativeCancellation = { error: "未觀測到媒體推論在途，未測指定條件取消" };
  }
  await save();
  report.nativeCancellation.cleanup = await removeOwnedRoot(nativeRoot.id, null);
  await save();
  if (scenario === "full") {
    const fairnessDir = path.join(output, "fairness"); await mkdir(fairnessDir);
    const definitions = [
      { kind: "long-video", file: "long.mp4", source: path.join(generated, "1080p-600.mp4"), modalities: ["video", "audio"] },
      { kind: "short-video", file: "short.mp4", source: path.join(generated, "1080p-60.mp4"), modalities: ["video", "audio"] },
      { kind: "wav", file: "knock.wav", source: knockFixture, modalities: ["audio"] },
      { kind: "text", file: "notes.txt", source: null, modalities: ["text"] },
    ];
    for (const d of definitions) {
      d.dir = path.join(fairnessDir, d.kind); await mkdir(d.dir);
      if (d.source) await copyFile(d.source, path.join(d.dir, d.file));
      else await writeFile(path.join(d.dir, d.file), "Synthetic text about semantic search and indexing.");
      d.root = ownRoot(await request("POST", "/roots", { path: d.dir, mode: "index", modalities: d.modalities, videoMaxFileBytes: 512 * 1024 * 1024 }));
    }
    const standaloneBaselines = [];
    for (const d of definitions.filter((entry) => entry.kind === "wav" || entry.kind === "text")) {
      const baselineDir = path.join(fairnessDir, `baseline-${d.kind}`); await mkdir(baselineDir);
      await copyFile(path.join(d.dir, d.file), path.join(baselineDir, d.file));
      const baselineRoot = ownRoot(await request("POST", "/roots", { path: baselineDir, mode: "index", modalities: d.modalities, videoMaxFileBytes: 512 * 1024 * 1024 }));
      const begin = performance.now(); const result = await request("POST", `/roots/${baselineRoot.id}/index`);
      const elapsedMs = performance.now() - begin;
      const chunks = (await server.store.listChunksByPath(baselineRoot.id, d.file)).length;
      standaloneBaselines.push({ kind: d.kind, elapsedMs, result, chunks, valid: result.processed === 1 && result.skippedUnchanged === 0 && result.skippedFiles?.length === 0 && result.failedFiles?.length === 0 && chunks > 0 });
      report.standaloneBaselines = [...standaloneBaselines]; await save();
      if (!standaloneBaselines.at(-1).valid) throw new Error(`單 root 基線失敗：${d.kind}`);
      standaloneBaselines.at(-1).cleanup = await removeOwnedRoot(baselineRoot.id, chunks);
      await save();
    }
    const budgetBefore = decoder.budgetStats();
    const started = performance.now();
    const runRoot = async (d) => {
      const begin = performance.now(); const result = await request("POST", `/roots/${d.root.id}/index`);
      return { kind: d.kind, startMs: begin - started, finishedMs: performance.now() - started, result, chunks: (await server.store.listChunksByPath(d.root.id, d.file)).length };
    };
    let longActive = true;
    const long = runRoot(definitions[0]).finally(() => { longActive = false; });
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const others = definitions.slice(1).map(runRoot);
    const querySamples = []; let fairnessTicksSkipped = 0; let lastFairnessCheckpoint = 0; let wakeFairness = () => {};
    const queryLoop = (async () => {
      while (longActive) {
        const begin = performance.now();
        try { await request("POST", "/search", { query: "Synthetic text about semantic search and indexing", k: 10 }); querySamples.push({ startMs: begin - started, durationMs: performance.now() - begin, ok: true }); }
        catch { querySamples.push({ startMs: begin - started, durationMs: performance.now() - begin, ok: false }); }
        if (performance.now() - lastFairnessCheckpoint >= 15000) {
          lastFairnessCheckpoint = performance.now();
          report.current = { state: "fairness", elapsedMs: lastFairnessCheckpoint - started, querySamples: [...querySamples] };
          report.observer = observer.snapshot({ includeSamples: false }); report.sampleWriteError = sampleWriteError; await save();
        }
        const elapsed = performance.now() - begin;
        fairnessTicksSkipped += Math.max(0, Math.ceil(elapsed / 2000) - 1);
        const delay = Math.max(0, Math.ceil(elapsed / 2000) * 2000 - elapsed);
        if (longActive) await new Promise((resolve) => { const timer = setTimeout(resolve, delay); wakeFairness = () => { clearTimeout(timer); resolve(); }; });
      }
    })();
    report.current = { state: "fairness", startedAt: new Date().toISOString() }; await save();
    let results;
    try { results = await Promise.all([long, ...others]); } finally { longActive = false; wakeFairness(); await queryLoop; }
    const longFinished = results[0].finishedMs;
    const budgetAfter = decoder.budgetStats();
    report.observer = observer.snapshot({ includeSamples: false });
    const events = report.observer.events.filter((event) => event.spawnMs >= started && event.spawnMs <= started + Math.max(...results.map((entry) => entry.finishedMs)));
    const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? null;
    const baselines = { "long-video": median(report.trials.filter((entry) => entry.name === "1080p-600" && entry.temperature === "warm").map((entry) => entry.totalMs)), "short-video": median(report.trials.filter((entry) => entry.name === "1080p-60" && entry.temperature === "warm").map((entry) => entry.totalMs)), wav: standaloneBaselines.find((entry) => entry.kind === "wav")?.elapsedMs ?? null, text: standaloneBaselines.find((entry) => entry.kind === "text")?.elapsedMs ?? null };
    const baselineSpawns = median(report.trials.filter((entry) => entry.name === "1080p-600" && entry.temperature === "warm").map((entry) => entry.ffmpegSpawns)) + median(report.trials.filter((entry) => entry.name === "1080p-60" && entry.temperature === "warm").map((entry) => entry.ffmpegSpawns));
    const fairnessUnsampledPids = events.filter((event) => event.pid !== null && report.observer.unsampledPids.includes(event.pid)).map((event) => event.pid);
    report.fairness = { startMonotonicMs: started, standaloneBaselines, baselines, baselineVideoFfmpegSpawns: baselineSpawns, unsampledPids: fairnessUnsampledPids, mediaPidCount: events.filter((event) => event.pid !== null).length, results: results.map((entry) => ({ ...entry, durationMs: entry.finishedMs - entry.startMs, changeFromBaselineMs: baselines[entry.kind] === null ? null : entry.finishedMs - entry.startMs - baselines[entry.kind], finishedBeforeLong: entry.kind === "long-video" ? null : entry.finishedMs < longFinished, valid: entry.result.processed === 1 && entry.result.skippedUnchanged === 0 && entry.result.skippedFiles?.length === 0 && entry.result.failedFiles?.length === 0 && entry.chunks > 0 })), budgetBefore, budgetAfter, preemptions: budgetAfter.preemptions - budgetBefore.preemptions, ffmpegSpawns: events.filter((event) => event.kind === "ffmpeg").length, querySamples, queryP95Ms: p95(querySamples.filter((sample) => sample.ok).map((sample) => sample.durationMs)), queryIntervalMs: 2000, queryTicksSkipped: fairnessTicksSkipped, note: "長片先啟動一秒；未先完成不等於證明完全無進度。與各單 root 基線的差異包含查詢及全部競爭，不能歸因為純重啟成本；程序 spawn 數與 preemption 供對照，不設未核定門檻。" };
    report.current = null; await save();
    report.fairness.cleanup = [];
    for (const d of definitions) report.fairness.cleanup.push(await removeOwnedRoot(d.root.id, null, false));
    if (await server.vec.count() !== 0 || ownedRoots.size !== 0) throw new Error("公平性測試後索引未清空");
    await save();
  }
  if (scenario === "full") {
    const warm = report.trials.filter((trial) => trial.temperature === "warm");
    const sixty = warm.filter((trial) => trial.name === "1080p-60");
    const longest = warm.filter((trial) => trial.name === "1080p-600");
    const nearLimit = warm.filter((trial) => trial.name === "1080p-near-limit");
    const missing = [];
    if (warm.length !== 15 || warm.some((trial) => !trial.valid || !trial.querySamples || trial.queryP95Ms === null || trial.queryErrors)) missing.push("暖跑、片段或查詢樣本不足");
    if (report.trials.some((trial) => trial.sampledPeakRss === null || !trial.phaseDurations["show-frames"].length || !trial.phaseDurations.audio.length || !trial.sampledPhases.includes("show-frames") || !trial.sampledPhases.includes("audio") || trial.unsampledMediaPids.length > 0)) missing.push("RSS 或 frame probe／AAC 程序觀測不足（含未採樣 PID）");
    const measuredUnsampled = report.observer.events.filter((event) => event.phase !== "other" && event.pid !== null && report.observer.unsampledPids.includes(event.pid));
    if (measuredUnsampled.length) missing.push("測試中有媒體 PID 未採到 RSS");
    if (!report.samplerReady || report.observer.samplerError || sampleWriteError) missing.push("RSS sampler 或原始樣本紀錄異常");
    if (!cancellationAcknowledged(report.cancellation) || !report.cancellation?.livePidsAtCancel?.length || report.cancellation.closeObservations.some((item) => item.closeAfterRequestMs === null)) missing.push("FFmpeg 取消時 PID close 未觀測");
    if (!cancellationAcknowledged(report.nativeCancellation) || report.nativeCancellation?.drainSettleMs == null) missing.push("媒體推論取消與 drain 未觀測");
    if (!report.fairness?.querySamples?.some((sample) => sample.ok) || report.fairness.queryP95Ms === null || report.fairness.querySamples.some((sample) => !sample.ok) || !fairnessObserved(report.fairness.results) || report.fairness.standaloneBaselines.some((entry) => !entry.valid) || Object.values(report.fairness.baselines).some((value) => value === null)) missing.push("多 root／查詢公平性資料不足");
    report.missing = missing;
    report.acceptance = { firstRelevant60: evaluateBound(sixty, 60000), firstRelevant600: evaluateBound(longest, 600000), firstRelevantNearLimit: evaluateBound(nearLimit, 600000), measurementsComplete: missing.length === 0,
      rssScope: "本驗收 Node（含 worker threads）與本輪 ffmpeg／ffprobe 的工作集，同時點近似採樣，峰值僅為下界；每輪主要 phase 與每個測試期間 PID 均須有完整樣本，未採樣 PID 不得算完整。啟動 -version 檢查列其他程序，不納入索引階段 gate。",
      note: "相關命中以輪詢上下界判定；區間跨過門檻時為 inconclusive。RSS unsampledPids、各 PID、取樣往返延遲及公平性覆蓋率另記；不對查詢 P95／RSS 新增硬門檻。" };
    report.status = missing.length ? "partial" : Object.values({ a: report.acceptance.firstRelevant60, b: report.acceptance.firstRelevant600, c: report.acceptance.firstRelevantNearLimit }).every((value) => value === "pass") ? "pass" : "not-passed";
    if (report.status !== "pass") process.exitCode = 1;
  } else report.status = "partial";
} catch (error) { report.status = "error"; report.error = String(error); process.exitCode = 1; }
finally {
  try { if (server) await server.close(); } catch (error) { report.closeError = error?.name ?? "Error"; report.status = "error"; process.exitCode = 1; }
  await observer.close();
  report.observer = observer.snapshot({ includeSamples: false });
  sampleStream.end();
  try { await finished(sampleStream); } catch { sampleWriteError = "sample-log-write-failed"; }
  report.sampleWriteError = sampleWriteError;
  if (!samplerClosedCleanly(report.observer, sampleWriteError)) {
    report.missing = [...new Set([...report.missing, "sampler 關閉後錯誤、待回應取樣或原始樣本寫入失敗"])];
    if (report.acceptance) report.acceptance.measurementsComplete = false;
    if (report.status !== "error") report.status = "partial";
    process.exitCode = 1;
  }
  await save();
}
console.log(JSON.stringify({ runId, status: report.status, trials: report.trials.length, missing: report.missing }));
