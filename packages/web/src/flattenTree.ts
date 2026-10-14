/**
 * 目錄樹的扁平化（純函式，與 React 無關）。
 *
 * 目錄樹的資料本質是「展開狀態 ＋ 已載入的子項表」；UI 只需要一維列陣列，
 * 交給 `@tanstack/react-virtual` 虛擬化。子項是 lazy 載入的：`childrenByDir` 只會有
 * 實際載入過的目錄，沒有的目錄視為「尚未載入」。
 */
import type { DirEntry } from "./api";

/** 一列（樹的可見節點）。 */
export interface TreeRow {
  entry: DirEntry;
  /** 縮排層級；root 的直接子項為 0。 */
  depth: number;
  /** 目錄是否展開。 */
  expanded: boolean;
}

/**
 * 把「已載入的子項表 ＋ 展開集合」攤平成可見列。
 *
 * `childrenByDir` 以**目錄的相對路徑**為 key（root 本身為 `""`）。
 */
export function flattenTree(childrenByDir: Map<string, DirEntry[]>, expanded: Set<string>): TreeRow[] {
  const rows: TreeRow[] = [];

  const walk = (dir: string, depth: number): void => {
    const children = childrenByDir.get(dir);
    if (children === undefined) return;
    for (const entry of children) {
      const isDir = entry.kind === "dir";
      const isExpanded = isDir && expanded.has(entry.path);
      rows.push({ entry, depth, expanded: isExpanded });
      if (isExpanded) walk(entry.path, depth + 1);
    }
  };

  walk("", 0);
  return rows;
}
