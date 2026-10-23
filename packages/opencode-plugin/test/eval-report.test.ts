/**
 * 評估報告渲染的物件序列化回歸測試。
 *
 * 背景：L2 迴圈 harness 曾把 check 的 `actual` 直接 `String()`，物件在 Markdown
 * 變成 `[object Object]`（例如 a3 場景的「命中分數／來源」）。這裡用最小假報告
 * 鎖住兩件事：
 * 1. 一般物件要輸出可讀 JSON，不再出現 `[object Object]`；
 * 2. 基本型別與陣列的呈現維持原樣（陣列仍是 `a,b,c`），避免修補改變既有報告。
 *
 * 測試不跑 server、不碰真實資料目錄；只渲染假的報告物件。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderMarkdown as renderDigestMarkdown } from "../eval/digest/lib/report.mjs";

interface LoopCheck {
  name: string;
  ok: boolean;
  expected?: unknown;
  actual?: unknown;
  informational?: boolean;
}

interface LoopCase {
  id: string;
  assertion: number;
  title: string;
  status: "pass" | "fail" | "info";
  gated?: boolean;
  durationMs: number;
  metrics: { modelCalls: number; writeAttempts: number; writes: number };
  checks: LoopCheck[];
  detail?: string;
}

interface LoopReportModule {
  renderMarkdown: (report: Record<string, unknown>) => string;
  printCaseResult: (entry: LoopCase, sanitize: (value: unknown) => string) => void;
}

const LOOP_REPORT_DIR = new URL("../eval/loop/", import.meta.url);

/**
 * 動態 import 沒有型別宣告的 `eval/loop/report.mjs`。
 * specifier 用變數傳入，並加 `@vite-ignore`，避免 Vite 改寫這個 import。
 */
async function importLoopReportModule(): Promise<LoopReportModule> {
  return (await import(/* @vite-ignore */ new URL("report.mjs", LOOP_REPORT_DIR).href)) as LoopReportModule;
}

function makeLoopCase(checks: LoopCheck[], overrides: Partial<LoopCase> = {}): LoopCase {
  return {
    id: "a3.semantic-old-turn",
    assertion: 3,
    title: "較舊的回合卡靠語意搜尋找回（僅報告）",
    status: "info",
    gated: false,
    durationMs: 12,
    metrics: { modelCalls: 0, writeAttempts: 0, writes: 0 },
    checks,
    ...overrides,
  };
}

function makeLoopReport(cases: LoopCase[]): Record<string, unknown> {
  return {
    generatedAt: "2026-10-23T00:00:00.000Z",
    durationMs: 1000,
    git: { short: "abcdef0", dirty: false, dirtyFileCount: 0 },
    fault: "none",
    fingerprint: "0123456789abcdef",
    build: { rebuilt: false, reason: null },
    environment: { node: "v22.0.0", platform: "linux" },
    embedder: { id: "test-embedder", dimension: 8 },
    readiness: { gate: "ready", final: null },
    modelValidation: { instances: [] },
    cases,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("L2 迴圈報告：check 值的安全序列化", () => {
  it("物件 actual／expected 輸出 JSON，不得出現 [object Object]", async () => {
    const { renderMarkdown } = await importLoopReportModule();
    const markdown = renderMarkdown(
      makeLoopReport([
        makeLoopCase([
          { name: "命中分數／來源", ok: true, expected: "（僅記錄）", actual: { score: 0.82, source: "semantic" }, informational: true },
          { name: "物件預期值", ok: true, expected: { minScore: 0.4 }, actual: { minScore: 0.4 } },
        ]),
      ]),
    );

    expect(markdown).not.toContain("[object Object]");
    expect(markdown).toContain('| ✓ | 命中分數／來源 | （僅記錄） | {"score":0.82,"source":"semantic"} |');
    expect(markdown).toContain('| ✓ | 物件預期值 | {"minScore":0.4} | {"minScore":0.4} |');
  });

  it("基本型別與陣列的呈現維持原樣（陣列仍是 a,b,c）", async () => {
    const { renderMarkdown } = await importLoopReportModule();
    const markdown = renderMarkdown(
      makeLoopReport([
        makeLoopCase([
          { name: "數字", ok: true, expected: 1, actual: 1 },
          { name: "布林", ok: true, expected: true, actual: false },
          { name: "陣列", ok: true, expected: ["a", "b", "c"], actual: ["a", "b", "c"] },
          { name: "空值", ok: true, expected: null, actual: undefined },
        ]),
      ]),
    );

    expect(markdown).toContain("| ✓ | 數字 | 1 | 1 |");
    expect(markdown).toContain("| ✓ | 布林 | true | false |");
    expect(markdown).toContain("| ✓ | 陣列 | a,b,c | a,b,c |");
    expect(markdown).toContain("| ✓ | 空值 |  |  |");
  });

  it("陣列內含物件時元素各自序列化；純字串陣列仍維持 a,b,c", async () => {
    const { renderMarkdown } = await importLoopReportModule();
    const markdown = renderMarkdown(
      makeLoopReport([
        makeLoopCase([
          {
            name: "物件陣列",
            ok: true,
            expected: [{ score: 0.82, source: "semantic" }],
            actual: [{ score: 0.82 }, { source: "semantic" }],
          },
          { name: "字串陣列", ok: true, expected: ["a", "b", "c"], actual: ["a", "b", "c"] },
        ]),
      ]),
    );

    // 舊寫法 String([{...}]) 會得到 [object Object]；元素必須各自走物件序列化。
    expect(markdown).not.toContain("[object Object]");
    expect(markdown).toContain(
      '| ✓ | 物件陣列 | {"score":0.82,"source":"semantic"} | {"score":0.82},{"source":"semantic"} |',
    );
    // 既有呈現不得改變：純字串陣列仍是逗號接法。
    expect(markdown).toContain("| ✓ | 字串陣列 | a,b,c | a,b,c |");
  });

  it("主控台摘要（printCaseResult）也不再印出 [object Object]", async () => {
    const { printCaseResult } = await importLoopReportModule();
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map((value) => String(value)).join(" "));
    });

    printCaseResult(
      makeLoopCase(
        [{ name: "命中分數／來源", ok: false, expected: { score: 0.9 }, actual: { score: 0.82, source: "semantic" } }],
        { status: "fail", gated: true },
      ),
      (value: unknown) => String(value),
    );

    const output = logs.join("\n");
    expect(output).not.toContain("[object Object]");
    expect(output).toContain('預期 {"score":0.9}，實際 {"score":0.82,"source":"semantic"}');
  });
});

describe("L3 digest 報告：硬條件／軟門檻的安全序列化", () => {
  it("硬條件與軟門檻的 actual 是物件時輸出 JSON，數字仍照舊呈現", () => {
    const markdown = renderDigestMarkdown({
      generatedAt: "2026-10-23T00:00:00.000Z",
      durationMs: 1000,
      git: { short: "abcdef0", dirty: false, dirtyFileCount: 0 },
      fixture: { version: "v1", turns: 1, fingerprint: "0123456789ab" },
      model: { id: "canned/x", kind: "canned", paid: false },
      build: { rebuilt: false, reason: null },
      hardConditions: [
        { id: "count", label: "mustNotInclude 命中 = 0", actual: 0, ok: true },
        { id: "detail", label: "觀察值", actual: { score: 0.9, source: "semantic" }, ok: true },
      ],
      softThresholds: [
        { id: "kind", label: "kind 命中率 ≥ 80%", actual: 0.5, threshold: 0.8, met: false },
        { id: "detail", label: "觀察值", actual: { score: 0.9 }, threshold: 0.8, met: true },
      ],
      metrics: {
        turns: 1,
        digested: 1,
        skipped: 0,
        failed: 0,
        skipReasons: {},
        failedReasons: {},
        skipExpectation: { correct: 0, expected: 0 },
        emptyExpectation: { correct: 0, expected: 0, nonEmpty: 1, nonEmptyWithWrites: 1 },
        mustInclude: { passed: 0, turnsWithExpectation: 0, rate: null },
        mustNotInclude: { hits: 0 },
        crossProjectLeaks: 0,
        kind: { hits: 0, expected: 0, rate: null },
        recall: { endToEnd: 0, expectedTurns: 0, endToEndRate: null, queryHitRate: null, injectionRate: null },
        itemsBudget: {
          rawItems: 1,
          keptByParser: 1,
          writtenCards: 1,
          rejected: 0,
          overLimitTurns: 0,
        },
        latency: { modelP50: 1, modelP95: 2, turnP50: 3, turnP95: 4 },
        timeoutBudget: { digestTimeoutMs: 45000, redundantThresholdMs: 4, ok: true },
      },
      crossProject: { contentLeaks: 0, scopeLeaks: 0 },
      parity: { ok: true, mismatches: [] },
      usage: { tokens: "N/A", cost: "N/A", note: "canned 模型沒有 usage。" },
      turns: [],
    });

    expect(markdown).not.toContain("[object Object]");
    expect(markdown).toContain('| PASS | 觀察值 | {"score":0.9,"source":"semantic"} |');
    expect(markdown).toContain("| PASS | mustNotInclude 命中 = 0 | 0 |");
    expect(markdown).toContain("| INFO（未達標，待校準） | kind 命中率 ≥ 80% | 80.0% | 50.0% |");
    expect(markdown).toContain('| INFO（達標） | 觀察值 | 80.0% | {"score":0.9} |');
  });
});
