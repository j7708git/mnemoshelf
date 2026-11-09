import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "../../packages/core/node_modules/vitest/dist/index.js";
import { createCorpus } from "./corpus.ts";
import { percentile, runBenchmark } from "./benchmark.ts";

const base = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("合成混合索引基準", () => {
  it("nearest-rank P95 保留未量測狀態", () => {
    expect(percentile([], .95)).toBeNull();
    expect(percentile(Array.from({ length: 20 }, (_, i) => i + 1), .95)).toBe(19);
    expect(() => percentile([1], 0)).toThrow(RangeError);
  });

  it("語料內容與 manifest 可重現，含全部模態與壞檔", async () => {
    await fs.mkdir(path.join(base, ".tmp"), { recursive: true });
    const directory = await fs.mkdtemp(path.join(base, ".tmp", "indexing-benchmark-test-"));
    const first = await createCorpus(directory, "smoke");
    const second = await createCorpus(directory, "smoke");
    expect(first).toEqual(second);
    expect(new Set(first.map((entry) => entry.kind))).toEqual(new Set(["text", "code", "image", "audio", "video", "bad-image", "binary-content", "unsupported-type"]));
    expect(first.find((entry) => entry.name === "duplicate-a.txt")?.sha256).toBe(first.find((entry) => entry.name === "duplicate-b.txt")?.sha256);
    expect((await fs.readFile(path.join(directory, "audio.wav"))).subarray(0, 4).toString()).toBe("RIFF");
    expect((await fs.readFile(path.join(directory, "video.avi"))).subarray(8, 12).toString()).toBe("AVI ");
  });

  it("真實 SQLite 可核對初建、未變、更動一檔、取消及恢復", async () => {
    const { report } = await runBenchmark({ mode: "accounting", profile: "smoke", repetitions: 1, label: "test" });
    const cold = report.trials.find((trial) => trial.temperature === "first-after-probe")!;
    expect(cold.phases[0]!.result?.failedFiles).toEqual([]);
    expect(cold.phases[0]!.firstSearchableMs.image).toBeTypeOf("number");
    expect(cold.phases[0]!.firstSearchableMs.audio).toBeNull();
    expect(cold.phases[0]!.firstSearchableMs.video).toBeNull();
    expect(cold.phases[1]!.counters.documents).toBe(0);
    // 壞圖每輪會再嘗試，不能把這個次數當成未變更的有效圖片重嵌。
    expect(cold.phases[1]!.result?.processed).toBe(0);
    expect(cold.phases[2]!.result?.processed).toBe(1);
    for (const trial of report.trials) for (const phase of trial.phases) {
      expect(phase.missingVectors).toBe(0); expect(phase.orphanVectors).toBe(0);
      expect(phase.vectors).toBe(phase.chunks);
      if (phase.result) expect(phase.result.processed + phase.result.skippedUnchanged + phase.result.skippedFiles.length + phase.result.failedFiles.length).toBe(phase.result.total);
    }
    const cancelled = report.trials.find((trial) => trial.temperature === "cancellation")!;
    expect(cancelled.phases[0]!.aborted).toBe(true);
    expect(cancelled.phases[1]!.chunks).toBe(cold.phases[0]!.chunks);
    for (const trial of report.trials) for (const phase of trial.phases) if (!phase.aborted) expect(phase.expectedKeysExact).toBe(true);

    const directory = await fs.mkdtemp(path.join(base, ".tmp", "indexing-benchmark-compare-"));
    const referenceFile = path.join(directory, "reference.json"); const invalidFile = path.join(directory, "invalid.json");
    await fs.writeFile(referenceFile, JSON.stringify(report));
    const invalid = structuredClone(report);
    for (const trial of invalid.trials) {
      trial.quality = [];
      trial.queryUnderIndex.errors = 1;
      for (const phase of trial.phases) if (phase.result) { phase.result.failedFiles.push({ relPath: "synthetic.md", reason: "error" }); phase.expectedKeysExact = false; }
    }
    await fs.writeFile(invalidFile, JSON.stringify(invalid));
    const { stdout } = await promisify(execFile)(process.execPath, ["--experimental-strip-types", path.join(base, "scripts", "indexing-benchmark", "compare.ts"), referenceFile, invalidFile]);
    const comparison = JSON.parse(stdout);
    expect(comparison.gates.accounting).toBe(false);
    expect(comparison.gates.quality).toBe(false);
    expect(comparison.performanceEligible).toBe(false);
    const valid = await promisify(execFile)(process.execPath, ["--experimental-strip-types", path.join(base, "scripts", "indexing-benchmark", "compare.ts"), referenceFile, referenceFile]);
    expect(JSON.parse(valid.stdout).gates.accounting).toBe(true);
    const missingCancel = structuredClone(report);
    missingCancel.trials = missingCancel.trials.filter((trial) => trial.temperature !== "cancellation");
    await fs.writeFile(invalidFile, JSON.stringify(missingCancel));
    const absent = await promisify(execFile)(process.execPath, ["--experimental-strip-types", path.join(base, "scripts", "indexing-benchmark", "compare.ts"), referenceFile, invalidFile]);
    expect(JSON.parse(absent.stdout).candidate.cancellationExact).toBe(false);
    const changedShared = structuredClone(report);
    changedShared.sourceHashes.find((item) => item.component === "embedder")!.sha256 = "changed";
    await fs.writeFile(invalidFile, JSON.stringify(changedShared));
    const mismatch = await promisify(execFile)(process.execPath, ["--experimental-strip-types", path.join(base, "scripts", "indexing-benchmark", "compare.ts"), referenceFile, invalidFile]);
    expect(JSON.parse(mismatch.stdout).sharedComponentsMatch).toBe(false);
    expect(JSON.parse(mismatch.stdout).performanceEligible).toBe(false);
  }, 30000);

  it("拒絕非法執行參數", async () => {
    await expect(runBenchmark({ mode: "accounting", profile: "smoke", repetitions: 0, label: "test" })).rejects.toThrow(RangeError);
    await expect(runBenchmark({ mode: "accounting", profile: "smoke", repetitions: 1, label: "../outside" })).rejects.toThrow(TypeError);
  });

  it("凍結原碼包含 scanner 與完整 proxy/worker 鏈，暫存模組可解析既有依賴", async () => {
    const { stdout } = await promisify(execFile)(process.execPath, ["--experimental-strip-types", path.join(base, "scripts", "indexing-benchmark", "freeze-baseline.ts"), "HEAD", `test-${Date.now()}`], { cwd: base });
    const result = JSON.parse(stdout) as { directory: string; commit: string; manifest: { component: string; sourceSha256: string; executableSha256: string }[] };
    expect(result.commit).toMatch(/^[a-f0-9]{40}$/);
    expect(result.manifest.map((entry) => entry.component)).toEqual(["indexer", "scan", "worker-embedder", "embedder-worker"]);
    for (const entry of result.manifest) { expect(entry.sourceSha256).toMatch(/^[a-f0-9]{64}$/); expect(entry.executableSha256).toMatch(/^[a-f0-9]{64}$/); }
    const indexer = await import(pathToFileURL(path.join(base, result.directory, "indexer.js")).href);
    expect(indexer.indexRoot).toBeTypeOf("function");
  }, 15000);
});
