import { describe, expect, it } from "vitest";
import {
  CHUNK_MAX_CHARS,
  CHUNK_MAX_TOKENS,
  chunkCode,
  chunkText,
  estimateTokens,
} from "../src/index.js";

function section(index: number, body = 700): string {
  return `# H${index}\n\n${"a".repeat(body)}`;
}

describe("chunkText", () => {
  it("空內容回傳空陣列", () => {
    expect(chunkText("")).toEqual([]);
    expect(chunkText("   \n\t\n  ")).toEqual([]);
  });

  it("短內容只有一塊", () => {
    const chunks = chunkText("# 標題\n\n短短一行");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.text).toContain("短短一行");
  });

  it("多個標題且每節夠大時，一節一塊且落在 600–1200", () => {
    const content = [section(1), section(2), section(3), section(4)].join("\n\n");
    const chunks = chunkText(content);
    expect(chunks).toHaveLength(4);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeGreaterThanOrEqual(600);
      expect(chunk.text.length).toBeLessThanOrEqual(CHUNK_MAX_CHARS);
    }
  });

  it("相鄰小節會被合併到不超過上限", () => {
    const content = [section(1, 400), section(2, 400)].join("\n\n");
    const chunks = chunkText(content);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.text.length).toBeLessThanOrEqual(CHUNK_MAX_CHARS);
  });

  it("超長段落會被切成不超過 1200 的多塊", () => {
    const content = "x".repeat(3000);
    const chunks = chunkText(content);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(CHUNK_MAX_CHARS);
    }
  });

  it("標題與其後第一段保持在一起，不產生極短的標題塊", () => {
    const chunks = chunkText(`# 標題\n\n${"x".repeat(3000)}`);
    expect(chunks[0]!.text.startsWith("# 標題")).toBe(true);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeGreaterThanOrEqual(600);
      expect(chunk.text.length).toBeLessThanOrEqual(CHUNK_MAX_CHARS);
    }
  });

  it("邊界：1200 剛好一塊，1201 會變兩塊", () => {
    const exact = "y".repeat(CHUNK_MAX_CHARS);
    expect(chunkText(exact)).toHaveLength(1);

    const over = "y".repeat(CHUNK_MAX_CHARS + 1);
    const pieces = chunkText(over);
    expect(pieces.length).toBe(2);
    expect(pieces[0]!.text.length).toBe(CHUNK_MAX_CHARS);
    for (const piece of pieces) expect(piece.text.length).toBeLessThanOrEqual(CHUNK_MAX_CHARS);
  });
});

describe("estimateTokens（保守估算）", () => {
  it("中文以 1 字 1 token 計、ASCII 以 3 字元 1 token 計", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("中文")).toBe(2);
    expect(estimateTokens("中".repeat(CHUNK_MAX_TOKENS))).toBe(CHUNK_MAX_TOKENS);
    expect(estimateTokens("a".repeat(1200))).toBe(400);
  });

  it("混合內容會把中英文一起計入", () => {
    // 10 個中文字（10）+ 300 個 ASCII（100）= 110
    expect(estimateTokens(`${"中".repeat(10)}${"a".repeat(300)}`)).toBe(110);
  });
});

describe("token 預算護欄（CJK 長塊）", () => {
  it("1200 個中文字的單一塊會被切成多塊，每塊估算 token 不超過上限", () => {
    const content = "中".repeat(1200);
    expect(estimateTokens(content)).toBeGreaterThan(CHUNK_MAX_TOKENS);

    const chunks = chunkText(content);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(estimateTokens(chunk.text)).toBeLessThanOrEqual(CHUNK_MAX_TOKENS);
      expect(chunk.text.length).toBeLessThanOrEqual(CHUNK_MAX_CHARS);
    }
    // 內容不得遺失（CJK 無空白，切點不會被 trim 掉）。
    expect(chunks.map((chunk) => chunk.text).join("")).toBe(content);
  });

  it("16 節 × ~1200 中文字的批次：每塊受限、總塊數可預期（確定性）", () => {
    const sections = Array.from({ length: 16 }, (_, index) => `# 第 ${index} 節\n\n${"字".repeat(1200)}`);
    const content = sections.join("\n\n");

    const chunks = chunkText(content);

    // 每節至少 3 塊（1200 字 ÷ 512 token/塊）；16 節 ⇒ 48 塊以上。
    expect(chunks.length).toBeGreaterThanOrEqual(48);
    for (const chunk of chunks) {
      expect(estimateTokens(chunk.text)).toBeLessThanOrEqual(CHUNK_MAX_TOKENS);
      expect(chunk.text.length).toBeLessThanOrEqual(CHUNK_MAX_CHARS);
    }
    // 一窗（16 塊）的 token 總量因此有上界：16 × 512，遠低於會產生 GB 級配置的區間。
    expect(16 * CHUNK_MAX_TOKENS).toBeLessThanOrEqual(8192);
  });

  it("一般英文不受影響：1200 字元的 ASCII 仍是一塊（估算 400 token）", () => {
    expect(estimateTokens("x".repeat(CHUNK_MAX_CHARS))).toBeLessThanOrEqual(CHUNK_MAX_TOKENS);
    expect(chunkText("x".repeat(CHUNK_MAX_CHARS))).toHaveLength(1);
  });

  it("程式碼的長中文註解行同樣受限（行邊界先讓位，避免超長塊）", () => {
    const longComment = `# ${"註".repeat(1000)}`;
    const chunks = chunkCode([longComment, "const a = 1;"].join("\n"));
    for (const chunk of chunks) {
      expect(estimateTokens(chunk.text)).toBeLessThanOrEqual(CHUNK_MAX_TOKENS);
    }
  });
});

describe("chunkCode", () => {  it("以行邊界累積，不超過上限", () => {
    const lines = Array.from(
      { length: 40 },
      (_, index) => `const value${index} = ${index}; // ${"-".repeat(40)}`,
    );
    const chunks = chunkCode(lines.join("\n"));
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(CHUNK_MAX_CHARS);
    }
    // 每塊的行都是完整的（重新組合可還原內容）
    expect(chunks.map((chunk) => chunk.text).join("\n")).toBe(lines.join("\n"));
  });

  it("空內容回傳空陣列", () => {
    expect(chunkCode("\n\n")).toEqual([]);
  });
});
