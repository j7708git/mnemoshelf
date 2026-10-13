/**
 * 向量後處理：Matryoshka 截斷＋重新 L2 正規化。
 *
 * 契約（docs/embedder-contract.md）：截斷後的向量**必須**重新 L2 正規化，
 * 否則餘弦相似度的排序會靜默劣化。截斷與正規化是保序的線性操作，但截斷本身
 * 不保持模長 1。
 *
 * 本檔為純函式，不依賴模型，可獨立單元測試。
 */
import { UnsupportedDimensionError, VectorTruncationError } from "./errors.js";

/** 模型支援的 MRL 截斷維度（官方模型卡：128、256、512、768）。 */
export const MRL_DIMENSIONS = [128, 256, 512, 768] as const;

/** MRL 截斷維度。 */
export type MrlDimension = (typeof MRL_DIMENSIONS)[number];

/** 斷言 `dim` 是支援的 MRL 維度。 */
export function assertMrlDimension(dim: number): asserts dim is MrlDimension {
  if (!(MRL_DIMENSIONS as readonly number[]).includes(dim)) {
    throw new UnsupportedDimensionError(dim, MRL_DIMENSIONS);
  }
}

/**
 * L2 正規化，回傳**新**的 `Float32Array`（不修改輸入）。
 *
 * 若模長為 0 或非有限值（退化輸入），回傳輸入的複本而不做縮放——
 * 呼叫端可據此偵測異常向量；正常模型輸出不會走到這條路徑。
 */
export function l2Normalize(vector: Float32Array): Float32Array {
  const out = new Float32Array(vector.length);
  let sum = 0;
  for (let i = 0; i < vector.length; i += 1) {
    sum += vector[i] * vector[i];
  }
  const norm = Math.sqrt(sum);
  if (!Number.isFinite(norm) || norm === 0) {
    out.set(vector);
    return out;
  }
  for (let i = 0; i < vector.length; i += 1) {
    out[i] = vector[i] / norm;
  }
  return out;
}

/**
 * 取前 `dim` 維後重新 L2 正規化（契約要求的截斷流程）。
 *
 * @throws {UnsupportedDimensionError} `dim` 不是支援的 MRL 維度。
 * @throws {VectorTruncationError} `dim` 大於向量現有長度。
 */
export function truncateAndNormalize(vector: Float32Array, dim: number): Float32Array {
  assertMrlDimension(dim);
  if (dim > vector.length) {
    throw new VectorTruncationError(dim, vector.length);
  }
  return l2Normalize(vector.subarray(0, dim));
}
