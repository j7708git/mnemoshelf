/** 真實 worker／模型排程驗收；只使用合成資料，結果與入口放 .tmp。 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { spawn } from "node:child_process";
import { deflateSync } from "node:zlib";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
function option(name) {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error("驗收參數缺少值");
  return value;
}
const output = path.join(root, ".tmp", "indexing-scheduler-smoke");

async function runSmoke(electronApp) {
  await mkdir(output, { recursive: true });

  function deferred() {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
  }

  /** 自行產生 2×2 紅色 PNG，不讀使用者圖片或依賴額外原生影像模組。 */
  function syntheticPng() {
    const crc = (bytes) => {
      let value = 0xffffffff;
      for (const byte of bytes) {
        value ^= byte;
        for (let i = 0; i < 8; i += 1) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
      }
      return (value ^ 0xffffffff) >>> 0;
    };
    const chunk = (name, data) => {
      const type = Buffer.from(name);
      const size = Buffer.alloc(4);
      size.writeUInt32BE(data.length);
      const checksum = Buffer.alloc(4);
      checksum.writeUInt32BE(crc(Buffer.concat([type, data])));
      return Buffer.concat([size, type, data, checksum]);
    };
    const header = Buffer.alloc(13);
    header.writeUInt32BE(2, 0); header.writeUInt32BE(2, 4);
    header[8] = 8; header[9] = 2;
    const row = Buffer.from([0, 255, 0, 0, 255, 0, 0]);
    return new Uint8Array(Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.concat([row, row]))), chunk("IEND", Buffer.alloc(0)),
    ]));
  }

  function verifyVector(vector, dim) {
    assert(vector instanceof Float32Array);
    assert.equal(vector.length, dim);
    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    assert(Math.abs(norm - 1) <= 1e-3);
  }

  let embedder;
  try {
    const { WorkerEmbedder } = await import("../packages/server/dist/worker-embedder.js");
    const turns = [];
    const pending = new Set();
    let maxInFlightWorkerRequests = 0;
    let nextRequest = deferred();
    embedder = new WorkerEmbedder({
      embedderOptions: {
        device: "cpu", dtype: "q4",
        ...((option("--cache") ?? process.env.MNEMOSHELF_MODEL_DIR) === undefined ? {} : {
          cacheDir: option("--cache") ?? process.env.MNEMOSHELF_MODEL_DIR,
        }),
      },
      scheduling: { maxWindowInputs: 2, maxQueryBurst: 2 },
      createWorker: () => {
        const worker = new Worker(new URL("./indexing-benchmark/offline-worker.mjs", import.meta.url), { execArgv: [] });
        worker.on("message", (message) => {
          if (message.type === "response") pending.delete(message.id);
        });
        const post = worker.postMessage.bind(worker);
        worker.postMessage = (message, transfer) => {
          if (message.type === "request" && message.method !== "dispose") {
            pending.add(message.id);
            maxInFlightWorkerRequests = Math.max(maxInFlightWorkerRequests, pending.size);
            turns.push({ method: message.method, inputs: message.params.inputs?.length ?? 1 });
            nextRequest.resolve();
          }
          post(message, transfer);
        };
        return worker;
      },
    });
    const image = { bytes: syntheticPng(), mimeType: "image/png" };
    const documents = [
      "A synthetic red apple grows in a green orchard.",
      "A synthetic blue sky appears over a quiet lake.",
      "A synthetic source file exports an addition function.",
      "A synthetic yellow train arrives at a station.",
      "A synthetic white cat sleeps beside a window.",
      "A synthetic small boat sails across an ocean.",
    ].map((text) => ({ text, title: "synthetic" }));
    const firstRequest = nextRequest.promise;
    const batch = embedder.embedDocuments(documents);
    await firstRequest;
    const query = embedder.embedQuery("red apple orchard");
    const picture = embedder.embedImage(image);
    const queuedController = new AbortController();
    const queuedImage = embedder.embedImage(image, { signal: queuedController.signal });
    const queuedCancelled = assert.rejects(queuedImage, { name: "AbortError" });
    queuedController.abort();
    const [vectors, queryVector, imageVector] = await Promise.all([batch, query, picture]);
    await queuedCancelled;
    assert.equal(vectors.length, documents.length);
    for (const vector of [...vectors, queryVector, imageVector]) verifyVector(vector, embedder.info.dim);
    assert.deepEqual(turns.slice(0, 3).map(({ method }) => method), ["embedDocuments", "embedQuery", "embedImage"]);
    assert(turns.filter(({ method }) => method === "embedDocuments").every(({ inputs }) => inputs <= 2));
    for (const index of [0, documents.length - 1]) {
      const reference = await embedder.embedDocument(documents[index].text, documents[index].title);
      const cosine = reference.reduce((sum, value, position) => sum + value * vectors[index][position], 0);
      assert(cosine >= 0.999);
    }
    await embedder.drain();

    // worker 請求已送出後取消文字；drain 必須等回應，剩餘文件視窗不得再啟動。
    nextRequest = deferred();
    const beforeCancel = turns.length;
    const controller = new AbortController();
    const cancelledBatch = embedder.embedDocuments(documents.map(({ text, title }) => ({ text: text.repeat(12), title })), { signal: controller.signal });
    const batchCancelled = assert.rejects(cancelledBatch, { name: "AbortError" });
    await nextRequest.promise;
    // 暖機後刻意保留 50ms，取消時 request 必須仍在途，避免只驗到 dispatch 前取消。
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(pending.size, 1);
    assert.equal(turns.length - beforeCancel, 1);
    const textCancelAt = performance.now();
    controller.abort();
    await Promise.all([batchCancelled, embedder.drain()]);
    const textCancelToDrainMs = performance.now() - textCancelAt;
    assert.equal(turns.length - beforeCancel, 1);

    // 圖片 worker 請求取消與 dispose 並行，驗證 Electron 安全收尾不依賴強制 process.exit。
    nextRequest = deferred();
    const imageController = new AbortController();
    const cancelledPicture = embedder.embedImage(image, { signal: imageController.signal });
    const pictureCancelled = assert.rejects(cancelledPicture, { name: "AbortError" });
    await nextRequest.promise;
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(pending.size, 1);
    const imageCancelAt = performance.now();
    imageController.abort();
    await Promise.all([pictureCancelled, embedder.drain(), embedder.dispose(), embedder.dispose()]);
    const imageCancelToDisposeMs = performance.now() - imageCancelAt;
    assert.equal(maxInFlightWorkerRequests, 1);
    const scheduling = embedder.schedulingStatus;
    assert.equal(scheduling.admittedRequests, 0);
    assert.equal(scheduling.admittedInputBytes, 0);
    assert.equal(scheduling.active, 0);
    const report = {
      passed: true, runtime: { node: process.versions.node, electron: process.versions.electron ?? null },
      model: embedder.info.id, device: embedder.runtimeStatus?.device,
      assertions: { orderedBatch: true, maxInFlightWorkerRequests, queryBeforeNextDocumentWindow: true, queuedImageCancellation: true, inFlightTextRequestCancellation: true, inFlightImageRequestCancellationAndSafeDispose: true },
      cancellation: { textCancelToDrainMs, imageCancelToDisposeMs },
      turns, scheduling,
    };
    await writeFile(path.join(output, "result.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    if (electronApp !== undefined) electronApp.quit();
  } catch (error) {
    await embedder?.dispose();
    // 不列印模型／worker 原始例外，避免路徑或機密出現在分享用結果。
    console.error(JSON.stringify({ passed: false, error: error instanceof Error ? error.name : "Error", message: "真實排程驗收失敗；請檢查建置、模型快取與隔離 runtime。" }));
    if (electronApp !== undefined) electronApp.exit(1);
    else process.exitCode = 1;
  }

}

const electronExecutable = option("--electron");
if (process.versions.electron !== undefined) {
  const { app } = await import("electron");
  mkdirSync(output, { recursive: true });
  app.setPath("userData", path.join(output, "electron-user-data"));
  // Electron 必須先完成 main module 評估才會 ready，不能在模組頂層 await whenReady。
  app.whenReady().then(() => runSmoke(app)).catch(() => {
    console.error(JSON.stringify({ passed: false, error: "ElectronStartupError" }));
    app.exit(1);
  });
} else if (electronExecutable !== undefined) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronExecutable, [fileURLToPath(import.meta.url), ...args], {
    cwd: root, env, windowsHide: true, stdio: "inherit",
  });
  process.exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
} else {
  await runSmoke();
}
