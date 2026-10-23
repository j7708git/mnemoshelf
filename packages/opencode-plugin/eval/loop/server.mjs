/**
 * 真 server ＋ 真 embedder 的啟動、就緒閘門與 HTTP client。
 *
 * 這份是 `eval/run.mjs` 的**副本**（依任務卡要求不 import、不改既有 `eval/lib/**`），
 * 只保留本 harness 需要的部分：建置檢查、模型快取尋找、隨機埠、暫存資料目錄、
 * 啟動／停止 server、`GET /diagnostics` 就緒輪詢。
 *
 * 隱私邊界：一律使用暫存 `MNEMOSHELF_DATA_DIR` 與隨機 token；不寫使用者預設資料目錄。
 */
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, promises as fs } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = path.resolve(HERE, "..", "..");
export const REPO_ROOT = path.resolve(PACKAGE_DIR, "..", "..");

export const SERVE_SCRIPT = path.join(REPO_ROOT, "packages", "server", "dist", "scripts", "serve.js");
const EMBEDDER_MARKER = path.join("onnx-community", "embeddinggemma-2-ONNX", "onnx", "model_q4.onnx");

export function log(message) {
  console.log(`[loop] ${message}`);
}

/** 建置產物不存在時，先建置（可用 `--no-build` 禁止）。 */
/** 遞迴列出目錄下的檔案（讀不到就回空陣列，交給後續的「缺少」判斷）。 */
async function listFiles(directory) {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(full)));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

/**
 * 比對 `src` 下的 TypeScript 原始檔與對應的 `dist` JavaScript 產物新鮮度。
 *
 * 只用 mtime 比對每個原始檔與它自己的產物：不依賴整個 dist 目錄的最舊檔案
 * （避免舊版殘留檔讓檢查永遠判定過期），也不假設分隔符。
 */
export async function checkDistFreshness() {
  const srcDir = path.join(PACKAGE_DIR, "src");
  const distDir = path.join(PACKAGE_DIR, "dist");
  const sources = (await listFiles(srcDir)).filter((file) => file.endsWith(".ts"));
  const problems = [];
  for (const source of sources) {
    const relativeSource = path.relative(srcDir, source);
    const relativeArtifact = relativeSource.replace(/\.ts$/, ".js");
    const artifact = path.join(distDir, relativeArtifact);
    let sourceStat;
    try {
      sourceStat = await fs.stat(source);
    } catch {
      continue;
    }
    try {
      const artifactStat = await fs.stat(artifact);
      if (artifactStat.mtimeMs < sourceStat.mtimeMs) problems.push(`${relativeArtifact} 比 src 舊`);
    } catch {
      problems.push(`${relativeArtifact} 缺少`);
    }
  }
  return { stale: problems.length > 0, problems, sourceCount: sources.length };
}

/**
 * 確保建置產物存在且**比 src 新**。
 *
 * 過期時只重建 `@mnemoshelf/opencode-plugin`（不跑 `pnpm -r build`，避免動到其他在途工作）；
 * 重建失敗就明確失敗，不繼續測舊碼。
 *
 * @returns {Promise<{ rebuilt: boolean, reason: string|null }>}
 */
export async function ensureBuild({ allowBuild = true } = {}) {
  if (!existsSync(SERVE_SCRIPT)) {
    throw new Error(
      `找不到 server 建置產物（${path.relative(REPO_ROOT, SERVE_SCRIPT)}）；請先建置 packages/server。`,
    );
  }
  const freshness = await checkDistFreshness();
  if (freshness.sourceCount === 0) {
    throw new Error(
      `找不到 ${path.relative(REPO_ROOT, path.join(PACKAGE_DIR, "src"))} 下的 TypeScript 原始檔；` +
        "無法比對 dist 新鮮度，拒絕執行。",
    );
  }
  if (!freshness.stale) return { rebuilt: false, reason: null };

  const reason = freshness.problems.slice(0, 6).join("、");
  if (!allowBuild) {
    throw new Error(
      `偵測到 dist 過期（${reason}）；已指定 --no-build，請先跑 ` +
        "`pnpm --filter @mnemoshelf/opencode-plugin build`。",
    );
  }
  log(`偵測到 dist 過期，已重建 @mnemoshelf/opencode-plugin（${reason}）`);
  const result = spawnSync("pnpm", ["--filter", "@mnemoshelf/opencode-plugin", "build"], {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(`重建 @mnemoshelf/opencode-plugin 失敗（exit ${result.status}）；不繼續跑，避免測到舊碼。`);
  }
  const after = await checkDistFreshness();
  if (after.stale) {
    throw new Error(`重建後 dist 仍過期（${after.problems.slice(0, 6).join("、")}）；請檢查建置設定。`);
  }
  return { rebuilt: true, reason };
}

/** 候選 embedder 模型目錄（標籤只用於輸出，不印絕對路徑）。 */
export function modelCandidates() {
  const fromEnv = process.env.MNEMOSHELF_MODEL_DIR;
  return [
    ...(typeof fromEnv === "string" && fromEnv.trim() !== ""
      ? [{ label: "$MNEMOSHELF_MODEL_DIR", dir: path.resolve(fromEnv) }]
      : []),
    { label: "~/.config/Mnemoshelf/models", dir: path.join(os.homedir(), ".config", "Mnemoshelf", "models") },
    { label: "~/.local/share/mnemoshelf/models", dir: path.join(os.homedir(), ".local", "share", "mnemoshelf", "models") },
    {
      label: "~/Library/Application Support/Mnemoshelf/models",
      dir: path.join(os.homedir(), "Library", "Application Support", "Mnemoshelf", "models"),
    },
    { label: "<repo>/.tmp/speed-diagnosis/models", dir: path.join(REPO_ROOT, ".tmp", "speed-diagnosis", "models") },
  ];
}

/** 找現成的 embedder 模型快取；找不到就明確失敗（**絕不下載**）。 */
export function resolveModelDir() {
  for (const candidate of modelCandidates()) {
    if (existsSync(path.join(candidate.dir, EMBEDDER_MARKER))) return candidate;
  }
  throw new Error(
    "找不到 embedder 模型快取（需要 `onnx-community/embeddinggemma-2-ONNX/onnx/model_q4.onnx`）。\n" +
      "候選目錄：MNEMOSHELF_MODEL_DIR、~/.config/Mnemoshelf/models、~/.local/share/mnemoshelf/models、" +
      "~/Library/Application Support/Mnemoshelf/models、<repo>/.tmp/speed-diagnosis/models。\n" +
      "本 harness 不會下載模型；請先開一次 Mnemoshelf 桌面版或設定 MNEMOSHELF_MODEL_DIR。",
  );
}

export function freePort() {
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

/** 建立暫存資料目錄（呼叫端負責刪除）。 */
export function makeDataDir() {
  return mkdtempSync(path.join(os.tmpdir(), "mnemoshelf-loop-data-"));
}

function serverEnv({ dataDir, port, token, modelDir }) {
  return {
    ...process.env,
    MNEMOSHELF_DATA_DIR: dataDir,
    MNEMOSHELF_TOKEN: token,
    MNEMOSHELF_PORT: String(port),
    MNEMOSHELF_AGENT_DISCOVERY: "off",
    MNEMOSHELF_EMBED_DEVICE: "cpu",
    MNEMOSHELF_MODEL_DIR: modelDir,
    // 避免父行程的設定影響這場評估。
    MNEMOSHELF_URL: "",
    MNEMOSHELF_PROJECT: "",
    MNEMOSHELF_INDEX_RATE: "off",
  };
}

/**
 * 啟動真 server 並等它印出 URL。
 *
 * @returns {{ child: import("node:child_process").ChildProcess, url: Promise<string>, tail: string[] }}
 */
export function startServer({ dataDir, port, token, modelDir, verbose = false }) {
  const child = spawn(process.execPath, [SERVE_SCRIPT], {
    cwd: REPO_ROOT,
    env: serverEnv({ dataDir, port, token, modelDir }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const tail = [];
  const push = (chunk) => {
    const text = chunk.toString();
    for (const line of text.split(/\r?\n/)) {
      if (line === "") continue;
      tail.push(line);
      if (tail.length > 80) tail.shift();
      if (verbose) console.error(`[server] ${line}`);
    }
  };
  child.stderr.on("data", push);
  child.stdout.on("data", push);

  const url = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("server 啟動逾時（60 秒內沒有印出網址）")), 60000);
    const scan = () => {
      const match = tail.join("\n").match(/服務已啟動：(http:\/\/127\.0\.0\.1:\d+)/);
      if (match === null) return;
      clearTimeout(timer);
      resolve(match[1]);
    };
    child.stderr.on("data", scan);
    child.stdout.on("data", scan);
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`server 提前結束（exit ${code}）：\n${tail.slice(-20).join("\n")}`));
    });
  });

  return { child, url, tail };
}

export async function stopServer(child) {
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

/** 極簡 HTTP client（只連 127.0.0.1，帶 token）。 */
export function makeClient(baseUrl, token) {
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

export function describeHttpError(action, response) {
  const message = response?.body?.error?.message ?? response?.text?.slice(0, 200) ?? "";
  return `${action} 失敗：HTTP ${response?.status ?? "?"}${message === "" ? "" : `（${message}）`}`;
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
  };
}

/** 輪詢 `GET /diagnostics` 直到所有記憶向量就緒。 */
export async function waitForReady(client, timeoutMs) {
  const started = Date.now();
  let polls = 0;
  let last = null;
  while (Date.now() - started < timeoutMs) {
    const response = await client.request("/diagnostics", { timeoutMs: 10000 });
    polls += 1;
    if (response.status !== 200) throw new Error(describeHttpError("GET /diagnostics", response));
    last = memoryStats(response.body);
    if (last.pending === 0 && last.failed === 0 && last.stale === 0) {
      return { gate: "passed", waitedMs: Date.now() - started, polls, final: last };
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return { gate: "timeout", waitedMs: Date.now() - started, polls, final: last };
}

/** 灌一張記憶；測試用的合成資料。 */
export async function seedMemory(client, body, label = "seed") {
  const response = await client.request("/memories", { method: "POST", body });
  if (response.status !== 201) throw new Error(describeHttpError(`灌入記憶 ${label}`, response));
  return response.body;
}

/** 列出記憶（依過濾條件）；不做遮罩以外的加工。 */
export async function listMemories(client, { scope, project, agent, kind, limit = 500 } = {}) {
  const params = new URLSearchParams();
  if (scope !== undefined) params.set("scope", scope);
  if (project !== undefined) params.set("project", project);
  if (agent !== undefined) params.set("agent", agent);
  if (kind !== undefined) params.set("kind", kind);
  params.set("limit", String(limit));
  const response = await client.request(`/memories?${params.toString()}`);
  if (response.status !== 200) throw new Error(describeHttpError("GET /memories", response));
  return Array.isArray(response.body?.memories) ? response.body.memories : [];
}

/** 直接打語意搜尋（報告與 scope 檢查用）。 */
export async function searchMemories(client, body) {
  const response = await client.request("/memories/search", {
    method: "POST",
    timeoutMs: 15000,
    body: { k: 8, minScore: 0.4, ...body },
  });
  return {
    status: response.status,
    hits: Array.isArray(response.body?.hits) ? response.body.hits : [],
    degraded: response.body?.degraded === true,
    degradedReason: response.body?.degradedReason ?? null,
  };
}

export function randomToken() {
  return randomBytes(24).toString("hex");
}
