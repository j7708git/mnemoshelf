/**
 * 真實模型批次量測（閘控）：單筆 vs 批次的每塊平均延遲對照。
 *
 *   MNEMOSHELF_E2E=1 pnpm --filter @mnemoshelf/embedder-transformers test
 *
 * 未設 `MNEMOSHELF_E2E=1` 時整個 suite 標為 skip：不下載模型、不連網。
 * 語料為合成文字（600–1200 字元，貼近 indexer 的 chunk 大小），不含任何個人資訊。
 */
import { existsSync } from "node:fs";
import { loadavg } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MAX_BATCH_SIZE, TransformersEmbedder } from "../src/index.js";

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

const REPO_ROOT = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));
const MODEL_CACHE_DIR = path.join(REPO_ROOT, ".tmp", "models");

const E2E_ENABLED = process.env.MNEMOSHELF_E2E === "1";

/** 兩向量的餘弦（皆已 L2 正規化，故等於內積）。 */
function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) dot += a[i]! * b[i]!;
  return dot;
}

/** 合成語料：`count` 段、每段約 `targetChars` 字元（合成內容，不含個資）。 */
function makeCorpus(count: number, targetChars: number): { text: string; title: string }[] {
  // 混合中英文，讓 token 數接近真實 chunk（600–1200 字元 ≈ 150–300 token）。
  const base =
    "Index throughput batch measurement corpus: this synthetic passage is generated only to compare " +
    "single-call and batch latency, and it contains no personal information whatsoever. " +
    "索引吞吐量的批次量測語料：這段合成文字只用來比較單筆與批次的延遲，不含任何個人資訊。";
  return Array.from({ length: count }, (_, i) => {
    const repeated = base.repeat(Math.ceil(targetChars / base.length));
    return { text: `${repeated.slice(0, targetChars)}（第 ${i} 段）`, title: `corpus/doc-${i}.md` };
  });
}

/** 對整份語料逐塊呼叫 `embedDocument`，回傳總耗時（ms）。 */
async function measureSingle(
  embedder: TransformersEmbedder,
  corpus: { text: string; title: string }[],
): Promise<{ ms: number; vectors: Float32Array[] }> {
  const started = performance.now();
  const vectors: Float32Array[] = [];
  for (const doc of corpus) {
    vectors.push(await embedder.embedDocument(doc.text, doc.title));
  }
  return { ms: performance.now() - started, vectors };
}

/** 對整份語料一次呼叫 `embedDocuments`，回傳總耗時（ms）。 */
async function measureBatch(
  embedder: TransformersEmbedder,
  corpus: { text: string; title: string }[],
): Promise<{ ms: number; vectors: Float32Array[] }> {
  const started = performance.now();
  const vectors = await embedder.embedDocuments(corpus);
  return { ms: performance.now() - started, vectors };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

describe.skipIf(!E2E_ENABLED)("真實模型批次量測（需設 MNEMOSHELF_E2E=1；會下載模型）", () => {
  it("單筆 vs 批次的每塊平均延遲（批次大小掃描、交錯多輪取中位數），並驗證向量一致性（餘弦 ≥ 0.999）", async () => {
    const embedder = new TransformersEmbedder({ cacheDir: MODEL_CACHE_DIR });

    // 暖機（載入模型）。
    await embedder.embedQuery("warmup");

    const sizes = [4, 8, MAX_BATCH_SIZE];
    const rounds = 2;
    const rows: {
      batchSize: number;
      singlePerChunkMs: number;
      batchPerChunkMs: number;
      speedup: number;
    }[] = [];
    let minCosine = 1;
    let vectorCountOk = true;

    for (const size of sizes) {
      const corpus = makeCorpus(size, 900);
      const singleMs: number[] = [];
      const batchMs: number[] = [];
      const record = (
        single: { vectors: Float32Array[] },
        batch: { vectors: Float32Array[] },
      ): void => {
        if (!(single.vectors.length === size && batch.vectors.length === size)) vectorCountOk = false;
        for (let i = 0; i < size; i += 1) {
          minCosine = Math.min(minCosine, cosine(single.vectors[i]!, batch.vectors[i]!));
        }
      };
      // 交錯量測：奇偶輪對調單筆／批次順序，降低這台機器的高量測雜訊。
      for (let round = 0; round < rounds; round += 1) {
        if (round % 2 === 0) {
          const single = await measureSingle(embedder, corpus);
          const batch = await measureBatch(embedder, corpus);
          singleMs.push(single.ms);
          batchMs.push(batch.ms);
          record(single, batch);
        } else {
          const batch = await measureBatch(embedder, corpus);
          const single = await measureSingle(embedder, corpus);
          singleMs.push(single.ms);
          batchMs.push(batch.ms);
          record(single, batch);
        }
      }

      const singleMedian = median(singleMs);
      const batchMedian = median(batchMs);
      rows.push({
        batchSize: size,
        singlePerChunkMs: Number((singleMedian / size).toFixed(1)),
        batchPerChunkMs: Number((batchMedian / size).toFixed(1)),
        speedup: Number((singleMedian / batchMedian).toFixed(2)),
      });
    }

    const report = {
      dtype: "q4（預設）",
      dim: embedder.info.dim,
      charsPerChunk: 900,
      maxBatchSize: MAX_BATCH_SIZE,
      rounds,
      loadavg: loadavg().map((v) => Number(v.toFixed(2))),
      rows,
      minCosine: Number(minCosine.toFixed(6)),
    };
    console.log("[batch-e2e] 單筆 vs 批次（每塊 ms）：", JSON.stringify(report));

    expect(rows).toHaveLength(sizes.length);
    expect(vectorCountOk).toBe(true);
    // 批次與單筆的向量語意必須一致。
    expect(minCosine).toBeGreaterThanOrEqual(0.999);

    await embedder.dispose();
  });

  it("超過批次上限時內部切窗，數量仍與輸入一致", async () => {
    const embedder = new TransformersEmbedder({ cacheDir: MODEL_CACHE_DIR });
    const corpus = makeCorpus(MAX_BATCH_SIZE + 4, 600);

    const vectors = await embedder.embedDocuments(corpus);
    expect(vectors).toHaveLength(corpus.length);
    for (const vec of vectors) {
      expect(vec.length).toBe(embedder.info.dim);
      let sum = 0;
      for (const value of vec) sum += value * value;
      expect(Math.abs(Math.sqrt(sum) - 1)).toBeLessThan(1e-3);
    }

    await embedder.dispose();
  });
});
