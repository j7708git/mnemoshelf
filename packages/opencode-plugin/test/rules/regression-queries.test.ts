/**
 * 合成查詢題庫（`eval/fixtures/regression-queries.json`）的驗證。
 *
 * 題庫本身的用處是「讓人看得懂的回歸案例」；這裡負責兩件事：
 * 1. 題庫不得說謊：`chars`、`expectedSkipReason`、`expectedRecall` 都拿實際規則重算。
 * 2. 題庫不得夾帶隱私資料：走 `test/forbidden-patterns.ts` 的共用清單
 *    （與 `test/eval-fixtures.test.ts` 同一份，兩邊不會再各自漂移），
 *    命中時只顯示遮罩後的片段與規則名稱。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { readSettings } from "../../src/config.js";
import { decideTrigger, hasExplicitCue, skipReason } from "../../src/recall.js";
import { FORBIDDEN_PATTERNS } from "../forbidden-patterns.js";

interface RegressionQuery {
  id: string;
  query: string;
  /** code point 長度（不是 UTF-16 code unit）。 */
  chars: number;
  /** `skipReason()` 的預期；`null` 代表不跳過。 */
  expectedSkipReason: "empty" | "short" | "slash" | "code" | null;
  /** `firstTurn=false`、預設 trigger 下 `decideTrigger().decide` 的預期。 */
  expectedRecall: boolean;
  note: string;
}

interface RegressionFixture {
  schemaVersion: number;
  queries: RegressionQuery[];
}

const FIXTURE_PATH = new URL("../../eval/fixtures/regression-queries.json", import.meta.url);
const RAW = readFileSync(fileURLToPath(FIXTURE_PATH), "utf8");
const fixture = JSON.parse(RAW) as RegressionFixture;
const queries = fixture.queries;
const settings = readSettings({});

/** 只顯示前 6 個字元；避免把疑似憑證整段寫進測試輸出。 */
function maskSnippet(snippet: string): string {
  const chars = [...snippet];
  const head = chars.slice(0, 6).join("");
  return `${head}${chars.length > 6 ? "…" : ""}（長度 ${chars.length}，已遮罩）`;
}

describe("合成查詢題庫：結構", () => {
  it("每筆都有必要欄位，id 與 query 不重複", () => {
    expect(fixture.schemaVersion).toBe(1);
    expect(queries.length).toBeGreaterThanOrEqual(10);
    const ids = new Set<string>();
    const seen = new Set<string>();
    for (const entry of queries) {
      expect(entry.id).toMatch(/^rq-\d{3}$/);
      expect(ids.has(entry.id), `id 重複：${entry.id}`).toBe(false);
      ids.add(entry.id);
      expect(entry.query.trim(), `${entry.id} 的 query 不可為空`).not.toBe("");
      expect(seen.has(entry.query), `query 重複：${entry.query}`).toBe(false);
      seen.add(entry.query);
      expect(entry.note.trim().length, `${entry.id} 必須有說明`).toBeGreaterThan(0);
      expect(typeof entry.expectedRecall, `${entry.id} 必須有 expectedRecall`).toBe("boolean");
      expect([null, "empty", "short", "slash", "code"]).toContain(entry.expectedSkipReason);
      expect(typeof entry.chars, `${entry.id} 必須標註 chars`).toBe("number");
    }
  });

  it("chars 與實際 code point 長度一致（「早安」必須是 2 字）", () => {
    for (const entry of queries) {
      const actual = [...entry.query].length;
      expect(actual, `${entry.id}「${entry.query}」的長度標註是 ${entry.chars}，實際是 ${actual}`).toBe(
        entry.chars,
      );
    }
    const greeting = queries.find((entry) => entry.query === "早安");
    expect(greeting, "題庫必須保留 2 字招呼案例").toBeDefined();
    expect(greeting?.chars, "「早安」是 2 字，不可標成 5 字").toBe(2);
  });

  it("覆蓋 2／5／6／15／≥21 字、slash、/memory 指令、code-heavy 與明示線索", () => {
    const lengths = queries.map((entry) => entry.chars);
    for (const required of [2, 5, 6, 15]) {
      expect(lengths, `缺少 ${required} 字案例`).toContain(required);
    }
    expect(lengths.some((length) => length >= 21), "缺少 ≥21 字案例").toBe(true);
    expect(queries.some((entry) => entry.expectedSkipReason === "slash"), "缺少 slash 案例").toBe(true);
    expect(
      queries.some((entry) => entry.query.startsWith("/") && entry.query.includes("/memory")),
      "缺少 /memory 指令案例",
    ).toBe(true);
    expect(queries.some((entry) => entry.expectedSkipReason === "code"), "缺少 code-heavy 案例").toBe(true);
    expect(queries.some((entry) => hasExplicitCue(entry.query)), "缺少明示線索案例").toBe(true);
    expect(queries.some((entry) => entry.query.includes("剛才")), "缺少「剛才」線索").toBe(true);
    expect(queries.some((entry) => entry.query.includes("剛剛")), "缺少「剛剛」線索").toBe(true);
  });
});

describe("合成查詢題庫：預期值與實際規則一致", () => {
  it("expectedSkipReason 與 skipReason() 一致", () => {
    for (const entry of queries) {
      expect(skipReason(entry.query), `${entry.id}「${entry.query}」的 skipReason 與題庫不符`).toBe(
        entry.expectedSkipReason,
      );
    }
  });

  it("expectedRecall 與 decideTrigger() 一致（firstTurn=false、預設 trigger）", () => {
    for (const entry of queries) {
      const decision = decideTrigger({ query: entry.query, firstTurn: false, settings });
      expect(decision.decide, `${entry.id}「${entry.query}」的召回預期與題庫不符`).toBe(entry.expectedRecall);
    }
  });

  it("非 short 的案例長度都 ≥6，short 的案例都 <6", () => {
    for (const entry of queries) {
      if (entry.expectedSkipReason === "short") {
        expect(entry.chars, `${entry.id} 標為 short 但長度是 ${entry.chars}`).toBeLessThan(6);
      } else if (entry.expectedSkipReason === null) {
        expect(entry.chars, `${entry.id} 標為非 short 但長度只有 ${entry.chars}`).toBeGreaterThanOrEqual(6);
      }
    }
  });
});

describe("合成查詢題庫：隱私掃描", () => {
  it("不得含 email、憑證、本機絕對路徑（命中片段先遮罩）", () => {
    const violations: string[] = [];
    const scan = (id: string, field: string, text: string): void => {
      for (const { name, pattern } of FORBIDDEN_PATTERNS) {
        const match = pattern.exec(text);
        if (match === null) continue;
        violations.push(
          `fixture=regression-queries.json id=${id} field=${field} regex=${name} 命中片段="${maskSnippet(match[0])}"`,
        );
      }
    };
    for (const entry of queries) {
      scan(entry.id, "id", entry.id);
      scan(entry.id, "query", entry.query);
      scan(entry.id, "note", entry.note);
    }
    scan("(whole-file)", "raw", RAW);
    expect(violations, `隱私掃描失敗：\n${violations.join("\n")}`).toEqual([]);
  });
});
