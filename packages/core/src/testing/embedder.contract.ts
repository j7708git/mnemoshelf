import { beforeEach, describe, expect, it } from "vitest";
import type { Embedder, ImageInput } from "../ports/embedder.js";

/** 每個測試都要拿到全新、獨立的實例（真實 embedder 會重新載入模型）。 */
export type EmbedderFactory = () => Embedder | Promise<Embedder>;

/** L2 模長。 */
function norm(vec: Float32Array): number {
  let sum = 0;
  for (const value of vec) sum += value * value;
  return Math.sqrt(sum);
}

/** 值全部有限（無 NaN／Infinity）。 */
function isFiniteVector(vec: Float32Array): boolean {
  for (const value of vec) {
    if (!Number.isFinite(value)) return false;
  }
  return true;
}

/**
 * 兩張 1×1 的合法 PNG（紅色與藍色），以 base64 內嵌，避免 commit 二進位檔。
 * 契約測試的 `embedImage` 需要**真正可解碼**的圖片（真實 embedder 會用 sharp 解碼）。
 */
const TINY_PNG_RED =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
const TINY_PNG_BLUE =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC";

/** 兩張不同內容的合法圖片輸入。 */
function distinctImage(which: "a" | "b"): ImageInput {
  const base64 = which === "a" ? TINY_PNG_RED : TINY_PNG_BLUE;
  return { bytes: new Uint8Array(Buffer.from(base64, "base64")), mimeType: "image/png" };
}

/**
 * Embedder 的契約測試（docs/embedder-contract.md）。
 *
 * 任何 embedder 實作（FakeEmbedder、ONNX transformers…）只要通過同一組測試就符合介面契約。
 * 注意：契約只檢查**介面與向量性質**，不檢查語意檢索品質——那屬於 probe() 的責任。
 */
export function runEmbedderContract(name: string, factory: EmbedderFactory): void {
  describe(`Embedder contract (${name})`, () => {
    let embedder: Embedder;

    beforeEach(async () => {
      embedder = await factory();
    });

    it("宣告 text 與 image 能力，info.id 為非空字串、dim 為正整數", () => {
      expect(typeof embedder.info.id).toBe("string");
      expect(embedder.info.id.length).toBeGreaterThan(0);
      expect(Number.isInteger(embedder.info.dim)).toBe(true);
      expect(embedder.info.dim).toBeGreaterThan(0);

      // text 與 image 是契約的硬性要求（docs/embedder-contract.md）。
      expect(embedder.info.capabilities.text).toBe(true);
      expect(embedder.info.capabilities.image).toBe(true);
      expect(typeof embedder.info.capabilities.audio).toBe("boolean");
      expect(typeof embedder.info.capabilities.video).toBe("boolean");
    });

    it("info 為穩定識別：重複讀取 id 與 dim 不變", () => {
      expect(embedder.info.id).toBe(embedder.info.id);
      expect(embedder.info.dim).toBe(embedder.info.dim);
    });

    it("同一輸入必得同一向量（query、document、image 各自確定性）", async () => {
      const query = await embedder.embedQuery("契約測試的查詢文字");
      expect(Array.from(await embedder.embedQuery("契約測試的查詢文字"))).toEqual(Array.from(query));

      const document = await embedder.embedDocument("契約測試的文件內容", "標題");
      expect(Array.from(await embedder.embedDocument("契約測試的文件內容", "標題"))).toEqual(Array.from(document));

      const image = distinctImage("a");
      expect(Array.from(await embedder.embedImage(image))).toEqual(Array.from(await embedder.embedImage(image)));

      // 沒有 title 與 title:"none" 的前綴等價（契約：沒有標題用 "none"）。
      expect(Array.from(await embedder.embedDocument("無標題文件"))).toEqual(
        Array.from(await embedder.embedDocument("無標題文件", "none")),
      );
    });

    it("不同輸入得不同向量", async () => {
      const queryA = await embedder.embedQuery("第一個查詢");
      const queryB = await embedder.embedQuery("第二個明顯不同的查詢");
      expect(Array.from(queryA)).not.toEqual(Array.from(queryB));

      const docA = await embedder.embedDocument("文件內容甲", "甲");
      const docB = await embedder.embedDocument("文件內容乙", "乙");
      expect(Array.from(docA)).not.toEqual(Array.from(docB));

      const imageA = await embedder.embedImage(distinctImage("a"));
      const imageB = await embedder.embedImage(distinctImage("b"));
      expect(Array.from(imageA)).not.toEqual(Array.from(imageB));
    });

    it("所有向量長度為 info.dim、值有限且已 L2 正規化（容差 1e-3）", async () => {
      const vectors = [
        await embedder.embedQuery("正規化檢查的查詢"),
        await embedder.embedDocument("正規化檢查的文件", "標題"),
        await embedder.embedImage(distinctImage("a")),
      ];
      for (const vec of vectors) {
        expect(vec).toBeInstanceOf(Float32Array);
        expect(vec.length).toBe(embedder.info.dim);
        expect(isFiniteVector(vec)).toBe(true);
        expect(Math.abs(norm(vec) - 1)).toBeLessThan(1e-3);
      }
    });

    it("probe() 回傳成功", async () => {
      const result = await embedder.probe();
      expect(result.ok).toBe(true);
      if (!result.ok) {
        // 讓失敗訊息直接出現在測試輸出中。
        throw new Error(`probe 失敗：${result.message ?? "(無訊息)"}`);
      }
    });

    it("dispose() 冪等：可重複呼叫且不拋錯", async () => {
      await embedder.dispose();
      await embedder.dispose();
    });
  });
}
