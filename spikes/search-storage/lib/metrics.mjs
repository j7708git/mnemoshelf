// 排名合併與檢索指標。
import { queryBucket } from "./corpus.mjs";

/** Reciprocal Rank Fusion：score = Σ 1/(k + rank)，rank 由 1 起算。 */
export function rrf(lists, k = 60) {
  const scores = new Map();
  for (const list of lists) {
    list.forEach((id, rank) => {
      scores.set(id, (scores.get(id) || 0) + 1 / (k + rank));
    });
  }
  return [...scores.entries()].sort((a, b) => b[1] - a[1]).map((x) => x[0]);
}

export const BUCKETS = ["<=2", "3-6", ">6", "all"];

/**
 * 對每個方法計算各查詢長度組的 Recall@5 / Recall@10 / MRR。
 * methods: { name: (pair) => rankedId[] }
 * pairs:   [{targetId, query}]
 */
export function evaluate(methods, pairs) {
  const report = {};
  for (const [name, fn] of Object.entries(methods)) {
    report[name] = {};
    for (const bucket of BUCKETS) {
      const sel = bucket === "all" ? pairs : pairs.filter((p) => queryBucket(p.query) === bucket);
      let r5 = 0;
      let r10 = 0;
      let mrr = 0;
      for (const pair of sel) {
        const list = fn(pair);
        const pos = list.indexOf(pair.targetId);
        if (pos >= 0 && pos < 5) r5 += 1;
        if (pos >= 0 && pos < 10) r10 += 1;
        if (pos >= 0) mrr += 1 / (pos + 1);
      }
      const n = sel.length || 1;
      report[name][bucket] = {
        n: sel.length,
        r5: Number((r5 / n).toFixed(3)),
        r10: Number((r10 / n).toFixed(3)),
        mrr: Number((mrr / n).toFixed(3)),
      };
    }
  }
  return report;
}
