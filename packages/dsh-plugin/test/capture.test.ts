import { describe, expect, it } from "vitest";
import {
  MAX_CARD_ASSISTANT_CHARS,
  MAX_CARD_USER_CHARS,
  MAX_MEMORY_CHARS,
} from "../src/config.js";
import { buildCapturePayload, buildTurnCard, shortenSourceRef } from "../src/capture.js";

const USER_TEXT = "使用者這次明確要求把召回 timeout 固定成八百毫秒，並且把 k 上限設為四。";
const ASSISTANT_TEXT = "收到，會照這個契約實作，召回失敗時 fail-open 不影響回覆。";

describe("buildTurnCard", () => {
  it("固定格式 User／Assistant", () => {
    const built = buildTurnCard(USER_TEXT, ASSISTANT_TEXT);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.card.content).toBe(`User: ${USER_TEXT}\nAssistant: ${ASSISTANT_TEXT}`);
  });

  it("確定性：同輸入重算兩次逐字相同，且不含時間戳／回合 id", () => {
    const first = buildTurnCard(USER_TEXT, ASSISTANT_TEXT);
    const second = buildTurnCard(USER_TEXT, ASSISTANT_TEXT);
    expect(first).toEqual(second);
    if (!first.ok) return;
    expect(first.card.content).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    expect(first.card.content).not.toContain("session-");
    expect(first.card.content).not.toContain("turn:");
  });

  it("剝除注入塊、附件與 system-reminder 後才組卡", () => {
    const dirtyUser = [
      USER_TEXT,
      '<memory-context source="mnemoshelf" trust="untrusted" form="recall">',
      "- [fact][2026-10-28] 不該寫回卡片的舊記憶",
      "</memory-context>",
      "<system-reminder>HOST ONLY</system-reminder>",
      "<file name=\"x.txt\">FILE BYTES</file>",
    ].join("\n");
    const dirtyAssistant = `回答\n<memory-context source="mnemoshelf">echo</memory-context>`;
    const built = buildTurnCard(dirtyUser, dirtyAssistant);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.card.content).not.toContain("memory-context");
    expect(built.card.content).not.toContain("不該寫回卡片");
    expect(built.card.content).not.toContain("HOST ONLY");
    expect(built.card.content).not.toContain("FILE BYTES");
    expect(built.card.content).toContain(USER_TEXT);
    expect(built.card.content).toContain("Assistant: 回答");
  });

  it("注入塊不算使用者長度：剝除後 <40 字元就不寫", () => {
    const shortUser = `短問題\n<memory-context source="mnemoshelf" trust="untrusted">\n${"很長的舊記憶。".repeat(50)}\n</memory-context>`;
    const built = buildTurnCard(shortUser, ASSISTANT_TEXT);
    expect(built).toEqual({ ok: false, skip: "short" });
  });

  it("空白或全附件不寫", () => {
    expect(buildTurnCard("   \n<file>x</file>", ASSISTANT_TEXT)).toEqual({
      ok: false,
      skip: "empty",
    });
  });

  it("助理沒有文字（空白回覆）不寫", () => {
    expect(buildTurnCard(USER_TEXT, "")).toEqual({ ok: false, skip: "no-assistant" });
  });

  it("長度用固定上限截斷，總長不超過 server 上限", () => {
    const built = buildTurnCard("u".repeat(MAX_CARD_USER_CHARS + 100), "a".repeat(MAX_CARD_ASSISTANT_CHARS + 100));
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect([...built.card.content].length).toBeLessThanOrEqual(MAX_MEMORY_CHARS);
    expect(built.card.content).toContain("u…");
    expect(built.card.content).toContain("a…");
  });
});

describe("buildCapturePayload", () => {
  it("專案範圍帶 project；global 不帶", () => {
    const project = buildCapturePayload({
      sessionId: "session-abc",
      turn: 3,
      userText: USER_TEXT,
      assistantText: ASSISTANT_TEXT,
      project: "mnemoshelf",
    });
    expect(project).not.toBeNull();
    expect(project).toMatchObject({
      kind: "fact",
      scope: "project",
      project: "mnemoshelf",
      agent: "dsh/turn",
      sourceSession: "session-abc",
      sourceMessage: "3",
    });

    const global = buildCapturePayload({
      sessionId: "session-abc",
      turn: 3,
      userText: USER_TEXT,
      assistantText: ASSISTANT_TEXT,
      project: null,
    });
    expect(global).toMatchObject({ scope: "global", agent: "dsh/turn" });
    expect(global).not.toHaveProperty("project");
  });

  it("內容不合格時回 null", () => {
    expect(
      buildCapturePayload({
        sessionId: "s",
        turn: 1,
        userText: "太短",
        assistantText: ASSISTANT_TEXT,
        project: null,
      }),
    ).toBeNull();
  });

  it("超長來源識別值用穩定的 SHA-256 縮短", () => {
    const long = "s".repeat(300);
    const short = shortenSourceRef(long);
    expect(short).toHaveLength(39);
    expect(short).toMatch(/^sha256:[0-9a-f]{32}$/);
    expect(shortenSourceRef(long)).toBe(short);
    expect(shortenSourceRef("session-abc")).toBe("session-abc");
  });
});
