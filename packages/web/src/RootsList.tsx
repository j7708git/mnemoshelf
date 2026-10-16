import type { Root } from "./api";

export interface RootsListProps {
  roots: Root[];
  selectedRootId: number | null;
  onSelect: (root: Root) => void;
  onRemove: (root: Root) => void;
  /**
   * 切換某個 root 的圖片模態（`PATCH /roots/:id`；見 `onToggleImages`）。
   *
   * 省略時不顯示這個開關（讓沒有這個能力的呼叫端維持原樣）。
   */
  onToggleImages?: (root: Root, enabled: boolean) => void;
  /** 正在更新設定的 root id（避免重複送出）。 */
  imagesBusyRootId?: number | null;
}

const MODE_LABEL: Record<Root["mode"], string> = {
  browse: "只瀏覽",
  index: "瀏覽並索引",
};

/** 模態 → 中文標籤（清單顯示用；未知值原樣顯示）。 */
const MODALITY_LABEL: Record<string, string> = {
  text: "文字",
  code: "程式碼",
  image: "圖片",
  audio: "音訊",
  video: "影片",
};

/** 這個 root 目前有沒有開圖片模態？ */
function imagesEnabled(root: Root): boolean {
  return root.modalities.includes("image");
}

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
export function RootsList({
  roots,
  selectedRootId,
  onSelect,
  onRemove,
  onToggleImages,
  imagesBusyRootId,
}: RootsListProps) {
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
                {MODE_LABEL[root.mode]}　模態：
                {root.modalities.map((modality) => MODALITY_LABEL[modality] ?? modality).join("、") || "（無）"}
              </p>
              {onToggleImages !== undefined && root.mode === "index" && (
                <label className="mt-1 flex items-center gap-1.5 text-xs text-ink">
                  <input
                    type="checkbox"
                    checked={imagesEnabled(root)}
                    disabled={imagesBusyRootId === root.id}
                    onChange={(event) => onToggleImages(root, event.target.checked)}
                    // 點開關不該同時把這個資料夾選取起來（外層是可點的按鈕區塊）。
                    onClick={(event) => event.stopPropagation()}
                  />
                  含照片（一起索引）
                  <span className="text-muted" title="改變設定後要重新索引才會生效">
                    （重新索引後生效）
                  </span>
                </label>
              )}
              <p className="text-xs text-muted">加入時間：{formatDate(root.createdAt)}</p>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
