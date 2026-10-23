/**
 * 三次真實事故的回歸測試（L1）。
 *
 * 每條測試刻意寫成「事故名稱 → 當時錯在哪 → 現在鎖住什麼」，讓未來改壞時，
 * 失敗訊息本身就能說明發生了什麼事。
 *
 * 這三條不是一般行為測試：它們各自對應一次已經發生過的產品事故。
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_DIGEST_TIMEOUT_MS,
  readSettings,
  parseDigestModel,
} from "../../src/config.js";
import { DIGEST_TIMEOUT_MS, MIN_DIGEST_TURN_CHARS } from "../../src/digest.js";
import { decideTrigger, skipReason } from "../../src/recall.js";

const settings = readSettings({});

/** 事故三的原始查詢（合成等價句）：15 字，含明示線索「剛剛」。 */
const FIFTEEN_CHAR_QUERY = "你還記得剛剛討論的佇列設定嗎？";

describe("事故一：摘要 8 秒逾時（寫入 timeout 被誤用成模型 timeout）", () => {
  it("模型 timeout（45000）與寫入 timeout（8000）是兩個不同的常數", () => {
    expect(
      DEFAULT_DIGEST_TIMEOUT_MS,
      `模型 timeout 必須維持 45 秒，實際 ${DEFAULT_DIGEST_TIMEOUT_MS}`,
    ).toBe(45000);
    expect(DIGEST_TIMEOUT_MS, `單次寫入 timeout 必須維持 8 秒，實際 ${DIGEST_TIMEOUT_MS}`).toBe(8000);
    expect(
      DIGEST_TIMEOUT_MS,
      "兩個 timeout 一旦相同，就是事故一的形狀：慢模型會把寫入也拖到模型 timeout 那麼久",
    ).not.toBe(DEFAULT_DIGEST_TIMEOUT_MS);
    expect(DIGEST_TIMEOUT_MS).toBeLessThan(DEFAULT_DIGEST_TIMEOUT_MS);
  });

  it("使用者調高 digestTimeoutMs 只影響模型，不會改動寫入 timeout", () => {
    const slow = readSettings({ digestTimeoutMs: 120000 });
    expect(slow.digestTimeoutMs, "digestTimeoutMs 應被夾到合法上限 120000").toBe(120000);
    expect(
      DIGEST_TIMEOUT_MS,
      "寫入 timeout 是模組常數、不是設定值；調高 digestTimeoutMs 不該讓它跟著變",
    ).toBe(8000);
    expect(readSettings({}).digestTimeoutMs, "未設定時必須回 DEFAULT_DIGEST_TIMEOUT_MS").toBe(
      DEFAULT_DIGEST_TIMEOUT_MS,
    );
  });
});

describe("事故二：模型 id 填錯（把 model id 當成 provider/id）", () => {
  it("沒有 provider 前綴、只有一側或空字串 → null（呼叫端跳過 digest，不亂猜）", () => {
    expect(parseDigestModel("qwen3.7-flash"), "缺少 provider/ 前綴必須無法解析").toBeNull();
    expect(parseDigestModel("openrouter/"), "只有 provider 沒有 model id 必須無法解析").toBeNull();
    expect(parseDigestModel("/qwen3.7-flash"), "只有 model id 沒有 provider 必須無法解析").toBeNull();
    expect(parseDigestModel(""), "空字串必須無法解析").toBeNull();
  });

  it("provider/id 依第一個 / 切分；多層 / 的 model id 不會被切壞", () => {
    expect(parseDigestModel("opencode-go/deepseek-v4.1-flash")).toEqual({
      providerID: "opencode-go",
      id: "deepseek-v4.1-flash",
    });
    // 事故二的核心：某些 provider 的 model id 本身就含 `/`，只能在第一個 `/` 切。
    expect(parseDigestModel("openrouter/qwen/qwen3.7-flash")).toEqual({
      providerID: "openrouter",
      id: "qwen/qwen3.7-flash",
    });
  });
});

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

  it("digest 的回合門檻（40 字）與召回的 short 門檻（6 字）是兩個獨立規則", () => {
    // MIN_DIGEST_TURN_CHARS 是 digest 模組自己的常數，無法用 vi.mock 影響 recall 的
    // skipReason（兩者沒有任何 import 關係）。這裡把「兩個門檻各自獨立」寫成斷言，
    // 避免未來有人把 digest 的 40 套到召回端，重演事故三。
    expect(MIN_DIGEST_TURN_CHARS).toBe(40);
    expect(MIN_DIGEST_TURN_CHARS).toBeGreaterThan(6);
    expect(skipReason(FIFTEEN_CHAR_QUERY), "召回端只看 6 字門檻，不該套用 digest 的 40 字").toBeNull();
  });
});
