import { describe, expect, it } from "vitest";
import { VectorDimensionError, VectorNotNormalizedError } from "../errors.js";
import type { VectorIndex } from "../ports/vector-index.js";

/** 每個測試都要拿到全新、獨立的實例（暫存目錄或 :memory:）。 */
export type VectorIndexFactory = () => VectorIndex | Promise<VectorIndex>;

/**
 * 契約前提：`dim >= 2`。向量一律以「單位基底向量」與其線性組合手工構造，
 * 這樣任何維度都能寫出可手算的距離與排序。
 */
function basis(dim: number, index: number, scale = 1): Float32Array {
  const vec = new Float32Array(dim);
  vec[index % dim] = scale;
  return vec;
}

function normalized(values: number[]): Float32Array {
  const vec = Float32Array.from(values);
  let sum = 0;
  for (const value of vec) sum += value * value;
  const norm = Math.sqrt(sum);
  for (let i = 0; i < vec.length; i += 1) vec[i] = vec[i] / norm;
  return vec;
}

/** 與基底向量混合的「中間」向量：normalize(e0 + e1)。 */
function midVector(dim: number): Float32Array {
  return normalized([1, 1, ...new Array<number>(Math.max(0, dim - 2)).fill(0)]);
}

/**
 * VectorIndex 的契約測試。任何實作（sqlite-vec、LanceDB、pgvector…）只要通過同一組
 * 測試就符合 docs/storage-ports.md 的介面契約。
 */
export function runVectorIndexContract(name: string, factory: VectorIndexFactory): void {
  describe(`VectorIndex contract (${name})`, () => {
    async function fresh(): Promise<VectorIndex> {
      const index = await factory();
      expect(index.dim).toBeGreaterThanOrEqual(2);
      return index;
    }

    it("寫入後 count 正確，同 key 重複 upsert 是覆寫", async () => {
      const index = await fresh();
      await index.upsert([
        { key: "c:1", rootId: 1, embedderId: "fake@1", vec: basis(index.dim, 0) },
        { key: "c:2", rootId: 1, embedderId: "fake@1", vec: basis(index.dim, 1) },
      ]);
      expect(await index.count()).toBe(2);

      // 把 c:1 的向量換成 e1：count 不變，但查詢結果順序改變（證明是覆寫而非新增）
      await index.upsert([{ key: "c:1", rootId: 1, embedderId: "fake@1", vec: basis(index.dim, 1) }]);
      expect(await index.count()).toBe(2);

      const hits = await index.searchVector(basis(index.dim, 0), {}, 10);
      expect(hits.map((h) => h.key)).toEqual(["c:2", "c:1"]);
      expect(hits.map((h) => h.rank)).toEqual([1, 2]);
    });

    it("空 upsert 與空 delete 不影響索引", async () => {
      const index = await fresh();
      await index.upsert([]);
      await index.deleteByKeys([]);
      expect(await index.count()).toBe(0);
    });

    it("已知最近鄰的排序正確", async () => {
      const index = await fresh();
      await index.upsert([
        { key: "c:1", rootId: 1, embedderId: "fake@1", vec: basis(index.dim, 0) },
        { key: "c:2", rootId: 1, embedderId: "fake@1", vec: midVector(index.dim) },
        { key: "c:3", rootId: 1, embedderId: "fake@1", vec: basis(index.dim, 1) },
      ]);

      // 手算（L2）：query=e0 時 d(c:1)=0、d(c:2)=sqrt(2-2/√2)≈0.765、d(c:3)=√2≈1.414
      const hits = await index.searchVector(basis(index.dim, 0), {}, 10);
      expect(hits.map((h) => h.key)).toEqual(["c:1", "c:2", "c:3"]);

      // k 只取前 2 名
      expect((await index.searchVector(basis(index.dim, 0), {}, 2)).map((h) => h.key)).toEqual(["c:1", "c:2"]);
    });

    it("rootIds 過濾只回傳該 root 的向量", async () => {
      const index = await fresh();
      await index.upsert([
        { key: "c:1", rootId: 1, embedderId: "fake@1", vec: basis(index.dim, 0) },
        { key: "c:2", rootId: 2, embedderId: "fake@1", vec: basis(index.dim, 1) },
        { key: "c:3", rootId: 1, embedderId: "fake@1", vec: basis(index.dim, 1) },
      ]);

      const rootOne = await index.searchVector(basis(index.dim, 0), { rootIds: [1] }, 10);
      expect(rootOne.map((h) => h.key).sort()).toEqual(["c:1", "c:3"]);

      const rootTwo = await index.searchVector(basis(index.dim, 0), { rootIds: [2] }, 10);
      expect(rootTwo.map((h) => h.key)).toEqual(["c:2"]);

      // 指定空的 rootIds＝沒有任何可見 root
      expect(await index.searchVector(basis(index.dim, 0), { rootIds: [] }, 10)).toEqual([]);
    });

    it("rootId 為 null 的向量：不過濾時回傳，指定 rootIds 時不回傳", async () => {
      const index = await fresh();
      await index.upsert([
        { key: "m:1", rootId: null, embedderId: "fake@1", vec: basis(index.dim, 0) },
        { key: "c:1", rootId: 5, embedderId: "fake@1", vec: basis(index.dim, 1) },
      ]);

      const unfiltered = await index.searchVector(basis(index.dim, 0), {}, 10);
      expect(unfiltered.map((h) => h.key).sort()).toEqual(["c:1", "m:1"]);

      const filtered = await index.searchVector(basis(index.dim, 0), { rootIds: [5] }, 10);
      expect(filtered.map((h) => h.key)).toEqual(["c:1"]);
    });

    it("rootIds 過濾在 KNN 之內生效，不會因為先取前 k 而少給結果", async () => {
      const index = await fresh();
      // root 2 的兩個向量離查詢最近；root 1 的向量全部比較遠。
      await index.upsert([
        { key: "c:100", rootId: 2, embedderId: "fake@1", vec: basis(index.dim, 0) },
        { key: "c:101", rootId: 2, embedderId: "fake@1", vec: midVector(index.dim) },
        { key: "c:1", rootId: 1, embedderId: "fake@1", vec: basis(index.dim, 1) },
        { key: "c:2", rootId: 1, embedderId: "fake@1", vec: basis(index.dim, 2) },
      ]);

      // 全域前 2 名都是 root 2 的向量
      const global = await index.searchVector(basis(index.dim, 0), {}, 2);
      expect(global.map((h) => h.key).sort()).toEqual(["c:100", "c:101"]);

      // 指定 root 1 且 k=2：必須拿到 root 1 的兩個向量（先過濾再掃描，而非取前 k 再過濾）
      const filtered = await index.searchVector(basis(index.dim, 0), { rootIds: [1] }, 2);
      expect(filtered.map((h) => h.key).sort()).toEqual(["c:1", "c:2"]);
      expect(filtered.map((h) => h.rank)).toEqual([1, 2]);
    });

    it("deleteByRoot 只刪該 root 的向量", async () => {
      const index = await fresh();
      await index.upsert([
        { key: "c:1", rootId: 1, embedderId: "fake@1", vec: basis(index.dim, 0) },
        { key: "c:2", rootId: 2, embedderId: "fake@1", vec: basis(index.dim, 1) },
        { key: "m:1", rootId: null, embedderId: "fake@1", vec: basis(index.dim, 1) },
      ]);

      await index.deleteByRoot(1);
      expect(await index.count()).toBe(2);
      expect(await index.searchVector(basis(index.dim, 0), { rootIds: [1] }, 10)).toEqual([]);
      expect((await index.searchVector(basis(index.dim, 0), {}, 10)).map((h) => h.key).sort()).toEqual(["c:2", "m:1"]);
    });

    it("deleteByKeys 刪除指定向量", async () => {
      const index = await fresh();
      await index.upsert([
        { key: "c:1", rootId: 1, embedderId: "fake@1", vec: basis(index.dim, 0) },
        { key: "c:2", rootId: 1, embedderId: "fake@1", vec: basis(index.dim, 1) },
      ]);

      await index.deleteByKeys(["c:1", "not-there"]);
      expect(await index.count()).toBe(1);
      expect((await index.searchVector(basis(index.dim, 0), {}, 10)).map((h) => h.key)).toEqual(["c:2"]);
    });

    it("維度不符時拋出 VectorDimensionError", async () => {
      const index = await fresh();
      const wrong = new Float32Array(index.dim + 1);
      await expect(
        index.upsert([{ key: "c:1", rootId: 1, embedderId: "fake@1", vec: wrong }]),
      ).rejects.toBeInstanceOf(VectorDimensionError);

      await expect(index.searchVector(wrong, {}, 5)).rejects.toBeInstanceOf(VectorDimensionError);
      expect(await index.count()).toBe(0);
    });

    it("未正規化時拋出 VectorNotNormalizedError", async () => {
      const index = await fresh();
      const notNormalized = basis(index.dim, 0, 3);
      await expect(
        index.upsert([{ key: "c:1", rootId: 1, embedderId: "fake@1", vec: notNormalized }]),
      ).rejects.toBeInstanceOf(VectorNotNormalizedError);
      expect(await index.count()).toBe(0);
    });

    it("embedderIds 回傳索引中出現過的 embedder", async () => {
      const index = await fresh();
      await index.upsert([
        { key: "c:1", rootId: 1, embedderId: "fake@1", vec: basis(index.dim, 0) },
        { key: "m:1", rootId: null, embedderId: "fake@2", vec: basis(index.dim, 1) },
        { key: "c:2", rootId: 1, embedderId: "fake@1", vec: basis(index.dim, 1) },
      ]);

      expect(await index.embedderIds()).toEqual(["fake@1", "fake@2"]);
    });

    it("k <= 0 回傳空清單，超過上限時夾住而非報錯", async () => {
      const index = await fresh();
      await index.upsert([{ key: "c:1", rootId: 1, embedderId: "fake@1", vec: basis(index.dim, 0) }]);

      expect(await index.searchVector(basis(index.dim, 0), {}, 0)).toEqual([]);
      expect((await index.searchVector(basis(index.dim, 0), {}, 100000)).map((h) => h.key)).toEqual(["c:1"]);
    });
  });
}
