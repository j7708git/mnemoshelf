import type { Root } from "./api";

export interface RootsListProps {
  roots: Root[];
  selectedRootId: number | null;
  onSelect: (root: Root) => void;
  onRemove: (root: Root) => void;
}

const MODE_LABEL: Record<Root["mode"], string> = {
  browse: "只瀏覽",
  index: "瀏覽並索引",
};

/** 只取路徑最後一段當標題（完整路徑另外顯示）。用字串處理，不假設平台分隔符。 */
function basename(target: string): string {
  const parts = target.split(/[\\/]/).filter((part) => part !== "");
  return parts.length > 0 ? parts[parts.length - 1]! : target;
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString("zh-TW");
}

/** 已加入的資料夾清單：可選取（右側顯示目錄樹）與移除。 */
export function RootsList({ roots, selectedRootId, onSelect, onRemove }: RootsListProps) {
  if (roots.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-line bg-white/60 px-4 py-8 text-center">
        <p className="text-sm font-medium text-ink">尚未加入任何資料夾</p>
        <p className="mt-2 text-xs text-muted">按「加入」選擇一個資料夾，加入後會先顯示統計。</p>
      </div>
    );
  }

  return (
    <ul className="space-y-2">
      {roots.map((root) => {
        const selected = root.id === selectedRootId;
        return (
          <li key={root.id}>
            <div
              className={`rounded-lg border px-3 py-2 ${
                selected ? "border-ink bg-white" : "border-line bg-white/70"
              }`}
            >
              <div className="flex items-baseline justify-between gap-2">
                <button
                  type="button"
                  onClick={() => onSelect(root)}
                  aria-current={selected ? "true" : undefined}
                  className="min-w-0 flex-1 text-left"
                  title={root.path}
                >
                  <span className="block truncate text-sm font-medium text-ink">{basename(root.path)}</span>
                  <span className="mt-0.5 block break-all font-mono text-xs text-muted">{root.path}</span>
                </button>
                <button
                  type="button"
                  onClick={() => onRemove(root)}
                  className="shrink-0 rounded-md border border-line px-2 py-0.5 text-xs text-muted hover:text-red-600"
                >
                  移除
                </button>
              </div>
              <p className="mt-1 text-xs text-muted">
                {MODE_LABEL[root.mode]}　模態：{root.modalities.join("、") || "（無）"}
              </p>
              <p className="text-xs text-muted">加入時間：{formatDate(root.createdAt)}</p>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
