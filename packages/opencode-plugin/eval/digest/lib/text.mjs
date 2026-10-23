/**
 * 比對規則（寫死，不讓各處自行發揮）。
 *
 * 正規化＝NFKC（全形轉半形）→ 轉小寫 → 移除所有空白；之後一律做**子字串**比對。
 * 最短比對長度 4 個字元：太短的針（例如「好」）沒有辨識力，載入 fixture 時直接視為錯誤。
 */

/** 最短比對長度（正規化後的字元數）。 */
export const MIN_NEEDLE_CHARS = 4;

/** 正規化：NFKC → 小寫 → 去空白。 */
export function normalizeForMatch(value) {
  if (typeof value !== "string") return "";
  return value.normalize("NFKC").toLowerCase().replace(/\s+/gu, "");
}

/** 正規化後的字元數（以 code point 計）。 */
export function needleLength(needle) {
  return [...normalizeForMatch(needle)].length;
}

/** 針是否達最短比對長度。 */
export function isUsableNeedle(needle) {
  return needleLength(needle) >= MIN_NEEDLE_CHARS;
}

/**
 * 文字集合中是否出現這個針。
 *
 * @param {string|string[]} haystack 單一文字或多段文字（逐段比對，不跨段拼接）
 * @param {string} needle
 */
export function includesNeedle(haystack, needle) {
  const normalizedNeedle = normalizeForMatch(needle);
  if (normalizedNeedle === "") return false;
  const parts = Array.isArray(haystack) ? haystack : [haystack];
  return parts.some((part) => normalizeForMatch(part).includes(normalizedNeedle));
}

/** 回傳沒有命中的針（保持原順序）。 */
export function missingNeedles(haystack, needles) {
  const parts = Array.isArray(haystack) ? haystack : [haystack];
  return (needles ?? []).filter((needle) => !includesNeedle(parts, needle));
}

/** 回傳命中的針（保持原順序）。 */
export function hitNeedles(haystack, needles) {
  const parts = Array.isArray(haystack) ? haystack : [haystack];
  return (needles ?? []).filter((needle) => includesNeedle(parts, needle));
}
