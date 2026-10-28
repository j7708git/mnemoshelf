/**
 * 更新錯誤分類：把 electron-updater、Electron `net`、Node fs 的原始錯誤收斂成
 * **穩定代碼 ＋ 可讀訊息**。
 *
 * 為什麼不直接轉發原始錯誤：原始訊息可能含下載 URL（含查詢參數）、快取路徑或
 * 使用者目錄。IPC 狀態會進 renderer，依計畫只帶代碼與固定訊息。
 *
 * 代碼清單是 IPC 契約的一部分（U3 會用代碼決定顯示文案），不要隨意改名。
 */

/** 穩定的錯誤代碼（IPC 契約）。 */
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
  | "busy"
  | "unexpected";

/** `error` 欄位的形狀。 */
export interface UpdaterErrorInfo {
  code: UpdaterErrorCode;
  message: string;
}

/** 每個代碼的預設訊息（繁體中文；不含任何路徑或 URL）。 */
const MESSAGES: Record<UpdaterErrorCode, string> = {
  offline: "網路不可用，請確認連線後再試。",
  "not-found": "找不到更新資訊；這個版本可能尚未發布。",
  "rate-limit": "GitHub 更新查詢已達流量上限，請稍後再試。",
  checksum: "更新檔驗證失敗（內容不完整），請重新下載。",
  "read-only": "更新檔所在的位置無法寫入；請改用手動下載更新。",
  "unsupported-appimage": "此安裝形式不支援自動更新。",
  "unsupported-tarball": "此安裝形式（tar.gz／解壓目錄）不支援自動更新；請下載新版本手動替換。",
  "invalid-signature": "更新檔簽章驗證失敗，已停止安裝。",
  "invalid-version": "更新資訊的版本格式不正確。",
  "check-failed": "檢查更新失敗，請稍後再試。",
  "download-failed": "下載更新失敗，請稍後再試。",
  "install-failed": "安裝更新失敗，請重新啟動應用程式後再試。",
  "backup-failed": "更新前備份失敗，已取消安裝。",
  busy: "更新正在進行中，請稍候。",
  unexpected: "更新時發生未預期的錯誤。",
};

/** 建立正規化後的錯誤資訊；`message` 可覆寫預設文案（仍不得含敏感資訊）。 */
export function updaterError(code: UpdaterErrorCode, message?: string): UpdaterErrorInfo {
  return { code, message: message ?? MESSAGES[code] };
}

/** 由本模組主動拋出的錯誤（保留穩定代碼，不讓分類器改變它）。 */
export class UpdaterFault extends Error {
  readonly info: UpdaterErrorInfo;

  constructor(code: UpdaterErrorCode, message?: string) {
    const info = updaterError(code, message);
    super(info.message);
    this.name = "UpdaterFault";
    this.info = info;
  }
}

/** 把任意錯誤轉成 `UpdaterErrorInfo`；`UpdaterFault` 原樣保留。 */
export function toUpdaterErrorInfo(error: unknown, fallback: UpdaterErrorCode = "unexpected"): UpdaterErrorInfo {
  if (error instanceof UpdaterFault) return error.info;
  return classifyUpdaterError(error, fallback);
}

/** 由錯誤物件取出 `code`（Electron net／Node fs／builder-util-runtime 都有這個欄位）。 */
function readErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

/** 離線類的錯誤代碼（Electron `net` 與 Node 網路錯誤）。 */
const OFFLINE_CODES = new Set([
  "ERR_INTERNET_DISCONNECTED",
  "ERR_NAME_NOT_RESOLVED",
  "ERR_CONNECTION_REFUSED",
  "ERR_CONNECTION_RESET",
  "ERR_CONNECTION_TIMED_OUT",
  "ERR_CONNECTION_CLOSED",
  "ERR_NETWORK_CHANGED",
  "ERR_ADDRESS_UNREACHABLE",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENETUNREACH",
  "ENETDOWN",
]);

const READ_ONLY_CODES = new Set(["EROFS", "EACCES", "EPERM"]);

/**
 * 分類 electron-updater／網路／檔案系統的錯誤。
 *
 * `fallback` 由呼叫端給（檢查／下載／安裝各有不同），確保未知錯誤也有穩定代碼。
 */
export function classifyUpdaterError(error: unknown, fallback: UpdaterErrorCode = "unexpected"): UpdaterErrorInfo {
  const code = readErrorCode(error);
  if (code !== null) {
    if (OFFLINE_CODES.has(code)) return updaterError("offline");
    if (READ_ONLY_CODES.has(code)) return updaterError("read-only");
    if (code === "ERR_CHECKSUM_MISMATCH") return updaterError("checksum");
    if (code === "ERR_UPDATER_INVALID_SIGNATURE") return updaterError("invalid-signature");
    if (code === "ERR_UPDATER_INVALID_VERSION") return updaterError("invalid-version");
    if (
      code === "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND" ||
      code === "ERR_UPDATER_LATEST_VERSION_NOT_FOUND" ||
      code === "ERR_UPDATER_NO_PUBLISHED_VERSIONS" ||
      code === "ERR_UPDATER_NO_FILES_PROVIDED" ||
      code === "ERR_UPDATER_OLD_FILE_NOT_FOUND"
    ) {
      return updaterError("not-found");
    }
  }

  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";

  // 先比對 electron-updater 的專屬字串，再比對一般的網路字樣（避免把 404 誤判成離線）。
  if (/ERR_CHECKSUM_MISMATCH|checksum mismatch/i.test(message)) return updaterError("checksum");
  if (/ERR_UPDATER_INVALID_SIGNATURE|code signature/i.test(message)) return updaterError("invalid-signature");
  if (/ERR_UPDATER_INVALID_VERSION/i.test(message)) return updaterError("invalid-version");
  if (
    /ERR_UPDATER_CHANNEL_FILE_NOT_FOUND|ERR_UPDATER_LATEST_VERSION_NOT_FOUND|ERR_UPDATER_NO_PUBLISHED_VERSIONS|ERR_UPDATER_NO_FILES_PROVIDED/i.test(
      message,
    )
  ) {
    return updaterError("not-found");
  }
  if (
    /ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET|ERR_CONNECTION_TIMED_OUT|ERR_NETWORK_CHANGED|fetch failed|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH/i.test(
      message,
    )
  ) {
    return updaterError("offline");
  }
  if (/read-only file system|EROFS|EACCES|EPERM|permission denied/i.test(message)) {
    return updaterError("read-only");
  }

  return updaterError(fallback);
}

/**
 * GitHub API 的 HTTP 狀態分類。
 *
 * - 403／429：rate limit（未認證 60/hr；GitHub 也可能用 403 表達）。
 * - 404：release 不存在。
 * - 其他 4xx／5xx：檢查失敗。
 * - 2xx／3xx：null（交給回應內容判斷）。
 */
export function classifyHttpStatus(status: number): UpdaterErrorInfo | null {
  if (status === 403 || status === 429) return updaterError("rate-limit");
  if (status === 404) return updaterError("not-found");
  if (status >= 400) return updaterError("check-failed");
  return null;
}
