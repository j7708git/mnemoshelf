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
  /** 切換「寫出 agent 連線資訊檔」；關閉時 main process 會立即刪檔。 */
  onToggleAgentDiscovery: (enabled: boolean) => void;
  /** 「複製連線資訊」：由 main process 把 `{url, token}` 放進剪貼簿。 */
  onCopyConnectionInfo: () => void;
  /** 複製結果的提示（含 token 警語在固定文案裡）。 */
  connectionNotice: string | null;
  /** 「複製 MCP 設定片段」：由 main process 把可直接貼用的設定放進剪貼簿（不含 token）。 */
  onCopyMcpConfig: () => void;
  /** MCP 設定片段的複製結果提示。 */
  mcpConfigNotice: string | null;
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
  return "CoreML 曾造成行程結束，已永久停用";
}

/**
 * 執行裝置那一行的文字（沒有資料時明說「未測試」，不假裝有結果）。
 *
 * 只有 `auto` 才顯示「自動偵測」段：**手動指定**裝置時本來就不會跑自我測試，
 * 寫「未測試」會讓使用者以為有一場自動測試還沒跑完；Windows 的 DirectML 也是
 * 「每次直接試、失敗即退回」，沒有自我測試這回事。
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
  if (runtime.requestedDevice !== "auto") {
    // 明示模式（env／選項指定）：不存在「自動偵測的結果」，不要顯示「未測試」。
    parts.push("｜（裝置為手動指定）");
  } else if (runtime.selfTest !== undefined || runtime.device === "coreml") {
    parts.push(`｜自動偵測：${selfTestSummary(runtime.selfTest)}`);
  }
  // 崩潰的說明已經在自我測試那一句裡（「曾造成行程結束」），不必再重複一次。
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
  onToggleAgentDiscovery,
  onCopyConnectionInfo,
  connectionNotice,
  onCopyMcpConfig,
  mcpConfigNotice,
  onExportDiagnostics,
  onClose,
}: SettingsPanelProps) {
  const autostart = settings?.autostart ?? null;
  const token = settings?.token ?? null;
  const agentDiscovery = settings?.agentDiscovery ?? null;

  /** 連線資訊檔的狀態文字（不顯示 token）。 */
  const agentDiscoveryStatus = (discovery: NonNullable<DesktopSettingsState["agentDiscovery"]>): string => {
    if (!discovery.enabled) return discovery.present ? "設定已關閉，但檔案仍存在" : "已關閉（不會寫出連線資訊檔）";
    if (discovery.present) return "可用（同機程式可讀取）";
    if (!discovery.active) return "重新啟動 Mnemoshelf 後生效";
    return "尚未寫出";
  };

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
        <div className="space-y-2">
          <h3 className="text-sm font-medium text-ink">Agent 連線資訊</h3>
          <p className="text-xs text-muted">
            寫出一份 <code>runtime.json</code>，讓同一台機器的 agent（OpenCode／OpenChamber 外掛、MCP client）
            自動取得網址與 token，不必手動複製。檔案含 token（等於本機全權），僅供同使用者讀取。
          </p>
          {agentDiscovery === null ? (
            <p className="text-xs text-muted">讀取中…</p>
          ) : (
            <>
              <label className="flex items-center gap-2 text-sm text-ink">
                <input
                  id="mnemoshelf-agent-discovery"
                  type="checkbox"
                  checked={agentDiscovery.enabled}
                  disabled={busy}
                  onChange={(event) => onToggleAgentDiscovery(event.target.checked)}
                  className="h-4 w-4"
                />
                寫出連線資訊檔（關閉時立即刪除）
              </label>
              <p id="mnemoshelf-agent-discovery-status" className="text-xs text-muted">
                狀態：{agentDiscoveryStatus(agentDiscovery)}
                {agentDiscovery.file !== "" && `（${agentDiscovery.file}）`}
              </p>
              <div className="flex flex-wrap items-center gap-3">
                <button
                  id="mnemoshelf-agent-copy"
                  type="button"
                  onClick={onCopyConnectionInfo}
                  disabled={!agentDiscovery.present}
                  className="rounded-md border border-line px-3 py-1.5 text-sm text-ink disabled:opacity-40"
                >
                  複製連線資訊
                </button>
                {connectionNotice !== null && (
                  <span role="status" className="text-xs text-muted">
                    {connectionNotice}
                  </span>
                )}
              </div>
              <p className="text-xs text-muted">
                複製的內容是 <code>{'{"url","token"}'}</code>，<strong>包含 token</strong>：只貼給信任的程式，
                不要放進版本控制、共用的設定檔或聊天訊息。
              </p>
              <div className="flex flex-wrap items-center gap-3">
                <button
                  id="mnemoshelf-mcp-copy"
                  type="button"
                  onClick={onCopyMcpConfig}
                  disabled={!agentDiscovery.present}
                  className="rounded-md border border-line px-3 py-1.5 text-sm text-ink disabled:opacity-40"
                >
                  複製 MCP 設定片段
                </button>
                {mcpConfigNotice !== null && (
                  <span role="status" className="text-xs text-muted">
                    {mcpConfigNotice}
                  </span>
                )}
              </div>
              <p className="text-xs text-muted">
                給 MCP client（Claude Code、Codex 等）用的設定片段：貼進它的 MCP 設定檔、重啟它就能連上。
                片段以應用程式自己的執行檔啟動入口（不必另外安裝 Node.js），並預設專案名稱為
                <code>mnemoshelf</code>。這段<strong>不含 token</strong>——MCP 入口會自己讀上面那份連線資訊檔取得憑證，
                全權憑證不必經過剪貼簿。
              </p>
              {agentDiscovery.error !== null && (
                <p role="alert" className="text-sm text-red-600">
                  {agentDiscovery.error}
                </p>
              )}
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
