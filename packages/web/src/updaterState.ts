/**
 * 更新狀態的純邏輯：事件去重、進度節流判斷、顯示文字。
 *
 * 為什麼要另外一層：U2 的狀態機允許同一階段轉同一階段（事件可能重複送達，例如
 * 手動檢查與 electron-updater 的 `checking-for-update` 各送一次），renderer 若照單全收
 * 會重複播報、閃爍或讓版面跳動。這裡用「同一份狀態就不更新」把重複事件吃掉；
 * 進度事件另外由 `UpdaterPanel` 以 ≥100ms 節流。
 *
 * 這個檔案不 import React、不碰 DOM，方便用 node 直接驗證。
 */
import type {
  UpdaterErrorCode,
  UpdaterErrorInfo,
  UpdaterProgress,
  UpdaterState,
} from "./desktop";

/** 兩個錯誤資訊是否相同（代碼與訊息都一樣才算重複）。 */
export function sameUpdaterError(a: UpdaterErrorInfo | null, b: UpdaterErrorInfo | null): boolean {
  if (a === null || b === null) return a === b;
  return a.code === b.code && a.message === b.message;
}

/** 兩份進度是否相同（整數位元組與百分比；浮點誤差不影響顯示就不重繪）。 */
export function sameUpdaterProgress(a: UpdaterProgress | null, b: UpdaterProgress | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.percent === b.percent &&
    a.transferred === b.transferred &&
    a.total === b.total &&
    a.bytesPerSecond === b.bytesPerSecond
  );
}

/**
 * 兩份狀態是否「對 UI 而言完全相同」。
 *
 * `undefined` 代表還沒有任何狀態（第一次收到事件時一定要套用）。
 */
export function sameUpdaterState(a: UpdaterState | null | undefined, b: UpdaterState): boolean {
  if (a === null || a === undefined) return false;
  return (
    a.state === b.state &&
    a.mode === b.mode &&
    a.currentVersion === b.currentVersion &&
    a.availableVersion === b.availableVersion &&
    a.releaseNotes === b.releaseNotes &&
    a.releaseUrl === b.releaseUrl &&
    a.skippedVersion === b.skippedVersion &&
    a.checkedAt === b.checkedAt &&
    a.notice === b.notice &&
    sameUpdaterError(a.error, b.error) &&
    sameUpdaterProgress(a.progress, b.progress)
  );
}

/**
 * 把新事件併進目前狀態：重複事件回傳**同一個參考**，讓 React 直接跳過重繪。
 *
 * 這也讓螢幕閱讀器不會把同一句「正在檢查…」或同一則錯誤播報兩次。
 */
export function mergeUpdaterState(current: UpdaterState | null | undefined, next: UpdaterState): UpdaterState {
  return sameUpdaterState(current, next) && current !== null && current !== undefined ? current : next;
}

/** 百分比夾在 0–100，並四捨五入成整數（顯示與 aria-valuenow 用）。 */
export function progressPercent(progress: UpdaterProgress | null): number {
  if (progress === null || !Number.isFinite(progress.percent)) return 0;
  return Math.min(100, Math.max(0, Math.round(progress.percent)));
}

/** 位元組數轉成人看的單位（1024 進位；0／未知顯示 0 B）。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"] as const;
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  const digits = index === 0 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[index]}`;
}

/** 下載進度的可讀摘要（百分比＋已下載／總大小；總大小未知時明說）。 */
export function progressSummary(progress: UpdaterProgress | null): string {
  if (progress === null) return "";
  const percent = progressPercent(progress);
  const transferred = formatBytes(progress.transferred);
  if (progress.total <= 0) return `${percent}%｜已下載 ${transferred}（總大小未知）`;
  return `${percent}%｜${transferred}／${formatBytes(progress.total)}`;
}

/**
 * 錯誤代碼 → 使用者可讀的繁中訊息。
 *
 * 刻意不直接採用 IPC 傳來的 `message` 當唯一來源：萬一主行程的訊息退化成英文或
 * 變成堆疊字串，UI 仍以穩定代碼顯示正確分類。未知代碼才退回 `fallback`。
 */
const ERROR_TEXT: Record<UpdaterErrorCode, string> = {
  offline: "目前沒有網路，請確認連線後再試。",
  "not-found": "找不到更新資訊，請稍後再試。",
  "rate-limit": "查詢太頻繁（GitHub 流量上限），請稍後再試。",
  checksum: "下載檔驗證失敗，已保留目前版本；請重試。",
  "read-only": "安裝位置不可寫入，請改用可寫的位置或手動下載更新。",
  "unsupported-appimage": "此 AppImage 形式不支援自動更新（例如以 extract-and-run 執行）。",
  "unsupported-tarball": "此安裝形式（tar.gz／解壓目錄）不支援自動更新，請下載新版本手動替換。",
  "invalid-signature": "更新檔簽章驗證失敗，已停止安裝。請改用手動下載。",
  "invalid-version": "更新資訊的版本格式不正確，請稍後再試。",
  "check-failed": "檢查更新失敗，請稍後再試。",
  "download-failed": "下載更新失敗，請稍後再試。",
  "install-failed": "安裝更新失敗，請重新啟動應用程式後再試。",
  "backup-failed": "更新前備份失敗，已取消安裝。你可以重試，或改用手動下載更新。",
  busy: "更新正在進行中，請稍候。",
  unexpected: "更新時發生未預期的錯誤，請稍後再試。",
};

/** 由代碼取得顯示訊息；未知代碼沿用 IPC 的訊息（若也沒有才用通用句）。 */
export function updaterErrorMessage(code: string, fallback: string | null = null): string {
  if (Object.prototype.hasOwnProperty.call(ERROR_TEXT, code)) {
    return ERROR_TEXT[code as UpdaterErrorCode];
  }
  if (fallback !== null && fallback.trim() !== "") return fallback;
  return "更新時發生錯誤，請稍後再試。";
}

/** 這個錯誤是否代表「目前的安裝形式不支援自動更新」（需要手動下載的說明）。 */
export function isUnsupportedInstallForm(code: string): boolean {
  return code === "unsupported-appimage" || code === "unsupported-tarball" || code === "read-only";
}

/** 錯誤是否與簽章／檔案完整性有關（安裝被擋下，不應說成「已是最新」）。 */
export function isVerificationError(code: string): boolean {
  return code === "checksum" || code === "invalid-signature";
}
