import { describe, expect, it } from "vitest";
import type { ImageInput } from "@mnemoshelf/core";
import { PROBE_MARGIN_THRESHOLD, createProbeImages, runProbe } from "../src/index.js";

const DIM = 4;

function basis(index: number): Float32Array {
  const vec = new Float32Array(DIM);
  vec[index] = 1;
  return vec;
}

describe("createProbeImages（程式生成，不需模型）", () => {
  it("產生兩張非空、格式為 PNG 的圖片，各附英文與繁中描述", () => {
    const images = createProbeImages(64);
    expect(images.length).toBe(2);

    const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    for (const sample of images) {
      expect(sample.image.bytes.length).toBeGreaterThan(0);
      expect(Array.from(sample.image.bytes.subarray(0, 8))).toEqual(pngSignature);
      expect(sample.image.mimeType).toBe("image/png");
      expect(sample.descriptions.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("兩張圖的位元組不同", () => {
    const [a, b] = createProbeImages(64);
    expect(Array.from(a.image.bytes)).not.toEqual(Array.from(b.image.bytes));
  });
});

describe("runProbe（以確定性樁向量驗證邏輯，不需模型）", () => {
  const images = createProbeImages(64);
  const [first, second] = images;

  /** 讓每張圖與它的描述落在不同的正交方向：語意邊界充足。 */
  function separatedStub() {
    return {
      embedImage: async (image: ImageInput): Promise<Float32Array> =>
        image.bytes === first.image.bytes ? basis(0) : basis(1),
      embedText: async (text: string): Promise<Float32Array> => {
        if (first.descriptions.includes(text)) return basis(0);
        if (second.descriptions.includes(text)) return basis(1);
        return basis(2);
      },
    };
  }

  it("語意邊界充足時通過", async () => {
    const result = await runProbe({ dim: DIM, ...separatedStub(), images });
    expect(result.ok).toBe(true);
    expect(result.message).toContain("最小邊界");
  });

  it("語意邊界不足時失敗（含門檻數值）", async () => {
    const result = await runProbe({
      dim: DIM,
      images,
      embedImage: async () => basis(0),
      embedText: async () => basis(0),
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain(String(PROBE_MARGIN_THRESHOLD));
  });

  it("維度不符時失敗", async () => {
    const result = await runProbe({
      dim: DIM,
      images,
      embedImage: async () => new Float32Array(DIM + 1),
      embedText: async () => basis(0),
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("維度不符");
  });

  it("向量含 NaN 時失敗", async () => {
    const nan = basis(0);
    nan[0] = Number.NaN;
    const result = await runProbe({
      dim: DIM,
      images,
      embedImage: async () => nan,
      embedText: async () => basis(0),
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("非有限值");
  });
});
