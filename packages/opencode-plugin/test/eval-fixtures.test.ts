/**
 * D3 評估資料集與選值規則的測試。
 *
 * 這些測試**不跑 server**：fixture 的完整性與「決策規則」都可以離線檢查。
 * 真正的召回數字要用 `pnpm --filter @mnemoshelf/opencode-plugin eval` 量。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 記憶卡內容的禁用樣式（真實 email、憑證、本機絕對路徑）。
 *
 * 清單本身在 `test/forbidden-patterns.ts`：卡片與查詢題庫兩邊共用同一份，
 * 才不會再各自漂移。樣式的自我驗證在 `forbidden-patterns.test.ts`。
 */
import { FORBIDDEN_PATTERNS } from "./forbidden-patterns.js";

interface Card {
  id: string;
  project?: string;
  scope?: string;
  kind: string;
  content: string;
  pinned?: boolean;
  force?: boolean;
  superseded?: boolean;
  supersedes?: string;
}

interface Question {
  id: string;
  project: string;
  category: "single" | "multi" | "update" | "negative" | "cross";
  split: "dev" | "test";
  lang: "zh" | "en";
  query: string;
  expected_ids: string[];
  acceptable_ids?: string[];
  forbidden_ids: string[];
  identifier?: boolean;
  code_identifier?: boolean;
  cross_check_id?: string;
}

const fixturesDir = new URL("../eval/fixtures/", import.meta.url);

function readFixture<T>(name: string): T {
  return JSON.parse(readFileSync(fileURLToPath(new URL(name, fixturesDir)), "utf8")) as T;
}

const cards = readFixture<{ cards: Card[] }>("cards.json").cards;
const questions = readFixture<{ questions: Question[] }>("questions.json").questions;
const cardById = new Map(cards.map((card) => [card.id, card]));
const supersededIds = new Set(cards.filter((card) => card.superseded === true).map((card) => card.id));

/**
 * 動態 import eval 的 `.mjs` 模組（模組沒有 `.d.ts`，specifier 用變數傳入 → TS 不檢查型別）。
 * 用絕對 file URL ＋ `@vite-ignore`，避免 Vite 試著改寫這個 import。
 */
const EVAL_LIB_DIR = new URL("../eval/lib/", import.meta.url);

async function importEvalModule<T>(file: string): Promise<T> {
  return (await import(/* @vite-ignore */ new URL(file, EVAL_LIB_DIR).href)) as T;
}

describe("D3 fixtures：卡片", () => {
  it("數量與專案分佈符合卡片要求（3 專案＋global，總數約 90）", () => {
    expect(cards.length).toBeGreaterThanOrEqual(85);
    expect(cards.length).toBeLessThanOrEqual(100);
    const byProject = new Map<string, number>();
    for (const card of cards) {
      const key = card.scope === "global" ? "global" : (card.project ?? "?");
      byProject.set(key, (byProject.get(key) ?? 0) + 1);
    }
    for (const project of ["alpha", "beta", "gamma"]) {
      expect(byProject.get(project) ?? 0).toBeGreaterThanOrEqual(25);
      expect(byProject.get(project) ?? 0).toBeLessThanOrEqual(30);
    }
    expect(byProject.get("global")).toBe(10);
  });

  it("slug 唯一、kind 合法、global 卡沒有 project", () => {
    const ids = new Set<string>();
    for (const card of cards) {
      expect(card.id).toMatch(/^[a-z0-9-]+$/);
      expect(ids.has(card.id)).toBe(false);
      ids.add(card.id);
      expect(["fact", "decision", "pitfall", "preference"]).toContain(card.kind);
      expect(card.content.length).toBeGreaterThanOrEqual(10);
      if (card.scope === "global") expect(card.project).toBeUndefined();
      else expect(["alpha", "beta", "gamma"]).toContain(card.project);
    }
  });

  it("supersede 鏈完整：舊卡標記 superseded、新卡排在舊卡之後", () => {
    const pairs = cards.filter((card) => card.supersedes !== undefined);
    expect(pairs.length).toBeGreaterThanOrEqual(18);
    for (const pair of pairs) {
      const old = cardById.get(pair.supersedes as string);
      expect(old).toBeDefined();
      expect(old?.superseded).toBe(true);
      expect(cards.indexOf(old as Card)).toBeLessThan(cards.indexOf(pair));
      expect(old?.project).toBe(pair.project);
    }
  });

  it("有 pinned 與近重複（force）卡", () => {
    expect(cards.filter((card) => card.pinned === true).length).toBeGreaterThanOrEqual(5);
    const forced = cards.filter((card) => card.force === true);
    expect(forced.length).toBeGreaterThanOrEqual(3);
    // force 卡的內容要與某張同專案卡高度重疊（近似重複，不是隨便一張）。
    const bigrams = (text: string): Set<string> => {
      const normalized = text.replace(/\s+/g, "");
      const set = new Set<string>();
      for (let index = 0; index + 1 < normalized.length; index += 1) set.add(normalized.slice(index, index + 2));
      return set;
    };
    const overlap = (a: string, b: string): number => {
      const left = bigrams(a);
      const right = bigrams(b);
      if (left.size === 0 || right.size === 0) return 0;
      let shared = 0;
      for (const gram of left) if (right.has(gram)) shared += 1;
      return shared / Math.min(left.size, right.size);
    };
    for (const card of forced) {
      const sibling = cards.some(
        (other) =>
          other !== card &&
          other.project === card.project &&
          other.kind === card.kind &&
          overlap(other.content, card.content) >= 0.5,
      );
      expect(sibling).toBe(true);
    }
  });

  it("不得含真實 email、憑證、本機絕對路徑", () => {
    for (const card of cards) {
      for (const { name, pattern } of FORBIDDEN_PATTERNS) {
        const match = pattern.exec(card.content);
        // 失敗訊息要指出是哪張卡、哪條樣式（而不是只丟整段內容）。
        expect(
          match === null ? undefined : match[0],
          `卡片 ${card.id} 命中禁用樣式 ${name}`,
        ).toBeUndefined();
      }
    }
  });
});

describe("D3 fixtures：題目", () => {
  it("120 題，dev／test 各 60，五類配比符合卡片", () => {
    expect(questions.length).toBe(120);
    const bySplit = { dev: 0, test: 0 };
    const byCategory = new Map<string, number>();
    for (const question of questions) {
      bySplit[question.split] += 1;
      byCategory.set(question.category, (byCategory.get(question.category) ?? 0) + 1);
    }
    expect(bySplit).toEqual({ dev: 60, test: 60 });
    expect(byCategory.get("single")).toBe(50);
    expect(byCategory.get("multi")).toBe(20);
    expect(byCategory.get("update")).toBe(20);
    expect(byCategory.get("negative")).toBe(15);
    expect(byCategory.get("cross")).toBe(15);
  });

  it("negative 與 cross 在兩個 split 都有", () => {
    for (const split of ["dev", "test"] as const) {
      expect(questions.filter((q) => q.split === split && q.category === "negative").length).toBeGreaterThanOrEqual(6);
      expect(questions.filter((q) => q.split === split && q.category === "cross").length).toBeGreaterThanOrEqual(6);
    }
  });

  it("id 唯一、query 不重複", () => {
    expect(new Set(questions.map((q) => q.id)).size).toBe(questions.length);
    expect(new Set(questions.map((q) => q.query.trim())).size).toBe(questions.length);
    for (const question of questions) expect(question.id).toMatch(/^q\d{3}$/);
  });

  it("標註參照的 slug 都存在，且 expected 在提問專案可見", () => {
    for (const question of questions) {
      for (const slug of [...question.expected_ids, ...(question.acceptable_ids ?? []), ...(question.forbidden_ids ?? [])]) {
        expect(cardById.has(slug)).toBe(true);
      }
      for (const slug of question.expected_ids) {
        const card = cardById.get(slug) as Card;
        expect(supersededIds.has(slug)).toBe(false);
        if (card.scope !== "global") expect(card.project).toBe(question.project);
      }
    }
  });

  it("各類別的 expected／forbidden 形狀正確", () => {
    for (const question of questions) {
      if (question.category === "single") expect(question.expected_ids).toHaveLength(1);
      if (question.category === "multi") expect(question.expected_ids.length).toBeGreaterThanOrEqual(2);
      if (question.category === "update") {
        expect(question.expected_ids).toHaveLength(1);
        expect(question.forbidden_ids ?? []).toHaveLength(1);
        expect(supersededIds.has(question.forbidden_ids![0] as string)).toBe(true);
        const old = cardById.get(question.forbidden_ids![0] as string) as Card;
        expect(old.supersedes).toBeUndefined();
        expect(cards.find((card) => card.supersedes === old.id)?.id).toBe(question.expected_ids[0]);
      }
      if (question.category === "negative") {
        expect(question.expected_ids).toHaveLength(0);
        expect(question.forbidden_ids ?? []).toHaveLength(0);
      }
      if (question.category === "cross") {
        expect(question.expected_ids).toHaveLength(0);
        expect((question.forbidden_ids ?? []).length).toBeGreaterThanOrEqual(1);
        expect(question.cross_check_id).toBeDefined();
        expect(question.forbidden_ids ?? []).toContain(question.cross_check_id as string);
      }
    }
  });

  it("identifier 子集 ≥20 題，其中 code identifier 至少一半", () => {
    const identifier = questions.filter((question) => question.identifier === true);
    const code = questions.filter((question) => question.code_identifier === true);
    expect(identifier.length).toBeGreaterThanOrEqual(20);
    expect(code.length).toBeGreaterThanOrEqual(Math.ceil(identifier.length / 2));
    for (const question of code) expect(question.identifier).toBe(true);
    // code identifier 題不能全是同一類別。
    expect(new Set(code.map((question) => question.category)).size).toBeGreaterThanOrEqual(2);
  });

  it("中文題 ≥60、英文題 ≥15", () => {
    expect(questions.filter((question) => question.lang === "zh").length).toBeGreaterThanOrEqual(60);
    expect(questions.filter((question) => question.lang === "en").length).toBeGreaterThanOrEqual(15);
  });

  it("query 不照抄卡片內容（避免 lexical leakage）", () => {
    for (const question of questions) {
      for (const slug of question.expected_ids) {
        const content = (cardById.get(slug) as Card).content;
        // 卡片開頭 24 個字不該原樣出現在 query（短標識、專有名詞重疊是正常的）。
        const longest = content.slice(0, 24);
        if (longest.length === 24) expect(question.query.includes(longest)).toBe(false);
      }
    }
  });
});

describe("D3 指標與選值規則", () => {
  it("estimateTokens：CJK 每字 1、ASCII 4 字元 1", async () => {
    const { estimateTokens } = await importEvalModule<{
      estimateTokens: (text: string) => number;
    }>("metrics.mjs");
    expect(estimateTokens("記憶")).toBe(2);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("記憶abcd")).toBe(3);
  });

  it("retrievalMetrics：單目標 Top-1／多目標全進前 5／stale 判定", async () => {
    const { retrievalMetrics } = await importEvalModule<{
      retrievalMetrics: (question: Question, hits: { id: number; slug: string }[]) => Record<string, unknown>;
    }>("metrics.mjs");
    const single = retrievalMetrics(
      { ...questions[0]!, expected_ids: ["x"], forbidden_ids: [] },
      [{ id: 7, slug: "y" }, { id: 8, slug: "x" }],
    ) as { top1: boolean; hit5: boolean; mrr: number };
    expect(single.top1).toBe(false);
    expect(single.hit5).toBe(true);
    expect(single.mrr).toBeCloseTo(0.5);

    const multi = retrievalMetrics(
      { ...questions[0]!, category: "multi", expected_ids: ["x", "y"], forbidden_ids: [] },
      [{ id: 1, slug: "y" }, { id: 2, slug: "z" }, { id: 3, slug: "w" }],
    ) as { hit5: boolean };
    expect(multi.hit5).toBe(false);

    const stale = retrievalMetrics(
      { ...questions[0]!, category: "update", expected_ids: ["x"], forbidden_ids: ["z"] },
      [{ id: 3, slug: "z" }, { id: 4, slug: "w" }],
    ) as { staleInTop5: boolean; hit5: boolean };
    expect(stale.staleInTop5).toBe(true);
    expect(stale.hit5).toBe(false);
  });

  const bucket = (overrides: Record<string, unknown>) => ({
    fpItemRate: 0.05,
    fpItems: 12,
    injectedItems: 240,
    hitItems: 47,
    negativeInjectionRate: 0.4,
    crossInjectionRate: 1,
    abstention: 0.95,
    recall5: 0.9,
    top1: 0.8,
    mrr: 0.85,
    injectedTokens: { p95: 500 },
    injectedChars: { p95: 900 },
    ...overrides,
  });

  it("selectMinScore：差異 <10pp 時沿用 0.40（無法分辨）", async () => {
    const { selectMinScore } = await importEvalModule<{
      selectMinScore: (input: Record<string, unknown>, baseline?: number) => {
        recommended: number;
        distinguishable: boolean;
      };
    }>("select.mjs");
    const result = selectMinScore({
      "0.35": bucket({ fpItemRate: 0.08, recall5: 0.88 }),
      "0.40": bucket({}),
      "0.45": bucket({ fpItemRate: 0.03, abstention: 0.97, recall5: 0.87 }),
    });
    expect(result.recommended).toBe(0.4);
    expect(result.distinguishable).toBe(false);
  });

  it("selectMinScore：abstention 明顯改善時選最大的合格 minScore", async () => {
    const { selectMinScore } = await importEvalModule<{
      selectMinScore: (input: Record<string, unknown>, baseline?: number) => {
        recommended: number;
        distinguishable: boolean;
      };
    }>("select.mjs");
    const result = selectMinScore({
      "0.35": bucket({ fpItemRate: 0.09, abstention: 0.8, recall5: 0.92 }),
      "0.40": bucket({ fpItemRate: 0.08, abstention: 0.8, recall5: 0.9 }),
      "0.45": bucket({ fpItemRate: 0.02, abstention: 0.98, recall5: 0.9 }),
    });
    expect(result.recommended).toBe(0.45);
    expect(result.distinguishable).toBe(true);
  });

  it("selectMinScore：FP 超過 10% 的候選不合格", async () => {
    const { selectMinScore } = await importEvalModule<{
      selectMinScore: (input: Record<string, unknown>, baseline?: number) => {
        recommended: number;
      };
    }>("select.mjs");
    const result = selectMinScore({
      "0.35": bucket({ fpItemRate: 0.2, hitItems: 40 }),
      "0.40": bucket({ fpItemRate: 0.12, hitItems: 45 }),
      "0.45": bucket({ fpItemRate: 0.04, hitItems: 30 }),
    });
    // 0.45 的 hitItems 掉到 30（< baseline 45）、另兩個 FP 超標 → 沒有合格候選 → 沿用 baseline。
    expect(result.recommended).toBe(0.4);
  });

  it("selectMinScore：FP 未達 10% 但 hitItems 不變、negative 注入明顯下降時仍建議較高門檻（標記未達標）", async () => {
    const { selectMinScore } = await importEvalModule<{
      selectMinScore: (input: Record<string, unknown>, baseline?: number) => {
        recommended: number;
        distinguishable: boolean;
        meetsGate: boolean;
      };
    }>("select.mjs");
    const result = selectMinScore({
      "0.40": bucket({ fpItemRate: 0.25, fpItems: 60, negativeInjectionRate: 0.4, abstention: 0.6 }),
      "0.70": bucket({ fpItemRate: 0.2, fpItems: 48, negativeInjectionRate: 0.25, abstention: 0.7 }),
    });
    expect(result.recommended).toBe(0.7);
    expect(result.distinguishable).toBe(true);
    expect(result.meetsGate).toBe(false);
  });

  it("selectMinScore：baseline 不合格、較高門檻合格且 hitItems 不變時，不套 <10pp 噪音規則", async () => {
    const { selectMinScore } = await importEvalModule<{
      selectMinScore: (input: Record<string, unknown>, baseline?: number) => {
        recommended: number;
        meetsGate: boolean;
      };
    }>("select.mjs");
    const result = selectMinScore({
      "0.40": bucket({ fpItemRate: 0.104, fpItems: 20, hitItems: 45, negativeInjectionRate: 0.125, abstention: 0.667 }),
      "0.70": bucket({ fpItemRate: 0.072, fpItems: 13, hitItems: 45, negativeInjectionRate: 0, abstention: 0.733 }),
    });
    expect(result.recommended).toBe(0.7);
    expect(result.meetsGate).toBe(true);
  });

  it("selectMaxItems：只有 hitItems 不低於 baseline 且 token 明顯下降才建議 3", async () => {
    const { selectMaxItems } = await importEvalModule<{
      selectMaxItems: (input: Record<string, unknown>, baseline?: number) => {
        recommended: number;
        distinguishable: boolean;
      };
    }>("select.mjs");
    // 合法：hitItems 相同、token p95 −40%
    expect(
      selectMaxItems({
        3: bucket({ hitItems: 47, injectedTokens: { p95: 300 } }),
        4: bucket({ hitItems: 47, injectedTokens: { p95: 500 } }),
        5: bucket({ hitItems: 47, injectedTokens: { p95: 600 } }),
        8: bucket({ hitItems: 47, injectedTokens: { p95: 900 } }),
      }).recommended,
    ).toBe(3);

    // hitItems 掉了 → 不能只看召回率就建議 3
    expect(
      selectMaxItems({
        3: bucket({ hitItems: 40, injectedTokens: { p95: 300 } }),
        4: bucket({ hitItems: 47, injectedTokens: { p95: 500 } }),
        5: bucket({ hitItems: 47, injectedTokens: { p95: 600 } }),
        8: bucket({ hitItems: 47, injectedTokens: { p95: 900 } }),
      }).recommended,
    ).toBe(4);

    // token 只少 <10% → 無法分辨，沿用 4
    expect(
      selectMaxItems({
        3: bucket({ hitItems: 47, injectedTokens: { p95: 480 } }),
        4: bucket({ hitItems: 47, injectedTokens: { p95: 500 } }),
      }).recommended,
    ).toBe(4);
  });

  it("aggregate：skip 與 degraded 樣本會依口徑正確處理（F1／F2）", async () => {
    const { aggregate } = await importEvalModule<{
      aggregate: (records: Record<string, unknown>[], mode?: "retrieval" | "production") => Record<string, unknown>;
    }>("metrics.mjs");
    const injection = {
      injectedCount: 2,
      injectedSlugs: ["a", "b"],
      fpCount: 2,
      fpSlugs: ["a", "b"],
      unlabeledCount: 0,
      unlabeledSlugs: [],
      hitCount: 0,
      foreignSlugs: [],
      chars: 100,
      tokensEst: 50,
      dedupedCount: 0,
      empty: false,
    };
    const emptyInjection = { ...injection, injectedCount: 0, injectedSlugs: [], fpCount: 0, fpSlugs: [], chars: 0, tokensEst: 0, empty: true };
    const base = {
      question: { category: "negative", expected_ids: [], forbidden_ids: [] },
      status: "ok",
      retrieval: { hit5: null, top1: null, mrr: 0, recallAt5: null, staleInTop5: false, foreignHits: 0, hitIds: [] },
      latencyMs: 10,
      skippedDedup: 0,
      injectedSources: { semantic: 2 },
    };
    const records = [
      // retrieval 口徑不看 skip：這一題仍然有注入；production 口徑才是 0。
      { ...base, skipReason: "short", injection, production: emptyInjection },
      { ...base, skipReason: null, injection, production: injection },
      {
        ...base,
        skipReason: null,
        status: "degraded",
        injection,
        production: injection,
      },
    ];
    const retrieval = aggregate(records, "retrieval") as { negativeInjectionRate: number; degraded: number; n: number };
    const production = aggregate(records, "production") as { negativeInjectionRate: number; skippedQuestions: number; n: number };
    expect(retrieval.n).toBe(2); // degraded 被剔除
    expect(retrieval.degraded).toBe(1);
    expect(retrieval.negativeInjectionRate).toBe(1);
    expect(production.negativeInjectionRate).toBe(0.5); // 被 skip 的那題算 0 注入
    expect(production.skippedQuestions).toBe(1);
  });

  it("selectTimeout：閒置 p95 在 150ms 內就沿用 150ms；超標時向上取 50ms 倍數", async () => {
    const { selectTimeout } = await importEvalModule<{
      selectTimeout: (
        input: { idleP50: number; idleP95: number; idleMax: number; idleOver150Rate: number; idleOver300Rate: number; indexingP95: number | null },
        baseline?: number,
      ) => { recommended: number };
    }>("select.mjs");
    expect(
      selectTimeout({ idleP50: 40, idleP95: 120, idleMax: 180, idleOver150Rate: 0.01, idleOver300Rate: 0, indexingP95: 4000 })
        .recommended,
    ).toBe(150);
    expect(
      selectTimeout({ idleP50: 200, idleP95: 380, idleMax: 500, idleOver150Rate: 0.6, idleOver300Rate: 0.2, indexingP95: 5000 })
        .recommended,
    ).toBe(400);
    expect(
      selectTimeout({ idleP50: 400, idleP95: 900, idleMax: 1200, idleOver150Rate: 0.9, idleOver300Rate: 0.8, indexingP95: 6000 })
        .recommended,
    ).toBe(500);
  });
});
