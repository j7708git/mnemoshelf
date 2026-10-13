// 路線 2（選做）：驗證 llama.cpp `llama-server` 能否用 mmproj 對**圖片**產生 embedding。
//
// 原則：
//   - 只操作自己起的實例（預設 port 18181），**絕不**碰既有的 127.0.0.1:8181 服務。
//   - 只下載需要的 GGUF（Q8_0 文字 + mmproj），不重新編譯 llama.cpp。
//   - 各種可能的請求格式逐一嘗試，把「HTTP 狀態 + 回應內容」原樣記錄，作為證據。
//
// 用法：node scripts/llama-mmproj.mjs [--port 18181] [--keep-server]
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ASSET_OUT_DIR, RESULTS_DIR, TMP_DIR, ensureDir, humanBytes, jsonWrite } from "../lib/paths.mjs";
import { IMAGES } from "../lib/corpus-images.mjs";
import { cosine, loadEmbedder, queryPrefix, runModel } from "../lib/embedder.mjs";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};
const PORT = Number(flag("port", "18181"));
const BASE_URL = `http://127.0.0.1:${PORT}`;
const KEEP_SERVER = args.includes("--keep-server");

const LLAMA_SERVER_BIN =
  process.env.LLAMA_SERVER_BIN ?? path.join(os.homedir(), "workspace", "llamacpp", "build", "bin", "llama-server");
const GGUF_REPO = "ggml-org/embeddinggemma-2-GGUF";
const MODEL_FILE = "embeddinggemma-2-Q8_0.gguf";
const MMPROJ_FILE = "mmproj-embeddinggemma-2-Q8_0.gguf";
const MODEL_DIR = path.join(TMP_DIR, "models");
const LOG_DIR = path.join(TMP_DIR, "logs");

async function downloadFile(repo, file, target) {
  if (fs.existsSync(target) && fs.statSync(target).size > 0) {
    return { file: target, bytes: fs.statSync(target).size, cached: true };
  }
  const url = `https://huggingface.co/${repo}/resolve/main/${file}`;
  const started = Date.now();
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) throw new Error(`下載 ${url} 失敗：HTTP ${response.status}`);
  const tmp = `${target}.part`;
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(tmp));
  fs.renameSync(tmp, target);
  return { file: target, bytes: fs.statSync(target).size, cached: false, ms: Date.now() - started, url };
}

async function waitForHealth(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE_URL}/health`);
      if (response.ok) return { ok: true, body: await response.json() };
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return { ok: false, error: String(lastError?.message ?? "timeout") };
}

async function postJson(pathname, body) {
  try {
    const response = await fetch(`${BASE_URL}${pathname}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* 非 JSON 就原樣保留 */
    }
    return { status: response.status, body: parsed ?? text.slice(0, 2000) };
  } catch (error) {
    return { status: null, error: String(error?.message ?? error) };
  }
}

async function getJson(pathname) {
  try {
    const response = await fetch(`${BASE_URL}${pathname}`);
    const text = await response.text();
    try {
      return { status: response.status, body: JSON.parse(text) };
    } catch {
      return { status: response.status, body: text.slice(0, 2000) };
    }
  } catch (error) {
    return { status: null, error: String(error?.message ?? error) };
  }
}

const dataUrl = (file) => `data:image/png;base64,${fs.readFileSync(file).toString("base64")}`;

/**
 * 把報告裡的本機絕對路徑換成 placeholder（log 與結果檔會進版控，不得含個人路徑）。
 * 例：<home>/workspace/agent/mnemoshelf/.tmp/models/x.gguf → <tmp>/models/x.gguf
 */
function sanitize(value) {
  const replacements = [
    [TMP_DIR, "<tmp>"],
    [os.homedir(), "<home>"],
  ];
  if (typeof value === "string") {
    let out = value;
    for (const [from, to] of replacements) out = out.split(from).join(to);
    return out;
  }
  if (Array.isArray(value)) return value.map((item) => sanitize(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitize(item)]));
  }
  return value;
}

async function main() {
  ensureDir(MODEL_DIR);
  ensureDir(LOG_DIR);
  const report = { startedAt: new Date().toISOString(), port: PORT, serverBin: "<home>/workspace/llamacpp/build/bin/llama-server", steps: [], errors: [] };

  const version = await new Promise((resolve) => {
    const child = spawn(LLAMA_SERVER_BIN, ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (out += chunk));
    child.on("close", (code) => resolve({ code, out: out.trim() }));
    child.on("error", (error) => resolve({ code: null, out: String(error.message) }));
  });
  report.serverVersion = version;
  console.log(`[llama] ${LLAMA_SERVER_BIN}\n${version.out}`);
  // 確認這個 build 的推論裝置（CPU-only build 不會有 CUDA 裝置，避免動到 GPU）
  report.devices = await new Promise((resolve) => {
    const child = spawn(LLAMA_SERVER_BIN, ["--list-devices"], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (out += chunk));
    child.on("close", () => resolve(out.trim()));
    child.on("error", (error) => resolve(String(error.message)));
  });
  console.log(`[llama] 可用裝置：${report.devices}`);

  const model = await downloadFile(GGUF_REPO, MODEL_FILE, path.join(MODEL_DIR, MODEL_FILE));
  console.log(`[llama] 已備妥 ${MODEL_FILE}（${humanBytes(model.bytes)}${model.cached ? "，快取" : `，下載 ${(model.ms / 1000).toFixed(1)}s`}）`);
  const mmproj = await downloadFile(GGUF_REPO, MMPROJ_FILE, path.join(MODEL_DIR, MMPROJ_FILE));
  console.log(`[llama] 已備妥 ${MMPROJ_FILE}（${humanBytes(mmproj.bytes)}${mmproj.cached ? "，快取" : `，下載 ${(mmproj.ms / 1000).toFixed(1)}s`}）`);
  report.downloads = {
    model: { ...model, file: path.relative(TMP_DIR, model.file) },
    mmproj: { ...mmproj, file: path.relative(TMP_DIR, mmproj.file) },
  };

  const serverArgs = [
    "-m", path.join(MODEL_DIR, MODEL_FILE),
    "--mmproj", path.join(MODEL_DIR, MMPROJ_FILE),
    "--embeddings", "--pooling", "mean",
    "-c", "2048",
    "--host", "127.0.0.1", "--port", String(PORT),
    "--no-webui",
  ];
  report.serverArgs = serverArgs.map((value) => (value.startsWith("/") ? path.relative(TMP_DIR, value) : value));
  const logFile = path.join(LOG_DIR, `llama-mmproj-${PORT}.log`);
  const logStream = fs.createWriteStream(logFile);
  const server = spawn(LLAMA_SERVER_BIN, serverArgs, { stdio: ["ignore", "pipe", "pipe"] });
  server.stdout.pipe(logStream);
  server.stderr.pipe(logStream);
  report.logFile = path.relative(TMP_DIR, logFile);

  let exitInfo = null;
  server.on("exit", (code, signal) => {
    exitInfo = { code, signal };
  });

  try {
    const health = await waitForHealth(180000);
    report.health = health;
    console.log(`[llama] health: ${JSON.stringify(health)}`);
    if (!health.ok) {
      report.errors.push(`health 失敗：${JSON.stringify(health)}`);
      throw new Error(`llama-server 未就緒：${JSON.stringify(health)}`);
    }
    report.props = await getJson("/props");
    report.models = await getJson("/v1/models");
    console.log(`[llama] /props: status ${report.props.status}；/v1/models: ${JSON.stringify(report.models.body?.data?.[0]?.capabilities ?? report.models.body?.data?.[0] ?? {})}`);

    // 1) 純文字 embedding（基準）：OAI 與非 OAI 兩種端點都測
    const textProbe = await postJson("/v1/embeddings", { input: queryPrefix("兩隻貓一起在沙發上睡覺"), model: "local" });
    const textVector = Array.isArray(textProbe.body?.data?.[0]?.embedding) ? textProbe.body.data[0].embedding : null;
    const nativeTextProbe = await postJson("/embeddings", { content: [{ prompt_string: queryPrefix("兩隻貓一起在沙發上睡覺") }] });
    const nativeTextVector = nativeTextProbe.body?.[0]?.embedding ?? null;
    report.textProbe = {
      status: textProbe.status,
      dims: textVector?.length ?? null,
      error: textProbe.body?.error ?? textProbe.error ?? null,
      nativeStatus: nativeTextProbe.status,
      nativeDims: nativeTextVector?.length ?? null,
      nativeError: nativeTextProbe.body?.error ?? nativeTextProbe.error ?? null,
      cosineOaiVsNative: textVector && nativeTextVector ? cosine(textVector, nativeTextVector) : null,
    };
    console.log(`[llama] 純文字：/v1/embeddings ${textProbe.status} dims=${report.textProbe.dims}；/embeddings ${nativeTextProbe.status} dims=${report.textProbe.nativeDims}；兩者餘弦 ${report.textProbe.cosineOaiVsNative}`);
    const textVectorForCrossCheck = textVector ?? nativeTextVector;

    // 2) 圖片輸入：依 llama.cpp 官方文件與本機原始碼（tools/server/README.md、
    //    tests/unit/test_vision_api.py）支援兩種形狀：
    //      a. 非 OAI 的 /embeddings：content: [{ prompt_string, multimodal_data: ["<base64>"] }]
    //         （base64 不含 data: 前綴；prompt_string 內要用 MTMD marker `<__media__>` 佔位）
    //      b. OAI 的 /v1/embeddings：input: [{ content: [{ type:"text" }, { type:"image_url", image_url:{ url: "data:..." } }] }]
    const png = path.join(ASSET_OUT_DIR, "red_circle.png");
    const rawBase64 = fs.readFileSync(png).toString("base64");
    const imageUrl = dataUrl(png);
    const marker = "<__media__>";
    const candidates = [
      {
        path: "/embeddings",
        name: "native-embeddings-prompt_string-multimodal_data",
        body: { content: [{ prompt_string: `${marker}\n`, multimodal_data: [rawBase64] }] },
      },
      {
        path: "/embeddings",
        name: "native-embeddings-with-data-uri-prefix",
        body: { content: [{ prompt_string: `${marker}\n`, multimodal_data: [imageUrl] }] },
      },
      {
        path: "/v1/embeddings",
        name: "oai-input-content-image_url",
        body: { input: [{ content: [{ type: "text", text: "" }, { type: "image_url", image_url: { url: imageUrl } }] }], model: "local" },
      },
      {
        path: "/v1/embeddings",
        name: "oai-input-prompt_string-multimodal_data",
        body: { input: [{ prompt_string: `${marker}\n`, multimodal_data: [rawBase64] }], model: "local" },
      },
      { path: "/v1/embeddings", name: "oai-input-image_url-object", body: { input: [{ type: "image_url", image_url: { url: imageUrl } }], model: "local" } },
    ];
    report.imageProbes = [];
    for (const candidate of candidates) {
      const result = await postJson(candidate.path, candidate.body);
      const dims = Array.isArray(result.body?.data?.[0]?.embedding)
        ? result.body.data[0].embedding.length
        : Array.isArray(result.body?.[0]?.embedding)
          ? result.body[0].embedding.length
          : null;
      report.imageProbes.push({
        name: candidate.name,
        path: candidate.path,
        status: result.status,
        dims,
        error: result.body?.error ?? result.error ?? null,
        bodyPreview: dims === null ? JSON.stringify(result.body).slice(0, 400) : null,
      });
      console.log(`[llama] 圖片格式 ${candidate.name}: status=${result.status} dims=${dims} ${dims === null ? `err=${JSON.stringify(result.body?.error ?? result.error ?? result.body).slice(0, 200)}` : ""}`);
      if (dims !== null) {
        // 若成功，與路線 1 的向量比較
        const vector = result.body?.data?.[0]?.embedding ?? result.body[0].embedding;
        report.llamaImageVector = vector;
        report.llamaTextVector = textVectorForCrossCheck;
        const route1 = JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, "bench-q8.json"), "utf8"));
        const route1Image = route1.images.budgets.budget280.rows.find((row) => row.id === "red_circle");
        // 文字端：用路線 1 的模型嵌入**完全相同**的字串再比（同 runtime 才能算餘弦）
        const { processor: p1, model: m1 } = await loadEmbedder({ dtype: "q8", modalities: "text+image" });
        const route1TextVector = (await runModel(m1, await p1([queryPrefix("兩隻貓一起在沙發上睡覺")]))).data[0];
        report.crossCheck = {
          route1Dims: route1Image.embedding.length,
          llamaDims: vector.length,
          cosineImageLlamaVsRoute1: cosine(vector, route1Image.embedding),
          cosineTextLlamaVsRoute1: textVectorForCrossCheck
            ? cosine(textVectorForCrossCheck, route1TextVector)
            : null,
        };
        console.log(`[llama] 跨路線餘弦：${JSON.stringify(report.crossCheck)}`);
        break;
      }
    }
    // 記錄 llama.cpp 自己的說明（若 /props 有 n_embd 等資訊）
    report.serverLogTail = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").split("\n").slice(-25).join("\n") : null;
  } catch (error) {
    report.errors.push(String(error?.message ?? error));
    report.serverLogTail = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").split("\n").slice(-40).join("\n") : null;
    console.error(`[llama] 失敗：${error?.message ?? error}`);
  } finally {
    if (!KEEP_SERVER) {
      server.kill("SIGTERM");
      await new Promise((resolve) => setTimeout(resolve, 3000));
      if (exitInfo === null) server.kill("SIGKILL");
      report.serverExit = exitInfo ?? { code: null, signal: "SIGKILL" };
      console.log(`[llama] 已關閉自己起的實例：${JSON.stringify(report.serverExit)}`);
    }
    jsonWrite(path.join(RESULTS_DIR, "llama-mmproj.json"), sanitize(report));
    console.log(`[llama] 結果寫入 results/llama-mmproj.json`);
  }
}

await main();
