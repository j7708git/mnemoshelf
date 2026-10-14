import { createHash } from "node:crypto";
import type {
  DocumentInput,
  Embedder,
  EmbedderInfo,
  EmbedDocumentsOptions,
  ImageInput,
  ProbeResult,
} from "../ports/embedder.js";

/** FakeEmbedder 的固定維度（與預設 embedder 的截斷維度一致）。 */
export const FAKE_EMBEDDER_DIM = 512;

/** 取消檢查（沿用 indexer 的 `throwIfAborted` 慣例）。 */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal === undefined) return;
  if (typeof signal.throwIfAborted === "function") {
    signal.throwIfAborted();
    return;
  }
  if (signal.aborted) {
    const reason = signal.reason;
    if (reason instanceof Error) throw reason;
    const error = new Error("嵌入已取消");
    error.name = "AbortError";
    throw error;
  }
}

/**
 * FakeEmbedder：**僅供測試，無語意（no semantics）**。
 *
 * 用輸入內容的 SHA-256 當種子產生確定性的偽隨機向量，再 L2 正規化。
 * 特性：不下載任何模型、不連網、同一輸入必得同一向量、不同輸入得不同向量。
 * 它**不具備任何語意**：相似的文字不會得到相近的向量，所以只能用來驗證介面、
 * 儲存與排序流程，不能拿來驗證檢索品質。
 */
export class FakeEmbedder implements Embedder {
  readonly info: EmbedderInfo = {
    id: "fake-embedder@test",
    dim: FAKE_EMBEDDER_DIM,
    capabilities: { text: true, image: true, audio: false, video: false },
  };

  async embedQuery(text: string): Promise<Float32Array> {
    return hashToVector(this.hash(`query:${text}`));
  }

  async embedDocument(text: string, title?: string): Promise<Float32Array> {
    return hashToVector(this.hash(`document:${title ?? "none"}:${text}`));
  }

  /**
   * 逐項委派 `embedDocument`，因此批次向量與單筆完全相同（順序對應）。
   * 只額外支援取消：開始前檢查一次 `signal`。
   */
  async embedDocuments(
    inputs: readonly DocumentInput[],
    opts?: EmbedDocumentsOptions,
  ): Promise<Float32Array[]> {
    throwIfAborted(opts?.signal);
    const vectors: Float32Array[] = [];
    for (const input of inputs) {
      vectors.push(await this.embedDocument(input.text, input.title));
    }
    return vectors;
  }

  async embedImage(image: ImageInput): Promise<Float32Array> {
    const digest = createHash("sha256").update("image:").update(image.bytes).digest();
    return hashToVector(digest);
  }

  /**
   * 只做結構性檢查（維度、有限值、正規化）。FakeEmbedder 沒有語意，
   * 因此不做「圖片與描述文字相似度」的語意檢查。
   */
  async probe(): Promise<ProbeResult> {
    const sample = await this.embedQuery("probe");
    if (sample.length !== this.info.dim) {
      return { ok: false, message: `維度不符：${sample.length} != ${this.info.dim}` };
    }
    for (const value of sample) {
      if (!Number.isFinite(value)) return { ok: false, message: "向量含非有限值" };
    }
    const norm = Math.sqrt(sample.reduce((sum, value) => sum + value * value, 0));
    if (Math.abs(norm - 1) > 1e-3) {
      return { ok: false, message: `向量未正規化（模長 ${norm.toFixed(6)}）` };
    }
    return { ok: true, message: "僅供測試的結構性探測通過（無語意）" };
  }

  async dispose(): Promise<void> {
    // 沒有需要釋放的資源。
  }

  private hash(input: string): Buffer {
    return createHash("sha256").update(input).digest();
  }
}

/** 以雜湊的前 4 個位元組當種子，產生確定性的單位向量。 */
function hashToVector(seed: Buffer): Float32Array {
  let state = (seed[0] | (seed[1] << 8) | (seed[2] << 16) | (seed[3] << 24)) >>> 0;

  const nextRandom = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const vec = new Float32Array(FAKE_EMBEDDER_DIM);
  let sumSquares = 0;
  for (let i = 0; i < vec.length; i += 1) {
    const value = nextRandom() * 2 - 1;
    vec[i] = value;
    sumSquares += value * value;
  }

  const norm = Math.sqrt(sumSquares);
  if (norm === 0) {
    vec[0] = 1;
    return vec;
  }
  for (let i = 0; i < vec.length; i += 1) {
    vec[i] = vec[i] / norm;
  }
  return vec;
}
