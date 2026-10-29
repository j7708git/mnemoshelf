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
  /** Agent 連線資訊（`runtime.json`）的設定與狀態；**不含 token**。 */
  agentDiscovery: {
    enabled: boolean;
    /** 這次執行的 server 是否已套用（變更要重新啟動才生效）。 */
    active: boolean;
    file: string;
    present: boolean;
    error: string | null;
  };
}

/**
 * 更新狀態機的階段（與 `packages/desktop/src/updater/state.ts` 一致）。
 *
 * web 沒辦法 import desktop 的型別；這裡是契約的鏡像，兩邊要一起改。
 */
export type UpdaterPhase =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "downloaded"
  | "installing"
  | "error";

/** 更新模式：`auto`＝App 內下載安裝；`manual`＝只檢查並開下載頁；`disabled`＝這次不啟用。 */
export type UpdaterMode = "auto" | "manual" | "disabled";

/** 下載進度（只含顯示需要的數字，不含路徑）。 */
export interface UpdaterProgress {
  /** 0–100。 */
  percent: number;
  transferred: number;
  /** 總位元組；未知時為 0。 */
  total: number;
  bytesPerSecond: number;
}

/** 穩定的錯誤代碼（與 desktop 的 `UpdaterErrorCode` 一致；顯示時保留代碼供回報）。 */
export type UpdaterErrorCode =
  | "offline"
  | "not-found"
  | "rate-limit"
  | "checksum"
  | "read-only"
  | "unsupported-appimage"
  | "unsupported-tarball"
  | "invalid-signature"
  | "invalid-version"
  | "check-failed"
  | "download-failed"
  | "install-failed"
  | "backup-failed"
  | "unexpected";

/** `error` 欄位的形狀。 */
export interface UpdaterErrorInfo {
  code: UpdaterErrorCode;
  message: string;
}

/** renderer 看到的更新狀態（IPC 契約；不含路徑或 token）。 */
export interface UpdaterState {
  state: UpdaterPhase;
  mode: UpdaterMode;
  currentVersion: string;
  /** 可更新版本（正規化、不含 `v`）；沒有時為 null。 */
  availableVersion: string | null;
  /** Release notes（純文字；UI 只以文字顯示，不解析 HTML）。 */
  releaseNotes: string | null;
  /** 公開的 Release 頁面（macOS 手動下載用）。 */
  releaseUrl: string | null;
  progress: UpdaterProgress | null;
  error: UpdaterErrorInfo | null;
  /** 使用者按過「稍後」的版本（本次執行；下次啟動會再詢問）。 */
  skippedVersion: string | null;
  /** 上次檢查完成時間（ISO 字串）。 */
  checkedAt: string | null;
  /** 給使用者看的非錯誤提示。 */
  notice: string | null;
}

/**
 * 「連接 Agent」偵測結果的三態（與 `packages/desktop/src/agent-guide.ts` 一致）。
 *
 * web 沒辦法 import desktop 的型別；這裡是契約的鏡像，兩邊要一起改。
 */
export type AgentGuideDetectState = "detected" | "not-detected" | "unknown";

/** 穩定的偵測原因碼（`unsupported` 目前不會由偵測回傳，保留給未來 harness）。 */
export type AgentGuideDetectReason =
  | "ok"
  | "file-missing"
  | "not-configured"
  | "read-error"
  | "too-large"
  | "invalid-format"
  | "unsupported";

/** 不允許複製的原因（穩定字串；UI 依此查文案）。 */
export type AgentGuideBlockedReason =
  | "runtime-missing"
  | "entry-missing"
  | "appimage"
  | "unknown-kind"
  | "clipboard-failed";

/** 可複製的內容種類（五種片段＋四張安裝指令卡）。 */
export type AgentGuideCopyKind =
  | "opencode-plugins"
  | "opencode-mcp"
  | "mcp-generic"
  | "codex-mcp"
  | "dsh-profile"
  | "install-card-opencode"
  | "install-card-codex"
  | "install-card-dsh"
  | "install-card-generic";

/** 單一 harness 的偵測結果（不含路徑、token 或設定內容）。 */
export interface DesktopAgentGuideHarnessDetection {
  state: AgentGuideDetectState;
  reason: AgentGuideDetectReason;
  /** 命中的識別字（已去重、排序）；顯示時以「、」連接。 */
  matches: string[];
  mcpConfigured: boolean;
  hookConfigured: boolean;
  /** 這次實際讀了幾個來源（含不存在與失敗的）。 */
  sourcesChecked: number;
}

/** 「連接 Agent」頁面的完整狀態；片段由 main 產生，renderer 只顯示。 */
export interface DesktopAgentGuideState {
  /** 這次偵測的時間（ISO 字串）。 */
  detectedAt: string;
  detection: {
    opencode: DesktopAgentGuideHarnessDetection;
    codex: DesktopAgentGuideHarnessDetection;
    dsh: DesktopAgentGuideHarnessDetection;
  };
  runtimeFile: string | null;
  entryPath: string | null;
  /** 已知不可複製的種類與原因（main 的複製閘門結果）。 */
  copy: { blocked: Partial<Record<AgentGuideCopyKind, AgentGuideBlockedReason>> };
  /** 每種可複製內容的預覽（不含 token）。 */
  previews: Record<AgentGuideCopyKind, string>;
}

/** `agentGuide.copy()` 的回應；不含片段內容。 */
export interface DesktopAgentGuideCopyResult {
  copied: boolean;
  reason: AgentGuideBlockedReason | null;
}

/**
 * 「連接 Agent」的窄介面（desktop shell API v3 新增）。
 *
 * 偵測與片段產生都在 main process：renderer 不讀檔案、不自己組片段，也不碰 token。
 */
export interface DesktopAgentGuideBridge {
  getState(): Promise<DesktopAgentGuideState>;
  /** `kind` 由 main 以白名單驗證；不認識的值回 `unknown-kind`。 */
  copy(kind: string): Promise<DesktopAgentGuideCopyResult>;
}

/**
 * 更新相關的窄介面（desktop shell API v2 新增）。
 *
 * `mode === "disabled"` 時所有操作都是 no-op；狀態只帶版本、進度、錯誤代碼與公開的
 * Release 頁面，不含路徑或 token。
 */
export interface DesktopUpdaterBridge {
  getState(): Promise<UpdaterState>;
  /** 手動檢查（略過「本次已按稍後」的抑制）。 */
  check(): Promise<UpdaterState>;
  download(): Promise<UpdaterState>;
  /**
   * 安裝已下載的更新（Linux／Windows）。
   *
   * `force: true` 表示使用者已確認「備份失敗仍要安裝」。
   */
  install(force?: boolean): Promise<UpdaterState>;
  /** 本次不安裝；下次啟動會再詢問。 */
  later(): Promise<UpdaterState>;
  /** 以系統瀏覽器開啟 Release 下載頁（macOS 的主要動作）。 */
  openReleasePage(): Promise<{ opened: boolean }>;
  /** 更新失敗後重新啟動 App 以恢復 Core 服務。 */
  restartApp(): Promise<void>;
  /** 訂閱狀態變化；回傳取消訂閱函式。 */
  onState(listener: (state: UpdaterState) => void): () => void;
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
    /** 設定是否寫出 `runtime.json`；關閉時立即刪除既有檔案。 */
    setAgentDiscovery(enabled: boolean): Promise<DesktopSettingsState>;
    /** 把 `{url, token}` 放進剪貼簿（使用者點擊才呼叫）；回傳不含 token。 */
    copyConnectionInfo(): Promise<{ copied: boolean; url: string | null }>;
    /**
     * 把可直接貼進 MCP client 的設定片段放進剪貼簿；片段**不含 token**。
     * 回傳不含 token，renderer 只拿到「是否成功」、網址與被擋的原因。
     */
    copyMcpConfig(): Promise<{ copied: boolean; url: string | null; reason: AgentGuideBlockedReason | null }>;
  };
  /**
   * 「連接 Agent」偵測與複製（v3 新增）。
   *
   * **選擇性**：v1／v2 的 preload 沒有這個成員，舊殼搭配新 UI 時要當成「不支援」，
   * 不可直接呼叫（`getDesktopAgentGuide()` 會處理）。
   */
  agentGuide?: DesktopAgentGuideBridge;
  /**
   * 更新（v2 新增；Linux／Windows 為 App 內下載安裝，macOS 只檢查並開下載頁）。
   *
   * **選擇性**：v1 的 preload 沒有這個成員，舊殼搭配新 UI 時要當成「不支援」，
   * 不可直接呼叫（`getDesktopUpdater()` 會處理）。
   */
  updater?: DesktopUpdaterBridge;
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

/**
 * 取得 updater 介面；不在桌面殼、或殼是 v1（沒有 updater）時回 null。
 *
 * v1→v2 相容：不能假設 `bridge.updater` 一定存在（舊的 preload 可能搭配新的 web build）。
 */
export function getDesktopUpdater(bridge: DesktopBridge | null = getDesktopBridge()): DesktopUpdaterBridge | null {
  if (bridge === null) return null;
  const updater = bridge.updater;
  if (updater === undefined || updater === null) return null;
  if (
    typeof updater.getState !== "function" ||
    typeof updater.check !== "function" ||
    typeof updater.download !== "function" ||
    typeof updater.install !== "function" ||
    typeof updater.later !== "function" ||
    typeof updater.openReleasePage !== "function" ||
    typeof updater.restartApp !== "function" ||
    typeof updater.onState !== "function"
  ) {
    return null;
  }
  return updater;
}

/**
 * 取得「連接 Agent」介面；不在桌面殼、或殼是 v1／v2（沒有 agentGuide）時回 null。
 *
 * 舊殼搭配新 UI 時不能假設 `bridge.agentGuide` 一定存在：頁面要照樣可看，
 * 只是偵測與複製顯示「需要桌面版 App」。
 */
export function getDesktopAgentGuide(
  bridge: DesktopBridge | null = getDesktopBridge(),
): DesktopAgentGuideBridge | null {
  if (bridge === null) return null;
  const agentGuide = bridge.agentGuide;
  if (agentGuide === undefined || agentGuide === null) return null;
  if (typeof agentGuide.getState !== "function" || typeof agentGuide.copy !== "function") return null;
  return agentGuide;
}
