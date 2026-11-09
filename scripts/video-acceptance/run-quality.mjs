#!/usr/bin/env node
/**
 * 影片索引里程碑（三）D1：真模型 24 題品質與混合目錄驗收 runner。
 *
 * 本 runner 走產品路徑；明確設定 VIDEO_ACCEPTANCE_RUN=1 才啟動真模型：
 *   產品 createServer（server dist，真 REST 127.0.0.1＋Bearer token）
 *   ＋ WorkersEmbedder（worker thread 內真 TransformersEmbedder，q4 模型快取）
 *   ＋ 真 FfmpegMediaDecoder（A1 static 候選）
 *   ＋ SQLite MetadataStore／VectorIndex
 *   ＋ 產品 unifiedSearch（POST /search，預設 vector 模式）
 *
 * 固定輸入：.tmp/video-a/corpus/labels/queries-frozen-v1.json（SHA256 於測前核對）
 * 與 .tmp/video-a/corpus/eval-root/ 的 10 支 MP4。題目、標註、門檻不動；逐題保留。
 *
 * 輸出及混合語料各自位於 .tmp/video-acceptance/runs/<runId>/。
 */
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, promises as fs } from "node:fs";
import { createServer } from "../../packages/server/dist/index.js";
import { FfmpegMediaDecoder } from "../../packages/core/dist/index.js";
import { createProbeImages } from "../../packages/embedder-transformers/dist/index.js";

// ---------------------------------------------------------------------------
// 路徑與常數（全部相對於 code repo 根；不寫死個人路徑）
// ---------------------------------------------------------------------------
const REPO_ROOT = process.cwd();
if (process.env.VIDEO_ACCEPTANCE_RUN !== "1") throw new Error("設定 VIDEO_ACCEPTANCE_RUN=1 才能執行真模型驗收");
const OUT_ROOT = path.join(REPO_ROOT, ".tmp", "video-acceptance");
const RUN_ID = process.env.VIDEO_ACCEPTANCE_RUN_ID ?? "run-" + Date.now() + "-" + randomBytes(4).toString("hex");
if (!/^[a-zA-Z0-9_-]+$/.test(RUN_ID)) throw new Error("runId 無效");
const RUN_DIR = path.join(OUT_ROOT, "runs", RUN_ID);
const REPORT_PATH = path.join(RUN_DIR, "report.json");
const LOG_PATH = path.join(RUN_DIR, "run.log");
const RSS_PATH = path.join(RUN_DIR, "rss-samples.json");

const MODEL_DIR = path.join(REPO_ROOT, ".tmp", "media-feasibility", "models");
const CORPUS_RUN_ID = process.env.VIDEO_QUALITY_CORPUS_RUN_ID;
if (CORPUS_RUN_ID && !/^[a-zA-Z0-9_-]+$/.test(CORPUS_RUN_ID)) throw new Error("語料 runId 無效");
const CORPUS_DIR = CORPUS_RUN_ID ? path.join(REPO_ROOT, ".tmp", "video-acceptance", "corpus", CORPUS_RUN_ID, "eval-root") : path.join(REPO_ROOT, ".tmp", "video-a", "corpus", "eval-root");
const LABELS_PATH = path.join(REPO_ROOT, "scripts", "video-acceptance", "queries-frozen-v1.json");
const FROZEN_LABELS_SHA256 = "846c102b582045a264388baed8ef458d5e7b1bb9278a368c73d2a564d2bece56";
const DECODER_BIN_DIR = path.join(
  REPO_ROOT, ".tmp", "video-a", "decoder", "bin", "ffmpeg-n9.0.2-48-gd4070a14ce-win64-lgpl-9.0", "bin",
);
const DATA_DIR = path.join(RUN_DIR, "data");
const MIXED_DIR = path.join(RUN_DIR, "mixed-root");
const AUDIO_FIXTURE_RUN_ID = process.env.VIDEO_AUDIO_FIXTURE_RUN_ID;
if (AUDIO_FIXTURE_RUN_ID && !/^[a-zA-Z0-9_-]+$/.test(AUDIO_FIXTURE_RUN_ID)) throw new Error("音訊 runId 無效");
const AUDIO_FIXTURE = AUDIO_FIXTURE_RUN_ID ? path.join(REPO_ROOT, ".tmp", "video-acceptance", "audio", AUDIO_FIXTURE_RUN_ID, "f04.wav") : path.join(REPO_ROOT, ".tmp", "audio-indexing-acceptance", "fixtures", "f04.wav");

const VIDEO_MAX_FILE_BYTES = 512 * 1024 * 1024;
const SEARCH_K = 10;
const TOKEN = randomBytes(24).toString("hex");

mkdirSync(path.dirname(RUN_DIR), { recursive: true });
mkdirSync(RUN_DIR);
const startedAt = new Date().toISOString();

// ---------------------------------------------------------------------------
// log／report（增量寫出，崩潰時仍保留已完成階段）
// ---------------------------------------------------------------------------
const logLines = [];
function log(...args) {
  const stamp = new Date().toISOString().slice(11, 23);
  const line = "[" + stamp + "] " + args
    .map((value) => (typeof value === "string" ? value : JSON.stringify(value)))
    .join(" ");
  console.log(line);
  logLines.push(line);
  try { appendFileSync(LOG_PATH, line + "\n"); } catch { /* 日誌失敗不影響驗收 */ }
}

const report = {
  runId: RUN_ID,
  executionEnvironment: process.env.VIDEO_ACCEPTANCE_ENVIRONMENT === "normal-permissions" ? "normal-permissions" : "sandbox-or-unspecified",
  startedAt,
  status: "running",
  environment: {},
  frozen: {},
  decoder: {},
  qualityRoot: {},
  queries24: {},
  negatives: {},
  evalRerun: {},
  mixedRoot: {},
  performance: {},
  notes: [],
};

function saveReport() {
  try {
    const serialized = JSON.stringify({ ...report, token: undefined }, null, 2);
    require_write(REPORT_PATH, serialized);
  } catch (error) {
    log("WARN 無法寫出 report.json", error instanceof Error ? error.message : String(error));
  }
}
// 同步寫檔（避免 finally 時序問題）
function require_write(filePath, content) {
  // eslint-disable-next-line no-restricted-syntax
  const fsSync = process.getBuiltinModule("node:fs");
  fsSync.writeFileSync(filePath, content, "utf8");
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------
function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
async function sha256File(filePath) {
  return sha256(await fs.readFile(filePath));
}
function countBy(values) {
  const out = {};
  for (const value of values) out[value] = (out[value] ?? 0) + 1;
  return out;
}
function unique(values) {
  return [...new Set(values)];
}
function round(value, digits = 3) {
  return typeof value === "number" && Number.isFinite(value) ? Number(value.toFixed(digits)) : value;
}
function stats(values) {
  if (values.length === 0) return { n: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
  return {
    n: sorted.length,
    min: round(sorted[0]),
    size: sorted[sorted.length - 1],
    median: round(at(0.5)),
    p95: round(at(0.95)),
    max: round(sorted[sorted.length - 1]),
    sum: round(sorted.reduce((sum, value) => sum + value, 0)),
    all: sorted.map((value) => round(value)),
  };
}
function rel(filePath) {
  return path.relative(REPO_ROOT, filePath).split(path.sep).join("/");
}

// ---------------------------------------------------------------------------
// HTTP（node:http，不設 client timeout；只打本機產品服務）
// ---------------------------------------------------------------------------
function httpJson(method, pathname, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, baseUrl + "/");
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), "utf8");
    const request = http.request(url, {
      method,
      headers: {
        authorization: "Bearer " + TOKEN,
        accept: "application/json",
        ...(payload === null ? {} : { "content-type": "application/json", "content-length": String(payload.length) }),
      },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let parsed = null;
        try { parsed = text === "" ? null : JSON.parse(text); } catch { parsed = { raw: text.slice(0, 500) }; }
        resolve({ status: response.statusCode ?? 0, body: parsed });
      });
    });
    request.on("error", reject);
    request.setTimeout(0);
    if (payload !== null) request.write(payload);
    request.end();
  });
}
async function expectOk(method, pathname, body) {
  const response = await httpJson(method, pathname, body);
  if (response.status < 200 || response.status >= 300) {
    throw new Error(method + " " + pathname + " 失敗 status=" + response.status + " body=" + JSON.stringify(response.body).slice(0, 500));
  }
  return response.body;
}

// 由 createServer 之後填入。
let baseUrl = "";

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
const rssSamples = [];
let rssPeak = 0;
let rssTimer = null;
let server = null;
let decoder = null;
const phaseMarks = {};

async function main() {
  log("=== D1 驗收開始 ===", { runId: RUN_ID, repoRoot: rel(REPO_ROOT), node: process.version });

  // 1) 固定輸入 preflight -------------------------------------------------
  report.buildHashes = {};
  for (const parts of [["packages", "core", "src", "indexer", "video.ts"], ["packages", "core", "src", "media", "ffmpeg-decoder.ts"], ["packages", "core", "dist", "indexer", "video.js"], ["packages", "core", "dist", "media", "ffmpeg-decoder.js"], ["packages", "server", "dist", "index.js"], ["packages", "server", "dist", "search.js"], ["packages", "server", "dist", "embedder-worker.js"], ["packages", "server", "dist", "worker-embedder.js"], ["packages", "embedder-transformers", "dist", "index.js"], ["packages", "embedder-transformers", "dist", "embedder.js"], ["scripts", "video-acceptance", "run-quality.mjs"], ["scripts", "video-acceptance", "relevance.mjs"], ["scripts", "video-acceptance", "process-observer.mjs"], ["scripts", "video-acceptance", "rss-sampler.ps1"]]) {
    const file = path.join(REPO_ROOT, ...parts);
    report.buildHashes[parts.join("/")] = await sha256File(file);
  }
  report.audioFixtureSha256 = await sha256File(AUDIO_FIXTURE);
  if (report.audioFixtureSha256 !== "c0fdef41a0af25c5bc4a16472c9cda1028ee150049c8293b715ea8712e6a0904") throw new Error("WAV fixture hash 不符");
  report.frozen = await preflight();
  if (report.frozen.ok !== true) {
    throw new Error("凍結輸入驗證失敗：" + JSON.stringify(report.frozen.failures));
  }
  saveReport();

  // 2) decoder（A1 static 候選）與 probe 10 支（記時長／codec；不進模型） ----
  decoder = new FfmpegMediaDecoder({
    ffmpegPath: path.join(DECODER_BIN_DIR, "ffmpeg.exe"),
    ffprobePath: path.join(DECODER_BIN_DIR, "ffprobe.exe"),
    limits: { maxSourceBytes: VIDEO_MAX_FILE_BYTES },
  });
  report.decoder = await probeDecoder();
  saveReport();

  // 3) 建混合目錄（10 支複本＋文字／圖片／WAV 合成 fixture） ----------------
  const mixedFixtures = await buildMixedRoot();
  saveReport();

  // 4) 啟動產品服務（真 server） -----------------------------------------
  await fs.mkdir(DATA_DIR, { recursive: true });
  process.env.MNEMOSHELF_EMBED_DEVICE = "cpu";
  process.env.MNEMOSHELF_MODEL_DIR = MODEL_DIR;

  rssTimer = setInterval(() => {
    const rss = process.memoryUsage().rss;
    rssSamples.push([Date.now(), rss]);
    if (rss > rssPeak) rssPeak = rss;
  }, 250);

  const serverStart = Date.now();
  server = await createServer({
    env: {
      MNEMOSHELF_MODEL_DIR: MODEL_DIR,
      MNEMOSHELF_EMBED_DEVICE: "cpu",
      MNEMOSHELF_MEMORY_BACKFILL: "off",
      MNEMOSHELF_AGENT_DISCOVERY: "off",
      MNEMOSHELF_INDEX_RATE: "off",
    },
    token: TOKEN,
    dataDir: DATA_DIR,
    port: 0,
    decoder,
    homeDir: os.homedir(),
  });
  baseUrl = server.url;
  log("產品服務已啟動（createServer）", { url: "http://127.0.0.1:<port>", startupMs: Date.now() - serverStart });

  const diag0 = await expectOk("GET", "/diagnostics");
  report.environment = environmentInfo(diag0);
  log("環境與能力", {
    node: report.environment.node,
    platform: report.environment.platform,
    arch: report.environment.arch,
    cpu: report.environment.cpuModel,
    cpuCount: report.environment.cpuCount,
    embedder: report.environment.embedder,
    video: { state: diag0.video?.state, reason: diag0.video?.reason, maxFileBytes: diag0.video?.maxFileBytes },
    decoder: { ffmpeg: diag0.video?.ffmpegVersion, ffprobe: diag0.video?.ffprobeVersion },
  });
  if (diag0.video?.state !== "available") {
    throw new Error("產品服務未宣告影片可用：" + JSON.stringify(diag0.video));
  }
  saveReport();

  // 5) eval-root：加入 root、preview、索引（輪詢首筆可搜尋） -----------------
  report.qualityRoot = await evaluateQualityRoot();
  report.environment.embedderRuntimeFinal = (await expectOk("GET", "/diagnostics")).embedderRuntime ?? null;
  saveReport();
  if (report.environment.embedderRuntimeFinal?.device !== "cpu" || report.environment.embedderRuntimeFinal?.loaded !== true) throw new Error("未確認真模型以 CPU 載入");

  // 6) 24 題固定題庫（產品 /search，預設 vector） --------------------------
  const labels = report.frozen.labels;
  report.queries24 = await runQualityQueries(labels, report.qualityRoot.root.id);
  report.negatives = evaluateNegatives(report.queries24);
  log("24 題結果", {
    recallAt3: report.queries24.metrics.recallAt3Overall,
    visual: report.queries24.metrics.recallAt3Visual,
    audio: report.queries24.metrics.recallAt3Audio,
    top1Correct: report.queries24.metrics.top1Correct,
    mrr: report.queries24.metrics.mrr,
    negativesTop1: report.negatives.violations.length,
  });
  saveReport();

  // 7) eval-root 未變重跑 ---------------------------------------------------
  report.evalRerun = await unchangedRerun(report.qualityRoot.root.id, "eval-root");
  saveReport();

  // 8) 混合目錄 ------------------------------------------------------------
  report.mixedRoot = await evaluateMixedRoot(mixedFixtures);
  saveReport();

  // 9) 驗收判定＋效能與完整性 ---------------------------------------------
  const qualityFailedFiles = report.qualityRoot.index?.failedFiles ?? [];
  const mixedFailedFiles = report.mixedRoot.index?.failedFiles ?? [];
  const recallPass = report.queries24.pass?.overall === true
    && report.queries24.pass?.visual === true
    && report.queries24.pass?.audio === true;
  const negativesPass = (report.negatives.violations ?? []).length === 0;
  report.acceptance = {
    qualityIndexComplete: qualityFailedFiles.length === 0,
    qualityIndexFailedFiles: qualityFailedFiles,
    mixedIndexFailedFiles: mixedFailedFiles,
    thresholds: {
      recallAt3: report.queries24.metrics?.recallAt3Overall ?? null,
      recallAt3Visual: report.queries24.metrics?.recallAt3Visual ?? null,
      recallAt3Audio: report.queries24.metrics?.recallAt3Audio ?? null,
      recallPass,
      negativesPass,
    },
    mixedQueriesFound: (report.mixedRoot.queries ?? []).filter((entry) => entry.expectedRank !== null).map((entry) => entry.name),
    mixedQueriesAllFound: (report.mixedRoot.queries ?? []).every((entry) => entry.expectedRank !== null),
    evalRerunNoReembed: report.evalRerun.noReembed === true,
    mixedRerunNoReembed: report.mixedRoot.rerun?.noReembed === true,
    incrementalOnlyModifiedFileRebuilt: report.mixedRoot.modification?.onlyModifiedFileRebuilt === true,
    vectorIntegrity: (report.mixedRoot.integrity?.missingVectorKeys === 0) && (report.mixedRoot.integrity?.orphanVectorCount === 0),
    frozenQualityPass: qualityFailedFiles.length === 0 && recallPass && negativesPass,
    mixedFlowPass: mixedFailedFiles.length === 0 && (report.mixedRoot.queries ?? []).length > 0 && (report.mixedRoot.queries ?? []).every((entry) => entry.expectedRank !== null) && report.mixedRoot.rerun?.noReembed === true && report.mixedRoot.modification?.onlyModifiedFileRebuilt === true && report.mixedRoot.integrity?.missingVectorKeys === 0 && report.mixedRoot.integrity?.orphanVectorCount === 0,
    officialPass: (report.mixedRoot.queries ?? []).length > 0
      && (report.mixedRoot.queries ?? []).every((entry) => entry.expectedRank !== null)
      && qualityFailedFiles.length === 0
      && mixedFailedFiles.length === 0
      && recallPass
      && negativesPass
      && (report.mixedRoot.integrity?.missingVectorKeys === 0
        && report.mixedRoot.integrity?.orphanVectorCount === 0),
  };
  report.performance = finalPerformance();
  report.status = report.acceptance.officialPass && report.acceptance.mixedFlowPass ? "ok" : "ok-with-issues";
  if (report.status !== "ok") process.exitCode = 1;
  log("驗收判定", report.acceptance);
  log("=== D1 驗收完成 ===", { status: report.status, elapsedSeconds: round((Date.now() - Date.parse(startedAt)) / 1000, 1) });
}

// ---------------------------------------------------------------------------
// 1) preflight
// ---------------------------------------------------------------------------
async function preflight() {
  const frozen = {
    labelsPath: rel(LABELS_PATH),
    expectedLabelsSha256: FROZEN_LABELS_SHA256,
    labelsSha256: null,
    labelsMatch: false,
    corpusDir: rel(CORPUS_DIR),
    files: [],
    failures: [],
    ok: false,
    labels: null,
  };
  if (!existsSync(LABELS_PATH)) throw new Error("缺少凍結 labels 檔：" + frozen.labelsPath);
  frozen.labelsSha256 = await sha256File(LABELS_PATH);
  frozen.labelsMatch = frozen.labelsSha256 === FROZEN_LABELS_SHA256;
  if (!frozen.labelsMatch) frozen.failures.push("labels SHA256 與凍結值不符");

  const labels = JSON.parse(await fs.readFile(LABELS_PATH, "utf8"));
  frozen.labels = labels;

  const expected = labels.evaluationRoot?.files ?? [];
  const actualNames = (await fs.readdir(CORPUS_DIR)).sort();
  const expectedNames = expected.map((entry) => entry.file).sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    frozen.failures.push("eval-root 檔案清單與凍結清單不符（實際 " + JSON.stringify(actualNames) + "）");
  }
  for (const entry of expected) {
    const abs = path.join(CORPUS_DIR, entry.file);
    const item = {
      file: entry.file,
      role: entry.role,
      expectedSha256: entry.sha256,
      sha256: null,
      bytes: null,
      match: false,
    };
    if (!existsSync(abs)) {
      frozen.failures.push(entry.file + " 不存在");
      frozen.files.push(item);
      continue;
    }
    const bytes = await fs.readFile(abs);
    item.bytes = bytes.length;
    item.sha256 = sha256(bytes);
    item.match = item.sha256 === entry.sha256;
    if (!item.match) frozen.failures.push(entry.file + " SHA256 不符");
    frozen.files.push(item);
  }
  frozen.queryCount = (labels.queries ?? []).length;
  frozen.negativeCount = (labels.negativeControls ?? []).length;
  frozen.thresholds = labels.thresholds;
  frozen.tolerance = labels.tolerance;
  frozen.ok = frozen.failures.length === 0;
  log("preflight 凍結輸入", {
    labelsSha256: frozen.labelsSha256,
    labelsMatch: frozen.labelsMatch,
    files: frozen.files.length,
    filesMatch: frozen.files.every((file) => file.match),
    queries: frozen.queryCount,
    negatives: frozen.negativeCount,
    failures: frozen.failures,
  });
  return frozen;
}

// ---------------------------------------------------------------------------
// 2) decoder probe（10 支）
// ---------------------------------------------------------------------------
async function probeDecoder() {
  const availability = await decoder.checkAvailability();
  const result = {
    binDir: rel(DECODER_BIN_DIR),
    ffmpegVersion: availability.ffmpegVersion,
    ffprobeVersion: availability.ffprobeVersion,
    available: availability.available,
    probes: [],
  };
  if (!availability.available) throw new Error("decoder 不可用：" + JSON.stringify(availability));
  for (const entry of report.frozen.files) {
    const abs = path.join(CORPUS_DIR, entry.file);
    const t0 = performance.now();
    const probe = await decoder.probe({ path: abs });
    result.probes.push({
      file: entry.file,
      probeMs: round(performance.now() - t0),
      durationSeconds: probe.durationSeconds,
      sourceStartSeconds: probe.sourceStartSeconds,
      video: probe.video === null ? null : {
        codec: probe.video.codec,
        width: probe.video.width,
        height: probe.video.height,
        rotationDegrees: probe.video.rotationDegrees,
        avgFrameRate: probe.video.avgFrameRate,
        rFrameRate: probe.video.rFrameRate,
      },
      hasAudio: probe.hasAudio,
      selectedAudio: probe.selectedAudio === null ? null : {
        streamIndex: probe.selectedAudio.streamIndex,
        codec: probe.selectedAudio.codec,
        isAac: probe.selectedAudio.isAac,
      },
      audioStreamCount: probe.audioStreams.length,
    });
    log("probe", entry.file, {
      duration: probe.durationSeconds,
      video: probe.video === null ? null : probe.video.codec + " " + probe.video.width + "x" + probe.video.height,
      audio: probe.selectedAudio === null ? null : probe.selectedAudio.codec,
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// 3) 混合目錄 fixture
// ---------------------------------------------------------------------------
const MIXED_TEXT = [
  "# 索引與建置筆記",
  "",
  "明天早上九點開設計審查會議，記得帶圖紙。",
  "",
  "The release checklist: run the pnpm workspace topological build, verify the SQLite migration runner, then check the REST diagnostics endpoint.",
  "",
  "這份文件是驗收用的合成文字，不包含任何私人資料。",
  "",
].join("\n");

const MIXED_IMAGE_QUERY_DESCRIPTION = "a solid blue square on a plain white background";

async function buildMixedRoot() {
  await fs.mkdir(MIXED_DIR, { recursive: true });
  for (const entry of report.frozen.files) {
    await fs.copyFile(path.join(CORPUS_DIR, entry.file), path.join(MIXED_DIR, entry.file));
  }
  await fs.writeFile(path.join(MIXED_DIR, "notes.md"), MIXED_TEXT, "utf8");

  const probeImage = createProbeImages(256).find((entry) => entry.id === "blue_square");
  if (probeImage === undefined) throw new Error("找不到合成 probe 圖片 blue_square");
  await fs.writeFile(path.join(MIXED_DIR, "blue_square.png"), probeImage.image.bytes);

  if (!existsSync(AUDIO_FIXTURE)) throw new Error("缺少既有合成 WAV fixture：" + rel(AUDIO_FIXTURE));
  await fs.copyFile(AUDIO_FIXTURE, path.join(MIXED_DIR, "knock.wav"));

  const files = [];
  for (const name of (await fs.readdir(MIXED_DIR)).sort()) {
    const abs = path.join(MIXED_DIR, name);
    const stat = await fs.stat(abs);
    files.push({ file: name, bytes: stat.size, sha256: await sha256File(abs) });
  }
  const fixtures = {
    dir: rel(MIXED_DIR),
    files,
    textFile: "notes.md",
    textQuery: "pnpm workspace topological build",
    imageFile: "blue_square.png",
    imageQuery: MIXED_IMAGE_QUERY_DESCRIPTION,
    audioFile: "knock.wav",
    audioQuery: "有人連續敲門的聲音",
    videoQuery: "Thick black diagonal lines sweeping across a white background",
    videoFile: "v06.mp4",
    sourceWav: rel(AUDIO_FIXTURE),
  };
  log("混合目錄已建立", { dir: fixtures.dir, files: files.map((file) => file.file) });
  return fixtures;
}

// ---------------------------------------------------------------------------
// 環境資訊
// ---------------------------------------------------------------------------
function environmentInfo(diagnostics) {
  const cpus = os.cpus();
  return {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cpuModel: cpus.length > 0 ? cpus[0].model.trim() : "unknown",
    cpuCount: cpus.length,
    totalMemBytes: os.totalmem(),
    freeMemBytes: os.freemem(),
    embedDevice: "cpu（明示 MNEMOSHELF_EMBED_DEVICE=cpu）",
    modelDir: rel(MODEL_DIR),
    dataDir: rel(DATA_DIR),
    embedder: {
      id: diagnostics.embedder?.id ?? null,
      dim: diagnostics.embedder?.dim ?? null,
      capabilities: diagnostics.embedder?.capabilities ?? null,
    },
    embedderRuntime: diagnostics.embedderRuntime ?? null,
    videoCapability: diagnostics.video
      ? {
          state: diagnostics.video.state,
          reason: diagnostics.video.reason ?? null,
          maxFileBytes: diagnostics.video.maxFileBytes,
          durationLimitSeconds: diagnostics.video.durationLimitSeconds,
          ffmpegVersion: diagnostics.video.ffmpegVersion ?? null,
          ffprobeVersion: diagnostics.video.ffprobeVersion ?? null,
        }
      : null,
    decoderBinaries: {
      relativeDir: rel(DECODER_BIN_DIR),
      ffmpegSha256: existsSync(path.join(DECODER_BIN_DIR, "ffmpeg.exe"))
        ? sha256(await_sync(path.join(DECODER_BIN_DIR, "ffmpeg.exe")))
        : null,
      ffprobeSha256: existsSync(path.join(DECODER_BIN_DIR, "ffprobe.exe"))
        ? sha256(await_sync(path.join(DECODER_BIN_DIR, "ffprobe.exe")))
        : null,
    },
  };
}
function await_sync(filePath) {
  const fsSync = process.getBuiltinModule("node:fs");
  return fsSync.readFileSync(filePath);
}

// ---------------------------------------------------------------------------
// 5) eval-root：root 建立＋preview＋索引（輪詢首筆可搜尋、每檔近似時間）
// ---------------------------------------------------------------------------
async function evaluateQualityRoot() {
  const state = {
    root: null,
    preview: null,
    index: null,
    statusTimeline: [],
    firstSearchable: null,
    chunks: null,
    diagnosticsTimings: null,
  };

  const root = await expectOk("POST", "/roots", {
    path: CORPUS_DIR,
    mode: "index",
    modalities: ["video", "audio"],
    videoMaxFileBytes: VIDEO_MAX_FILE_BYTES,
  });
  state.root = { id: root.id, path: rel(root.path), modalities: root.modalities, videoMaxFileBytes: root.videoMaxFileBytes };
  const fetched = await expectOk("GET", "/roots/" + root.id);
  state.rootPersisted = {
    modalities: fetched.modalities,
    videoMaxFileBytes: fetched.videoMaxFileBytes,
    videoMaxFileBytesMatchesDefault: fetched.videoMaxFileBytes === VIDEO_MAX_FILE_BYTES,
  };
  log("eval-root 已加入", state.root);

  const preview = await expectOk("POST", "/roots/" + root.id + "/preview");
  state.preview = {
    totalFiles: preview.totalFiles,
    totalBytes: preview.totalBytes,
    byKind: preview.byKind,
    estimated: preview.estimated ?? null,
    videoCapability: preview.videoCapability ?? null,
    skipped: preview.skipped ?? [],
  };
  log("eval-root preview", {
    totalFiles: preview.totalFiles,
    video: preview.byKind?.video?.count ?? null,
    audio: preview.byKind?.audio?.count ?? null,
    estimatedChunks: preview.estimated?.chunks ?? null,
  });

  const chunkSnapshotBefore = await snapshotChunks(root.id);
  const timingsBefore = (await expectOk("GET", "/diagnostics")).indexingTimings;

  // 索引與輪詢：狀態進度（500ms）＋ 首筆可搜尋（2s 一次 /search）
  const indexStartedMs = Date.now();
  const indexPromise = expectOk("POST", "/roots/" + root.id + "/index");
  let stopPolling = false;
  let pollInFlight = false;
  let lastSearchPollMs = 0;
  const pollTimer = setInterval(async () => {
    if (stopPolling || pollInFlight) return;
    pollInFlight = true;
    try {
      const status = await httpJson("GET", "/roots/" + root.id + "/index/status");
      if (status.status === 200 && status.body) {
        state.statusTimeline.push({
          tMs: Date.now() - indexStartedMs,
          state: status.body.state,
          processed: status.body.progress?.processed ?? null,
          skippedUnchanged: status.body.progress?.skippedUnchanged ?? null,
          skipped: status.body.progress?.skipped ?? null,
          failed: status.body.progress?.failed ?? null,
          processedChunks: status.body.progress?.processedChunks ?? null,
          estimatedChunks: status.body.progress?.estimatedChunks ?? null,
        });
      }
    } catch { /* 輪詢失敗不影響索引 */ }

    // 首筆可搜尋：每 2 秒最多查一次（避免查詢搶佔索引嵌入的排程）。
    if (state.firstSearchable === null && Date.now() - lastSearchPollMs >= 2000) {
      lastSearchPollMs = Date.now();
      try {
        const found = await findFirstSearchable();
        if (found !== null) state.firstSearchable = found;
      } catch { /* 索引中查詢失敗屬量測雜訊 */ }
    }
    pollInFlight = false;
  }, 500);

  let indexResult;
  try {
    indexResult = await indexPromise;
  } finally {
    stopPolling = true;
    clearInterval(pollTimer);
  }
  const indexDurationMs = Date.now() - indexStartedMs;
  state.index = {
    durationMs: indexResult.durationMs,
    wallMs: indexDurationMs,
    total: indexResult.total,
    processed: indexResult.processed,
    skippedUnchanged: indexResult.skippedUnchanged,
    removedFiles: indexResult.removedFiles,
    skippedFiles: indexResult.skippedFiles,
    failedFiles: indexResult.failedFiles,
    maskedFiles: indexResult.maskedFiles ?? 0,
    scanSkippedFiles: indexResult.scanSkippedFiles ?? [],
  };
  log("eval-root 索引完成", {
    durationMs: indexResult.durationMs,
    wallMs: indexDurationMs,
    total: indexResult.total,
    processed: indexResult.processed,
    skipped: indexResult.skippedFiles.length,
    failed: indexResult.failedFiles.length,
  });

  const chunkSnapshotAfter = await snapshotChunks(root.id);
  state.chunks = chunkSnapshotAfter;
  const timingsAfter = (await expectOk("GET", "/diagnostics")).indexingTimings;
  state.diagnosticsTimings = { before: timingsBefore, after: timingsAfter };
  state.diagnosticsVideo = (await expectOk("GET", "/diagnostics")).video ?? null;

  // 首筆可搜尋：換算成秒（含模型載入，屬產品端到端觀測）
  if (state.firstSearchable !== null) {
    state.firstSearchable = {
      ...state.firstSearchable,
      sinceIndexStartMs: state.firstSearchable.atMs - indexStartedMs,
      sinceIndexStartSeconds: round((state.firstSearchable.atMs - indexStartedMs) / 1000, 2),
    };
  }

  // 每檔 chunk 對帳（含 track／seq／時間／身分）
  state.chunks = summariseChunks(chunkSnapshotBefore, chunkSnapshotAfter);
  return state;
}

async function findFirstSearchable() {
  const response = await httpJson("POST", "/search", {
    query: report.frozen.labels.queries.find((query) => query.id === "V01").prompt,
    k: SEARCH_K,
  });
  if (response.status !== 200) return null;
  const hits = response.body?.hits ?? [];
  const videoHits = hits.filter((hit) => hit.type === "chunk" && hit.kind === "video");
  if (videoHits.length === 0) return null;
  const v01Hit = videoHits.find((hit) => hit.relPath === "v01.mp4") ?? null;
  return {
    atMs: Date.now(),
    probeQuery: "V01",
    firstVideoChunkHit: {
      relPath: videoHits[0].relPath,
      seq: videoHits[0].seq,
      rank: videoHits[0].rank,
      startSeconds: videoHits[0].media?.startSeconds ?? null,
      endSeconds: videoHits[0].media?.endSeconds ?? null,
      score: videoHits[0].score,
    },
    v01ChunkHit: v01Hit === null ? null : {
      relPath: v01Hit.relPath,
      seq: v01Hit.seq,
      rank: v01Hit.rank,
      startSeconds: v01Hit.media?.startSeconds ?? null,
      endSeconds: v01Hit.media?.endSeconds ?? null,
    },
    totalHits: hits.length,
  };
}

// ---------------------------------------------------------------------------
// chunk 快照／對帳
// ---------------------------------------------------------------------------
async function snapshotChunks(rootId) {
  const paths = await server.store.listRelPaths(rootId);
  const files = [];
  const allIds = [];
  for (const relPath of paths) {
    const chunks = await server.store.listChunksByPath(rootId, relPath);
    const entry = {
      relPath,
      chunkCount: chunks.length,
      ids: chunks.map((chunk) => chunk.id),
      seqs: chunks.map((chunk) => chunk.seq),
      kinds: countBy(chunks.map((chunk) => chunk.kind)),
      tracks: countBy(chunks.map((chunk) => (chunk.media === undefined ? "(none)" : chunk.media.track))),
      contentHashes: unique(chunks.map((chunk) => chunk.contentHash)),
      preprocessVersions: unique(chunks.map((chunk) => (chunk.media === undefined ? null : chunk.media.preprocessVersion))),
      embedderIds: unique(chunks.map((chunk) => (chunk.media === undefined ? null : chunk.media.embedderId))),
      embeddingDims: unique(chunks.map((chunk) => (chunk.media === undefined ? null : chunk.media.embeddingDim))),
      spans: chunks.map((chunk) => (chunk.media === undefined
        ? null
        : [round(chunk.media.startSeconds, 3), round(chunk.media.endSeconds, 3), chunk.media.track])),
      frameTimes: chunks
        .filter((chunk) => chunk.media?.track === "video")
        .map((chunk) => (chunk.media.frameTimesSeconds ?? []).map((value) => round(value, 3))),
    };
    entry.seqUnique = entry.seqs.length === new Set(entry.seqs).size;
    allIds.push(...entry.ids);
    files.push(entry);
  }
  return { rootId, files, chunkCount: allIds.length, chunkIds: allIds };
}

function summariseChunks(before, after) {
  const byTrack = { video: 0, "video-audio": 0, audio: 0, "(none)": 0 };
  for (const file of after.files) {
    for (const [track, count] of Object.entries(file.tracks)) byTrack[track] = (byTrack[track] ?? 0) + count;
  }
  const durationSum = {};
  for (const file of after.files) {
    const videoChunks = file.spans.filter((span) => span !== null && span[2] === "video").length;
    const audioChunks = file.spans.filter((span) => span !== null && span[2] === "video-audio").length;
    durationSum[file.relPath] = { videoChunks, audioChunks };
  }
  return {
    chunkCount: after.chunkCount,
    byTrack,
    perFile: after.files.map((file) => ({
      relPath: file.relPath,
      chunkCount: file.chunkCount,
      byTrack: file.tracks,
      seqUnique: file.seqUnique,
      contentHashes: file.contentHashes,
      preprocessVersions: file.preprocessVersions,
      embedderIds: file.embedderIds,
      embeddingDims: file.embeddingDims,
      spans: file.spans,
      videoChunks: durationSum[file.relPath].videoChunks,
      audioChunks: durationSum[file.relPath].audioChunks,
    })),
    before: {
      chunkCount: before.chunkCount,
      perFile: before.files.map((file) => ({ relPath: file.relPath, chunkCount: file.chunkCount, ids: file.ids })),
    },
    rawAfter: after,
  };
}

// ---------------------------------------------------------------------------
// 6) 24 題固定題庫
// ---------------------------------------------------------------------------
function evaluateHit(hit, query) {
  if (hit === null || hit === undefined) return { correct: false, reason: "no-hit" };
  if (hit.type !== "chunk") return { correct: false, reason: "not-chunk" };
  if (hit.relPath !== query.file) return { correct: false, reason: "other-file" };
  const expectedKind = query.track === "video" ? "video" : "audio";
  const expectedTrack = query.track === "video" ? "video" : "video-audio";
  if (hit.kind !== expectedKind) return { correct: false, reason: "wrong-kind" };
  const media = hit.media;
  if (media === undefined || media === null) return { correct: false, reason: "no-media" };
  if (media.track !== expectedTrack) return { correct: false, reason: "wrong-track" };
  const overlap = Math.min(media.endSeconds, query.annotatedEndSeconds) - Math.max(media.startSeconds, query.annotatedStartSeconds);
  return {
    correct: overlap > 0.001,
    overlapSeconds: round(overlap, 3),
    reason: overlap > 0.001 ? "hit" : "no-overlap",
  };
}

function slimHit(hit) {
  if (hit === null || hit === undefined) return null;
  if (hit.type !== "chunk") {
    return { type: hit.type, rank: hit.rank, score: round(hit.score, 6), key: hit.key ?? null };
  }
  return {
    type: "chunk",
    rank: hit.rank,
    score: round(hit.score, 6),
    relPath: hit.relPath,
    seq: hit.seq,
    kind: hit.kind,
    media: hit.media === undefined ? null : {
      track: hit.media.track,
      startSeconds: round(hit.media.startSeconds, 3),
      endSeconds: round(hit.media.endSeconds, 3),
      streamIndex: hit.media.streamIndex ?? null,
      preprocessVersion: hit.media.preprocessVersion,
    },
  };
}

async function runQualityQueries(labels, rootId) {
  const result = {
    rootId,
    mode: null,
    k: SEARCH_K,
    queryCount: 0,
    results: [],
    metrics: {},
    thresholds: labels.thresholds,
  };
  for (const query of labels.queries) {
    const t0 = performance.now();
    const response = await expectOk("POST", "/search", { query: query.prompt, k: SEARCH_K });
    const elapsedMs = performance.now() - t0;
    result.mode = response.mode;
    const hits = response.hits ?? [];
    const evaluated = hits.map((hit) => ({ hit, evaluation: evaluateHit(hit, query) }));
    const correct = evaluated.filter((entry) => entry.evaluation.correct);
    const firstCorrect = correct[0] ?? null;
    const top1 = hits[0] ?? null;
    const top1Evaluation = evaluated[0]?.evaluation ?? { correct: false, reason: "no-hit" };
    result.results.push({
      id: query.id,
      lang: query.lang,
      track: query.track,
      modality: query.modality,
      file: query.file,
      prompt: query.prompt,
      annotatedStartSeconds: query.annotatedStartSeconds,
      annotatedEndSeconds: query.annotatedEndSeconds,
      elapsedMs: round(elapsedMs, 1),
      hitCount: hits.length,
      fileSegmentCounts: (() => { const file = report.qualityRoot.chunks?.perFile?.find((entry) => entry.relPath === query.file); return file ? { video: file.videoChunks, audio: file.audioChunks } : null; })(),
      correctRank: firstCorrect === null ? null : firstCorrect.hit.rank,
      hitAt3: firstCorrect !== null && firstCorrect.hit.rank <= 3,
      top1Correct: top1Evaluation.correct === true,
      top1: slimHit(top1),
      top1Reason: top1Evaluation.reason ?? null,
      top3: hits.slice(0, 3).map(slimHit),
      correctHits: correct.slice(0, 3).map((entry) => ({ ...slimHit(entry.hit), overlapSeconds: entry.evaluation.overlapSeconds })),
      negativeTop3: hits.slice(0, 3).some((hit) => isNegativeFile(hit)),
      allHits: hits.map(slimHit),
    });
  }
  const visual = result.results.filter((entry) => entry.track === "video");
  const audio = result.results.filter((entry) => entry.track !== "video");
  const recall = (list) => list.filter((entry) => entry.hitAt3).length;
  result.queryCount = result.results.length;
  result.metrics = {
    recallAt3Overall: recall(result.results),
    recallAt3OverallOf: result.results.length,
    recallAt3Visual: recall(visual),
    recallAt3VisualOf: visual.length,
    recallAt3Audio: recall(audio),
    recallAt3AudioOf: audio.length,
    top1Correct: result.results.filter((entry) => entry.top1Correct).length,
    mrr: round(
      result.results.reduce((sum, entry) => sum + (entry.correctRank === null ? 0 : 1 / entry.correctRank), 0) / result.results.length,
      5,
    ),
    failures: result.results
      .filter((entry) => !entry.hitAt3)
      .map((entry) => ({
        id: entry.id,
        track: entry.track,
        prompt: entry.prompt,
        file: entry.file,
        annotated: [entry.annotatedStartSeconds, entry.annotatedEndSeconds],
        correctRank: entry.correctRank,
        top1: entry.top1,
      })),
  };
  // 門檻（讀自凍結檔；不自行放寬）
  const thresholds = labels.thresholds ?? {};
  const requiredOverall = thresholds.recallAt3Overall ?? { required: 18, of: 24 };
  const requiredPerTrack = thresholds.recallAt3PerTrack ?? { required: 9, of: 12 };
  result.pass = {
    overall: result.metrics.recallAt3Overall >= (requiredOverall.required ?? 18),
    visual: result.metrics.recallAt3Visual >= (requiredPerTrack.required ?? 9),
    audio: result.metrics.recallAt3Audio >= (requiredPerTrack.required ?? 9),
    negatives: true, // 由 evaluateNegatives 覆寫
  };
  return result;
}

function isNegativeFile(hit) {
  if (hit === null || hit === undefined || hit.type !== "chunk") return false;
  const negatives = report.frozen.labels?.negativeControls ?? [];
  return negatives.some((entry) => entry.file === hit.relPath);
}

function evaluateNegatives(queries24) {
  const negativeFiles = (report.frozen.labels?.negativeControls ?? []).map((entry) => entry.file);
  const violations = [];
  const top3Appearances = [];
  for (const entry of queries24.results) {
    const top1 = entry.top1;
    if (top1 !== null && top1.type === "chunk" && negativeFiles.includes(top1.relPath)) {
      violations.push({ id: entry.id, query: entry.prompt, top1: top1.relPath, top1Seq: top1.seq });
    }
    for (const hit of entry.top3) {
      if (hit !== null && hit.type === "chunk" && negativeFiles.includes(hit.relPath)) {
        top3Appearances.push({ id: entry.id, rank: hit.rank, file: hit.relPath, seq: hit.seq });
      }
    }
  }
  queries24.pass.negatives = violations.length === 0;
  return {
    files: negativeFiles,
    violations,
    top3Appearances,
  };
}

// ---------------------------------------------------------------------------
// 7) 未變重跑（eval-root、混合目錄共用）
// ---------------------------------------------------------------------------
async function unchangedRerun(rootId, label) {
  const before = await snapshotChunks(rootId);
  const timingsBefore = (await expectOk("GET", "/diagnostics")).indexingTimings;
  const t0 = performance.now();
  const result = await expectOk("POST", "/roots/" + rootId + "/index");
  const wallMs = performance.now() - t0;
  const after = await snapshotChunks(rootId);
  const timingsAfter = (await expectOk("GET", "/diagnostics")).indexingTimings;

  const sameIds = JSON.stringify(before.chunkIds) === JSON.stringify(after.chunkIds);
  const samePerFile = JSON.stringify(before.files.map((file) => [file.relPath, file.chunkCount, file.ids]))
    === JSON.stringify(after.files.map((file) => [file.relPath, file.chunkCount, file.ids]));
  const evidence = {
    label,
    rootId,
    durationMs: result.durationMs,
    wallMs: round(wallMs, 1),
    total: result.total,
    processed: result.processed,
    skippedUnchanged: result.skippedUnchanged,
    skippedFiles: result.skippedFiles,
    failedFiles: result.failedFiles,
    chunkIdsUnchanged: sameIds,
    perFileUnchanged: samePerFile,
    chunkCountBefore: before.chunkCount,
    chunkCountAfter: after.chunkCount,
    embedStageCallsBefore: timingsBefore.embed.calls,
    embedStageCallsAfter: timingsAfter.embed.calls,
    embedStageCallsDelta: timingsAfter.embed.calls - timingsBefore.embed.calls,
    noReembed: timingsAfter.embed.calls === timingsBefore.embed.calls,
  };
  log("未變重跑", {
    label,
    durationMs: evidence.durationMs,
    processed: evidence.processed,
    skippedUnchanged: evidence.skippedUnchanged,
    chunkIdsUnchanged: evidence.chunkIdsUnchanged,
    embedCallsDelta: evidence.embedStageCallsDelta,
  });
  return evidence;
}

// ---------------------------------------------------------------------------
// 8) 混合目錄
// ---------------------------------------------------------------------------
async function evaluateMixedRoot(fixtures) {
  const state = { fixtures, root: null, preview: null, index: null, chunks: null, queries: [], rerun: null, modification: null };

  const root = await expectOk("POST", "/roots", {
    path: MIXED_DIR,
    mode: "index",
    modalities: ["text", "code", "image", "audio", "video"],
    videoMaxFileBytes: VIDEO_MAX_FILE_BYTES,
  });
  const fetched = await expectOk("GET", "/roots/" + root.id);
  state.root = {
    id: root.id,
    path: rel(root.path),
    modalities: fetched.modalities,
    videoMaxFileBytes: fetched.videoMaxFileBytes,
  };
  log("mixed root 已加入", state.root);

  const preview = await expectOk("POST", "/roots/" + root.id + "/preview");
  state.preview = {
    totalFiles: preview.totalFiles,
    totalBytes: preview.totalBytes,
    byKind: preview.byKind,
    estimated: preview.estimated ?? null,
    skipped: preview.skipped ?? [],
    videoCapability: preview.videoCapability ?? null,
  };
  log("mixed preview", {
    totalFiles: preview.totalFiles,
    byKind: Object.fromEntries(Object.entries(preview.byKind ?? {}).map(([kind, value]) => [kind, value.count])),
  });

  // 索引（不輪詢；乾淨量測）
  const t0 = performance.now();
  const result = await expectOk("POST", "/roots/" + root.id + "/index");
  const wallMs = performance.now() - t0;
  state.index = {
    durationMs: result.durationMs,
    wallMs: round(wallMs, 1),
    total: result.total,
    processed: result.processed,
    skippedUnchanged: result.skippedUnchanged,
    skippedFiles: result.skippedFiles,
    failedFiles: result.failedFiles,
    removedFiles: result.removedFiles,
    scanSkippedFiles: result.scanSkippedFiles ?? [],
  };
  log("mixed 索引完成", { durationMs: result.durationMs, total: result.total, processed: result.processed, failed: result.failedFiles.length });

  const snapshot = await snapshotChunks(root.id);
  state.chunks = {
    chunkCount: snapshot.chunkCount,
    byKind: countBy(snapshot.files.flatMap((file) => Object.entries(file.kinds).flatMap(([kind, count]) => Array.from({ length: count }, () => kind)))),
    perFile: snapshot.files.map((file) => ({
      relPath: file.relPath,
      chunkCount: file.chunkCount,
      kinds: file.kinds,
      tracks: file.tracks,
      contentHashes: file.contentHashes,
      videoChunks: file.tracks.video ?? 0,
      audioChunks: (file.tracks["video-audio"] ?? 0) + (file.tracks.audio ?? 0),
    })),
  };

  // 四類文字搜尋（同一混合 root；rootIds 限定此 root，避免與品質 root 互相污染）
  const mixedQueries = [
    { name: "text", query: fixtures.textQuery, expectFile: fixtures.textFile, expectKind: "text" },
    { name: "image", query: fixtures.imageQuery, expectFile: fixtures.imageFile, expectKind: "image" },
    { name: "audio-wav", query: fixtures.audioQuery, expectFile: fixtures.audioFile, expectKind: "audio" },
    { name: "video", query: fixtures.videoQuery, expectFile: fixtures.videoFile, expectKind: "video" },
  ];
  for (const item of mixedQueries) {
    const started = performance.now();
    const response = await expectOk("POST", "/search", { query: item.query, k: SEARCH_K, rootIds: [root.id] });
    const elapsedMs = performance.now() - started;
    const hits = response.hits ?? [];
    const matchesExpected = (hit) => {
      if (hit.type !== "chunk" || hit.relPath !== item.expectFile) return false;
      if (item.expectKind === "video") return hit.kind === "video" && hit.media?.track === "video";
      if (item.expectKind === "audio") return hit.kind === "audio" && hit.media?.track === "audio";
      return hit.kind === item.expectKind;
    };
    const expectedRank = (() => {
      const index = hits.findIndex(matchesExpected);
      return index === -1 ? null : index + 1;
    })();
    const kindRank = (() => {
      const index = hits.findIndex((hit) => hit.type === "chunk" && hit.kind === item.expectKind);
      return index === -1 ? null : index + 1;
    })();
    state.queries.push({
      name: item.name,
      query: item.query,
      expectFile: item.expectFile,
      expectKind: item.expectKind,
      elapsedMs: round(elapsedMs, 1),
      expectedRank,
      kindRank,
      expectedAtTop1: expectedRank === 1,
      expectedAtTop3: expectedRank !== null && expectedRank <= 3,
      modalityOfTop1: hits[0] === undefined ? null : (hits[0].type === "chunk" ? hits[0].kind : hits[0].type),
      hits: hits.map(slimHit),
    });
    log("mixed 查詢", { name: item.name, expectedRank, elapsedMs: round(elapsedMs, 1), top1: hits[0] ? (hits[0].type === "chunk" ? hits[0].kind + ":" + hits[0].relPath : hits[0].type) : null });
  }
  state.queryElapsedMs = state.queries.map((entry) => entry.elapsedMs);

  // 未變重跑
  state.rerun = await unchangedRerun(root.id, "mixed-root");

  // 修改一檔（以 v02 複本覆蓋 v03 複本）：只重建該檔
  const before = await snapshotChunks(root.id);
  const sourceHash = (report.frozen.files.find((file) => file.file === "v02.mp4") ?? {}).sha256 ?? null;
  await fs.copyFile(path.join(MIXED_DIR, "v02.mp4"), path.join(MIXED_DIR, "v03.mp4"));
  const timingsBefore = (await expectOk("GET", "/diagnostics")).indexingTimings;
  const t1 = performance.now();
  const modifyResult = await expectOk("POST", "/roots/" + root.id + "/index");
  const modifyWallMs = performance.now() - t1;
  const after = await snapshotChunks(root.id);
  const timingsAfter = (await expectOk("GET", "/diagnostics")).indexingTimings;

  const beforeById = new Map(before.files.map((file) => [file.relPath, file]));
  const perFileDiff = after.files.map((file) => {
    const previous = beforeById.get(file.relPath);
    return {
      relPath: file.relPath,
      changed: previous === undefined || JSON.stringify(previous.ids) !== JSON.stringify(file.ids),
      chunkCountBefore: previous?.chunkCount ?? 0,
      chunkCountAfter: file.chunkCount,
      contentHashes: file.contentHashes,
    };
  });
  const changedFiles = perFileDiff.filter((file) => file.changed).map((file) => file.relPath);
  const modifiedFile = perFileDiff.find((file) => file.relPath === "v03.mp4") ?? null;
  state.modification = {
    action: "以 v02.mp4 複本覆蓋 v03.mp4",
    expectedContentHash: sourceHash,
    durationMs: modifyResult.durationMs,
    wallMs: round(modifyWallMs, 1),
    total: modifyResult.total,
    processed: modifyResult.processed,
    skippedUnchanged: modifyResult.skippedUnchanged,
    failedFiles: modifyResult.failedFiles,
    skippedFiles: modifyResult.skippedFiles,
    changedFiles,
    onlyModifiedFileRebuilt: changedFiles.length === 1 && changedFiles[0] === "v03.mp4",
    v03: modifiedFile,
    v03ContentHashMatchesExpected: modifiedFile !== null && sourceHash !== null && modifiedFile.contentHashes.includes(sourceHash),
    embedStageCallsDelta: timingsAfter.embed.calls - timingsBefore.embed.calls,
    chunksAfter: after.chunkCount,
  };
  log("修改一檔", {
    processed: modifyResult.processed,
    skippedUnchanged: modifyResult.skippedUnchanged,
    changedFiles,
    v03ContentHashMatchesExpected: state.modification.v03ContentHashMatchesExpected,
    embedCallsDelta: state.modification.embedStageCallsDelta,
  });

  // 最終完整性（兩個 root 全部 chunk 都要有向量）
  state.integrity = await integrityCheck([report.qualityRoot.root.id, root.id]);
  return state;
}

// ---------------------------------------------------------------------------
// 完整性
// ---------------------------------------------------------------------------
async function integrityCheck(rootIds) {
  const allKeys = [];
  const chunkIds = [];
  for (const rootId of rootIds) {
    const snapshot = await snapshotChunks(rootId);
    chunkIds.push(...snapshot.chunkIds);
    allKeys.push(...snapshot.chunkIds.map((id) => "c:" + id));
  }
  const existing = await server.vec.existingKeys(allKeys);
  const missing = allKeys.filter((key) => !existing.has(key));
  const vectorCount = await server.vec.count();
  const embedderIds = await server.vec.embedderIds();
  const result = {
    roots: rootIds,
    chunkCount: chunkIds.length,
    vectorCount,
    vectorDim: server.vec.dim,
    missingVectorKeys: missing.length,
    missingVectorSample: missing.slice(0, 10),
    orphanVectorCount: Math.max(0, vectorCount - chunkIds.length),
    embedderIds,
    chunkCountMatchesVectorCount: vectorCount === chunkIds.length,
  };
  log("完整性", {
    chunks: result.chunkCount,
    vectors: result.vectorCount,
    missing: result.missingVectorKeys,
    orphans: result.orphanVectorCount,
    embedderIds,
  });
  return result;
}

// ---------------------------------------------------------------------------
// 9) 效能
// ---------------------------------------------------------------------------
function finalPerformance() {
  clearInterval(rssTimer);
  const queryElapsed = [
    ...(report.queries24.results ?? []).map((entry) => entry.elapsedMs),
    ...(report.mixedRoot.queries ?? []).map((entry) => entry.elapsedMs),
  ];
  const qualityQueryElapsed = (report.queries24.results ?? []).map((entry) => entry.elapsedMs);
  const memory = process.memoryUsage();
  return {
    evaluationSeconds: round((Date.now() - Date.parse(startedAt)) / 1000, 1),
    qualityRootIndexSeconds: round((report.qualityRoot.index?.durationMs ?? 0) / 1000, 2),
    mixedRootIndexSeconds: round((report.mixedRoot.index?.durationMs ?? 0) / 1000, 2),
    firstSearchableSeconds: report.qualityRoot.firstSearchable?.sinceIndexStartSeconds ?? null,
    firstSearchable: report.qualityRoot.firstSearchable ?? null,
    searchLatencyMs: {
      quality24: stats(qualityQueryElapsed),
      mixed4: stats(report.mixedRoot.queryElapsedMs ?? []),
      combined: stats(queryElapsed),
      note: "逐筆 wall time（embedQuery＋向量搜尋＋REST）；混合目錄 4 筆含 product 預設 vector 模式。P95 以 n 筆小樣本取最近秩，僅供粗略參考。",
    },
    rss: {
      peakBytes: rssPeak,
      peakMiB: round(rssPeak / (1024 * 1024), 1),
      samples: rssSamples.length,
      intervalMs: 250,
      scope: "Node 主執行緒＋worker thread（同一行程）的 process.memoryUsage().rss 峰值；不含 ffmpeg 子程序。",
      checkpoint: {
        afterEvalIndex: report.decoder?.checkpointRssAfterEvalIndex ?? null,
        end: { rss: memory.rss, heapUsed: memory.heapUsed, external: memory.external, arrayBuffers: memory.arrayBuffers },
      },
    },
    indexerTimings: {
      quality: report.qualityRoot.diagnosticsTimings ?? null,
      note: "server /diagnostics 的 indexingTimings 累計（含排隊與前處理，非純模型時間）。",
    },
  };
}

// ---------------------------------------------------------------------------
// 收尾
// ---------------------------------------------------------------------------
async function shutdown(code) {
  try { clearInterval(rssTimer); } catch { /* ignore */ }
  try {
    const fsSync = process.getBuiltinModule("node:fs");
    fsSync.writeFileSync(RSS_PATH, JSON.stringify({ peakBytes: rssPeak, samples: rssSamples }), "utf8");
  } catch { /* ignore */ }
  try { if (server !== null) await server.close(); } catch (error) { log("WARN close 失敗", error instanceof Error ? error.message : String(error)); }
  saveReport();
  if (code !== 0) process.exitCode = code;
}

const invocationStart = Date.now();
try {
  await main();
} catch (error) {
  report.status = "error";
  report.error = {
    name: error instanceof Error ? error.name : "Error",
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? (error.stack ?? "").split("\n").slice(0, 20) : [],
  };
  log("ERROR 驗收中止", report.error.message);
  await shutdown(1);
  process.exit(1);
}
await shutdown(0);
log("總耗時（秒）", round((Date.now() - invocationStart) / 1000, 1));
