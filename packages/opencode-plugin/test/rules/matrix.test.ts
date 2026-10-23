/**
 * 對話記憶的規則矩陣（L1）。
 *
 * 把 `skipReason`、`decideTrigger`、`resolveProjectTarget`、`parseDigestItems`、
 * `parseDigestModel` 與 digest 的回合門檻，逐格釘成表格式的案例。這裡的每一格都
 * 對應 docs 的一條契約；改動任何一格都應該先改 docs，再改這裡。
 */
import path from "node:path";

import { describe, expect, it } from "vitest";

import { parseDigestModel, readSettings } from "../../src/config.js";
import { parseDigestItems, resolveDigestTurn } from "../../src/digest.js";
import { resolveProjectTarget } from "../../src/project.js";
import { decideTrigger, skipReason } from "../../src/recall.js";

const settings = readSettings({});

/** 事故三的合成等價句：15 字、含「剛剛」。 */
const FIFTEEN = "你還記得剛剛討論的佇列設定嗎？";
const CHAT_SESSION = "session-7a4cbf23-fe33-4fa1-8e10-f0be38497381";

function user(text: string): unknown {
  return { id: "u1", type: "user", text };
}

function assistant(text: string): unknown {
  return { id: "a1", type: "assistant", text };
}

describe("skipReason：長度與形狀", () => {
  it("空字串與只有空白 → empty", () => {
    expect(skipReason("")).toBe("empty");
    expect(skipReason("   \n\t ")).toBe("empty");
  });

  it("`/` 開頭（含前導空白）→ slash", () => {
    expect(skipReason("/memory")).toBe("slash");
    expect(skipReason("  /memory-all")).toBe("slash");
  });

  it("2 字招呼 → short", () => {
    expect([..."早安"].length).toBe(2);
    expect(skipReason("早安")).toBe("short");
  });

  it("5 字 → short（門檻是 <6）", () => {
    expect([..."請繼續往下"].length).toBe(5);
    expect(skipReason("請繼續往下")).toBe("short");
  });

  it("6 字 → 不是 short（邊界剛好放行）", () => {
    expect([..."這樣可以嗎？"].length).toBe(6);
    expect(skipReason("這樣可以嗎？")).toBeNull();
  });

  it("15 字 → 不是 short", () => {
    expect(skipReason(FIFTEEN)).toBeNull();
  });

  it("fenced code 佔比 ≥60% → code", () => {
    expect(skipReason("```ts\nconst queueSize = 42;\n```")).toBe("code");
  });

  it("≥10 行且平均行長 <20 → code", () => {
    const block = Array.from({ length: 10 }, (_, index) => `let v${index} = ${index};`).join("\n");
    expect(skipReason(block)).toBe("code");
  });
});

describe("decideTrigger：輪次、線索與 kind", () => {
  it("first-turn 一律召回（沒有明示線索也一樣）", () => {
    expect(
      decideTrigger({ query: "請幫我整理今天的重點", firstTurn: true, settings }),
    ).toEqual({ decide: true });
  });

  it("every-turn 一律召回（非首輪、沒有線索也一樣）", () => {
    expect(
      decideTrigger({
        query: "請幫我整理今天的重點",
        firstTurn: false,
        settings: { ...settings, trigger: "every-turn" },
      }),
    ).toEqual({ decide: true });
  });

  it("非首輪含明示線索「剛剛」→ 召回", () => {
    expect(decideTrigger({ query: FIFTEEN, firstTurn: false, settings })).toEqual({ decide: true });
  });

  it("非首輪含明示線索「剛才」→ 召回", () => {
    expect(
      decideTrigger({ query: "剛才那個排序的決定是什麼？", firstTurn: false, settings }),
    ).toEqual({ decide: true });
  });

  it("非 primary 的 kind → 不召回（reason: kind），即使首輪且有線索", () => {
    expect(
      decideTrigger({ query: FIFTEEN, kind: "subagent", firstTurn: true, settings }),
    ).toEqual({ decide: false, reason: "kind" });
  });

  it("沒有明示線索且非首輪 → 不召回（reason: trigger）", () => {
    expect(
      decideTrigger({ query: "請幫我整理今天的重點", firstTurn: false, settings }),
    ).toEqual({ decide: false, reason: "trigger" });
  });

  it("query 太短時 short 優先於 first-turn（不會因為首輪就召回招呼）", () => {
    expect(decideTrigger({ query: "早安", firstTurn: true, settings })).toEqual({
      decide: false,
      reason: "short",
    });
  });
});

describe("resolveProjectTarget：專案、聊天 session、fail closed", () => {
  it("一般專案目錄 → project（取目錄 basename）", () => {
    expect(resolveProjectTarget({ locationDirectory: path.join("work", "alpha-src") })).toEqual({
      kind: "project",
      project: "alpha-src",
    });
  });

  it("canonical（main checkout）優先於 worktree 目錄", () => {
    expect(
      resolveProjectTarget({
        canonical: path.join("work", "alpha"),
        projectDirectory: path.join("work", "alpha-feature"),
      }),
    ).toEqual({ kind: "project", project: "alpha" });
  });

  it("OpenChamber 聊天 session（chats/<日期>/session-<uuid>）→ global-chat", () => {
    const chat = path.join("work", "openchamber", "chats", "2026-10-22", CHAT_SESSION);
    expect(resolveProjectTarget({ locationDirectory: chat })).toEqual({ kind: "global-chat" });
    // 沒有日期層的變體也是同一個 session 目錄形狀。
    expect(
      resolveProjectTarget({ locationDirectory: path.join("work", "openchamber", "chats", CHAT_SESSION) }),
    ).toEqual({ kind: "global-chat" });
  });

  it("Windows 聊天路徑（用 path.win32 產生）→ global-chat", () => {
    const chat = path.win32.join("D:", "work", "openchamber", "chats", "2026-10-22", CHAT_SESSION);
    expect(resolveProjectTarget({ locationDirectory: chat, platform: "win32" })).toEqual({
      kind: "global-chat",
    });
  });

  it("option 明確指定專案時優先於聊天目錄判定", () => {
    const chat = path.join("work", "openchamber", "chats", "2026-10-22", CHAT_SESSION);
    expect(
      resolveProjectTarget({ optionProject: "explicit-project", locationDirectory: chat }),
    ).toEqual({ kind: "project", project: "explicit-project" });
  });

  it("無法解析 → unresolved（fail closed，不回空字串也不回 global）", () => {
    expect(resolveProjectTarget({})).toEqual({ kind: "unresolved" });
    expect(resolveProjectTarget({ locationDirectory: "   " })).toEqual({ kind: "unresolved" });
    const target = resolveProjectTarget({});
    expect(target.kind).not.toBe("project");
  });
});

describe("parseDigestItems：模型輸出驗證", () => {
  const SOURCE = [
    "使用者說：請把佇列上限改成 64，並保留重試三次的設定。",
    "助理回覆：已改成 64，重試次數維持三次。",
  ].join("\n");

  function payload(items: unknown, turn: unknown = "討論佇列上限，決定改成 64。"): string {
    return JSON.stringify({ turn, items });
  }

  it("合法 JSON → 保留 turn 與 items，沒有 rejected", () => {
    const result = parseDigestItems(
      payload([
        { content: "佇列上限改為 64", kind: "decision", quote: "請把佇列上限改成 64" },
        { content: "重試次數維持三次", kind: "fact", quote: "重試次數維持三次" },
      ]),
      SOURCE,
      2,
    );
    expect(result.error).toBeUndefined();
    expect(result.turn).toBe("討論佇列上限，決定改成 64。");
    expect(result.items).toEqual([
      { content: "佇列上限改為 64", kind: "decision", quote: "請把佇列上限改成 64" },
      { content: "重試次數維持三次", kind: "fact", quote: "重試次數維持三次" },
    ]);
    expect(result.rejected).toBe(0);
  });

  it("code fence 包裹的 JSON 仍可解析", () => {
    const raw = "```json\n" + payload([{ content: "上限是 64", kind: "fact", quote: "上限改成 64" }]) + "\n```";
    const result = parseDigestItems(raw, SOURCE, 2);
    expect(result.error).toBeUndefined();
    expect(result.items).toHaveLength(1);
  });

  it("不是 JSON → error: not-json", () => {
    const result = parseDigestItems("模型今天不想輸出 JSON", SOURCE, 2);
    expect(result).toEqual({ turn: null, items: [], rejected: 0, error: "not-json" });
  });

  it("JSON 陣列（只有 item、沒有 turn／items 的物件）→ error: shape", () => {
    const result = parseDigestItems(`[{"content":"x"}]`, SOURCE, 2);
    expect(result.error).toBe("shape");
    expect(result.items).toEqual([]);
  });

  it("空物件 `{}` → shape（既沒有 turn 也沒有 items）", () => {
    expect(parseDigestItems("{}", SOURCE, 2)).toEqual({
      turn: null,
      items: [],
      rejected: 0,
      error: "shape",
    });
  });

  it("items 不是陣列 → shape，但 turn 仍保留", () => {
    const result = parseDigestItems(payload("oops", "有回合內容"), SOURCE, 2);
    expect(result).toEqual({ turn: "有回合內容", items: [], rejected: 0, error: "shape" });
  });

  it("quote 對不上原文 → 丟棄該筆並計入 rejected", () => {
    const result = parseDigestItems(
      payload([
        { content: "佇列上限改為 64", kind: "decision", quote: "請把佇列上限改成 64" },
        { content: "模型自己編的內容", kind: "fact", quote: "原文根本沒有這句話" },
      ]),
      SOURCE,
      2,
    );
    expect(result.items).toEqual([
      { content: "佇列上限改為 64", kind: "decision", quote: "請把佇列上限改成 64" },
    ]);
    expect(result.rejected).toBe(1);
  });

  it("items 超過 limit 是 break：只取前 limit 筆，rejected 不增加", () => {
    const result = parseDigestItems(
      payload([
        { content: "第一則", kind: "fact", quote: "請把佇列上限改成 64" },
        { content: "第二則", kind: "fact", quote: "重試次數維持三次" },
        { content: "第三則", kind: "fact", quote: "已改成 64" },
      ]),
      SOURCE,
      2,
    );
    expect(result.items.map((item) => item.content)).toEqual(["第一則", "第二則"]);
    expect(result.rejected, "超過上限是主動停止，不是丟棄錯誤，rejected 必須是 0").toBe(0);
  });

  it("只有 turn、沒有 items → 視為空陣列，不是錯誤", () => {
    const result = parseDigestItems(JSON.stringify({ turn: "只有回合紀錄" }), SOURCE, 2);
    expect(result).toEqual({ turn: "只有回合紀錄", items: [], rejected: 0 });
  });

  it("item 缺 content 或 quote → 計入 rejected", () => {
    const result = parseDigestItems(
      payload([
        { kind: "fact", quote: "請把佇列上限改成 64" },
        { content: "缺 quote", kind: "fact" },
        { content: "合格的", kind: "fact", quote: "重試次數維持三次" },
      ]),
      SOURCE,
      2,
    );
    expect(result.items.map((item) => item.content)).toEqual(["合格的"]);
    expect(result.rejected).toBe(2);
  });

  it("kind 不在合法清單 → 當成 fact", () => {
    const result = parseDigestItems(
      payload([{ content: "上限是 64", kind: "rumor", quote: "上限改成 64" }]),
      SOURCE,
      2,
    );
    expect(result.items[0]?.kind).toBe("fact");
  });

  it("重複內容 → 第二筆計入 rejected", () => {
    const result = parseDigestItems(
      payload([
        { content: "上限是 64", kind: "fact", quote: "上限改成 64" },
        { content: "上限是 64", kind: "fact", quote: "重試次數維持三次" },
      ]),
      SOURCE,
      2,
    );
    expect(result.items).toHaveLength(1);
    expect(result.rejected).toBe(1);
  });

  it("turn 不是字串 → turn 為 null，但 items 照常解析", () => {
    const result = parseDigestItems(
      JSON.stringify({ turn: 123, items: [{ content: "上限是 64", kind: "fact", quote: "上限改成 64" }] }),
      SOURCE,
      2,
    );
    expect(result.turn).toBeNull();
    expect(result.items).toHaveLength(1);
  });
});

describe("parseDigestModel：provider/model 的切分", () => {
  it("單層 `/` → provider 與 model id", () => {
    expect(parseDigestModel("opencode-go/deepseek-v4.1-flash")).toEqual({
      providerID: "opencode-go",
      id: "deepseek-v4.1-flash",
    });
  });

  it("多層 `/` → 只在第一個 `/` 切", () => {
    expect(parseDigestModel("openrouter/qwen/qwen3.7-flash")).toEqual({
      providerID: "openrouter",
      id: "qwen/qwen3.7-flash",
    });
  });

  it("沒有 `/` → null", () => {
    expect(parseDigestModel("deepseek-v4.1-flash")).toBeNull();
  });

  it("前後空白會 trim（provider 與 id 各自 trim）", () => {
    expect(parseDigestModel("  opencode-go / qwen3.7-flash  ")).toEqual({
      providerID: "opencode-go",
      id: "qwen3.7-flash",
    });
  });

  it("只有空白字元、或空的一側 → null", () => {
    expect(parseDigestModel("   ")).toBeNull();
    expect(parseDigestModel("openrouter/")).toBeNull();
    expect(parseDigestModel("/qwen3.7-flash")).toBeNull();
  });
});

describe("resolveDigestTurn：回合內容的 40 字門檻", () => {
  it("39 字（user 20＋assistant 19）→ short", () => {
    const result = resolveDigestTurn([user("測".repeat(20)), assistant("答".repeat(19))]);
    expect(result).toEqual({ skip: "short" });
  });

  it("40 字（剛好達標）→ 產生回合，不跳過", () => {
    const result = resolveDigestTurn([user("測".repeat(20)), assistant("答".repeat(20))]);
    expect("turn" in result).toBe(true);
  });

  it("41 字 → 產生回合", () => {
    const result = resolveDigestTurn([user("測".repeat(20)), assistant("答".repeat(21))]);
    expect("turn" in result).toBe(true);
  });

  it("門檻看 user＋assistant 合計，不是只看 user", () => {
    const result = resolveDigestTurn([user("測".repeat(5)), assistant("答".repeat(35))]);
    expect("turn" in result).toBe(true);
  });
});
