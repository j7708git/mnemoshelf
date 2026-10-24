/**
 * 站內確認對話框：取代原生 confirm。
 *
 * 原生對話框的按鈕文字由作業系統語言決定（中文介面會出現英文 Cancel／OK），
 * 程式無法改寫，因此破壞性操作一律用這個元件自己畫。
 *
 * 刻意**不做 focus trap**（Tab 循環限制）：本元件只負責
 * - 開啟時把焦點放在「取消」（破壞性操作的安全預設）；
 * - `Esc` 或點遮罩＝取消，`busy` 時兩者都不生效；
 * - 關閉後把焦點還給原本觸發的按鈕（該按鈕若已從文件移除就留在原處）。
 *
 * 生命週期由呼叫端決定：按確定後對話框保持開啟、`busy=true`，成功才關閉；
 * 後端失敗時呼叫端關閉對話框，讓原本的錯誤橫幅看得見。
 */
import { useEffect, useId, useRef } from "react";

export interface ConfirmDialogProps {
  /** `false` 時不渲染任何 DOM（不留隱藏的遮罩）。 */
  open: boolean;
  title: string;
  /** 補充說明；換行會原樣保留（`\n\n` 分段）。 */
  description?: string;
  /** 確定鈕文字（例如「刪除」「繼續」「永久刪除」「移除」）。 */
  confirmLabel: string;
  /** 取消鈕文字；預設「取消」。 */
  cancelLabel?: string;
  /** `danger` 用紅色確定鈕（不可復原的操作）。 */
  variant?: "default" | "danger";
  /** `true`：兩顆按鈕都停用、確定鈕顯示「處理中…」，`Esc` 與遮罩點擊一併忽略。 */
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/** 取消鈕樣式（既有面板的次要按鈕風格）。 */
const CANCEL_CLASS = "rounded-md border border-line px-3 py-1.5 text-sm text-ink disabled:opacity-40";

/** 確定鈕樣式：一般與 danger 兩種，沿用面板既有的 ink／red 色票。 */
const CONFIRM_CLASS: Record<NonNullable<ConfirmDialogProps["variant"]>, string> = {
  default: "rounded-md bg-ink px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40",
  danger: "rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-40",
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
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  /**
   * 最新一次 render 的回呼與狀態給事件監聽器讀。
   *
   * 焦點與鍵盤的副作用只隨 `open` 掛載一次；若把 `onCancel`／`busy` 放進依賴陣列，
   * 每次 render 都會重掛監聽器並重設焦點，反而把使用者的焦點搶走。
   */
  const latest = useRef({ onCancel, busy });
  useEffect(() => {
    latest.current = { onCancel, busy };
  }, [onCancel, busy]);

  useEffect(() => {
    if (!open) return;
    // 觸發鈕：關閉後要還焦點回去（點擊會讓按鈕成為 activeElement）。
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancelRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || latest.current.busy) return;
      latest.current.onCancel();
    };
    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      // 觸發鈕可能已被移除（例如確認後卡片消失、清單重繪）：此時不硬搶焦點。
      if (trigger !== null && trigger.isConnected) trigger.focus();
    };
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30 px-4 py-6"
      onClick={() => {
        if (!busy) onCancel();
      }}
    >
      {/* 點對話框本體不觸發遮罩的取消。 */}
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(event) => event.stopPropagation()}
        className="w-full max-w-md rounded-lg border border-line bg-white px-5 py-4 text-ink shadow-lg"
      >
        <h2 id={titleId} className="text-base font-medium text-ink">
          {title}
        </h2>
        {description !== undefined && (
          <p className="mt-2 whitespace-pre-line break-words text-sm text-muted">{description}</p>
        )}
        <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
          <button ref={cancelRef} type="button" disabled={busy} onClick={onCancel} className={CANCEL_CLASS}>
            {cancelLabel}
          </button>
          <button type="button" disabled={busy} onClick={onConfirm} className={CONFIRM_CLASS[variant]}>
            {busy ? "處理中…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
