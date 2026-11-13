/**
 * 確認對話框（原生 `<dialog>` + `showModal()`）。
 *
 * 依照 modern-web-guidance：不手動加 `role="dialog"`、`aria-modal` 或焦點陷阱，
 * 由原生 Top Layer、`showModal()` 與 `Esc` cancel 事件接管，並搭配 `overscroll-behavior: contain`。
 */
import { useEffect, useId, useRef, type SyntheticEvent } from "react";

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  cancelLabel?: string;
  variant?: "default" | "danger";
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

const CONFIRM_CLASS: Record<NonNullable<ConfirmDialogProps["variant"]>, string> = {
  default: "rounded-[10px] bg-brand px-3.5 py-2 text-sm font-semibold text-on-brand disabled:opacity-40",
  danger: "rounded-[10px] bg-danger px-3.5 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-40",
};

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel = "取消",
  variant = "default",
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDialogElement | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    if (open) {
      if (!dialog.open) {
        dialog.returnValue = "";
        dialog.showModal();
      }
      return;
    }
    if (dialog.open) {
      dialog.close();
    }
  }, [open]);

  if (!open) return null;

  const handleNativeCancel = (event: SyntheticEvent<HTMLDialogElement>): void => {
    event.preventDefault();
    if (!busy) onCancel();
  };

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onCancel={handleNativeCancel}
      className="mnemo-dialog mnemo-dialog-compact w-full"
    >
      <div className="space-y-4 p-5">
        <div className="space-y-2">
          <h3 id={titleId} className="font-serif text-base font-bold text-ink">
            {title}
          </h3>
          <p id={descriptionId} className="whitespace-pre-line break-all text-sm text-muted">
            {description}
          </p>
        </div>

        <div className="flex justify-end gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={onCancel}
            className="rounded-[10px] border border-line bg-surface px-3.5 py-2 text-sm font-medium text-ink hover:bg-raised disabled:opacity-40"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onConfirm}
            className={CONFIRM_CLASS[variant]}
          >
            {busy ? "處理中…" : confirmLabel}
          </button>
        </div>
      </div>
    </dialog>
  );
}
