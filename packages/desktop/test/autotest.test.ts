/**
 * `autotest.ts` 的純邏輯測試：情境清單的解析與執行順序。
 *
 * `autotest.ts` 只在 Electron 內跑（頂層就 import `electron`），這裡用 mock 取代它，
 * 驗的是可單獨測的部分（情境名與順序）；真正的行為驗收由 `scripts/smoke.mjs` 驅動。
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  BrowserWindow: class {},
  Tray: class {},
}));

import {
  ALL_SCENARIOS,
  OPT_IN_SCENARIOS,
  buttonExistsExpression,
  clickByTextExpression,
  parseScenarios,
} from "../src/autotest.js";

describe("parseScenarios", () => {
  it("空字串與 all 都展開成全部（不含 opt-in 情境）", () => {
    expect(parseScenarios("")).toEqual([...ALL_SCENARIOS]);
    expect(parseScenarios("all")).toEqual([...ALL_SCENARIOS]);
    expect(parseScenarios("all")).not.toContain("hidden");
  });

  it("接受 opt-in 情境 hidden", () => {
    expect(parseScenarios("hidden")).toEqual(["hidden"]);
  });
  it("音訊情境需明確指定，不混入既有 all", () => {
    expect(parseScenarios("audio")).toEqual(["audio"]);
    expect(parseScenarios("all")).not.toContain("audio");
  });

  it("opt-in 情境排在 tray 之前（tray 會結束行程，必須最後）", () => {
    expect(parseScenarios("tray,hidden")).toEqual(["hidden", "tray"]);
    expect(OPT_IN_SCENARIOS).toContain("hidden");
    expect(ALL_SCENARIOS[ALL_SCENARIOS.length - 1]).toBe("tray");
  });

  it("照固定順序跑，不受輸入順序影響", () => {
    expect(parseScenarios("tray,bootstrap,autostart")).toEqual(["bootstrap", "autostart", "tray"]);
  });

  it("不認得的情境丟錯，訊息列出可用的情境", () => {
    expect(() => parseScenarios("nope")).toThrowError(/不認得的情境：nope/);
    expect(() => parseScenarios("nope")).toThrowError(/hidden/);
  });
});

describe("control text matching expressions", () => {
  function runWithFakeDocument(textContents: string[], expr: string) {
    const clicked: string[] = [];
    const nodes = textContents.map((textContent) => ({
      textContent,
      click: () => clicked.push(textContent),
    }));
    const fn = new Function("document", `return (${expr});`);
    const result = fn({ querySelectorAll: () => nodes });
    return { result, clicked };
  }

  it("clickByTextExpression 容許前置 +／＋ 與空白且不誤點其他按鈕", () => {
    const res1 = runWithFakeDocument(["+ 加入資料夾", "+ 加入"], clickByTextExpression("加入"));
    expect(res1.result).toBe(true);
    expect(res1.clicked).toEqual(["+ 加入"]);

    const res2 = runWithFakeDocument(["加入並預覽"], clickByTextExpression("加入"));
    expect(res2.result).toBe(false);
    expect(res2.clicked).toEqual([]);
  });

  it("buttonExistsExpression 同樣容許前置 +／＋ 與空白", () => {
    expect(runWithFakeDocument(["+ 加入"], buttonExistsExpression("加入")).result).toBe(true);
    expect(runWithFakeDocument(["＋ 加入"], buttonExistsExpression("加入")).result).toBe(true);
    expect(runWithFakeDocument(["+ 加入資料夾"], buttonExistsExpression("加入")).result).toBe(false);
  });
});
