#!/usr/bin/env node
/**
 * Stage 2 混合目錄格式統計 CLI（唯讀、只輸出匿名統計）。
 *
 * 用法（先於 repo 執行 `pnpm build`）：
 *   node scripts/format-stats.mjs --dir <PATH> [--label <NAME>] [--probe-media]
 *     [--probe-headers] [--ffprobe <PATH>] [--no-gitignore] [--out <DIR>]
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectFormatStats, formatStatsMarkdown } from "../packages/core/dist/index.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function findFfprobe(explicit) {
  if (explicit) return explicit;
  for (const candidate of ["/opt/homebrew/bin/ffprobe", "/usr/local/bin/ffprobe", "/usr/bin/ffprobe"]) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // 繼續找下一個
    }
  }
  return undefined;
}

function parseArgs(argv) {
  const opts = {
    dir: null,
    label: "mixed-corpus",
    probeMedia: false,
    probeHeaders: false,
    ffprobe: undefined,
    respectGitignore: true,
    outDir: path.join(REPO_ROOT, ".tmp", "format-stats"),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") continue;
    if (arg === "--dir") opts.dir = path.resolve(argv[++i]);
    else if (arg.startsWith("--dir=")) opts.dir = path.resolve(arg.slice("--dir=".length));
    else if (arg === "--label") opts.label = argv[++i];
    else if (arg.startsWith("--label=")) opts.label = arg.slice("--label=".length);
    else if (arg === "--probe-media") opts.probeMedia = true;
    else if (arg === "--probe-headers") opts.probeHeaders = true;
    else if (arg === "--ffprobe") opts.ffprobe = argv[++i];
    else if (arg.startsWith("--ffprobe=")) opts.ffprobe = arg.slice("--ffprobe=".length);
    else if (arg === "--no-gitignore") opts.respectGitignore = false;
    else if (arg === "--out") opts.outDir = path.resolve(argv[++i]);
    else if (arg.startsWith("--out=")) opts.outDir = path.resolve(arg.slice("--out=".length));
    else if (arg === "--help" || arg === "-h") {
      console.log(
        "用法：node scripts/format-stats.mjs --dir <PATH> [--label <NAME>] [--probe-media] [--probe-headers] [--ffprobe <PATH>] [--no-gitignore] [--out <DIR>]",
      );
      process.exit(0);
    } else {
      throw new Error(`未知參數：${arg}`);
    }
  }
  if (!opts.dir) throw new Error("必須提供 --dir <PATH>");
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
const ffprobePath = opts.probeMedia ? await findFfprobe(opts.ffprobe) : undefined;
if (opts.probeMedia && !ffprobePath) {
  throw new Error("啟用 --probe-media 但找不到 ffprobe，請以 --ffprobe 指定路徑");
}

const report = await collectFormatStats(
  {
    label: opts.label,
    path: opts.dir,
    respectGitignore: opts.respectGitignore,
  },
  {
    probeUnknownHeaders: opts.probeHeaders,
    ...(ffprobePath ? { ffprobePath } : {}),
  },
);

const markdown = formatStatsMarkdown(report);
await fs.mkdir(opts.outDir, { recursive: true });
const safeLabel = opts.label.replace(/[^a-zA-Z0-9._-]+/g, "-");
const jsonPath = path.join(opts.outDir, `${safeLabel}.json`);
const mdPath = path.join(opts.outDir, `${safeLabel}.md`);
await fs.writeFile(jsonPath, JSON.stringify(report, null, 2) + "\n", "utf8");
await fs.writeFile(mdPath, markdown, "utf8");

console.log(markdown);
console.log(`JSON: ${path.relative(REPO_ROOT, jsonPath)}`);
console.log(`Markdown: ${path.relative(REPO_ROOT, mdPath)}`);
