/** 真 REST → WorkerEmbedder → 離線真模型 → SQLite／向量庫 → search；每次由全新行程執行。 */
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { promisify } from "node:util";
import path from "node:path";
import http from "node:http";
import os from "node:os";

assert.equal(process.env.WEBGPU_INTEGRATION_RUN, "1", "設定 WEBGPU_INTEGRATION_RUN=1 才能執行真模型");
const repo = process.cwd();
const base = path.join(repo, ".tmp", "webgpu-integration");
const device = process.env.WEBGPU_CASE_DEVICE;
const scenario = process.env.WEBGPU_CASE_SCENARIO ?? "standard";
const runId = process.env.WEBGPU_CASE_ID;
assert(["cpu", "webgpu"].includes(device));
assert(["standard", "budget"].includes(scenario));
assert(runId && /^[a-zA-Z0-9_-]+$/.test(runId), "必須指定安全的 case id");
const output = path.join(base, "runs", runId);
await mkdir(path.dirname(output), { recursive: true });
await mkdir(output); // 已有產物時拒絕覆蓋。
const report = { version: 1, device, scenario, runId, startedAt: new Date().toISOString(), runtime: { node: process.versions.node, electron: process.versions.electron ?? null, platform: process.platform, arch: process.arch }, checks: {}, stages: {}, snapshots: [], workerCalls: {}, workerErrors: [], modelFiles: [], sourceHashes: {}, resources: { samples: [], media: [] }, passed: false };
const save = () => writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
function check(name, value, details) { report.checks[name] = { passed: Boolean(value), details }; assert(value, name); }
async function hash(file) { const value = createHash("sha256"); for await (const chunk of createReadStream(file)) value.update(chunk); return value.digest("hex"); }
const manifest = JSON.parse(await readFile(path.join(base, "fixtures.json"), "utf8"));
const decoderPaths = JSON.parse(await readFile(path.join(base, "decoder-local.json"), "utf8"));
const models = JSON.parse(await readFile(path.join(base, "verified-models.json"), "utf8"));
for (const model of models) { assert.equal(await hash(path.join(base, "cache", ...model.parts)), model.sha256, "模型資產指紋不符"); report.modelFiles.push(model); }
for (const parts of [["packages", "server", "dist", "index.js"], ["packages", "server", "dist", "worker-embedder.js"], ["packages", "server", "dist", "embedder-worker.js"], ["packages", "embedder-transformers", "dist", "embedder.js"], ["packages", "core", "dist", "indexer", "indexer.js"], ["scripts", "webgpu-integration", "case.mjs"], ["scripts", "webgpu-integration", "offline-worker.mjs"]]) report.sourceHashes[parts.join(":")] = await hash(path.join(repo, ...parts));

// 在 import 產品前追蹤本輪 decoder 程序；不含其他應用程式。worker threads 已計入主行程 RSS。
const originalSpawn = childProcess.spawn;
const media = new Map();
childProcess.spawn = function(command, args, options) {
  const child = originalSpawn.call(this, command, args, options);
  const name = path.basename(String(command)).toLowerCase().replace(/\.exe$/, "");
  if (["ffmpeg", "ffprobe"].includes(name)) {
    const event = { kind: name, pid: null, startedMs: performance.now(), closedMs: null, code: null };
    report.resources.media.push(event);
    child.once("spawn", () => { event.pid = child.pid; media.set(child.pid, event); });
    child.once("close", (code) => { event.closedMs = performance.now(); event.code = code; media.delete(child.pid); });
  }
  return child;
};
syncBuiltinESMExports();
const execFile = promisify(childProcess.execFile);
let sampling = false;
async function sample(label) {
  if (sampling) return;
  sampling = true;
  try {
    const pids = [...media.keys()];
    const children = [];
    for (const pid of pids) {
      try { const result = await execFile("ps", ["-o", "rss=", "-p", String(pid)], { timeout: 2000 }); const rss = Number(result.stdout.trim()) * 1024; children.push({ pid, rssBytes: Number.isFinite(rss) && rss > 0 ? rss : null }); }
      catch { children.push({ pid, rssBytes: null }); }
    }
    report.resources.samples.push({ label, atMs: performance.now(), mainRssBytes: process.memoryUsage().rss, children });
  } finally { sampling = false; }
}
const samplingTimer = setInterval(() => { void sample("interval"); }, 500);
const { createServer } = await import("../../packages/server/dist/index.js");
const { WorkerEmbedder } = await import("../../packages/server/dist/worker-embedder.js");
const { openDatabase, FfmpegMediaDecoder } = await import("../../packages/core/dist/index.js");
const token = randomBytes(24).toString("hex");
let server;
let workerStarts = 0;
let cancelOnWindow = null;
let queryOnWindow = null;
let maxWorkerInFlight = 0;
const inFlight = new Set();
const embedder = new WorkerEmbedder({
  embedderOptions: { device, dtype: "q4", dim: 512, cacheDir: path.join(base, "cache") },
  createWorker: () => {
    workerStarts++;
    const worker = new Worker(new URL("./offline-worker.mjs", import.meta.url), { execArgv: [] });
    worker.on("message", (message) => {
      if (message.type === "response") {
        inFlight.delete(message.id);
        if (!message.ok) report.workerErrors.push({ name: message.error?.name, code: message.error?.code });
      }
    });
    const post = worker.postMessage.bind(worker);
    worker.postMessage = (message, transfer) => {
      if (message.type === "request" && message.method !== "dispose") {
        report.workerCalls[message.method] = (report.workerCalls[message.method] ?? 0) + 1;
        inFlight.add(message.id); maxWorkerInFlight = Math.max(maxWorkerInFlight, inFlight.size);
      }
      post(message, transfer);
      if (message.type === "request" && message.method === "embedDocuments") {
        if (cancelOnWindow) { const callback = cancelOnWindow; cancelOnWindow = null; setTimeout(callback, 50); }
        if (queryOnWindow) { const callback = queryOnWindow; queryOnWindow = null; setTimeout(callback, 0); }
      }
    };
    return worker;
  },
});
async function request(method, endpoint, body) {
  return new Promise((resolve, reject) => {
    const bytes = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request(new URL(endpoint, server.url), { method, headers: { authorization: `Bearer ${token}`, ...(bytes ? { "content-type": "application/json", "content-length": bytes.length } : {}) } }, (res) => {
      const chunks = []; res.on("data", (chunk) => chunks.push(chunk)); res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`HTTP ${res.statusCode}: ${method} ${endpoint}`));
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch (error) { reject(error); }
      });
    });
    req.setTimeout(600000, () => req.destroy(new Error("驗收 HTTP deadline"))); req.once("error", reject);
    if (bytes) req.write(bytes); req.end();
  });
}
async function timed(name, action) {
  const before = performance.now(); const usage = process.cpuUsage(); await sample(`${name}-before`);
  try { return await action(); }
  finally { report.stages[name] = { wallMs: performance.now() - before, processCpuMicros: process.cpuUsage(usage) }; await sample(`${name}-after`); await save(); }
}
async function snapshot(name) { const diagnostic = await request("GET", "/diagnostics"); report.snapshots.push({ name, diagnostic }); await save(); return diagnostic; }
function accounted(result) { return result.processed + result.skippedUnchanged + result.skippedFiles.length + result.failedFiles.length === result.total; }
async function audit(name) {
  const db = openDatabase(server.config.dbPath, { readonly: true });
  try {
    const chunks = db.prepare("select id, root_id, rel_path, seq from chunks order by root_id, rel_path, seq").all();
    const vectors = db.prepare("select key, embedding from vectors").all();
    const byKey = new Map(vectors.map((row) => [row.key, row.embedding]));
    const items = chunks.map((row) => {
      const raw = byKey.get(`c:${row.id}`); assert(raw, "chunk 缺少向量");
      const values = Array.from({ length: raw.length / 4 }, (_, index) => raw.readFloatLE(index * 4));
      assert.equal(values.length, 512); assert(values.every(Number.isFinite)); assert(Math.abs(Math.hypot(...values) - 1) <= 1e-3);
      return { rootId: row.root_id, relPath: row.rel_path, seq: row.seq, vector: values };
    });
    check(`${name}-vector-accounting`, vectors.length === chunks.length && chunks.length > 0, { chunks: chunks.length, vectors: vectors.length, dim: 512 });
    await writeFile(path.join(output, `${name}-vectors.json`), JSON.stringify(items));
    return items;
  } finally { db.close(); }
}
try {
  const decoder = manifest.decoder.available ? new FfmpegMediaDecoder(decoderPaths) : undefined;
  server = await createServer({ token, port: 0, dataDir: path.join(output, "data"), embedder, decoder, env: { MNEMOSHELF_MEMORY_BACKFILL: "off", MNEMOSHELF_AGENT_DISCOVERY: "off", MNEMOSHELF_INDEX_RATE: "off" } });
  check("real-worker", server.embedder instanceof WorkerEmbedder);
  const corpus = path.join(output, "corpus"); await mkdir(corpus);
  for (const file of manifest.files.filter((item) => scenario !== "budget" || item.name === "firewall.txt")) { assert.equal(await hash(path.join(base, "fixtures", file.name)), file.sha256); await copyFile(path.join(base, "fixtures", file.name), path.join(corpus, file.name)); }
  const root = await request("POST", "/roots", { path: corpus, mode: "index", modalities: ["text", "code", "image", "video"], respectGitignore: false, watch: false });
  report.preview = await request("POST", `/roots/${root.id}/preview`);
  if (scenario === "budget") {
    report.initial = await timed("initialIndex", () => request("POST", `/roots/${root.id}/index`));
    check("budget-initial-ready", report.initial.processed === 1 && report.initial.failedFiles.length === 0, report.initial);
    const before = (await snapshot("before-budget")).embedderRuntime;
    check("budget-start-device", before.device === device && before.loaded, before);
    const query = "firewall ".repeat(3000);
    const { AutoProcessor, env } = await import("../../packages/embedder-transformers/node_modules/@huggingface/transformers/dist/transformers.node.mjs");
    env.allowRemoteModels = false;
    env.cacheDir = path.join(base, "cache");
    const processor = await AutoProcessor.from_pretrained("onnx-community/embeddinggemma-2-ONNX", { local_files_only: true });
    const encoded = await processor([`task: search result | query: ${query}`]);
    const shape = encoded.input_ids.dims;
    report.budgetInputShape = shape;
    check("budget-legal-long-input", shape.length === 2 && shape[0] === 1 && shape[1] > 2700 && shape[1] <= 8192, shape);
    report.budgetSearch = await timed("budgetSearch", () => request("POST", "/search", { query, rootIds: [root.id], k: 5 }));
    const after = (await snapshot("after-budget")).embedderRuntime;
    check("budget-cpu-fallback", after.device === "cpu" && after.requestedDevice === device && (device === "cpu" || after.fallbackReason?.code === "token-budget"), after);
    report.normalSearchAfterBudget = await timed("normalSearchAfterBudget", () => request("POST", "/search", { query: manifest.topics[0].query, rootIds: [root.id], k: 5 }));
    check("budget-followup-query", report.normalSearchAfterBudget.hits.some((hit) => hit.relPath === "firewall.txt"));
    await audit("budget-final");
  } else {
  let queryDuringIndex;
  queryOnWindow = () => { queryDuringIndex = (async () => { const start = performance.now(); const health = await request("GET", "/health"); const hits = await request("POST", "/search", { query: "network firewall", rootIds: [root.id], k: 3 }); return { wallMs: performance.now() - start, health: health.status, hits: hits.hits.length }; })(); };
  report.initial = await timed("initialIndex", () => request("POST", `/roots/${root.id}/index`));
  report.queryDuringIndex = await queryDuringIndex;
  const ready = manifest.files.length - 2;
  check("initial-accounting", accounted(report.initial) && report.initial.processed === ready && report.initial.skippedFiles.length === 1 && report.initial.failedFiles.length === 0, report.initial);
  check("responsive-during-index", report.queryDuringIndex?.health === "ok", report.queryDuringIndex);
  const loaded = (await snapshot("visual-index")).embedderRuntime;
  check("actual-device", loaded?.device === device && loaded.loaded, loaded);
  if (device === "webgpu") check("webgpu-probe", loaded.webgpuProbe?.status === "passed" && loaded.batchSize === 8 && loaded.batchTokenBudget === 2700 && loaded.serializedInference, loaded);
  report.queries = [];
  for (let repeat = 0; repeat < 2; repeat++) for (const item of manifest.topics) {
    const start = performance.now(); const result = await request("POST", "/search", { query: item.query, rootIds: [root.id], k: 5 });
    const paths = result.hits.filter((hit) => hit.type === "chunk").map((hit) => hit.relPath);
    report.queries.push({ repeat, target: item.target, wallMs: performance.now() - start, paths });
    check(`query-${repeat}-${item.target}`, paths.includes(item.target), paths);
  }
  await audit("initial");
  const callsBefore = { ...report.workerCalls };
  report.unchanged = await timed("unchangedIndex", () => request("POST", `/roots/${root.id}/index`));
  check("incremental-unchanged", accounted(report.unchanged) && report.unchanged.processed === 0 && report.unchanged.skippedUnchanged === ready && JSON.stringify(callsBefore) === JSON.stringify(report.workerCalls), report.unchanged);
  await writeFile(path.join(corpus, "firewall.txt"), "Firewall updates: deny inbound requests except HTTPS. Track security audit events and trusted outgoing connections.\n");
  report.modified = await timed("modifiedIndex", () => request("POST", `/roots/${root.id}/index`));
  check("incremental-modified", accounted(report.modified) && report.modified.processed === 1 && report.modified.skippedUnchanged === ready - 1 && report.modified.failedFiles.length === 0, report.modified);
  const cancelDir = path.join(output, "cancel-corpus"); await mkdir(cancelDir);
  await writeFile(path.join(cancelDir, "long.txt"), Array.from({ length: 300 }, (_, index) => `Section ${index}: ${manifest.topics[0].query}`).join("\n\n"));
  const cancelRoot = await request("POST", "/roots", { path: cancelDir, mode: "index", modalities: ["text"], respectGitignore: false, watch: false });
  let cancellation;
  cancelOnWindow = () => { cancellation = request("POST", `/roots/${cancelRoot.id}/index/cancel`); };
  report.cancelled = await timed("cancelIndex", () => request("POST", `/roots/${cancelRoot.id}/index`));
  report.cancelAcknowledged = await cancellation;
  report.cancelStatus = await request("GET", `/roots/${cancelRoot.id}/index/status`);
  check("cancel-observed", report.cancelAcknowledged?.cancelled && report.cancelled.cancelled && report.cancelStatus.state === "cancelled", report.cancelStatus);
  check("cancel-no-partial-file", (await server.store.listChunksByPath(cancelRoot.id, "long.txt")).length === 0);
  report.resumed = await timed("resumeIndex", () => request("POST", `/roots/${cancelRoot.id}/index`));
  check("resume-complete", report.resumed.processed === 1 && report.resumed.failedFiles.length === 0 && (await server.store.listChunksByPath(cancelRoot.id, "long.txt")).length > 1, report.resumed);
  await snapshot("after-resume-before-audio");
  const audioDir = path.join(output, "audio-corpus"); await mkdir(audioDir); await copyFile(path.join(base, "tone.wav"), path.join(audioDir, "tone.wav"));
  const audioRoot = await request("POST", "/roots", { path: audioDir, mode: "index", modalities: ["audio"], watch: false });
  report.audio = await timed("audioCpuIndex", () => request("POST", `/roots/${audioRoot.id}/index`));
  check("audio-ready", report.audio.processed === 1 && report.audio.failedFiles.length === 0, report.audio);
  const audioStatus = (await snapshot("after-audio-cpu")).embedderRuntime;
  check("audio-cpu-policy", audioStatus.device === "cpu" && audioStatus.requestedDevice === device && audioStatus.audioState === "ready" && (device === "cpu" || audioStatus.fallbackReason?.code === "audio-cpu"), audioStatus);
  report.postAudioSearch = await timed("postAudioSearch", () => request("POST", "/search", { query: manifest.topics[1].query, rootIds: [root.id], k: 5 }));
  check("post-audio-query", report.postAudioSearch.hits.some((hit) => hit.relPath === "orchard.txt"));
  await audit("final");
  }
  check("worker-serialized", maxWorkerInFlight === 1 && workerStarts === 1, { maxWorkerInFlight, workerStarts });
  report.passed = true;
} catch (error) {
  report.error = { name: error?.name ?? "Error", message: String(error?.message ?? "驗收失敗").replaceAll(repo, "<repo>").replaceAll(os.homedir(), "<home>") };
} finally {
  const completed = report.passed;
  report.passed = false;
  clearInterval(samplingTimer);
  report.status = "closing";
  await save();
  try {
    if (server) {
      await timed("close", () => server.close());
      check("media-closed", media.size === 0, { active: media.size });
    } else await embedder.dispose();
    report.passed = completed;
  } catch (error) {
    report.passed = false;
    report.cleanupError = { name: error?.name, message: "服務或媒體程序未乾淨關閉；查核 close 與 media-closed。" };
  }
  while (sampling) await new Promise((resolve) => setTimeout(resolve, 20));
  await sample("after-close");
  childProcess.spawn = originalSpawn; syncBuiltinESMExports();
  report.resources.mainPeakRssBytes = process.resourceUsage().maxRSS * 1024;
  report.resources.note = "主行程 RSS 包含 worker threads；500ms 採樣峰值是下界。ps 無法取得的子程序 RSS 記 null；原生 GPU 驅動獨立用量未量測。";
  report.status = "finished";
  report.finishedAt = new Date().toISOString(); await save();
  console.log(JSON.stringify({ runId, passed: report.passed, error: report.error, checks: report.checks, stages: report.stages }));
  if (!report.passed) process.exitCode = 1;
}
