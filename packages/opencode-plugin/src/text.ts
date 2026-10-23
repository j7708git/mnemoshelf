/**
 * 召回與 digest 共用的純文字工具。
 *
 * 一律以 code point 計算與截斷，避免把 surrogate pair（emoji、部分 CJK 擴充字）切一半。
 */

/** 以字元數（code point）計算，避免截斷 surrogate pair。 */
export function charLength(text: string): number {
  return [...text].length;
}

/** 截到 `limit` 個字元；超長時保留結尾的 `…`。 */
export function truncateChars(text: string, limit: number): string {
  const chars = [...text];
  if (chars.length <= limit) return text;
  if (limit <= 1) return "…".slice(0, Math.max(0, limit));
  return `${chars.slice(0, limit - 1).join("")}…`;
}

/**
 * 保留**結尾** `limit` 個字元（前面加 `…`）。
 *
 * digest 只送助理的最終回覆，而最終回覆在長回覆的尾端；截頭比截尾合理。
 */
export function tailChars(text: string, limit: number): string {
  const chars = [...text];
  if (chars.length <= limit) return text;
  if (limit <= 1) return "…".slice(0, Math.max(0, limit));
  return `…${chars.slice(chars.length - (limit - 1)).join("")}`;
}
