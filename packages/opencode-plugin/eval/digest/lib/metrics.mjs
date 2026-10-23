/**
 * L3 的指標（純函式，沒有 IO）。
 *
 * 名詞與口徑：
 * - `mustInclude` 通過率：該回合所有 mustInclude 都命中才算通過；分母是**有 mustInclude 的回合數**。
 * - `mustNotInclude`：命中即該回合失敗（硬條件），總命中數必須為 0。
 * - kind 命中率：期望 items 中，存在一筆 content 含 `contains` 且 kind 相符的實際 item；
 *   分母是**期望 items 總數**。
 * - 端到端召回：有 recallQuery 的回合中，「server 查詢命中 recallMarker」且「實際注入的
 *   `<memory-context>` 區塊含 recallMarker」的回合比例。
 * - 逾時預算：production 的 `digestTimeoutMs` ≥ 2 × 模型呼叫延遲 p95。
 */
import { percentile, round } from "../../lib/metrics.mjs";
import { hitNeedles, includesNeedle, missingNeedles } from "./text.mjs";

/**
 * 比對單一回合的期望與實際結果。
 *
 * @param {object} input
 * @param {string} input.id 回合 id（fixture 的 t01…）
 * @param {object} input.expectation fixture 期望值
 * @param {object} input.actual 實際結果（見 run.mjs）
 */
export function evaluateTurn({ id, expectation, actual }) {
  const expected = expectation ?? {};
  const outputTexts = [actual.turnContent ?? "", ...(actual.items ?? []).map((item) => item.content)];
  const mustInclude = expected.mustInclude ?? [];
  const mustNotInclude = expected.mustNotInclude ?? [];
  const mustIncludeMissing = missingNeedles(outputTexts, mustInclude);
  const mustNotIncludeHits = hitNeedles(outputTexts, mustNotInclude);

  const expectEmpty = expected.expectEmpty === true;
  const expectSkip = typeof expected.expectSkip === "string" ? expected.expectSkip : null;
  const emptyOk = expectEmpty ? actual.written === 0 : actual.written > 0;
  const skipOk =
    expectSkip === null ? true : actual.outcome === "skipped" && actual.skipReason === expectSkip;

  const kindDetail = [];
  for (const wanted of expected.expectedItems ?? []) {
    const matched = (actual.items ?? []).some(
      (item) => includesNeedle(item.content, wanted.contains) && item.kind === wanted.kind,
    );
    kindDetail.push({ kind: wanted.kind, contains: wanted.contains, ok: matched });
  }

  return {
    id,
    outcome: actual.outcome,
    skipReason: actual.skipReason,
    written: actual.written,
    mustInclude,
    mustIncludeMissing,
    mustNotIncludeHits,
    expectEmpty,
    emptyOk,
    expectSkip,
    skipOk,
    kindDetail,
    rawItemCount: actual.rawItemCount ?? 0,
    keptItemCount: actual.keptItemCount ?? 0,
    writtenItemCount: (actual.items ?? []).length,
    turnCardWritten: actual.turnCardWritten === true,
    atomicItemsWritten: actual.atomicItemsWritten ?? 0,
    crossProjectHit: actual.crossProjectHit === true,
    rejected: actual.rejected ?? 0,
    parseError: actual.parseError ?? null,
    latencyMs: actual.latencyMs ?? 0,
    recall: actual.recall ?? null,
  };
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

/**
 * 聚合逐回合結果。
 *
 * @param {object[]} turns evaluateTurn() 的輸出
 * @param {object} input
 * @param {number} input.digestTimeoutMs production 口徑的模型 timeout
 * @param {number[]} input.modelLatencies 每次模型呼叫的延遲（毫秒）
 * @param {number} input.crossProjectLeaks 跨專案洩漏數（內容層＋scope 層，由 pipeline 算好）
 */
export function aggregateMetrics(turns, { digestTimeoutMs, modelLatencies, crossProjectLeaks }) {
  const withInclude = turns.filter((turn) => turn.mustInclude.length > 0);
  const includePass = withInclude.filter((turn) => turn.mustIncludeMissing.length === 0).length;
  const mustIncludeRate = withInclude.length === 0 ? null : includePass / withInclude.length;

  const mustNotIncludeHits = sum(turns.map((turn) => turn.mustNotIncludeHits.length));

  const kindExpected = sum(turns.map((turn) => turn.kindDetail.length));
  const kindHits = sum(turns.map((turn) => turn.kindDetail.filter((entry) => entry.ok).length));
  const kindRate = kindExpected === 0 ? null : kindHits / kindExpected;

  const recallTurns = turns.filter((turn) => turn.recall !== null);
  const recallHits = recallTurns.filter((turn) => turn.recall.queryHit && turn.recall.injected).length;
  const e2eRecallRate = recallTurns.length === 0 ? null : recallHits / recallTurns.length;
  const queryHitRate =
    recallTurns.length === 0
      ? null
      : recallTurns.filter((turn) => turn.recall.queryHit).length / recallTurns.length;
  const injectedRate =
    recallTurns.length === 0
      ? null
      : recallTurns.filter((turn) => turn.recall.injected).length / recallTurns.length;

  const p50 = percentile(modelLatencies, 0.5);
  const p95 = percentile(modelLatencies, 0.95);
  const budgetOk = (p95 ?? 0) === 0 ? true : digestTimeoutMs >= 2 * (p95 ?? 0);

  const rawItems = sum(turns.map((turn) => turn.rawItemCount));
  const keptItems = sum(turns.map((turn) => turn.keptItemCount));
  const writtenItems = sum(turns.map((turn) => turn.writtenItemCount));

  const skipped = turns.filter((turn) => turn.outcome === "skipped");
  const failed = turns.filter((turn) => turn.outcome === "failed");

  return {
    turns: turns.length,
    digested: turns.filter((turn) => turn.outcome === "digested").length,
    skipped: skipped.length,
    failed: failed.length,
    failedReasons: countBy(failed.map((turn) => turn.skipReason ?? "unknown")),
    skipReasons: countBy(skipped.map((turn) => turn.skipReason ?? "unknown")),
    skipExpectation: {
      expected: turns.filter((turn) => turn.expectSkip !== null).length,
      correct: turns.filter((turn) => turn.expectSkip !== null && turn.skipOk).length,
    },
    emptyExpectation: {
      expected: turns.filter((turn) => turn.expectEmpty).length,
      correct: turns.filter((turn) => turn.expectEmpty && turn.emptyOk).length,
      nonEmpty: turns.filter((turn) => !turn.expectEmpty).length,
      nonEmptyWithWrites: turns.filter((turn) => !turn.expectEmpty && turn.written > 0).length,
    },
    mustInclude: {
      turnsWithExpectation: withInclude.length,
      passed: includePass,
      rate: round(mustIncludeRate, 4),
      missing: turns
        .filter((turn) => turn.mustIncludeMissing.length > 0)
        .map((turn) => ({ id: turn.id, missing: turn.mustIncludeMissing })),
    },
    mustNotInclude: { hits: mustNotIncludeHits },
    crossProjectLeaks,
    kind: {
      expected: kindExpected,
      hits: kindHits,
      rate: round(kindRate, 4),
      misses: turns.flatMap((turn) =>
        turn.kindDetail.filter((entry) => !entry.ok).map((entry) => ({
          id: turn.id,
          kind: entry.kind,
          contains: entry.contains,
        })),
      ),
    },
    recall: {
      expectedTurns: recallTurns.length,
      queryHits: recallTurns.filter((turn) => turn.recall.queryHit).length,
      injected: recallTurns.filter((turn) => turn.recall.injected).length,
      endToEnd: recallHits,
      queryHitRate: round(queryHitRate, 4),
      injectionRate: round(injectedRate, 4),
      endToEndRate: round(e2eRecallRate, 4),
    },
    itemsBudget: {
      rawItems,
      keptByParser: keptItems,
      writtenCards: writtenItems,
      rejected: sum(turns.map((turn) => turn.rejected)),
      overLimitTurns: turns.filter((turn) => turn.rawItemCount > turn.keptItemCount).length,
    },
    latency: {
      modelP50: round(p50, 2),
      modelP95: round(p95, 2),
      turnP50: round(percentile(turns.map((turn) => turn.latencyMs), 0.5), 2),
      turnP95: round(percentile(turns.map((turn) => turn.latencyMs), 0.95), 2),
    },
    timeoutBudget: {
      digestTimeoutMs,
      redundantThresholdMs: round(p95 === null ? null : 2 * p95, 2),
      ok: budgetOk,
    },
  };
}

function countBy(values) {
  const counts = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

/** 軟門檻（先當報告，不影響退出碼）。 */
export function softThresholds(metrics) {
  return [
    {
      id: "mustInclude",
      label: "mustInclude 通過率 ≥ 90%",
      actual: metrics.mustInclude.rate,
      threshold: 0.9,
      met: metrics.mustInclude.rate !== null && metrics.mustInclude.rate >= 0.9,
    },
    {
      id: "kind",
      label: "kind 命中率 ≥ 80%",
      actual: metrics.kind.rate,
      threshold: 0.8,
      met: metrics.kind.rate !== null && metrics.kind.rate >= 0.8,
    },
    {
      id: "recall",
      label: "端到端召回 ≥ 90%",
      actual: metrics.recall.endToEndRate,
      threshold: 0.9,
      met: metrics.recall.endToEndRate !== null && metrics.recall.endToEndRate >= 0.9,
    },
  ];
}

/** 硬條件（會影響退出碼）。 */
export function hardConditions(metrics) {
  return [
    {
      id: "mustNotInclude",
      label: "mustNotInclude 命中 = 0",
      actual: metrics.mustNotInclude.hits,
      ok: metrics.mustNotInclude.hits === 0,
    },
    {
      id: "crossProject",
      label: "跨專案洩漏 = 0",
      actual: metrics.crossProjectLeaks,
      ok: metrics.crossProjectLeaks === 0,
    },
    {
      id: "timeoutBudget",
      label: "digestTimeoutMs ≥ 2 × 模型延遲 p95",
      actual: `${metrics.timeoutBudget.digestTimeoutMs}ms vs p95=${metrics.latency.modelP95}`,
      ok: metrics.timeoutBudget.ok,
    },
  ];
}
