#!/usr/bin/env node
/**
 * L3 矩陣：同一份 30 回合 fixture，餵給多個摘要模型做同條件比較，產出排行榜。
 *
 * 用法：
 *   pnpm --filter @mnemoshelf/opencode-plugin eval:digest:matrix -- --models all
 *   node eval/digest/matrix.mjs [--models all|id,id] [--turns 10|all] [--dry-run]
 *                               [--max-calls N] [--allow-paid] [--out DIR]
 *                               [--no-build] [--keep] [--verbose]
 *
 * 預設 screening 前 10 回合（成本保護）；`--turns all` 才是完整 30 回合。
 * pnpm 10 會把 `--` 原樣傳給 script：parseArgs 會忽略它，並支援 `--flag value` 與 `--flag=value`。
 *
 * 退出碼：
 *   0 = 每個被選到的模型都跑完（RANKED）且五條硬門檻全過
 *   1 = 有任何模型 NOT RUN／ERROR／硬門檻 FAIL，或前置條件（預算、fixture）不成立
 */
import { promises as fs, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  describeHttpError,
  ensureBuild,
  freePort,
  log,
  makeClient,
  makeDataDir,
  randomToken,
  REPO_ROOT,
  resolveModelDir,
  startServer,
  stopServer,
  waitForReady,
} from "../loop/server.mjs";
import { estimateModelCalls, loadFixtures } from "./lib/fixtures.mjs";
import { aggregateMetrics } from "./lib/metrics.mjs";
import { PRODUCTION_DIGEST_TIMEOUT_MS, allHardPass, computeSignals, hardGates, rankResults, DISCRIMINATION } from "./lib/matrix-gates.mjs";
import {
  createMatrixRunner,
  loadMatrixCatalog,
  MatrixBudgetExceeded,
  resolveModelConfig,
  selectMatrixModels,
} from "./lib/matrix-models.mjs";
import { gitInfo, makeSanitizer, writeReport } from "./lib/matrix-report.mjs";
import { runDigestPipeline } from "./lib/pipeline.mjs";
import { SPIKE_FINDINGS, probeOpenCodeEndpoint } from "./lib/spike.mjs";
import { normalizeForMatch } from "./lib/text.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = path.resolve(HERE, "..", "..");
const FIXTURE_DIR = path.join(HERE, "fixtures");
const MODELS_FILE = path.join(HERE, "matrix-models.json");
const SCREENING_TURNS = 10;

function parseArgs(argv) {
  const options = {
    outDir: path.join(REPO_ROOT, ".tmp", "eval-digest-matrix"),
    modelsSpec: "all",
    turns: SCREENING_TURNS,
    dryRun: false,
    maxCalls: 100,
    allowPaid: false,
    build: true,
    keep: false,
    verbose: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    // pnpm 10 會把 `--` 原樣傳給 script；任何位置的 `--` 都只是分隔符。
    if (arg === "--") continue;
    if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--full" || arg === "--turns=all") {
      options.turns = null;
    } else if (arg === "--turns") {
      const value = argv[++index];
      options.turns = value === "all" ? null : Number(value);
    } else if (arg.startsWith("--turns=")) {
      const value = arg.slice("--turns=".length);
      options.turns = value === "all" ? null : Number(value);
    } else if (arg === "--models") {
      options.modelsSpec = argv[++index];
    } else if (arg.startsWith("--models=")) {
      options.modelsSpec = arg.slice("--models=".length);
    } else if (arg === "--out") {
      options.outDir = path.resolve(argv[++index]);
    } else if (arg.startsWith("--out=")) {
      options.outDir = path.resolve(arg.slice("--out=".length));
    } else if (arg === "--max-calls") {
      options.maxCalls = Number(argv[++index]);
    } else if (arg.startsWith("--max-calls=")) {
      options.maxCalls = Number(arg.slice("--max-calls=".length));
    } else if (arg === "--allow-paid") {
      options.allowPaid = true;
    } else if (arg === "--no-build") {
      options.build = false;
    } else if (arg === "--keep") {
      options.keep = true;
    } else if (arg === "--verbose") {
      options.verbose = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        "用法：node eval/digest/matrix.mjs [--models all|id,id] [--turns 10|all] [--dry-run]\n" +
          "                                [--max-calls N] [--allow-paid] [--out DIR]\n" +
          "                                [--no-build] [--keep] [--verbose]\n" +
          "pnpm：pnpm --filter @mnemoshelf/opencode-plugin eval:digest:matrix [-- --models all]（`--` 可有可無）",
      );
      process.exit(0);
    } else {
      throw new Error(`未知參數：${arg}`);
    }
  }
  if (!Number.isFinite(options.maxCalls) || options.maxCalls <= 0) {
    throw new Error(`--max-calls 必須是正整數（收到 ${options.maxCalls}）`);
  }
  if (options.turns !== null && (!Number.isInteger(options.turns) || options.turns <= 0)) {
    throw new Error(`--turns 必須是正整數或 all（收到 ${options.turns}）`);
  }
  return options;
}

/** 依 `--turns` 切出這一輪要跑的回合與期望值。 */
function sliceFixtures(fixtures, turns) {
  if (turns === null || turns >= fixtures.turns) {
    return {
      conversations: fixtures.conversations,
      expectations: fixtures.expectations,
      evaluatedTurns: fixtures.turns,
      mode: "full",
    };
  }
  const kept = fixtures.conversations.turns.slice(0, turns);
  const keptIds = new Set(kept.map((turn) => turn.id));
  const turnsById = {};
  for (const [id, expectation] of Object.entries(fixtures.expectations.turns ?? {})) {
    if (keptIds.has(id)) turnsById[id] = expectation;
  }
  return {
    conversations: { ...fixtures.conversations, turns: kept },
    expectations: { ...fixtures.expectations, turns: turnsById },
    evaluatedTurns: kept.length,
    mode: "screening",
  };
}

/** 同時有 recallQuery 與 recallMarker 的回合才會做搜尋。 */
function countRecallQueries(expectations) {
  return Object.values(expectations.turns ?? {}).filter(
    (entry) => typeof entry?.recallQuery === "string" && typeof entry?.recallMarker === "string",
  ).length;
}

/**
 * 檢查本 fixture 的「跨專案 marker」是否同時被某回合的 mustNotInclude 使用。
 *
 * 若是，兩條硬門檻其實指向同一根針：一次輸出會讓兩條同時 FAIL。
 * 這裡只用回合 id 描述，不把針的文字放進報告。
 */
function describeGateOverlap(fixtures) {
  const marker = fixtures.expectations.crossProject?.foreignMarker;
  if (typeof marker !== "string" || marker === "") {
    return { sameNeedle: false, turnIds: [], note: null };
  }
  const wanted = normalizeForMatch(marker);
  const turnIds = [];
  for (const [id, expectation] of Object.entries(fixtures.expectations.turns ?? {})) {
    const needles = Array.isArray(expectation?.mustNotInclude) ? expectation.mustNotInclude : [];
    if (needles.some((needle) => normalizeForMatch(needle) === wanted)) turnIds.push(id);
  }
  return {
    sameNeedle: turnIds.length > 0,
    turnIds,
    note:
      turnIds.length > 0
        ? `本次 fixture 的跨專案 marker 同時是 ${turnIds.join("、")} 的 mustNotInclude 針：` +
          "同一次輸出會同時讓 mustNotInclude 與跨專案洩漏 FAIL，去重後只算 1 個獨立事件。"
        : null,
  };
}

function summarizeUsage(runner) {
  const usages = runner.attempts.map((attempt) => attempt.usage).filter((usage) => usage !== null && usage !== undefined);
  if (usages.length === 0) {
    return {
      tokens: "N/A",
      cost: "N/A",
      note: "端點沒有回傳 usage（或呼叫全數失敗）；token 與成本不得臆測。",
    };
  }
  const total = usages.reduce((sum, usage) => sum + (usage.totalTokens ?? 0), 0);
  return { tokens: String(total), cost: "N/A", note: "只有 token 用量；未設定單價，成本不推估。" };
}

/**
 * 跑一個模型：自己的暫存資料目錄、自己的 server、自己的模型 runner。
 *
 * @returns {Promise<object>} 報告用的模型結果
 */
async function runOneModel({ model, config, fixtures, options, budget, sanitize }) {
  const startedAt = Date.now();
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mnemoshelf-matrix-"));
  const logDir = path.join(tempRoot, "logs");
  await fs.mkdir(logDir, { recursive: true });
  await fs.mkdir(path.join(tempRoot, "home"), { recursive: true });

  const runner = createMatrixRunner(model, { budget, connection: config.connection });
  const hosts = [];
  let child = null;
  let dataDir = null;
  const result = {
    id: model.id,
    label: model.label ?? model.id,
    transport: model.transport,
    digestModel: model.digestModel,
    timeoutMs: model.timeoutMs,
    paid: model.paid === true,
    status: "ERROR",
    reason: null,
    env: config.env,
    attempts: 0,
    errorCounts: {},
    usage: { tokens: "N/A", cost: "N/A", note: "尚未呼叫模型。" },
    signals: null,
    gates: [],
    turns: [],
    measurement: {
      parity: null,
      degradedSearches: null,
      vectorReadiness: "not-run",
      turns: 0,
    },
    durationMs: 0,
  };

  try {
    dataDir = makeDataDir();
    const port = await freePort();
    const token = randomToken();
    log(`[${model.id}] 啟動暫存 server（127.0.0.1:${port}）…`);
    const server = startServer({ dataDir, port, token, modelDir: options.modelDir, verbose: options.verbose });
    child = server.child;
    const baseUrl = await server.url;
    const client = makeClient(baseUrl, token);
    const health = await client.request("/health", { timeoutMs: 5000 });
    if (health.status !== 200 || health.body?.service !== "mnemoshelf") {
      throw new Error(describeHttpError("GET /health（服務身分比對）", health));
    }
    const readiness = await waitForReady(client, 180000);
    if (readiness.gate !== "passed") {
      throw new Error(
        `就緒閘門逾時（pending=${readiness.final?.pending} failed=${readiness.final?.failed} stale=${readiness.final?.stale}）；` +
          "拒絕在向量未就緒時下結論。",
      );
    }
    log(`[${model.id}] 就緒（等待 ${(readiness.waitedMs / 1000).toFixed(1)} 秒）`);
    try {
      await client.request("/memories/search", {
        method: "POST",
        timeoutMs: 15000,
        body: { query: "暖機查詢：確認向量查詢路徑可用", k: 1, minScore: 0.4, project: "alpha" },
      });
    } catch {
      // 暖機失敗不影響量測；真正的召回會自己回報。
    }

    const pipeline = await runDigestPipeline({
      client,
      baseUrl,
      token,
      tmpRoot: tempRoot,
      logDir,
      packageDir: PACKAGE_DIR,
      conversations: fixtures.conversations,
      expectations: fixtures.expectations,
      modelRunner: runner,
      onHost: (host) => hosts.push(host),
    });

    const metrics = aggregateMetrics(pipeline.turns, {
      digestTimeoutMs: PRODUCTION_DIGEST_TIMEOUT_MS,
      modelLatencies: pipeline.attemptLatencies ?? pipeline.modelLatencies,
      crossProjectLeaks: pipeline.crossProject.total,
    });
    const signals = computeSignals({
      rawTurns: pipeline.rawTurns,
      turns: pipeline.turns,
      metrics,
      attempts: runner.attempts,
      entry: model,
    });
    const measurement = {
      parity: pipeline.parity.ok,
      degradedSearches: pipeline.recallDegraded,
      vectorReadiness: pipeline.vectorReadiness.gate,
      turns: pipeline.turns.length,
    };
    const measurementOk =
      measurement.parity === true &&
      measurement.degradedSearches === 0 &&
      measurement.turns === fixtures.conversations.turns.length;

    result.attempts = runner.attempts.length;
    result.errorCounts = runner.errorCounts;
    result.usage = summarizeUsage(runner);
    result.signals = signals;
    result.gates = hardGates(signals);
    result.measurement = measurement;
    result.turns = pipeline.turns.map((turn) => ({
      id: turn.id,
      outcome: turn.outcome,
      skipReason: turn.skipReason,
      turnCardWritten: turn.turnCardWritten === true,
      atomicItemsWritten: turn.atomicItemsWritten,
      written: turn.written,
      mustIncludeMissing: turn.mustIncludeMissing,
      // 硬門檻命中只記「回合 id」與分類；不落 needle、模型輸出或對話文字。
      mustNotIncludeHits: turn.mustNotIncludeHits.length > 0 ? [turn.id] : [],
      crossProjectHits: turn.crossProjectHit === true ? [turn.id] : [],
      kindDetail: turn.kindDetail,
      recall: turn.recall,
      latencyMs: turn.latencyMs,
      parseError: turn.parseError,
    }));

    if (runner.budgetExceeded) {
      result.status = "ERROR";
      result.reason = `模型呼叫超過 --max-calls ${budget.limit}；已中止（嚴重：只有 ${runner.attempts.length} 次成功進入預算）`;
    } else if (!measurementOk) {
      result.status = "ERROR";
      result.reason = "測量有效性不足（卡片 parity／degraded／回合數不符），不採用這組數字";
    } else {
      result.status = "RANKED";
    }
  } catch (error) {
    result.status = "ERROR";
    result.reason = sanitize(`${error?.name ?? "Error"}：${error?.message ?? ""}`);
    result.attempts = runner.attempts.length;
    result.errorCounts = runner.errorCounts;
    result.usage = summarizeUsage(runner);
  } finally {
    result.durationMs = Date.now() - startedAt;
    for (const host of hosts) await host.close();
    if (child !== null) await stopServer(child);
    if (options.keep) {
      log(`[${model.id}] 已保留暫存目錄（--keep；路徑不列入報告）`);
    } else {
      if (dataDir !== null) rmSync(dataDir, { recursive: true, force: true });
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }
  return result;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const startedAt = Date.now();
  const generatedAt = new Date().toISOString();
  const sanitize = makeSanitizer({ home: os.homedir(), roots: [os.tmpdir()] });

  const fixturesAll = await loadFixtures(FIXTURE_DIR);
  const fixtures = sliceFixtures(fixturesAll, options.turns);
  const catalog = await loadMatrixCatalog(MODELS_FILE);
  const selected = selectMatrixModels(catalog, options.modelsSpec);

  if (fixtures.evaluatedTurns !== fixturesAll.turns) {
    // 篩選只影響這一輪；fixture 本身仍是完整的 30 回合。
    log(`[matrix] screening：前 ${fixtures.evaluatedTurns}/${fixturesAll.turns} 回合（完整比較請加 --turns all）`);
  }

  // 先做環境檢查（不發請求）——dry-run 也在這裡結束。
  const configs = new Map();
  for (const model of selected) configs.set(model.id, resolveModelConfig(model, { env: process.env, allowPaid: options.allowPaid }));

  if (options.dryRun) {
    console.log(`[matrix] fixture：${fixturesAll.version}（${fixtures.evaluatedTurns}/${fixturesAll.turns} 回合；模式 ${fixtures.mode}；指紋 ${fixturesAll.fingerprint}）`);
    let estimatedTotal = 0;
    for (const model of selected) {
      const config = configs.get(model.id);
      const estimated = config.ready ? estimateModelCalls(fixtures) : 0;
      estimatedTotal += estimated;
      const label = config.ready ? "READY" : "NOT RUN";
      console.log(
        `[matrix] ${model.id}（${model.transport}，timeout ${model.timeoutMs}ms）→ ${label}` +
          (config.ready ? `；預計模型呼叫 ${estimated} 次` : `；原因：${config.reasons.join("；")}`),
      );
    }
    console.log(`[matrix] 預計召回查詢：${countRecallQueries(fixtures.expectations)} 次（同時有 recallQuery＋recallMarker 的回合；只有 recallQuery 的回合不做搜尋）`);
    console.log(`[matrix] 合計模型呼叫 ${estimatedTotal} 次（--max-calls ${options.maxCalls}）`);
    console.log("[matrix] --dry-run：不發任何請求、不啟動 server、不寫報告。");
    if (estimatedTotal > options.maxCalls) {
      console.error(`[matrix] 預計呼叫 ${estimatedTotal} 次超過 --max-calls ${options.maxCalls}；中止。`);
      process.exitCode = 1;
    }
    return;
  }

  const budget = { limit: options.maxCalls, used: 0, exceeded: false };
  const probes = [];
  const results = [];
  let build = { rebuilt: false, reason: null, checked: false };
  let abortRemaining = null;

  // opencode transport 走唯讀探測（不呼叫模型），確認端點與認證。
  for (const model of selected.filter((candidate) => configs.get(candidate.id).ready)) {
    if (model.transport !== "opencode") continue;
    const config = configs.get(model.id);
    const probe = await probeOpenCodeEndpoint({
      url: config.connection.url,
      username: config.connection.username,
      password: config.connection.password,
    });
    probes.push({ modelId: model.id, ...probe });
    if (!probe.authOk || probe.endpointExists === false) {
      config.ready = false;
      config.reasons = [
        probe.authOk
          ? probe.endpointExists === false
            ? "OpenCode server 沒有 /api/experimental/generate（spike 失敗）"
            : "OpenCode server 的 OpenAPI 無法解析（spike 失敗）"
          : probe.reachable === false
            ? `OpenCode server 連不上（${probe.errorClass ?? "network"}）`
            : `OpenCode server 認證失敗（HTTP ${probe.status ?? "?"}）；請確認 ${model.passwordEnv} 是該 server 的 OPENCODE_SERVER_PASSWORD`,
      ];
      log(`[${model.id}] NOT RUN：${config.reasons[0]}`);
    }
  }

  // 預算前置檢查：在任何**模型**請求送出前就擋下（探測只是唯讀 GET）。
  const estimatedTotal = selected
    .filter((model) => configs.get(model.id).ready)
    .reduce((sum) => sum + estimateModelCalls(fixtures), 0);
  if (estimatedTotal > options.maxCalls) {
    console.error(
      `[matrix] 預計模型呼叫 ${estimatedTotal} 次超過 --max-calls ${options.maxCalls}；` +
        `請提高上限（會產生實際費用）或縮小 --turns。已中止，未送出任何模型請求。`,
    );
    process.exitCode = 1;
    return;
  }

  // 只有真的有人要跑時才建置與找 embedder（全 NOT RUN 時不做白工）。
  if (selected.some((model) => configs.get(model.id).ready)) {
    const outcome = await ensureBuild({ allowBuild: options.build });
    build = { ...outcome, checked: true };
    const modelDir = resolveModelDir();
    options.modelDir = modelDir.dir;
    log(`embedder 模型快取：${modelDir.label}`);
  }

  for (const model of selected) {
    const config = configs.get(model.id);
    if (abortRemaining !== null) {
      results.push({
        id: model.id,
        label: model.label ?? model.id,
        transport: model.transport,
        digestModel: model.digestModel,
        timeoutMs: model.timeoutMs,
        paid: model.paid === true,
        status: "NOT RUN",
        reason: abortRemaining,
        env: config.env,
        attempts: 0,
        errorCounts: {},
        usage: { tokens: "N/A", cost: "N/A", note: "未執行。" },
        signals: null,
        gates: [],
        turns: [],
        measurement: { parity: null, degradedSearches: null, vectorReadiness: "not-run", turns: 0 },
        durationMs: 0,
      });
      continue;
    }
    if (!config.ready) {
      results.push({
        id: model.id,
        label: model.label ?? model.id,
        transport: model.transport,
        digestModel: model.digestModel,
        timeoutMs: model.timeoutMs,
        paid: model.paid === true,
        status: "NOT RUN",
        reason: config.reasons.join("；"),
        env: config.env,
        attempts: 0,
        errorCounts: {},
        usage: { tokens: "N/A", cost: "N/A", note: "未執行。" },
        signals: null,
        gates: [],
        turns: [],
        measurement: { parity: null, degradedSearches: null, vectorReadiness: "not-run", turns: 0 },
        durationMs: 0,
      });
      continue;
    }

    log(`[${model.id}] 開始（${model.transport} → ${model.digestModel}）`);
    const result = await runOneModel({ model, config, fixtures, options, budget, sanitize });
    results.push(result);
    if (budget.exceeded) abortRemaining = `前一模型用盡 --max-calls ${budget.limit}；未執行`;
    if (result.status === "RANKED") {
      const passed = result.gates.filter((gate) => gate.ok).length;
      log(`[${model.id}] RANKED：硬門檻 ${passed}/${result.gates.length}`);
    } else {
      log(`[${model.id}] ${result.status}：${result.reason ?? ""}`);
    }
  }

  const ordered = rankResults(results);

  const report = {
    schemaVersion: 1,
    kind: "eval-digest-matrix",
    generatedAt,
    durationMs: Date.now() - startedAt,
    fixture: {
      version: fixturesAll.version,
      turns: fixturesAll.turns,
      evaluatedTurns: fixtures.evaluatedTurns,
      mode: fixtures.mode,
      fingerprint: fixturesAll.fingerprint,
    },
    options: {
      models: selected.map((model) => model.id),
      allowPaid: options.allowPaid,
      maxCalls: options.maxCalls,
      turns: options.turns,
    },
    budget: { limit: budget.limit, used: budget.used },
    build: { rebuilt: build.rebuilt, reason: build.reason, checked: build.checked },
    environment: { node: process.version, platform: process.platform },
    git: undefined,
    spike: { findings: SPIKE_FINDINGS, probes },
    discrimination: DISCRIMINATION,
    gateOverlap: describeGateOverlap(fixturesAll),
    models: ordered,
    privacy: {
      patterns: ["email", "sk- 開頭金鑰", "Authorization: Bearer <token>", "home-path", "windows-user-path"],
      reportContainsConversation: false,
      reportContainsCredentials: false,
    },
  };

  report.git = gitInfo(REPO_ROOT);
  const relative = (file) => path.relative(REPO_ROOT, file).split(path.sep).join("/");
  report.output = {
    json: relative(path.join(options.outDir, "matrix-report.json")),
    md: relative(path.join(options.outDir, "matrix-report.md")),
  };
  await writeReport(report, options.outDir);

  const exitOk = allHardPass(ordered);
  console.log("");
  log(`fixture：${report.fixture.version}（${report.fixture.evaluatedTurns}/${report.fixture.turns} 回合，${report.fixture.mode}）`);
  log(`報告：${report.output.json}、${report.output.md}`);
  log(`模型呼叫：${budget.used}/${budget.limit}`);
  for (const model of ordered) {
    if (model.status !== "RANKED") {
      log(`${model.status} ${model.label}：${model.reason ?? ""}`);
      continue;
    }
    const gates = model.gates.map((gate) => `${gate.ok ? "PASS" : "FAIL"} ${gate.id}`).join("、");
    log(`RANKED #${model.rank} ${model.label}：${gates}`);
  }
  if (ordered.some((model) => model.status === "RANKED")) {
    log(`排行：${ordered.filter((model) => model.status === "RANKED").map((model) => `${model.rank}. ${model.label}`).join("；")}`);
  }
  log(`退出碼 ${exitOk ? 0 : 1}${exitOk ? "" : "（有模型 NOT RUN／ERROR 或硬門檻 FAIL）"}`);
  process.exitCode = exitOk ? 0 : 1;
}

main().catch((error) => {
  console.error(`[matrix] 未預期錯誤：${error?.name ?? "Error"}：${error?.message ?? ""}`);
  if (error instanceof MatrixBudgetExceeded) console.error("[matrix] 呼叫數超過上限，已中止。");
  process.exitCode = 1;
});
