import { describe, expect, it } from "vitest";
import {
  assertMemorySourceChunks,
  chunkMemorySourceMessages,
  memorySourceEventHash,
  memorySourceRequestHash,
  normalizeMemorySourceEventCheck,
  normalizeMemorySourceRequest,
  normalizeMemorySourceScope,
  RAW_MEMORY_CHUNK_VERSION,
  readMemoryPolicy,
  validateMemorySourceWrite,
  type NewMemorySource,
} from "../src/memory/source.js";

function request(): Omit<NewMemorySource, "requestHash" | "chunkVersion"> {
  return {
    agent: " agent ",
    scope: "project",
    project: " test ",
    sourceSession: " session ",
    sourceTurn: " turn ",
    messages: [{ sourceMessage: " m ", role: "user", content: "  😺\r\n", occurredAt: null }],
  };
}

describe("原文切塊", () => {
  it("後半段優先切在完整段落，保留 UTF-16 位置、重疊及空訊息索引", () => {
    const firstParagraph = "a".repeat(600) + "\r\n\r\n";
    const messages = [
      { content: firstParagraph + "b".repeat(200) + "\n" + "c".repeat(600) },
      { content: "\t \r\n" },
      { content: "助理 😺\r\n " },
    ];
    const chunks = chunkMemorySourceMessages(messages);
    expect(chunks[0]).toEqual({ start: 0, end: firstParagraph.length, chunkIndex: 0, messageIndex: 0, content: firstParagraph });
    expect(chunks[1]?.start).toBe(firstParagraph.length - 128);
    expect(chunks[1]?.end).toBe(messages[0]?.content.length);
    expect(chunks[2]?.messageIndex).toBe(2);
    expect(chunks[2]?.content).toBe(messages[2]?.content);
    expect(chunkMemorySourceMessages(messages)).toEqual(chunks);
  });

  it("硬切與重疊遇到 surrogate pair 或 CRLF 時不切開字元", () => {
    for (const boundary of ["😺", "\r\n"]) {
      const atEnd = { content: "x".repeat(1023) + boundary + "y".repeat(200) };
      const atStart = { content: "x".repeat(895) + boundary + "y".repeat(126) + "\n" + "z".repeat(300) };
      expect(chunkMemorySourceMessages([atEnd])[0]?.end).toBe(1023);
      const chunks = chunkMemorySourceMessages([atStart]);
      expect(chunks[0]?.end).toBe(1024);
      expect(chunks[1]?.start).toBe(895);
      expect(chunks[1]?.content.startsWith(boundary)).toBe(true);
      expect(chunks.every(({ start, end }) => end - start <= 1024)).toBe(true);
    }
  });

  it("拒絕錯誤的片段索引、內容或 surrogate 邊界", () => {
    const { messages } = normalizeMemorySourceRequest(request());
    const chunks = chunkMemorySourceMessages(messages);
    expect(() => assertMemorySourceChunks(messages, RAW_MEMORY_CHUNK_VERSION, chunks)).not.toThrow();
    const chunk = chunks[0]!;
    expect(() => assertMemorySourceChunks(messages, RAW_MEMORY_CHUNK_VERSION, [{ ...chunk, chunkIndex: 1 }])).toThrow(TypeError);
    expect(() => assertMemorySourceChunks(messages, RAW_MEMORY_CHUNK_VERSION, [{ ...chunk, content: "改寫" }])).toThrow(TypeError);
    const start = messages[0]!.content.indexOf("😺") + 1;
    expect(() => assertMemorySourceChunks(messages, RAW_MEMORY_CHUNK_VERSION, [{
      ...chunk, start, content: chunk.content.slice(start),
    }])).toThrow(TypeError);
    const longContent = "x".repeat(1025);
    expect(() => assertMemorySourceChunks([{ ...messages[0]!, content: longContent }], RAW_MEMORY_CHUNK_VERSION, [{
      ...chunk, start: 0, end: longContent.length, content: longContent,
    }])).toThrow(TypeError);
  });
});

describe("原文來源輸入", () => {
  it("識別字及專案正規化，雜湊穩定且區分原始內容、時間、角色及 scope", () => {
    const input = request();
    const normalized = normalizeMemorySourceRequest(input);
    expect(normalized).toMatchObject({
      agent: "agent", project: "test", sourceSession: "session", sourceTurn: "turn",
      messages: [{ sourceMessage: "m", content: input.messages[0]!.content, occurredAt: null }],
    });
    const hash = memorySourceRequestHash(input);
    expect(hash).toBe(memorySourceRequestHash(normalized));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    const message = normalized.messages[0]!;
    expect(memorySourceRequestHash({ ...normalized, messages: [{ ...message, content: message.content.trim() }] })).not.toBe(hash);
    expect(memorySourceRequestHash({ ...normalized, messages: [{ ...message, occurredAt: "2026-11-06T00:00:00Z" }] })).not.toBe(hash);
    expect(memorySourceRequestHash({ ...normalized, messages: [{ ...message, role: "assistant" }] })).not.toBe(hash);
    expect(memorySourceRequestHash({ ...normalized, scope: "global", project: null })).not.toBe(hash);
    const event = normalizeMemorySourceEventCheck({ ...input, requestHash: hash });
    expect(event).toEqual({ agent: "agent", sourceSession: "session", sourceTurn: "turn", requestHash: hash });
    expect(memorySourceEventHash(event)).toBe(memorySourceEventHash(normalized));
    expect(memorySourceEventHash(event)).not.toBe(hash);
    expect(memorySourceEventHash(event)).not.toBe(memorySourceEventHash({ ...event, sourceTurn: "later" }));
  });

  it("拒絕不合法的識別值、時間、重複訊息、空內容、NUL 或孤立 surrogate", () => {
    const input = request();
    const message = input.messages[0]!;
    const fakeToken = ["gh", "p_", "1234567890test"].join("");
    for (const invalid of [
      { ...input, agent: fakeToken },
      { ...input, sourceTurn: "a".repeat(201) },
      { ...input, messages: [message, { ...message, sourceMessage: message.sourceMessage.trim() }] },
      { ...input, messages: [{ ...message, content: " \r\n " }] },
      { ...input, messages: [{ ...message, content: "無效\0資料" }] },
      { ...input, messages: [{ ...message, content: "無效\uD800資料" }] },
      { ...input, messages: [{ ...message, occurredAt: "yesterday" }] },
      { ...input, messages: [{ ...message, occurredAt: "2026-02-30T00:00:00Z" }] },
    ]) {
      expect(() => normalizeMemorySourceRequest(invalid)).toThrow(TypeError);
    }
    expect(() => normalizeMemorySourceScope(input, { project: fakeToken })).toThrow(TypeError);
    expect(() => normalizeMemorySourceEventCheck({ ...input, requestHash: "bad" })).toThrow(TypeError);
  });

  it("寫入前驗證雜湊與切塊版本，回傳一致的正規化資料", () => {
    const input = request();
    const requestHash = memorySourceRequestHash(input);
    const chunkVersion = RAW_MEMORY_CHUNK_VERSION;
    const chunks = chunkMemorySourceMessages(input.messages);
    expect(validateMemorySourceWrite({ ...input, requestHash, chunkVersion }, chunks)).toEqual({
      ...normalizeMemorySourceRequest(input), requestHash, chunkVersion,
    });
    expect(() => validateMemorySourceWrite({ ...input, requestHash: "bad", chunkVersion }, chunks)).toThrow(TypeError);
    expect(() => validateMemorySourceWrite({ ...input, requestHash, chunkVersion: "" }, chunks)).toThrow(TypeError);
  });

  it("政策未建立時開啟，未知值或版本無法被判讀為關閉", () => {
    expect(readMemoryPolicy(undefined)).toEqual({ maskSecrets: true, version: 1 });
    expect(readMemoryPolicy({ mask_secrets: false, version: 2 })).toEqual({ maskSecrets: false, version: 2 });
    expect(() => readMemoryPolicy({ mask_secrets: "false", version: 2 })).toThrow();
    expect(() => readMemoryPolicy({ mask_secrets: 0, version: 0 })).toThrow();
  });
});
