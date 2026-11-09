#!/usr/bin/env node
/** 波次二合成 CFR 夾具；預設只產生短片，MNEMOSHELF_SLOW_GATED=1 加長片。 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const out = path.join(repo, ".tmp", "wave2", "fixtures");
const ffmpeg = process.env.MNEMOSHELF_FFMPEG_PATH ?? "";
if (!existsSync(ffmpeg)) throw new Error("請設定 MNEMOSHELF_FFMPEG_PATH");
mkdirSync(out, { recursive: true });
const rates = ["30000-1001", "24000-1001", "24", "25", "30", "50", "60"];
const cases = rates.map((rate) => [rate, "8"]);
cases.push(["30000-1001", "12"], ["30000-1001", "60"], ...["0.2", "4.2", "8.2"].map((duration) => ["30", duration]));
if (process.env.MNEMOSHELF_SLOW_GATED === "1") cases.push(...rates.map((rate) => [rate, "367"]), ["30", "599"], ["30", "600"]);
for (const [rate, duration] of cases) {
  const target = path.join(out, `${rate}-${duration}.mp4`);
  const sourceRate = rate.replace("-", "/");
  const source = rate === "30000-1001" && duration === "367"
    ? `testsrc2=s=64x64:r=${sourceRate}:d=${duration}`
    : `color=c=red:s=64x64:r=${sourceRate}:d=${duration}`;
  const result = spawnSync(ffmpeg, ["-y", "-v", "error", "-f", "lavfi", "-i", source, "-c:v", "libopenh264", target], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(`生成 ${rate}/${duration} 失敗：${result.stderr}`);
  console.log(`${rate} ${duration} 秒完成`);
}
