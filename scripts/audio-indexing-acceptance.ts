/** 音訊產品整條路徑驗收；先執行 acceptance-tts.ps1 與 acceptance-prepare.ts。 */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile, copyFile, realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { deflateSync } from "node:zlib";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import type { ChunkMedia } from "../packages/core/dist/index.js";

const repo = process.cwd();
const base = path.join(repo, ".tmp", "audio-indexing-acceptance");
const label = process.versions.electron ? "electron" : "node";
const output = path.join(base, `${label}-${Date.now()}`);
await mkdir(output, { recursive: true });
const fixtureDir = path.join(base, "fixtures");
const core = await import(pathToFileURL(path.join(repo, "packages", "core", "dist", "index.js")).href) as typeof import("../packages/core/dist/index.js");
const { unifiedSearch } = await import(pathToFileURL(path.join(repo, "packages", "server", "dist", "search.js")).href) as typeof import("../packages/server/dist/search.js");
const { WorkerEmbedder } = await import(pathToFileURL(path.join(repo, "packages", "server", "dist", "worker-embedder.js")).href) as typeof import("../packages/server/dist/worker-embedder.js");

const fixtureManifest = JSON.parse(await readFile(path.join(base, "fixture-manifest.json"), "utf8"));
for (const fixture of fixtureManifest.files) {
  assert.equal(createHash("sha256").update(await readFile(path.join(fixtureDir, fixture.name))).digest("hex"), fixture.sha256);
}
const report: Record<string, unknown> = {
  version: 1, startedAt: new Date().toISOString(), thresholdsFrozenAt: "2026-11-07T23:46:02Z",
  runtime: { node: process.versions.node, electron: process.versions.electron ?? null, platform: process.platform, arch: process.arch },
  fixtureManifest, checks: {},
};
const codeFingerprints: Record<string, string> = {};
for (const parts of [
  ["core", "dist", "audio", "wav.js"], ["core", "dist", "indexer", "indexer.js"],
  ["core", "dist", "adapters", "sqlite", "metadata-store.js"],
  ["embedder-transformers", "dist", "embedder.js"], ["server", "dist", "worker-embedder.js"],
  ["server", "dist", "embedder-worker.js"], ["server", "dist", "search.js"],
]) {
  codeFingerprints[parts.join(":")] = createHash("sha256").update(await readFile(path.join(repo, "packages", ...parts))).digest("hex");
}
report.codeFingerprints = codeFingerprints;
const modelFingerprints: Record<string, string> = {};
for (const name of ["model_q4.onnx", "model_q4.onnx_data", "vision_encoder_q4.onnx", "vision_encoder_q4.onnx_data", "audio_encoder_q4.onnx", "audio_encoder_q4.onnx_data"]) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path.join(repo, ".tmp", "media-feasibility", "models", "onnx-community", "embeddinggemma-2-ONNX", "onnx", name))) hash.update(chunk);
  modelFingerprints[name] = hash.digest("hex");
}
report.modelFingerprints = modelFingerprints;
const checks = report.checks as Record<string, unknown>;
let audioCalls = 0;
let audioPending = 0;
let maxAudioPending = 0;
let queryDuringIndex: Promise<unknown> | undefined;
let startIndexQuery: (() => Promise<unknown>) | undefined;
let cancelNext: AbortController | undefined;
let cancelRequestedAt: number | undefined;
let maxWorkerInFlight = 0;
const pending = new Set<number>();
const turns: string[] = [];
const embedder = new WorkerEmbedder({
  embedderOptions: { device: "cpu", dtype: "q4", dim: 512, cacheDir: path.join(repo, ".tmp", "media-feasibility", "models") },
  createWorker: () => {
    const worker = new Worker(pathToFileURL(path.join(repo, "scripts", "indexing-benchmark", "offline-worker.mjs")), { execArgv: [] });
    worker.on("message", (message: { type: string; id: number }) => { if (message.type === "response") pending.delete(message.id); });
    const post = worker.postMessage.bind(worker);
    worker.postMessage = (message: { type: string; method: string; id: number }, transfer) => {
      if (message.type === "request" && message.method !== "dispose") {
        turns.push(message.method); pending.add(message.id); maxWorkerInFlight = Math.max(maxWorkerInFlight, pending.size);
        if (message.method === "embedAudio" && cancelNext) {
          const controller = cancelNext; cancelNext = undefined;
          setTimeout(() => { cancelRequestedAt = performance.now(); controller.abort(); }, 50);
        }
      }
      post(message, transfer);
    };
    return worker;
  },
});
const originalAudio = embedder.embedAudio.bind(embedder);
embedder.embedAudio = async (audio, options) => {
  audioCalls++; audioPending++; maxAudioPending = Math.max(maxAudioPending, audioPending);
  const task = originalAudio(audio, options);
  if (startIndexQuery) { const run = startIndexQuery; startIndexQuery = undefined; queryDuringIndex = run(); }
  try {
    const vector = await task;
    assert.equal(vector.length, 512);
    assert(vector.every(Number.isFinite));
    assert(Math.abs(Math.hypot(...vector) - 1) <= 1e-3);
    return vector;
  } finally { audioPending--; }
};
const db = core.openDatabase(path.join(output, "index.sqlite"));
const store = new core.SqliteMetadataStore(db);
await store.migrate();
const vec = new core.SqliteVectorIndex(db, embedder.info.dim);
const deps = { embedder, store, vec };
const failures: string[] = [];
function check(name: string, ok: boolean, details?: unknown): void {
  checks[name] = { passed: ok, details };
  if (!ok) failures.push(name);
}

function png(): Uint8Array {
  const crc = (bytes: Buffer) => { let n = 0xffffffff; for (const byte of bytes) { n ^= byte; for (let i = 0; i < 8; i++) n = (n >>> 1) ^ ((n & 1) ? 0xedb88320 : 0); } return (n ^ 0xffffffff) >>> 0; };
  const chunk = (name: string, data: Buffer) => { const type = Buffer.from(name); const size = Buffer.alloc(4); size.writeUInt32BE(data.length); const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(Buffer.concat([type, data]))); return Buffer.concat([size, type, data, sum]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(2, 0); header.writeUInt32BE(2, 4); header[8] = 8; header[9] = 2;
  const row = Buffer.from([0, 255, 0, 0, 255, 0, 0]);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.concat([row, row]))), chunk("IEND", Buffer.alloc(0))]);
}

async function addRoot(directory: string) {
  return store.addRoot({ path: await realpath(directory), mode: "index", modalities: ["text", "code", "image", "audio"], include: [], exclude: [], respectGitignore: false, watch: false });
}

function account(result: Awaited<ReturnType<typeof core.indexRoot>>): boolean {
  return result.processed + result.skippedUnchanged + result.skippedFiles.length + result.failedFiles.length === result.total;
}

try {
  // 極短尾段屬 API 合法輸入；實際 processor 必須可以處理，不能只依 mock 判定。
  const tiny: Record<string, unknown>[] = [];
  for (const count of [1, 160, 1600]) {
    try {
      await embedder.embedAudio({ samples: new Float32Array(count), sampleRate: 16000 });
      tiny.push({ samples: count, passed: true });
    } catch (error) { tiny.push({ samples: count, passed: false, error: error instanceof Error ? error.name : "error" }); }
  }
  check("tinyAudio", tiny.every((item) => item.passed === true), tiny);

  const corpus = path.join(output, "corpus"); await mkdir(corpus);
  for (let n = 1; n <= 7; n++) { const name = `f0${n}.wav`; await copyFile(path.join(fixtureDir, name), path.join(corpus, name)); }
  await writeFile(path.join(corpus, "document.txt"), "A synthetic network firewall configuration blocks incoming connections.");
  await writeFile(path.join(corpus, "source.ts"), "export const add = (left: number, right: number) => left + right;");
  await writeFile(path.join(corpus, "picture.png"), png());
  await writeFile(path.join(corpus, "broken.wav"), Buffer.from("not a wave file"));
  await writeFile(path.join(corpus, "unsupported.mp3"), Buffer.from("synthetic unsupported placeholder"));
  const root = await addRoot(corpus);
  report.embedder = embedder.info;
  const start = performance.now();
  startIndexQuery = async () => {
    const before = performance.now();
    const hits = await unifiedSearch(deps, { query: "network firewall", rootIds: [root.id], k: 3 });
    return { elapsedMs: performance.now() - before, hits: hits.hits.length };
  };
  const first = await core.indexRoot(root, { ...deps, concurrency: 2 });
  report.initialIndexMs = performance.now() - start;
  report.initialIndex = first;
  report.searchDuringIndex = await queryDuringIndex;
  check("initialAccounting", account(first) && first.processed === 10 && first.failedFiles.length === 0 && first.skippedFiles.length === 1 && first.scanSkippedFiles?.some((item) => item.relPath === "unsupported.mp3") === true, first);

  const queries = [
    ["speech", "f01.wav", "烹飪番茄炒蛋的做法"], ["speech", "f01.wav", "Cooking tomatoes and eggs, seasoning with salt."],
    ["speech", "f02.wav", "明天早上九點開設計審查會議"], ["speech", "f02.wav", "A design review meeting at nine in the morning."],
    ["speech", "f03.wav", "火車抵達第二月台的廣播"], ["speech", "f03.wav", "A train arriving at platform two, passengers getting ready to board."],
    ["environment", "f04.wav", "有人連續敲門的聲音"], ["environment", "f04.wav", "Someone knocking repeatedly on a wooden door."],
    ["environment", "f05.wav", "持續下雨的沙沙聲"], ["environment", "f05.wav", "Steady rainfall and water droplets."],
    ["environment", "f06.wav", "電子警報器間歇嗶嗶聲"], ["environment", "f06.wav", "An electronic alarm beeping repeatedly."],
  ];
  const results: { category: string; target: string; query: string; rank: number | null; elapsedMs: number; hits: { path: string; seq: number; score: number; media?: ChunkMedia }[] }[] = [];
  for (const [category, target, query] of queries) {
    const before = performance.now();
    const result = await unifiedSearch(deps, { query, rootIds: [root.id], k: 20 });
    const ranked = result.hits.filter((hit) => hit.type === "chunk");
    const rank = ranked.findIndex((hit) => hit.relPath === target) + 1;
    results.push({ category, target, query, rank: rank || null, elapsedMs: performance.now() - before, hits: ranked.map((hit) => ({ path: hit.relPath, seq: hit.seq, score: hit.score, media: hit.media })) });
  }
  const recall = (category?: string) => results.filter((item) => (!category || item.category === category) && item.rank !== null && item.rank <= 3).length;
  report.queries = results;
  report.quality = { recallAt3: recall() / 12, speechRecallAt3: recall("speech") / 6, environmentRecallAt3: recall("environment") / 6, top1: results.filter((item) => item.rank === 1).length / 12, mrr: results.reduce((sum, item) => sum + (item.rank ? 1 / item.rank : 0), 0) / 12 };
  check("retrievalQuality", recall() >= 9 && recall("speech") >= 5 && recall("environment") >= 4, report.quality);
  check("silenceNegative", results.every((item) => item.hits[0]?.path !== "f07.wav"));
  const beforeUnchanged = audioCalls;
  const unchanged = await core.indexRoot(root, { ...deps, concurrency: 2 });
  check("unchanged", audioCalls === beforeUnchanged && unchanged.skippedUnchanged === 10 && account(unchanged), unchanged);
  await copyFile(path.join(fixtureDir, "replacement.wav"), path.join(corpus, "f06.wav"));
  const beforeModified = audioCalls;
  const modified = await core.indexRoot(root, { ...deps, concurrency: 2 });
  check("modified", audioCalls - beforeModified === 1 && modified.processed === 1 && modified.skippedUnchanged === 9 && account(modified), modified);
  const changedChunks = await store.listChunksByPath(root.id, "f06.wav");
  check("modifiedMetadata", changedChunks.length === 1 && changedChunks[0].media?.endSeconds === 3 && changedChunks[0].media.embeddingDim === 512, changedChunks);

  const longDir = path.join(output, "long"); await mkdir(longDir);
  await copyFile(path.join(fixtureDir, "long.wav"), path.join(longDir, "f01.wav"));
  const longRoot = await addRoot(longDir);
  const longIndex = await core.indexRoot(longRoot, { ...deps, concurrency: 1 });
  const longChunks = await store.listChunksByPath(longRoot.id, "f01.wav");
  const longResult = await unifiedSearch(deps, { query: "番茄炒蛋加鹽調味", rootIds: [longRoot.id], k: 4 });
  const firstLong = longResult.hits[0];
  check("longCoverage", longIndex.processed === 1 && longChunks.length === 4 && longChunks[0].media?.startSeconds === 0 && longChunks[3].media?.startSeconds === 30 && longChunks[3].media.endSeconds === 35 && longChunks.every((chunk, i) => i === 0 || chunk.media?.startSeconds === longChunks[i - 1].media?.endSeconds), longChunks);
  check("longLocalization", firstLong?.type === "chunk" && (firstLong.media?.startSeconds ?? -1) >= 30, longResult);

  const edgeDir = path.join(output, "edge"); await mkdir(edgeDir);
  await copyFile(path.join(fixtureDir, "tail-edge.wav"), path.join(edgeDir, "f01.wav"));
  const edgeRoot = await addRoot(edgeDir);
  const edgeIndex = await core.indexRoot(edgeRoot, { ...deps, concurrency: 1 });
  const edgeChunks = await store.listChunksByPath(edgeRoot.id, "f01.wav");
  check("oneSampleRemainder", edgeIndex.processed === 1 && edgeChunks.length === 2 && edgeChunks[1].media?.startSeconds === 10 && edgeChunks[1].media.endSeconds === 10 + 1 / 16000, { result: edgeIndex, chunks: edgeChunks });

  const cancelDir = path.join(output, "cancel"); await mkdir(cancelDir);
  await copyFile(path.join(fixtureDir, "long.wav"), path.join(cancelDir, "f01.wav"));
  const cancelRoot = await addRoot(cancelDir);
  const controller = new AbortController(); cancelNext = controller;
  await assert.rejects(core.indexRoot(cancelRoot, { ...deps, concurrency: 1, signal: controller.signal }), { name: "AbortError" });
  await embedder.drain();
  const cancelMs = performance.now() - (cancelRequestedAt ?? performance.now());
  const afterCancel = await store.listChunksByPath(cancelRoot.id, "f01.wav");
  const resumed = await core.indexRoot(cancelRoot, { ...deps, concurrency: 1 });
  check("cancelResume", afterCancel.length === 0 && resumed.processed === 1 && (await store.listChunksByPath(cancelRoot.id, "f01.wav")).length === 4, { cancelToDrainMs: cancelMs, beforeRerunChunks: afterCancel.length, resumed });
  const missing = db.prepare("select count(*) as n from chunks c where not exists (select 1 from vectors v where v.key = 'c:' || c.id)").get() as { n: number };
  const orphan = db.prepare("select count(*) as n from vectors v where v.key like 'c:%' and not exists (select 1 from chunks c where v.key = 'c:' || c.id)").get() as { n: number };
  check("vectorAccounting", missing.n === 0 && orphan.n === 0, { missing: missing.n, orphan: orphan.n });
  check("workerBounds", maxWorkerInFlight === 1 && maxAudioPending <= 2, { maxWorkerInFlight, maxAudioPending });
  report.audioCalls = audioCalls; report.turns = turns;
} catch (error) {
  failures.push("unexpected-error");
  report.error = { name: error instanceof Error ? error.name : "error", message: error instanceof Error ? error.message.replaceAll(repo, "<repo>") : "驗收失敗" };
} finally {
  await embedder.dispose(); db.close();
  report.finishedAt = new Date().toISOString(); report.peakRssBytes = process.resourceUsage().maxRSS * 1024;
  report.failures = failures; report.passed = failures.length === 0;
  await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  await writeFile(path.join(base, `${label}-latest.json`), JSON.stringify({ directory: path.basename(output), passed: report.passed }, null, 2));
  console.log(JSON.stringify({ directory: path.basename(output), passed: report.passed, failures, quality: report.quality, checks: report.checks }, null, 2));
  if (failures.length) process.exitCode = 1;
}
