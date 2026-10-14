import { describe, expect, it } from "vitest";
import { FAKE_EMBEDDER_DIM, FakeEmbedder } from "../src/testing/index.js";

function norm(vec: Float32Array): number {
  let sum = 0;
  for (const value of vec) sum += value * value;
  return Math.sqrt(sum);
}

function isFiniteVector(vec: Float32Array): boolean {
  for (const value of vec) {
    if (!Number.isFinite(value)) return false;
  }
  return true;
}

describe("FakeEmbedder", () => {
  const embedder = new FakeEmbedder();

  it("宣告多模態能力（text 與 image 必為 true）", () => {
    expect(embedder.info.dim).toBe(FAKE_EMBEDDER_DIM);
    expect(embedder.info.capabilities).toEqual({ text: true, image: true, audio: false, video: false });
    expect(embedder.info.id.length).toBeGreaterThan(0);
  });

  it("同一輸入必得同一向量，不同輸入得不同向量", async () => {
    const first = await embedder.embedQuery("相同的查詢文字");
    const second = await embedder.embedQuery("相同的查詢文字");
    expect(Array.from(first)).toEqual(Array.from(second));

    const other = await embedder.embedQuery("不同的查詢文字");
    expect(Array.from(other)).not.toEqual(Array.from(first));

    const document = await embedder.embedDocument("文件內容", "標題");
    const sameDocument = await embedder.embedDocument("文件內容", "標題");
    expect(Array.from(document)).toEqual(Array.from(sameDocument));
    const differentTitle = await embedder.embedDocument("文件內容", "別的標題");
    expect(Array.from(differentTitle)).not.toEqual(Array.from(document));
  });

  it("圖片位元組也會產生確定性向量", async () => {
    const bytes = Uint8Array.from([1, 2, 3, 4]);
    const first = await embedder.embedImage({ bytes, mimeType: "image/png" });
    const second = await embedder.embedImage({ bytes });
    expect(Array.from(first)).toEqual(Array.from(second));
    const other = await embedder.embedImage({ bytes: Uint8Array.from([4, 3, 2, 1]) });
    expect(Array.from(other)).not.toEqual(Array.from(first));
  });

  it("所有向量長度為 512、值有限且已 L2 正規化", async () => {
    const vectors = [
      await embedder.embedQuery("查詢"),
      await embedder.embedDocument("文件", "標題"),
      await embedder.embedImage({ bytes: Uint8Array.from([9, 9, 9]) }),
    ];
    for (const vec of vectors) {
      expect(vec).toBeInstanceOf(Float32Array);
      expect(vec.length).toBe(FAKE_EMBEDDER_DIM);
      expect(isFiniteVector(vec)).toBe(true);
      expect(Math.abs(norm(vec) - 1)).toBeLessThan(1e-3);
    }
  });

  it("probe() 回傳成功，dispose() 可重複呼叫", async () => {
    const result = await embedder.probe();
    expect(result.ok).toBe(true);
    await embedder.dispose();
    await embedder.dispose();
  });

  it("embedDocuments：空陣列回傳 []，數量一致且與單筆向量相同（順序對應）", async () => {
    expect(await embedder.embedDocuments([])).toEqual([]);

    const inputs = [
      { text: "批次文件甲", title: "甲" },
      { text: "批次文件乙", title: "乙" },
      { text: "批次文件丙" },
    ];
    const batch = await embedder.embedDocuments(inputs);
    expect(batch).toHaveLength(inputs.length);

    for (let i = 0; i < inputs.length; i += 1) {
      const single = await embedder.embedDocument(inputs[i]!.text, inputs[i]!.title);
      expect(Array.from(batch[i]!)).toEqual(Array.from(single));
    }
  });

  it("embedDocuments：已取消的 signal 會拋出 AbortError", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      embedder.embedDocuments([{ text: "文件" }], { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
