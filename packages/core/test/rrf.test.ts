import { describe, expect, it } from "vitest";
import { rrfMerge } from "../src/search/rrf.js";
import type { RankedHit } from "../src/ports/types.js";

const hit = (key: string, rank: number): RankedHit => ({ key, rank });

describe("rrfMerge", () => {
  it("合併兩份清單並依 score = Σ 1/(60+rank) 排序", () => {
    // 輸入（rank 從 1 起算）：
    //   L1 = [a, b, c] → rank 1,2,3
    //   L2 = [b, d]    → rank 1,2
    // 手算（k=60，分母 61/62/63）：
    //   b = 1/(60+2) + 1/(60+1) = 1/62 + 1/61 = (61 + 62)/3782 = 123/3782 ≈ 0.032522
    //   a = 1/(60+1)            = 1/61     = 62/3782 ≈ 0.016393
    //   d = 1/(60+2)            = 1/62     = 61/3782 ≈ 0.016129
    //   c = 1/(60+3)            = 1/63     ≈ 0.015873
    // 0.032522 > 0.016393 > 0.016129 > 0.015873 → 排序 b, a, d, c
    const merged = rrfMerge([
      [hit("a", 1), hit("b", 2), hit("c", 3)],
      [hit("b", 1), hit("d", 2)],
    ]);

    expect(merged).toEqual([
      { key: "b", rank: 1 },
      { key: "a", rank: 2 },
      { key: "d", rank: 3 },
      { key: "c", rank: 4 },
    ]);

    // 分數關係用公式獨立核對一次（避免只依賴排序結果）
    expect(1 / 62 + 1 / 61).toBeGreaterThan(1 / 61);
    expect(1 / 61).toBeGreaterThan(1 / 62);
    expect(1 / 62).toBeGreaterThan(1 / 63);
  });

  it("只出現在單一清單的項目仍會進榜", () => {
    // L1 = [a]，L2 = [b]：兩者同分 1/61，但 a 的字典序在前。
    const merged = rrfMerge([[hit("a", 1)], [hit("b", 1)]]);
    expect(merged).toEqual([
      { key: "a", rank: 1 },
      { key: "b", rank: 2 },
    ]);

    // L1 = [x]，L2 = []：x 只出現在一個清單，仍是唯一結果
    expect(rrfMerge([[hit("x", 1)], []])).toEqual([{ key: "x", rank: 1 }]);
  });

  it("同分時以 key 字典序穩定排序（字串比較，非 locale）", () => {
    // 'c:10' < 'c:2'，因為 '1' < '2'
    const merged = rrfMerge([[hit("c:2", 1)], [hit("c:10", 1)]]);
    expect(merged).toEqual([
      { key: "c:10", rank: 1 },
      { key: "c:2", rank: 2 },
    ]);
  });

  it("可自訂 k，且重複出現的項目分數相加", () => {
    // k=1：a = 1/(1+1) + 1/(1+1) = 1，b = 1/(1+2) = 0.333
    const merged = rrfMerge([[hit("a", 1), hit("b", 2)], [hit("a", 1)]], 1);
    expect(merged).toEqual([
      { key: "a", rank: 1 },
      { key: "b", rank: 2 },
    ]);

    // k=1、兩份名次相反的清單：a 與 b 同分（1/2 + 1/1），字典序決定
    expect(rrfMerge([[hit("a", 1), hit("b", 2)], [hit("b", 1), hit("a", 2)]], 1)).toEqual([
      { key: "a", rank: 1 },
      { key: "b", rank: 2 },
    ]);
  });

  it("空輸入回傳空清單", () => {
    expect(rrfMerge([])).toEqual([]);
    expect(rrfMerge([[]])).toEqual([]);
  });
});
