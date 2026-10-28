/**
 * 訊息文字抽取與剝除。
 *
 * 這些規則直接對應 `docs/agent-integration.md` §注入標記與剝除／§不送什麼：
 * - `<memory-context>` 整塊（含被截斷、沒有收尾標籤的不完整區塊）一律移除；
 * - 附件（`<file>`／`<attached-file>`／`<attachment>`）與 `<system-reminder>` 不進卡片；
 * - 只取 `type:"text"` 的 content block，工具輸出／reasoning／媒體不會被當成對話文字。
 *
 * 純函式：同輸入、同規則 → 同輸出（卡片確定性的前提）。
 */

/** 只把物件當成可讀的 key-value 容器；陣列與 null 都回 null。 */
export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * 取一則訊息的純文字：只讀 `type:"text"` 的 block。
 *
 * dsh 的 `user/message.data.content` 與 `assistant/message.data.message.content` 都是
 * block 陣列；不是陣列時回空字串（不猜測宿主格式）。
 */
export function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    const record = asRecord(block);
    if (record === null) continue;
    if (record.type !== "text") continue;
    if (typeof record.text !== "string" || record.text === "") continue;
    parts.push(record.text);
  }
  return parts.join("\n");
}

/** 移除所有 `<memory-context …>…</memory-context>`；沒有收尾標籤時丟到字串尾端。 */
export function stripMemoryContext(text: string): string {
  return String(text)
    .replace(/<\s*memory-context\b[^>]*>[\s\S]*?<\s*\/\s*memory-context\s*>/gi, " ")
    .replace(/<\s*memory-context\b[^>]*>[\s\S]*$/i, " ")
    .replace(/<\s*\/?\s*memory-context\b[^>]*>/gi, " ");
}

/** 移除宿主內嵌的附件與 system-reminder 區塊。 */
export function stripHostBlocks(text: string): string {
  return String(text)
    .replace(/<file\b[^>]*>[\s\S]*?<\s*\/\s*file\s*>/gi, " ")
    .replace(/<attached-file\b[^>]*>[\s\S]*?<\s*\/\s*attached-file\s*>/gi, " ")
    .replace(/<attachment\b[^>]*>[\s\S]*?<\s*\/\s*attachment\s*>/gi, " ")
    .replace(/<system-reminder\b[^>]*>[\s\S]*?<\s*\/\s*system-reminder\s*>/gi, " ")
    // 沒有收尾標籤的 system-reminder：整段到尾端都不可信（保守做法）。
    .replace(/<system-reminder\b[^>]*>[\s\S]*$/gi, " ")
    .replace(/<\s*\/?\s*system-reminder\b[^>]*>/gi, " ");
}

/** 把連續空白（含換行）收斂成單一空格，並去掉前後空白。 */
export function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

/** 卡片／查詢共用的清洗：先剝除注入塊與宿主區塊，再正規化空白。 */
export function cleanText(text: string): string {
  return normalizeWhitespace(stripHostBlocks(stripMemoryContext(String(text))));
}

/** 中和可以提前關閉注入圍籬的結尾標籤。 */
export function escapeMemoryText(text: string): string {
  return text.replace(/<\/memory-context\s*>/gi, "<\\/memory-context>");
}

/** 轉義 XML 屬性值（project 名稱可能含引號）。 */
export function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** 以 code point 計算字元數，避免 surrogate pair 被算成兩個。 */
export function charLength(text: string): number {
  return [...text].length;
}

/** 截到 `limit` 個 code point；超長時保留結尾的 `…`。 */
export function truncateChars(text: string, limit: number): string {
  const chars = [...text];
  if (chars.length <= limit) return text;
  if (limit <= 1) return "…".slice(0, Math.max(0, limit));
  return `${chars.slice(0, limit - 1).join("")}…`;
}
