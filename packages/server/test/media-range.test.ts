/**
 * `parseMediaRange` 的單元測試（影片播放端點的 Range 解析）。
 *
 * 設計依據：A1 播放 spike 13/13（206／416／單次 4 MiB 上限／續傳／suffix）。
 * 這裡只測純函式；HTTP 行為（header、串流、401／403／415／413）在 `media-http.test.ts`。
 */
import { describe, expect, it } from "vitest";
import { MEDIA_RANGE_MAX_BYTES, parseMediaRange } from "../src/index.js";

const SIZE = 10 * 1024 * 1024; // 10 MiB：大於單次上限，方便驗證截短

describe("parseMediaRange", () => {
  it("沒有 Range header → 200 整檔（full）", () => {
    expect(parseMediaRange(undefined, SIZE)).toEqual({ kind: "full", totalBytes: SIZE });
    expect(parseMediaRange("", SIZE)).toEqual({ kind: "full", totalBytes: SIZE });
    expect(parseMediaRange("   ", SIZE)).toEqual({ kind: "full", totalBytes: SIZE });
  });

  it("bytes=0-99 → partial 0–99", () => {
    expect(parseMediaRange("bytes=0-99", SIZE)).toEqual({ kind: "partial", start: 0, end: 99, totalBytes: SIZE });
  });

  it("開放式 bytes=a- → 到檔尾（未超上限時）", () => {
    expect(parseMediaRange("bytes=100-", 200)).toEqual({ kind: "partial", start: 100, end: 199, totalBytes: 200 });
  });

  it("開放式 bytes=0- 在超過單次上限時截到 4 MiB", () => {
    expect(parseMediaRange("bytes=0-", SIZE)).toEqual({
      kind: "partial",
      start: 0,
      end: MEDIA_RANGE_MAX_BYTES - 1,
      totalBytes: SIZE,
    });
    // 續傳：從上限之後再要，仍受上限約束。
    expect(parseMediaRange(`bytes=${MEDIA_RANGE_MAX_BYTES}-`, SIZE)).toEqual({
      kind: "partial",
      start: MEDIA_RANGE_MAX_BYTES,
      end: 2 * MEDIA_RANGE_MAX_BYTES - 1,
      totalBytes: SIZE,
    });
  });

  it("明確範圍超過上限時截短（仍是 206，不是錯誤）", () => {
    const decision = parseMediaRange("bytes=0-9000000", SIZE);
    expect(decision).toEqual({ kind: "partial", start: 0, end: MEDIA_RANGE_MAX_BYTES - 1, totalBytes: SIZE });
  });

  it("尾端範圍不超過上限時完整回傳", () => {
    expect(parseMediaRange("bytes=10000000-10485759", SIZE)).toEqual({
      kind: "partial",
      start: 10_000_000,
      end: 10_485_759,
      totalBytes: SIZE,
    });
  });

  it("suffix bytes=-100 → 最後 100 bytes", () => {
    expect(parseMediaRange("bytes=-100", SIZE)).toEqual({ kind: "partial", start: SIZE - 100, end: SIZE - 1, totalBytes: SIZE });
  });

  it("suffix 大於檔案 → 整檔（0..size-1）", () => {
    expect(parseMediaRange("bytes=-999999999", 200)).toEqual({ kind: "partial", start: 0, end: 199, totalBytes: 200 });
  });

  it("越界／end < start／空檔 → unsatisfiable（416）", () => {
    expect(parseMediaRange("bytes=99999999-", SIZE)).toEqual({ kind: "unsatisfiable", totalBytes: SIZE });
    expect(parseMediaRange("bytes=100-99", SIZE)).toEqual({ kind: "unsatisfiable", totalBytes: SIZE });
    expect(parseMediaRange("bytes=-0", SIZE)).toEqual({ kind: "unsatisfiable", totalBytes: SIZE });
    expect(parseMediaRange("bytes=0-", 0)).toEqual({ kind: "unsatisfiable", totalBytes: 0 });
  });

  it("多段 Range 一律 416（只支援單一範圍）", () => {
    expect(parseMediaRange("bytes=0-99,200-299", SIZE)).toEqual({ kind: "unsatisfiable", totalBytes: SIZE });
    expect(parseMediaRange("bytes=0-99, 200-299", SIZE)).toEqual({ kind: "unsatisfiable", totalBytes: SIZE });
  });

  it("畸形／非 bytes 單位 → 416", () => {
    for (const header of ["items=0-1", "bytes=", "bytes=-", "bytes=abc-def", "bytes=1-2-3", "bytes= 0-1", "bytes=0 - 1"]) {
      expect(parseMediaRange(header, SIZE)).toEqual({ kind: "unsatisfiable", totalBytes: SIZE });
    }
  });

  it("自訂單次上限（測試可覆寫）", () => {
    expect(parseMediaRange("bytes=0-", 100, 10)).toEqual({ kind: "partial", start: 0, end: 9, totalBytes: 100 });
    expect(parseMediaRange("bytes=-50", 100, 10)).toEqual({ kind: "partial", start: 50, end: 59, totalBytes: 100 });
  });
});
