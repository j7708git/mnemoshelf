/**
 * 設定畫面：開機自啟開關 ＋ token 保存狀態 ＋ 版本資訊（桌面模式）＋ 執行裝置 ＋ 匯出診斷資訊。
 *
 * 開機自啟在 Linux 走 XDG autostart 檔（`<XDG_CONFIG_HOME|~/.config>/autostart/mnemoshelf.desktop`），
 * macOS／Windows 交給系統的登入項目 API；實際動作都在 main process，UI 只切換開關。
 * 桌面模式專屬的區塊（自啟／token／版本）只在 `settings !== null` 時顯示；
 * **執行裝置**與**匯出診斷資訊**對兩種模式都有意義，因此一律顯示。
 * 資料由 `App` 取得後傳進來（純顯示元件，方便重複使用與測試）。
 */
import type { DiagnosticsEmbedderRuntime, DiagnosticsEmbedderSelfTest } from "./api";
import type { DesktopSettingsState } from "./desktop";

export interface SettingsPanelProps {
  settings: DesktopSettingsState | null;
  error: string | null;
  busy: boolean;
  /**
   * embedder 的執行裝置狀態：`undefined`＝還在讀取、`null`＝服務未提供這個資訊。
   * 沒有這個成員的實作（純 CPU）也會回 `null`，畫面顯示「未提供」。
   */
  embedderRuntime: DiagnosticsEmbedderRuntime | null | undefined;
  /** 讀取執行裝置狀態失敗的訊息；沒有時為 null。 */
  embedderRuntimeError: string | null;
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

/** 裝置值的中文名稱（未知的值原樣顯示，不猜）。 */
const DEVICE_LABELS: Record<string, string> = {
  cpu: "CPU",
  dml: "DirectML（GPU）",
  coreml: "CoreML（Mac GPU）",
};

/** 加速器自我測試結果的中文說明；沒有資料＝「未測試」。 */
export function selfTestSummary(selfTest: DiagnosticsEmbedderSelfTest | undefined): string {
  if (selfTest === undefined) return "未測試";
  const numbers: string[] = [];
  if (typeof selfTest.throughputRatio === "number") {
    numbers.push(`吞吐 ${selfTest.throughputRatio.toFixed(2)}×`);
  }
  if (typeof selfTest.minCosine === "number") {
    numbers.push(`向量一致性 ${selfTest.minCosine.toFixed(5)}`);
  }
  const detail = numbers.length > 0 ? `（${numbers.join("、")}）` : "";
  if (selfTest.outcome === "usable") return `CoreML 已採用${detail}`;
  if (selfTest.outcome === "unusable") return `CoreML 不適用，已改用 CPU${detail}`;
  return "CoreML 曾於測試中結束行程，已永久停用";
}

/**
 * 執行裝置那一行的文字（沒有資料時明說「未測試」，不假裝有結果）。
 *
 * 只在使用者真的會遇到 CoreML 自我測試時才顯示「自動偵測」段：Windows 的 DirectML
 * 是「每次直接試、失敗即退回」，沒有自我測試這回事，寫「未測試」只會誤導。
 */
export function describeEmbedderRuntime(
  runtime: DiagnosticsEmbedderRuntime | null | undefined,
  error: string | null = null,
): string {
  if (error !== null && error !== "") return `讀取裝置資訊失敗：${error}`;
  if (runtime === undefined) return "讀取中…";
  if (runtime === null) return "本機服務未提供裝置資訊。";

  const parts = [`目前裝置：${DEVICE_LABELS[runtime.device] ?? runtime.device}`];
  if (!runtime.loaded) parts.push("（模型尚未載入，顯示的是計畫裝置）");
  if (runtime.selfTest !== undefined || runtime.device === "coreml" || runtime.requestedDevice === "coreml") {
    parts.push(`｜自動偵測：${selfTestSummary(runtime.selfTest)}`);
  }
  // 崩潰的說明已經在自我測試那一句裡（「曾於測試中結束行程」），不必再重複一次。
  if (runtime.fallbackReason !== null && runtime.selfTest?.outcome !== "crashed") {
    parts.push(`｜${runtime.fallbackReason.message}`);
  }
  return parts.join("");
}

export function SettingsPanel({
  settings,
  error,
  busy,
  embedderRuntime,
  embedderRuntimeError,
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

      <div className="space-y-1">
        <h3 className="text-sm font-medium text-ink">嵌入裝置</h3>
        <p id="mnemoshelf-embedder-device" className="text-xs text-muted">
          {describeEmbedderRuntime(embedderRuntime, embedderRuntimeError)}
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
