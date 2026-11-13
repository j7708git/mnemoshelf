/** 串行排程：CPU／GPU 隔離行程與 DB；每案只跑一個模型，失敗立即停止。 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { finished } from "node:stream/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { supervise } from "./supervisor.mjs";

assert.equal(process.env.WEBGPU_INTEGRATION_RUN, "1", "設定 WEBGPU_INTEGRATION_RUN=1 才能執行真模型");
const repo = process.cwd();
const base = path.join(repo, ".tmp", "webgpu-integration");
const group = process.env.WEBGPU_RUN_ID ?? `matrix-${Date.now()}-${randomBytes(3).toString("hex")}`;
assert(/^[a-zA-Z0-9_-]+$/.test(group));
const runtimes = (process.env.WEBGPU_RUNTIMES ?? "node,electron").split(",");
assert(runtimes.length > 0 && runtimes.every((name) => ["node", "electron"].includes(name)));
const rounds = Number(process.env.WEBGPU_ROUNDS ?? 3);
assert(Number.isInteger(rounds) && rounds > 0 && rounds <= 5);
const output = path.join(base, "matrices", group);
await mkdir(path.dirname(output), { recursive: true }); await mkdir(output);
const summary = { version: 1, group, startedAt: new Date().toISOString(), rounds, cases: [], comparisons: [], stability: {}, passed: false };
const save = () => writeFile(path.join(output, "summary.json"), JSON.stringify(summary, null, 2));
let electron;
if (runtimes.includes("electron")) {
  const require = createRequire(path.join(repo, "packages", "desktop", "package.json"));
  electron = process.env.WEBGPU_ELECTRON_PATH ?? require("electron");
  assert(typeof electron === "string" && path.isAbsolute(electron), "需要真 Electron executable");
}
async function run(runtime, device, iteration, scenario = "standard") {
  const id = `${group}-${runtime}-${device}-${scenario}-${iteration}`;
  console.log(`開始 ${id}`);
  const log = createWriteStream(path.join(output, `${id}.log`), { flags: "wx" });
  const env = { ...process.env, WEBGPU_CASE_DEVICE: device, WEBGPU_CASE_ID: id, WEBGPU_CASE_SCENARIO: scenario };
  delete env.ELECTRON_RUN_AS_NODE;
  const entry = path.join(repo, "scripts", "webgpu-integration", runtime === "electron" ? "electron-main.mjs" : "case.mjs");
  const child = spawn(runtime === "electron" ? electron : process.execPath, [entry], { cwd: repo, env, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
  let supervised;
  try { supervised = await supervise(child); }
  finally { log.end(); await finished(log); }
  const { exit, timedOut, memoryExceeded, sampledPeakRssBytes, maxRssBytes, sampleFailures } = supervised;
  await writeFile(path.join(output, `${id}-parent-rss.json`), JSON.stringify(supervised, null, 2));
  let report;
  try { report = JSON.parse(await readFile(path.join(base, "runs", id, "report.json"), "utf8")); } catch { /* 硬崩潰沒有報告；退出狀態仍保留。 */ }
  const item = { id, runtime, device, iteration, scenario, exit, timedOut, memoryExceeded, sampledPeakRssBytes, maxRssBytes, sampleFailures, passed: exit.code === 0 && !timedOut && !memoryExceeded && report?.passed === true && report.resources.mainPeakRssBytes <= maxRssBytes, stages: report?.stages, peakRssBytes: report?.resources?.mainPeakRssBytes, error: report?.error };
  summary.cases.push(item); await save();
  console.log(JSON.stringify(item));
  assert(item.passed, `${id} 未通過；檢查隔離 log／report`);
  return report;
}
function cosine(left, right) { let dot = 0; let aa = 0; let bb = 0; for (let index = 0; index < left.length; index++) { dot += left[index] * right[index]; aa += left[index] ** 2; bb += right[index] ** 2; } return dot / Math.sqrt(aa * bb); }
async function compare(cpu, gpu) {
  const cpuVectors = JSON.parse(await readFile(path.join(base, "runs", cpu.runId, "initial-vectors.json"), "utf8"));
  const gpuVectors = JSON.parse(await readFile(path.join(base, "runs", gpu.runId, "initial-vectors.json"), "utf8"));
  const indexed = new Map(cpuVectors.map((item) => [`${item.relPath}:${item.seq}`, item.vector]));
  assert(indexed.size > 0 && gpuVectors.length > 0, "CPU／GPU 向量不可為空");
  assert.equal(indexed.size, gpuVectors.length, "CPU／GPU 向量數不同");
  const similarities = gpuVectors.map((item) => { const other = indexed.get(`${item.relPath}:${item.seq}`); assert(other); return cosine(other, item.vector); });
  const minCosine = Math.min(...similarities);
  const comparison = { cpu: cpu.runId, webgpu: gpu.runId, vectors: similarities.length, minCosine, initialIndexSpeedup: cpu.stages.initialIndex.wallMs / gpu.stages.initialIndex.wallMs, passed: minCosine >= 0.999 };
  summary.comparisons.push(comparison); await save(); assert(comparison.passed, "CPU／GPU 向量一致性低於 0.999");
}
try {
  for (const runtime of runtimes) {
    // Node 三輪檢查新行程穩定性；Electron 每輪一組代表案例，可另以 WEBGPU_ROUNDS 調整 Node 輪數。
    for (let iteration = 1; iteration <= (runtime === "node" ? rounds : 1); iteration++) {
      const cpu = await run(runtime, "cpu", iteration);
      const gpu = await run(runtime, "webgpu", iteration);
      await compare(cpu, gpu);
    }
    await run(runtime, "webgpu", 1, "budget");
  }
  for (const runtime of runtimes) for (const device of ["cpu", "webgpu"]) {
    const cases = summary.cases.filter((item) => item.runtime === runtime && item.device === device && item.scenario === "standard");
    summary.stability[`${runtime}-${device}`] = { freshProcesses: cases.length, peakRssBytes: cases.map((item) => item.peakRssBytes), initialIndexMs: cases.map((item) => item.stages.initialIndex.wallMs), closeMs: cases.map((item) => item.stages.close.wallMs), note: "列出實際趨勢，不以少數新行程樣本宣稱沒有長期洩漏。" };
  }
  summary.passed = true;
} catch (error) { summary.error = { name: error?.name, message: String(error?.message ?? "矩陣失敗").replaceAll(repo, "<repo>").replaceAll(os.homedir(), "<home>") }; process.exitCode = 1; }
finally { summary.finishedAt = new Date().toISOString(); await save(); console.log(JSON.stringify({ group, passed: summary.passed, error: summary.error, comparisons: summary.comparisons, stability: summary.stability }, null, 2)); }
