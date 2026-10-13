import type { RankedHit } from "../ports/types.js";

/** RRF 公式的預設常數（storage-ports.md）。 */
export const RRF_DEFAULT_K = 60;

/**
 * Reciprocal Rank Fusion：合併多份排名清單。
 *
 * score(key) = Σ_lists 1 / (k + rank)，rank 從 1 起算。
 * 同分時以 key 的字典序（逐字元比較，非 locale 排序）穩定排序，確保結果可重現。
 * 回傳的 rank 為合併後的名次，從 1 起算。
 */
export function rrfMerge(lists: RankedHit[][], k: number = RRF_DEFAULT_K): RankedHit[] {
  const scores = new Map<string, number>();

  for (const list of lists) {
    for (const hit of list) {
      scores.set(hit.key, (scores.get(hit.key) ?? 0) + 1 / (k + hit.rank));
    }
  }

  return [...scores.entries()]
    .sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
    })
    .map(([key], index) => ({ key, rank: index + 1 }));
}
