/**
 * 桌面模式（Electron 殼）的偵測與型別。
 *
 * 判準：preload（`packages/desktop/src/preload.cts`）會在有桌面殼時掛上
 * `window.mnemoshelfDesktop`；在瀏覽器（直接開本機服務的網址）時不存在，
 * UI 就回到「手動貼 token」的流程。因此同一個 build 同時支援兩種使用方式。
 *
 * 契約與 `packages/desktop/src/desktop-api.ts` 一致（web 沒辦法 import desktop 的型別，
 * 兩邊都要改）。這裡只宣告**狀態**：token 不會經過 renderer。
 */
import { useEffect, useState } from "react";

/** 模型下載的階段（與 desktop 的 `BootstrapState.phase` 相同）。 */
export type BootstrapPhase = "idle" | "checking" | "downloading" | "verifying" | "ready" | "failed";

/** 模型下載狀態（桌面殼自己聚合，renderer 只讀）。 */
export interface DesktopBootstrapState {
  phase: BootstrapPhase;
  modelId: string;
  modelDir: string;
  attempt: number;
  maxAttempts: number;
  progress: {
    loaded: number;
    total: number;
    percent: number;
    currentFile: string | null;
    downloadedBytes: number;
    reusedBytes: number;
    filesDone: number;
    filesKnown: number;
  };
  reusedBytes: number;
  lastError: { name: string; message: string } | null;
  failures: { attempt: number; error: { name: string; message: string } }[];
  missingFiles: string[];
  removedTempFiles: string[];
  message: string;
  hint: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

/** token 的保存狀態（**不含 token 本身**）。 */
export interface DesktopTokenInfo {
  source: "env" | "stored" | "generated" | "session";
  persisted: boolean;
  encryptionAvailable: boolean;
  location: string;
  notice: string | null;
}

export interface DesktopSettingsState {
  app: {
    name: string;
    version: string;
    electron: string;
    chrome: string;
    node: string;
    platform: string;
    headless: boolean;
    isPackaged: boolean;
  };
  token: DesktopTokenInfo;
  autostart: {
    enabled: boolean;
    supported: boolean;
    location: string | null;
    detail: string;
  };
}

/** preload 暴露的窄介面。 */
export interface DesktopBridge {
  kind: "mnemoshelf-desktop";
  apiVersion: number;
  platform: string;
  bootstrap: {
    getState(): Promise<DesktopBootstrapState | null>;
    retry(): Promise<DesktopBootstrapState | null>;
    onUpdate(listener: (state: DesktopBootstrapState) => void): () => void;
  };
  settings: {
    get(): Promise<DesktopSettingsState>;
    setAutostart(enabled: boolean): Promise<DesktopSettingsState>;
  };
}

declare global {
  interface Window {
    mnemoshelfDesktop?: DesktopBridge;
  }
}

/** 目前是否在桌面殼裡（瀏覽器開啟時為 false）。 */
export function isDesktopMode(): boolean {
  return getDesktopBridge() !== null;
}

/** 取得 desktop bridge；不在桌面殼裡時回 null。 */
export function getDesktopBridge(): DesktopBridge | null {
  if (typeof window === "undefined") return null;
  const bridge = window.mnemoshelfDesktop;
  if (bridge === undefined || bridge.kind !== "mnemoshelf-desktop") return null;
  return bridge;
}

/** React 版的 bridge 取用（物件在 preload 載入時就固定，所以只讀一次）。 */
export function useDesktopBridge(): DesktopBridge | null {
  const [bridge, setBridge] = useState<DesktopBridge | null>(() => getDesktopBridge());
  useEffect(() => {
    // preload 一定比頁面腳本先跑；這裡只是保險（例如熱重載）。
    if (bridge === null) setBridge(getDesktopBridge());
  }, [bridge]);
  return bridge;
}
