/**
 * 召回短查詢事故的回歸測試（L1）。
 *
 * 每條測試刻意寫成「事故名稱 → 當時錯在哪 → 現在鎖住什麼」，讓未來改壞時，
 * 失敗訊息本身就能說明發生了什麼事。
 *
 * 這三條不是一般行為測試：它們各自對應一次已經發生過的產品事故。
 */
import { describe, expect, it } from "vitest";

import { readSettings } from "../../src/config.js";
import { decideTrigger, skipReason } from "../../src/recall.js";

const settings = readSettings({});

/** 事故三的原始查詢（合成等價句）：15 字，含明示線索「剛剛」。 */
const FIFTEEN_CHAR_QUERY = "你還記得剛剛討論的佇列設定嗎？";

describe("事故三：15 字短句被 `<20` 誤殺（short 門檻）", () => {
  it("15 字且含明示線索的查詢不是 short，而且會被召回", () => {
    expect([...FIFTEEN_CHAR_QUERY].length, "這條測試句必須真的是 15 字，長度標註不能錯").toBe(15);
    expect(
      skipReason(FIFTEEN_CHAR_QUERY),
      "事故三：short 門檻曾是 20，這種 15 字正常問題被當成招呼丟掉；現在門檻是 6",
    ).not.toBe("short");
    expect(skipReason(FIFTEEN_CHAR_QUERY)).toBeNull();
    expect(
      decideTrigger({ query: FIFTEEN_CHAR_QUERY, firstTurn: false, settings }).decide,
      "非首輪也要因為「剛剛」這個明示線索而召回",
    ).toBe(true);
  });

  it("2 字招呼仍被 short 跳過（門檻沒有被放寬到什麼都召回）", () => {
    expect([..."早安"].length).toBe(2);
    expect(skipReason("早安")).toBe("short");
    expect(decideTrigger({ query: "早安", firstTurn: true, settings })).toEqual({
      decide: false,
      reason: "short",
    });
  });

  it("short 門檻是 6 字：5 字跳過、6 字放行", () => {
    const five = "請繼續往下";
    const six = "這樣可以嗎？";
    expect([...five].length).toBe(5);
    expect([...six].length).toBe(6);
    expect(skipReason(five), "5 字仍在門檻內").toBe("short");
    expect(skipReason(six), "6 字剛好達門檻，不可再被 short 誤殺").toBeNull();
  });

});
