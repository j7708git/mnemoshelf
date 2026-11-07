import { promises as fs } from "node:fs";
import { percentile } from "./benchmark.ts";

interface Phase { phase: string; durationMs: number; chunks: number; vectors: number; missingVectors: number; orphanVectors: number; expectedChunks: number; expectedKeysExact: boolean; aborted: boolean; result: { total: number; processed: number; skippedUnchanged: number; skippedFiles: unknown[]; failedFiles: unknown[] } | null; counters: { documents: number } }
interface Trial { trial: number; temperature: string; indexConcurrency?: number; embedder: { id: string; dim: number }; runtime?: { device: string }; phases: Phase[]; peakRssBytes: number; queryUnderIndex: { errors: number; observations: { phase: string; durationMs: number }[] }; quality: { key: string; vec: number[] }[] }
interface Report { options: { mode: string; profile: string; repetitions: number }; sourceHashes: { component: string; sha256: string }[]; environment: { platform: string; arch: string; node: string }; corpusDigest: string; trials: Trial[] }

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function metric(report: Report) {
  const warm = report.trials.filter((trial) => trial.temperature === "warm");
  return {
    warmMedianMs: median(warm.map((trial) => trial.phases.find((phase) => phase.phase === "first-build")!.durationMs)),
    warmLowerNearestRank50Ms: percentile(warm.map((trial) => trial.phases.find((phase) => phase.phase === "first-build")!.durationMs), .5),
    queryP95Ms: percentile(warm.flatMap((trial) => trial.queryUnderIndex.observations.filter((sample) => sample.phase === "first-build").map((sample) => sample.durationMs)), .95),
    querySamples: warm.reduce((total, trial) => total + trial.queryUnderIndex.observations.filter((sample) => sample.phase === "first-build").length, 0),
    peakRssBytes: Math.max(...report.trials.map((trial) => trial.peakRssBytes)),
    accountingExact: report.trials.every((trial) => trial.phases.every((phase) => phase.missingVectors === 0 && phase.orphanVectors === 0 && phase.chunks === phase.vectors && (!phase.result || phase.result.total === phase.result.processed + phase.result.skippedUnchanged + phase.result.skippedFiles.length + phase.result.failedFiles.length))),
    noFailures: report.trials.every((trial) => trial.queryUnderIndex.errors === 0 && trial.phases.every((phase) => !phase.result || phase.result.failedFiles.length === 0)),
    expectedCorpusExact: report.trials.every((trial) => trial.quality.length > 0 && trial.phases.every((phase) => phase.aborted || (phase.expectedKeysExact && phase.expectedChunks === phase.chunks && phase.chunks > 0))),
    unchangedExact: warm.every((trial) => { const phase = trial.phases.find((p) => p.phase === "unchanged")!; return phase.result?.processed === 0 && phase.counters.documents === 0; }),
    partialExact: warm.every((trial) => trial.phases.find((p) => p.phase === "partial-edit")?.result?.processed === 1),
    cancellationExact: report.trials.filter((trial) => trial.temperature === "cancellation").length === 1 && report.trials.filter((trial) => trial.temperature === "cancellation").every((trial) => trial.indexConcurrency === 1 && trial.phases.length === 2 && trial.phases[0]?.phase === "cancel" && trial.phases[0]?.aborted && trial.phases[1]?.phase === "cancel-rerun" && !trial.phases[1]?.aborted && trial.phases[1]?.chunks === warm[0]?.phases[0]?.chunks),
  };
}

const [baselineFile, candidateFile, outputFile] = process.argv.slice(2);
if (!baselineFile || !candidateFile) throw new Error("用法：compare.ts baseline.json candidate.json [output.json]");
const baseline: Report = JSON.parse(await fs.readFile(baselineFile, "utf8"));
const candidate: Report = JSON.parse(await fs.readFile(candidateFile, "utf8"));
if (baseline.corpusDigest !== candidate.corpusDigest || baseline.options.mode !== candidate.options.mode || baseline.options.profile !== candidate.options.profile) throw new Error("語料或模式不相符，不可比較");
const b = metric(baseline); const c = metric(candidate);
let minCosine = 1; let keysExact = true;
for (let i = 0; i < candidate.trials.length; i += 1) {
  const reference = new Map((baseline.trials[i]?.quality ?? []).map((item) => [item.key, item.vec]));
  const actual = candidate.trials[i]!.quality;
  if (reference.size === 0 || actual.length === 0 || reference.size !== actual.length) keysExact = false;
  for (const { key, vec } of actual) {
    const old = reference.get(key);
    if (!old || old.length !== vec.length || vec.length === 0 || !vec.every(Number.isFinite)) { keysExact = false; continue; }
    const dot = vec.reduce((sum, value, j) => sum + value * old[j]!, 0);
    const norm = Math.sqrt(vec.reduce((sum, value) => sum + value * value, 0) * old.reduce((sum, value) => sum + value * value, 0));
    const cosine = dot / norm;
    if (!Number.isFinite(cosine)) keysExact = false;
    else minCosine = Math.min(minCosine, cosine);
  }
}
const runtimeIdentity = (trial: Trial): string => JSON.stringify([trial.embedder?.id, trial.embedder?.dim, trial.runtime?.device]);
const runtimeMatches = new Set([...baseline.trials, ...candidate.trials].map(runtimeIdentity)).size === 1;
const environmentMatches = JSON.stringify(baseline.environment) === JSON.stringify(candidate.environment);
const sharedComponentsMatch = ["embedder", "chunk-text", "sqlite-metadata", "sqlite-vector"].every((component) => {
  const before = baseline.sourceHashes.find((item) => item.component === component)?.sha256;
  const after = candidate.sourceHashes.find((item) => item.component === component)?.sha256;
  return typeof before === "string" && before === after;
});
const actualRunsEnough = [baseline, candidate].every((report) => ["first-after-probe", "warm"].every((temperature) => new Set(report.trials.filter((trial) => trial.temperature === temperature).map((trial) => trial.trial)).size >= 3));
const performanceEligible = baseline.options.mode === "real" && actualRunsEnough && b.querySamples >= 20 && c.querySamples >= 20 && runtimeMatches && environmentMatches && sharedComponentsMatch && b.noFailures && c.noFailures && b.expectedCorpusExact && c.expectedCorpusExact;
const comparison = {
  baseline: b, candidate: c, quality: { keysExact, minCosine },
  performanceEligible,
  runtimeMatches,
  environmentMatches,
  sharedComponentsMatch,
  actualRunsEnough,
  medianDefinition: "偶數樣本取中央兩值平均；保留 warmLowerNearestRank50Ms 供核對。此定義在候選比較前修正，兩組相同。",
  frozenThresholds: { queryP95RatioMaximum: .75, warmMedianRatioMaximum: 1.10, rssRatioMaximum: 1.20, rssAllowanceBytes: 256 * 1024 ** 2, minCosine: .999, minimumQuerySamples: 20 },
  gates: {
    accounting: [b, c].every((m) => m.accountingExact && m.noFailures && m.expectedCorpusExact && m.unchangedExact && m.partialExact && m.cancellationExact),
    quality: keysExact && minCosine >= .999 && runtimeMatches,
    queryP95: performanceEligible ? c.queryP95Ms! <= b.queryP95Ms! * .75 : null,
    totalTime: performanceEligible ? c.warmMedianMs <= b.warmMedianMs * 1.10 : null,
    rss: performanceEligible ? c.peakRssBytes <= b.peakRssBytes * 1.20 + 256 * 1024 ** 2 : null,
  },
};
if (outputFile) await fs.writeFile(outputFile, JSON.stringify(comparison, null, 2));
console.log(JSON.stringify(comparison, null, 2));
