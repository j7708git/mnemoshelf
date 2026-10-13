import { describe, expect, it } from "vitest";
import {
  DEFAULT_DIM,
  DEFAULT_MAX_SOFT_TOKENS,
  TransformersEmbedder,
  UnsupportedDimensionError,
  UnsupportedDtypeError,
  InvalidEmbedderOptionError,
} from "../src/index.js";

// 以下測試只碰建構子與 info，不載入模型、不連網。
describe("TransformersEmbedder 建構子（不下載模型）", () => {
  it("info 在載入模型前即可同步讀取，預設 id／dim／capabilities 正確", () => {
    const embedder = new TransformersEmbedder();
    expect(embedder.info.id).toBe("embeddinggemma-2@onnx-q4");
    expect(embedder.info.dim).toBe(DEFAULT_DIM);
    expect(embedder.info.capabilities).toEqual({ text: true, image: true, audio: false, video: false });
  });

  it("dtype 會進 info.id（換量化即換 id）", () => {
    expect(new TransformersEmbedder({ dtype: "q8" }).info.id).toBe("embeddinggemma-2@onnx-q8");
    expect(new TransformersEmbedder({ dtype: "fp32" }).info.id).toBe("embeddinggemma-2@onnx-fp32");
    expect(
      new TransformersEmbedder({ dtype: { model: "q4", vision_encoder: "q8" } }).info.id,
    ).toBe("embeddinggemma-2@onnx-model-q4-vision-q8");
  });

  it("自訂模型 id 會反映在 info.id", () => {
    expect(new TransformersEmbedder({ modelId: "org/some-model" }).info.id).toBe("some-model@onnx-q4");
  });

  it("dim 只允許 128／256／512／768", () => {
    for (const dim of [128, 256, 512, 768]) {
      expect(new TransformersEmbedder({ dim }).info.dim).toBe(dim);
    }
    for (const dim of [0, 100, 384, 1024]) {
      expect(() => new TransformersEmbedder({ dim })).toThrow(UnsupportedDimensionError);
    }
  });

  it("不可使用 float16；其他未知 dtype 也拒絕", () => {
    expect(() => new TransformersEmbedder({ dtype: "fp16" as never })).toThrow(UnsupportedDtypeError);
    expect(() => new TransformersEmbedder({ dtype: "int8" as never })).toThrow(UnsupportedDtypeError);
    expect(
      () => new TransformersEmbedder({ dtype: { model: "q4", vision_encoder: "fp16" as never } }),
    ).toThrow(UnsupportedDtypeError);
  });

  it("maxSoftTokens 必須是正整數", () => {
    expect(new TransformersEmbedder({ maxSoftTokens: 280 }).info.dim).toBe(DEFAULT_DIM);
    for (const value of [0, -1, 1.5]) {
      expect(() => new TransformersEmbedder({ maxSoftTokens: value })).toThrow(InvalidEmbedderOptionError);
    }
    expect(DEFAULT_MAX_SOFT_TOKENS).toBe(70);
  });
});
