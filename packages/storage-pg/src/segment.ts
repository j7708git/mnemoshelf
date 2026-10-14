/**
 * 中文斷詞（與 core 的 SQLite 後端同一套「方案 S」）。
 *
 * PostgreSQL 內建 parser 對連續中文視為**單一 token**（實測：`to_tsvector('simple','儲存介面與向量搜尋')`
 * 只產生一個 lexeme），因此不做應用層斷詞就完全搜不到中文。
 * 這裡用 `Intl.Segmenter('zh-Hant', { granularity: 'word' })` 斷詞後以空白連接存入 `seg` 欄位，
 * 再交給 generated `tsvector('simple', seg)`；查詢端用**同一個**函式斷詞，兩邊 token 才會一致。
 *
 * 這是 `MetadataStore` 的實作細節，不得洩漏到介面。
 */

const SEGMENTER = new Intl.Segmenter("zh-Hant", { granularity: "word" });

/** 純英數詞（含底線）；這類 token 轉小寫，讓查詢大小寫不敏感。 */
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
