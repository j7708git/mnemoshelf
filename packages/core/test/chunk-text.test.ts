import { describe, expect, it } from "vitest";
import { CHUNK_MAX_CHARS, chunkCode, chunkText } from "../src/index.js";

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

describe("chunkCode", () => {
  it("以行邊界累積，不超過上限", () => {
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
