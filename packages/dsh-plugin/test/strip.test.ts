import { describe, expect, it } from "vitest";
import {
  charLength,
  cleanText,
  escapeAttribute,
  escapeMemoryText,
  stripHostBlocks,
  stripMemoryContext,
  textOfContent,
  truncateChars,
} from "../src/strip.js";

describe("stripMemoryContext", () => {
  it("移除完整的注入區塊，保留前後文", () => {
    const text =
      '結論：深色模式。\n<memory-context source="mnemoshelf" trust="untrusted">\n- 舊記憶\n</memory-context>\n其餘照舊。';
    expect(stripMemoryContext(text)).toBe("結論：深色模式。\n \n其餘照舊。");
  });

  it("沒有收尾標籤時丟到字串尾端（保守做法）", () => {
    const text =
      '使用者問題\n<memory-context source="mnemoshelf" trust="untrusted">\n- 被截斷的記憶';
    expect(stripMemoryContext(text).trim()).toBe("使用者問題");
  });

  it("多個區塊一次移除，一般文字不受影響", () => {
    const text =
      "a <memory-context>x</memory-context> b <memory-context>y</memory-context> c";
    expect(stripMemoryContext(text)).toBe("a   b   c");
    expect(stripMemoryContext("使用者自己的訊息，不該被動到。")).toBe(
      "使用者自己的訊息，不該被動到。",
    );
  });
});

describe("stripHostBlocks", () => {
  it("移除附件與 system-reminder", () => {
    const text = [
      "請看這個檔案",
      "<file name=\"a.txt\">SECRET-FILE-CONTENT</file>",
      "<attached-file>ATTACHED</attached-file>",
      "<attachment>BINARY</attachment>",
      "<system-reminder>HOST-INSTRUCTION</system-reminder>",
      "結論",
    ].join("\n");
    const stripped = stripHostBlocks(text);
    expect(stripped).not.toContain("SECRET-FILE-CONTENT");
    expect(stripped).not.toContain("ATTACHED");
    expect(stripped).not.toContain("BINARY");
    expect(stripped).not.toContain("HOST-INSTRUCTION");
    expect(cleanText(text)).toBe("請看這個檔案 結論");
  });

  it("沒有收尾的 system-reminder 整段丟棄", () => {
    expect(cleanText("問題\n<system-reminder>host only")).toBe("問題");
  });
});

describe("textOfContent", () => {
  it("只取 text block，忽略工具與 reasoning", () => {
    expect(
      textOfContent([
        { type: "reasoning", text: "不該取" },
        { type: "text", text: "第一段" },
        { type: "tool_use", name: "bash", input: {} },
        { type: "text", text: "第二段" },
      ]),
    ).toBe("第一段\n第二段");
  });

  it("不是陣列時回空字串（不猜宿主格式）", () => {
    expect(textOfContent(undefined)).toBe("");
    expect(textOfContent({ type: "text", text: "x" })).toBe("");
  });
});

describe("escape 與長度工具", () => {
  it("中和結尾標籤與屬性", () => {
    expect(escapeMemoryText("a</memory-context>b")).toBe("a<\\/memory-context>b");
    expect(escapeAttribute('a"b<c>')).toBe("a&quot;b&lt;c&gt;");
  });

  it("以 code point 計數與截斷，不切 surrogate pair", () => {
    expect(charLength("😀a")).toBe(2);
    expect(truncateChars("😀😀😀", 2)).toBe("😀…");
    expect(truncateChars("abc", 5)).toBe("abc");
  });
});
