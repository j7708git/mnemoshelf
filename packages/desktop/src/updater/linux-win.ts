/**
 * Linux／Windows 的更新後端：包住 electron-updater 的 `autoUpdater`。
 *
 * 兩個硬性旗標（計畫拍板，U0 研究 §Q2）：
 * - `autoDownload = false`：檢查只回報有新版本，下載由使用者按「下載」觸發。
 * - `autoInstallOnAppQuit = false`：下載完成後**不會**在關閉 App 時靜默安裝；
 *   electron-updater 6.8.11 的預設是 true，必須明確關掉。
 *
 * `electron-updater` 只用 dynamic import 載入（`loadElectronUpdater`），因此：
 * - macOS 分支永遠不會載入這個套件（`index.ts` 只會在 linux／win32 呼叫）；
 * - 測試可以用 fake updater 取代，不需要真的啟動 Electron。
 */
import path from "node:path";
import { updaterError, type UpdaterErrorInfo } from "./errors.js";
import type { UpdaterProgress } from "./state.js";

/**
 * 我們實際用到的 electron-updater 介面（刻意不用套件的型別）。
 *
 * 這樣測試的 fake 只要實作這幾個成員，也避免把 electron-updater 的型別拉進
 * `index.ts` 的編譯單元（型別 import 雖然會被抹除，但少一層相依更清楚）。
 */
export interface ElectronUpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  /**
   * electron-updater 的 logger；設 null 會換成 NoOpLogger。
   *
   * 預設是 `console`，錯誤時會把完整 stack（含快取路徑、下載 URL）印出來；
   * 本專案統一由自己的 log／狀態處理，不讓它把路徑或 token 寫進輸出。
   */
  logger?: unknown;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

/** 更新資訊（electron-updater 的 UpdateInfo 只取需要的欄位）。 */
export interface AutoUpdateInfo {
  version: string;
  releaseNotes: string | null;
}

/** 事件轉接器：把 electron-updater 的事件翻成 controller 的狀態更新。 */
export interface AutoUpdaterHooks {
  onChecking(): void;
  onAvailable(info: AutoUpdateInfo): void;
  onNotAvailable(): void;
  onProgress(progress: UpdaterProgress): void;
  onDownloaded(info: AutoUpdateInfo): void;
  onError(error: unknown): void;
  onAppImageRenamed(newPath: string): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 版本比較只吃正規化後的字串；這裡保留原樣，交給 controller 驗證。 */
function readVersion(value: unknown): string {
  if (typeof value === "string") return value;
  if (isRecord(value) && typeof value.version === "string") return value.version;
  return "";
}

function normalizeReleaseNotes(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" ? null : trimmed;
  }
  if (Array.isArray(value)) {
    const notes = value
      .map((item) => (isRecord(item) && typeof item.note === "string" ? item.note : ""))
      .filter((note) => note.trim() !== "");
    return notes.length === 0 ? null : notes.join("\n\n");
  }
  return null;
}

function readInfo(value: unknown): AutoUpdateInfo {
  const record = isRecord(value) ? value : {};
  return {
    version: readVersion(value),
    releaseNotes: normalizeReleaseNotes(record.releaseNotes),
  };
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function readProgress(value: unknown): UpdaterProgress {
  const record = isRecord(value) ? value : {};
  const percent = Math.min(100, Math.max(0, asNumber(record.percent)));
  return {
    percent,
    transferred: Math.max(0, asNumber(record.transferred)),
    total: Math.max(0, asNumber(record.total)),
    bytesPerSecond: Math.max(0, asNumber(record.bytesPerSecond)),
  };
}

/**
 * 接上 electron-updater 的事件，並設定兩個必要旗標。
 *
 * 必須在第一次 `checkForUpdates()` 之前呼叫（旗標要在下載完成、quit handler
 * 掛上之前就生效）。
 */
export function wireAutoUpdater(updater: ElectronUpdaterLike, hooks: AutoUpdaterHooks): void {
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  // 預設 logger 是 console，錯誤時會印出含路徑／URL 的 stack；狀態與 log 由我們自己控管。
  updater.logger = null;

  updater.on("checking-for-update", () => hooks.onChecking());
  updater.on("update-available", (info) => hooks.onAvailable(readInfo(info)));
  updater.on("update-not-available", () => hooks.onNotAvailable());
  updater.on("download-progress", (progress) => hooks.onProgress(readProgress(progress)));
  updater.on("update-downloaded", (info) => hooks.onDownloaded(readInfo(info)));
  updater.on("error", (error) => hooks.onError(error));
  // 只有 Linux AppImage 會發出；Windows 不會。安裝時由 electron-updater 同步發出。
  updater.on("appimage-filename-updated", (newPath) => {
    if (typeof newPath === "string") hooks.onAppImageRenamed(newPath);
  });
}

/**
 * 以 dynamic import 載入 electron-updater 的 singleton `autoUpdater`。
 *
 * 這是整個 desktop 套件唯一載入 electron-updater 的地方；`index.ts` 只會在
 * Linux／Windows 呼叫它。CJS 套件在 ESM 下的 named export 可能只出現在
 * `default`，因此兩種形狀都接受。
 */
export async function loadElectronUpdater(): Promise<ElectronUpdaterLike> {
  const loaded: unknown = await import("electron-updater");
  if (isRecord(loaded) && isRecord(loaded.autoUpdater)) {
    return loaded.autoUpdater as unknown as ElectronUpdaterLike;
  }
  if (isRecord(loaded) && isRecord(loaded.default) && isRecord(loaded.default.autoUpdater)) {
    return loaded.default.autoUpdater as unknown as ElectronUpdaterLike;
  }
  throw new Error("electron-updater 沒有匯出 autoUpdater");
}

/** Linux 安裝形式的檢查結果。 */
export type LinuxFormCheck = { supported: true } | { supported: false; error: UpdaterErrorInfo };

export interface LinuxFormInput {
  env: NodeJS.ProcessEnv;
  argv: readonly string[];
  execPath: string;
}

/** tar.gz 解壓後的目錄名（electron-builder artifactName 含版本與平台）。 */
const TARBALL_DIRECTORY_PATTERN = /^mnemoshelf-\d+\.\d+\.\d+-(?:linux|win|mac)/i;

/**
 * 判斷 Linux 這個執行形式是否支援 App 內更新（純函式）。
 *
 * - `APPIMAGE` 由 AppImage runtime 設定；沒有它，electron-updater 的
 *   `AppImageUpdater.isUpdaterActive()` 會直接停用（U0 §Q3）。
 * - `--appimage-extract-and-run`／`APPIMAGE_EXTRACT_AND_RUN`：沒有 FUSE 的機器會
 *   解壓到暫存目錄執行；替換 AppImage 後重啟的新行程會走一般模式，行為沒有保證。
 *   政策上視為不支援自動更新（U0 §Q3）。
 * - tar.gz／手動解壓目錄：以目錄名（`Mnemoshelf-<版本>-linux-<arch>`）辨識；
 *   electron-builder 的 tar.gz 就是這個形狀。使用者若自行改名，會落到
 *   `unsupported-appimage`（同樣的「此安裝形式不支援」）。
 */
export function detectLinuxUpdatableForm(input: LinuxFormInput): LinuxFormCheck {
  const appImage = input.env.APPIMAGE;
  const hasAppImage = appImage !== undefined && appImage.trim() !== "";

  const extractAndRunFlag = input.env.APPIMAGE_EXTRACT_AND_RUN;
  const extractAndRun =
    input.argv.includes("--appimage-extract-and-run") ||
    (extractAndRunFlag !== undefined && extractAndRunFlag.trim() !== "" && extractAndRunFlag.trim() !== "0");
  if (extractAndRun) return { supported: false, error: updaterError("unsupported-appimage") };

  if (hasAppImage) return { supported: true };

  const directory = path.basename(path.dirname(input.execPath));
  if (TARBALL_DIRECTORY_PATTERN.test(directory)) {
    return { supported: false, error: updaterError("unsupported-tarball") };
  }
  return { supported: false, error: updaterError("unsupported-appimage") };
}
