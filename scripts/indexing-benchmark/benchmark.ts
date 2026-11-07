import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { cpus, totalmem } from "node:os";
import { performance } from "node:perf_hooks";
import { Worker } from "node:worker_threads";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chunkCode, chunkText, indexRoot, openDatabase, SqliteMetadataStore, SqliteVectorIndex, type Embedder, type IndexRootOptions, type IndexRootResult, type VectorItem } from "../../packages/core/dist/index.js";
import { FakeEmbedder } from "../../packages/core/dist/testing/fake-embedder.js";
import { unifiedSearch } from "../../packages/server/dist/search.js";
import { createCorpus, type CorpusProfile } from "./corpus.ts";

const base = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
type IndexFunction = (root: Parameters<typeof indexRoot>[0], options: IndexRootOptions) => Promise<IndexRootResult>;
export interface BenchmarkOptions { mode: "accounting" | "real"; profile: CorpusProfile; repetitions: number; label: string; indexerModule?: string; workerModule?: string; workerEntryModule?: string; device?: "cpu" | "dml" | "auto"; scenario?: "full" | "cancel-only" }
type QualityVector = { key: string; vec: number[] };
interface Counters { documents: number; documentBatches: number; images: number; maxBatch: number }

/** 使用 nearest-rank 定義；沒有樣本時保留 null，避免把未量測當成零延遲。 */
export function percentile(values: readonly number[], fraction: number): number | null {
  if (values.length === 0) return null;
  if (!(fraction > 0 && fraction <= 1)) throw new RangeError("fraction 必須介於 0 與 1 之間");
  return [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1]!;
}

class AccountingEmbedder extends FakeEmbedder {
  override async embedImage(input: Parameters<Embedder["embedImage"]>[0]): Promise<Float32Array> {
    // 假模型也不能把壞圖／不支援的音訊與影片偽裝成成功。
    if (Buffer.from(input.bytes).readUInt32BE(0) !== 0x89504e47) throw Object.assign(new Error("合成媒體無法解碼"), { code: "undecodable" });
    return super.embedImage(input);
  }
}

async function makeEmbedder(options: BenchmarkOptions): Promise<Embedder & { drain?: () => Promise<void> }> {
  if (options.mode === "accounting") return new AccountingEmbedder();
  const { WorkerEmbedder } = options.workerModule ? await import(pathToFileURL(path.resolve(options.workerModule)).href) : await import("../../packages/server/dist/worker-embedder.js");
  return new WorkerEmbedder({
    embedderOptions: { device: options.device ?? "cpu" },
    createWorker: () => new Worker(new URL("./offline-worker.mjs", import.meta.url), { workerData: { ...(options.workerEntryModule ? { entry: pathToFileURL(path.resolve(options.workerEntryModule)).href } : {}) } }),
  });
}

function instrument(embedder: Embedder, counters: Counters): Embedder {
  return {
    info: embedder.info,
    get runtimeStatus() { return embedder.runtimeStatus; },
    embedQuery: (text) => embedder.embedQuery(text),
    embedDocument: (text, title) => embedder.embedDocument(text, title),
    embedDocuments: (inputs, opts) => {
      counters.documentBatches += 1; counters.documents += inputs.length; counters.maxBatch = Math.max(counters.maxBatch, inputs.length);
      return embedder.embedDocuments(inputs, opts);
    },
    embedImage: (image, opts) => { counters.images += 1; return embedder.embedImage(image, opts); },
    probe: () => embedder.probe(), dispose: () => embedder.dispose(),
  };
}

async function measure(directory: string, corpus: string, embedder: Embedder, index: IndexFunction, cancellation: boolean) {
  await fs.mkdir(directory, { recursive: true });
  const db = openDatabase(path.join(directory, "index.sqlite"));
  const store = new SqliteMetadataStore(db);
  await store.migrate();
  const vec = new SqliteVectorIndex(db, embedder.info.dim);
  const root = await store.addRoot({ path: await fs.realpath(corpus), mode: "index", modalities: ["text", "code", "image", "audio", "video"], include: [], exclude: [], respectGitignore: false, watch: false });
  const vectors = new Map<string, number[]>();
  let publicationPhase = { first: { text: null, code: null, image: null, audio: null, video: null } as Record<string, number | null>, started: performance.now() };
  const originalUpsert = vec.upsert.bind(vec);
  vec.upsert = async (items: VectorItem[]) => {
    const phase = publicationPhase;
    await originalUpsert(items);
    for (const item of items) {
      const chunk = (await store.getChunks([Number(item.key.slice(2))]))[0];
      if (chunk === undefined) continue;
      vectors.set(`${chunk.relPath}:${chunk.seq}`, Array.from(item.vec));
      if (phase.first[chunk.kind] === null) {
        const hits = await vec.searchVector(item.vec, { rootIds: [root.id] }, 100);
        if (hits.some((hit) => hit.key === item.key)) phase.first[chunk.kind] = performance.now() - phase.started;
      }
    }
  };
  let peakRss = process.memoryUsage().rss;
  const rssTimer = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 20);
  const controller = new AbortController();
  let querying = true;
  let activeQuery: Promise<void> | undefined;
  const queryLatencies: number[] = [];
  const queryObservations: { phase: string; durationMs: number }[] = [];
  let currentPhase = "setup";
  let queryErrors = 0;
  let queryTicksSkipped = 0;
  const query = async (): Promise<void> => {
    const start = performance.now();
    const phase = currentPhase;
    try { await unifiedSearch({ store, vec, embedder }, { query: "red apple blue sky orchard", rootIds: [root.id], k: 5 }); const durationMs = performance.now() - start; queryLatencies.push(durationMs); queryObservations.push({ phase, durationMs }); }
    catch { queryErrors += 1; }
  };
  const queryTimer = setInterval(() => {
    if (!querying) return;
    if (activeQuery !== undefined) { queryTicksSkipped += 1; return; }
    activeQuery = query().finally(() => { activeQuery = undefined; });
  }, 250);
  const stages: Record<string, number> = {};
  const run = async (phase: string, cancel: boolean) => {
    currentPhase = phase;
    let lastProgress: unknown = null;
    let cancelRequestedAt: number | null = null;
    const local = { first: { text: null, code: null, image: null, audio: null, video: null } as Record<string, number | null>, started: performance.now() };
    publicationPhase = local;
    const counters: Counters = { documents: 0, documentBatches: 0, images: 0, maxBatch: 0 };
    const measuredEmbedder = instrument(embedder, counters);
    let result: IndexRootResult | null = null;
    let aborted = false;
    const opts: IndexRootOptions & { onTiming: (event: { stage: string; durationMs: number }) => void } = {
      embedder: measuredEmbedder, store, vec,
      // 原基線的 Promise.all 取消會先返回；此情境單一檔案 worker 才能隔離歷史行為。
      concurrency: cancellation ? 1 : 2,
      onProgress: (progress) => {
        lastProgress = { ...progress };
        peakRss = Math.max(peakRss, process.memoryUsage().rss);
        if (cancel && progress.processed >= 1 && cancelRequestedAt === null) { cancelRequestedAt = performance.now(); controller.abort(); }
      },
      onTiming: (event) => { stages[event.stage] = (stages[event.stage] ?? 0) + event.durationMs; },
      ...(cancel ? { signal: controller.signal } : {}),
    };
    try { result = await index(root, opts); }
    catch (error) { if ((error as Error).name !== "AbortError") throw error; aborted = true; }
    const durationMs = performance.now() - local.started;
    const cancelObservedMs = !cancel || cancelRequestedAt === null ? null : performance.now() - cancelRequestedAt;
    const chunks = Number((db.prepare("select count(*) as n from chunks").get() as { n: number }).n);
    const vectorCount = await vec.count();
    const missing = Number((db.prepare("select count(*) as n from chunks c where not exists (select 1 from vectors v where v.key = 'c:' || c.id)").get() as { n: number }).n);
    const orphan = Number((db.prepare("select count(*) as n from vectors v where not exists (select 1 from chunks c where v.key = 'c:' || c.id)").get() as { n: number }).n);
    const expectedKeys: string[] = [];
    for (const name of (await fs.readdir(corpus)).sort()) {
      if (name === "bad.png" || ![".md", ".txt", ".ts", ".png"].includes(path.extname(name)) || name === "binary.txt") continue;
      const pieces = path.extname(name) === ".png" ? [null] : (path.extname(name) === ".ts" ? chunkCode : chunkText)(await fs.readFile(path.join(corpus, name), "utf8"));
      for (let seq = 0; seq < pieces.length; seq += 1) expectedKeys.push(`${name}:${seq}`);
    }
    const actualKeys = (db.prepare("select rel_path, seq from chunks").all() as { rel_path: string; seq: number }[]).map((row) => `${row.rel_path}:${row.seq}`).sort();
    return { phase, durationMs, result, aborted, expectedChunks: expectedKeys.length, expectedKeysExact: JSON.stringify(actualKeys) === JSON.stringify(expectedKeys.sort()), firstSearchableMs: { ...local.first }, counters: { ...counters }, chunks, vectors: vectorCount, missingVectors: missing, orphanVectors: orphan, lastProgress, cancelObservedMs };
  };
  try {
    const phases = [];
    if (cancellation) {
      phases.push(await run("cancel", true));
      // 等候 native 推論在安全邊界結束後再重跑。
      if ("drain" in embedder && typeof embedder.drain === "function") await embedder.drain();
      phases.push(await run("cancel-rerun", false));
    } else {
      phases.push(await run("first-build", false));
      phases.push(await run("unchanged", false));
      await fs.appendFile(path.join(corpus, "text-00.md"), "\nSynthetic partial edit changes this file only.\n");
      phases.push(await run("partial-edit", false));
    }
    querying = false; clearInterval(queryTimer); await activeQuery;
    const idleQueryLatencies: number[] = [];
    for (let i = 0; i < 20; i += 1) { const start = performance.now(); await unifiedSearch({ store, vec, embedder }, { query: "red apple blue sky orchard", rootIds: [root.id], k: 5 }); idleQueryLatencies.push(performance.now() - start); }
    const quality: QualityVector[] = [...vectors].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => ({ key, vec: value }));
    const firstBuildQueries = queryObservations.filter((sample) => sample.phase === "first-build").map((sample) => sample.durationMs);
    return { phases, indexConcurrency: cancellation ? 1 : 2, peakRssBytes: peakRss, scheduling: "schedulingStatus" in embedder ? embedder.schedulingStatus : null, queryUnderIndex: { intervalMs: 250, samples: queryLatencies.length, p95Ms: percentile(queryLatencies, .95), firstBuildSamples: firstBuildQueries.length, firstBuildP95Ms: percentile(firstBuildQueries, .95), errors: queryErrors, ticksSkipped: queryTicksSkipped, observations: queryObservations }, idleQuery: { samples: 20, p95Ms: percentile(idleQueryLatencies, .95) }, stagesMs: stages, quality };
  } finally { querying = false; clearInterval(queryTimer); clearInterval(rssTimer); await activeQuery; db.close(); }
}

/** 真實索引器與 SQLite 的可重跑量測；模型模式不允許下載。 */
export async function runBenchmark(options: BenchmarkOptions) {
  if (!Number.isInteger(options.repetitions) || options.repetitions < 1) throw new RangeError("repetitions 必須是正整數");
  if (!/^[a-zA-Z0-9_-]+$/.test(options.label)) throw new TypeError("label 僅允許英數、底線與連字號");
  const target = path.join(base, ".tmp", "indexing-benchmark", `${options.label}-${Date.now()}`);
  await fs.mkdir(target, { recursive: true });
  let frozenBaseline: unknown = null;
  if (options.indexerModule) {
    try { frozenBaseline = JSON.parse(await fs.readFile(path.join(path.dirname(path.resolve(options.indexerModule)), "manifest.json"), "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  const sourceFiles = [options.indexerModule ? path.resolve(options.indexerModule) : path.join(base, "packages", "core", "dist", "indexer", "indexer.js"), frozenBaseline ? path.join(path.dirname(path.resolve(options.indexerModule!)), "scan.js") : path.join(base, "packages", "core", "dist", "indexer", "scan.js"), options.workerModule ? path.resolve(options.workerModule) : path.join(base, "packages", "server", "dist", "worker-embedder.js"), options.workerEntryModule ? path.resolve(options.workerEntryModule) : path.join(base, "packages", "server", "dist", "embedder-worker.js"), path.join(base, "packages", "embedder-transformers", "dist", "embedder.js"), path.join(base, "packages", "core", "dist", "indexer", "chunk-text.js"), path.join(base, "packages", "core", "dist", "adapters", "sqlite", "metadata-store.js"), path.join(base, "packages", "core", "dist", "adapters", "sqlite", "vector-index.js")];
  const sourceHashes = await Promise.all(sourceFiles.map(async (file, i) => ({ component: ["indexer", "scan", "worker-embedder", "embedder-worker", "embedder", "chunk-text", "sqlite-metadata", "sqlite-vector"][i], sha256: createHash("sha256").update(await fs.readFile(file)).digest("hex") })));
  const dependencies = await Promise.all([path.join(base, "packages", "embedder-transformers", "node_modules", "@huggingface", "transformers", "package.json"), path.join(base, "packages", "core", "node_modules", "better-sqlite3", "package.json"), path.join(base, "packages", "core", "node_modules", "sqlite-vec", "package.json")].map(async (file) => { const item = JSON.parse(await fs.readFile(file, "utf8")); return { name: String(item.name), version: String(item.version) }; }));
  const index: IndexFunction = options.indexerModule ? (await import(pathToFileURL(path.resolve(options.indexerModule)).href)).indexRoot : indexRoot;
  const trials = [];
  let manifest;
  for (let trial = 0; trial < options.repetitions; trial += 1) {
    const embedder = await makeEmbedder(options);
    try {
      const probeStarted = performance.now(); const probe = await embedder.probe();
      if (!probe.ok) throw new Error("embedder 探測失敗");
      const probeMs = performance.now() - probeStarted;
      for (const temperature of options.scenario === "cancel-only" ? [] : ["first-after-probe", "warm"] as const) {
        const trialDir = path.join(target, `trial-${trial}-${temperature}`);
        const corpus = path.join(trialDir, "corpus"); manifest = await createCorpus(corpus, options.profile);
        const data = await measure(trialDir, corpus, embedder, index, false);
        trials.push({ trial, temperature, probeMs: temperature === "first-after-probe" ? probeMs : 0, embedder: embedder.info, runtime: embedder.runtimeStatus, ...data });
      }
      if (trial === 0) {
        const directory = path.join(target, "cancellation"); const corpus = path.join(directory, "corpus");
        manifest = await createCorpus(corpus, options.profile);
        trials.push({ trial, temperature: "cancellation" as const, probeMs: 0, embedder: embedder.info, runtime: embedder.runtimeStatus, ...await measure(directory, corpus, embedder, index, true) });
      }
    } finally { await embedder.dispose(); }
  }
  const report = { schemaVersion: 1, createdAt: new Date().toISOString(), options: { ...options, indexerModule: options.indexerModule ? "frozen-baseline" : "current-build", workerModule: options.workerModule ? "frozen-baseline" : "current-build", workerEntryModule: options.workerEntryModule ? "frozen-baseline" : "current-build" }, sourceHashes, frozenBaseline, environment: { platform: process.platform, arch: process.arch, node: process.version, cpu: cpus()[0]?.model ?? "unknown", logicalCpus: cpus().length, physicalMemoryBytes: totalmem(), dependencies }, corpusDigest: createHash("sha256").update(JSON.stringify(manifest)).digest("hex"), manifest, caveats: ["first-after-probe and warm BOTH use a loaded model and fresh DB; cold initialization + semantic probe measured separately as probeMs; no claim of cold-model indexing; OS page cache is not flushed", "accounting mode has no semantics and cannot support speed or quality claims", "query latency is in-process unifiedSearch, not HTTP/MCP transport latency", "firstSearchable uses actual vector publication + self-vector retrieval, not semantic relevance", "RSS is whole Node process incl. worker; 20ms sampling may miss brief spikes", "cancellation is requested at first committed-file progress boundary, not proof of mid-native-inference abort"], trials };
  const file = path.join(target, "report.json"); await fs.writeFile(file, JSON.stringify(report, null, 2));
  return { report, file };
}
