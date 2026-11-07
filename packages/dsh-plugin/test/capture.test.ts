import { describe, expect, it } from "vitest";
import { buildCapturePayload, captureMessage } from "../src/capture.js";

describe("dsh 可見文字擷取", () => {
  it("不插入換行、排除非文字及注入、保留 Unicode／空白與宿主時間", () => {
    const first = "  開始\r\n🧭  ";
    const last = "\t尾端  ";
    expect(captureMessage({
      id: "u1", role: "user", time: 1500, ordinal: 0,
      content: [
        { type: "text", text: first },
        { type: "reasoning", text: "private" },
        { type: "text", text: "<memory-context>injected</memory-context>" },
        { type: "text", text: "hidden", hidden: true },
        { type: "text", text: last },
        { type: "media", text: "media" },
      ],
    })).toEqual({
      sourceMessage: "u1", role: "user", occurredAt: new Date(1500).toISOString(), content: first + last,
    });
  });

  it("只含工具、附件與注入的訊息不產生資料；空文字可保留", () => {
    const input = { id: undefined, role: "assistant" as const, time: undefined, ordinal: 1 };
    expect(captureMessage({ ...input, content: [{ type: "tool", text: "tool result" }] })).toBeNull();
    expect(captureMessage({ ...input, content: " <attachment>image</attachment>\n" })).toBeNull();
    expect(captureMessage({ ...input, content: "<memory-context>fragment" })).toBeNull();
    expect(captureMessage({ ...input, content: "" })).toEqual({
      sourceMessage: "visible:assistant:1", role: "assistant", occurredAt: null, content: "",
    });
  });

  it("短使用者訊息與長中尾原文不截斷，專案／global 設定與事件 ID 固定", () => {
    const body = " 原文\r\n".repeat(3000) + " `後段`  ";
    const user = captureMessage({ id: "u1", role: "user", content: "不行", time: undefined, ordinal: 0 })!;
    const assistant = captureMessage({ id: "a1", role: "assistant", content: body, time: undefined, ordinal: 1 })!;
    const input = { sessionId: "s".repeat(201), turn: 4, messages: [user, assistant], project: "p" };
    const project = buildCapturePayload(input);
    expect(project).toMatchObject({
      sourceSession: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      sourceTurn: "4", project: "p", scope: "project", agent: "dsh/turn",
      messages: [user, assistant],
    });
    expect(buildCapturePayload(input)).toEqual(project);
    expect(buildCapturePayload({ ...input, project: null })).not.toHaveProperty("project");
    expect(buildCapturePayload({ ...input, messages: [assistant] })).toBeNull();
    expect(buildCapturePayload({ ...input, messages: [{ ...user, content: " \t " }] })).toBeNull();
  });
});
