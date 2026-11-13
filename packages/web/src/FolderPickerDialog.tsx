/**
 * 瀏覽器版資料夾選擇對話框（原生 `<dialog>` + `showModal()`）。
 *
 * 設計契約：
 * - 遵循 modern-web-guidance：不使用 `role="dialog"`／`aria-modal`／手動焦點鎖，
 *   交由瀏覽器原生的 Top Layer、`showModal()`、`Esc` 關閉與 `overscroll-behavior: contain` 處理。
 * - 只在 `open` 變為 `true` 或使用者點擊麵包屑／側欄／子資料夾時呼叫 `GET /fs/browse`，
 *   不做背景預載，也不在客戶端記錄瀏覽過的路徑。
 * - 只列出子資料夾名稱，不讀寫檔案內容。
 */
import { useCallback, useEffect, useId, useRef, useState, type SyntheticEvent } from "react";
import { AccessPolicyRiskBanner } from "./AccessPolicyRiskBanner";
import { browseDirectories, type BrowseAccessPolicy, type BrowseDirectoriesResponse } from "./api";

export interface FolderPickerDialogProps {
  open: boolean;
  /** 可選的初始瀏覽路徑；留空則由伺服器依目前範圍決定起點。 */
  initialPath?: string;
  /** 若已知伺服器策略，可先行傳入並在尚未收到列表前就提醒。 */
  knownPolicy?: BrowseAccessPolicy | null;
  onSelect: (chosenPath: string) => void;
  onClose: () => void;
}

type LoadState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; data: BrowseDirectoriesResponse }
  | { kind: "error"; message: string };

export function FolderPickerDialog({
  open,
  initialPath,
  knownPolicy,
  onSelect,
  onClose,
}: FolderPickerDialogProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const requestSeqRef = useRef(0);

  const [load, setLoad] = useState<LoadState>({ kind: "idle" });
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  const loadDirectory = useCallback(async (targetPath?: string): Promise<void> => {
    const seq = ++requestSeqRef.current;
    setLoad({ kind: "loading" });
    try {
      const data = await browseDirectories(targetPath);
      if (seq !== requestSeqRef.current) return;
      setLoad({ kind: "ready", data });
      setSelectedPath(data.currentPath);
    } catch (error) {
      if (seq !== requestSeqRef.current) return;
      setLoad({
        kind: "error",
        message: error instanceof Error ? error.message : "無法列出資料夾",
      });
    }
  }, []);

  // 同步原生 <dialog> 的開啟與關閉；只在 open === true 時向伺服器請求列表。
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;

    if (open) {
      if (!dialog.open) {
        dialog.returnValue = "";
        dialog.showModal();
      }
      const trimmed = initialPath?.trim();
      void loadDirectory(trimmed !== undefined && trimmed !== "" ? trimmed : undefined);
      return;
    }

    requestSeqRef.current += 1;
    if (dialog.open) {
      dialog.close();
    }
    setLoad({ kind: "idle" });
    setSelectedPath(null);
  }, [open, initialPath, loadDirectory]);

  const handleNativeCancel = (event: SyntheticEvent<HTMLDialogElement>): void => {
    // 交由 React controlled state 統一呼叫 close()，避免雙重狀態不同步。
    event.preventDefault();
    onClose();
  };

  const activeData = load.kind === "ready" ? load.data : null;
  const activePolicy = activeData?.policy ?? knownPolicy ?? null;
  const effectiveSelection = selectedPath ?? activeData?.currentPath ?? null;

  const confirmSelection = (): void => {
    if (effectiveSelection === null) return;
    onSelect(effectiveSelection);
  };

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      onCancel={handleNativeCancel}
      className="mnemo-dialog w-full"
    >
      <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
        <h3 id={titleId} className="font-serif text-base font-bold text-ink">
          選擇資料夾
        </h3>
        <button
          type="button"
          onClick={onClose}
          aria-label="關閉"
          className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-line bg-surface text-sm text-muted hover:bg-raised hover:text-ink"
        >
          ✕
        </button>
      </div>

      {activePolicy?.relaxed === true && (
        <div className="border-b border-line px-5 py-2.5">
          <AccessPolicyRiskBanner policy={activePolicy} compact />
        </div>
      )}

      {activeData !== null && (
        <nav
          aria-label="資料夾路徑"
          className="flex flex-wrap items-center gap-1 border-b border-line bg-raised/45 px-5 py-2 text-xs"
        >
          {activeData.breadcrumbs.map((crumb, index) => (
            <span key={crumb.path} className="inline-flex items-center gap-1">
              {index > 0 && <span className="text-muted">/</span>}
              <button
                type="button"
                onClick={() => void loadDirectory(crumb.path)}
                className={`rounded-md px-1.5 py-0.5 font-mono transition ${
                  index === activeData.breadcrumbs.length - 1
                    ? "bg-tint font-semibold text-brand"
                    : "text-muted hover:bg-surface hover:text-ink"
                }`}
              >
                {crumb.label}
              </button>
            </span>
          ))}
        </nav>
      )}

      <div className="grid min-h-[280px] flex-1 grid-cols-1 overflow-hidden sm:grid-cols-[176px_1fr]">
        <aside className="overflow-y-auto border-b border-line bg-bg/50 p-3 sm:border-b-0 sm:border-r">
          <div className="px-1.5 pb-1.5 text-[11px] font-bold tracking-wider text-muted uppercase">
            快速位置
          </div>
          {activeData === null ? (
            <p className="px-1.5 py-1 text-xs text-muted">載入中…</p>
          ) : activeData.quickLocations.length === 0 ? (
            <p className="px-1.5 py-1 text-xs text-muted">沒有可用的快速位置</p>
          ) : (
            <ul className="space-y-1">
              {activeData.quickLocations.map((loc) => {
                const isCurrent = activeData.currentPath === loc.path;
                return (
                  <li key={loc.id}>
                    <button
                      type="button"
                      onClick={() => void loadDirectory(loc.path)}
                      className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] transition ${
                        isCurrent
                          ? "bg-tint font-semibold text-brand"
                          : "text-ink hover:bg-raised"
                      }`}
                    >
                      <span aria-hidden="true">📁</span>
                      <span className="truncate">{loc.label}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </aside>

        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-3">
          {load.kind === "loading" && (
            <div className="flex flex-1 items-center justify-center py-8 text-sm text-muted">
              正在讀取子資料夾名稱…
            </div>
          )}

          {load.kind === "error" && (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
              <p role="alert" className="text-sm text-danger">
                {load.message}
              </p>
              <button
                type="button"
                onClick={() => void loadDirectory(undefined)}
                className="rounded-[10px] border border-line bg-surface px-3 py-1.5 text-xs font-medium text-ink hover:bg-raised"
              >
                回到預設起點目錄
              </button>
            </div>
          )}

          {load.kind === "ready" && (
            <div className="space-y-1">
              {load.data.parentPath !== null && (
                <button
                  type="button"
                  onClick={() => void loadDirectory(load.data.parentPath!)}
                  className="flex w-full items-center gap-2 rounded-[10px] px-3 py-2 text-left text-[13px] text-muted hover:bg-raised hover:text-ink"
                >
                  <span aria-hidden="true">⬆</span>
                  <span>上一層資料夾</span>
                </button>
              )}

              {load.data.directories.length === 0 ? (
                <p className="px-3 py-6 text-center text-xs text-muted">
                  此資料夾底下沒有可選的子資料夾；你可以直接點下方「選擇此資料夾」。
                </p>
              ) : (
                load.data.directories.map((dir) => {
                  const isSelected = selectedPath === dir.path;
                  return (
                    <div
                      key={dir.path}
                      className={`flex items-center justify-between gap-2 rounded-[10px] border px-3 py-1.5 transition ${
                        isSelected
                          ? "border-brand bg-tint/70"
                          : "border-transparent hover:bg-raised/70"
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => setSelectedPath(dir.path)}
                        onDoubleClick={() => void loadDirectory(dir.path)}
                        aria-pressed={isSelected}
                        className="flex min-w-0 flex-1 items-center gap-2.5 py-0.5 text-left text-[13px] text-ink"
                      >
                        <span aria-hidden="true">📁</span>
                        <span className="truncate font-medium">{dir.name}</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => void loadDirectory(dir.path)}
                        className="shrink-0 rounded-md border border-line bg-surface px-2 py-0.5 text-[11px] font-medium text-muted hover:border-brand hover:text-brand"
                      >
                        進入
                      </button>
                    </div>
                  );
                })
              )}
            </div>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line bg-bg/45 px-5 py-3.5">
        <div className="min-w-0 flex-1 text-xs text-muted">
          <span>已選：</span>
          <code className="break-all font-mono text-ink">
            {effectiveSelection ?? "尚未載入"}
          </code>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-[10px] border border-line bg-surface px-3.5 py-2 text-xs font-medium text-ink hover:bg-raised"
          >
            取消
          </button>
          <button
            type="button"
            disabled={effectiveSelection === null || load.kind === "loading"}
            onClick={confirmSelection}
            className="rounded-[10px] bg-brand px-4 py-2 text-xs font-semibold text-on-brand disabled:opacity-40"
          >
            選擇此資料夾
          </button>
        </div>
      </div>
    </dialog>
  );
}
