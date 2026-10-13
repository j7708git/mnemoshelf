/**
 * 中文斷詞（spike 筆記 §8 的「方案 S」）：
 * `Intl.Segmenter('zh-Hant', { granularity: 'word' })` 斷詞後以空白連接，交給 FTS5 的
 * `unicode61` tokenizer。
 *
 * 為什麼不用 trigram：trigram 對少於 3 個字元的查詢不 match，「向量」這類兩字中文詞
 * 完全搜不到（spike 實測 R@5 ≈ 0）。
 *
 * 這是 `MetadataStore` 的實作細節，不得洩漏到介面。
 */

const SEGMENTER = new Intl.Segmenter("zh-Hant", { granularity: "word" });

const ASCII_WORD = /^[A-Za-z0-9_]+$/;

/** 把內文斷成以空白分隔的 token（英數詞轉小寫以統一大小寫）。 */
export function segmentText(text: string): string {
  const tokens: string[] = [];
  for (const part of SEGMENTER.segment(text)) {
    if (!part.isWordLike) continue;
    const token = part.segment.trim();
    if (token.length === 0) continue;
    tokens.push(ASCII_WORD.test(token) ? token.toLowerCase() : token);
  }
  return tokens.join(" ");
}

/** 把查詢字串轉成 FTS5 的 MATCH 運算式；沒有可用 token 時回傳 null。 */
export function buildMatchExpression(query: string): string | null {
  const tokens = segmentText(query).split(" ").filter((t) => t.length > 0);
  if (tokens.length === 0) return null;
  // 加上雙引號避免查詢字串裡的 FTS 語法（例如 `"`、`OR`、`*`）影響解析。
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ");
}
