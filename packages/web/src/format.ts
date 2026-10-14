/** 顯示用的格式化工具（純函式）。 */

import type { MemoryKind, MemoryScope } from "./api";

/** 人類可讀的位元組大小。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** ISO 時間字串 → 本地化顯示；無法解析時原樣回傳。 */
export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString("zh-TW");
}

/** 記憶種類的中文標籤。 */
export const MEMORY_KIND_LABEL: Record<MemoryKind, string> = {
  fact: "事實",
  decision: "決策",
  pitfall: "踩坑",
  preference: "偏好",
};

/** 記憶作用範圍的中文標籤。 */
export const MEMORY_SCOPE_LABEL: Record<MemoryScope, string> = {
  global: "全域",
  project: "專案",
  agent: "agent",
};

/** 取路徑最後一段當顯示名稱；不假設平台分隔符。 */
export function basename(target: string): string {
  const parts = target.split(/[\\/]/).filter((part) => part !== "");
  return parts.length > 0 ? parts[parts.length - 1]! : target;
}
