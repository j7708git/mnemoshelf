import { AutoTokenizer, env as modelEnv } from "@huggingface/transformers";
import type { Embedder } from "@mnemoshelf/core";
import { DEFAULT_MODEL_ID, TransformersEmbedder } from "@mnemoshelf/embedder-transformers";
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
export const OUTPUT = path.join(REPO, ".tmp", "raw-memory-baseline");
const CACHE = path.resolve(process.env.RAW_MEMORY_MODEL_CACHE ?? path.join(REPO, ".tmp", "speed-diagnosis", "models"));
export const TOKEN_BUDGETS = [192, 384, 768];
export const NOW = new Date("2026-11-06T00:00:00Z");

export function chars(text: string): number {
  return Array.from(text).length;
}

export function bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

export function quantiles(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (ratio: number) => sorted[Math.ceil(sorted.length * ratio) - 1] ?? null;
  return { p50: percentile(0.5), p95: percentile(0.95) };
}

function keywordOnly(): Embedder {
  const unused = async (): Promise<never> => {
    throw new Error("關鍵字對照不得呼叫模型");
  };
  return {
    info: { id: "eval-keyword-only", dim: 512, capabilities: { text: true, image: true, audio: false, video: false } },
    embedQuery: unused, embedDocument: unused, embedDocuments: unused, embedImage: unused,
    probe: unused, dispose: async () => {},
  };
}

export async function backend() {
  const mode = process.env.RAW_MEMORY_BACKEND ?? "keyword";
  if (mode !== "keyword" && mode !== "real") throw new Error("RAW_MEMORY_BACKEND 必須是 keyword 或 real");

  // Transformers 4.3.1 在快取缺檔時拒絕遠端模型請求。另在 CPU 明示模式避免落地裝置探測資料。
  modelEnv.allowRemoteModels = false;
  modelEnv.cacheDir = CACHE;
  const tokenizerPath = path.join(CACHE, ...DEFAULT_MODEL_ID.split("/"), "tokenizer.json");
  const hasTokenizer = await access(tokenizerPath).then(() => true, () => false);
  const tokenizer = hasTokenizer
    ? await AutoTokenizer.from_pretrained(DEFAULT_MODEL_ID, { local_files_only: true })
    : null;
  const tokens = tokenizer === null
    ? null
    : (value: string) => value === "" ? 0 : tokenizer.encode(value, { add_special_tokens: false }).length;
  if (mode === "keyword") return { mode, embedder: keywordOnly(), tokens, firstQueryMs: null };
  if (tokens === null) throw new Error("離線模型快取缺 tokenizer，請提供已有的 RAW_MEMORY_MODEL_CACHE");

  const embedder = new TransformersEmbedder({ cacheDir: CACHE, device: "cpu" });
  const started = performance.now();
  try {
    await embedder.embedQuery("測試室的維護手冊說了什麼？");
  } catch (error) {
    await embedder.dispose();
    throw error;
  }
  return { mode, embedder, tokens, firstQueryMs: performance.now() - started };
}

export type Backend = Awaited<ReturnType<typeof backend>>;
