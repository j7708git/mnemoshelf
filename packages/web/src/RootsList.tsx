import type { Root } from "./api";

export interface RootsListProps {
  roots: Root[];
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

/** 已加入的資料夾清單（本卡只讀 `GET /roots`；加入／移除與目錄樹留待後續卡）。 */
export function RootsList({ roots }: RootsListProps) {
  if (roots.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-line bg-white/60 px-6 py-12 text-center">
        <p className="text-base font-medium text-ink">尚未加入任何資料夾</p>
        <p className="mt-2 text-sm text-muted">
          加入資料夾、目錄樹與搜尋功能會在後續版本提供；本版本只顯示已加入的資料夾清單。
        </p>
      </div>
    );
  }

  return (
    <ul className="space-y-2">
      {roots.map((root) => (
        <li key={root.id} className="rounded-lg border border-line bg-white px-4 py-3">
          <div className="flex items-baseline justify-between gap-3">
            <span className="truncate font-medium text-ink" title={root.path}>
              {basename(root.path)}
            </span>
            <span className="shrink-0 rounded-full border border-line px-2 py-0.5 text-xs text-muted">
              {MODE_LABEL[root.mode]}
            </span>
          </div>
          <p className="mt-1 break-all font-mono text-xs text-muted">{root.path}</p>
          <p className="mt-1 text-xs text-muted">
            模態：{root.modalities.join("、") || "（無）"}　加入時間：{formatDate(root.createdAt)}
          </p>
        </li>
      ))}
    </ul>
  );
}
