#!/usr/bin/env node
/**
 * L3：單模型摘要品質量測的執行入口。
 *
 * 預設完全離線、零成本：canned 抽取式基線＋真 server／真 embedder＋假宿主。
 * 真模型是選項，不是跑得完的必要條件。
 *
 * 用法：
 *   pnpm --filter @mnemoshelf/opencode-plugin eval:digest
 *   pnpm --filter @mnemoshelf/opencode-plugin eval:digest -- --dry-run
 *   node eval/digest/run.mjs [--out DIR] [--dry-run] [--max-calls N] [--model ID]
 *                            [--allow-paid] [--no-build] [--keep] [--verbose]
 *
 * pnpm 10 會把 `--` 原樣傳給 script：parseArgs 會忽略它，並支援 `--flag value` 與 `--flag=value`。
 */
import { createHash } from "node:crypto";
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
import { aggregateMetrics, hardConditions, softThresholds } from "./lib/metrics.mjs";
import { createModelRunner, loadModelCatalog, ModelSelectionError, selectModel } from "./lib/models.mjs";
import { runDigestPipeline } from "./lib/pipeline.mjs";
import { gitInfo, makeSanitizer, writeReport } from "./lib/report.mjs";
import { estimateModelCalls, loadFixtures } from "./lib/fixtures.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = path.resolve(HERE, "..", "..");
const FIXTURE_DIR = path.join(HERE, "fixtures");
const MODELS_FILE = path.join(HERE, "models.json");

function parseArgs(argv) {
  const options = {
    outDir: path.join(REPO_ROOT, ".tmp", "eval-digest"),
    dryRun: false,
    maxCalls: 100,
    modelId: null,
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
    } else if (arg === "--out") {
      options.outDir = path.resolve(argv[++index]);
    } else if (arg.startsWith("--out=")) {
      options.outDir = path.resolve(arg.slice("--out=".length));
    } else if (arg === "--max-calls") {
      options.maxCalls = Number(argv[++index]);
    } else if (arg.startsWith("--max-calls=")) {
      options.maxCalls = Number(arg.slice("--max-calls=".length));
    } else if (arg === "--model") {
      options.modelId = argv[++index];
    } else if (arg.startsWith("--model=")) {
      options.modelId = arg.slice("--model=".length);
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
        "用法：node eval/digest/run.mjs [--out DIR] [--dry-run] [--max-calls N] [--model ID]\n" +
          "                              [--allow-paid] [--no-build] [--keep] [--verbose]\n" +
          "pnpm：pnpm --filter @mnemoshelf/opencode-plugin eval:digest [-- --dry-run]（`--` 可有可無）",
      );
      process.exit(0);
    } else {
      throw new Error(`未知參數：${arg}`);
    }
  }
  if (!Number.isFinite(options.maxCalls) || options.maxCalls <= 0) {
    throw new Error(`--max-calls 必須是正整數（收到 ${options.maxCalls}）`);
  }
  return options;
}

function summarizeUsage(modelRunner) {
  const usages = modelRunner.calls.map((call) => call.usage).filter((usage) => usage !== null);
  if (usages.length === 0) {
    return {
      tokens: "N/A",
      cost: "N/A",
      note:
        modelRunner.info.kind === "canned"
          ? "canned 模型沒有 usage 欄位；token 與成本不得臆測。"
          : "模型端點沒有回傳 usage；token 與成本不得臆測。",
    };
  }
  const total = usages.reduce((sum, usage) => sum + (usage.totalTokens ?? 0), 0);
  return {
    tokens: String(total),
    cost: "N/A",
    note: "只有 token 用量；models.json 沒有單價，成本不推估。",
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const fixtures = await loadFixtures(FIXTURE_DIR);
  const estimatedCalls = estimateModelCalls(fixtures);
  const catalog = await loadModelCatalog(MODELS_FILE);
  const entry = selectModel(catalog, options.modelId);

  if (options.dryRun) {
    console.log(`[digest] fixture：${fixtures.version}（${fixtures.turns} 回合；指紋 ${fixtures.fingerprint}）`);
    console.log(`[digest] 模型：${entry.id}（${entry.kind ?? "canned"}）`);
    console.log(`[digest] 預計模型呼叫：${estimatedCalls} 次（--max-calls ${options.maxCalls}）`);
    console.log(`[digest] 預計召回查詢：${Object.values(fixtures.expectations.turns).filter((turn) => typeof turn.recallQuery === "string" && typeof turn.recallMarker === "string").length} 次（同時有 recallQuery＋recallMarker 的回合；只有 recallQuery 的回合不做搜尋）`);
    console.log("[digest] --dry-run：不呼叫模型、不啟動 server、不寫報告。");
    if (estimatedCalls > options.maxCalls) {
      console.error(`[digest] 預計呼叫 ${estimatedCalls} 次超過 --max-calls ${options.maxCalls}；中止。`);
      process.exitCode = 1;
    }
    return;
  }

  const startedAt = Date.now();
  const generatedAt = new Date().toISOString();

  let child = null;
  let dataDir = null;
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mnemoshelf-digest-eval-"));
  const sanitize = makeSanitizer({ home: os.homedir(), roots: [tempRoot] });
  const logDir = path.join(tempRoot, "logs");
  await fs.mkdir(logDir, { recursive: true });
  await fs.mkdir(path.join(tempRoot, "home"), { recursive: true });
  const hosts = [];
  let report;
  let exitCode = 1;
  let build = { rebuilt: false, reason: null };

  try {
    let modelRunner;
    try {
      modelRunner = createModelRunner(entry, {
        maxCalls: options.maxCalls,
        allowPaid: options.allowPaid,
        env: process.env,
      });
    } catch (error) {
      if (error instanceof ModelSelectionError) {
        console.error(`[digest] NOT RUN：${error.message}`);
        process.exitCode = 1;
        return;
      }
      throw error;
    }

    if (estimatedCalls > options.maxCalls) {
      throw new Error(`預計模型呼叫 ${estimatedCalls} 次超過 --max-calls ${options.maxCalls}；中止。`);
    }

    build = await ensureBuild({ allowBuild: options.build });
    const modelDir = resolveModelDir();
    log(`embedder 模型快取：${modelDir.label}`);

    dataDir = makeDataDir();
    const port = await freePort();
    const token = randomToken();
    log(`暫存資料目錄與真 server（127.0.0.1:${port}）…`);
    const server = startServer({ dataDir, port, token, modelDir: modelDir.dir, verbose: options.verbose });
    child = server.child;
    const baseUrl = await server.url;
    const client = makeClient(baseUrl, token);
    const health = await client.request("/health", { timeoutMs: 5000 });
    if (health.status !== 200 || health.body?.service !== "mnemoshelf") {
      throw new Error(describeHttpError("GET /health（服務身分比對）", health));
    }
    log("server 就緒");

    const readiness = await waitForReady(client, 180000);
    if (readiness.gate !== "passed") {
      throw new Error(
        `就緒閘門逾時（pending=${readiness.final?.pending} failed=${readiness.final?.failed} stale=${readiness.final?.stale}）；` +
          "拒絕在向量未就緒時下結論。",
      );
    }
    log(`就緒閘門：passed（等待 ${(readiness.waitedMs / 1000).toFixed(1)} 秒）`);

    // 暖機查詢路徑，避免第一次 embedding 載入造成召回數字抖動。
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
      modelRunner,
      onHost: (host) => hosts.push(host),
    });

    const metrics = aggregateMetrics(pipeline.turns, {
      digestTimeoutMs: 45000,
      modelLatencies: pipeline.modelLatencies,
      crossProjectLeaks: pipeline.crossProject.total,
    });
    const hard = hardConditions(metrics);
    const soft = softThresholds(metrics);
    const usage = summarizeUsage(modelRunner);

    report = {
      schemaVersion: 1,
      kind: "eval-digest",
      generatedAt,
      durationMs: Date.now() - startedAt,
      fixture: {
        version: fixtures.version,
        turns: fixtures.turns,
        fingerprint: fixtures.fingerprint,
      },
      model: {
        ...modelRunner.info,
        hasUsage: modelRunner.calls.some((call) => call.usage !== null),
        calls: modelRunner.callCount,
      },
      settings: {
        digestTimeoutMs: 45000,
        recentTurns: 3,
        minScore: 0.4,
        recallTimeoutMs: 1000,
      },
      build: { rebuilt: build.rebuilt, reason: build.reason },
      environment: { node: process.version, platform: process.platform },
      git: undefined,
      hardConditions: hard,
      softThresholds: soft,
      metrics,
      crossProject: pipeline.crossProject,
      parity: pipeline.parity,
      recallHealth: {
        degradedSearches: pipeline.recallDegraded,
        vectorReadiness: pipeline.vectorReadiness,
      },
      usage,
      turns: pipeline.turns.map((turn) => ({
        id: turn.id,
        outcome: turn.outcome,
        skipReason: turn.skipReason,
        expectSkip: turn.expectSkip,
        expectEmpty: turn.expectEmpty,
        written: turn.written,
        mustInclude: turn.mustInclude,
        mustIncludeMissing: turn.mustIncludeMissing,
        mustNotIncludeHits: turn.mustNotIncludeHits,
        kindDetail: turn.kindDetail,
        rawItemCount: turn.rawItemCount,
        keptItemCount: turn.keptItemCount,
        writtenItemCount: turn.writtenItemCount,
        rejected: turn.rejected,
        parseError: turn.parseError,
        recall: turn.recall,
        latencyMs: turn.latencyMs,
        parity: turn.parity,
      })),
      readiness: { gate: readiness.gate, waitedMs: readiness.waitedMs },
      privacy: {
        reportContainsConversation: false,
        reportContainsSessionIds: false,
        forbiddenPatternsScanned: ["email", "api-key", "home-path", "windows-user-path"],
      },
    };

    const hardOk = hard.every((condition) => condition.ok);
    const measurementOk = pipeline.parity.ok && pipeline.recallDegraded === 0;
    exitCode = hardOk && measurementOk && pipeline.turns.length === fixtures.turns ? 0 : 1;
  } catch (error) {
    console.error(`[digest] 失敗：${sanitize(`${error?.name ?? "Error"}: ${error?.message ?? ""}`)}`);
    exitCode = 1;
  } finally {
    for (const host of hosts) await host.close();
    if (child !== null) await stopServer(child);
    if (options.keep) {
      log("已保留暫存目錄（--keep；路徑不列入報告）");
    } else {
      if (dataDir !== null) rmSync(dataDir, { recursive: true, force: true });
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }

  if (report !== undefined) {
    report.git = gitInfo(REPO_ROOT);
    const outJson = path.join(options.outDir, "digest-report.json");
    const outMd = path.join(options.outDir, "digest-report.md");
    const relative = (file) => path.relative(REPO_ROOT, file).split(path.sep).join("/");
    report.output = { json: relative(outJson), md: relative(outMd) };
    await writeReport(report, options.outDir);
    const relativeJson = report.output.json;
    const relativeMd = report.output.md;
    console.log("");
    log(`模型：${report.model.id}`);
    log(`報告：${relativeJson}、${relativeMd}`);
    for (const condition of report.hardConditions) {
      log(`${condition.ok ? "PASS" : "FAIL"} ${condition.label}（實際 ${condition.actual}）`);
    }
    for (const threshold of report.softThresholds) {
      log(
        `INFO ${threshold.label}（實際 ${threshold.actual === null ? "N/A" : (threshold.actual * 100).toFixed(1) + "%"}${threshold.met === false ? "；未達標，待校準" : ""}）`,
      );
    }
    log(`卡片 parity：${report.parity.ok ? "一致" : "不一致"}`);
    log(`召回前向量就緒：${report.recallHealth.vectorReadiness.gate}；degraded 查詢 ${report.recallHealth.degradedSearches} 次`);
    log(`token／成本：${report.usage.tokens}／${report.usage.cost}`);
    log(`退出碼 ${exitCode}`);
  }
  process.exitCode = exitCode;
}

main().catch((error) => {
  console.error(`[digest] 未預期錯誤：${error?.name ?? "Error"}: ${error?.message ?? ""}`);
  process.exitCode = 1;
});
