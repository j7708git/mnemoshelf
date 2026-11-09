import { useState } from "react";
import type { Root, VideoCapability } from "./api";
import {
  DEFAULT_VIDEO_MAX_FILE_BYTES,
  effectiveVideoMaxFileBytes,
  formatVideoLimitBytes,
  parseVideoLimitMiB,
  videoLimitMiBDefault,
  VIDEO_LIMIT_MAX_MIB,
  VIDEO_LIMIT_MIN_MIB,
  videoToggleState,
} from "./media";

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
  onToggleAudio?: (root: Root, enabled: boolean) => void;
  /**
   * 切換某個 root 的影片模態（`PATCH /roots/:id`）。
   *
   * 省略時不顯示這個開關；`videoCapability` 非 `available` 時開關停用並顯示原因。
   */
  onToggleVideo?: (root: Root, enabled: boolean) => void;
  /** 服務層影片能力（`GET /roots` 的 `video`）；`undefined`＝尚未取得、`null`＝服務未回報。 */
  videoCapability?: VideoCapability | null;
  /**
   * 儲存某個 root 的影片單檔大小上限（bytes；呼叫端走 `PATCH /roots/:id`）。
   *
   * `bytes === null` 表示**清除設定**（回到服務層預設；Core `RootPatch` 契約）。
   * 省略時不顯示上限編輯器；影片模態未開啟也可以設定（契約允許）。
   */
  onSetVideoMaxFileBytes?: (root: Root, bytes: number | null) => void;
  /** 正在儲存上限的 root id（避免重複送出）。 */
  videoLimitBusyRootId?: number | null;
  /** 服務層預設的影片單檔上限（bytes；root 未設定時的顯示與 placeholder 用）。 */
  defaultVideoMaxFileBytes?: number;
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
  onToggleAudio,
  onToggleVideo,
  videoCapability,
  onSetVideoMaxFileBytes,
  videoLimitBusyRootId,
  defaultVideoMaxFileBytes,
  imagesBusyRootId,
}: RootsListProps) {
  const videoToggle = videoToggleState(videoCapability ?? null);
  const videoEnabled = (root: Root): boolean => root.modalities.includes("video");
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
              {onToggleAudio !== undefined && root.mode === "index" && (
                <label className="mt-1 flex items-center gap-1.5 text-xs text-ink">
                  <input type="checkbox" checked={root.modalities.includes("audio")}
                    disabled={imagesBusyRootId === root.id}
                    onChange={(event) => onToggleAudio(root, event.target.checked)} />
                  含音訊 WAV（重新索引後生效）
                </label>
              )}
              {onToggleVideo !== undefined && root.mode === "index" && (
                <label className="mt-1 flex items-start gap-1.5 text-xs text-ink">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={videoEnabled(root)}
                    disabled={imagesBusyRootId === root.id || !videoToggle.enabled}
                    onChange={(event) => onToggleVideo(root, event.target.checked)}
                  />
                  <span>
                    含影片 .mp4（重新索引後生效）
                    <span className="mt-0.5 block text-xs text-muted">
                      {videoToggle.enabled
                        ? "每 4 秒抽 1 幀；時長上限 600 秒、單檔上限依服務設定。音訊另需勾「含音訊」。"
                        : videoToggle.reason ?? "影片能力不可用。"}
                    </span>
                  </span>
                </label>
              )}
              {onSetVideoMaxFileBytes !== undefined && root.mode === "index" && (
                <VideoLimitEditor
                  root={root}
                  fallbackBytes={defaultVideoMaxFileBytes ?? DEFAULT_VIDEO_MAX_FILE_BYTES}
                  busy={videoLimitBusyRootId === root.id}
                  onSave={onSetVideoMaxFileBytes}
                />
              )}
              <p className="text-xs text-muted">加入時間：{formatDate(root.createdAt)}</p>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
/**
 * 單一 root 的影片單檔大小上限編輯器（單位 MiB；送出時換算成 bytes）。
 *
 * - 顯示目前生效值（root 設定 → 服務預設 → 產品預設 512 MiB）；未設定時標「服務預設」。
 * - 輸入為整數 MiB（1–16384）；不合法時即時顯示原因並阻擋送出，不默默截斷。
 * - **與影片模態無關**：影片未開啟也能設定（契約明定），只改設定、不會自動重新索引。
 */
function VideoLimitEditor({
  root,
  fallbackBytes,
  busy,
  onSave,
}: {
  root: Root;
  fallbackBytes: number;
  busy: boolean;
  onSave: (root: Root, bytes: number | null) => void;
}) {
  const [draft, setDraft] = useState("");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const parsed = parseVideoLimitMiB(draft);
  const effective = effectiveVideoMaxFileBytes(root, fallbackBytes);
  const inputId = `root-video-limit-${root.id}`;
  const visibleError = submitError ?? (draft.trim() !== "" && !parsed.ok ? parsed.message : null);

  const submit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!parsed.ok) {
      setSubmitError(parsed.message);
      return;
    }
    setSubmitError(null);
    onSave(root, parsed.bytes);
  };

  return (
    <form onSubmit={submit} className="mt-1 space-y-1">
      <p className="text-xs text-muted">
        影片單檔上限：<span className="font-medium text-ink">{formatVideoLimitBytes(effective)}</span>
        {root.videoMaxFileBytes == null ? "（服務預設）" : ""}
      </p>
      <div className="flex flex-wrap items-center gap-1.5">
        <label htmlFor={inputId} className="text-xs text-muted">
          設為
        </label>
        <input
          id={inputId}
          type="number"
          min={VIDEO_LIMIT_MIN_MIB}
          max={VIDEO_LIMIT_MAX_MIB}
          step={1}
          inputMode="numeric"
          value={draft}
          placeholder={videoLimitMiBDefault(fallbackBytes)}
          disabled={busy}
          aria-label="影片單檔上限（MiB）"
          aria-invalid={visibleError !== null}
          onChange={(event) => {
            setDraft(event.target.value);
            setSubmitError(null);
          }}
          className="w-20 rounded-md border border-line bg-white px-2 py-0.5 text-xs text-ink outline-none focus:border-ink disabled:opacity-40"
        />
        <span className="text-xs text-muted">MiB</span>
        <button
          type="submit"
          disabled={busy || draft.trim() === ""}
          className="rounded-md border border-line px-2 py-0.5 text-xs text-ink disabled:opacity-40"
          title="只套用影片；不會自動重新索引既有的文字／圖片內容"
        >
          {busy ? "儲存中…" : "儲存"}
        </button>
        {root.videoMaxFileBytes !== undefined && (
          <button
            type="button"
            disabled={busy}
            onClick={() => onSave(root, null)}
            className="rounded-md border border-line px-2 py-0.5 text-xs text-muted disabled:opacity-40"
            title="清除這個資料夾的設定，回到服務預設上限"
          >
            恢復預設
          </button>
        )}
      </div>
      {visibleError !== null && (
        <p role="alert" className="text-xs text-red-600">
          {visibleError}
        </p>
      )}
    </form>
  );
}
