/**
 * D3 的選值規則（**只用 dev**）。
 *
 * 卡片上的決策規則：
 * 1. 選「dev 上 FP ≤10% 且 abstention 最高、Recall@5 不低於 baseline」的最大 minScore。
 * 2. dev 上差異 <10pp 一律視為「無法分辨」，沿用較保守值（不是較高分或較低分的極端）。
 * 3. 60 題 test 的 Top-1 95% CI 約 ±12–13pp，所以 test 只用來報告，不參與選值。
 *
 * 這裡只回傳「建議 ＋ 依據 ＋ 是否可分辨」，不寫任何檔案，方便單元測試。
 */

/** 0..1 的比例差異換成百分點（pp）。 */
export function ppDiff(a, b) {
  if (a === null || b === null || a === undefined || b === undefined) return null;
  return Math.abs(a - b) * 100;
}

export const NOISE_PP = 10;
export const FP_GATE = 0.1;

/**
 * minScore 選值（**用 production 口徑**的 dev 結果）。
 *
 * 卡片規則：選「FP ≤10% 且 abstention 最高、Recall@5 不低於 baseline」的最大 minScore。
 * F1 之後，這裡的 FP／abstention 是「套用外掛 skip 判斷後」的 production 數字；Recall 則用
 * 注入層的 `hitItems`（期望卡實際被注入的數量），因為 Recall@5 是檢索層、與 minScore 無關。
 *
 * 若沒有任何候選達到 FP ≤10%，但某個候選的 hitItems 不低於 baseline、negative 注入明顯更低，
 * 仍會建議該值（並標記 `meetsGate: false`）——這正是「先改善、尚未達標」的誠實說法。
 *
 * @param {Record<string, object>} devByMinScore key 是 `"0.35"`…，值是 production aggregate
 * @param {number} baseline
 */
export function selectMinScore(devByMinScore, baseline = 0.4) {
  const entries = Object.entries(devByMinScore)
    .map(([key, value]) => ({ minScore: Number(key), bucket: value }))
    .sort((a, b) => b.minScore - a.minScore);
  const baseEntry = entries.find((entry) => Math.abs(entry.minScore - baseline) < 1e-9);
  if (baseEntry === undefined) throw new Error("selectMinScore: 缺少 baseline 的 dev 結果");
  const base = baseEntry.bucket;
  const baseHit = base.hitItems ?? 0;

  const rows = entries.map((entry) => ({
    minScore: entry.minScore,
    fp: entry.bucket.fpItemRate,
    fpItems: entry.bucket.fpItems ?? 0,
    negativeInjection: entry.bucket.negativeInjectionRate,
    crossInjection: entry.bucket.crossInjectionRate,
    abstention: entry.bucket.abstention,
    recall5: entry.bucket.recall5,
    hitItems: entry.bucket.hitItems ?? 0,
    tokensP95: entry.bucket.injectedTokens?.p95 ?? null,
    meetsRecallGate: (entry.bucket.hitItems ?? 0) >= baseHit,
    meetsFpGate: entry.bucket.fpItemRate !== null && entry.bucket.fpItemRate <= FP_GATE,
  }));
  for (const row of rows) row.eligible = row.meetsRecallGate && row.meetsFpGate;

  const eligible = rows.filter((row) => row.eligible);
  if (eligible.length > 0) {
    // 若 baseline 自己不合格（FP 超過 10%），而某個更高的門檻合格且 hitItems 不變，
    // 這是「跨過門檻」的類別差異，不套 <10pp 的噪音規則——否則永遠只能沿用不合格的現值。
    const baselineEligible = rows.find((row) => Math.abs(row.minScore - baseline) < 1e-9)?.eligible === true;
    if (!baselineEligible) {
      const best = eligible.reduce((candidate, row) => {
        const currentAbstention = candidate.abstention ?? -1;
        const rowAbstention = row.abstention ?? -1;
        if (rowAbstention > currentAbstention) return row;
        if (rowAbstention < currentAbstention) return candidate;
        return row.minScore > candidate.minScore ? row : candidate;
      });
      return {
        recommended: best.minScore,
        baseline,
        distinguishable: true,
        meetsGate: true,
        reason:
          `baseline ${baseline.toFixed(2)} 的 FP 是 ${((base.fpItemRate ?? 0) * 100).toFixed(1)}%（未達 ≤10%）；` +
          `minScore=${best.minScore.toFixed(2)} 的 FP ${((best.fp ?? 0) * 100).toFixed(1)}%、` +
          `negative 注入 ${((base.negativeInjectionRate ?? 0) * 100).toFixed(1)}% → ${((best.negativeInjection ?? 0) * 100).toFixed(1)}%、` +
          `hitItems ${baseHit} → ${best.hitItems}（不變）。個別差異雖 <10pp，但 FP 由「不合格」變成「合格」，是門檻效應而非噪音`,
        rows,
      };
    }

    const selected = eligible.reduce((best, row) => {
      const bestAbstention = best.abstention ?? -1;
      const rowAbstention = row.abstention ?? -1;
      if (rowAbstention > bestAbstention) return row;
      if (rowAbstention < bestAbstention) return best;
      return row.minScore > best.minScore ? row : best;
    });
    if (selected.minScore === baseline) {
      return {
        recommended: baseline,
        baseline,
        distinguishable: true,
        meetsGate: true,
        reason: `目前預設（${baseline.toFixed(2)}）是符合 FP ≤10% 與 hitItems 不低於 baseline 的最大 minScore`,
        rows,
      };
    }
    const fpGain = (base.fpItemRate ?? 0) - (selected.fp ?? 0);
    const abstentionGain = (selected.abstention ?? 0) - (base.abstention ?? 0);
    const hitGain = (selected.hitItems ?? 0) - baseHit;
    const decisive = fpGain >= NOISE_PP / 100 || abstentionGain >= NOISE_PP / 100 || hitGain > 0;
    if (!decisive) {
      return {
        recommended: baseline,
        baseline,
        distinguishable: false,
        meetsGate: true,
        reason:
          `minScore=${selected.minScore.toFixed(2)} 與 ${baseline.toFixed(2)} 的 FP／abstention 差異都 <10pp、` +
          `hitItems 也沒有增加；無法分辨，沿用 ${baseline.toFixed(2)}`,
        rows,
      };
    }
    return {
      recommended: selected.minScore,
      baseline,
      distinguishable: true,
      meetsGate: true,
      reason:
        `dev（production 口徑）minScore=${selected.minScore.toFixed(2)}：FP ${(selected.fp * 100).toFixed(1)}%、` +
        `abstention ${(selected.abstention * 100).toFixed(1)}%、hitItems ${selected.hitItems}（baseline ${baseHit}）；達到 FP ≤10% 的通過線`,
      rows,
    };
  }

  const baseNegative = base.negativeInjectionRate ?? 1;
  const improving = rows.filter(
    (row) =>
      row.minScore !== baseline &&
      row.meetsRecallGate &&
      (row.negativeInjection ?? 1) < baseNegative &&
      ((baseNegative - (row.negativeInjection ?? 0)) * 100 >= NOISE_PP ||
        ((base.fpItemRate ?? 0) - (row.fp ?? 0)) * 100 >= NOISE_PP),
  );
  if (improving.length > 0) {
    const selected = improving.reduce((best, row) =>
      (row.negativeInjection ?? 1) < (best.negativeInjection ?? 1)
        ? row
        : (row.negativeInjection ?? 1) === (best.negativeInjection ?? 1) && row.minScore > best.minScore
          ? row
          : best,
    );
    return {
      recommended: selected.minScore,
      baseline,
      distinguishable: true,
      meetsGate: false,
      reason:
        `沒有任何 minScore 達到 FP ≤10%，但 minScore=${selected.minScore.toFixed(2)} 在 dev（production 口徑）上 ` +
        `hitItems 不變（${selected.hitItems} vs ${baseHit}）、negative 注入由 ` +
        `${(baseNegative * 100).toFixed(1)}% 降到 ${((selected.negativeInjection ?? 0) * 100).toFixed(1)}%、` +
        `FP items ${base.fpItems ?? 0} → ${selected.fpItems}。這是「改善但未達標」，仍比沿用 baseline 好`,
      rows,
    };
  }

  return {
    recommended: baseline,
    baseline,
    distinguishable: false,
    meetsGate: false,
    reason:
      "沒有任何 minScore 能讓 hitItems 不低於 baseline 且降低 negative 注入；門檻不是這裡的槓桿（見 §8.4），沿用現值",
    rows,
  };
}

/**
 * maxItems 選值（F3：用**注入層**證據，不用檢索層 Recall@5）。
 *
 * 規則：`maxItems 3` 只有在「期望卡實際被注入的數量（hitItems）不低於 4」且
 * 「注入 token p95 明顯下降（≥10%）」時才建議；否則沿用 4。
 *
 * 為什麼不用 Recall@5／abstention：Recall@5 是檢索層，跟裝幾筆無關；abstention 在
 * minScore 0.40 下恆為 0，拿它當閘門等於沒有閘門。
 *
 * @param {Record<string, object>} devByMaxItems key 是 `3`／`5`／`8`（`4` 是 baseline）
 * @param {number} baseline
 */
export function selectMaxItems(devByMaxItems, baseline = 4) {
  const entries = Object.entries(devByMaxItems)
    .map(([key, value]) => ({ maxItems: Number(key), bucket: value }))
    .sort((a, b) => a.maxItems - b.maxItems);
  const baseEntry = entries.find((entry) => entry.maxItems === baseline);
  if (baseEntry === undefined) throw new Error("selectMaxItems: 缺少 baseline 的 dev 結果");
  const base = baseEntry.bucket;

  const rows = entries.map((entry) => ({
    maxItems: entry.maxItems,
    hitItems: entry.bucket.hitItems ?? 0,
    fp: entry.bucket.fpItemRate,
    fpItems: entry.bucket.fpItems ?? 0,
    recall5: entry.bucket.recall5,
    injectedItems: entry.bucket.injectedItems ?? 0,
    tokensP95: entry.bucket.injectedTokens?.p95 ?? null,
    charsP95: entry.bucket.injectedChars?.p95 ?? null,
    meetsHitGate: (entry.bucket.hitItems ?? 0) >= (base.hitItems ?? 0),
  }));

  const eligible = rows.filter((row) => row.meetsHitGate);
  const smallest = eligible.length === 0 ? null : eligible[0];
  if (smallest === null || smallest.maxItems === baseline) {
    return {
      recommended: baseline,
      baseline,
      distinguishable: false,
      meetsGate: true,
      reason: `沒有更小的 maxItems 能讓 hitItems 不低於 ${baseline}（baseline hitItems ${base.hitItems ?? 0}），沿用 ${baseline}`,
      rows,
    };
  }

  const baseTokens = base.injectedTokens?.p95 ?? 0;
  const smallestTokens = smallest.tokensP95 ?? 0;
  const tokenGain = baseTokens === 0 ? 0 : (baseTokens - smallestTokens) / baseTokens;
  if (tokenGain < NOISE_PP / 100) {
    return {
      recommended: baseline,
      baseline,
      distinguishable: false,
      meetsGate: true,
      reason:
        `maxItems=${smallest.maxItems} 的 hitItems 不變（${smallest.hitItems}），但 token p95 只少 ` +
        `${(tokenGain * 100).toFixed(1)}%（<10%）；無法分辨，沿用 ${baseline}`,
      rows,
    };
  }
  return {
    recommended: smallest.maxItems,
    baseline,
    distinguishable: true,
    meetsGate: true,
    reason:
      `maxItems=${smallest.maxItems}：hitItems ${smallest.hitItems} 與 ${baseline}（${base.hitItems ?? 0}）相同、` +
      `FP items ${smallest.fpItems} vs ${base.fpItems ?? 0}，token p95 ${baseTokens} → ${smallestTokens}` +
      `（−${(tokenGain * 100).toFixed(1)}%）。**尚未做下游品質 A/B**，改之前要有品質證據`,
    rows,
  };
}

/**
 * kMax 選值：只比較候選數（k=3／5／8）對 Recall@5／MRR 的影響。
 * 沒有明顯損失就沿用現值 8——k 只影響 server 端候選，不是 token 成本的主要來源。
 */
export function selectKMax(devByK, baseline = 8) {
  const rows = Object.entries(devByK)
    .map(([key, value]) => ({
      k: Number(key),
      recall5: value.recall5,
      mrr: value.mrr,
      fp: value.fpItemRate,
    }))
    .sort((a, b) => a.k - b.k);
  const base = rows.find((row) => row.k === baseline);
  if (base === undefined) throw new Error("selectKMax: 缺少 baseline 的 dev 結果");
  const viable = rows.filter(
    (row) =>
      row.recall5 !== null &&
      base.recall5 !== null &&
      row.recall5 >= base.recall5 - NOISE_PP / 100 &&
      (row.mrr ?? 0) >= (base.mrr ?? 0) - NOISE_PP / 100,
  );
  const smallest = viable.length === 0 ? null : viable[0];
  if (smallest !== null && smallest.k !== baseline) {
    const recallGap = ppDiff(smallest.recall5, base.recall5) ?? 0;
    const mrrGap = ppDiff(smallest.mrr, base.mrr) ?? 0;
    return {
      recommended: baseline,
      baseline,
      distinguishable: false,
      reason:
        `k=${smallest.k} 與 k=${baseline} 的 Recall@5 差 ${recallGap.toFixed(1)}pp、MRR 差 ${mrrGap.toFixed(1)}pp，` +
        `都在噪音內；k 不是 token 成本主因，沿用 ${baseline}`,
      rows,
    };
  }
  return {
    recommended: baseline,
    baseline,
    distinguishable: smallest !== null,
    reason: `k=${baseline} 沒有被更小的候選數以 10pp 內的差距取代；沿用 ${baseline}`,
    rows,
  };
}

/**
 * timeoutMs 選值。
 *
 * - 閒置 p95 ≤150ms 且超過 150ms 的比例 ≤1% → 維持 150ms。
 * - 否則建議把 p95 向上取到 50ms 的倍數（上限 500ms，與 plugin 的 clamp 一致）。
 * - 索引中永遠可能排隊；fail-open 的設計不變，調高只降低「索引中完全沒有記憶」的機率。
 */
export function selectTimeout({ idleP50, idleP95, idleMax, idleOver150Rate, idleOver300Rate, indexingP95 }, baseline = 150) {
  const rows = [
    { timeoutMs: 100, note: "目前 clamp 下限" },
    { timeoutMs: 150, note: "目前預設" },
    { timeoutMs: 300, note: "研究筆記的替代值" },
    { timeoutMs: 500, note: "clamp 上限" },
  ];
  if (idleP95 === null) {
    return { recommended: baseline, baseline, distinguishable: false, reason: "沒有可用的閒置延遲樣本，沿用 150ms", rows };
  }
  const summary =
    `閒置 p95 ${idleP95.toFixed(0)}ms（p50 ${idleP50 ?? "?"}ms、max ${idleMax ?? "?"}ms）、` +
    `超過 150ms 的比例 ${((idleOver150Rate ?? 0) * 100).toFixed(1)}%、超過 300ms ${((idleOver300Rate ?? 0) * 100).toFixed(1)}%`;

  if (idleP95 <= baseline) {
    return {
      recommended: baseline,
      baseline,
      distinguishable: false,
      reason:
        `${summary}；p95 在 150ms 以內，沿用 ${baseline}ms` +
        ((idleOver150Rate ?? 0) > 0.01
          ? `（>150ms 的比例略高，代表少數查詢會 fail-open＝該輪沒有記憶，這是 fail-open 的既定取捨）`
          : ""),
      rows,
    };
  }
  const target = Math.min(500, Math.max(150, Math.ceil(idleP95 / 50) * 50));
  if (target === baseline) {
    return {
      recommended: baseline,
      baseline,
      distinguishable: false,
      reason: `${summary}；依 p95 取整算出的目標等於現值 ${baseline}ms，維持不變`,
      rows,
    };
  }
  return {
    recommended: target,
    baseline,
    distinguishable: true,
    reason: `${summary}；建議把 timeoutMs 提到 ${target}ms`,
    rows,
  };
}
