/**
 * 設定畫面：開機自啟開關 ＋ token 保存狀態 ＋ 版本資訊（桌面模式）＋ 匯出診斷資訊。
 *
 * 開機自啟在 Linux 走 XDG autostart 檔（`<XDG_CONFIG_HOME|~/.config>/autostart/mnemoshelf.desktop`），
 * macOS／Windows 交給系統的登入項目 API；實際動作都在 main process，UI 只切換開關。
 * 桌面模式專屬的區塊（自啟／token／版本）只在 `settings !== null` 時顯示；
 * **匯出診斷資訊**對兩種模式都有意義，因此一律顯示。
 * 資料由 `App` 取得後傳進來（純顯示元件，方便重複使用與測試）。
 */
import type { DesktopSettingsState } from "./desktop";

export interface SettingsPanelProps {
  settings: DesktopSettingsState | null;
  error: string | null;
  busy: boolean;
  /** 匯出診斷資訊是否進行中。 */
  diagnosticsBusy: boolean;
  /** 匯出成功訊息（含檔名）；沒有時為 null。 */
  diagnosticsNotice: string | null;
  /** 匯出失敗訊息；沒有時為 null。 */
  diagnosticsError: string | null;
  onToggleAutostart: (enabled: boolean) => void;
  onExportDiagnostics: () => void;
  onClose: () => void;
}

/** token 保存狀態的中文說明。 */
function tokenSummary(token: DesktopSettingsState["token"]): string {
  if (token.source === "env") return "由環境變數 MNEMOSHELF_TOKEN 提供（不落地）。";
  if (token.persisted) return "已用系統金鑰庫加密保存在應用程式資料目錄（token.bin）。";
  if (token.source === "session") return "只保留在本次執行（這個環境沒有可用的系統金鑰庫），不會寫到磁碟。";
  return "狀態不明。";
}

export function SettingsPanel({
  settings,
  error,
  busy,
  diagnosticsBusy,
  diagnosticsNotice,
  diagnosticsError,
  onToggleAutostart,
  onExportDiagnostics,
  onClose,
}: SettingsPanelProps) {
  const autostart = settings?.autostart ?? null;
  const token = settings?.token ?? null;

  return (
    <section id="mnemoshelf-settings" aria-label="設定" className="space-y-4 rounded-lg border border-line bg-white p-5">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-base font-medium text-ink">設定</h2>
        <button type="button" onClick={onClose} className="text-sm text-muted underline">
          關閉
        </button>
      </div>

      {settings !== null && (
        <div className="space-y-2">
          <h3 className="text-sm font-medium text-ink">開機自啟</h3>
          {autostart === null ? (
            <p className="text-xs text-muted">讀取中…</p>
          ) : (
            <>
              <label className="flex items-center gap-2 text-sm text-ink">
                <input
                  id="mnemoshelf-autostart"
                  type="checkbox"
                  checked={autostart.enabled}
                  disabled={busy || !autostart.supported}
                  onChange={(event) => onToggleAutostart(event.target.checked)}
                  className="h-4 w-4"
                />
                登入時自動啟動 Mnemoshelf（縮到系統匣）
              </label>
              <p id="mnemoshelf-autostart-detail" className="text-xs text-muted">
                {autostart.detail}
                {autostart.location !== null && `（${autostart.location}）`}
              </p>
            </>
          )}
        </div>
      )}

      {settings !== null && (
        <div className="space-y-1">
          <h3 className="text-sm font-medium text-ink">存取 token</h3>
          <p className="text-xs text-muted">
            {token === null ? "讀取中…" : tokenSummary(token)}
            {token?.notice !== null && token?.notice !== undefined && ` ${token.notice}`}
          </p>
        </div>
      )}

      {settings !== null && (
        <div className="space-y-1">
          <h3 className="text-sm font-medium text-ink">版本</h3>
          <p className="text-xs text-muted">
            Mnemoshelf {settings.app.version}｜Electron {settings.app.electron}｜Chromium {settings.app.chrome}
            {settings.app.isPackaged ? "（打包版）" : "（開發模式）"}
          </p>
        </div>
      )}

      <div className="space-y-2">
        <h3 className="text-sm font-medium text-ink">匯出診斷資訊</h3>
        <p className="text-xs text-muted">
          產出一份 JSON（版本、平台、embedder、各資料夾的統計與最近一次索引結果），
          供回報問題時附上。不含檔案內容、token 或個人檔案清單；家目錄路徑會以 <code>~</code> 遮罩。
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={onExportDiagnostics}
            disabled={diagnosticsBusy}
            className="rounded-md bg-ink px-3 py-2 text-sm font-medium text-white disabled:opacity-40"
          >
            {diagnosticsBusy ? "匯出中…" : "匯出診斷資訊"}
          </button>
          {diagnosticsNotice !== null && (
            <span role="status" className="text-xs text-muted">
              {diagnosticsNotice}
            </span>
          )}
        </div>
        {diagnosticsError !== null && (
          <p role="alert" className="text-sm text-red-600">
            {diagnosticsError}
          </p>
        )}
      </div>

      {error !== null && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
    </section>
  );
}
