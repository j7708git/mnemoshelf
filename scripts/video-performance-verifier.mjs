#!/usr/bin/env node
/** 獨立核對既有 performance.json 與 RSS 原始資料；只新增 validation.json。 */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const CASES = new Map([["1080p-60", 60], ["1080p-300", 300], ["1080p-600", 600], ["1080p-tail", 60.2], ["1080p-near-limit", 600]]);
const RUNNER_SHA256 = "89260ee32e1e4a5b84b5e3ed5742d6dc3e63820cb563875eb95b1016a88181a5";
const isNum = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;
const isId = (value) => Number.isSafeInteger(value) && value > 0;
const own = (obj, key) => obj !== null && typeof obj === "object" && Object.hasOwn(obj, key);
const close = (a, b) => isNum(a) && isNum(b) && Math.abs(a - b) <= 0.01;
const empty = (value) => Array.isArray(value) && value.length === 0;
const relevant = (hit, name, duration) => {
  if (!hit || hit.relPath !== `${name}.mp4` || hit.media?.track !== "video" || !isNum(hit.media.startSeconds) || !isNum(hit.media.endSeconds) || hit.media.endSeconds <= hit.media.startSeconds) return false;
  for (let start = 0; start < duration; start += 36) if (Math.min(hit.media.endSeconds, Math.min(start + 8, duration)) - Math.max(hit.media.startSeconds, start) > 0.001) return true;
  return false;
};
const indexed = (value) => isId(value?.rootId) && value.processed === 1 && value.skippedUnchanged === 0 && empty(value.skippedFiles) && empty(value.failedFiles) && empty(value.scanSkippedFiles);
const cleaned = (value, rootId, count, expectZero = true) => value?.rootId === rootId && value.deletedData === true && Number.isSafeInteger(value.remainingVectors) && value.remainingVectors >= 0 && (count === null ? Number.isSafeInteger(value.removedChunks) && value.removedChunks >= 0 : value.removedChunks === count) && (!expectZero || value.remainingVectors === 0);
const cpu = (value) => value?.device === "cpu" && value.loaded === true;
const p95 = (values) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1];

/** 不以原報告 status／valid／acceptance 作為判定；每項由保存的欄位重新核對。 */
export function validatePerformance(report, samples) {
  const checks = [];
  const add = (name, status, detail) => checks.push({ name, status, detail });
  const pass = (name, condition, detail) => add(name, condition ? "pass" : "missing", detail);
  const r = report && typeof report === "object" ? report : {};
  const trials = Array.isArray(r.trials) ? r.trials.map((item) => item && typeof item === "object" ? item : {}) : [];
  const events = Array.isArray(r.observer?.events) ? r.observer.events.map((item) => item && typeof item === "object" ? item : {}) : [];
  const sampleList = Array.isArray(samples) ? samples.map((item) => item && typeof item === "object" ? item : {}) : [];
  const runnerHashes = Object.entries(r.sourceHashes ?? {}).filter(([key]) => key.split(/[\\/]/).at(-1) === "run-performance.mjs").map(([, value]) => value);
  pass("來源與終態", r.scenario === "full" && r.executionEnvironment === "normal-permissions" && r.current === null && ["pass", "not-passed", "partial"].includes(r.status) && runnerHashes.length === 1 && runnerHashes[0] === RUNNER_SHA256, "完整情境、一般權限、非進行中且量測 runner hash 符合已知版本");
  const expectedModels = ["model_q4.onnx", "model_q4.onnx_data", "vision_encoder_q4.onnx", "vision_encoder_q4.onnx_data", "audio_encoder_q4.onnx", "audio_encoder_q4.onnx_data"];
  const isHash = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
  pass("素材與模型身分欄位", typeof r.runId === "string" && typeof r.sourceId === "string" && r.labelsSha256 === "846c102b582045a264388baed8ef458d5e7b1bb9278a368c73d2a564d2bece56" && r.audioFixtureSha256 === "c0fdef41a0af25c5bc4a16472c9cda1028ee150049c8293b715ea8712e6a0904" && expectedModels.every((name) => isHash(r.modelHashes?.[name])) && isHash(r.decoderHashes?.ffmpeg) && isHash(r.decoderHashes?.ffprobe) && Object.values(r.sourceHashes ?? {}).every(isHash), "凍結標籤、WAV 與六個模型、兩個 decoder hash 欄位；不聲稱實際重新 hash 外部資產");
  pass("冷啟動", isNum(r.coldQueryMs) && cpu(r.embedderRuntimeAfterColdQuery), "另記冷查詢耗時且確認模型已載入 CPU");
  const cold = trials.filter((trial) => trial.temperature === "cold-media" && trial.name === "1080p-60" && trial.iteration === 0);
  const warm = trials.filter((trial) => trial.temperature === "warm");
  const exactSchedule = trials.length === 16 && cold.length === 1 && warm.length === 15 && [...CASES.keys()].every((name) => {
    const items = warm.filter((trial) => trial.name === name);
    return items.length === 3 && [1, 2, 3].every((iteration) => items.filter((trial) => trial.iteration === iteration).length === 1);
  });
  pass("案例與暖跑", exactSchedule, "五種素材各三暖跑，另有一輪 60 秒冷媒體");
  for (const [index, trial] of trials.entries()) {
    const duration = CASES.get(trial.name);
    const id = `trial ${index + 1} ${trial.name ?? "unknown"} ${trial.temperature ?? "unknown"}/${trial.iteration ?? "?"}`;
    const counts = duration !== undefined && trial.videoChunks === Math.ceil(duration / 4) && trial.audioChunks === Math.ceil(duration / 10) && trial.expectedVideo === Math.ceil(duration / 4) && trial.expectedAudio === Math.ceil(duration / 10);
    const timeline = isNum(trial.startMonotonicMs) && isNum(trial.endMonotonicMs) && trial.endMonotonicMs >= trial.startMonotonicMs && close(trial.endMonotonicMs - trial.startMonotonicMs, trial.totalMs);
    const observation = trial.firstRelevantObservation;
    const hit = duration !== undefined && relevant(trial.firstRelevantHit, trial.name, duration) && isNum(trial.firstRelevantMs) && isNum(observation?.afterMs) && isNum(observation?.byMs) && observation.afterMs <= observation.byMs && close(observation.byMs, trial.firstRelevantMs);
    const query = Number.isSafeInteger(trial.querySamples) && trial.querySamples > 0 && trial.queryErrors === 0 && isNum(trial.queryP95Ms) && Number.isSafeInteger(trial.queryTicksSkipped) && trial.queryTicksSkipped >= 0 && trial.queryIntervalMs === 2000;
    const systemCpu = ["user", "nice", "sys", "idle", "irq"].every((key) => isNum(trial.systemCpuStart?.[key]) && isNum(trial.systemCpuEnd?.[key]) && trial.systemCpuEnd[key] >= trial.systemCpuStart[key]);
    const phase = ["show-frames", "audio"].every((name) => Array.isArray(trial.phaseDurations?.[name]) && trial.phaseDurations[name].length > 0 && trial.phaseDurations[name].every(isNum));
    pass(id, counts && timeline && hit && query && systemCpu && phase && cpu(trial.embedderRuntime) && indexed(trial.indexed) && cleaned(trial.cleanup, trial.indexed?.rootId, trial.videoChunks + trial.audioChunks) && isNum(trial.sampledPeakRss) && trial.sampledPeakRss > 0 && isNum(trial.sampledPeakArrayBuffers) && duration !== undefined && trial.estimatedPcmBytes === Math.ceil(duration * 16000) * 4, "片段數、實際相關命中、時間、查詢、CPU、每檔清理與 RSS 欄位");
  }
  function bound(name, limit, ids) {
    const group = warm.filter((trial) => ids.includes(trial.name));
    if (group.length !== ids.length * 3 || group.some((trial) => !isNum(trial.firstRelevantObservation?.afterMs) || !isNum(trial.firstRelevantObservation?.byMs) || trial.firstRelevantObservation.afterMs > trial.firstRelevantObservation.byMs || !CASES.has(trial.name) || !relevant(trial.firstRelevantHit, trial.name, CASES.get(trial.name)))) return add(name, "missing", "相關命中區間或三暖跑缺失");
    const observations = group.map((trial) => trial.firstRelevantObservation);
    const result = observations.every((o) => o.byMs <= limit) ? "pass" : observations.some((o) => o.afterMs > limit) ? "fail" : "inconclusive";
    add(name, result, `${group.length} 筆觀察上下界；跨門檻列 inconclusive`);
  }
  bound("60秒首筆相關 ≤60秒", 60_000, ["1080p-60"]);
  bound("最長600秒首筆相關 ≤600秒", 600_000, ["1080p-600", "1080p-near-limit"]);

  const obs = r.observer;
  const finalObserver = r.samplerReady === true && own(obs, "samplerError") && obs.samplerError === null && own(obs, "pendingSamples") && obs.pendingSamples === 0 && own(r, "sampleWriteError") && r.sampleWriteError === null && Number.isSafeInteger(obs?.sampleCount) && obs.sampleCount === sampleList.length;
  pass("最終 observer 與日誌", finalObserver, "最終 samplerError=null、pending=0、寫檔無誤且 NDJSON 行數吻合");
  const eventsByPid = new Map();
  for (const event of events) {
    if (!eventsByPid.has(event.pid)) eventsByPid.set(event.pid, []);
    eventsByPid.get(event.pid).push(event);
  }
  function sampleValid(sample) {
    if (!isNum(sample.atMs) || !isNum(sample.nodeRss) || !isNum(sample.nodeExternal) || !isNum(sample.nodeArrayBuffers) || !isNum(sample.ffmpegRss) || !isNum(sample.ffprobeRss) || !isNum(sample.totalRss) || !isNum(sample.roundTripMs) || typeof sample.complete !== "boolean" || !Array.isArray(sample.pids) || !Array.isArray(sample.observedRss) || !sample.pids.every(isId) || new Set(sample.pids).size !== sample.pids.length) return false;
    const observed = new Map();
    for (const entry of sample.observedRss) {
      if (!isId(entry?.pid) || !isNum(entry.rss) || observed.has(entry.pid) || !sample.pids.includes(entry.pid)) return false;
      observed.set(entry.pid, entry.rss);
    }
    if (sample.complete !== sample.pids.every((pid) => observed.has(pid))) return false;
    let ffmpeg = 0, ffprobe = 0;
    for (const pid of sample.pids) {
      const matches = (eventsByPid.get(pid) ?? []).filter((event) => isNum(event.spawnMs) && isNum(event.closeMs) && event.spawnMs <= sample.atMs && sample.atMs <= event.closeMs);
      if (matches.length !== 1 || !["ffmpeg", "ffprobe"].includes(matches[0].kind)) return false;
      const rss = observed.get(pid) ?? 0;
      if (matches[0].kind === "ffmpeg") ffmpeg += rss; else ffprobe += rss;
    }
    return close(sample.ffmpegRss, ffmpeg) && close(sample.ffprobeRss, ffprobe) && close(sample.totalRss, sample.nodeRss + ffmpeg + ffprobe);
  }
  const validSamples = sampleList.length > 0 && sampleList.every(sampleValid);
  pass("原始 RSS 樣本", validSamples, "逐樣本核對 PID 身分／完整性，按程序種類重算 RSS 組成；峰值只是取樣下界");
  const closed = events.length > 0 && events.every((event) => ["ffmpeg", "ffprobe"].includes(event.kind) && isId(event.pid) && isNum(event.spawnMs) && isNum(event.exitMs) && isNum(event.closeMs) && event.spawnMs <= event.exitMs && event.exitMs <= event.closeMs && own(event, "code") && own(event, "signal"));
  pass("所有媒體程序 close", closed, "包括版本探測程序，逐一要求真實 spawn／exit／close 時間");
  const completeSamples = sampleList.filter((sample) => sample.complete === true && sampleValid(sample));
  const relevantEvents = events.filter((event) => event.phase !== "other");
  const missingPids = relevantEvents.filter((event) => !completeSamples.some((sample) => sample.atMs >= event.spawnMs && sample.atMs <= event.closeMs && sample.pids.includes(event.pid) && sample.observedRss.some((entry) => entry.pid === event.pid && entry.rss > 0)));
  pass("逐媒體 PID 採樣", relevantEvents.length > 0 && missingPids.length === 0, `非版本探測媒體程序 ${relevantEvents.length} 個；未完整採樣 ${missingPids.length} 個`);
  for (const [index, trial] of trials.entries()) {
    const scopedEvents = relevantEvents.filter((event) => isNum(event.spawnMs) && event.spawnMs >= trial.startMonotonicMs && event.spawnMs <= trial.endMonotonicMs);
    const scopedSamples = completeSamples.filter((sample) => sample.atMs >= trial.startMonotonicMs && sample.atMs <= trial.endMonotonicMs);
    const peak = scopedSamples.length ? Math.max(...scopedSamples.map((sample) => sample.totalRss)) : null;
    const arrayPeak = scopedSamples.length ? Math.max(...scopedSamples.map((sample) => sample.nodeArrayBuffers)) : null;
    const phases = ["show-frames", "audio"].every((phase) => scopedEvents.some((event) => event.phase === phase && !missingPids.includes(event)));
    const durationsMatch = ["show-frames", "streams", "visual", "audio"].every((phase) => {
      const raw = scopedEvents.filter((event) => event.phase === phase).map((event) => event.closeMs - event.spawnMs);
      const stored = trial.phaseDurations?.[phase];
      return Array.isArray(stored) && stored.length === raw.length && stored.every((value, i) => close(value, raw[i]));
    });
    pass(`trial ${index + 1} PID/RSS`, scopedEvents.length > 0 && scopedSamples.length > 0 && phases && durationsMatch && scopedEvents.every((event) => !missingPids.includes(event) && isNum(event.closeMs) && event.closeMs <= trial.endMonotonicMs) && close(peak, trial.sampledPeakRss) && close(arrayPeak, trial.sampledPeakArrayBuffers) && trial.ffmpegSpawns === scopedEvents.filter((event) => event.kind === "ffmpeg").length, "以真實 spawn／close 重算程序耗時，驗證索引返回前 close，並以完整樣本重算 RSS 峰值");
  }
  for (const [name, entry] of [["FFmpeg 取消", r.cancellation], ["native 取消", r.nativeCancellation]]) {
    const response = entry?.response, result = entry?.indexResult;
    const ack = isId(response?.rootId) && response.cancelled === true && result?.rootId === response.rootId && result.cancelled === true && cleaned(entry?.cleanup, response.rootId, 0);
    const times = isNum(entry?.requestMonotonicMs) && isNum(entry?.cancelResponseMs) && isNum(entry?.indexSettleMs) && isNum(entry?.drainCallMs);
    const native = name === "native 取消" ? isNum(entry?.drainSettleMs) : isNum(entry?.budgetClosedMs) && isNum(entry?.nativeDrainFromRequestMs) && Array.isArray(entry?.livePidsAtCancel) && entry.livePidsAtCancel.length > 0 && Array.isArray(entry.closeObservations) && entry.closeObservations.length === entry.livePidsAtCancel.length && entry.livePidsAtCancel.every((pid) => {
      const observation = entry.closeObservations.filter((item) => item.pid === pid);
      const matches = events.filter((event) => event.pid === pid && event.kind === "ffmpeg" && event.spawnMs <= entry.requestMonotonicMs && event.closeMs >= entry.requestMonotonicMs);
      return observation.length === 1 && matches.length === 1 && isNum(observation[0].closeAfterRequestMs) && observation[0].closeAfterRequestMs <= entry.indexSettleMs && observation[0].closeAfterRequestMs <= entry.budgetClosedMs && close(observation[0].closeAfterRequestMs, matches[0].closeMs - entry.requestMonotonicMs);
    });
    pass(name, ack && times && native, "取消 ACK／索引終態 rootId 一致且 cancelled=true，記錄 drain／close，清理零片段及零向量");
  }
  const fairness = r.fairness;
  const kinds = ["long-video", "short-video", "wav", "text"];
  const results = Array.isArray(fairness?.results) ? fairness.results : [];
  const cleanups = Array.isArray(fairness?.cleanup) ? fairness.cleanup : [];
  const bases = Array.isArray(fairness?.standaloneBaselines) ? fairness.standaloneBaselines : [];
  const fairnessQueries = Array.isArray(fairness?.querySamples) ? fairness.querySamples : [];
  const fq = fairnessQueries.length > 0 && fairnessQueries.every((entry) => entry.ok === true && isNum(entry.startMs) && isNum(entry.durationMs)) && isNum(fairness.queryP95Ms) && close(p95(fairnessQueries.map((entry) => entry.durationMs)), fairness.queryP95Ms);
  const baselines = ["wav", "text"].every((kind) => {
    const items = bases.filter((entry) => entry.kind === kind);
    return items.length === 1 && indexed(items[0].result) && isNum(items[0].elapsedMs) && Number.isSafeInteger(items[0].chunks) && items[0].chunks > 0 && cleaned(items[0].cleanup, items[0].result.rootId, items[0].chunks);
  }) && kinds.every((kind) => isNum(fairness?.baselines?.[kind]));
  const resultSet = results.length === 4 && kinds.every((kind) => results.filter((entry) => entry.kind === kind).length === 1) && results.every((entry) => indexed(entry.result) && Number.isSafeInteger(entry.chunks) && entry.chunks > 0 && (entry.kind !== "long-video" || entry.chunks === 210) && (entry.kind !== "short-video" || entry.chunks === 21) && isNum(entry.startMs) && isNum(entry.finishedMs) && entry.finishedMs >= entry.startMs && close(entry.durationMs, entry.finishedMs - entry.startMs));
  const fairnessCleanup = cleanups.length === 4 && resultSet && results.every((entry) => cleanups.filter((item) => cleaned(item, entry.result.rootId, entry.chunks, false)).length === 1) && cleanups.at(-1)?.remainingVectors === 0;
  pass("公平性與清理", fq && baselines && resultSet && fairnessCleanup && fairness.budgetAfter?.active === 0 && fairness.budgetAfter?.waiting === 0 && isNum(fairness.preemptions) && isNum(fairness.ffmpegSpawns) && isNum(fairness.baselineVideoFfmpegSpawns), "四 root 完成、獨立基線、查詢原始 P95、budget 歸零與四 root 清理");
  const longResult = results.find((entry) => entry.kind === "long-video");
  const peers = results.filter((entry) => ["short-video", "wav", "text"].includes(entry.kind));
  if (!resultSet || !longResult || peers.length !== 3 || peers.some((entry) => typeof entry.finishedBeforeLong !== "boolean" || entry.finishedBeforeLong !== (entry.finishedMs < longResult.finishedMs))) {
    add("公平性先後次序", "missing", "缺少可核對的四 root 完工時間或先後旗標");
  } else {
    const queryDuringLong = fairnessQueries.some((entry) => entry.ok === true && entry.startMs >= longResult.startMs && entry.startMs < longResult.finishedMs);
    add("公平性先後次序", peers.every((entry) => entry.finishedMs < longResult.finishedMs) && queryDuringLong ? "pass" : "fail", "短片、WAV、文字皆須在長片前完成，且長片期間有成功查詢");
  }
  const allIds = [...trials.map((t) => t.indexed?.rootId), r.cancellation?.response?.rootId, r.nativeCancellation?.response?.rootId, ...bases.map((b) => b.result?.rootId), ...results.map((x) => x.result?.rootId)];
  pass("root 身分唯一", allIds.every(isId) && new Set(allIds).size === allIds.length, "各輪、取消與公平性使用獨立 rootId");
  const unresolved = checks.filter((item) => item.status !== "pass");
  return { status: unresolved.length === 0 ? "pass" : unresolved.some((item) => item.status === "fail") ? "fail" : "incomplete", checks, limitations: [
    "最終 trial 僅保存查詢 P95 與計數，未保存各次查詢延遲，無法獨立重算每輪 P95。",
    "fairness 未保存絕對單調起點；逐 PID 採樣檢查涵蓋整次非版本探測媒體程序，不能重建 fairness 單獨時間窗。",
    "observer 未保存 sampler 自身 close 旗標；獨立 sidecar 只補同一身分程序是否已退出，不能證明 Node close 事件已觀測。",
    "native 媒體 worker active 條件未保存原始計數；僅能核對取消回應、drain 與索引終態。",
    "首筆命中只保留 relPath/seq/media/rank，未保留 type/kind；影片 track／時間交集可複算，型別篩選依量測 runner 程式證據。",
    "sampler sidecar 的 parent PID 沒有由原報告或 NDJSON 直接記錄，程序與本次 run 的歸屬依外部採證紀錄。",
    "原始 report 自述的一般權限與量測 runner hash 是工作流程紀錄，不是外部獨立認證。",
  ] };
}

/** 外部唯讀 sidecar 是補充證據，不與產品媒體程序 close 混算。 */
export function verifySamplerSidecars(before, after) {
  const sampler = before?.sampler;
  const identity = after?.before;
  const observed = Date.parse(before?.observedUtc ?? "");
  const checked = Date.parse(after?.checkedUtc ?? "");
  if (!isId(before?.parent?.ProcessId) || !isId(sampler?.ProcessId) || typeof sampler.Name !== "string" || !Number.isFinite(Date.parse(sampler.CreationDate)) || !Number.isFinite(observed) || !Number.isFinite(checked) || checked < observed || identity?.ProcessId !== sampler.ProcessId || identity?.Name !== sampler.Name || identity?.CreationDate !== sampler.CreationDate || after?.queryStatus !== "ok" || typeof after.sameIdentityAlive !== "boolean") return { status: "not-proven", detail: "sidecar 缺失、查詢失敗或程序身分／時間不一致" };
  return after.sameIdentityAlive ? { status: "still-running", detail: "同一 sampler 身分仍存活" } : { status: "exited", detail: "查詢成功，原 PID 與建立時間的程序已不存在" };
}

async function main() {
  if (process.argv.length !== 3) throw new Error("用法：node scripts/video-performance-verifier.mjs <performance-run-directory>");
  const dir = path.resolve(process.argv[2]);
  const errors = [];
  async function read(name) {
    try { return await readFile(path.join(dir, name)); }
    catch (error) { errors.push(`${name} 無法讀取：${error?.code ?? "unknown"}`); return null; }
  }
  const reportBytes = await read("performance.json");
  const sampleBytes = await read("rss-samples.ndjson");
  let report = {}, samples = [];
  if (reportBytes) { try { report = JSON.parse(reportBytes.toString("utf8")); } catch { errors.push("performance.json 無法解析"); } }
  if (sampleBytes) {
    const text = sampleBytes.toString("utf8");
    if (text && !text.endsWith("\n")) errors.push("RSS NDJSON 最末行不完整");
    else { try { samples = text.split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line)); } catch { errors.push("RSS NDJSON 包含無法解析的行"); } }
  }
  const result = validatePerformance(report, samples);
  if (errors.length) { if (result.status !== "fail") result.status = "incomplete"; result.checks.unshift({ name: "原始輸入", status: "missing", detail: errors.join("；") }); }
  const sha = (bytes) => bytes === null ? null : createHash("sha256").update(bytes).digest("hex");
  const validatorBytes = await readFile(fileURLToPath(import.meta.url));
  let beforeBytes = null, afterBytes = null, before, after;
  try { beforeBytes = await readFile(path.join(dir, "sampler-identity-before.json")); before = JSON.parse(beforeBytes.toString("utf8")); } catch {}
  try { afterBytes = await readFile(path.join(dir, "sampler-identity-after.json")); after = JSON.parse(afterBytes.toString("utf8")); } catch {}
  const samplerHelper = { ...verifySamplerSidecars(before, after), beforeSha256: sha(beforeBytes), afterSha256: sha(afterBytes) };
  const output = { schemaVersion: 1, validatedAt: new Date().toISOString(), runId: report.runId ?? null, reportSha256: sha(reportBytes), samplesSha256: sha(sampleBytes), measurementRunnerSha256: Object.entries(report.sourceHashes ?? {}).find(([key]) => key.split(/[\\/]/).at(-1) === "run-performance.mjs")?.[1] ?? null, validatorSha256: sha(validatorBytes), samplerHelper, ...result, status: samplerHelper.status === "still-running" ? "fail" : result.status };
  await writeFile(path.join(dir, "validation.json"), JSON.stringify(output, null, 2) + "\n", { flag: "wx" });
  console.log(JSON.stringify({ runId: output.runId, status: output.status, samplerHelper: samplerHelper.status, validation: path.join(dir, "validation.json") }));
  if (output.status !== "pass") process.exitCode = 1;
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) main().catch((error) => { console.error(String(error?.message ?? error)); process.exitCode = 1; });
