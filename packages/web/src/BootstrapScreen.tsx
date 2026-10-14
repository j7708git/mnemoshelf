/**
 * 首次啟動的模型下載畫面（桌面模式限定）。
 *
 * 為什麼要有這個畫面：模型是 lazy 載入的，第一次索引才會下載（約 300 MB）。
 * 桌面殼改成啟動時就先下載，這個畫面負責顯示進度、失敗原因與重試路徑。
 * 進度由 main process 透過 preload 推過來（見 `desktop.ts`）。
 */
import { formatBytes } from "./format";
import type { DesktopBootstrapState, DesktopTokenInfo } from "./desktop";

export interface BootstrapScreenProps {
  state: DesktopBootstrapState | null;
  /** token 的保存狀態（例如「沒有金鑰庫，token 只留在本次執行」）。 */
  token: DesktopTokenInfo | null;
  busy: boolean;
  onRetry: () => void;
  /** 先進入應用（索引時會再試一次下載）。 */
  onSkip: () => void;
}

/** 目前正在下載的檔案（顯示檔名的最後一段即可）。 */
function shortFile(file: string | null): string | null {
  if (file === null) return null;
  const parts = file.split(/[\\/]/).filter((part) => part !== "");
  return parts.length > 0 ? parts[parts.length - 1]! : file;
}

export function BootstrapScreen({ state, token, busy, onRetry, onSkip }: BootstrapScreenProps) {
  const phase = state?.phase ?? "checking";
  const progress = state?.progress ?? null;
  const total = progress?.total ?? 0;
  const loaded = progress?.loaded ?? 0;
  /**
   * 顯示用的百分比：下載階段一律壓在 99% 以下。
   *
   * 原因：進度是「目前已知的檔案」算出來的，套件在拿到模型檔案清單之前，分母只包含較小的
   * 設定／分詞檔，會短暫顯示 100%。真正 100% 只在驗證完成（`ready`）時顯示。
   */
  const percent = phase === "ready" ? 100 : Math.min(99, progress?.percent ?? 0);
  const failed = phase === "failed";
  const allKnownDone =
    phase === "downloading" && (progress?.filesKnown ?? 0) > 0 && progress?.filesDone === progress?.filesKnown;

  return (
    <div id="mnemoshelf-bootstrap" className="mx-auto flex w-full max-w-xl flex-1 flex-col justify-center gap-6 px-6 py-12">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold text-ink">Mnemoshelf</h1>
        <p className="text-sm text-muted">
          {failed ? "模型下載失敗。" : "首次啟動需要準備本機模型（約 300 MB），完成後即可離線使用。"}
        </p>
      </div>

      <div className="space-y-2 rounded-lg border border-line bg-white p-4">
        <p className="text-sm text-ink">
          {phase === "checking" && "正在確認模型是否已下載…"}
          {phase === "downloading" && (state?.message ?? "正在下載模型…")}
          {phase === "verifying" && "模型下載完成，正在驗證可用性…"}
          {failed && (state?.lastError === null || state?.lastError === undefined ? "模型下載失敗。" : `${state.lastError.name}：${state.lastError.message}`)}
        </p>

        <div
          className="h-2 w-full overflow-hidden rounded-full bg-line"
          role="progressbar"
          aria-label="模型下載進度"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          aria-valuetext={`${percent}%`}
        >
          <div className="h-full bg-ink transition-[width]" style={{ width: `${percent}%` }} />
        </div>

        <p
          id="mnemoshelf-bootstrap-progress"
          data-loaded={String(loaded)}
          data-total={String(total)}
          data-percent={String(percent)}
          className="text-xs text-muted"
        >
          {total > 0
            ? `已下載 ${formatBytes(loaded)}／${formatBytes(total)}（${percent}%）：${progress?.filesDone ?? 0}／${progress?.filesKnown ?? 0} 個檔案`
            : "正在取得檔案清單…"}
          {shortFile(progress?.currentFile ?? null) !== null && `　目前：${shortFile(progress?.currentFile ?? null)}`}
          {allKnownDone && "　（正在確認是否還有其他檔案）"}
        </p>

        {state !== null && state.attempt > 1 && (
          <p className="text-xs text-muted">
            第 {state.attempt}／{state.maxAttempts} 次嘗試
            {state.failures.length > 0 && `（前一次：${state.failures[state.failures.length - 1]?.error.message ?? ""}）`}
          </p>
        )}

        {state !== null && state.reusedBytes > 0 && (
          <p className="text-xs text-muted">已沿用先前下載完成的 {formatBytes(state.reusedBytes)}，重試只會抓缺少的部分。</p>
        )}
      </div>

      {token !== null && token.notice !== null && (
        <p className="rounded-md border border-line bg-surface px-3 py-2 text-xs text-muted">{token.notice}</p>
      )}

      {failed && (
        <div className="space-y-3">
          {state?.hint !== null && state?.hint !== undefined && <p className="text-xs text-muted">{state.hint}</p>}
          <div className="flex flex-wrap gap-2">
            <button
              id="mnemoshelf-bootstrap-retry"
              type="button"
              onClick={onRetry}
              disabled={busy}
              className="rounded-md bg-ink px-3 py-2 text-sm font-medium text-white disabled:opacity-40"
            >
              {busy ? "重試中…" : "重試下載"}
            </button>
            <button
              id="mnemoshelf-bootstrap-skip"
              type="button"
              onClick={onSkip}
              className="rounded-md border border-line px-3 py-2 text-sm text-ink"
            >
              先進入應用（索引時再試）
            </button>
          </div>
        </div>
      )}

      <p className="text-xs text-muted">
        模型檔案放在應用程式的資料目錄（userData）底下；下載完成的檔案會保留，中斷後重試不會重新下載。
      </p>
    </div>
  );
}
