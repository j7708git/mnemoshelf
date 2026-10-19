/**
 * 記憶內容正規化與 hash 的單元測試（卡 C2 寫入去重的共用基礎）。
 *
 * 只測純函式：NFC、trim、空白收斂、大小寫／標點不動，以及 sha256 hex 的已知向量。
 * 去重語意（同 key 不新增、軟刪除可再新增…）在 `metadata-store.contract.ts` 驗證。
 */
import { describe, expect, it } from "vitest";
import { memoryContentHash, normalizeMemoryContentForHash } from "../src/index.js";

/** sha256("")（空字串）與 sha256("abc") 的已知向量。 */
const SHA256_EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const SHA256_ABC = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

describe("normalizeMemoryContentForHash", () => {
  it("trim 並把連續空白（含換行、Tab）收斂成單一空格", () => {
    expect(normalizeMemoryContentForHash("  第一行\r\n\r\n第二行\t ")).toBe("第一行 第二行");
    expect(normalizeMemoryContentForHash("a \n\t b")).toBe("a b");
    // Unicode 空白（全形空白）也一併收斂。
    expect(normalizeMemoryContentForHash("前\u3000後")).toBe("前 後");
  });

  it("空字串與全空白都回空字串", () => {
    expect(normalizeMemoryContentForHash("")).toBe("");
    expect(normalizeMemoryContentForHash(" \n\t\u3000 ")).toBe("");
  });

  it("Unicode NFC：組合字元與預組字元視為相同", () => {
    const decomposed = "e\u0301"; // e + combining acute
    const composed = "\u00e9"; // é
    expect(normalizeMemoryContentForHash(decomposed)).toBe(composed);
    expect(memoryContentHash(decomposed)).toBe(memoryContentHash(composed));
  });

  it("不轉大小寫、不動標點", () => {
    expect(normalizeMemoryContentForHash("Partition KEY, v1.2!")).toBe("Partition KEY, v1.2!");
    expect(normalizeMemoryContentForHash("PARTITION")).not.toBe(normalizeMemoryContentForHash("partition"));
    expect(normalizeMemoryContentForHash("a-b")).not.toBe(normalizeMemoryContentForHash("a b"));
  });

  it("不改變已經正規化的文字（冪等）", () => {
    const normalized = normalizeMemoryContentForHash("  已經 正規化\u3000的內容  ");
    expect(normalizeMemoryContentForHash(normalized)).toBe(normalized);
  });
});

describe("memoryContentHash", () => {
  it("回傳正規化後內容的 sha256 hex（已知向量）", () => {
    expect(memoryContentHash("  abc  ")).toBe(SHA256_ABC);
    expect(memoryContentHash("")).toBe(SHA256_EMPTY);
    expect(memoryContentHash(" \r\n\t ")).toBe(SHA256_EMPTY);
  });

  it("只差空白／換行的內容 hash 相同；不同內容 hash 不同", () => {
    expect(memoryContentHash("第一行 第二行")).toBe(memoryContentHash("第一行\r\n\r\n第二行  "));
    expect(memoryContentHash("內容 A")).not.toBe(memoryContentHash("內容 B"));
    // 只有大小寫不同就不是重複。
    expect(memoryContentHash("Content")).not.toBe(memoryContentHash("content"));
  });

  it("格式固定：64 個小寫十六進位字元", () => {
    expect(memoryContentHash("任意內容")).toMatch(/^[0-9a-f]{64}$/);
  });
});
