/**
 * main process 與 renderer 之間的窄介面（desktop shell API v2）。
 *
 * 這裡只放「契約」：通道名稱與狀態型別。實作有兩份，必須一致：
 * - main 端：`src/main.ts` 的 `ipcMain.handle`；
 * - renderer 端：`src/preload.cts`（打包成 `dist/preload.cjs`）以 `contextBridge` 暴露；
 * - 使用端：`packages/web/src/desktop.ts`（同一個形狀，web 沒辦法 import 本檔）。
 *
 * 安全邊界：renderer 只拿得到**狀態**，拿不到 token 本身（token 只留在 main，
 * 由 `webRequest` 注入標頭）。這裡刻意沒有任何「取得 token」的方法。
 */
import type { BootstrapState } from "./model-bootstrap.js";
import type { TokenInfo } from "./token-store.js";
import type { AutostartState } from "./autostart.js";
import type { UpdaterState } from "./updater/state.js";

/** IPC 通道名稱。 */
export const DESKTOP_CHANNELS = {
  bootstrapGet: "mnemoshelf:bootstrap:get",
  bootstrapRetry: "mnemoshelf:bootstrap:retry",
  bootstrapUpdate: "mnemoshelf:bootstrap:update",
  settingsGet: "mnemoshelf:settings:get",
  settingsSetAutostart: "mnemoshelf:settings:set-autostart",
  settingsSetAgentDiscovery: "mnemoshelf:settings:set-agent-discovery",
  settingsCopyConnectionInfo: "mnemoshelf:settings:copy-connection-info",
  settingsCopyMcpConfig: "mnemoshelf:settings:copy-mcp-config",
  updaterGetState: "mnemoshelf:updater:get-state",
  updaterCheck: "mnemoshelf:updater:check",
  updaterDownload: "mnemoshelf:updater:download",
  updaterInstall: "mnemoshelf:updater:install",
  updaterLater: "mnemoshelf:updater:later",
  updaterOpenReleasePage: "mnemoshelf:updater:open-release-page",
  updaterRestartApp: "mnemoshelf:updater:restart-app",
  updaterState: "mnemoshelf:updater:state",
} as const;

/** `contextBridge` 掛在 renderer 上的全域名稱，以及 API 版本。 */
export const DESKTOP_BRIDGE_NAME = "mnemoshelfDesktop";
/** v2：新增 updater 的狀態與操作（U2）。 */
export const DESKTOP_API_VERSION = 2;

/** 應用與環境資訊（顯示用）。 */
export interface DesktopAppInfo {
  name: string;
  version: string;
  electron: string;
  chrome: string;
  node: string;
  platform: string;
  /** 是否以 `--headless` 啟動（沒有視窗）。 */
  headless: boolean;
  isPackaged: boolean;
}

/**
 * Agent 連線資訊（`runtime.json`）的設定與狀態。
 *
 * **不含 token**：token 只在 main process；「複製連線資訊」由 main 直接寫剪貼簿。
 */
export interface DesktopAgentDiscoveryState {
  /** 使用者設定（持久化在 `agentSettings.json`）。 */
  enabled: boolean;
  /** 這次執行的 server 是否已套用（變更開關要重新啟動才會生效）。 */
  active: boolean;
  /** 連線資訊檔的路徑（`<userData>/data/runtime.json`）。 */
  file: string;
  /** 檔案目前是否存在（外部程式現在是否讀得到）。 */
  present: boolean;
  /** 寫檔失敗或刪檔失敗的說明；沒有時為 null。 */
  error: string | null;
}

/** `settings.get()` 的回應。 */
export interface DesktopSettingsState {
  app: DesktopAppInfo;
  /** token 的保存狀態（**不含 token**）。 */
  token: TokenInfo;
  autostart: AutostartState;
  agentDiscovery: DesktopAgentDiscoveryState;
}

/** renderer 看到的 desktop API（`window.mnemoshelfDesktop`）。 */
export interface DesktopBridge {
  kind: "mnemoshelf-desktop";
  apiVersion: number;
  platform: string;
  bootstrap: {
    /**
     * 目前的模型下載狀態；**可能為 null**（`--headless` 沒有下載流程、或啟動流程尚未建好
     * `ModelBootstrap` 時）。main 端的實作就是 `bootstrap?.getState() ?? null`，web 端的
     * 鏡像（`packages/web/src/desktop.ts`）也早已宣告 `| null`；這裡以實際行為為準對齊。
     */
    getState(): Promise<BootstrapState | null>;
    /** 重新檢查並（必要時）重試下載；回傳最新狀態（同上，可能為 null）。 */
    retry(): Promise<BootstrapState | null>;
    /** 訂閱狀態變化；回傳取消訂閱函式。 */
    onUpdate(listener: (state: BootstrapState) => void): () => void;
  };
  settings: {
    get(): Promise<DesktopSettingsState>;
    setAutostart(enabled: boolean): Promise<DesktopSettingsState>;
    /** 設定是否寫出 `runtime.json`；關閉時立即刪除既有檔案。 */
    setAgentDiscovery(enabled: boolean): Promise<DesktopSettingsState>;
    /**
     * 把 `{url, token}` 放進剪貼簿（由使用者主動點擊）。
     *
     * token 只在 main process；回傳不含 token，renderer 只拿到「是否成功」與網址。
     */
    copyConnectionInfo(): Promise<{ copied: boolean; url: string | null }>;
    /**
     * 把可直接貼進 MCP client 的設定片段放進剪貼簿。
     *
     * 片段**不含 token**：MCP 入口會自己讀 `runtime.json` 取得網址與 token。
     * 回傳不含 token，renderer 只拿到「是否成功」與網址。
     */
    copyMcpConfig(): Promise<{ copied: boolean; url: string | null }>;
  };
  /**
   * 更新（Linux／Windows 為 App 內下載安裝；macOS 只檢查並開啟下載頁）。
   *
   * `mode === "disabled"` 時所有操作都是 no-op（開發模式／headless）。
   * 狀態只帶版本、進度、錯誤代碼與公開的 Release 頁面，不含路徑或 token。
   */
  updater: {
    getState(): Promise<UpdaterState>;
    /** 手動檢查（略過「本次已按稍後」的抑制）。 */
    check(): Promise<UpdaterState>;
    download(): Promise<UpdaterState>;
    /**
     * 安裝已下載的更新（Linux／Windows）。
     *
     * `force: true` 表示使用者已確認「備份失敗仍要安裝」；main 會依此略過備份失敗的中止。
     * macOS 沒有 App 內安裝，請用 `openReleasePage()`。
     */
    install(force?: boolean): Promise<UpdaterState>;
    /** 本次不安裝；下次啟動會再詢問。 */
    later(): Promise<UpdaterState>;
    /** 以系統瀏覽器開啟 Release 下載頁（macOS B 案的主要動作）。 */
    openReleasePage(): Promise<{ opened: boolean }>;
    /** 更新失敗後重新啟動 App 以恢復 Core 服務（main process 直接 relaunch）。 */
    restartApp(): Promise<void>;
    /** 訂閱狀態變化；回傳取消訂閱函式。 */
    onState(listener: (state: UpdaterState) => void): () => void;
  };
}
