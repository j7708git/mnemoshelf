/**
 * 矩陣的指標訊號、硬門檻與排名（純函式，沒有 IO）。
 *
 * 口徑：
 * - **JSON 成功率**：分母是「真的有呼叫模型」的回合；分子是「有模型輸出且 parser 沒有報錯」。
 *   被跳過的回合不會呼叫模型，不列入分母。`not-json`／`shape` 都算失敗。
 * - **turn 非空率**：分母是實際 digest 成功的回合；分子是回合卡內容非空。
 * - **p95**：所有模型呼叫嘗試（含失敗）的延遲；失敗不從延遲分佈剔除。 * - **逾時率**：`timeout`＋`aborted` 類別 ÷ 呼叫嘗試數。
 * - **token／成本**：端點沒回 usage 就是 `N/A`，不推估。
 */
import { percentile, round } from "../../lib/metrics.mjs";

/** production 的摘要模型逾時（`DEFAULT_DIGEST_TIMEOUT_MS`）。 */
export const PRODUCTION_DIGEST_TIMEOUT_MS = 45000;
/** p95 的絕對上限：避免模型自己把 timeoutMs 調寬就過關。 */
export const ABSOLUTE_P95_LIMIT_MS = 30000;
/** JSON 成功率的硬門檻。 */
export const JSON_SUCCESS_MIN = 0.95;

function rate(numerator, denominator) {
  return denominator === 0 ? null : numerator / denominator;
}

/**
 * 由一次模型執行的結果算出報告要用的訊號。
 *
 * @param {object} input
 * @param {object[]} input.rawTurns pipeline 的逐回合原始結果
 * @param {object[]} input.turns pipeline 的逐回合評估結果（有 mustNotIncludeHits）
 * @param {object} input.metrics aggregateMetrics() 的結果
 * @param {object[]} input.attempts 模型呼叫嘗試（含失敗）
 * @param {object} input.entry matrix-models.json 的模型項
 */
export function computeSignals({ rawTurns, turns, metrics, attempts, entry }) {
  const calledTurns = rawTurns.filter((turn) => turn.modelCalled === true);
  const jsonOkTurns = calledTurns.filter((turn) => turn.modelOutputPresent === true && turn.parseError === null);
  const digested = rawTurns.filter((turn) => turn.outcome === "digested");
  const nonEmpty = digested.filter(
    (turn) => typeof turn.turnContent === "string" && turn.turnContent.trim() !== "",
  );

  const latencies = attempts.map((attempt) => attempt.latencyMs).filter((value) => Number.isFinite(value));
  const p50 = percentile(latencies, 0.5);
  const p95 = percentile(latencies, 0.95);
  const timeouts = attempts.filter((attempt) => attempt.errorClass === "timeout" || attempt.errorClass === "aborted");
  const errorCounts = {};
  for (const attempt of attempts) {
    if (attempt.errorClass === null || attempt.errorClass === undefined) continue;
    errorCounts[attempt.errorClass] = (errorCounts[attempt.errorClass] ?? 0) + 1;
  }

  // 寫入張數分三欄，避免「原子 item 數」被誤讀成總張數。
  const turnCards = rawTurns.filter((turn) => turn.turnCardWritten === true).length;
  const atomicItems = rawTurns.reduce((sum, turn) => sum + (turn.atomicItemsWritten ?? 0), 0);
  const totalWritten = rawTurns.reduce((sum, turn) => sum + (turn.written ?? 0), 0);

  // 硬門檻命中的回合 id（只記 id，不記任何 needle 或模型輸出文字）。
  const mustNotIncludeHits = turns
    .filter((turn) => Array.isArray(turn.mustNotIncludeHits) && turn.mustNotIncludeHits.length > 0)
    .map((turn) => turn.id);
  const crossProjectHits = rawTurns.filter((turn) => turn.crossProjectHit === true).map((turn) => turn.id);

  // 去重後的「獨立事件」：同一回合的同一次輸出若同時觸發兩條門檻，只算一次。
  const eventKeys = new Set([...mustNotIncludeHits, ...crossProjectHits].map((id) => `turn:${id}`));
  // scope 層洩漏沒有回合，若存在就各算一個獨立事件。
  const scopeLeaks = Math.max(0, metrics.crossProjectLeaks - crossProjectHits.length);
  if (scopeLeaks > 0) eventKeys.add("scope");

  return {
    modelId: entry.id,
    modelCalls: calledTurns.length,
    jsonSuccess: {
      ok: jsonOkTurns.length,
      total: calledTurns.length,
      rate: round(rate(jsonOkTurns.length, calledTurns.length), 4),
    },
    turnNonEmpty: {
      ok: nonEmpty.length,
      total: digested.length,
      rate: round(rate(nonEmpty.length, digested.length), 4),
    },
    rejectedItems: metrics.itemsBudget.rejected,
    mustInclude: metrics.mustInclude,
    mustNotIncludeHits: metrics.mustNotInclude.hits,
    crossProjectLeaks: metrics.crossProjectLeaks,
    hardEvents: {
      // 兩個欄位都是「命中的回合 id」陣列；不含任何文字。
      mustNotIncludeHits,
      crossProjectHits,
      independentEvents: eventKeys.size,
      scopeLeakEvents: scopeLeaks,
    },
    writes: {
      turnCards,
      atomicItems,
      total: totalWritten,
      consistent: totalWritten === turnCards + atomicItems,
    },
    kind: metrics.kind,
    recall: metrics.recall,
    itemsBudget: metrics.itemsBudget,
    latency: {
      attempts: attempts.length,
      p50Ms: round(p50, 2),
      p95Ms: round(p95, 2),
      samplesMs: latencies.map((value) => round(value, 2)),
      modelTimeoutMs: entry.timeoutMs,
      modelBudgetMs: round(entry.timeoutMs / 2, 2),
      productionTimeoutMs: PRODUCTION_DIGEST_TIMEOUT_MS,
      productionBudgetMs: PRODUCTION_DIGEST_TIMEOUT_MS / 2,
      absoluteLimitMs: ABSOLUTE_P95_LIMIT_MS,
    },
    timeouts: {
      count: timeouts.length,
      total: attempts.length,
      rate: round(rate(timeouts.length, attempts.length), 4),
    },
    errorCounts,
  };
}

/**
 * 五條硬門檻（各自獨立，不互相取代）。
 *
 * @param {object} signals computeSignals() 的結果
 */
export function hardGates(signals) {
  const p95 = signals.latency.p95Ms;
  const hasP95 = typeof p95 === "number" && Number.isFinite(p95);
  return [
    {
      id: "mustNotInclude",
      label: "mustNotInclude 命中 = 0",
      actual: String(signals.mustNotIncludeHits),
      ok: signals.mustNotIncludeHits === 0,
    },
    {
      id: "crossProject",
      label: "跨專案洩漏 = 0",
      actual: String(signals.crossProjectLeaks),
      ok: signals.crossProjectLeaks === 0,
    },
    {
      id: "jsonSuccess",
      label: "JSON 成功率 ≥ 95%",
      actual: signals.jsonSuccess.rate === null ? "N/A（沒有模型呼叫）" : `${(signals.jsonSuccess.rate * 100).toFixed(1)}%（${signals.jsonSuccess.ok}/${signals.jsonSuccess.total}）`,
      ok: signals.jsonSuccess.rate !== null && signals.jsonSuccess.rate >= JSON_SUCCESS_MIN,
    },
    {
      id: "p95ModelBudget",
      label: `p95 ≤ 該模型 timeoutMs / 2（${signals.latency.modelTimeoutMs}ms → ${signals.latency.modelBudgetMs}ms）`,
      actual: hasP95 ? `${p95}ms` : "N/A",
      ok: hasP95 && p95 <= signals.latency.modelBudgetMs,
    },
    {
      id: "p95Absolute",
      label: `p95 ≤ ${ABSOLUTE_P95_LIMIT_MS}ms（絕對上限）`,
      actual: hasP95 ? `${p95}ms` : "N/A",
      ok: hasP95 && p95 <= ABSOLUTE_P95_LIMIT_MS,
    },
  ];
}

/**
 * 每條硬條件在「canned 抽取式基線」下的鑑別力。
 *
 * canned 只讀助理回覆、輸出一定是自製 JSON、延遲近乎 0，所以部分條件是**結構性成立**，
 * 不能拿來宣稱真模型安全。這張表會原樣寫進矩陣報告。
 */
export const DISCRIMINATION = [
  {
    id: "mustNotInclude",
    condition: "mustNotInclude 命中 = 0",
    canned: "結構性成立（無鑑別力）",
    real: "有鑑別力",
    why: "canned 只讀助理回覆；本 fixture 的禁止詞只在使用者句，canned 結構上不可能輸出。真模型的 prompt 含整回合文字。",
  },
  {
    id: "crossProject",
    condition: "跨專案洩漏 = 0",
    canned: "內容層結構性成立；scope 層是真檢查",
    real: "有鑑別力（尤其內容層）",
    why: "內容層同上；scope 層是外來 host 對真 server 查詢／列舉，任何模型都一樣，屬於管線檢查。",
  },
  {
    id: "jsonSuccess",
    condition: "JSON 成功率 ≥ 95%",
    canned: "結構性成立（無鑑別力）",
    real: "有鑑別力",
    why: "canned 的輸出就是自己產生的 JSON；真模型才可能回非 JSON 或形狀不符。",
  },
  {
    id: "p95ModelBudget",
    condition: "p95 ≤ 該模型 timeoutMs / 2",
    canned: "結構性成立（無鑑別力）",
    real: "有鑑別力",
    why: "canned 的 p95 約 0.15ms，任何 timeout 都會過；真模型的網路與生成時間才是被量測的對象。",
  },
  {
    id: "p95Absolute",
    condition: "p95 ≤ 30000ms",
    canned: "結構性成立（無鑑別力）",
    real: "有鑑別力",
    why: "同上；絕對上限是為了防止「把 timeoutMs 調寬就過關」。",
  },
];

/**
 * 排名：先比硬門檻通過數，再比 mustInclude、kind、端到端召回，最後 p95 低者優先。
 * 只排 `RANKED` 的模型；NOT RUN／ERROR 依原順序附在後面。
 *
 * @param {object[]} results 每個模型的結果（含 status／signals／gates）
 */
export function rankResults(results) {
  const ranked = results
    .filter((result) => result.status === "RANKED" && result.signals !== null)
    .slice()
    .sort((left, right) => {
      const leftGates = left.gates.filter((gate) => gate.ok).length;
      const rightGates = right.gates.filter((gate) => gate.ok).length;
      if (leftGates !== rightGates) return rightGates - leftGates;
      const leftInclude = left.signals.mustInclude.rate ?? -1;
      const rightInclude = right.signals.mustInclude.rate ?? -1;
      if (leftInclude !== rightInclude) return rightInclude - leftInclude;
      const leftKind = left.signals.kind.rate ?? -1;
      const rightKind = right.signals.kind.rate ?? -1;
      if (leftKind !== rightKind) return rightKind - leftKind;
      const leftRecall = left.signals.recall.endToEndRate ?? -1;
      const rightRecall = right.signals.recall.endToEndRate ?? -1;
      if (leftRecall !== rightRecall) return rightRecall - leftRecall;
      return (left.signals.latency.p95Ms ?? Number.MAX_SAFE_INTEGER) -
        (right.signals.latency.p95Ms ?? Number.MAX_SAFE_INTEGER);
    });
  for (const [index, result] of ranked.entries()) result.rank = index + 1;
  const rest = results.filter((result) => result.status !== "RANKED");
  for (const result of rest) result.rank = null;
  return [...ranked, ...rest];
}

/** 全體是否「每個模型都跑完且五條硬門檻全過」。 */
export function allHardPass(results) {
  return (
    results.length > 0 &&
    results.every(
      (result) =>
        result.status === "RANKED" &&
        Array.isArray(result.gates) &&
        result.gates.every((gate) => gate.ok),
    )
  );
}
