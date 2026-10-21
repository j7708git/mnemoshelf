/**
 * D3 的指標計算（純函式，沒有 IO）。
 *
 * 名詞：
 * - **retrieval**：server 回傳的排名清單（已套用該 variant 的 minScore／k），不是裝箱後的結果。
 * - **injection**：`planRecall` 實際放進 `<memory-context>` 的卡片。FP 一律用 expected／
 *   acceptable／forbidden 判定，**不看 score**（keyword 命中的 score 是 `1/rank`）。
 */

/** 中文字元（含擴充 A）與全形標點都算 1 token；其餘以 4 字元 1 token 估。 */
export function estimateTokens(text) {
  if (typeof text !== "string" || text === "") return 0;
  const cjk = text.match(/[\u3400-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef]/g)?.length ?? 0;
  const rest = [...text].length - cjk;
  return Math.round(cjk + rest / 4);
}

/** 線性內插的百分位（p 為 0..1）；空陣列回 `null`。 */
export function percentile(values, p) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0];
  const position = (sorted.length - 1) * p;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

export function mean(values) {
  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length === 0) return null;
  return finite.reduce((total, value) => total + value, 0) / finite.length;
}

/** 四捨五入到小數第 n 位；null 保持 null。 */
export function round(value, digits = 3) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * 排名清單的指標。
 *
 * - `hit5`／`multiAll`：Recall@5 的兩種形式（單目標：有進前 5；多目標：required 全進前 5）。
 * - `top1`：單目標題 rank 1 是否為 expected。
 * - `mrr`：第一個 expected 的 1/rank（只看前 10 名）。
 */
export function retrievalMetrics(question, hits) {
  const expected = new Set(question.expected_ids ?? []);
  const forbidden = new Set(question.forbidden_ids ?? []);
  const keyOf = (hit) => hit.slug ?? hit.id;
  const top5 = hits.slice(0, 5);
  const top10 = hits.slice(0, 10);
  const rankOf = (set) => {
    for (let index = 0; index < top10.length; index += 1) {
      if (set.has(keyOf(top10[index]))) return index + 1;
    }
    return null;
  };
  const firstExpectedRank = expected.size === 0 ? null : rankOf(expected);
  const foundIn5 = top5.filter((hit) => expected.has(keyOf(hit))).length;

  let hit5;
  if (question.category === "single" || question.category === "update") hit5 = foundIn5 >= 1;
  else if (question.category === "multi") hit5 = foundIn5 === expected.size;
  else hit5 = null;

  return {
    hit5,
    top1: question.category === "single" ? firstExpectedRank === 1 : null,
    mrr: firstExpectedRank === null ? 0 : 1 / firstExpectedRank,
    recallAt5: expected.size === 0 ? null : foundIn5 / expected.size,
    staleInTop5: forbidden.size > 0 && top5.some((hit) => forbidden.has(keyOf(hit))),
    foreignHits: hits.filter((hit) => hit.foreignProject === true).length,
    hitIds: top5.map((hit) => keyOf(hit)),
  };
}

/**
 * 裝箱結果的指標。
 *
 * **FP 的判定（重要）**：標註是稀疏的——每題只標「必要」與「明確錯誤」的卡，其餘卡片
 * 是「未判定（unjudged）」，不是「不相關」。因此：
 * - `forbidden_ids`（過時／跨專案）→ FP。
 * - `negative`／`cross` 題（正確行為是 0 注入）→ 任何注入都是 FP。
 * - 其他未標註的卡 → 只計入 `unlabeledCount`，不當成 FP（標準 IR 的 pooling 慣例）。
 *   它們仍然會讓「標註精準率」看起來很低，報告會分開呈現，避免把「沒標」講成「錯」。
 *
 * @param {object} question
 * @param {{injected: {id: number, kind: string, pinned: boolean}[], block: string}} planned
 * @param {(id: number) => object|undefined} cardOf  id → 卡片（含 slug、project、scope）
 * @param {number} dedupedCount
 */
export function injectionMetrics(question, planned, cardOf, dedupedCount = 0) {
  const expected = new Map((question.expected_ids ?? []).map((slug) => [slug, "expected"]));
  const acceptable = new Map((question.acceptable_ids ?? []).map((slug) => [slug, "acceptable"]));
  const forbidden = new Map((question.forbidden_ids ?? []).map((slug) => [slug, "forbidden"]));
  const shouldAbstain = question.category === "negative" || question.category === "cross";

  const injectedSlugs = [];
  const fpSlugs = [];
  const unlabeledSlugs = [];
  const hitSlugs = [];
  const foreignSlugs = [];
  for (const item of planned.injected) {
    const card = cardOf(item.id);
    if (card === undefined) {
      fpSlugs.push(`#${item.id}`);
      continue;
    }
    injectedSlugs.push(card.id);
    if (expected.has(card.id)) hitSlugs.push(card.id);
    else if (acceptable.has(card.id)) {
      // 近似重複／等價卡：不算命中，也不算 FP。
    } else if (forbidden.has(card.id) || shouldAbstain) {
      fpSlugs.push(card.id);
    } else {
      unlabeledSlugs.push(card.id);
    }
    if (card.scope !== "global" && card.project !== undefined && card.project !== question.project) {
      foreignSlugs.push(card.id);
    }
  }

  return {
    injectedCount: planned.injected.length,
    injectedSlugs,
    fpCount: fpSlugs.length,
    fpSlugs,
    unlabeledCount: unlabeledSlugs.length,
    unlabeledSlugs,
    hitCount: hitSlugs.length,
    foreignSlugs,
    chars: planned.block.length,
    tokensEst: estimateTokens(planned.block),
    dedupedCount,
    empty: planned.injected.length === 0,
  };
}

/** 空集合的聚合（variant A 用）。 */
function emptyBucket(n) {
  return {
    n,
    recall5: null,
    top1: null,
    mrr: null,
    updateHit5: null,
    staleHitRate: null,
    fpItemRate: null,
    fpQuestionRate: null,
    negativeInjectionRate: null,
    crossInjectionRate: null,
    abstention: null,
    emptyRecallRate: null,
    injectedPerQuestion: null,
    injectedChars: null,
    injectedTokens: null,
    injectedItems: 0,
    fpItems: 0,
    unlabeledItems: 0,
    hitItems: 0,
    expectedQuestions: 0,
    questionsWithExpectedHit: 0,
    expectedHitRate: null,
    expectedAllHitRate: null,
    labeledPrecision: null,
    skippedQuestions: 0,
    skippedWithExpected: 0,
    skippedByReason: {},
    injectedSources: {},
    latency: null,
    timeouts: 0,
    degraded: 0,
    errors: 0,
  };
}

/**
 * 聚合一批逐題紀錄（同一 variant ＋ 同一 split）。
 *
 * **兩種口徑**（F1）：
 * - `mode: "retrieval"`：不管外掛會不會跳過，一律用 `planRecall` 的裝箱結果。
 * - `mode: "production"`：套用外掛真實的 skip 判斷；被跳過的題目視為 0 注入（不查 server）。
 *   檢索欄位（Recall／MRR）仍來自實測，但注入／FP／abstention 一律用 production 的結果。
 *
 * @param {object[]} records 每題一筆：{question, retrieval, injection, production, latencyMs, status, skipReason, skippedDedup}
 * @param {"retrieval"|"production"} mode
 */
export function aggregate(records, mode = "retrieval") {
  const usable = records.filter((record) => record.status === "ok");
  const bucket = emptyBucket(usable.length);
  const pick = (record) => (mode === "production" ? record.production : record.injection);
  if (usable.length === 0) {
    bucket.total = records.length;
    bucket.excluded = records.length - usable.length;
    bucket.degraded = records.filter((record) => record.status === "degraded").length;
    bucket.skippedQuestions = records.filter((record) => record.skipReason !== null && record.skipReason !== undefined).length;
    return bucket;
  }

  const single = usable.filter((r) => r.question.category === "single");
  const multi = usable.filter((r) => r.question.category === "multi");
  const update = usable.filter((r) => r.question.category === "update");
  const negative = usable.filter((r) => r.question.category === "negative");
  const cross = usable.filter((r) => r.question.category === "cross");

  const boolRate = (items, pickValue) => {
    const values = items.map(pickValue).filter((value) => value !== null && value !== undefined);
    if (values.length === 0) return null;
    return values.filter(Boolean).length / values.length;
  };

  const recallRecords = [...single, ...multi];
  bucket.recall5 = boolRate(recallRecords, (r) => r.retrieval.hit5);
  bucket.top1 = boolRate(single, (r) => r.retrieval.top1);
  bucket.mrr = mean(recallRecords.map((r) => r.retrieval.mrr));
  bucket.updateHit5 = boolRate(update, (r) => r.retrieval.hit5);
  bucket.staleHitRate = boolRate(update, (r) => r.retrieval.staleInTop5);

  const injectedItems = usable.reduce((total, r) => total + pick(r).injectedCount, 0);
  const fpItems = usable.reduce((total, r) => total + pick(r).fpCount, 0);
  bucket.injectedItems = injectedItems;
  bucket.fpItems = fpItems;
  bucket.unlabeledItems = usable.reduce((total, r) => total + (pick(r).unlabeledCount ?? 0), 0);
  bucket.hitItems = usable.reduce((total, r) => total + pick(r).hitCount, 0);
  bucket.fpItemRate = injectedItems === 0 ? 0 : fpItems / injectedItems;
  // 標註精準率（下限）：expected 卡 ÷ 所有注入卡。標註稀疏，所以這只是下限，不是錯誤率。
  bucket.labeledPrecision = injectedItems === 0 ? null : bucket.hitItems / injectedItems;
  bucket.fpQuestionRate = boolRate(usable, (r) => (pick(r).injectedCount === 0 ? false : pick(r).fpCount > 0));
  bucket.negativeInjectionRate = boolRate(negative, (r) => pick(r).injectedCount > 0);
  bucket.crossInjectionRate = boolRate(cross, (r) => pick(r).injectedCount > 0);
  bucket.abstention = boolRate([...negative, ...cross], (r) => pick(r).injectedCount === 0);
  bucket.emptyRecallRate = boolRate(usable, (r) => pick(r).empty);

  // 注入層的「召回」：期望卡實際被注入的數量與題目比例（F3 的主要證據）。
  const withExpected = usable.filter((r) => (r.question.expected_ids ?? []).length > 0);
  bucket.expectedQuestions = withExpected.length;
  bucket.questionsWithExpectedHit = withExpected.filter((r) => pick(r).hitCount > 0).length;
  bucket.expectedHitRate = bucket.expectedQuestions === 0 ? null : bucket.questionsWithExpectedHit / bucket.expectedQuestions;
  const allHit = withExpected.filter((r) => pick(r).hitCount === r.question.expected_ids.length);
  bucket.expectedAllHitRate = bucket.expectedQuestions === 0 ? null : allHit.length / bucket.expectedQuestions;

  const counts = usable.map((r) => pick(r).injectedCount);
  const chars = usable.map((r) => pick(r).chars);
  const tokens = usable.map((r) => pick(r).tokensEst);
  bucket.injectedPerQuestion = {
    mean: round(mean(counts), 2),
    p50: percentile(counts, 0.5),
    p95: percentile(counts, 0.95),
    max: counts.length === 0 ? null : Math.max(...counts),
  };
  bucket.injectedChars = {
    mean: round(mean(chars), 1),
    p50: percentile(chars, 0.5),
    p95: percentile(chars, 0.95),
    max: chars.length === 0 ? null : Math.max(...chars),
  };
  bucket.injectedTokens = {
    mean: round(mean(tokens), 1),
    p50: percentile(tokens, 0.5),
    p95: percentile(tokens, 0.95),
    max: tokens.length === 0 ? null : Math.max(...tokens),
  };

  const latencies = usable.map((r) => r.latencyMs).filter((value) => Number.isFinite(value));
  bucket.latency = {
    p50: percentile(latencies, 0.5),
    p95: percentile(latencies, 0.95),
    max: latencies.length === 0 ? null : Math.max(...latencies),
    n: latencies.length,
  };
  bucket.timeouts = records.filter((record) => record.status === "timeout").length;
  bucket.errors = records.filter((record) => record.status === "error").length;
  bucket.degraded = records.filter((record) => record.status === "degraded").length;
  bucket.total = records.length;
  bucket.excluded = records.length - usable.length;

  // 外掛 skip 的統計（production 口徑的來源）。
  bucket.skippedQuestions = usable.filter((r) => r.skipReason !== null && r.skipReason !== undefined).length;
  bucket.skippedWithExpected = usable.filter(
    (r) => r.skipReason !== null && r.skipReason !== undefined && (r.question.expected_ids ?? []).length > 0,
  ).length;
  const byReason = {};
  for (const record of usable) {
    if (record.skipReason === null || record.skipReason === undefined) continue;
    byReason[record.skipReason] = (byReason[record.skipReason] ?? 0) + 1;
  }
  bucket.skippedByReason = byReason;

  // 診斷用：去重（variant D）與跨專案命中。
  bucket.dedupedItems = usable.reduce((total, r) => total + (r.skippedDedup ?? 0), 0);
  bucket.questionsWithDedupe = boolRate(usable, (r) => (r.skippedDedup ?? 0) > 0);
  bucket.foreignInjected = usable.reduce((total, r) => total + pick(r).foreignSlugs.length, 0);
  bucket.foreignHitQuestions = usable.filter((r) => r.retrieval.foreignHits > 0).length;
  return bucket;
}

/** 子集（identifier／code identifier／語言）的召回與注入。 */
export function subsetMetrics(records, predicate, mode = "retrieval") {
  const selected = records.filter((record) => record.status === "ok" && predicate(record.question));
  const pick = (record) => (mode === "production" ? record.production : record.injection);
  const recallRecords = selected.filter((r) => ["single", "multi"].includes(r.question.category));
  const bool = (items, pickValue) => {
    const values = items.map(pickValue).filter((value) => value !== null && value !== undefined);
    return values.length === 0 ? null : values.filter(Boolean).length / values.length;
  };
  const injectedItems = selected.reduce((total, r) => total + pick(r).injectedCount, 0);
  const hitItems = selected.reduce((total, r) => total + pick(r).hitCount, 0);
  const withExpected = selected.filter((r) => (r.question.expected_ids ?? []).length > 0);
  return {
    n: selected.length,
    recall5: bool(recallRecords, (r) => r.retrieval.hit5),
    top1: bool(
      selected.filter((r) => r.question.category === "single"),
      (r) => r.retrieval.top1,
    ),
    mrr: mean(recallRecords.map((r) => r.retrieval.mrr)),
    hitItems,
    skippedQuestions: selected.filter((r) => r.skipReason !== null && r.skipReason !== undefined).length,
    expectedHitRate:
      withExpected.length === 0 ? null : withExpected.filter((r) => pick(r).hitCount > 0).length / withExpected.length,
    fpItemRate: injectedItems === 0 ? 0 : selected.reduce((total, r) => total + pick(r).fpCount, 0) / injectedItems,
  };
}
