import { describe, expect, it } from "vitest";
import {
  MRL_DIMENSIONS,
  l2Normalize,
  truncateAndNormalize,
} from "../src/vector.js";
import { UnsupportedDimensionError, VectorTruncationError } from "../src/errors.js";

function norm(vec: Float32Array): number {
  let sum = 0;
  for (const value of vec) sum += value * value;
  return Math.sqrt(sum);
}

/** 產生 768 維的確定性合成向量（未正規化，模長 != 1）。 */
function synthetic768(): Float32Array {
  const vec = new Float32Array(768);
  for (let i = 0; i < vec.length; i += 1) {
    vec[i] = Math.sin(i * 0.37) * 3 + 0.5;
  }
  return vec;
}

describe("l2Normalize", () => {
  it("回傳新的正規化向量，且不修改輸入", () => {
    const input = Float32Array.from([3, 0, 4]);
    const before = Array.from(input);
    const out = l2Normalize(input);

    expect(out).not.toBe(input);
    expect(Math.abs(norm(out) - 1)).toBeLessThan(1e-6);
    expect(Array.from(input)).toEqual(before); // 輸入未被修改
  });

  it("對非正規化輸入做縮放不變（方向相同的輸入得到相同單位向量）", () => {
    const base = Float32Array.from([1, 2, 3, -4]);
    const scaled = Float32Array.from(Array.from(base).map((v) => v * 7));
    expect(Array.from(l2Normalize(base))).toEqual(Array.from(l2Normalize(scaled)));
  });

  it("零向量：回傳複本且不產生 NaN／Infinity", () => {
    const out = l2Normalize(new Float32Array(8));
    expect(out.length).toBe(8);
    expect(Array.from(out).every((v) => v === 0)).toBe(true);
  });
});

describe("truncateAndNormalize", () => {
  it("截斷成 512／256／128 維後重新 L2 正規化，且保留前綴維度", () => {
    const vec = synthetic768();
    for (const dim of [512, 256, 128] as const) {
      const out = truncateAndNormalize(vec, dim);
      expect(out.length).toBe(dim);
      // 保留原始向量的前 dim 維（只是被縮放）。
      expect(out[0]).toBeCloseTo(vec[0] / norm(vec.subarray(0, dim)), 6);
      expect(out[dim - 1]).toBeCloseTo(vec[dim - 1] / norm(vec.subarray(0, dim)), 6);
      expect(Math.abs(norm(out) - 1)).toBeLessThan(1e-6);
    }
  });

  it("截斷後模長通常 ≠ 1，重新正規化後 = 1", () => {
    const vec = synthetic768();
    const truncated = vec.subarray(0, 512);
    // 這個合成向量的前 512 維模長明顯不是 1（證明截斷本身不保模長）。
    expect(Math.abs(norm(truncated) - 1)).toBeGreaterThan(1e-3);

    const out = truncateAndNormalize(vec, 512);
    expect(Math.abs(norm(out) - 1)).toBeLessThan(1e-6);
  });

  it("任何 MRL 維度都得到單位向量；非正規化輸入也一樣", () => {
    const vec = synthetic768();
    for (const dim of MRL_DIMENSIONS) {
      const out = truncateAndNormalize(vec, dim);
      expect(Math.abs(norm(out) - 1)).toBeLessThan(1e-6);
    }
  });

  it("不支援的維度拋出 UnsupportedDimensionError", () => {
    const vec = synthetic768();
    for (const dim of [0, 100, 384, 1024, 1.5]) {
      expect(() => truncateAndNormalize(vec, dim)).toThrow(UnsupportedDimensionError);
    }
  });

  it("維度大於向量長度時拋出 VectorTruncationError", () => {
    const vec = new Float32Array(100);
    expect(() => truncateAndNormalize(vec, 128)).toThrow(VectorTruncationError);
  });
});
