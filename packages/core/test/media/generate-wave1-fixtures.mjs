#!/usr/bin/env node
/**
 * 波次一（D1／D2）gated 測試 fixture 生成器（合成、固定參數；不依賴私人媒體）。
 *
 * 用法（Windows x64；需要 A1 已下載的 FFmpeg static 候選）：
 *   set MNEMOSHELF_FFMPEG_PATH=C:\path\to\ffmpeg.exe
 *   set MNEMOSHELF_FFPROBE_PATH=C:\path\to\ffprobe.exe
 *   node packages/core/test/media/generate-wave1-fixtures.mjs
 *
 * 預設輸出到 code repo 的 .tmp/wave1/fixtures（已忽略，不進版控）；
 * 可用 MNEMOSHELF_WAVE1_FIXTURES 指定其他目錄。
 * 生成後跑 gated 測試：
 *   pnpm --filter @mnemoshelf/core exec vitest run test/media/ffmpeg-decoder.wave1.gated.test.ts
 */
import { spawnSync } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const ffmpeg = process.env.MNEMOSHELF_FFMPEG_PATH ?? "";
const ffprobe = process.env.MNEMOSHELF_FFPROBE_PATH ?? "";
const fixtureDir = process.env.MNEMOSHELF_WAVE1_FIXTURES ?? path.join(repoRoot, ".tmp/wave1/fixtures");

if (ffmpeg.length === 0 || ffprobe.length === 0 || !existsSync(ffmpeg) || !existsSync(ffprobe)) {
  console.error("缺少 MNEMOSHELF_FFMPEG_PATH／MNEMOSHELF_FFPROBE_PATH（需指向既有候選執行檔）");
  process.exit(2);
}

function run(args, label) {
  const result = spawnSync(ffmpeg, ["-y", "-v", "error", ...args], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) {
    console.error("生成失敗：" + label + "\n" + (result.stderr ?? ""));
    process.exit(1);
  }
}

await fs.mkdir(fixtureDir, { recursive: true });

// D1：短尾段（0.2／4.2／4.8／8.2 秒）；4.8 秒是對照組。
for (const duration of ["0.2", "4.2", "4.8", "8.2"]) {
  run(["-f", "lavfi", "-i", "color=c=red:s=64x64:r=30:d=" + duration, "-c:v", "libopenh264", path.join(fixtureDir, "tail-" + duration + ".mp4")], "tail-" + duration);
}

// D1 回歸（lead P1 複驗）：尾段內含中點格點的正常影片（6.2／7.9／10.2 秒的 6.0／10.0 格點；
// 12.2／16.2 為尾段不含格點的對照；3.9 秒是單一尾段）。30 fps、64x64、純色。
for (const duration of ["3.9", "6.2", "7.9", "10.2", "12.2", "16.2"]) {
  run(["-f", "lavfi", "-i", "color=c=red:s=64x64:r=30:d=" + duration, "-c:v", "libopenh264", path.join(fixtureDir, "tail-grid-" + duration + ".mp4")], "tail-grid-" + duration);
}

// D1 回歸：599 秒（mod 4 = 3；尾段 [596,599) 內含 598 格點）長片；小尺寸以控制時間。
run(["-f", "lavfi", "-i", "color=c=red:s=64x64:r=15:d=599", "-c:v", "libopenh264", path.join(fixtureDir, "long-599s-grid.mp4")], "long-599s-grid");
// D1：稀疏幀（0／5／10 秒有幀；每段走 fallback 取段內最後一幀）
run(["-f", "lavfi", "-i", "testsrc2=size=64x64:rate=25:duration=12", "-vf", "select='not(mod(n\\,125))'", "-fps_mode", "vfr", "-c:v", "libopenh264", path.join(fixtureDir, "sparse-12s.mp4")], "sparse-12s");

// D1：時間線缺口（0／1／12 秒有幀；segment 1 完全沒有幀 → unsupported-video-timeline）
run(["-f", "lavfi", "-i", "testsrc2=size=64x64:rate=25:duration=13", "-vf", "select='not(mod(n\\,300))+lt(n\\,2)'", "-fps_mode", "vfr", "-c:v", "libopenh264", path.join(fixtureDir, "sparse-gap-13s.mp4")], "sparse-gap-13s");

// D2：12 秒畫面＋11.8 秒 AAC（音軌比容器短）
run(["-f", "lavfi", "-i", "color=c=red:s=64x64:r=30:d=12", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=11.8", "-c:v", "libopenh264", "-c:a", "aac", path.join(fixtureDir, "video12-audio11.8.mp4")], "video12-audio11.8");

// D2：音軌延遲 2 秒（12 秒畫面＋10 秒音訊，leading offset 約 1.98 秒）
run(["-f", "lavfi", "-i", "testsrc2=size=64x64:rate=25:duration=12", "-itsoffset", "2", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=10", "-map", "0:v:0", "-map", "1:a:0", "-c:v", "libopenh264", "-c:a", "aac", "-shortest", path.join(fixtureDir, "audio-offset-2s.mp4")], "audio-offset-2s");

// D1：edit list／-ss copy 重包（4 秒 → 2 秒；時間軸應仍是播放時間軸 0-based）
run(["-ss", "1", "-i", path.join(fixtureDir, "tail-4.8.mp4"), "-t", "2", "-c", "copy", path.join(fixtureDir, "editlist-2s.mp4")], "editlist-2s");

// 只保留本生成器負責的檔名；其他 fixture（例如 A1 的）不動。
const names = (await fs.readdir(fixtureDir)).sort();
console.log("wave1 fixtures -> " + fixtureDir);
console.log(names.join("\n"));