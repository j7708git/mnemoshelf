/**
 * 虛擬化的目錄樹（lazy 載入子項 ＋ `@tanstack/react-virtual`）。
 *
 * - 展開目錄時才呼叫 `GET /roots/:id/entries`（子項不預先載入）。
 * - 只渲染視窗內的列（`useVirtualizer`），節點多時 DOM 不會爆。
 * - 純邏輯在 `flattenTree.ts`（可獨立測試）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { listEntries, type DirEntry } from "./api";
import { flattenTree } from "./flattenTree";

export interface DirectoryTreeProps {
  rootId: number;
  /** 變更這個值可強制重新載入（索引完成後刷新用）。 */
  refreshKey: number;
  /** 目前選取的檔案路徑（高亮用）。 */
  selectedPath: string | null;
  onSelectFile: (entry: DirEntry) => void;
}

type LoadState = "loading" | "ready" | "error";

/** 每列的固定高度（像素）；虛擬化用。 */
const ROW_HEIGHT = 30;

/** 檔案／目錄種類的圖示（純文字，不引入圖示套件）。 */
function kindIcon(entry: DirEntry, expanded: boolean): string {
  if (entry.kind === "dir") return expanded ? "▾" : "▸";
  switch (entry.kind) {
    case "image":
      return "▣";
    case "text":
    case "code":
      return "≡";
    case "audio":
    case "video":
      return "♪";
    default:
      return "•";
  }
}

export function DirectoryTree({ rootId, refreshKey, selectedPath, onSelectFile }: DirectoryTreeProps) {
  const [children, setChildren] = useState<Map<string, DirEntry[]>>(() => new Map());
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [state, setState] = useState<LoadState>("loading");
  const [error, setError] = useState("");
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(() => new Set());

  const parentRef = useRef<HTMLDivElement>(null);

  const loadDir = useCallback(
    async (dirPath: string): Promise<void> => {
      setLoadingDirs((previous) => new Set(previous).add(dirPath));
      try {
        const entries = await listEntries(rootId, dirPath);
        setChildren((previous) => {
          const next = new Map(previous);
          next.set(dirPath, entries);
          return next;
        });
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : "讀取目錄失敗");
        setState("error");
      } finally {
        setLoadingDirs((previous) => {
          const next = new Set(previous);
          next.delete(dirPath);
          return next;
        });
      }
    },
    [rootId],
  );

  // root 變更或要求刷新時：清空並重新載入最上層。
  useEffect(() => {
    setChildren(new Map());
    setExpanded(new Set());
    setError("");
    setState("loading");
    let cancelled = false;
    void (async () => {
      try {
        const entries = await listEntries(rootId, "");
        if (cancelled) return;
        setChildren(new Map([["", entries]]));
        setState("ready");
      } catch (loadError) {
        if (cancelled) return;
        setError(loadError instanceof Error ? loadError.message : "讀取目錄失敗");
        setState("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [rootId, refreshKey]);

  const toggleDir = (dirPath: string): void => {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(dirPath)) {
        next.delete(dirPath);
      } else {
        next.add(dirPath);
      }
      return next;
    });
    if (!children.has(dirPath)) void loadDir(dirPath);
  };

  const rows = useMemo(() => flattenTree(children, expanded), [children, expanded]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  return (
    <div ref={parentRef} className="h-full overflow-auto rounded-lg border border-line bg-white">
      {state === "loading" && <p className="px-4 py-6 text-sm text-muted">正在載入目錄…</p>}
      {state === "error" && (
        <p role="alert" className="px-4 py-6 text-sm text-red-600">
          {error}
        </p>
      )}
      {state === "ready" && rows.length === 0 && (
        <p className="px-4 py-6 text-sm text-muted">這個資料夾是空的（沒有可顯示的檔案或子目錄）。</p>
      )}
      {state === "ready" && rows.length > 0 && (
        <div style={{ height: virtualizer.getTotalSize(), position: "relative", width: "100%" }}>
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const row = rows[virtualRow.index]!;
            const isDir = row.entry.kind === "dir";
            const isSelected = !isDir && row.entry.path === selectedPath;
            const isLoading = loadingDirs.has(row.entry.path);
            return (
              <div
                key={row.entry.path}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  height: `${virtualRow.size}px`,
                  transform: `translateY(${virtualRow.start}px)`,
                }}
              >
                <button
                  type="button"
                  title={row.entry.path}
                  aria-expanded={isDir ? row.expanded : undefined}
                  onClick={() => (isDir ? toggleDir(row.entry.path) : onSelectFile(row.entry))}
                  className={`flex h-full w-full items-center gap-2 pr-3 text-left text-sm hover:bg-surface ${
                    isSelected ? "bg-surface font-medium text-ink" : "text-ink"
                  }`}
                  style={{ paddingLeft: `${8 + row.depth * 14}px` }}
                >
                  <span aria-hidden="true" className="w-4 shrink-0 text-center text-xs text-muted">
                    {isLoading ? "…" : kindIcon(row.entry, row.expanded)}
                  </span>
                  <span className="truncate">{row.entry.name}</span>
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
