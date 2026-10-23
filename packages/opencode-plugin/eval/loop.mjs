#!/usr/bin/env node
/**
 * L2：對話迴圈 harness 的執行入口。
 *
 * 做什麼：
 * 1. 啟動**真的** mnemoshelf server（暫存資料目錄、隨機埠、隨機 token）與真 embedder。
 * 2. 用假宿主（假 OpenCode ctx）跑 alpha／beta／global chat 的完整 digest 回合，
 *    模型回應是 canned（不呼叫真模型、不需要 API key）。
 * 3. 跑召回注入與九條斷言的場景，輸出逐場景 pass/fail 的 JSON＋Markdown 報告。
 *
 * 用法：
 *   pnpm --filter @mnemoshelf/opencode-plugin eval:loop
 *   node eval/loop.mjs [--out DIR] [--fault other-location|model-missing] [--no-build] [--keep] [--verbose]
 *
 * `--fault` 是**負向對照**用的故障注入：讓所有一般實例的 `ctx.session.get` 回不同目錄，
 * 或讓 `ctx.model.list()` 不含 digestModel；受影響的場景應該轉紅（退出碼 1）。
 */
import { promises as fs, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ensureBuild,
  describeHttpError,
  freePort,
  log,
  makeClient,
  makeDataDir,
  modelCandidates,
  randomToken,
  REPO_ROOT,
  resolveModelDir,
  startServer,
  stopServer,
} from "./loop/server.mjs";
import { makeSanitizer, printCaseResult, resultsFingerprint, writeReport } from "./loop/report.mjs";
import { runScenarios, summarizeAssertions } from "./loop/scenarios.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = path.resolve(HERE, "..");

const FAULTS = new Set(["none", "other-location", "model-missing"]);

function parseArgs(argv) {
  const options = {
    outDir: path.join(REPO_ROOT, ".tmp", "eval-loop"),
    fault: "none",
    build: true,
    keep: false,
    verbose: false,
    readinessTimeoutMs: 180000,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    // pnpm 10 會把 `--` 原樣傳給 script（`eval:loop -- --fault …`）；它在任何位置都只是分隔符。
    if (arg === "--") continue;
    if (arg === "--out") {
      options.outDir = path.resolve(argv[++index]);
    } else if (arg.startsWith("--fault=")) {
      options.fault = arg.slice("--fault=".length);
    } else if (arg === "--fault") {
      options.fault = argv[++index];
    } else if (arg === "--no-build") {
      options.build = false;
    } else if (arg === "--keep") {
      options.keep = true;
    } else if (arg === "--verbose") {
      options.verbose = true;
    } else if (arg === "--readiness-timeout-min") {
      options.readinessTimeoutMs = Number(argv[++index]) * 60 * 1000;
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        "用法：node eval/loop.mjs [--out DIR] [--fault none|other-location|model-missing] [--no-build] [--keep] [--verbose]\n" +
          "pnpm：pnpm --filter @mnemoshelf/opencode-plugin eval:loop [-- --fault other-location]（`--` 可有可無）",
      );
      process.exit(0);
    } else {
      throw new Error(`未知參數：${arg}`);
    }
  }
  if (!FAULTS.has(options.fault)) throw new Error(`未知的 --fault 值：${options.fault}`);
  return options;
}

function describeModelSource(resolved) {
  const known = modelCandidates().find((candidate) => candidate.dir === resolved.dir);
  return known === undefined ? "外部模型目錄" : known.label;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const startedAt = Date.now();
  const generatedAt = new Date().toISOString();

  await fs.mkdir(options.outDir, { recursive: true });
  const logDir = path.join(options.outDir, "logs");
  await fs.rm(logDir, { recursive: true, force: true });
  await fs.mkdir(logDir, { recursive: true });

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mnemoshelf-loop-"));
  const sanitize = makeSanitizer({ home: os.homedir(), roots: [tempRoot] });

  let child = null;
  let dataDir = null;
  let hosts = [];
  let report;
  let exitCode = 1;
  let build = { rebuilt: false, reason: null };

  try {
    build = await ensureBuild({ allowBuild: options.build });
    const model = resolveModelDir();
    log(`embedder 模型快取：${describeModelSource(model)}`);
    log(`故障模式：${options.fault}`);

    dataDir = makeDataDir();
    const port = await freePort();
    const token = randomToken();
    log(`暫存資料目錄與真 server（127.0.0.1:${port}）…`);
    const server = startServer({ dataDir, port, token, modelDir: model.dir, verbose: options.verbose });
    child = server.child;
    const baseUrl = await server.url;
    const client = makeClient(baseUrl, token);

    const health = await client.request("/health", { timeoutMs: 5000 });
    if (health.status !== 200 || health.body?.service !== "mnemoshelf") {
      throw new Error(describeHttpError("GET /health（服務身分比對）", health));
    }
    log("server 就緒");

    let readiness;
    try {
      const outcome = await runScenarios({
        client,
        baseUrl,
        token,
        tmpRoot: tempRoot,
        logDir,
        fault: options.fault,
        sanitize,
        onHost: (host) => hosts.push(host),
      });
      readiness = outcome.readiness;
      log(
        `就緒閘門：${readiness.gate}（等待 ${(readiness.waitedMs / 1000).toFixed(1)} 秒、${readiness.polls} 次輪詢；` +
          `ready=${readiness.final?.ready} pending=${readiness.final?.pending} failed=${readiness.final?.failed}）`,
      );

      for (const entry of outcome.cases) printCaseResult(entry, sanitize);

      const diagnostics = await client.request("/diagnostics", { timeoutMs: 10000 });
      const embedder = diagnostics.body?.embedder ?? {};
      const fingerprint = resultsFingerprint(outcome.cases, options.fault);
      const assertionSummary = summarizeAssertions(outcome.cases);
      const failures = outcome.cases.filter((entry) => entry.gated !== false && entry.status !== "pass");
      // `info` 是「僅報告、不設門檻」的狀態，不算通過也不算未執行。
      const notRun = outcome.cases.filter((entry) => !["pass", "fail", "info"].includes(entry.status));

      report = {
        schemaVersion: 1,
        kind: "eval-loop",
        generatedAt,
        durationMs: Date.now() - startedAt,
        fault: options.fault,
        build: { rebuilt: build.rebuilt, reason: build.reason },
        environment: { node: process.version, platform: process.platform },
        git: undefined,
        embedder: { id: embedder.id ?? null, dimension: embedder.dim ?? null },
        readiness: {
          gate: readiness.gate,
          waitedMs: readiness.waitedMs,
          polls: readiness.polls,
          final: readiness.final,
        },
        modelValidation: outcome.modelValidation,
        assertions: assertionSummary,
        cases: outcome.cases,
        fingerprint,
        privacy: {
          reportContainsConversation: false,
          reportContainsSessionIds: false,
          digestLogScan: "只掃 digest.log 檔案，不掃 console log",
        },
      };
      exitCode = failures.length === 0 && notRun.length === 0 && outcome.cases.length > 0 ? 0 : 1;
    } catch (error) {
      // 世界建立失敗（模型沒就緒、server 掛掉…）：仍輸出報告，讓「未執行」看得見。
      report = {
        schemaVersion: 1,
        kind: "eval-loop",
        generatedAt,
        durationMs: Date.now() - startedAt,
        fault: options.fault,
        build: { rebuilt: build.rebuilt, reason: build.reason },
        environment: { node: process.version, platform: process.platform },
        embedder: { id: null, dimension: null },
        readiness: { gate: "not-run", waitedMs: 0, polls: 0, final: null },
        modelValidation: { digestModel: "canned/digest-model", instances: [] },
        assertions: summarizeAssertions([]),
        cases: [],
        setupError: sanitize(`${error?.name ?? "Error"}: ${error?.message ?? ""}`),
        fingerprint: resultsFingerprint([], options.fault),
        privacy: {
          reportContainsConversation: false,
          reportContainsSessionIds: false,
          digestLogScan: "只掃 digest.log 檔案，不掃 console log",
        },
      };
      exitCode = 1;
    }
  } catch (error) {
    // 環境層失敗（缺模型、server 起不來、建置失敗）：明確訊息＋非零退出。
    console.error(`[loop] 失敗：${sanitize(`${error?.name ?? "Error"}: ${error?.message ?? ""}`)}`);
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
    // git 狀態在最後才讀（跑完後仍可看出工作區是否 dirty）。
    const { gitInfo } = await import("./loop/report.mjs");
    report.git = gitInfo(REPO_ROOT);
    const paths = await writeReport(report, options.outDir);
    const relativeJson = path.relative(REPO_ROOT, paths.jsonPath).split(path.sep).join("/");
    const relativeMd = path.relative(REPO_ROOT, paths.mdPath).split(path.sep).join("/");
    console.log("");
    log(`故障模式：${report.fault}`);
    log(`結果指紋（含模式）：${report.fingerprint}`);
    log(`報告：${relativeJson}、${relativeMd}`);
    if (report.build?.rebuilt === true) log("本次有重建 dist（原 dist 過期）");
    const failed = report.cases.filter((entry) => entry.gated !== false && entry.status === "fail").length;
    const reported = report.cases.filter((entry) => entry.status === "info").length;
    log(
      failed === 0 && report.cases.length > 0
        ? `硬門檻全部通過（${report.cases.length - reported} 個場景；另有 ${reported} 個僅報告）`
        : `有失敗或未執行（失敗 ${failed}、場景 ${report.cases.length}）`,
    );
    if (report.setupError !== undefined) log(`setup error：${report.setupError}`);
  }

  log(`退出碼 ${exitCode}`);
  process.exitCode = exitCode;
}

main().catch((error) => {
  console.error(`[loop] 未預期錯誤：${error?.name ?? "Error"}: ${error?.message ?? ""}`);
  process.exitCode = 1;
});
