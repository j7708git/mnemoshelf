/**
 * 更新狀態機與 IPC 回傳的狀態形狀（main → renderer）。
 *
 * 階段（計畫 §M8）：
 *
 * ```
 * idle → checking → (available | idle | error)
 * available → downloading → downloaded → installing
 * available → idle（稍後）
 * error → idle（重試／清除）
 * error → installing（僅 backup-failed ＋使用者 force 續裝）
 * ```
 *
 * 這個檔案刻意不碰 electron、不碰檔案系統：狀態轉移是純資料，讓測試可以直接餵
 * fake updater 的事件驗證，不需要真的啟動 Electron。
 */
import type { UpdaterErrorInfo } from "./errors.js";

/** 平台的更新模式：`auto`＝App 內下載／安裝；`manual`＝只檢查版本並開下載頁；`disabled`＝這次不啟用。 */
export type UpdaterMode = "auto" | "manual" | "disabled";

/** 狀態機的階段。 */
export type UpdaterPhase =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "downloaded"
  | "installing"
  | "error";

/** 下載進度（只放顯示需要的數字；不含路徑）。 */
export interface UpdaterProgress {
  /** 0–100。 */
  percent: number;
  /** 已下載位元組。 */
  transferred: number;
  /** 總位元組；未知時為 0。 */
  total: number;
  /** 目前速度（bytes/sec）；未知時為 0。 */
  bytesPerSecond: number;
}

/**
 * renderer／IPC 看到的更新狀態。
 *
 * 安全邊界：`error` 只帶穩定代碼與可讀訊息，**不含**路徑、token、URL 查詢參數；
 * `releaseUrl` 是公開的 GitHub Release 頁面（UI 要開的那一個）。
 */
export interface UpdaterState {
  state: UpdaterPhase;
  mode: UpdaterMode;
  currentVersion: string;
  /** 可更新版本（正規化、不含 `v`）；沒有時為 null。 */
  availableVersion: string | null;
  /** Release notes（純文字；electron-updater 或 GitHub API 提供）。 */
  releaseNotes: string | null;
  /** Release 頁面（macOS B 案的必要輸出；其他平台也可用）。 */
  releaseUrl: string | null;
  progress: UpdaterProgress | null;
  error: UpdaterErrorInfo | null;
  /** 使用者按過「稍後」的版本（本次執行；下次啟動會再詢問）。 */
  skippedVersion: string | null;
  /** 上次檢查完成時間（ISO 字串；顯示用）。 */
  checkedAt: string | null;
  /** 給使用者看的非錯誤提示（例如 AppImage 改名後自啟項目無法更新）。 */
  notice: string | null;
}

/** 建立初始狀態。 */
export function createInitialUpdaterState(input: { currentVersion: string; mode: UpdaterMode }): UpdaterState {
  return {
    state: "idle",
    mode: input.mode,
    currentVersion: input.currentVersion,
    availableVersion: null,
    releaseNotes: null,
    releaseUrl: null,
    progress: null,
    error: null,
    skippedVersion: null,
    checkedAt: null,
    notice: null,
  };
}

/**
 * 允許的狀態轉移。
 *
 * 同一階段轉同一階段是刻意允許的（事件可能重複送達，例如 checking 事件與手動檢查
 * 同時發生）；其他未列出的轉移一律忽略並記 log，不讓 updater 的事件把狀態機弄壞。
 */
const TRANSITIONS: Record<UpdaterPhase, readonly UpdaterPhase[]> = {
  idle: ["idle", "checking", "available", "error"],
  checking: ["checking", "idle", "available", "error"],
  available: ["available", "checking", "downloading", "idle", "error"],
  downloading: ["downloading", "downloaded", "error"],
  downloaded: ["downloaded", "installing", "error"],
  installing: ["installing", "error"],
  // `error → installing` 只給「備份失敗後使用者確認仍要安裝」的 force 重試；
  // 一般 install() 會先檢查狀態，不會走這條路。
  error: ["error", "idle", "checking", "installing"],
};

/** 從 `from` 是否可以走到 `to`。 */
export function canTransition(from: UpdaterPhase, to: UpdaterPhase): boolean {
  return TRANSITIONS[from].includes(to);
}

/**
 * 系統匣提示文字（若 tray 結構允許就更新 tooltip）。
 *
 * 不回傳路徑或版本以外的敏感資訊；沒有更新時就是應用名稱。
 */
export function updaterTrayTooltip(state: UpdaterState): string {
  switch (state.state) {
    case "checking":
      return "Mnemoshelf — 正在檢查更新";
    case "available":
      return state.availableVersion === null
        ? "Mnemoshelf — 有新版本"
        : `Mnemoshelf — 有新版本 v${state.availableVersion}`;
    case "downloading": {
      const percent = state.progress === null ? null : Math.round(state.progress.percent);
      return percent === null ? "Mnemoshelf — 正在下載更新" : `Mnemoshelf — 正在下載更新（${percent}%）`;
    }
    case "downloaded":
      return "Mnemoshelf — 更新已下載，可安裝";
    case "installing":
      return "Mnemoshelf — 正在安裝更新";
    case "error":
      return "Mnemoshelf — 更新檢查失敗";
    case "idle":
      return "Mnemoshelf";
  }
}
