/**
 * D4 補修的 gated 回歸測試：影片解碼「程序生命週期」全域上限（真 ffmpeg）。
 *
 * 契約：project-notes/projects/mnemoshelf/research/2026-11-09-video-d4-process-budget.md §8。
 * 背景：波次一只把影片名額改成「每次 decoder next() 取放」，ffmpeg 程序在等待嵌入時仍存活；
 * 四個 roots 同時索引時實測同時存活 4 個 ffmpeg。task-20 的 decoder 新增 per-decoder 的
 * `DecodeProcessBudget`（容量 1、持有到程序 close、跨 root 讓出／段界恢復），本檔驗收它。
 *
 * 這支測試**只追蹤自己 spawn 的 ffmpeg**：在載入任何產品模組之前 patch
 * `child_process.spawn`，只計 ffmpeg.exe 且 args 含 `rawvideo`（視覺）或 `f32le`（音軌）的程序，
 * close 時從 live 移除；不使用全機 tasklist（避免把別人的程序當成自己的殘留）。
 *
 * Gating（缺任何一項整檔 skip，CI 不受影響）：
 * - Windows x64；
 * - `MNEMOSHELF_FFMPEG_PATH`／`MNEMOSHELF_FFPROBE_PATH` 指向 LGPL static 候選（A1 的 .tmp）；
 * - 短 fixture 存在：`.tmp/wave1/fixtures`（`tail-grid-16.2.mp4`、`tail-grid-12.2.mp4`、
 *   `tail-8.2.mp4`、`tail-grid-3.9.mp4`、`tail-0.2.mp4`、`video12-audio11.8.mp4`），
 *   可用 `MNEMOSHELF_WAVE1_FIXTURES` 覆寫；
 * - 錯誤／慢速 fixture 存在：`.tmp/wave1/verify/fixtures`（`text-as-mp4.mp4`、
 *   `long-599s-64x64-30fps.mp4`），可用 `MNEMOSHELF_WAVE1_VERIFY_FIXTURES` 覆寫。
 * fixture 由 `.tmp/wave1/gen-fixtures.mjs` 等腳本以合成內容產生（不進版控、不含私人媒體）。
 *
 * 599 秒慢速測試（預設 skip；**實測需數分鐘**，原因見下）：
 * ```powershell
 * $env:MNEMOSHELF_FFMPEG_PATH  = (Resolve-Path ".tmp/video-a/decoder/bin/ffmpeg-n9.0.2-48-gd4070a14ce-win64-lgpl-9.0/bin/ffmpeg.exe").Path
 * $env:MNEMOSHELF_FFPROBE_PATH = (Resolve-Path ".tmp/video-a/decoder/bin/ffmpeg-n9.0.2-48-gd4070a14ce-win64-lgpl-9.0/bin/ffprobe.exe").Path
 * $env:MNEMOSHELF_SLOW_GATED = "1"
 * pnpm --filter @mnemoshelf/core exec vitest run test/media/video-process-budget.gated.test.ts
 * ```
 *
 * 為什麼慢：四個 root 同時競爭容量 1 的名額時，decoder 依契約在**每個段界**讓出（關閉程序、下一個
 * next() 以 -ss 恢復），599 秒／4 秒段＝每檔 150 段、四檔合計約 600 次 ffmpeg spawn（實測約
 * 0.2–0.4 秒／次）；這是「不得為了省 spawn 而預取未來片段」的預期代價，不是測試瑕疵。
 * 慢速測試 timeout 給 600 秒；快速版（短 fixture）仍維持 30–120 秒。
 */
import childProcess from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DecodeBudgetStats, DecodeProcessBudget } from "../../src/media/decode-budget.js";
import type { Embedder, Root } from "../../src/index.js";
import type { EmbedDocumentsOptions, VideoInput } from "../../src/ports/embedder.js";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, "../../../..");
const workspaceTmp = path.join(repoRoot, ".tmp");

const ffmpegPath = process.env.MNEMOSHELF_FFMPEG_PATH ?? "";
const ffprobePath = process.env.MNEMOSHELF_FFPROBE_PATH ?? "";
const fastFixturesDir = process.env.MNEMOSHELF_WAVE1_FIXTURES ?? path.join(workspaceTmp, "wave1", "fixtures");
const verifyFixturesDir = process.env.MNEMOSHELF_WAVE1_VERIFY_FIXTURES ?? path.join(workspaceTmp, "wave1", "verify", "fixtures");

/** 短 fixture（12–17 秒）供快速的四 root／公平性／取消／錯誤／重跑測試。 */
const FAST_FIXTURES = {
  long16: "tail-grid-16.2.mp4",
  mid12: "tail-grid-12.2.mp4",
  tail8: "tail-8.2.mp4",
  tiny39: "tail-grid-3.9.mp4",
  tiny02: "tail-0.2.mp4",
  withAudio: "video12-audio11.8.mp4",
} as const;
const SLOW_FIXTURE = "long-599s-64x64-30fps.mp4";
const TEXT_AS_MP4_FIXTURE = "text-as-mp4.mp4";

function fixtureAt(dir: string, name: string): string { return path.join(dir, name); }

const missingFastFixtures = Object.values(FAST_FIXTURES)
  .filter((name) => !existsSync(fixtureAt(fastFixturesDir, name)));
const missingVerifyFixtures = [TEXT_AS_MP4_FIXTURE]
  .filter((name) => !existsSync(fixtureAt(verifyFixturesDir, name)));
const gated = process.platform === "win32"
  && ffmpegPath.length > 0 && ffprobePath.length > 0
  && existsSync(ffmpegPath) && existsSync(ffprobePath)
  && missingFastFixtures.length === 0 && missingVerifyFixtures.length === 0;
const slowGated = gated
  && process.env.MNEMOSHELF_SLOW_GATED === "1"
  && existsSync(fixtureAt(verifyFixturesDir, SLOW_FIXTURE));

if (!gated) {
  const reasons: string[] = [];
  if (process.platform !== "win32") reasons.push("非 Windows x64");
  if (ffmpegPath.length === 0 || ffprobePath.length === 0) reasons.push("未設 MNEMOSHELF_FFMPEG_PATH／FFPROBE_PATH");
  else if (!existsSync(ffmpegPath) || !existsSync(ffprobePath)) reasons.push("ffmpeg／ffprobe 路徑不存在");
  if (missingFastFixtures.length > 0) reasons.push(`缺短 fixture：${missingFastFixtures.join("、")}（${fastFixturesDir}）`);
  if (missingVerifyFixtures.length > 0) reasons.push(`缺錯誤 fixture：${missingVerifyFixtures.join("、")}（${verifyFixturesDir}）`);
  console.info(`[video-process-budget] 整檔 skip：${reasons.join("；")}`);
}

// ---------------------------------------------------------------------------
// 程序追蹤：必須在載入產品模組之前 patch spawn。
// ---------------------------------------------------------------------------

type DecodeKind = "visual" | "audio";

interface TrackedSpawnEvent {
  type: "start" | "close";
  pid: number;
  kind: DecodeKind;
  live: number;
  at: number;
}

interface ProcessTracker {
  install(): void;
  liveCount(): number;
  livePids(): number[];
  readonly peak: number;
  readonly peakVisual: number;
  readonly peakAudio: number;
  readonly spawns: { visual: number; audio: number };
  readonly events: TrackedSpawnEvent[];
  reset(): void;
  waitForDrain(timeoutMs: number): Promise<boolean>;
}

function createProcessTracker(): ProcessTracker {
  const live = new Map<number, { kind: DecodeKind; startedAt: number }>();
  const events: TrackedSpawnEvent[] = [];
  const spawns = { visual: 0, audio: 0 };
  let peak = 0;
  let peakVisual = 0;
  let peakAudio = 0;
  let installed = false;

  const tracker: ProcessTracker = {
    install() {
      if (installed) return;
      installed = true;
      const module = childProcess as unknown as { spawn: (...args: unknown[]) => unknown };
      const originalSpawn = module.spawn;
      module.spawn = function patchedSpawn(...args: unknown[]): unknown {
        const child = originalSpawn.apply(module, args) as {
          pid?: number;
          once(event: "close", listener: () => void): void;
        };
        const command = String(args[0] ?? "");
        const argv = Array.isArray(args[1]) ? (args[1] as unknown[]).map(String) : [];
        const baseName = path.basename(command).toLowerCase();
        const isFfmpeg = baseName === "ffmpeg.exe" || baseName === "ffmpeg";
        const kind: DecodeKind | null = !isFfmpeg
          ? null
          : argv.includes("f32le")
            ? "audio"
            : argv.includes("rawvideo")
              ? "visual"
              : null;
        if (kind !== null && typeof child.pid === "number") {
          const pid = child.pid;
          live.set(pid, { kind, startedAt: performance.now() });
          spawns[kind] += 1;
          peak = Math.max(peak, live.size);
          if (kind === "visual") peakVisual = Math.max(peakVisual, live.size);
          if (kind === "audio") peakAudio = Math.max(peakAudio, live.size);
          events.push({ type: "start", pid, kind, live: live.size, at: performance.now() });
          child.once("close", () => {
            live.delete(pid);
            events.push({ type: "close", pid, kind, live: live.size, at: performance.now() });
          });
        }
        return child;
      };
      syncBuiltinESMExports();
    },
    liveCount() { return live.size; },
    livePids() { return [...live.keys()]; },
    get peak() { return peak; },
    get peakVisual() { return peakVisual; },
    get peakAudio() { return peakAudio; },
    spawns,
    events,
    reset() {
      // 每個測試重新計數；live 集合不重設（正常情況下上一個測試已 drain，非空代表殘留，
      // 下一個測試會以 liveAfter 斷言抓到）。
      events.length = 0;
      spawns.visual = 0;
      spawns.audio = 0;
      peak = 0;
      peakVisual = 0;
      peakAudio = 0;
    },
    async waitForDrain(timeoutMs: number) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (live.size === 0) return true;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return live.size === 0;
    },
  };
  return tracker;
}

const tracker = createProcessTracker();

// ---------------------------------------------------------------------------
// 產品模組：patch 完成後才動態載入（ESM live binding 才會是新 spawn）。
// ---------------------------------------------------------------------------

interface Products {
  indexRoot: typeof import("../../src/index.js").indexRoot;
  openDatabase: typeof import("../../src/index.js").openDatabase;
  SqliteMetadataStore: typeof import("../../src/index.js").SqliteMetadataStore;
  SqliteVectorIndex: typeof import("../../src/index.js").SqliteVectorIndex;
  FakeEmbedder: typeof import("../../src/testing/fake-embedder.js").FakeEmbedder;
  FfmpegMediaDecoder: typeof import("../../src/media/index.js").FfmpegMediaDecoder;
  DecodeProcessBudget: typeof import("../../src/media/decode-budget.js").DecodeProcessBudget;
}

let products: Products | null = null;
if (gated) {
  tracker.install();
  products = {
    ...(await import("../../src/index.js")),
    ...(await import("../../src/testing/fake-embedder.js")),
    ...(await import("../../src/media/index.js")),
    ...(await import("../../src/media/decode-budget.js")),
  } as unknown as Products;
}

function requireProducts(): Products {
  if (products === null) throw new Error("D4 gated 測試未啟用：需要 Windows＋ffmpeg env＋fixtures");
  return products;
}

type Store = InstanceType<typeof import("../../src/index.js").SqliteMetadataStore>;
type VectorStore = InstanceType<typeof import("../../src/index.js").SqliteVectorIndex>;
type Decoder = InstanceType<Products["FfmpegMediaDecoder"]>;
type Budget = InstanceType<Products["DecodeProcessBudget"]>;
type EmbedderInstance = InstanceType<Products["FakeEmbedder"]>;
type IndexResult = Awaited<ReturnType<Products["indexRoot"]>>;

// ---------------------------------------------------------------------------
// 共用測試夾具
// ---------------------------------------------------------------------------

interface Gate {
  readonly promise: Promise<void>;
  resolve(): void;
}

function openGate(): Gate {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve: () => resolve() };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`逾時（${String(timeoutMs)}ms）：${message}`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function abortError(): Error {
  const error = new Error("測試取消");
  error.name = "AbortError";
  return error;
}

/** 等到 signal abort（已 abort 或 undefined 時立刻回）。 */
function waitForAbort(signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined || signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => { signal.addEventListener("abort", () => resolve(), { once: true }); });
}

/**
 * 每個 root 的「第一次嵌入」都先被擋住（仿 .tmp/wave1-concurrency-repro.mjs）。
 *
 * 修正後 decoder 程序名額容量 1：正常只有第一個 root 會抵達第一次嵌入，其他 root 卡在
 * decoder 名額佇列；因此 expected=roots.length 在修正後**通常不會**達成，靠 timeout 放行。
 * 只有舊 bug（四個 ffmpeg 同時存活）才會在 timeout 前四個 root 都到齊——這是刻意保留的
 * 對照：若 firstEmbeds 在短時間內等於 roots.length，代表程序名額失效。
 */
interface FirstEmbedGate {
  firstEmbeds(): number;
  release(): void;
  dispose(): void;
}

function installFirstEmbedGate(embedder: EmbedderInstance, options: { expected: number; timeoutMs: number }): FirstEmbedGate {
  const gate = openGate();
  const seen = new Set<AbortSignal | undefined>();
  let firstEmbeds = 0;
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    gate.resolve();
  };
  const timer = setTimeout(release, options.timeoutMs);
  const original = embedder.embedVideo!.bind(embedder);
  embedder.embedVideo = async (input, opts) => {
    const key = opts?.signal;
    if (!seen.has(key)) {
      seen.add(key);
      firstEmbeds += 1;
      if (firstEmbeds >= options.expected) release();
      await gate.promise;
    }
    return original(input, opts);
  };
  return {
    firstEmbeds: () => firstEmbeds,
    release,
    dispose: () => { clearTimeout(timer); release(); },
  };
}

/** 讀 decoder 的預算統計；task-20 未落地時給出明確訊息（失敗屬預期）。 */
interface DecoderBudgetApi {
  budgetStats?: () => DecodeBudgetStats;
  decodeBudget?: Budget;
}

function decoderBudgetStats(decoder: Decoder): DecodeBudgetStats {
  const api = decoder as unknown as DecoderBudgetApi;
  if (typeof api.budgetStats !== "function") {
    throw new Error("FfmpegMediaDecoder 尚未提供 budgetStats()／decodeBudget（task-20 D4 未完成）");
  }
  const stats = api.budgetStats();
  if (api.decodeBudget === undefined) throw new Error("FfmpegMediaDecoder 尚未提供 decodeBudget 屬性（task-20 D4）");
  expect(api.decodeBudget.stats(), "budgetStats() 應與 decodeBudget.stats() 一致").toEqual(stats);
  return stats;
}

function expectBudgetIdle(stats: DecodeBudgetStats, label: string): void {
  expect(stats.capacity, `${label}：capacity`).toBe(1);
  expect(stats.active, `${label}：所有路徑結束後 active 必須歸零`).toBe(0);
  expect(stats.waiting, `${label}：所有路徑結束後 waiting 必須歸零`).toBe(0);
}

interface TestState {
  workDir: string;
  db: ReturnType<Products["openDatabase"]>;
  store: Store;
  vec: VectorStore;
}

let state: TestState | null = null;

beforeEach(async () => {
  if (!gated) return;
  const p = requireProducts();
  await fs.mkdir(path.join(workspaceTmp, "wave1"), { recursive: true });
  const workDir = await fs.mkdtemp(path.join(workspaceTmp, "wave1", "d4-"));
  const db = p.openDatabase(":memory:");
  const store = new p.SqliteMetadataStore(db);
  await store.migrate();
  const vec = new p.SqliteVectorIndex(db);
  state = { workDir, db, store, vec };
  // 上一個測試若有殘留（失敗路徑），先等它回收再把計數歸零，避免污染下一個測試的量測。
  await tracker.waitForDrain(10_000);
  tracker.reset();
});

afterEach(async () => {
  if (state !== null) {
    state.db.close();
    await fs.rm(state.workDir, { recursive: true, force: true });
    state = null;
  }
});

function requireState(): TestState {
  if (state === null) throw new Error("gated 測試未初始化");
  return state;
}

function newBudget(): Budget {
  return new (requireProducts().DecodeProcessBudget)(1);
}

function instantiateDecoder(budget: Budget): Decoder {
  const p = requireProducts();
  // task-20 之前 constructor 沒有 budget 選項；用 cast 讓測試在實作前也能編譯（執行期會自然失敗）。
  const options = { ffmpegPath, ffprobePath, budget } as unknown as ConstructorParameters<typeof p.FfmpegMediaDecoder>[0];
  return new p.FfmpegMediaDecoder(options);
}

function newEmbedder(options: { audio?: boolean } = {}): EmbedderInstance {
  const p = requireProducts();
  return new p.FakeEmbedder({ video: true, audio: options.audio === true });
}

async function addFixtureRoot(options: {
  dirName: string;
  fixtureName: string;
  fixturesDir?: string;
  targetName?: string;
  modalities: Root["modalities"];
}): Promise<Root> {
  const st = requireState();
  const rootDir = path.join(st.workDir, options.dirName);
  await fs.mkdir(rootDir, { recursive: true });
  const target = path.join(rootDir, options.targetName ?? "clip.mp4");
  await fs.copyFile(fixtureAt(options.fixturesDir ?? fastFixturesDir, options.fixtureName), target);
  return st.store.addRoot({
    path: rootDir,
    mode: "index",
    modalities: options.modalities,
    include: [],
    exclude: [],
    respectGitignore: false,
    watch: false,
  });
}

interface ConcurrentRun {
  results: IndexResult[];
  roots: Root[];
  budgetStats: DecodeBudgetStats;
  decoderStats: DecodeBudgetStats;
  liveAfter: number;
  firstEmbeds: number;
  budget: Budget;
  decoder: Decoder;
  embedder: EmbedderInstance;
  videoEmbeds: number;
  audioEmbeds: number;
}

/**
 * 四（或 N）個 roots 同時 indexRoot、共用同一個 decoder／embedder，gate 每個 root 的第一次嵌入。
 *
 * 修正後的 decoder 程序名額容量 1：只有第一個 root 能走到嵌入，其餘會卡在 decoder 的名額佇列；
 * 因此 firstEmbeds 正常只到 1，gate 靠 1.2 秒 timeout 放行（不是「全部到齊」才放行）。
 * 舊行為（可同時 4 個 ffmpeg）才會四個 root 同時抵達嵌入、在 timeout 前到齊（peak=4）。
 */
async function runConcurrentRoots(options: {
  fixtures: readonly string[];
  fixturesDir?: string;
  modalities: ("text" | "code" | "image" | "audio" | "video")[];
  gateTimeoutMs: number;
}): Promise<ConcurrentRun> {
  const p = requireProducts();
  const st = requireState();
  const budget = newBudget();
  const decoder = instantiateDecoder(budget);
  const embedder = newEmbedder({ audio: options.modalities.includes("audio") });
  let videoEmbeds = 0;
  let audioEmbeds = 0;
  const originalVideo = embedder.embedVideo!.bind(embedder);
  embedder.embedVideo = async (input, opts) => { videoEmbeds += 1; return originalVideo(input, opts); };
  const originalAudio = embedder.embedAudio!.bind(embedder);
  embedder.embedAudio = async (input, opts) => { audioEmbeds += 1; return originalAudio(input, opts); };

  const roots: Root[] = [];
  for (let index = 0; index < options.fixtures.length; index += 1) {
    roots.push(await addFixtureRoot({
      dirName: `root-${String(index)}`,
      fixtureName: options.fixtures[index]!,
      ...(options.fixturesDir === undefined ? {} : { fixturesDir: options.fixturesDir }),
      modalities: options.modalities,
    }));
  }

  // expected=roots.length 是「舊 bug 的到齊條件」；修正後正常靠 gateTimeoutMs 放行。
  const gate = installFirstEmbedGate(embedder, { expected: roots.length, timeoutMs: options.gateTimeoutMs });
  try {
    const results = await Promise.all(roots.map((root) => p.indexRoot(root, {
      store: st.store, vec: st.vec, embedder, decoder,
    })));
    const drained = await tracker.waitForDrain(20_000);
    // close 事件 → lease.release() 的收尾（若有）在事件迴圈下一輪；再等一格讓 stats 穩定。
    await new Promise((resolve) => setTimeout(resolve, 50));
    return {
      results,
      roots,
      budgetStats: budget.stats(),
      decoderStats: decoderBudgetStats(decoder),
      liveAfter: drained ? tracker.liveCount() : tracker.liveCount(),
      firstEmbeds: gate.firstEmbeds(),
      budget, decoder, embedder, videoEmbeds, audioEmbeds,
    };
  } finally {
    gate.dispose();
  }
}

// ---------------------------------------------------------------------------
// A／F：四 roots 同時索引（短 fixture 快速版）
// ---------------------------------------------------------------------------

describe.skipIf(!gated)("D4 gated：解碼程序生命週期預算（真 ffmpeg）", () => {
  it("四個 roots 同時索引：同時存活的解碼 ffmpeg ≤1、結束無殘留、budget 歸零", async () => {
    const run = await runConcurrentRoots({
      fixtures: [FAST_FIXTURES.long16, FAST_FIXTURES.mid12, FAST_FIXTURES.tail8, FAST_FIXTURES.tiny39],
      modalities: ["video"],
      gateTimeoutMs: 1200,
    });

    expect(run.firstEmbeds, "至少第一個 root 應走到第一次嵌入").toBeGreaterThanOrEqual(1);
    expect(run.results.map((result) => result.processed)).toEqual([1, 1, 1, 1]);
    expect(run.results.flatMap((result) => result.failedFiles)).toEqual([]);
    // 16.2→5 段、12.2→4 段、8.2→3 段、3.9→1 段（以 DB 實存 chunk 數對帳）。
    const st = requireState();
    const chunkCounts = await Promise.all(run.roots.map(async (root) => (await st.store.listChunksByPath(root.id, "clip.mp4")).length));
    expect(chunkCounts).toEqual([5, 4, 3, 1]);

    expect(tracker.peak, `live 事件：${JSON.stringify(tracker.events)}`).toBeLessThanOrEqual(1);
    expect(tracker.peak, "至少應實際 spawn 過解碼程序（否則量測無意義）").toBeGreaterThanOrEqual(1);
    expect(run.liveAfter, `殘留 pid：${tracker.livePids().join(",")}`).toBe(0);
    expectBudgetIdle(run.budgetStats, "注入的 budget");
    expectBudgetIdle(run.decoderStats, "decoder.budgetStats()");
    expect(run.budgetStats.granted, "應該真的取得過名額").toBeGreaterThan(0);
  }, 60_000);

  it("音訊：四個 roots 都有音軌時 rawvideo＋f32le 峰值 ≤1、全部完成、budget 歸零", async () => {
    const run = await runConcurrentRoots({
      fixtures: [FAST_FIXTURES.withAudio, FAST_FIXTURES.withAudio, FAST_FIXTURES.withAudio, FAST_FIXTURES.withAudio],
      modalities: ["video", "audio"],
      gateTimeoutMs: 1200,
    });

    expect(run.results.map((result) => result.processed)).toEqual([1, 1, 1, 1]);
    expect(run.results.flatMap((result) => result.failedFiles)).toEqual([]);
    expect(run.results.flatMap((result) => result.skippedFiles)).toEqual([]);
    // 12.0 秒畫面 → 3 段／檔；11.8 秒音軌 → 2 段／檔。
    expect(run.videoEmbeds).toBe(12);
    expect(run.audioEmbeds).toBe(8);

    expect(tracker.peak, `live 事件：${JSON.stringify(tracker.events)}`).toBeLessThanOrEqual(1);
    expect(tracker.peakVisual).toBeLessThanOrEqual(1);
    expect(tracker.peakAudio).toBeLessThanOrEqual(1);
    expect(run.liveAfter, `殘留 pid：${tracker.livePids().join(",")}`).toBe(0);
    expectBudgetIdle(run.budgetStats, "音軌情境 budget");
    expectBudgetIdle(run.decoderStats, "音軌情境 decoder.budgetStats()");
  }, 120_000);

// ---------------------------------------------------------------------------
// B：公平性（長片 ≥5 段 vs 0.2 秒短片）
// ---------------------------------------------------------------------------

  it("公平性：0.2 秒短片可在長片第一次嵌入被擋住時完成整個索引", async () => {
    const p = requireProducts();
    const st = requireState();
    const longRoot = await addFixtureRoot({
      dirName: "long",
      fixtureName: FAST_FIXTURES.long16,
      targetName: "long.mp4",
      modalities: ["video"],
    });
    const shortRoot = await addFixtureRoot({
      dirName: "short",
      fixtureName: FAST_FIXTURES.tiny02,
      targetName: "short.mp4",
      modalities: ["video"],
    });

    const budget = newBudget();
    const decoder = instantiateDecoder(budget);
    const embedder = newEmbedder();
    const longController = new AbortController();
    const shortController = new AbortController();

    const longFirstEmbed = openGate();
    const longHold = openGate();
    const original = embedder.embedVideo!.bind(embedder);
    let longGated = false;
    embedder.embedVideo = async (input, opts) => {
      if (!longGated && opts?.signal === longController.signal) {
        longGated = true;
        longFirstEmbed.resolve();
        await longHold.promise;
      }
      return original(input, opts);
    };

    let longSettled = false;
    const longPromise = p.indexRoot(longRoot, {
      store: st.store, vec: st.vec, embedder, decoder, signal: longController.signal,
    }).finally(() => { longSettled = true; });

    // 長片的第一段已解碼、正卡在嵌入（它的 ffmpeg 依設計會被名額等待者要求讓出）。
    await withTimeout(longFirstEmbed.promise, 20_000, "長片未到達第一次嵌入");
    // 短片必須能在長片仍被擋住時完成整個索引（不能靠延後長片讓路）。
    const shortResult = await withTimeout(
      p.indexRoot(shortRoot, { store: st.store, vec: st.vec, embedder, decoder, signal: shortController.signal }),
      30_000,
      "短片未能在長片被擋住期間完成整個索引",
    );
    expect(longSettled, "短片完成時長片應仍在進行中").toBe(false);
    expect(shortResult.processed).toBe(1);
    expect(shortResult.skippedFiles).toEqual([]);
    expect(shortResult.failedFiles).toEqual([]);

    longHold.resolve();
    const longResult = await withTimeout(longPromise, 60_000, "長片未在解除 gate 後完成");
    expect(longResult.processed).toBe(1);
    expect(longResult.failedFiles).toEqual([]);

    expect(await tracker.waitForDrain(20_000)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(tracker.peak, `live 事件：${JSON.stringify(tracker.events)}`).toBeLessThanOrEqual(1);
    expect(tracker.liveCount()).toBe(0);
    expectBudgetIdle(budget.stats(), "公平性 budget");
    expectBudgetIdle(decoderBudgetStats(decoder), "公平性 decoder.budgetStats()");
  }, 90_000);

// ---------------------------------------------------------------------------
// C：取消（embed 等待中／解碼進行中）
// ---------------------------------------------------------------------------

  it("取消：embed 等待中 abort → 程序全關、不寫入、budget 歸零、重跑成功", async () => {
    const p = requireProducts();
    const st = requireState();
    const root = await addFixtureRoot({
      dirName: "cancel-embed",
      fixtureName: FAST_FIXTURES.long16,
      modalities: ["video"],
    });
    const budget = newBudget();
    const decoder = instantiateDecoder(budget);
    const embedder = newEmbedder();
    const controller = new AbortController();
    const embedStarted = openGate();
    embedder.embedVideo = async (_input, opts) => {
      embedStarted.resolve();
      await waitForAbort(opts?.signal);
      throw abortError();
    };

    const run = p.indexRoot(root, { store: st.store, vec: st.vec, embedder, decoder, signal: controller.signal });
    await withTimeout(embedStarted.promise, 20_000, "未到達第一次嵌入");
    controller.abort();
    await expect(run).rejects.toMatchObject({ name: "AbortError" });

    expect(await tracker.waitForDrain(20_000), `殘留 pid：${tracker.livePids().join(",")}`).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(tracker.liveCount()).toBe(0);
    expect(await st.store.listChunksByPath(root.id, "clip.mp4")).toEqual([]);
    expectBudgetIdle(budget.stats(), "取消（embed）budget");
    expectBudgetIdle(decoderBudgetStats(decoder), "取消（embed）decoder.budgetStats()");

    // 重跑成功（新 decoder／budget 實例，避免吃上一輪的殘留狀態）。
    const rerunBudget = newBudget();
    const rerunDecoder = instantiateDecoder(rerunBudget);
    const rerun = await p.indexRoot(root, { store: st.store, vec: st.vec, embedder: newEmbedder(), decoder: rerunDecoder });
    expect(rerun.processed).toBe(1);
    expect(rerun.failedFiles).toEqual([]);
    expect(await tracker.waitForDrain(20_000)).toBe(true);
    expectBudgetIdle(rerunBudget.stats(), "取消後重跑 budget");
    expectBudgetIdle(decoderBudgetStats(rerunDecoder), "取消後重跑 decoder.budgetStats()");
  }, 60_000);

  it("取消：解碼進行中 abort → 程序全關、不寫入、budget 歸零、重跑成功", async () => {
    const p = requireProducts();
    const st = requireState();
    const root = await addFixtureRoot({
      dirName: "cancel-decode",
      fixtureName: FAST_FIXTURES.long16,
      modalities: ["video"],
    });
    const budget = newBudget();
    const decoder = instantiateDecoder(budget);
    const embedder = newEmbedder();
    const controller = new AbortController();

    // 「解碼進行中」：在 prepare（probe 完成、即將開始 lazy 解碼）後的下一個 tick abort，
    // 讓取消落在 decoder 已 spawn／正在解碼的階段（與 C1 的「等待嵌入被擋住」區分）。
    let cancelledDuringDecodePhase = false;
    await expect(p.indexRoot(root, {
      store: st.store,
      vec: st.vec,
      embedder,
      decoder,
      signal: controller.signal,
      onTiming: (event) => {
        if (event.stage === "prepare" && !cancelledDuringDecodePhase) {
          cancelledDuringDecodePhase = true;
          setTimeout(() => controller.abort(), 0);
        }
      },
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(cancelledDuringDecodePhase, "取消應發生在解碼階段").toBe(true);

    expect(await tracker.waitForDrain(20_000), `殘留 pid：${tracker.livePids().join(",")}`).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(tracker.liveCount()).toBe(0);
    expect(await st.store.listChunksByPath(root.id, "clip.mp4")).toEqual([]);
    expectBudgetIdle(budget.stats(), "取消（decode）budget");
    expectBudgetIdle(decoderBudgetStats(decoder), "取消（decode）decoder.budgetStats()");

    const rerunBudget = newBudget();
    const rerunDecoder = instantiateDecoder(rerunBudget);
    const rerun = await p.indexRoot(root, { store: st.store, vec: st.vec, embedder: newEmbedder(), decoder: rerunDecoder });
    expect(rerun.processed).toBe(1);
    expect(rerun.failedFiles).toEqual([]);
    expect(await tracker.waitForDrain(20_000)).toBe(true);
    expectBudgetIdle(rerunBudget.stats(), "解碼取消後重跑 budget");
  }, 60_000);

// ---------------------------------------------------------------------------
// D：錯誤（text-as-mp4 與正常 root 並行）
// ---------------------------------------------------------------------------

  it("錯誤：text-as-mp4 與正常 root 並行 → 具名 skip、另一 root 完成、程序全關", async () => {
    const p = requireProducts();
    const st = requireState();
    const badRoot = await addFixtureRoot({
      dirName: "bad-media",
      fixtureName: TEXT_AS_MP4_FIXTURE,
      fixturesDir: verifyFixturesDir,
      targetName: "bad.mp4",
      modalities: ["video"],
    });
    const goodRoot = await addFixtureRoot({
      dirName: "good-media",
      fixtureName: FAST_FIXTURES.tail8,
      modalities: ["video"],
    });
    const budget = newBudget();
    const decoder = instantiateDecoder(budget);
    const embedder = newEmbedder();

    const [badResult, goodResult] = await Promise.all([
      p.indexRoot(badRoot, { store: st.store, vec: st.vec, embedder, decoder }),
      p.indexRoot(goodRoot, { store: st.store, vec: st.vec, embedder, decoder }),
    ]);

    expect(goodResult.processed).toBe(1);
    expect(goodResult.failedFiles).toEqual([]);
    expect(goodResult.skippedFiles).toEqual([]);
    expect(badResult.processed).toBe(0);
    expect(badResult.failedFiles, "壞檔必須是具名 skip，不能記 failed").toEqual([]);
    expect(badResult.skippedFiles).toHaveLength(1);
    expect(badResult.skippedFiles[0]!.relPath).toBe("bad.mp4");
    expect(
      ["invalid-video", "unsupported-video-container", "unsupported-video-codec", "video-no-stream", "unsupported-video-format"],
      `實際 skip 原因：${String(badResult.skippedFiles[0]!.reason)}`,
    ).toContain(badResult.skippedFiles[0]!.reason);

    expect(await tracker.waitForDrain(20_000), `殘留 pid：${tracker.livePids().join(",")}`).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(tracker.peak).toBeLessThanOrEqual(1);
    expect(tracker.liveCount()).toBe(0);
    expectBudgetIdle(budget.stats(), "錯誤情境 budget");
    expectBudgetIdle(decoderBudgetStats(decoder), "錯誤情境 decoder.budgetStats()");
  }, 60_000);

// ---------------------------------------------------------------------------
// E：重跑不重解碼
// ---------------------------------------------------------------------------

  it("重跑：同 hash 再索引 unchanged，不再 spawn 解碼程序", async () => {
    const p = requireProducts();
    const st = requireState();
    const root = await addFixtureRoot({
      dirName: "rerun",
      fixtureName: FAST_FIXTURES.mid12,
      modalities: ["video"],
    });
    const budget = newBudget();
    const decoder = instantiateDecoder(budget);
    const embedder = newEmbedder();

    const first = await p.indexRoot(root, { store: st.store, vec: st.vec, embedder, decoder });
    expect(first.processed).toBe(1);
    expect(first.failedFiles).toEqual([]);
    const spawnsAfterFirst = { ...tracker.spawns };
    const grantedAfterFirst = budget.stats().granted;
    expect(spawnsAfterFirst.visual, "第一次索引應真的 spawn 解碼程序").toBeGreaterThan(0);

    const second = await p.indexRoot(root, { store: st.store, vec: st.vec, embedder, decoder });
    expect(second.skippedUnchanged).toBe(1);
    expect(second.processed).toBe(0);
    expect({ ...tracker.spawns }, "unchanged 不得再 spawn 解碼程序").toEqual(spawnsAfterFirst);
    expect(budget.stats().granted, "unchanged 不得再取得解碼名額").toBe(grantedAfterFirst);

    expect(await tracker.waitForDrain(20_000)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(tracker.liveCount()).toBe(0);
    expectBudgetIdle(budget.stats(), "重跑 budget");
    expectBudgetIdle(decoderBudgetStats(decoder), "重跑 decoder.budgetStats()");
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 慢速（599 秒 ×4）：預設 skip，verifier 以 MNEMOSHELF_SLOW_GATED=1 跑一次。
// ---------------------------------------------------------------------------

describe.skipIf(!gated)("D4 gated 慢速：599 秒四 root（需 MNEMOSHELF_SLOW_GATED=1）", () => {
  it.skipIf(!slowGated)("四個 roots 各 599 秒影片：峰值 ≤1、全部完成、budget 歸零", async () => {
    const run = await runConcurrentRoots({
      fixtures: [SLOW_FIXTURE, SLOW_FIXTURE, SLOW_FIXTURE, SLOW_FIXTURE],
      fixturesDir: verifyFixturesDir,
      modalities: ["video"],
      gateTimeoutMs: 3000,
    });

    expect(run.results.map((result) => result.processed)).toEqual([1, 1, 1, 1]);
    expect(run.results.flatMap((result) => result.failedFiles)).toEqual([]);
    expect(run.results.flatMap((result) => result.skippedFiles)).toEqual([]);
    // 599 秒／4 秒段 → 每檔 150 段（以 DB 實存 chunk 數對帳）。
    const st = requireState();
    const chunkCounts = await Promise.all(run.roots.map(async (root) => (await st.store.listChunksByPath(root.id, "clip.mp4")).length));
    expect(chunkCounts).toEqual([150, 150, 150, 150]);
    expect(tracker.peak, `live 事件（前 40 筆）：${JSON.stringify(tracker.events.slice(0, 40))}`).toBeLessThanOrEqual(1);
    expect(tracker.peak).toBeGreaterThanOrEqual(1);
    expect(run.liveAfter, `殘留 pid：${tracker.livePids().join(",")}`).toBe(0);
    expectBudgetIdle(run.budgetStats, "599 秒 budget");
    expectBudgetIdle(run.decoderStats, "599 秒 decoder.budgetStats()");
  }, 600_000);
});
