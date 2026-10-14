/**
 * 設定畫面（桌面模式限定）：開機自啟開關 ＋ token 保存狀態 ＋ 版本資訊。
 *
 * 開機自啟在 Linux 走 XDG autostart 檔（`<XDG_CONFIG_HOME|~/.config>/autostart/mnemoshelf.desktop`），
 * macOS／Windows 交給系統的登入項目 API；實際動作都在 main process，UI 只切換開關。
 * 資料由 `App` 取得後傳進來（純顯示元件，方便重複使用與測試）。
 */
import type { DesktopSettingsState } from "./desktop";

export interface SettingsPanelProps {
  settings: DesktopSettingsState | null;
  error: string | null;
  busy: boolean;
  onToggleAutostart: (enabled: boolean) => void;
  onClose: () => void;
}

/** token 保存狀態的中文說明。 */
function tokenSummary(token: DesktopSettingsState["token"]): string {
  if (token.source === "env") return "由環境變數 MNEMOSHELF_TOKEN 提供（不落地）。";
  if (token.persisted) return "已用系統金鑰庫加密保存在應用程式資料目錄（token.bin）。";
  if (token.source === "session") return "只保留在本次執行（這個環境沒有可用的系統金鑰庫），不會寫到磁碟。";
  return "狀態不明。";
}

export function SettingsPanel({ settings, error, busy, onToggleAutostart, onClose }: SettingsPanelProps) {
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

      <div className="space-y-1">
        <h3 className="text-sm font-medium text-ink">存取 token</h3>
        <p className="text-xs text-muted">
          {token === null ? "讀取中…" : tokenSummary(token)}
          {token?.notice !== null && token?.notice !== undefined && ` ${token.notice}`}
        </p>
      </div>

      {settings !== null && (
        <div className="space-y-1">
          <h3 className="text-sm font-medium text-ink">版本</h3>
          <p className="text-xs text-muted">
            Mnemoshelf {settings.app.version}｜Electron {settings.app.electron}｜Chromium {settings.app.chrome}
            {settings.app.isPackaged ? "（打包版）" : "（開發模式）"}
          </p>
        </div>
      )}

      {error !== null && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
    </section>
  );
}
