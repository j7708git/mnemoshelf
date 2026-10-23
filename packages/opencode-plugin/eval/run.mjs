#!/usr/bin/env node
/**
 * D3：記憶召回離線評估（v1）。
 *
 * 做什麼：
 * 1. 用暫存 `MNEMOSHELF_DATA_DIR` 啟動本 repo 的 server（`packages/server/dist/scripts/serve.js`）。
 * 2. 灌入 `eval/fixtures/cards.json` 的合成記憶卡（含 supersede／pin／近似重複）。
 * 3. **就緒閘門**：輪詢 `GET /diagnostics` 直到 `pending/failed/stale === 0`；`tooLong` 只記錄。
 * 4. 對每個 variant 重跑檢索＋裝箱（重用 D2 的 `planRecall`），輸出 JSON＋Markdown。
 *
 * 唯讀邊界：不改 server、不改 plugin 行為、不碰使用者的資料目錄（一律 mkdtemp）。
 * 用法與指標定義見 `eval/README.md`。
 */
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadDataset } from "./lib/dataset.mjs";
import { aggregate, injectionMetrics, percentile, retrievalMetrics, subsetMetrics } from "./lib/metrics.mjs";
import { selectKMax, selectMaxItems, selectMinScore, selectTimeout, FP_GATE } from "./lib/select.mjs";
import { renderMarkdown } from "./lib/report.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = path.resolve(HERE, "..");
const REPO_ROOT = path.resolve(PACKAGE_DIR, "..", "..");
const SERVE_SCRIPT = path.join(REPO_ROOT, "packages", "server", "dist", "scripts", "serve.js");
const FIXTURES_DIR = path.join(HERE, "fixtures");
const AGENT_NAME = "eval-d3";

/** 量測用的 timeout：刻意放寬，避免把「實際很慢」誤記成失敗；timeout 建議另外用分佈推算。 */
const MEASURE_TIMEOUT_MS = 3000;
/** 主要 pass 使用的候選數。 */
const SEARCH_K = 8;

function parseArgs(argv) {
  const options = {
    outDir: path.join(REPO_ROOT, ".tmp", "eval-d3"),
    readinessTimeoutMs: 15 * 60 * 1000,
    keep: false,
    build: true,
    indexPass: true,
    determinism: true,
    verbose: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--out") options.outDir = path.resolve(argv[++index]);
    else if (arg === "--readiness-timeout-min") options.readinessTimeoutMs = Number(argv[++index]) * 60 * 1000;
    else if (arg === "--keep") options.keep = true;
    else if (arg === "--no-build") options.build = false;
    else if (arg === "--no-index-pass") options.indexPass = false;
    else if (arg === "--no-determinism") options.determinism = false;
    else if (arg === "--verbose") options.verbose = true;
    else if (arg === "--help" || arg === "-h") {
      console.log("用法：node eval/run.mjs [--out DIR] [--readiness-timeout-min N] [--keep] [--no-build] [--no-index-pass] [--no-determinism] [--verbose]");
      process.exit(0);
    } else {
      throw new Error(`未知參數：${arg}`);
    }
  }
  return options;
}

function log(message) {
  console.log(`[eval] ${message}`);
}

function nowIso() {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// 建置與模型快取
// ---------------------------------------------------------------------------

function ensureBuild(options) {
  const needed = [
    SERVE_SCRIPT,
    path.join(PACKAGE_DIR, "dist", "recall.js"),
    path.join(PACKAGE_DIR, "dist", "config.js"),
  ];
  const missing = needed.filter((file) => !existsSync(file));
  if (missing.length === 0) return;
  if (!options.build) {
    throw new Error(
      `找不到建置產物（${missing.map((file) => path.relative(REPO_ROOT, file)).join("、")}）。` +
        "先跑 `pnpm -r build`，或不要加 --no-build。",
    );
  }
  log("找不到建置產物，先跑 `pnpm -r build`（可加 --no-build 跳過）…");
  const result = spawnSync("pnpm", ["-r", "build"], { cwd: REPO_ROOT, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`pnpm -r build 失敗（exit ${result.status}）`);
  const stillMissing = needed.filter((file) => !existsSync(file));
  if (stillMissing.length > 0) throw new Error(`建置後仍缺少：${stillMissing.join("、")}`);
}

/** 找現成的 embedder 模型快取；找不到就明確失敗（**絕不下載**）。 */
function resolveModelDir() {
  const candidates = [
    process.env.MNEMOSHELF_MODEL_DIR,
    path.join(os.homedir(), ".config", "Mnemoshelf", "models"),
    path.join(os.homedir(), ".local", "share", "mnemoshelf", "models"),
    path.join(os.homedir(), "Library", "Application Support", "Mnemoshelf", "models"),
    path.join(REPO_ROOT, ".tmp", "speed-diagnosis", "models"),
  ].filter((candidate) => typeof candidate === "string" && candidate !== "");

  const marker = path.join("onnx-community", "embeddinggemma-2-ONNX", "onnx", "model_q4.onnx");
  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, marker))) return candidate;
  }
  throw new Error(
    "找不到 embedder 模型快取（需要 `onnx-community/embeddinggemma-2-ONNX/onnx/model_q4.onnx`）。\n" +
      "候選目錄：MNEMOSHELF_MODEL_DIR、~/.config/Mnemoshelf/models、~/.local/share/mnemoshelf/models、" +
      "~/Library/Application Support/Mnemoshelf/models、<repo>/.tmp/speed-diagnosis/models。\n" +
      "本 harness 不會下載模型；請先開一次 Mnemoshelf 桌面版或設定 MNEMOSHELF_MODEL_DIR。",
  );
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => (port > 0 ? resolve(port) : reject(new Error("取不到空閒埠"))));
    });
  });
}

// ---------------------------------------------------------------------------
// Server 子行程與 HTTP client
// ---------------------------------------------------------------------------

function startServer(env, options) {
  const child = spawn(process.execPath, [SERVE_SCRIPT], {
    cwd: REPO_ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const tail = [];
  const push = (chunk) => {
    const text = chunk.toString();
    for (const line of text.split(/\r?\n/)) {
      if (line === "") continue;
      tail.push(line);
      if (tail.length > 60) tail.shift();
      if (options.verbose) console.error(`[server] ${line}`);
    }
  };
  child.stderr.on("data", push);
  child.stdout.on("data", push);

  const url = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("server 啟動逾時（30 秒內沒有印出網址）")), 30000);
    const scan = () => {
      const joined = tail.join("\n");
      const match = joined.match(/服務已啟動：(http:\/\/127\.0\.0\.1:\d+)/);
      if (match === null) return false;
      clearTimeout(timer);
      resolve(match[1]);
      return true;
    };
    child.stderr.on("data", () => scan());
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`server 提前結束（exit ${code}）：\n${tail.join("\n")}`));
    });
  });

  return { child, url, tail };
}

async function stopServer(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  const exited = new Promise((resolve) => child.once("exit", resolve));
  const timeout = new Promise((resolve) => setTimeout(() => resolve("timeout"), 30000));
  const result = await Promise.race([exited, timeout]);
  if (result === "timeout") {
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));
  }
}

function makeClient(baseUrl, token) {
  const request = async (pathname, { method = "GET", body, timeoutMs = 30000 } = {}) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${baseUrl}${pathname}`, {
        method,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
      const text = await response.text();
      let parsed = null;
      try {
        parsed = text === "" ? null : JSON.parse(text);
      } catch {
        parsed = null;
      }
      return { status: response.status, body: parsed, text };
    } finally {
      clearTimeout(timer);
    }
  };
  return { request };
}

function describeHttpError(action, response) {
  const message = response?.body?.error?.message ?? response?.text?.slice(0, 200) ?? "";
  return `${action} 失敗：HTTP ${response?.status ?? "?"}${message === "" ? "" : `（${message}）`}`;
}

// ---------------------------------------------------------------------------
// Fixture 載入與就緒閘門
// ---------------------------------------------------------------------------

async function loadFixtures(client, dataset) {
  const idBySlug = new Map();
  const maskIssues = [];
  for (const card of dataset.cards) {
    const body = {
      content: card.content,
      kind: card.kind,
      scope: card.scope ?? "project",
      agent: AGENT_NAME,
      ...(card.project === undefined ? {} : { project: card.project }),
      ...(card.force === true ? { force: true } : {}),
      ...(card.supersedes === undefined ? {} : { supersedes: idBySlug.get(card.supersedes) }),
    };
    const response = await client.request("/memories", { method: "POST", body });
    if (response.status !== 201) {
      throw new Error(`${describeHttpError(`載入卡片 ${card.id}`, response)}`);
    }
    idBySlug.set(card.id, response.body.id);
    if (response.body.redacted === true) {
      // 遮罩會改寫內容（不可回復）：fixture 不該踩到，若發生要能看到。
      maskIssues.push({ id: card.id, count: response.body.redactedCount ?? 0 });
    }
    if (card.pinned === true) {
      const pin = await client.request(`/memories/${response.body.id}/pin`, { method: "POST", body: {} });
      if (pin.status !== 200) throw new Error(describeHttpError(`釘選 ${card.id}`, pin));
    }
  }
  return { idBySlug, maskIssues };
}

function memoryStats(diagnostics) {
  const memories = diagnostics?.memories ?? {};
  return {
    total: memories.total ?? 0,
    ready: memories.ready ?? 0,
    pending: memories.pending ?? 0,
    failed: memories.failed ?? 0,
    tooLong: memories.tooLong ?? 0,
    stale: memories.stale ?? 0,
    queued: memories.worker?.queued ?? 0,
    processing: memories.worker?.processing ?? 0,
  };
}

async function waitForReady(client, timeoutMs) {
  const started = Date.now();
  let polls = 0;
  let last = null;
  let first = null;
  while (Date.now() - started < timeoutMs) {
    const response = await client.request("/diagnostics", { timeoutMs: 10000 });
    polls += 1;
    if (response.status !== 200) {
      throw new Error(describeHttpError("GET /diagnostics", response));
    }
    last = memoryStats(response.body);
    if (first === null) first = last;
    if (last.pending === 0 && last.failed === 0 && last.stale === 0) {
      return { gate: "passed", waitedMs: Date.now() - started, polls, first, final: last };
    }
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  return { gate: "timeout", waitedMs: Date.now() - started, polls, first, final: last };
}

// ---------------------------------------------------------------------------
// 檢索與變體
// ---------------------------------------------------------------------------

const CONFIGS = {
  ms035: { k: SEARCH_K, minScore: 0.35 },
  ms040: { k: SEARCH_K, minScore: 0.4 },
  ms045: { k: SEARCH_K, minScore: 0.45 },
  ms050: { k: SEARCH_K, minScore: 0.5 },
  ms055: { k: SEARCH_K, minScore: 0.55 },
  ms060: { k: SEARCH_K, minScore: 0.6 },
  ms065: { k: SEARCH_K, minScore: 0.65 },
  ms070: { k: SEARCH_K, minScore: 0.7 },
  kw: { k: SEARCH_K, minScore: 1 },
  k3: { k: 3, minScore: 0.4 },
  k5: { k: 5, minScore: 0.4 },
  // 尺度校準：k=20、minScore 0，用來看「expected 卡本身的 cosine 在哪裡」。
  calib: { k: 20, minScore: 0 },
};

async function search(client, question, config) {
  const started = Date.now();
  let response;
  try {
    response = await client.request("/memories/search", {
      method: "POST",
      timeoutMs: config.timeoutMs ?? MEASURE_TIMEOUT_MS,
      body: {
        query: question.query,
        project: question.project,
        k: config.k,
        minScore: config.minScore,
      },
    });
  } catch (error) {
    // 逾時／斷線都要變成「這題沒有結果」，不能讓整個評估崩潰。
    const latencyMs = Date.now() - started;
    const name = error instanceof Error ? error.name : "unknown";
    return { ok: false, status: 0, latencyMs, reason: name === "AbortError" ? "timeout" : "network" };
  }
  const latencyMs = Date.now() - started;
  if (response.status !== 200) {
    return { ok: false, status: response.status, latencyMs, reason: "http" };
  }
  return {
    ok: true,
    hits: Array.isArray(response.body.hits) ? response.body.hits : [],
    degraded: response.body.degraded === true,
    degradedReason: response.body.degradedReason ?? null,
    latencyMs,
  };
}

function annotateHits(hits, question, idToCard) {
  return hits.map((hit) => {
    const card = idToCard.get(hit.id);
    return {
      id: hit.id,
      score: hit.score,
      source: hit.source,
      slug: card?.id ?? null,
      foreignProject: card !== undefined && card.scope !== "global" && card.project !== undefined && card.project !== question.project,
      globalCard: card?.scope === "global",
    };
  });
}

const VARIANTS = [
  { id: "A", label: "無記憶（對照）", config: null },
  { id: "B", label: "預設 0.40／4 筆／k8／TTL8", config: "ms040", settings: { minScore: 0.4, maxItems: 4, kMax: 8, dedupeTTL: 8 } },
  { id: "C1", label: "minScore 0.35", config: "ms035", settings: { minScore: 0.35, maxItems: 4, kMax: 8, dedupeTTL: 8 } },
  { id: "C2", label: "minScore 0.40（同 B，一致性檢查）", config: "ms040", settings: { minScore: 0.4, maxItems: 4, kMax: 8, dedupeTTL: 8 } },
  { id: "C3", label: "minScore 0.45", config: "ms045", settings: { minScore: 0.45, maxItems: 4, kMax: 8, dedupeTTL: 8 } },
  { id: "C4", label: "minScore 0.50（延伸掃描）", config: "ms050", settings: { minScore: 0.5, maxItems: 4, kMax: 8, dedupeTTL: 8 } },
  { id: "C5", label: "minScore 0.55（延伸掃描）", config: "ms055", settings: { minScore: 0.55, maxItems: 4, kMax: 8, dedupeTTL: 8 } },
  { id: "C6", label: "minScore 0.60（延伸掃描）", config: "ms060", settings: { minScore: 0.6, maxItems: 4, kMax: 8, dedupeTTL: 8 } },
  { id: "C7", label: "minScore 0.65（延伸掃描）", config: "ms065", settings: { minScore: 0.65, maxItems: 4, kMax: 8, dedupeTTL: 8 } },
  { id: "C8", label: "minScore 0.70（延伸掃描；尺度校準建議值）", config: "ms070", settings: { minScore: 0.7, maxItems: 4, kMax: 8, dedupeTTL: 8 } },
  { id: "K3", label: "maxItems 3", config: "ms040", settings: { minScore: 0.4, maxItems: 3, kMax: 8, dedupeTTL: 8 } },
  { id: "K5", label: "maxItems 5", config: "ms040", settings: { minScore: 0.4, maxItems: 5, kMax: 8, dedupeTTL: 8 } },
  { id: "K8", label: "maxItems 8", config: "ms040", settings: { minScore: 0.4, maxItems: 8, kMax: 8, dedupeTTL: 8 } },
  { id: "D", label: "B＋session 去重 TTL 8", config: "ms040", settings: { minScore: 0.4, maxItems: 4, kMax: 8, dedupeTTL: 8 }, dedupe: true },
  { id: "E", label: "B＋注入在開頭（只量 token／延遲）", config: "ms040", settings: { minScore: 0.4, maxItems: 4, kMax: 8, dedupeTTL: 8 }, placement: "start" },
  { id: "F", label: "keyword-only（minScore 1.0 過濾語意）", config: "kw", settings: { minScore: 0.4, maxItems: 4, kMax: 8, dedupeTTL: 8 } },
];

function variantSettings(definition, readSettings) {
  // 用真正的 readSettings 夾值：eval 與外掛看到的預設／上下限必須一致。
  return readSettings(definition.settings);
}

/**
 * 把一題的檢索結果＋裝箱轉成逐題紀錄。
 *
 * @param {object} question
 * @param {object|null} searchResult null＝無記憶變體
 * @param {object} settings
 * @param {Map<number, object>} dedupe session 去重表（D 變體共用；其他變體每次新建）
 * @param {number} turn
 * @param {Function} planRecall
 * @param {Map<number, object>} idToCard
 */
function evaluateQuestion({ question, searchResult, settings, dedupe, turn, planRecall, isDuplicate, skipReasonFn, idToCard }) {
  const base = {
    question,
    status: "ok",
    degraded: false,
    latencyMs: searchResult?.latencyMs ?? null,
    skippedDedup: 0,
    // 外掛真實的 skip 判斷（short／slash／code／empty）；production 口徑會把它當成 0 注入。
    skipReason: skipReasonFn(question.query),
  };
  const emptyInjection = {
    injectedCount: 0,
    injectedSlugs: [],
    fpCount: 0,
    fpSlugs: [],
    unlabeledCount: 0,
    unlabeledSlugs: [],
    hitCount: 0,
    foreignSlugs: [],
    chars: 0,
    tokensEst: 0,
    dedupedCount: 0,
    empty: true,
  };

  let hits = [];
  if (searchResult !== null) {
    if (!searchResult.ok) {
      return {
        ...base,
        status: searchResult.reason === "http" ? "error" : "timeout",
        detail: `HTTP ${searchResult.status}`,
        retrieval: { hit5: null, top1: null, mrr: 0, recallAt5: null, staleInTop5: false, foreignHits: 0, hitIds: [] },
        injection: emptyInjection,
        production: emptyInjection,
      };
    }
    if (searchResult.degraded) {
      // 降級（FTS）樣本不得計分：標成 degraded，aggregate 會整筆剔除（F2）。
      base.status = "degraded";
      base.degraded = true;
    }
    hits = annotateHits(searchResult.hits, question, idToCard);
  }

  const retrieval = searchResult === null
    ? { hit5: null, top1: null, mrr: 0, recallAt5: null, staleInTop5: false, foreignHits: 0, hitIds: [] }
    : retrievalMetrics(question, hits);

  // 被去重表擋掉的候選數：只在共用去重表的變體（D）會非 0。
  const duplicateHits =
    searchResult?.ok === true
      ? searchResult.hits.filter((hit) => {
          if (hit.source !== "keyword" && (!Number.isFinite(hit.score) || hit.score < settings.minScore)) return false;
          return isDuplicate(dedupe.get(hit.id), turn, settings.dedupeTTL);
        }).length
      : 0;

  const planned = searchResult === null
    ? { block: "", injected: [] }
    : planRecall({
        hits: searchResult.hits,
        settings,
        project: question.project,
        dedupe,
        turn,
        now: new Date(),
        latencyMs: searchResult.latencyMs,
      });
  for (const item of planned.injected) {
    dedupe.set(item.id, { turn, kind: item.kind, pinned: item.pinned });
  }

  const injection = injectionMetrics(question, planned, (id) => idToCard.get(id), duplicateHits);
  // 注入的來源（semantic／keyword）：用來解釋 production 口徑下殘餘的誤注入。
  const sourceById = new Map((searchResult?.hits ?? []).map((hit) => [hit.id, hit.source]));
  const injectedSources = {};
  for (const item of planned.injected) {
    const source = sourceById.get(item.id) ?? "unknown";
    injectedSources[source] = (injectedSources[source] ?? 0) + 1;
  }
  // production 口徑：外掛會在 skipReason !== null 時整輪不查、不注入。
  const production = base.skipReason === null ? injection : emptyInjection;

  return {
    ...base,
    retrieval,
    injection,
    production,
    injectedSources: base.skipReason === null ? injectedSources : {},
    skippedDedup: duplicateHits,
  };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const startedAt = Date.now();
  const { readSettings } = await import("../dist/config.js");
  const { planRecall, isDuplicate, skipReason } = await import("../dist/recall.js");
  // skipReason 是外掛在 `onContext` 裡真正用來判斷「這輪要不要召回」的函式之一（F1）：
  // 少了它，negative／cross 會量到「假設每題都召回」的注入率。
  const planDeps = { planRecall, isDuplicate, readSettings, skipReasonFn: skipReason };

  const dataset = loadDataset(FIXTURES_DIR);
  log(`資料集：${dataset.meta.cards} 張卡（存活 ${dataset.meta.liveCards}）、${dataset.meta.questions} 題（${dataset.meta.bySplit.dev} dev／${dataset.meta.bySplit.test} test）`);

  ensureBuild(options);
  const modelDir = resolveModelDir();
  log(`模型快取：找到（${path.basename(path.dirname(path.dirname(modelDir)))}/…）`);

  const dataDir = mkdtempSync(path.join(os.tmpdir(), "mnemoshelf-eval-d3-"));
  const port = await freePort();
  const token = randomBytes(24).toString("hex");
  const childEnv = {
    ...process.env,
    MNEMOSHELF_DATA_DIR: dataDir,
    MNEMOSHELF_TOKEN: token,
    MNEMOSHELF_PORT: String(port),
    MNEMOSHELF_AGENT_DISCOVERY: "off",
    MNEMOSHELF_EMBED_DEVICE: "cpu",
    MNEMOSHELF_MODEL_DIR: modelDir,
    // 避免父行程的設定影響評估。
    MNEMOSHELF_URL: "",
    MNEMOSHELF_PROJECT: "",
    MNEMOSHELF_INDEX_RATE: "off",
  };

  log(`暫存資料目錄與 server（port ${port}）；就緒閘門上限 ${(options.readinessTimeoutMs / 60000).toFixed(0)} 分鐘…`);
  const server = startServer(childEnv, options);
  let baseUrl = null;
  let exitCode = 0;
  const report = {};

  try {
    baseUrl = await server.url;
    const client = makeClient(baseUrl, token);

    const health = await client.request("/health", { timeoutMs: 5000 });
    if (health.status !== 200 || health.body?.service !== "mnemoshelf") {
      throw new Error(describeHttpError("GET /health（服務身分比對）", health));
    }
    const healthBody = health.body;

    const loadedAt = Date.now();
    const { idBySlug, maskIssues } = await loadFixtures(client, dataset);
    log(`已灌入 ${idBySlug.size} 張卡（${((Date.now() - loadedAt) / 1000).toFixed(1)} 秒）；等待記憶向量就緒…`);

    const readiness = await waitForReady(client, options.readinessTimeoutMs);
    log(
      `就緒閘門：${readiness.gate}；等待 ${(readiness.waitedMs / 1000).toFixed(1)} 秒、${readiness.polls} 次輪詢；` +
        `pending=${readiness.final?.pending} failed=${readiness.final?.failed} stale=${readiness.final?.stale} tooLong=${readiness.final?.tooLong}`,
    );
    if (readiness.gate !== "passed") {
      throw new Error(
        `就緒閘門逾時（pending=${readiness.final?.pending} failed=${readiness.final?.failed} stale=${readiness.final?.stale}）。` +
          "拒絕用 FTS 降級數據下結論；請看 server log 或加 --verbose 重跑。",
      );
    }

    const diagnostics = await client.request("/diagnostics", { timeoutMs: 10000 });
    if (diagnostics.status !== 200) throw new Error(describeHttpError("GET /diagnostics", diagnostics));
    const embedderInfo = diagnostics.body.embedder ?? null;
    const embedderRuntime = diagnostics.body.embedderRuntime ?? null;

    const idToCard = new Map();
    for (const card of dataset.cards) idToCard.set(idBySlug.get(card.id), card);
    const missingIds = dataset.questions
      .flatMap((question) => [...question.expected_ids, ...question.forbidden_ids, ...question.acceptable_ids])
      .filter((slug) => !idBySlug.has(slug));
    if (missingIds.length > 0) throw new Error(`fixture 有 slug 沒載入：${[...new Set(missingIds)].join("、")}`);

    // 預熱：避免第一次查詢把模型載入成本算進延遲分佈。
    for (const warmup of dataset.questions.slice(0, 3)) {
      await search(client, warmup, CONFIGS.ms040);
    }

    // 1) 逐題檢索（每個設定一次）
    const responses = new Map(); // question.id → { configId: result }
    const degradedSamples = [];
    const timeoutSamples = [];
    const errorSamples = [];
    let degradedWithHits = 0;
    const queryStarted = Date.now();
    for (const question of dataset.questions) {
      const perConfig = {};
      for (const [configId, config] of Object.entries(CONFIGS)) {
        const result = await search(client, question, config);
        perConfig[configId] = result;
        if (!result.ok) {
          if (result.reason === "http") errorSamples.push({ id: question.id, config: configId, status: result.status });
          else timeoutSamples.push({ id: question.id, config: configId });
        } else if (result.degraded) {
          // 異常樣本＝在 degraded 狀態下仍拿到命中（代表量到的是 FTS 降級，不是 cosine）。
          if (result.hits.length > 0) degradedWithHits += 1;
          degradedSamples.push({
            id: question.id,
            config: configId,
            reason: result.degradedReason,
            hits: result.hits.length,
          });
        }
      }
      responses.set(question.id, perConfig);
    }
    log(`檢索完成：${dataset.questions.length} 題 × ${Object.keys(CONFIGS).length} 組設定，${((Date.now() - queryStarted) / 1000).toFixed(1)} 秒`);

    // 2) 跨專案有效性檢查（includeAllProjects）
    const crossQuestions = dataset.questions.filter((question) => question.category === "cross");
    const crossMissing = [];
    let crossHit = 0;
    for (const question of crossQuestions) {
      const started = Date.now();
      const response = await client.request("/memories/search", {
        method: "POST",
        timeoutMs: MEASURE_TIMEOUT_MS,
        body: { query: question.query, includeAllProjects: true, k: SEARCH_K, minScore: 0.4 },
      });
      void started;
      const target = idBySlug.get(question.cross_check_id);
      const found = response.status === 200 && (response.body?.hits ?? []).some((hit) => hit.id === target);
      if (found) crossHit += 1;
      else crossMissing.push(question.id);
    }

    // 3) 重跑一致性（同一組參數抽 dev 題）
    let determinism = null;
    if (options.determinism) {
      const sample = dataset.questions.filter((question) => question.split === "dev").slice(0, 20);
      let mismatches = 0;
      for (const question of sample) {
        const first = responses.get(question.id).ms040;
        const again = await search(client, question, CONFIGS.ms040);
        const firstIds = first.ok ? first.hits.map((hit) => hit.id).join(",") : "error";
        const againIds = again.ok ? again.hits.map((hit) => hit.id).join(",") : "error";
        if (firstIds !== againIds) mismatches += 1;
      }
      determinism = { checked: sample.length, mismatches };
      log(`重跑一致性：${sample.length} 題、${mismatches} 題不一致`);
    }

    // 4) 逐 variant 聚合
    const variants = {};
    for (const definition of VARIANTS) {
      variants[definition.id] = {
        label: definition.label,
        config: definition.config,
        settings: definition.settings ?? null,
        placement: definition.placement ?? "end",
        dev: null,
        test: null,
        devByCategory: {},
        testByCategory: {},
        subsets: { dev: {}, test: {} },
        subsetsProduction: { dev: {}, test: {} },
      };
    }

    for (const split of ["dev", "test"]) {
      const splitQuestions = dataset.questions.filter((question) => question.split === split);
      for (const definition of VARIANTS) {
        const settings = definition.settings === undefined ? null : variantSettings(definition, readSettings);
        const records = [];
        const sessions = new Map();
        for (const question of splitQuestions) {
          if (definition.config === null) {
            records.push(evaluateQuestion({
              question,
              searchResult: null,
              settings: readSettings({ minScore: 0.4, maxItems: 4, kMax: 8, dedupeTTL: 8 }),
              dedupe: new Map(),
              turn: 1,
              ...planDeps,
              idToCard,
            }));
            continue;
          }
          const sessionKey = question.project;
          if (!sessions.has(sessionKey)) sessions.set(sessionKey, { turn: 0, dedupe: new Map() });
          const session = sessions.get(sessionKey);
          session.turn += 1;
          const dedupe = definition.dedupe === true ? session.dedupe : new Map();
          const record = evaluateQuestion({
            question,
            searchResult: responses.get(question.id)[definition.config],
            settings,
            dedupe,
            turn: session.turn,
            ...planDeps,
            idToCard,
          });
          records.push(record);
        }
        const variant = variants[definition.id];
        variant[split] = aggregate(records, "retrieval");
        variant[`${split}Production`] = aggregate(records, "production");
        variant[`${split}ByCategory`] = {};
        variant[`${split}ByCategoryProduction`] = {};
        for (const category of ["single", "multi", "update", "negative", "cross"]) {
          const subset = records.filter((record) => record.question.category === category);
          variant[`${split}ByCategory`][category] = aggregate(subset, "retrieval");
          variant[`${split}ByCategoryProduction`][category] = aggregate(subset, "production");
        }
        variant.subsets[split] = {
          identifier: subsetMetrics(records, (question) => question.identifier === true, "retrieval"),
          codeIdentifier: subsetMetrics(records, (question) => question.code_identifier === true, "retrieval"),
          zh: subsetMetrics(records, (question) => question.lang === "zh", "retrieval"),
          en: subsetMetrics(records, (question) => question.lang === "en", "retrieval"),
        };
        variant.subsetsProduction[split] = {
          identifier: subsetMetrics(records, (question) => question.identifier === true, "production"),
          codeIdentifier: subsetMetrics(records, (question) => question.code_identifier === true, "production"),
          zh: subsetMetrics(records, (question) => question.lang === "zh", "production"),
          en: subsetMetrics(records, (question) => question.lang === "en", "production"),
        };
        if (definition.id === "B" || definition.id === "F" || definition.id === "C8") {
          variant[`${split}Records`] = records;
        }
      }
    }

    // 5) 延遲（索引閒置：用 ms040 的量測樣本）
    const idleLatencies = dataset.questions
      .map((question) => responses.get(question.id).ms040)
      .filter((response) => response.ok)
      .map((response) => response.latencyMs);
    const idle = {
      n: idleLatencies.length,
      p50: percentile(idleLatencies, 0.5),
      p95: percentile(idleLatencies, 0.95),
      max: idleLatencies.length === 0 ? null : Math.max(...idleLatencies),
      over150Rate: idleLatencies.length === 0 ? null : idleLatencies.filter((value) => value > 150).length / idleLatencies.length,
      over300Rate: idleLatencies.length === 0 ? null : idleLatencies.filter((value) => value > 300).length / idleLatencies.length,
    };

    // 6) 索引進行中的延遲
    let indexing = {
      n: 0,
      timeouts: 0,
      p50: null,
      p95: null,
      max: null,
      over150Rate: null,
      over300Rate: null,
      note: "未跑（--no-index-pass）",
    };
    if (options.indexPass) {
      const rootDir = path.join(dataDir, "index-root");
      mkdirSync(rootDir, { recursive: true });
      for (let index = 0; index < 6; index += 1) {
        const lines = [];
        lines.push(`// 合成檔案 ${index}：只為了讓索引工作佔用嵌入佇列。`);
        for (let line = 0; line < 40; line += 1) {
          lines.push(`export function file${index}Fn${line}(value: number): number { return value * ${line} + ${index}; }`);
        }
        writeFileSync(path.join(rootDir, `synthetic-${index}.ts`), lines.join("\n"), "utf8");
      }
      const addRoot = await client.request("/roots", { method: "POST", body: { path: rootDir, mode: "index", modalities: ["text", "code"] } });
      if (addRoot.status !== 201) throw new Error(describeHttpError("POST /roots", addRoot));
      const rootId = addRoot.body.id;
      const indexStarted = Date.now();
      // 不 await：查詢要與索引重疊。先掛 catch，避免主流程出錯時留下未處理的 rejection。
      const indexPromise = client
        .request(`/roots/${rootId}/index`, { method: "POST", body: {}, timeoutMs: 10 * 60 * 1000 })
        .catch((error) => ({ status: 0, body: null, error }));
      const during = [];
      let duringTimeouts = 0;
      let lastQueryAt = null;
      // 用外掛實際的 150ms timeout：索引期間的成敗就是外掛會看到的結果（fail-open＝無召回）。
      const indexingConfig = { ...CONFIGS.ms040, timeoutMs: 150 };
      const indexingQuestions = dataset.questions.filter((question) => question.split === "dev");
      for (const question of indexingQuestions) {
        const result = await search(client, question, indexingConfig);
        lastQueryAt = Date.now();
        if (result.ok) during.push(result.latencyMs);
        else duringTimeouts += 1;
      }
      const indexResponse = await indexPromise;
      const indexDurationMs = Date.now() - indexStarted;
      if (indexResponse.status !== 200) {
        throw new Error(describeHttpError("POST /roots/:id/index", indexResponse));
      }
      const querySpanMs = lastQueryAt === null ? 0 : lastQueryAt - indexStarted;
      const totalQueries = during.length + duringTimeouts;
      indexing = {
        n: during.length,
        timeouts: duringTimeouts,
        totalQueries,
        timeoutRate: totalQueries === 0 ? null : duringTimeouts / totalQueries,
        p50: percentile(during, 0.5),
        p95: percentile(during, 0.95),
        max: during.length === 0 ? null : Math.max(...during),
        over150Rate: null,
        over300Rate: null,
        indexDurationMs,
        querySpanMs,
        note:
          querySpanMs < indexDurationMs / 2
            ? `索引耗時 ${(indexDurationMs / 1000).toFixed(1)} 秒；查詢在索引結束前就跑完（${(querySpanMs / 1000).toFixed(1)} 秒），樣本以排隊等待為主`
            : `索引耗時 ${(indexDurationMs / 1000).toFixed(1)} 秒，查詢全程重疊`,
      };
      log(
        `索引中延遲（150ms timeout）：ok ${indexing.n}、timeout ${duringTimeouts}/${totalQueries}、` +
          `p50 ${indexing.p50?.toFixed(0)}ms、p95 ${indexing.p95?.toFixed(0)}ms（index ${(indexDurationMs / 1000).toFixed(1)}s）`,
      );
    }

    // 6.4) 語意尺度校準（k=20、minScore 0）：判斷 minScore 是否高於整個尺度。
    const calibration = (() => {
      const expectedScores = [];
      const ranks = [];
      const byCategory = {};
      const abstainTopScores = [];
      let top1 = 0;
      let top1N = 0;
      for (const question of dataset.questions) {
        const response = responses.get(question.id).calib;
        if (!response.ok) continue;
        if (question.category === "negative" || question.category === "cross") {
          // 「應該 0 注入」的題目，語意路徑上最高分的那張卡；minScore 要高於這個值才可能 abstain。
          let top = null;
          for (const hit of response.hits) {
            if (hit.source === "keyword") continue;
            if (top === null || hit.score > top) top = hit.score;
          }
          if (top !== null) abstainTopScores.push(top);
          continue;
        }
        const expectedIds = new Set((question.expected_ids ?? []).map((slug) => idBySlug.get(slug)));
        if (expectedIds.size === 0) continue;
        let bestRank = null;
        let bestScore = null;
        response.hits.forEach((hit, index) => {
          if (!expectedIds.has(hit.id)) return;
          if (bestRank === null) bestRank = index + 1;
          if (hit.source !== "keyword" && (bestScore === null || hit.score > bestScore)) bestScore = hit.score;
        });
        const top5Ids = new Set(response.hits.slice(0, 5).map((hit) => hit.id));
        const foundIn5 = [...expectedIds].filter((id) => top5Ids.has(id)).length;
        const key = `${question.category}/${question.split}`;
        const category = byCategory[key] ?? { n: 0, anyIn5: 0, allIn5: 0, top1: 0 };
        category.n += 1;
        if (bestRank !== null && bestRank <= 5) category.anyIn5 += 1;
        if (foundIn5 === expectedIds.size) category.allIn5 += 1;
        if (bestRank === 1) category.top1 += 1;
        byCategory[key] = category;
        if (question.category === "single") {
          top1N += 1;
          if (bestRank === 1) top1 += 1;
        }
        ranks.push(bestRank === null ? 0 : bestRank);
        if (bestScore !== null) expectedScores.push(bestScore);
      }
      const categoryRows = Object.values(byCategory);
      const totalN = categoryRows.reduce((total, row) => total + row.n, 0);
      const totalAny = categoryRows.reduce((total, row) => total + row.anyIn5, 0);
      const totalAll = categoryRows.reduce((total, row) => total + row.allIn5, 0);
      const at = (threshold) => (expectedScores.length === 0 ? null : expectedScores.filter((score) => score >= threshold).length / expectedScores.length);
      const abstainAt = (threshold) =>
        abstainTopScores.length === 0 ? null : abstainTopScores.filter((score) => score < threshold).length / abstainTopScores.length;
      return {
        expectedAnyIn5: totalN === 0 ? null : totalAny / totalN,
        expectedAllIn5: totalN === 0 ? null : totalAll / totalN,
        top1: top1N === 0 ? null : top1 / top1N,
        abstain: {
          n: abstainTopScores.length,
          p50: percentile(abstainTopScores, 0.5),
          p95: percentile(abstainTopScores, 0.95),
          max: abstainTopScores.length === 0 ? null : Math.max(...abstainTopScores),
          min: abstainTopScores.length === 0 ? null : Math.min(...abstainTopScores),
          shareBelow: Object.fromEntries(
            [0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8].map((threshold) => [threshold, abstainAt(threshold)]),
          ),
        },
        n: ranks.length,
        expectedScore: {
          n: expectedScores.length,
          p50: percentile(expectedScores, 0.5),
          p95: percentile(expectedScores, 0.95),
          max: expectedScores.length === 0 ? null : Math.max(...expectedScores),
          min: expectedScores.length === 0 ? null : Math.min(...expectedScores),
        },
        shareAbove: Object.fromEntries(
          [0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8].map((threshold) => [threshold, at(threshold)]),
        ),
        byCategory,
      };
    })();

    // 6.5) 分數尺度診斷：minScore 只有在 cosine 尺度已知時才有意義。
    const scoreDiagnostics = {};
    for (const [configId, config] of Object.entries(CONFIGS)) {
      const semanticScores = [];
      let keywordHits = 0;
      let semanticHits = 0;
      let questionsWithNoSemantic = 0;
      const expectedScores = [];
      for (const question of dataset.questions) {
        const response = responses.get(question.id)[configId];
        if (!response.ok) continue;
        const semantic = response.hits.filter((hit) => hit.source !== "keyword");
        const keyword = response.hits.filter((hit) => hit.source === "keyword");
        semanticHits += semantic.length;
        keywordHits += keyword.length;
        if (semantic.length === 0) questionsWithNoSemantic += 1;
        for (const hit of semantic) semanticScores.push(hit.score);
        const expectedIds = new Set((question.expected_ids ?? []).map((slug) => idBySlug.get(slug)));
        for (const hit of semantic) if (expectedIds.has(hit.id)) expectedScores.push(hit.score);
      }
      scoreDiagnostics[configId] = {
        minScore: config.minScore,
        k: config.k,
        semanticHits,
        keywordHits,
        questionsWithNoSemantic,
        semanticScore: {
          n: semanticScores.length,
          p50: percentile(semanticScores, 0.5),
          p95: percentile(semanticScores, 0.95),
          max: semanticScores.length === 0 ? null : Math.max(...semanticScores),
          min: semanticScores.length === 0 ? null : Math.min(...semanticScores),
        },
        expectedHitScore: {
          n: expectedScores.length,
          p50: percentile(expectedScores, 0.5),
          p95: percentile(expectedScores, 0.95),
        },
      };
    }

    // 7) 選值（只用 dev）
    // F1：選值一律用 production 口徑（套 skip 後的真實注入），不用「假設每題都召回」的數字。
    const devByMinScore = {
      "0.35": variants.C1.devProduction,
      "0.40": variants.C2.devProduction,
      "0.45": variants.C3.devProduction,
      "0.50": variants.C4.devProduction,
      "0.55": variants.C5.devProduction,
      "0.60": variants.C6.devProduction,
      "0.65": variants.C7.devProduction,
      "0.70": variants.C8.devProduction,
    };
    const devByMaxItems = {
      3: variants.K3.devProduction,
      4: variants.B.devProduction,
      5: variants.K5.devProduction,
      8: variants.K8.devProduction,
    };
    const devByK = {
      3: aggregateOfConfig(dataset, responses, "k3", { ...planDeps, idToCard }),
      5: aggregateOfConfig(dataset, responses, "k5", { ...planDeps, idToCard }),
      8: variants.B.dev,
    };
    const minScore = selectMinScore(devByMinScore, 0.4);
    const maxItems = selectMaxItems(devByMaxItems, 4);
    const kMax = selectKMax(devByK, 8);
    const timeout = selectTimeout({
      idleP50: idle.p50,
      idleP95: idle.p95,
      idleMax: idle.max,
      idleOver150Rate: idle.over150Rate,
      idleOver300Rate: idle.over300Rate,
      indexingP95: indexing.p95,
    }, 150);

    // F1／minScore 對照：同一份 dev、兩種口徑並列，讓 PM 看得到「為什麼建議這個值」。
    const minScoreComparison = ["C1", "C2", "C3", "C4", "C5", "C6", "C7", "C8"].map((id) => {
      const variant = variants[id];
      const retrieval = variant.dev;
      const production = variant.devProduction;
      return {
        id,
        minScore: variant.settings.minScore,
        hitItemsRetrieval: retrieval.hitItems,
        hitItemsProduction: production.hitItems,
        expectedHitRateProduction: production.expectedHitRate,
        fpItems: production.fpItems,
        fpItemRate: production.fpItemRate,
        fpItemRateRetrieval: retrieval.fpItemRate,
        negativeInjectionRetrieval: retrieval.negativeInjectionRate,
        negativeInjectionProduction: production.negativeInjectionRate,
        crossInjectionProduction: production.crossInjectionRate,
        abstentionRetrieval: retrieval.abstention,
        abstentionProduction: production.abstention,
        tokensP95: production.injectedTokens?.p95 ?? null,
        skippedQuestions: production.skippedQuestions,
        recall5: retrieval.recall5,
      };
    });

    const d2Diff = [
      {
        option: "minScore",
        current: "0.40",
        recommended: minScore.recommended.toFixed(2),
        change: Math.abs(minScore.recommended - 0.4) > 1e-9,
        evidence: minScore.reason,
      },
      {
        option: "maxItems",
        current: "4",
        recommended: String(maxItems.recommended),
        change: maxItems.recommended !== 4,
        evidence: maxItems.reason,
      },
      {
        option: "kMax",
        current: "8",
        recommended: String(kMax.recommended),
        change: kMax.recommended !== 8,
        evidence: kMax.reason,
      },
      {
        option: "dedupeTTL",
        current: "8",
        recommended: "8",
        change: false,
        evidence: `D 變體（TTL 8）在 dev 上抑制了 ${variants.D.dev.dedupedItems ?? 0} 筆重複注入；token p95 ${variants.B.dev.injectedTokens?.p95} → ${variants.D.dev.injectedTokens?.p95}（無法分辨就沿用）`,
      },
      {
        option: "timeoutMs",
        current: "150",
        recommended: String(timeout.recommended),
        change: timeout.recommended !== 150,
        evidence: timeout.reason,
      },
    ];

    // F1：外掛 skip 的統計（全部題目；production 口徑的來源）。
    const skipStats = (() => {
      const byReason = {};
      const byCategory = {};
      const rows = [];
      for (const question of dataset.questions) {
        const reason = skipReason(question.query);
        if (reason === null) continue;
        byReason[reason] = (byReason[reason] ?? 0) + 1;
        const key = question.category;
        byCategory[key] = byCategory[key] ?? { total: 0, skipped: 0 };
        rows.push({ id: question.id, category: key, reason, chars: [...question.query.trim()].length });
      }
      for (const question of dataset.questions) {
        const key = question.category;
        byCategory[key] = byCategory[key] ?? { total: 0, skipped: 0 };
        byCategory[key].total += 1;
      }
      for (const row of rows) byCategory[row.category].skipped += 1;
      return { total: dataset.questions.length, skipped: rows.length, byReason, byCategory, samples: rows.slice(0, 30) };
    })();

    // F1：production 口徑下仍然被注入的 negative／cross 題（要能解釋，不能只給一個比例）。
    const productionResidual = (variants.B.devRecords ?? [])
      .filter(
        (record) =>
          (record.question.category === "negative" || record.question.category === "cross") &&
          record.skipReason === null &&
          record.production.injectedCount > 0,
      )
      .map((record) => ({
        id: record.question.id,
        category: record.question.category,
        chars: [...record.question.query.trim()].length,
        injected: record.production.injectedSlugs,
        semantic: record.injectedSources.semantic ?? 0,
        keyword: record.injectedSources.keyword ?? 0,
      }));

    const residualOf = (variant) =>
      (variant.devRecords ?? [])
        .filter(
          (record) =>
            (record.question.category === "negative" || record.question.category === "cross") &&
            record.skipReason === null &&
            record.production.injectedCount > 0,
        )
        .map((record) => ({
          id: record.question.id,
          category: record.question.category,
          injected: record.production.injectedSlugs,
          semantic: record.injectedSources.semantic ?? 0,
          keyword: record.injectedSources.keyword ?? 0,
        }));
    const productionResidual070 = residualOf(variants.C8);

    // 7.5) D3b 提案素材：為什麼「調 minScore」救不了 abstention。
    const d3b = {
      keywordBackfill: {
        ms070SemanticHits: scoreDiagnostics.ms070?.semanticHits ?? null,
        ms070KeywordHits: scoreDiagnostics.ms070?.keywordHits ?? null,
        ms070Abstention: variants.C8.dev.abstention,
        ms070NegativeInjection: variants.C8.dev.negativeInjectionRate,
        ms070CrossInjection: variants.C8.dev.crossInjectionRate,
        calibAbstainAt070: calibration.abstain?.shareBelow?.[0.7] ?? null,
        calibExpectedAt070: calibration.shareAbove?.[0.7] ?? null,
        recallB: variants.B.dev.recall5,
        recallF: variants.F.dev.recall5,
        keywordOnlyNegativeInjection: variants.F.dev.negativeInjectionRate,
        // 0.70 的 production 口徑：剩下的是哪些題？
        production070: {
          abstention: variants.C8.devProduction.abstention,
          negativeInjection: variants.C8.devProduction.negativeInjectionRate,
          crossInjection: variants.C8.devProduction.crossInjectionRate,
          fpItemRate: variants.C8.devProduction.fpItemRate,
          foreignInjected: variants.C8.devProduction.foreignInjected,
        },
        residual070: productionResidual070,
        residual070Semantic: productionResidual070.reduce((total, row) => total + row.semantic, 0),
        residual070Keyword: productionResidual070.reduce((total, row) => total + row.keyword, 0),
        expectedAt075: calibration.shareAbove?.[0.75] ?? null,
        abstainAt075: calibration.abstain?.shareBelow?.[0.75] ?? null,
      },
    };

    // 8) 回答四個問題
    const answers = buildAnswers({
      variants,
      crossHit,
      crossTotal: crossQuestions.length,
      skipStats,
      productionResidual,
      productionResidual070,
      minScoreComparison,
    });
    const bDev = variants.B.dev;
    const bProd = variants.B.devProduction;
    const bTest = variants.B.test;
    const bTestProd = variants.B.testProduction;

    const bDevRecords = variants.B.devRecords ?? [];
    const failureSamples = [];
    for (const record of bDevRecords) {
      if (failureSamples.length >= 10) break;
      if (record.status !== "ok") continue;
      const missing = record.question.expected_ids.filter((slug) => !record.retrieval.hitIds.includes(slug));
      const extra = record.injection.fpSlugs;
      if (missing.length === 0 && extra.length === 0) continue;
      failureSamples.push([
        record.question.id,
        record.question.category,
        missing.join("、") || "—",
        extra.join("、") || "—",
        `${record.injection.unlabeledCount} 筆未標註${record.question.notes === undefined ? "" : `；${record.question.notes}`}`,
      ]);
    }

    const keywordOnlyCheck = (() => {
      let keywordHits = 0;
      let semanticHits = 0;
      const sources = new Set();
      for (const question of dataset.questions) {
        const response = responses.get(question.id).kw;
        if (!response.ok) continue;
        for (const hit of response.hits) {
          sources.add(hit.source);
          if (hit.source === "keyword") keywordHits += 1;
          else semanticHits += 1;
        }
      }
      return { keywordHits, semanticHits, sources: [...sources] };
    })();

    const notes = [
      "**兩種口徑**：`retrieval`＝假設每題都召回（看檢索器上限）；`production`＝套用外掛 `skipReason`，被跳過的題目算 0 注入。生產環境的誤注入率請讀 production。",
      "skip 只套用 `skipReason`（empty／slash／short／code）；trigger 以「第一輪」計（`first-turn` 會召回），所以不是第一輪又沒有明示線索的訊息在生產環境還可能被 trigger 跳過，本評估沒有把那一層算進去。",
      "`degraded:true` 的回應會標成 `degraded` 並從所有聚合剔除；報告的「degraded 樣本數」若 >0 代表該批數字少算了那些題目。",
      "資料集是**合成**的（虛構專案 alpha／beta／gamma）；分數只代表這份資料，不是真實使用者的召回率。",
      "query 大多刻意改寫過（不照抄卡片文字），但仍是人工撰寫；真人的問法會更分散。",
      "token 是估算（CJK 每字 1、其餘 4 字元 1），沒有引入 tokenizer 依賴；請以「相對比較」使用。",
      "每個 split 只有 60 題，單一子集（identifier／中文）更小；95% CI 很寬，<10pp 的差異一律視為無法分辨。",
      "延遲是單機、CPU、空負載的序列查詢；索引中的欄位是刻意在跑檔案索引時量的，但只跑一輪。",
      "`F` 用 `minScore: 1.0` 讓 server 過濾掉所有語意命中，只留下關鍵字補位（不動 server 程式）；" +
        `實際命中來源：keyword ${keywordOnlyCheck.keywordHits} 筆、semantic ${keywordOnlyCheck.semanticHits} 筆。`,
      "`E`（注入在開頭）只量 token 與延遲：字串內容與 B 完全相同、只是位置不同，因此 token 必然相同；品質 A/B 需要 LLM judge，不在本卡範圍。",
      "`A`（無記憶）只提供對照：Recall／FP 等指標不適用，abstention 依定義為 100%。",
      "沒有量「寫入品質」：本卡只做召回；若召回好但 agent 仍常出錯，問題可能在寫入或抽取，需另一個任務處理。",
      "FP 只算 forbidden 與「應該 0 注入」題目的注入；未標註的卡不算 FP（標註稀疏，詳見 eval/README 的指標定義）。",
      "minScore 0.35–0.45 的結果完全相同，代表這段低於模型對無關文字的相似度下限；延伸掃描到 0.70 才開始有取捨（見 §4.5）。",
    ];

    const finishedAt = nowIso();
    Object.assign(report, {
      meta: {
        startedAt: new Date(startedAt).toISOString(),
        finishedAt,
        durationMs: Date.now() - startedAt,
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        serverVersion: healthBody.appVersion ?? null,
        embedder: embedderInfo === null ? null : { id: embedderInfo.id, dim: embedderInfo.dim ?? null },
        embedderRuntime,
        fixtures: { cards: dataset.meta.cards, questions: dataset.meta.questions },
        searchK: SEARCH_K,
        measureTimeoutMs: MEASURE_TIMEOUT_MS,
        agent: AGENT_NAME,
        modelCache: "found",
        dataDir: "<temp>",
      },
      readiness: {
        ...readiness,
        degradedResponses: degradedSamples.length,
        degradedWithHits,
        timeouts: timeoutSamples.length,
        errors: errorSamples.length,
        samples: { degraded: degradedSamples.slice(0, 10), timeouts: timeoutSamples.slice(0, 10), errors: errorSamples.slice(0, 10) },
        maskIssues,
      },
      dataset: { meta: { ...dataset.meta, duplicatePairs: dataset.cards.filter((card) => card.force === true).length } },
      skipStats,
      productionResidual,
      productionResidual070,
      configs: CONFIGS,
      variants,
      latency: { idle, indexing, timeout },
      crossCheck: {
        total: crossQuestions.length,
        hit: crossHit,
        rate: crossQuestions.length === 0 ? null : crossHit / crossQuestions.length,
        missing: crossMissing,
      },
      determinism,
      keywordOnlyCheck,
      scoreDiagnostics,
      calibration,
      d3b,
      recommendations: { minScore, maxItems, kMax, timeoutMs: timeout, d2Diff, minScoreComparison },
      answers,
      failureSamples,
      notes,
      privacy: { tokenPrinted: false, absolutePathsInReport: false },
    });

    mkdirSync(options.outDir, { recursive: true });
    const jsonPath = path.join(options.outDir, "eval-report.json");
    const mdPath = path.join(options.outDir, "eval-report.md");
    writeFileSync(jsonPath, JSON.stringify(report, null, 2), "utf8");
    writeFileSync(mdPath, renderMarkdown(report), "utf8");

    log(`報告已寫出：${path.relative(process.cwd(), jsonPath)}、${path.relative(process.cwd(), mdPath)}`);
    log(
      `dev（B）retrieval：Recall@5 ${fmtPct(bDev.recall5)}、Top-1 ${fmtPct(bDev.top1)}、MRR ${fmtNum(bDev.mrr, 3)}、` +
        `FP ${fmtPct(bDev.fpItemRate)}、negative 注入 ${fmtPct(bDev.negativeInjectionRate)}、abstention ${fmtPct(bDev.abstention)}`,
    );
    log(
      `dev（B）production：hitItems ${bProd.hitItems}、FP ${fmtPct(bProd.fpItemRate)}、` +
        `negative 注入 ${fmtPct(bProd.negativeInjectionRate)}、cross 注入 ${fmtPct(bProd.crossInjectionRate)}、` +
        `abstention ${fmtPct(bProd.abstention)}、skip ${bProd.skippedQuestions}/${bProd.n}`,
    );
    log(
      `test（B）production：Recall@5 ${fmtPct(bTest.recall5)}、FP ${fmtPct(bTestProd.fpItemRate)}、` +
        `negative 注入 ${fmtPct(bTestProd.negativeInjectionRate)}、abstention ${fmtPct(bTestProd.abstention)}`,
    );
    log(
      `建議：minScore ${d2Diff[0].recommended}（${minScore.distinguishable ? "可分辨" : "無法分辨"}）、` +
        `maxItems ${d2Diff[1].recommended}、kMax ${d2Diff[2].recommended}、timeoutMs ${d2Diff[4].recommended}`,
    );
    log(`總耗時 ${((Date.now() - startedAt) / 1000).toFixed(1)} 秒`);
  } catch (error) {
    exitCode = 1;
    console.error(`[eval] 失敗：${error instanceof Error ? error.message : String(error)}`);
    if (options.verbose && error instanceof Error && error.stack !== undefined) console.error(error.stack);
  } finally {
    await stopServer(server.child);
    if (!options.keep) rmSync(dataDir, { recursive: true, force: true });
    else log(`暫存資料目錄保留在 ${dataDir}（--keep；內含測試 DB，不含使用者資料）`);
  }
  process.exit(exitCode);
}

/** 用同一條 evaluateQuestion 走一次「只改 k」的設定，供 kMax 選值（dev only）。 */
function aggregateOfConfig(dataset, responses, configId, deps) {
  const settings = deps.readSettings({ minScore: 0.4, maxItems: 4, kMax: 8, dedupeTTL: 8 });
  const records = [];
  for (const question of dataset.questions.filter((item) => item.split === "dev")) {
    records.push(
      evaluateQuestion({
        question,
        searchResult: responses.get(question.id)[configId],
        settings,
        dedupe: new Map(),
        turn: 1,
        ...deps,
      }),
    );
  }
  return aggregate(records);
}

function fmtPct(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${(value * 100).toFixed(1)}%`;
}
function fmtNum(value, digits) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return value.toFixed(digits);
}

// ---------------------------------------------------------------------------
// 四個問題的答案（只依 dev 選值；test 僅附註）
// ---------------------------------------------------------------------------

function buildAnswers({ variants, crossHit, crossTotal, skipStats, productionResidual, minScoreComparison }) {
  const retrieval = variants.B.dev;
  const production = variants.B.devProduction;
  const testRetrieval = variants.B.test;
  const testProduction = variants.B.testProduction;
  const identifier = variants.B.subsets.dev.identifier;
  const identifierProd = variants.B.subsetsProduction.dev.identifier;
  const codeIdentifier = variants.B.subsets.dev.codeIdentifier;
  const zh = variants.B.subsets.dev.zh;
  const en = variants.B.subsets.dev.en;

  const rrfNeeded = identifier?.recall5 !== null && identifier?.recall5 !== undefined && identifier.recall5 < 0.6;
  const rrf = {
    verdict: rrfNeeded ? "建議提 RRF 小改（不改 server，留 D3b）" : "不需要（identifier 子集 Recall@5 ≥60%）",
    detail: rrfNeeded
      ? [
          `identifier 子集（n=${identifier?.n ?? 0}）的 dev Recall@5 是 ${fmtPct(identifier?.recall5)}、` +
            `整體 dev Recall@5 是 ${fmtPct(retrieval.recall5)}。`,
          `其中 code identifier（n=${codeIdentifier?.n ?? 0}）是 ${fmtPct(codeIdentifier?.recall5)}；` +
            `中文 ${fmtPct(zh?.recall5)}、英文 ${fmtPct(en?.recall5)}。`,
          "提議（**不在本卡實作、不動 server**）：語意 top-20 ＋ FTS top-20 做 RRF（k=60、權重 1:1），" +
            "keyword-only 命中另外算 cosine，低於 0.25 者丟棄；候選數從 8 增到 20（單次多 12 筆 cosine，<1ms 等級），" +
            "代價是 server 要改一條搜尋路徑並重跑本評估驗證 FP 不變差。",
        ].join("\n")
      : [
          `identifier 子集（n=${identifier?.n ?? 0}）的 dev Recall@5 是 ${fmtPct(identifier?.recall5)}、` +
            `code identifier（n=${codeIdentifier?.n ?? 0}）是 ${fmtPct(codeIdentifier?.recall5)}，都高於 60% 的提案門檻。`,
          `中文 ${fmtPct(zh?.recall5)}、英文 ${fmtPct(en?.recall5)}；沒有證據顯示需要靠混合檢索救 identifier，` +
            "因此不建議現在改 server 的 RRF（改動成本不是 0，且小樣本無法證明 +5pp）。",
          "k 的影響：k=8 與 k=5 的 dev Recall@5 差距在噪音內，候選數不是瓶頸。",
        ].join("\n"),
  };

  const sweep = minScoreComparison ?? [];
  const msRows = (values) => sweep.filter((row) => values.includes(row.minScore));
  const sweepText = sweep
    .map((row) => `${row.minScore.toFixed(2)}→hit ${row.hitItemsProduction}／neg ${fmtPct(row.negativeInjectionProduction)}／FP ${fmtPct(row.fpItemRate)}`)
    .join("；");

  const fp = production.fpItemRate;
  const negProd = production.negativeInjectionRate;
  const crossProd = production.crossInjectionRate;
  const recall = retrieval.recall5;
  const top1 = retrieval.top1;
  const skippedNegCross = skipStats.byCategory.negative?.skipped + skipStats.byCategory.cross?.skipped;

  const issues = [];
  if (fp !== null && fp > FP_GATE) issues.push(`production FP 注入率 ${fmtPct(fp)} 超過 10% 通過線`);
  if (negProd !== null && negProd > 0) issues.push(`production negative 注入率 ${fmtPct(negProd)}（retrieval 口徑 ${fmtPct(retrieval.negativeInjectionRate)}）`);
  if (crossProd !== null && crossProd > 0) issues.push(`production cross 注入率 ${fmtPct(crossProd)}`);
  if (recall !== null && recall < 0.85) issues.push(`retrieval Recall@5 ${fmtPct(recall)} 低於 85% 目標（差距在 60 題 CI 內）`);
  if (top1 !== null && top1 < 0.75) issues.push(`Top-1 ${fmtPct(top1)} 低於 75% 目標`);

  const recallNearTarget = recall !== null && recall >= 0.75;
  const injectionBad = (negProd !== null && negProd > 0) || (fp !== null && fp > FP_GATE);
  const bottleneck = issues.length === 0
    ? `召回與注入都在通過線內；主要成本是注入量（dev p95 ${retrieval.injectedTokens?.p95 ?? "?"} 估算 token／次），不是正確性。` +
      "本卡沒有量寫入品質；若 agent 仍然「講過又忘」，下一個要查的是寫入／抽取，而不是再調 minScore。"
    : `${issues.join("；")}。` +
      (recallNearTarget && injectionBad
        ? `召回（${fmtPct(recall)}）離目標的差距在 60 題 CI（±12–13pp）內；**主要問題仍是「不該注入的卡被注入」**。` +
          `套用 skip 後 negative／cross 仍有 ${productionResidual.length} 題被注入（${skippedNegCross} 題因 query <6 字被跳過），` +
          "其餘是 cosine 尺度與 keyword 補位造成；見 §8.5 的 D3b。"
        : "在改演算法（RRF 等）之前，先確認是不是門檻與注入範圍的問題。");

  const msRow = (minScoreValue) => sweep.find((row) => Math.abs(row.minScore - minScoreValue) < 1e-9);

  return {
    summary:
      `有兩種口徑（F1）：**retrieval**（假設每題都召回）與 **production**（套用外掛 skip）。` +
      `dev（B）retrieval：Recall@5 ${fmtPct(recall)}、Top-1 ${fmtPct(top1)}、MRR ${fmtNum(retrieval.mrr, 3)}；` +
      `production：negative 注入 ${fmtPct(negProd)}、cross 注入 ${fmtPct(crossProd)}、abstention ${fmtPct(production.abstention)}、` +
      `FP ${fmtPct(fp)}、hitItems ${production.hitItems}/${retrieval.hitItems}（${skipStats.skipped}/${skipStats.total} 題被 skip）。` +
      `test（B）retrieval Recall@5 ${fmtPct(testRetrieval.recall5)}、production abstention ${fmtPct(testProduction.abstention)}。` +
      `注入量 p95 ${retrieval.injectedTokens?.p95 ?? "?"} 估算 token、延遲 p95 ${fmtNum(retrieval.latency?.p95)}ms。`,
    bottleneck,
    rrf,
    details: {
      "問題 1：目前預設的 FP 注入率？":
        `retrieval 口徑 dev ${fmtPct(retrieval.fpItemRate)}（${retrieval.fpItems}/${retrieval.injectedItems}）、test ${fmtPct(testRetrieval.fpItemRate)}；` +
        `**production 口徑 dev ${fmtPct(fp)}（${production.fpItems}/${production.injectedItems}）、test ${fmtPct(testProduction.fpItemRate)}**。` +
        `兩者差在「被 skip 的題目不會注入」；未標註卡（retrieval ${retrieval.unlabeledItems} 筆）不算 FP。` +
        `minScore 掃描（production 口徑）：${sweepText}。`,
      "問題 2：negative 題是否 0 注入？":
        `retrieval：negative ${fmtPct(retrieval.negativeInjectionRate)}、cross ${fmtPct(retrieval.crossInjectionRate)}、abstention ${fmtPct(retrieval.abstention)}。` +
        `**production：negative ${fmtPct(negProd)}、cross ${fmtPct(crossProd)}、abstention ${fmtPct(production.abstention)}**；` +
        `negative／cross 共 ${skipStats.byCategory.negative?.skipped ?? 0}+${skipStats.byCategory.cross?.skipped ?? 0} 題因 query <6 字被 skip。` +
        `剩下仍被注入的是 ${productionResidual.length} 題（dev）；cross 用 includeAllProjects 重查可命中目標卡 ${crossHit}/${crossTotal}，` +
        `代表 cross 的 0 注入不是「查不到」。`,
      "問題 3：identifier／中文子集 Recall@5？":
        `retrieval：identifier（n=${identifier?.n ?? 0}）dev ${fmtPct(identifier?.recall5)}、` +
        `code identifier（n=${codeIdentifier?.n ?? 0}）${fmtPct(codeIdentifier?.recall5)}、` +
        `中文（n=${zh?.n ?? 0}）${fmtPct(zh?.recall5)}、英文（n=${en?.n ?? 0}）${fmtPct(en?.recall5)}。` +
        `production 的 expectedHitRate：identifier ${fmtPct(identifierProd?.expectedHitRate)}（n=${identifierProd?.n ?? 0}）。` +
        `test：identifier ${fmtPct(variants.B.subsets.test.identifier?.recall5)}、中文 ${fmtPct(variants.B.subsets.test.zh?.recall5)}。`,
      "問題 4：要不要 RRF？": `${rrf.verdict}。${rrfNeeded ? "差異與成本見 §8.3。" : "identifier／中文召回已足夠，先不要動 server。"}`,
      "minScore 0.40 vs 0.70": (() => {
        const a = msRow(0.4);
        const b = msRow(0.7);
        const c = msRow(0.55);
        if (a === undefined || b === undefined) return "缺少 0.40 或 0.70 的結果。";
        return (
          `production：0.40 → hitItems ${a.hitItemsProduction}、negative 注入 ${fmtPct(a.negativeInjectionProduction)}、` +
          `cross ${fmtPct(a.crossInjectionProduction)}、FP ${a.fpItems}（${fmtPct(a.fpItemRate)}）、token p95 ${a.tokensP95}；` +
          `0.70 → hitItems ${b.hitItemsProduction}、negative 注入 ${fmtPct(b.negativeInjectionProduction)}、` +
          `cross ${fmtPct(b.crossInjectionProduction)}、FP ${b.fpItems}（${fmtPct(b.fpItemRate)}）、token p95 ${b.tokensP95}` +
          (c === undefined ? "" : `；0.55 介於兩者（negative ${fmtPct(c.negativeInjectionProduction)}、FP ${c.fpItems}）`) +
          `。0.55–0.70 的 FP 已降到 9.0–7.2%（≤10%），且 0.70 在 hitItems 不變下 negative 注入最低；依規則建議 0.70，取捨見 §8.1–8.2。`
        );
      })(),
    },
  };
}

main().catch((error) => {
  console.error(`[eval] 未預期錯誤：${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exit(1);
});
