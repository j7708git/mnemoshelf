// 單一指令重現 A–E：產圖 → q8 → q4 → dtype 比較。fp32 對照要另外跑（下載量大）。
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ASSET_OUT_DIR, RESULTS_DIR, SPIKE_ROOT } from "../lib/paths.mjs";
import { IMAGES } from "../lib/corpus-images.mjs";

const withFp32 = process.argv.includes("--with-fp32");

function step(title, args) {
  console.log(`\n===== ${title} =====`);
  const started = Date.now();
  const result = spawnSync(process.execPath, args, { cwd: SPIKE_ROOT, stdio: "inherit" });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (result.status !== 0) {
    console.error(`[run-all] 「${title}」失敗（exit ${result.status}），中止。`);
    process.exit(result.status ?? 1);
  }
  console.log(`[run-all] 「${title}」完成，耗時 ${seconds} s`);
}

if (!fs.existsSync(path.join(ASSET_OUT_DIR, IMAGES[0].file))) {
  step("產生測試圖片", [path.join("scripts", "make-assets.mjs")]);
}

step("q8（文字+圖片）", [path.join("scripts", "bench.mjs"), "--dtype", "q8", "--vision", "--label", "q8"]);
step("q4（文字+圖片）", [path.join("scripts", "bench.mjs"), "--dtype", "q4", "--vision", "--label", "q4"]);
if (withFp32) {
  step("fp32（文字；下載約 1.1 GB）", [path.join("scripts", "bench.mjs"), "--dtype", "fp32", "--text-only", "--label", "fp32"]);
}
step("dtype 比較", [
  path.join("scripts", "compare-dtypes.mjs"),
  "--baseline",
  fs.existsSync(path.join(RESULTS_DIR, "bench-fp32.json")) ? "fp32" : "q8",
]);

console.log("\n[run-all] 全部完成。結果在 spikes/embed-runtime/results/");
