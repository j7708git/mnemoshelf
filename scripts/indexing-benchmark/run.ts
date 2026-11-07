import path from "node:path";
import { runBenchmark } from "./benchmark.ts";

const args = process.argv.slice(2);
function value(name: string, fallback: string): string { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1] ?? fallback; }
const mode = value("--mode", "accounting"); const profile = value("--profile", "smoke"); const device = value("--device", "cpu"); const scenario = value("--scenario", "full");
if (!["accounting", "real"].includes(mode) || !["smoke", "focus", "mixed"].includes(profile) || !["cpu", "dml", "auto"].includes(device) || !["full", "cancel-only"].includes(scenario)) throw new Error("mode/profile/device/scenario 無效");
try {
  const { report, file } = await runBenchmark({ mode: mode as "accounting" | "real", profile: profile as "smoke" | "focus" | "mixed", device: device as "cpu" | "dml" | "auto", scenario: scenario as "full" | "cancel-only", repetitions: Number(value("--repetitions", "3")), label: value("--label", mode), ...(args.includes("--indexer-module") ? { indexerModule: value("--indexer-module", "") } : {}), ...(args.includes("--worker-module") ? { workerModule: value("--worker-module", "") } : {}), ...(args.includes("--worker-entry-module") ? { workerEntryModule: value("--worker-entry-module", "") } : {}) });
  console.log(JSON.stringify({ report: path.relative(process.cwd(), file), corpusDigest: report.corpusDigest, trials: report.trials.map(({ quality, ...trial }) => trial) }, null, 2));
} catch (error) {
  // 原始模型／檔案錯誤可能含私人絕對路徑，只輸出短標籤。
  console.error(JSON.stringify({ error: error instanceof Error ? error.name : "error", message: "量測未完成；請檢查建置、快取與執行裝置。" })); process.exitCode = 1;
}
