/**
 * 真實模型端到端（手動執行）：
 *
 *   pnpm --filter @mnemoshelf/embedder-transformers run e2e
 *
 * 流程：載入模型（首次會下載，快取在 mnemoshelf/.tmp/models）→ 探測（probe）→
 * 量測文字／圖片單次延遲與 RSS → 輸出數字。
 *
 * 需要連網下載模型（q4 約 271 MB，暖快取後為 0 B）。
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { cpus } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TransformersEmbedder, createProbeImages } from "../src/index.js";

/** 由起始目錄往上找到含 pnpm-workspace.yaml 的 repo 根（不依賴檔案深度）。 */
function findRepoRoot(start: string): string {
  let dir = start;
  for (;;) {
    if (existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error("找不到 repo 根（pnpm-workspace.yaml）");
    dir = parent;
  }
}

/** mnemoshelf/ 根。 */
const REPO_ROOT = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));
const MODEL_CACHE_DIR = path.join(REPO_ROOT, ".tmp", "models");

function dirSizeBytes(dir: string): number {
  let total = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) {
        try {
          total += statSync(full).size;
        } catch {
          /* 忽略個別檔案的讀取錯誤 */
        }
      }
    }
  }
  return total;
}

const mib = (bytes: number): number => Number((bytes / 1024 / 1024).toFixed(1));
const ms = (value: number): number => Number(value.toFixed(1));

async function main(): Promise<void> {
  const embedder = new TransformersEmbedder({ cacheDir: MODEL_CACHE_DIR });

  const cacheBefore = dirSizeBytes(MODEL_CACHE_DIR);
  const meta = {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cpu: cpus()[0]?.model ?? "unknown",
    cpuThreads: cpus().length,
    embedderId: embedder.info.id,
    dim: embedder.info.dim,
    cacheDir: path.relative(REPO_ROOT, MODEL_CACHE_DIR).split(path.sep).join("/"),
    coldCache: cacheBefore === 0,
  };

  // ---- 載入（第一次呼叫觸發下載＋載入）----
  const loadStarted = performance.now();
  await embedder.embedQuery("warmup query");
  const loadMs = performance.now() - loadStarted;
  const cacheAfterLoad = dirSizeBytes(MODEL_CACHE_DIR);
  const rssAfterLoad = process.memoryUsage().rss;

  // ---- 文字延遲（暖機後量三次取中位數）----
  const textLatencies: number[] = [];
  for (let i = 0; i < 3; i += 1) {
    const started = performance.now();
    await embedder.embedQuery("how do I renew my passport?");
    textLatencies.push(performance.now() - started);
  }

  const docLatencies: number[] = [];
  for (let i = 0; i < 3; i += 1) {
    const started = performance.now();
    await embedder.embedDocument("Charged particles from the sun excite gases in the upper atmosphere.", "Aurora");
    docLatencies.push(performance.now() - started);
  }

  // ---- 圖片延遲（兩張合成測試圖，各量兩次取第二次）----
  const images = createProbeImages();
  const imageLatencies: Record<string, number[]> = {};
  for (const sample of images) {
    const runs: number[] = [];
    for (let i = 0; i < 2; i += 1) {
      const started = performance.now();
      await embedder.embedImage(sample.image);
      runs.push(performance.now() - started);
    }
    imageLatencies[sample.id] = runs.map(ms);
  }

  // ---- 探測 ----
  const probe = await embedder.probe();

  const rssAfter = process.memoryUsage().rss;
  const peakRssBytes = process.resourceUsage ? process.resourceUsage().maxRSS * 1024 : rssAfter; // Linux: KB

  const median = (values: number[]): number => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  };

  const report = {
    meta: {
      ...meta,
      downloadedBytes: Math.max(0, cacheAfterLoad - cacheBefore),
      downloadedMiB: mib(Math.max(0, cacheAfterLoad - cacheBefore)),
      cacheBytesAfterLoad: cacheAfterLoad,
    },
    loadMs: ms(loadMs),
    text: {
      queryMedianMs: ms(median(textLatencies)),
      queryRunsMs: textLatencies.map(ms),
      documentMedianMs: ms(median(docLatencies)),
      documentRunsMs: docLatencies.map(ms),
    },
    image: {
      budgets: imageLatencies,
    },
    memory: {
      rssAfterLoadMiB: mib(rssAfterLoad),
      rssAfterWorkloadMiB: mib(rssAfter),
      peakRssMiB: mib(peakRssBytes),
    },
    probe,
  };

  console.log(JSON.stringify(report, null, 2));
  await embedder.dispose();

  if (!probe.ok) {
    console.error(`[e2e] probe 失敗：${probe.message ?? "(無訊息)"}`);
    process.exitCode = 1;
  }
}

await main();
