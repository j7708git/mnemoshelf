/**
 * main process 與 renderer 之間的窄介面（desktop shell API v1）。
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

/** IPC 通道名稱。 */
export const DESKTOP_CHANNELS = {
  bootstrapGet: "mnemoshelf:bootstrap:get",
  bootstrapRetry: "mnemoshelf:bootstrap:retry",
  bootstrapUpdate: "mnemoshelf:bootstrap:update",
  settingsGet: "mnemoshelf:settings:get",
  settingsSetAutostart: "mnemoshelf:settings:set-autostart",
} as const;

/** `contextBridge` 掛在 renderer 上的全域名稱，以及 API 版本。 */
export const DESKTOP_BRIDGE_NAME = "mnemoshelfDesktop";
export const DESKTOP_API_VERSION = 1;

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

/** `settings.get()` 的回應。 */
export interface DesktopSettingsState {
  app: DesktopAppInfo;
  /** token 的保存狀態（**不含 token**）。 */
  token: TokenInfo;
  autostart: AutostartState;
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
  };
}
