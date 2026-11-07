/** 歷史摘要評測的純函式、fixture 與量測測試。 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  MAX_DIGEST_ITEMS,
  buildDigestCards,
  parseDigestItems,
  resolveDigestTurn,
} from "../src/digest.js";
import { cannedBaselineResponse, promptSections, splitSentences } from "../eval/digest/lib/canned.mjs";
import { loadFixtures, privacyFindings } from "../eval/digest/lib/fixtures.mjs";
import { aggregateMetrics, evaluateTurn, hardConditions, softThresholds } from "../eval/digest/lib/metrics.mjs";
import { countRawItems, digestPostBody } from "../eval/digest/lib/pipeline.mjs";
import { renderMarkdown } from "../eval/digest/lib/report.mjs";
import { includesNeedle, needleLength, normalizeForMatch } from "../eval/digest/lib/text.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = path.resolve(HERE, "..");
const FIXTURE_DIR = path.join(PACKAGE_DIR, "eval", "digest", "fixtures");

/* ------------------------------------------------------------------ *
 * 1. 輸出形狀（寫死，不可設定）
 * ------------------------------------------------------------------ */

/** 引號片段都真的出現在原文裡；`quote` 驗證會逐句比對。 */
const SHAPE_SOURCE = "第一句：決定採用指數退避。第二句：快取上限是 32。第三句：日誌用 snake_case。";

const THREE_ITEMS = [
  { content: "指數退避可以避免重試風暴。", kind: "decision", quote: "指數退避" },
  { content: "快取需要上限。", kind: "pitfall", quote: "快取上限" },
  { content: "日誌欄位用 snake_case。", kind: "preference", quote: "snake_case" },
];

describe("buildDigestCards：輸出形狀固定", () => {
  it("turn＋3 items → 3 張（回合卡在前、items 由 parser 截到 2）", () => {
    const parsed = parseDigestItems(
      JSON.stringify({ turn: "回合紀錄", items: THREE_ITEMS }),
      SHAPE_SOURCE,
      MAX_DIGEST_ITEMS,
    );
    expect(parsed.error).toBeUndefined();
    expect(parsed.items).toHaveLength(2);
    const cards = buildDigestCards(parsed);
    expect(cards).toHaveLength(3);
    expect(cards[0]).toEqual({
      item: { content: "回合紀錄", kind: "fact", quote: "" },
      agent: "opencode-plugin/turn",
      force: true,
    });
    expect(cards.slice(1).map((card) => card.item.content)).toEqual([
      "指數退避可以避免重試風暴。",
      "快取需要上限。",
    ]);
    expect(cards.slice(1).every((card) => card.agent === "opencode-plugin" && card.force === false)).toBe(true);
    expect(buildDigestCards(parsed).length).toBe(3);
  });

  it("只有 items（3 則原始輸出）→ 2 張，且沒有回合卡", () => {
    const parsed = parseDigestItems(JSON.stringify({ items: THREE_ITEMS }), SHAPE_SOURCE, MAX_DIGEST_ITEMS);
    expect(parsed.turn).toBeNull();
    const cards = buildDigestCards(parsed);
    expect(cards).toHaveLength(2);
    expect(cards.every((card) => card.agent === "opencode-plugin")).toBe(true);
  });

  it("空結果 → 0 張（不造假回合卡）", () => {
    const parsed = parseDigestItems('{"turn":"","items":[]}', SHAPE_SOURCE, MAX_DIGEST_ITEMS);
    expect(buildDigestCards(parsed)).toEqual([]);
    expect(buildDigestCards(parsed).length).toBe(0);
  });
});

describe("30 回合 synthetic fixture", () => {
  it("30 回合、涵蓋跳過／decision／pitfall／preference／fact／跨專案，且通過隱私樣式", async () => {
    const fixtures = await loadFixtures(FIXTURE_DIR);
    expect(fixtures.turns).toBe(30);
    expect(fixtures.version).toBe("digest-conversations-v1+digest-expectations-v1");

    const turns = fixtures.conversations.turns as Array<{ id: string; mode: string }>;
    expect(turns.filter((turn) => turn.mode === "syntheticOnly")).toHaveLength(1);
    const skipReasons = Object.values(fixtures.expectations.turns as Record<string, { expectSkip?: string }>)
      .map((expectation) => expectation.expectSkip)
      .filter((reason) => typeof reason === "string");
    expect(new Set(skipReasons)).toEqual(new Set(["no-user", "short"]));

    const allExpectedItems = Object.values(
      fixtures.expectations.turns as Record<string, { expectedItems?: { kind: string }[] }>,
    ).flatMap((expectation) => expectation.expectedItems ?? []);
    expect(new Set(allExpectedItems.map((entry) => entry.kind))).toEqual(
      new Set(["decision", "pitfall", "preference", "fact"]),
    );

    const mustNotInclude = Object.values(
      fixtures.expectations.turns as Record<string, { mustNotInclude?: string[] }>,
    ).flatMap((expectation) => expectation.mustNotInclude ?? []);
    expect(mustNotInclude).toContain("貝塔專案");

    const recallQueries = Object.values(
      fixtures.expectations.turns as Record<string, { recallQuery?: string }>,
    ).filter((expectation) => typeof expectation.recallQuery === "string");
    expect(recallQueries.length).toBeGreaterThanOrEqual(15);
    expect(fixtures.expectations.crossProject.foreignProject).toBe("beta");

    for (const file of ["conversations.json", "digest-expectations.json"]) {
      const text = await fs.readFile(path.join(FIXTURE_DIR, file), "utf8");
      expect(privacyFindings(text)).toEqual([]);
    }
  });
});

describe("比對規則（寫死）", () => {
  it("正規化：去空白、全形轉半形、忽略大小寫；最短 4 字", () => {
    expect(normalizeForMatch(" 採用　Ｐ９５ ")).toBe("採用p95");
    expect(includesNeedle("門檻採用 P95 當標準", "採用p95")).toBe(true);
    expect(needleLength(" p95 ")).toBe(3);
    expect(needleLength("採用p95")).toBe(5);
    expect(includesNeedle("SQLite 當儲存層", "sqlite")).toBe(true);
  });

  it("evaluateTurn／aggregateMetrics 的口徑：mustNotInclude 命中即失敗、kind 需同時符合、召回需查詢命中且注入", () => {
    const actual = {
      outcome: "digested",
      skipReason: null,
      written: 2,
      turnContent: "這一輪決定採用指數退避。",
      items: [{ content: "指數退避可以避免重試風暴。", kind: "decision" }],
      rawItemCount: 3,
      keptItemCount: 1,
      rejected: 0,
      parseError: null,
      latencyMs: 10,
      recall: { queryHit: true, injected: true },
    };
    const evaluated = evaluateTurn({
      id: "t04",
      expectation: {
        expectEmpty: false,
        mustInclude: ["指數退避"],
        mustNotInclude: ["貝塔專案"],
        expectedItems: [
          { kind: "decision", contains: "指數退避" },
          { kind: "fact", contains: "沒有這句" },
        ],
      },
      actual,
    });
    expect(evaluated.mustIncludeMissing).toEqual([]);
    expect(evaluated.mustNotIncludeHits).toEqual([]);
    expect(evaluated.kindDetail.map((entry: { ok: boolean }) => entry.ok)).toEqual([true, false]);

    const metrics = aggregateMetrics([evaluated], {
      digestTimeoutMs: 45000,
      modelLatencies: [10, 20, 30],
      crossProjectLeaks: 0,
    });
    expect(metrics.mustInclude.rate).toBe(1);
    expect(metrics.kind.rate).toBe(0.5);
    expect(metrics.recall.endToEndRate).toBe(1);
    expect(metrics.itemsBudget.rawItems).toBe(3);
    expect(metrics.itemsBudget.keptByParser).toBe(1);
    expect(metrics.timeoutBudget.ok).toBe(true);
    expect(hardConditions(metrics).every((entry) => entry.ok)).toBe(true);
    expect(softThresholds(metrics).find((entry) => entry.id === "kind")?.met).toBe(false);
  });

  it("報告把未達標的軟門檻標成 INFO（未達標，待校準），不得顯示 PASS", () => {
    const markdown = renderMarkdown({
      generatedAt: "2026-10-23T00:00:00.000Z",
      durationMs: 1000,
      git: { short: "abcdef0", dirty: false, dirtyFileCount: 0 },
      fixture: { version: "v1", turns: 30, fingerprint: "0123456789ab" },
      model: { id: "canned/x", kind: "canned", paid: false },
      build: { rebuilt: false, reason: null },
      hardConditions: [{ id: "mustNotInclude", label: "mustNotInclude 命中 = 0", actual: 0, ok: true }],
      softThresholds: [
        { id: "kind", label: "kind 命中率 ≥ 80%", actual: 0.5, threshold: 0.8, met: false },
        { id: "recall", label: "端到端召回 ≥ 90%", actual: 1, threshold: 0.9, met: true },
      ],
      metrics: {
        turns: 30,
        digested: 27,
        skipped: 3,
        failed: 0,
        skipReasons: { short: 2, "no-user": 1 },
        failedReasons: {},
        skipExpectation: { correct: 3, expected: 3 },
        emptyExpectation: { correct: 3, expected: 3, nonEmpty: 27, nonEmptyWithWrites: 27 },
        mustInclude: { passed: 1, turnsWithExpectation: 1, rate: 1 },
        mustNotInclude: { hits: 0 },
        crossProjectLeaks: 0,
        kind: { hits: 1, expected: 2, rate: 0.5 },
        recall: { endToEnd: 1, expectedTurns: 1, endToEndRate: 1, queryHitRate: 1, injectionRate: 1 },
        itemsBudget: {
          rawItems: 3,
          keptByParser: 1,
          writtenCards: 1,
          rejected: 0,
          overLimitTurns: 1,
        },
        latency: { modelP50: 1, modelP95: 2, turnP50: 3, turnP95: 4 },
        timeoutBudget: { digestTimeoutMs: 45000, redundantThresholdMs: 4, ok: true },
      },
      crossProject: { contentLeaks: 0, scopeLeaks: 0 },
      parity: { ok: true, mismatches: [] },
      usage: { tokens: "N/A", cost: "N/A", note: "canned 模型沒有 usage。" },
      turns: [],
    });
    expect(markdown).toContain("INFO（未達標，待校準）");
    expect(markdown).toContain("INFO（達標）");
    expect(markdown).not.toMatch(/\|\s*PASS\s*\|[^\n]*kind/);
  });
});

describe("canned 基線與原始 items 計數", () => {
  it("canned 回應是確定性的抽取式結果（turn 取前兩句，items 最多 3 筆）", () => {
    const prompt = [
      "這一回合的使用者訊息：",
      "請整理重試策略。",
      "",
      "助理這一回合的最終回覆：",
      "決定把重試間隔改成指數退避。這樣可以避免任務佔滿佇列。踩到沒有加抖動的坑。",
      "偏好日誌欄位用 snake_case。",
    ].join("\n");
    const first = cannedBaselineResponse(prompt);
    const second = cannedBaselineResponse(prompt);
    expect(first).toEqual(second);
    const parsed = JSON.parse(first.text) as { turn: string; items: { kind: string }[] };
    expect(parsed.turn).toBe("回合紀錄：決定把重試間隔改成指數退避。這樣可以避免任務佔滿佇列。");
    expect(parsed.items.map((entry) => entry.kind)).toEqual(["decision", "pitfall", "preference"]);
    expect(promptSections(prompt).user).toContain("重試策略");
    expect(splitSentences("第一句。第二句！第三句").length).toBeGreaterThanOrEqual(2);
  });

  it("countRawItems 數的是模型原始 items 陣列（不是 parser 保留數）", () => {
    expect(countRawItems(JSON.stringify({ items: THREE_ITEMS }))).toBe(3);
    expect(countRawItems("```json\n" + JSON.stringify({ items: THREE_ITEMS }) + "\n```")).toBe(3);
    expect(countRawItems("不是 JSON")).toBe(0);
  });
});
