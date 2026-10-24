/**
 * L3：`buildDigestCards` 抽取的 parity 測試、fixture 規則與量測邏輯測試。
 *
 * 這一檔刻意分成三層：
 * 1. **純函式 parity**：抽出後的 `buildDigestCards` 與重構前寫在 `runDigest()` 裡的組卡邏輯
 *    逐位元等價（含截斷）。
 * 2. **runtime parity**：真 `createMemoryRuntime` 的 POST 內容 ≡ `buildDigestCards` 的輸出，
 *    證明「harness 量到的卡片」就是「產品送出的卡片」。
 * 3. **fixture／量測規則**：30 回合、隱私、針長度、正規化與指標口徑。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  MAX_DIGEST_ITEMS,
  buildDigestCards,
  parseDigestItems,
  resolveDigestTurn,
} from "../src/digest.js";
import { createMemoryRuntime, type RuntimeCleanup } from "../src/recall.js";
import type {
  CommandEditorLike,
  ModelDomainLike,
  ModelInfoLike,
  PluginContextLike,
  StorageLike,
} from "../src/types.js";
import { cannedBaselineResponse, promptSections, splitSentences } from "../eval/digest/lib/canned.mjs";
import { loadFixtures, privacyFindings } from "../eval/digest/lib/fixtures.mjs";
import { aggregateMetrics, evaluateTurn, hardConditions, softThresholds } from "../eval/digest/lib/metrics.mjs";
import { countRawItems, digestPostBody } from "../eval/digest/lib/pipeline.mjs";
import { renderMarkdown } from "../eval/digest/lib/report.mjs";
import { includesNeedle, needleLength, normalizeForMatch } from "../eval/digest/lib/text.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = path.resolve(HERE, "..");
const FIXTURE_DIR = path.join(PACKAGE_DIR, "eval", "digest", "fixtures");

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

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

/* ------------------------------------------------------------------ *
 * 2. runtime parity：真 runtime 的 POST ≡ buildDigestCards
 * ------------------------------------------------------------------ */

const LOCATION = "/work/eval-parity";
const MODEL = "canned/parity-model";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function tick(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class EventFeed {
  private items: unknown[] = [];
  private resolver: ((result: IteratorResult<unknown>) => void) | undefined;

  push(value: unknown): void {
    if (this.resolver !== undefined) {
      const resolve = this.resolver;
      this.resolver = undefined;
      resolve({ value, done: false });
      return;
    }
    this.items.push(value);
  }

  async *stream(): AsyncGenerator<unknown, void, void> {
    for (;;) {
      if (this.items.length > 0) {
        yield this.items.shift();
        continue;
      }
      const next = await new Promise<IteratorResult<unknown>>((resolve) => {
        this.resolver = resolve;
      });
      if (next.done === true) return;
      yield next.value;
    }
  }
}

function memoryStorage(): StorageLike {
  const map = new Map<string, unknown>();
  return {
    get: async (key) => map.get(key),
    set: async (key, value) => {
      map.set(key, value);
    },
    remove: async (key) => {
      map.delete(key);
    },
    scan: async ({ prefix, after, limit }) => {
      const keys = [...map.keys()].filter((key) => key.startsWith(prefix)).sort();
      const start = after === undefined ? 0 : keys.indexOf(after) + 1;
      const size = limit ?? 100;
      const page = keys.slice(start, start + size);
      const next = keys[start + page.length];
      return {
        entries: page.map((key) => ({ key, value: map.get(key) })),
        ...(next === undefined ? {} : { next }),
      };
    },
  };
}

const USER_TEXT =
  "請整理這一回合的三件事：指數退避的重試策略、快取上限，以及日誌欄位命名；最後附上下一步。";
const ASSISTANT_TEXT =
  "這一輪確認了指數退避可以避免重試風暴，也確認快取需要上限。日誌欄位統一用 snake_case，下一步補測試。";

const RAW_RESPONSE = JSON.stringify({
  turn: "這一輪確認了抽取後的組卡行為，並記下下一步。",
  items: [
    { content: "指數退避可以避免重試風暴。", kind: "decision", quote: "指數退避" },
    { content: "快取需要上限，否則長時間執行會吃光記憶體。", kind: "pitfall", quote: "快取上限" },
    { content: "日誌欄位統一用 snake_case。", kind: "preference", quote: "日誌欄位" },
  ],
});

async function runParityRuntime(): Promise<{ posts: Record<string, unknown>[]; cleanup: RuntimeCleanup }> {
  const posts: Record<string, unknown>[] = [];
  const messages = [
    { id: "u-1", type: "user", role: "user", content: [{ type: "text", text: USER_TEXT }] },
    { id: "a-1", type: "assistant", role: "assistant", content: [{ type: "text", text: ASSISTANT_TEXT }] },
  ];
  const feed = new EventFeed();
  const logDir = await fs.mkdtemp(path.join(os.tmpdir(), "mnemoshelf-digest-eval-parity-"));
  tempDirs.push(logDir);

  const ctx: PluginContextLike = {
    app: { version: "2.1.1" },
    options: {
      digestEnabled: true,
      digestModel: MODEL,
    },
    location: { directory: LOCATION, project: { canonical: LOCATION, directory: LOCATION } },
    session: {
      hook: async () => ({ dispose: async () => undefined }),
      synthetic: async () => ({}),
      get: async () => ({ location: { directory: LOCATION } }),
      context: async () => messages,
    },
    command: {
      transform: async (callback: (editor: CommandEditorLike) => void) => {
        callback({ add: () => undefined });
        return { dispose: async () => undefined };
      },
    },
    generate: {
      text: async () => ({ text: RAW_RESPONSE }),
    },
    model: {
      list: async () => ({ data: [{ id: "parity-model", modelID: "parity-model", providerID: "canned" } satisfies ModelInfoLike] }),
    } satisfies ModelDomainLike,
    storage: memoryStorage(),
    event: { subscribe: () => feed.stream() },
  };

  const cleanup = await createMemoryRuntime(ctx, {
    env: { MNEMOSHELF_URL: "http://127.0.0.1:43118", MNEMOSHELF_TOKEN: "test-token-value" },
    platform: "linux",
    home: logDir,
    log: () => undefined,
    fetchImpl: async (request, init) => {
      const url = String(request);
      if (url.endsWith("/memories/search")) return jsonResponse({ hits: [] });
      if (url.endsWith("/memories")) {
        posts.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
        return jsonResponse({ id: posts.length, duplicate: false }, 201);
      }
      return jsonResponse({}, 404);
    },
    readFileImpl: async () => {
      throw new Error("ENOENT");
    },
    digestLogFile: path.join(logDir, "digest.log"),
  });

  feed.push({ id: "evt-1", type: "session.execution.succeeded", data: { sessionID: "s1" } });
  await tick();
  await cleanup.awaitIdle?.();
  await tick(5);
  return { posts, cleanup };
}

describe("runtime POST 內容 ≡ buildDigestCards", () => {
  it("真 runtime 送出的每一張卡都等於純函式的輸出（形狀固定：turn＋最多 2 則）", async () => {
    const { posts, cleanup } = await runParityRuntime();
    try {
      const resolved = resolveDigestTurn([
        { id: "u-1", type: "user", content: [{ type: "text", text: USER_TEXT }] },
        { id: "a-1", type: "assistant", content: [{ type: "text", text: ASSISTANT_TEXT }] },
      ]);
      expect("turn" in resolved).toBe(true);
      if (!("turn" in resolved)) return;

      const parsed = parseDigestItems(RAW_RESPONSE, resolved.turn.sourceText, MAX_DIGEST_ITEMS);
      const cards = buildDigestCards(parsed);
      const expected = cards.map((card) =>
        digestPostBody(card, { sessionID: "s1", messageID: "a-1", project: "eval-parity" }),
      );

      expect(cards).toHaveLength(3); // 回合卡 + 2 則 item
      expect(posts).toEqual(expected);
      // 額外鎖住「回合卡先寫、force=true；原子記憶 force 不帶」。
      expect(posts[0]).toMatchObject({ agent: "opencode-plugin/turn", kind: "fact", force: true });
      expect(posts[1]).toMatchObject({ agent: "opencode-plugin", kind: "decision" });
      expect(posts[1].force).toBeUndefined();
      expect(posts[2]).toMatchObject({ agent: "opencode-plugin", kind: "pitfall" });
      expect(posts[2].force).toBeUndefined();
    } finally {
      await cleanup();
    }
  });
});

/* ------------------------------------------------------------------ *
 * 3. fixture 與量測規則
 * ------------------------------------------------------------------ */

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
    expect(countRawItems(RAW_RESPONSE)).toBe(3);
    expect(countRawItems("```json\n" + RAW_RESPONSE + "\n```")).toBe(3);
    expect(countRawItems("不是 JSON")).toBe(0);
  });
});
