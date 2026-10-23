/**
 * digest 的純函式測試：回合邊界、文字剝除、模型輸出驗證。
 */
import { describe, expect, it } from "vitest";

import {
  MAX_DIGEST_CONTENT_CHARS,
  MAX_FAILURE_REASON_CHARS,
  MAX_TURN_CONTENT_CHARS,
  buildDigestPrompt,
  checkDigestModel,
  failureReason,
  formatDay,
  parseDigestItems,
  parseTerminalEvent,
  resolveDigestTurn,
  stripMemoryContext,
} from "../src/digest.js";
import type { ModelDomainLike, PluginContextLike } from "../src/types.js";

function user(text: string, id = "u1"): unknown {
  return { id, type: "user", text, time: { created: 0 } };
}

function assistant(...parts: unknown[]): unknown;
function assistant(id: string, ...parts: unknown[]): unknown;
function assistant(...args: unknown[]): unknown {
  const hasId = typeof args[0] === "string";
  const id = hasId ? (args[0] as string) : "a1";
  const parts = hasId ? args.slice(1) : args;
  return {
    id,
    type: "assistant",
    time: { created: 0 },
    agent: "build",
    model: { providerID: "p", id: "m" },
    content: parts,
  };
}

function text(value: string): unknown {
  return { type: "text", text: value };
}

const LONG_USER = "請說明我們為什麼要把 digest 預設關閉，並列出兩個具體理由與成本考量。";
const LONG_ASSISTANT =
  "第一，預設關閉避免使用者在不知道的情況下把對話送給另一個模型；第二，每回合抽取的成本會隨對話長度成長。";

describe("stripMemoryContext", () => {
  it("剝除完整區塊與沒有收尾標籤的區塊", () => {
    const text = [
      "真正的問題在這一行",
      '<memory-context source="mnemoshelf" trust="untrusted" project="x">',
      "- [decision][2026-10-18][0.82] 這是注入的記憶",
      "</memory-context>",
    ].join("\n");
    const stripped = stripMemoryContext(text);
    expect(stripped).toContain("真正的問題在這一行");
    expect(stripped).not.toContain("注入的記憶");
    expect(stripped).not.toContain("memory-context");
  });

  it("未收尾的區塊一路剝到結尾", () => {
    expect(stripMemoryContext("問題\n<memory-context foo>殘留內容").trim()).toBe("問題");
  });

  it("沒有區塊時原樣回傳", () => {
    expect(stripMemoryContext("一般訊息")).toBe("一般訊息");
  });
});

describe("resolveDigestTurn（回合邊界）", () => {
  it("以最後一則非 synthetic assistant 為水位線，往前找最近一則 user", () => {
    const result = resolveDigestTurn([
      user("第一回合的問題內容足夠長，可以通過最低字數門檻嗎？", "u1"),
      assistant("a1", text("第一回合的回答內容也足夠長，用來通過最低字數門檻。")),
      user("第二回合的問題內容足夠長，可以通過最低字數門檻嗎？", "u2"),
      assistant("a2", text("第二回合的回答內容也足夠長，用來通過最低字數門檻。")),
    ]);
    expect("turn" in result).toBe(true);
    if (!("turn" in result)) return;
    expect(result.turn.assistantMessageID).toBe("a2");
    expect(result.turn.userMessageID).toBe("u2");
    expect(result.turn.userText).toContain("第二回合");
    expect(result.turn.assistantText).toContain("第二回合");
    expect(result.turn.sourceText).not.toContain("第一回合");
  });

  it("跳過 synthetic 狀態訊息：只取真正的 user", () => {
    const result = resolveDigestTurn([
      user("[[mnemoshelf-status]] [mnemoshelf] 記憶外掛狀態", "s1"),
      user(LONG_USER, "u1"),
      assistant(text(LONG_ASSISTANT)),
    ]);
    expect("turn" in result).toBe(true);
    if (!("turn" in result)) return;
    expect(result.turn.userMessageID).toBe("u1");
  });

  it("只有 synthetic 的 /memory 回合 → status-turn", () => {
    const result = resolveDigestTurn([
      { id: "s1", type: "synthetic", text: "[[mnemoshelf-status]] 狀態", time: { created: 0 } },
      assistant(text(LONG_ASSISTANT)),
    ]);
    expect(result).toEqual({ skip: "status-turn" });
  });

  it("synthetic 狀態訊息自成一個回合，不回頭配對上一個真 prompt", () => {
    const result = resolveDigestTurn([
      user(LONG_USER, "u1"),
      assistant("a1", text(LONG_ASSISTANT)),
      { id: "s2", type: "synthetic", text: "[[mnemoshelf-status]] 狀態", time: { created: 0 } },
      assistant("a2", text("（/memory 之後的助理回覆）")),
    ]);
    expect(result).toEqual({ skip: "status-turn" });
  });

  it("Plan mode 的 synthetic system-reminder 屬於同一回合，往前找真 prompt", () => {
    const result = resolveDigestTurn([
      user(LONG_USER, "u1"),
      { id: "s1", type: "synthetic", text: "<system-reminder>Plan mode</system-reminder>" },
      assistant("a1", text(LONG_ASSISTANT)),
    ]);
    expect("turn" in result).toBe(true);
    if (!("turn" in result)) return;
    expect(result.turn.userMessageID).toBe("u1");
  });

  it("user 是狀態訊息時回 status-turn", () => {
    const result = resolveDigestTurn([
      user("[[mnemoshelf-status]] 狀態", "s1"),
      assistant(text(LONG_ASSISTANT)),
    ]);
    expect(result).toEqual({ skip: "status-turn" });
  });

  it("slash command 回合跳過", () => {
    const result = resolveDigestTurn([
      user("/memory-all 查詢向量表的決定與後續調整", "u1"),
      assistant(text(LONG_ASSISTANT)),
    ]);
    expect(result).toEqual({ skip: "slash" });
  });

  it("太短的回話跳過（<40 字）", () => {
    const result = resolveDigestTurn([user("好，照這樣做。", "u1"), assistant(text("了解。"))]);
    expect(result).toEqual({ skip: "short" });
  });

  it("沒有 assistant 或沒有 user 時各自回對應原因", () => {
    expect(resolveDigestTurn([])).toEqual({ skip: "no-messages" });
    expect(resolveDigestTurn([user(LONG_USER)])).toEqual({ skip: "no-assistant" });
    expect(resolveDigestTurn([assistant(text(LONG_ASSISTANT))])).toEqual({ skip: "no-user" });
  });

  it("助理只有 tool／reasoning part 時視為沒有可用文字", () => {
    const result = resolveDigestTurn([
      user(LONG_USER, "u1"),
      assistant("a1", { type: "reasoning", text: "內部推理" }, { type: "tool", id: "t1", name: "bash" }),
    ]);
    expect(result).toEqual({ skip: "empty" });
  });

  it("只取 text part：tool 輸出不會進 sourceText", () => {
    const result = resolveDigestTurn([
      user(LONG_USER, "u1"),
      assistant(
        "a1",
        { type: "tool", id: "t1", name: "bash", state: { output: "TOOL-OUTPUT-SECRET" } },
        text(LONG_ASSISTANT),
      ),
    ]);
    expect("turn" in result).toBe(true);
    if (!("turn" in result)) return;
    expect(result.turn.sourceText).not.toContain("TOOL-OUTPUT-SECRET");
    expect(result.turn.sourceText).not.toContain("內部推理");
  });

  it("容忍舊式 role 欄位與 content parts", () => {
    const result = resolveDigestTurn([
      { id: "u9", role: "user", content: [text(LONG_USER)] },
      { id: "a9", role: "assistant", content: [text(LONG_ASSISTANT)] },
    ]);
    expect("turn" in result).toBe(true);
    if (!("turn" in result)) return;
    expect(result.turn.assistantMessageID).toBe("a9");
  });
});

describe("parseDigestItems", () => {
  const source = `${LONG_USER}\n${LONG_ASSISTANT}`;

  it("接受純 JSON 與 code fence，並保留合法 kind", () => {
    const raw = JSON.stringify({
      items: [{ content: "digest 預設關閉。", kind: "decision", quote: "為什麼要把 digest 預設關閉" }],
    });
    expect(parseDigestItems(raw, source, 3).items).toEqual([
      { content: "digest 預設關閉。", kind: "decision", quote: "為什麼要把 digest 預設關閉" },
    ]);
    expect(parseDigestItems(`\`\`\`json\n${raw}\n\`\`\``, source, 3).items).toHaveLength(1);
  });

  it("前後有說明文字時仍取出 JSON 物件", () => {
    const raw = `好的，結果如下：\n${JSON.stringify({ items: [{ content: "重點", kind: "fact", quote: "兩個具體理由" }] })}\n完成。`;
    expect(parseDigestItems(raw, source, 3).items).toHaveLength(1);
  });

  it("非 JSON 與缺少 items 各自回錯誤，且不產生卡片", () => {
    expect(parseDigestItems("這不是 JSON", source, 3)).toMatchObject({ items: [], error: "not-json" });
    expect(parseDigestItems('[{"content":"x"}]', source, 3)).toMatchObject({ items: [], error: "shape" });
    expect(parseDigestItems('{"items":{}}', source, 3)).toMatchObject({ items: [], error: "shape" });
  });

  it("quote 不在原文中時丟棄該筆（含注入塊內容）", () => {
    const raw = JSON.stringify({
      items: [
        { content: "無中生有的卡片", kind: "fact", quote: "原文完全沒有這句話" },
        { content: "有支撐的卡片", kind: "fact", quote: "每回合抽取的成本" },
      ],
    });
    const result = parseDigestItems(raw, source, 3);
    expect(result.items.map((item) => item.content)).toEqual(["有支撐的卡片"]);
    expect(result.rejected).toBe(1);
  });

  it("quote 允許空白正規化，但不允許改寫", () => {
    const multiline = "第一，預設關閉\n避免使用者把對話送出去。";
    const raw = JSON.stringify({
      items: [{ content: "空白差異", kind: "fact", quote: "第一，預設關閉 避免使用者" }],
    });
    expect(parseDigestItems(raw, multiline, 3).items).toHaveLength(1);
    const rewritten = JSON.stringify({
      items: [{ content: "改寫", kind: "fact", quote: "第一，預設關閉並且避免使用者" }],
    });
    expect(parseDigestItems(rewritten, multiline, 3).items).toHaveLength(0);
  });

  it("未知 kind 當 fact；超過上限截斷；內容過長截斷", () => {
    const long = "長".repeat(MAX_DIGEST_CONTENT_CHARS + 20);
    const raw = JSON.stringify({
      items: [
        { content: long, kind: "reflection", quote: "兩個具體理由" },
        { content: "第二筆", kind: "pitfall", quote: "每回合抽取" },
        { content: "第三筆", kind: "preference", quote: "預設關閉" },
      ],
    });
    const result = parseDigestItems(raw, source, 2);
    expect(result.items).toHaveLength(2);
    expect(result.items[0].kind).toBe("fact");
    expect([...result.items[0].content].length).toBeLessThanOrEqual(MAX_DIGEST_CONTENT_CHARS);
  });

  it("批次內重複內容只留一筆；缺欄位丟棄", () => {
    const raw = JSON.stringify({
      items: [
        { content: "同一件事", kind: "fact", quote: "預設關閉" },
        { content: "同一件事", kind: "decision", quote: "成本考量" },
        { content: "", kind: "fact", quote: "預設關閉" },
        { content: "沒有 quote", kind: "fact" },
      ],
    });
    const result = parseDigestItems(raw, source, 3);
    expect(result.items).toHaveLength(1);
    expect(result.rejected).toBe(3);
  });
});

describe("buildDigestPrompt", () => {
  it("包含規則、JSON 格式與這一回合的對話，不含其他東西", () => {
    const prompt = buildDigestPrompt({ userText: "使用者訊息", assistantText: "助理回覆" });
    expect(prompt).toContain("使用者訊息");
    expect(prompt).toContain("助理回覆");
    expect(prompt).toContain('"turn"');
    expect(prompt).toContain('"items"');
    expect(prompt).toContain("quote");
  });

  it("要求回合紀錄寫「討論主題 → 結論／決定 → 下一步或未解問題」", () => {
    const prompt = buildDigestPrompt({ userText: "u", assistantText: "a" });
    expect(prompt).toContain("討論主題");
    expect(prompt).toContain("結論／決定");
    expect(prompt).toContain("下一步或未解問題");
    expect(prompt).toContain("最多 300 字");
  });

  it("items 上限文字是 0–2（不是原本的 0–3）", () => {
    const prompt = buildDigestPrompt({ userText: "u", assistantText: "a" });
    expect(prompt).toContain("0–2 則");
    expect(prompt).not.toContain("0–3");
  });
});

describe("回合紀錄（turn）解析", () => {
  const source = `${LONG_USER}\n${LONG_ASSISTANT}`;

  it("turn 缺失、非字串或空白 → null（不是錯誤）", () => {
    for (const raw of [
      JSON.stringify({ items: [] }),
      JSON.stringify({ turn: 42, items: [] }),
      JSON.stringify({ turn: "   ", items: [] }),
      '{"items":[]}',
    ]) {
      const result = parseDigestItems(raw, source, 2);
      expect(result.turn).toBeNull();
      expect(result.error).toBeUndefined();
    }
  });

  it("turn 301 字截到 300 字", () => {
    const long = "字".repeat(301);
    const result = parseDigestItems(JSON.stringify({ turn: long, items: [] }), source, 2);
    expect(result.turn).not.toBeNull();
    expect([...(result.turn ?? "")].length).toBe(MAX_TURN_CONTENT_CHARS);
    expect(result.turn?.endsWith("…")).toBe(true);
  });

  it("只有 turn 而模型省略 items 時仍保留回合紀錄", () => {
    const result = parseDigestItems(JSON.stringify({ turn: "討論 A，結論 B。" }), source, 2);
    expect(result.turn).toBe("討論 A，結論 B。");
    expect(result.items).toEqual([]);
    expect(result.error).toBeUndefined();
  });

  it("items 與 turn 重複時丟棄該則原子記憶", () => {
    const raw = JSON.stringify({
      turn: "討論 digest 預設關閉。",
      items: [
        { content: "討論 digest 預設關閉。", kind: "fact", quote: "為什麼要把 digest 預設關閉" },
        { content: "另一個有用的決策", kind: "decision", quote: "每回合抽取的成本" },
      ],
    });
    const result = parseDigestItems(raw, source, 2);
    expect(result.items.map((item) => item.content)).toEqual(["另一個有用的決策"]);
    expect(result.rejected).toBe(1);
  });
});

describe("parseTerminalEvent", () => {
  it("只認三種 execution terminal 事件", () => {
    expect(parseTerminalEvent({ type: "session.execution.succeeded", data: { sessionID: "s1" } })).toEqual({
      type: "succeeded",
      sessionID: "s1",
    });
    expect(
      parseTerminalEvent({ type: "session.execution.interrupted", data: { sessionID: "s1", reason: "user" } }),
    ).toEqual({ type: "interrupted", sessionID: "s1", reason: "user" });
    expect(parseTerminalEvent({ type: "session.execution.failed", data: { sessionID: "s2" } })).toEqual({
      type: "failed",
      sessionID: "s2",
    });
    expect(parseTerminalEvent({ type: "session.text.ended", data: { sessionID: "s1" } })).toBeNull();
    expect(parseTerminalEvent({ type: "session.execution.succeeded", data: {} })).toBeNull();
    expect(parseTerminalEvent(null)).toBeNull();
  });
});

describe("formatDay", () => {
  it("用本地時區輸出 YYYY-MM-DD", () => {
    expect(formatDay(new Date(2026, 9, 22, 23, 59))).toBe("2026-10-22");
    expect(formatDay(new Date(2026, 0, 3, 0, 0))).toBe("2026-01-03");
  });
});

describe("failureReason", () => {
  it("保留型別名與訊息，壓成單行", () => {
    const error = new Error("Model unavailable: cheap/missing\n  retry later");
    error.name = "Generate.ModelSelectionError";
    expect(failureReason(error)).toBe(
      "Generate.ModelSelectionError: Model unavailable: cheap/missing retry later",
    );
  });

  it("訊息為空時只留型別名；非 Error 一律 unknown", () => {
    expect(failureReason(new Error(""))).toBe("Error");
    expect(failureReason("boom")).toBe("unknown");
    expect(failureReason(null)).toBe("unknown");
  });

  it("截斷在 200 字元內（不因長訊息撐爆 log／狀態）", () => {
    const reason = failureReason(new Error("x".repeat(500)));
    expect([...reason].length).toBe(MAX_FAILURE_REASON_CHARS);
    expect(reason.endsWith("…")).toBe(true);
  });
});

describe("checkDigestModel", () => {
  const model = { providerID: "cheap", id: "test-model" };

  function ctxWith(list?: () => Promise<unknown>): Pick<PluginContextLike, "model"> {
    if (list === undefined) return {};
    return { model: { list: list as ModelDomainLike["list"] } };
  }

  it("providerID 與 id 完全相符才算存在", async () => {
    const ctx = ctxWith(async () => ({
      location: { directory: "/work/x" },
      data: [
        { id: "other", providerID: "cheap" },
        { id: "test-model", providerID: "cheap" },
      ],
    }));
    await expect(checkDigestModel(ctx, model)).resolves.toEqual({ state: "ok" });
    await expect(checkDigestModel(ctx, { providerID: "cheap", id: "missing" })).resolves.toEqual({
      state: "model-unavailable",
    });
    await expect(checkDigestModel(ctx, { providerID: "other-provider", id: "test-model" })).resolves.toEqual({
      state: "model-unavailable",
    });
  });

  it("宿主直接回陣列也接受", async () => {
    const ctx = ctxWith(async () => [{ id: "test-model", providerID: "cheap" }]);
    await expect(checkDigestModel(ctx, model)).resolves.toEqual({ state: "ok" });
  });

  it("沒有 API、呼叫失敗、格式不符都退回 unchecked", async () => {
    await expect(checkDigestModel({}, model)).resolves.toEqual({
      state: "unchecked",
      reason: "no-model-api",
    });
    await expect(
      checkDigestModel(
        ctxWith(async () => {
          throw new Error("nope");
        }),
        model,
      ),
    ).resolves.toEqual({ state: "unchecked", reason: "list-error" });
    await expect(checkDigestModel(ctxWith(async () => ({ oops: true })), model)).resolves.toEqual({
      state: "unchecked",
      reason: "bad-response",
    });
  });

  it("清單逾時：unchecked/timeout（不拖住 digest）", async () => {
    const ctx = ctxWith(() => new Promise<unknown>(() => undefined));
    await expect(checkDigestModel(ctx, model, { timeoutMs: 10 })).resolves.toEqual({
      state: "unchecked",
      reason: "timeout",
    });
  });
});
