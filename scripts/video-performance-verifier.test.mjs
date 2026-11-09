import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { validatePerformance, verifySamplerSidecars } from "./video-performance-verifier.mjs";

function fixture() {
  const samples = [], events = [], trials = [];
  let nextPid = 1000, nextRoot = 0;
  const cleanup = (id, count, remainingVectors = 0) => ({ rootId: id, deletedData: true, removedChunks: count, remainingVectors });
  const indexed = (id) => ({ rootId: id, processed: 1, skippedUnchanged: 0, skippedFiles: [], failedFiles: [], scanSkippedFiles: [] });
  function event(phase, start, end, kind = phase === "streams" || phase === "show-frames" ? "ffprobe" : "ffmpeg") {
    const pid = nextPid++;
    events.push({ kind, phase, pid, spawnMs: start, exitMs: end, closeMs: end + 0.1, code: 0, signal: null });
    samples.push({ atMs: start + 1, roundTripMs: 1, nodeRss: 100, nodeExternal: 20, nodeArrayBuffers: 10, ffmpegRss: kind === "ffmpeg" ? 50 : 0, ffprobeRss: kind === "ffprobe" ? 50 : 0, totalRss: 150, complete: true, pids: [pid], observedRss: [{ pid, rss: 50 }] });
    return pid;
  }
  const specs = [["1080p-60", 60], ["1080p-300", 300], ["1080p-600", 600], ["1080p-tail", 60.2], ["1080p-near-limit", 600]];
  const addTrial = (name, duration, iteration, temperature) => {
    const rootId = ++nextRoot, start = rootId * 1000, end = start + 500;
    for (const [index, phase] of ["streams", "show-frames", "visual", "audio"].entries()) event(phase, start + 20 + index * 100, start + 90 + index * 100);
    const vc = Math.ceil(duration / 4), ac = Math.ceil(duration / 10);
    trials.push({ name, iteration, temperature, startMonotonicMs: start, endMonotonicMs: end, totalMs: end - start, firstRelevantMs: 500, firstRelevantObservation: { afterMs: 400, byMs: 500 }, firstRelevantHit: { relPath: `${name}.mp4`, media: { track: "video", startSeconds: 0, endSeconds: 4 } }, videoChunks: vc, audioChunks: ac, expectedVideo: vc, expectedAudio: ac, querySamples: 2, queryErrors: 0, queryP95Ms: 2, queryTicksSkipped: 0, queryIntervalMs: 2000, sampledPeakRss: 150, sampledPeakArrayBuffers: 10, estimatedPcmBytes: Math.ceil(duration * 16000) * 4, ffmpegSpawns: 2, systemCpuStart: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 }, systemCpuEnd: { user: 1, nice: 0, sys: 1, idle: 1, irq: 0 }, phaseDurations: { streams: [70.1], "show-frames": [70.1], visual: [70.1], audio: [70.1] }, embedderRuntime: { loaded: true, device: "cpu" }, indexed: indexed(rootId), cleanup: cleanup(rootId, vc + ac) });
  };
  addTrial("1080p-60", 60, 0, "cold-media");
  for (const [name, duration] of specs) for (let i = 1; i <= 3; i += 1) addTrial(name, duration, i, "warm");
  const cancelId = ++nextRoot, requestMs = 18010, cancelPid = event("visual", 18000, 18020);
  const cancellation = { requestMonotonicMs: requestMs, livePidsAtCancel: [cancelPid], closeObservations: [{ pid: cancelPid, closeAfterRequestMs: 10.1 }], response: { rootId: cancelId, cancelled: true }, indexResult: { rootId: cancelId, cancelled: true }, cancelResponseMs: 2, budgetClosedMs: 11, nativeDrainFromRequestMs: 4, drainCallMs: 2, indexSettleMs: 12, cleanup: cleanup(cancelId, 0) };
  const nativeId = ++nextRoot;
  const nativeCancellation = { requestMonotonicMs: 19000, response: { rootId: nativeId, cancelled: true }, indexResult: { rootId: nativeId, cancelled: true }, cancelResponseMs: 1, drainCallMs: 2, drainSettleMs: 3, indexSettleMs: 4, cleanup: cleanup(nativeId, 0) };
  const standaloneBaselines = ["wav", "text"].map((kind) => { const id = ++nextRoot; return { kind, elapsedMs: 10, result: indexed(id), chunks: 1, cleanup: cleanup(id, 1) }; });
  const kinds = ["long-video", "short-video", "wav", "text"];
  const results = kinds.map((kind, index) => { const id = ++nextRoot, end = index === 0 ? 1000 : 500; return { kind, startMs: 0, finishedMs: end, durationMs: end, finishedBeforeLong: index === 0 ? null : true, result: indexed(id), chunks: index === 0 ? 210 : index === 1 ? 21 : 1 }; });
  const fairness = { standaloneBaselines, baselines: Object.fromEntries(kinds.map((kind) => [kind, 10])), baselineVideoFfmpegSpawns: 2, unsampledPids: [], results, cleanup: results.map((entry, index) => cleanup(entry.result.rootId, entry.chunks, index === 3 ? 0 : 3 - index)), budgetAfter: { active: 0, waiting: 0 }, preemptions: 1, ffmpegSpawns: 2, querySamples: [{ startMs: 0, durationMs: 1, ok: true }, { startMs: 2, durationMs: 2, ok: true }], queryP95Ms: 2 };
  const fakeHash = "a".repeat(64);
  const modelHashes = Object.fromEntries(["model_q4.onnx", "model_q4.onnx_data", "vision_encoder_q4.onnx", "vision_encoder_q4.onnx_data", "audio_encoder_q4.onnx", "audio_encoder_q4.onnx_data"].map((name) => [name, fakeHash]));
  const report = { runId: "synthetic", sourceId: "synthetic-source", labelsSha256: "846c102b582045a264388baed8ef458d5e7b1bb9278a368c73d2a564d2bece56", audioFixtureSha256: "c0fdef41a0af25c5bc4a16472c9cda1028ee150049c8293b715ea8712e6a0904", modelHashes, decoderHashes: { ffmpeg: fakeHash, ffprobe: fakeHash }, scenario: "full", status: "pass", current: null, executionEnvironment: "normal-permissions", coldQueryMs: 20, embedderRuntimeAfterColdQuery: { device: "cpu", loaded: true }, sourceHashes: { "scripts/video-acceptance/run-performance.mjs": "89260ee32e1e4a5b84b5e3ed5742d6dc3e63820cb563875eb95b1016a88181a5" }, samplerReady: true, sampleWriteError: null, trials, cancellation, nativeCancellation, fairness, observer: { events, sampleCount: samples.length, samplerError: null, pendingSamples: 0 } };
  return { report, samples };
}
const check = (result, name) => result.checks.find((entry) => entry.name === name)?.status;

test("完整合成測量可通過並保留無法重算的限制", () => {
  const { report, samples } = fixture();
  const result = validatePerformance(report, samples);
  assert.equal(result.status, "pass", JSON.stringify(result.checks.filter((entry) => entry.status !== "pass")));
  assert.ok(result.limitations.some((text) => text.includes("無法獨立重算")));
});

test("缺暖跑、樣本或最後寫檔狀態不可通過", () => {
  for (const mutate of [
    ({ report }) => report.trials.pop(),
    ({ samples }) => samples.pop(),
    ({ report }) => { delete report.sampleWriteError; },
    ({ report }) => { report.observer.pendingSamples = 1; },
    ({ report }) => { report.observer.events[0].closeMs = null; },
    ({ report }) => { report.observer.events[0].closeMs = report.trials[0].endMonotonicMs + 1; },
  ]) {
    const input = fixture(); mutate(input);
    assert.notEqual(validatePerformance(input.report, input.samples).status, "pass");
  }
});

test("finally 才出現 samplerError 不可被舊 status=pass 掩蓋", () => {
  const { report, samples } = fixture(); report.observer.samplerError = "sampler-close-timeout";
  assert.notEqual(validatePerformance(report, samples).status, "pass");
  assert.equal(check(validatePerformance(report, samples), "最終 observer 與日誌"), "missing");
});

test("自然完成不得假稱取消；兩個 rootId、ACK、終態及清理需一致", () => {
  for (const mutate of [
    (r) => { r.cancellation.indexResult.cancelled = false; },
    (r) => { delete r.cancellation.response.cancelled; },
    (r) => { r.cancellation.indexResult.rootId += 1; },
    (r) => { r.nativeCancellation.indexResult.cancelled = false; },
    (r) => { r.nativeCancellation.cleanup.removedChunks = 1; },
    (r) => { r.cancellation.indexSettleMs = 1; },
    (r) => { r.cancellation.budgetClosedMs = 1; },
  ]) {
    const { report, samples } = fixture(); mutate(report);
    assert.notEqual(validatePerformance(report, samples).status, "pass");
  }
});

test("近上限 600 秒暖跑也必須套原最長片門檻", () => {
  const { report, samples } = fixture();
  const trial = report.trials.find((item) => item.name === "1080p-near-limit");
  trial.firstRelevantMs = 700000; trial.firstRelevantObservation = { afterMs: 650000, byMs: 700000 };
  const result = validatePerformance(report, samples);
  assert.equal(check(result, "最長600秒首筆相關 ≤600秒"), "fail");
  assert.equal(result.status, "fail");
});

test("跨越門檻的觀察區間不可視為通過", () => {
  const { report, samples } = fixture();
  const trial = report.trials.find((item) => item.temperature === "warm" && item.name === "1080p-60");
  trial.firstRelevantMs = 61000; trial.firstRelevantObservation = { afterMs: 59000, byMs: 61000 };
  assert.equal(check(validatePerformance(report, samples), "60秒首筆相關 ≤60秒"), "inconclusive");
});

test("未完整採到個別 PID、錯置 PID 時間或無實際工作集均不通過", () => {
  for (const mutate of [
    (samples) => { samples[0].complete = false; },
    (samples) => { samples[0].observedRss = []; },
    (samples) => { samples[0].atMs += 999999; },
    (samples) => { samples[0].ffmpegRss = 20; samples[0].ffprobeRss = 30; },
    (samples) => { samples[0].pids.push(777777); },
  ]) {
    const input = fixture(); mutate(input.samples);
    assert.notEqual(validatePerformance(input.report, input.samples).status, "pass");
  }
});

test("程序退出期間的不完整樣本可保留，但同 PID 仍需其他完整樣本", () => {
  const { report, samples } = fixture();
  const valid = structuredClone(samples[0]);
  samples[0].complete = false;
  samples[0].observedRss = [];
  samples[0].ffmpegRss = 0;
  samples[0].ffprobeRss = 0;
  samples[0].totalRss = samples[0].nodeRss;
  samples.push(valid);
  report.observer.sampleCount = samples.length;
  assert.equal(validatePerformance(report, samples).status, "pass");
  samples.pop(); report.observer.sampleCount = samples.length;
  assert.notEqual(validatePerformance(report, samples).status, "pass");
});

test("公平性必須其他三 root 先於長片完成、清理並有成功查詢", () => {
  for (const mutate of [
    (f) => { f.results[1].finishedMs = 1100; f.results[1].durationMs = 1100; f.results[1].finishedBeforeLong = false; },
    (f) => { f.querySamples[0].ok = false; },
    (f) => { f.cleanup.at(-1).remainingVectors = 1; },
  ]) {
    const { report, samples } = fixture(); mutate(report.fairness);
    assert.notEqual(validatePerformance(report, samples).status, "pass");
  }
});

test("sampler 外部側證需相同 PID／建立時間與成功查詢", () => {
  const before = { parent: { ProcessId: 1 }, sampler: { ProcessId: 2, Name: "powershell.exe", CreationDate: "2026-11-09T01:00:00Z" }, observedUtc: "2026-11-09T01:01:00Z" };
  const after = { before: { ...before.sampler }, checkedUtc: "2026-11-09T01:02:00Z", queryStatus: "ok", sameIdentityAlive: false };
  assert.equal(verifySamplerSidecars(before, after).status, "exited");
  assert.equal(verifySamplerSidecars(before, { ...after, sameIdentityAlive: true }).status, "still-running");
  assert.equal(verifySamplerSidecars(before, { ...after, queryStatus: "error", sameIdentityAlive: null }).status, "not-proven");
  assert.equal(verifySamplerSidecars(before, { ...after, before: { ...after.before, CreationDate: "2026-11-09T01:00:01Z" } }).status, "not-proven");
});


test("CLI 只建立新 validation，不覆寫原始報告或既有驗證結果", async () => {
  const tmp = path.join(process.cwd(), ".tmp");
  await mkdir(tmp, { recursive: true });
  const dir = await mkdtemp(path.join(tmp, "performance-verifier-test-"));
  const { report, samples } = fixture();
  const reportBytes = Buffer.from(JSON.stringify(report));
  const sampleBytes = Buffer.from(samples.map((sample) => JSON.stringify(sample)).join("\n") + "\n");
  await writeFile(path.join(dir, "performance.json"), reportBytes);
  await writeFile(path.join(dir, "rss-samples.ndjson"), sampleBytes);
  const runner = path.join(process.cwd(), "scripts", "video-performance-verifier.mjs");
  const first = spawnSync(process.execPath, [runner, dir], { encoding: "utf8", windowsHide: true });
  assert.equal(first.status, 0, first.stderr);
  const saved = await readFile(path.join(dir, "validation.json"));
  assert.equal(JSON.parse(saved.toString()).status, "pass");
  const second = spawnSync(process.execPath, [runner, dir], { encoding: "utf8", windowsHide: true });
  assert.notEqual(second.status, 0);
  assert.deepEqual(await readFile(path.join(dir, "validation.json")), saved);
  assert.deepEqual(await readFile(path.join(dir, "performance.json")), reportBytes);
  assert.deepEqual(await readFile(path.join(dir, "rss-samples.ndjson")), sampleBytes);
});
