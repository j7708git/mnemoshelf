/**
 * 記憶內容的正規化與內容 hash（寫入去重與匯入去重共用；不得各自實作）。
 *
 * 正規化只做**語意無關**的收斂，讓「只差空白／換行」的內容視為同一筆：
 * Unicode NFC → 去除前後空白 → 連續空白（含換行、Tab 與 Unicode 空白）收斂為單一空格。
 * **不轉大小寫、不動標點**——避免把不同語意的內容誤判為重複。
 *
 * hash 是正規化後 UTF-8 內容的 sha256 hex；只存在本機資料庫（`memories.content_hash`），
 * 不含原文，也不做任何網路傳輸。
 */
import { createHash } from "node:crypto";

/**
 * 把記憶內容正規化成「去重比較用」的字串（見檔頭說明）。
 *
 * 例：`"  第一行\r\n\r\n第二行\t "` → `"第一行 第二行"`。
 * 空字串或全空白 → `""`（呼叫端不得把空內容寫入記憶）。
 */
export function normalizeMemoryContentForHash(content: string): string {
  return content.normalize("NFC").trim().replace(/\s+/gu, " ");
}

/**
 * 記憶內容的 sha256 hex（取 `normalizeMemoryContentForHash` 後的 UTF-8 位元組）。
 *
 * 同一個回傳值代表「正規化後完全相同」；呼叫端另以 scope／project／agent 當去重 key 的一部分
 * （見 `MetadataStore.addMemoryUnlessDuplicate`）。
 */
export function memoryContentHash(content: string): string {
  return createHash("sha256").update(normalizeMemoryContentForHash(content), "utf8").digest("hex");
}
