/**
 * 更新能力的入口：依平台建立 controller（`createUpdater`）。
 *
 * 平台分流：
 * - **Linux／Windows**：electron-updater（`linux-win.ts`，dynamic import）→ 檢查、下載、
 *   安裝都在 App 內完成。
 * - **macOS**：不打 electron-updater；用 GitHub API 比版本，只回版本與下載頁
 *   （`mac.ts`）；安裝＝使用者自己下載 dmg。
 * - **`!app.isPackaged`／`--headless`／其他平台**：不初始化（`mode: "disabled"`）。
 *
 * 這個檔案也不 import electron：`net.fetch`、`shell.openExternal`、`app.exit` 等
 * 都由 `main.ts` 注入，讓狀態機與安裝流程可以在 vitest 裡用 fake 驗證。
 */
import { createNoopBackup, type BackupPort, type BackupResult } from "./backup.js";
import { toUpdaterErrorInfo, UpdaterFault, updaterError, type UpdaterErrorCode, type UpdaterErrorInfo } from "./errors.js";
import { checkMacRelease, isAllowedReleaseUrl, releasePageUrl, type FetchLike } from "./mac.js";
import {
  detectLinuxUpdatableForm,
  loadElectronUpdater,
  wireAutoUpdater,
  type AutoUpdateInfo,
  type AutoUpdaterHooks,
  type ElectronUpdaterLike,
} from "./linux-win.js";
import { compareVersions, normalizeVersion } from "./semver.js";
import { canTransition, createInitialUpdaterState, type UpdaterMode, type UpdaterState } from "./state.js";

/** 延遲檢查的預設值（啟動後 30 秒）。 */
const DEFAULT_INITIAL_CHECK_DELAY_MS = 30_000;

/** 自動檢查的間隔（6 小時）。 */
const DEFAULT_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1_000;

/** 安裝後若行程仍存活（表示 `quitAndInstall()` 沒有真的結束），多久回到錯誤狀態。 */
const DEFAULT_INSTALL_WATCHDOG_MS = 30_000;

/** 更新 feed 的預設 repo（與 `electron-builder.yml` 的 publish 設定一致，公開資訊）。 */
const DEFAULT_GITHUB = { owner: "j7708git", repo: "mnemoshelf" };

/** 「稍後」的版本存放介面；main 接 `agent-settings.ts`，測試用記憶體實作。 */
export interface SkippedVersionStore {
  load(): Promise<string | null>;
  save(version: string | null): Promise<void>;
}

/** 記憶體版的 skipped version（預設；測試與未接設定檔時使用）。 */
export function createMemorySkippedVersionStore(initial: string | null = null): SkippedVersionStore {
  let value = initial;
  return {
    load: async () => value,
    save: async (version) => {
      value = version;
    },
  };
}

export interface CreateUpdaterOptions {
  platform: NodeJS.Platform;
  currentVersion: string;
  isPackaged: boolean;
  headless: boolean;
  /** 命令列（預設 `process.argv`）：用於偵測 `--appimage-extract-and-run`。 */
  argv?: readonly string[];
  /** 環境變數（預設 `process.env`）：用於偵測 `APPIMAGE`。 */
  env?: NodeJS.ProcessEnv;
  /** 目前執行檔路徑（預設 `process.execPath`）：用於辨識 tar.gz 解壓目錄。 */
  execPath?: string;
  github?: { owner: string; repo: string };
  /** 只關 server、不結束行程（main 的 `closeServerOnly()`）。 */
  closeServerOnly: () => Promise<void>;
  /** 更新前備份（預設 no-op；main 會注入真正的檔案備份）。 */
  backup?: BackupPort;
  /** 安裝前設定 `quitting = true`（避免 `before-quit` 再跑一次）。 */
  onQuitting?: () => void;
  /** 安裝流程中止時把 `quitting` 還原。 */
  onQuitAborted?: () => void;
  /** 每次狀態變化（main 轉送到 renderer 與系統匣）。 */
  onStateChange?: (state: UpdaterState) => void;
  /** AppImage 改名（electron-updater 事件）；回傳給使用者看的提示或 null。 */
  onAppImageRenamed?: (newPath: string) => string | null;
  /** 「稍後」的版本存放；預設只在記憶體（本次執行）。 */
  skippedVersionStore?: SkippedVersionStore;
  /** 測試注入：預設 dynamic import electron-updater。 */
  loadAutoUpdater?: () => Promise<ElectronUpdaterLike>;
  /** macOS 的 GitHub API fetch（main 傳 `net.fetch` 包裝）。 */
  fetchImpl?: FetchLike;
  /** macOS 開啟下載頁（main 傳 `shell.openExternal`）。 */
  openExternal?: (url: string) => Promise<void>;
  initialCheckDelayMs?: number;
  checkIntervalMs?: number;
  installWatchdogMs?: number;
  log?: (message: string) => void;
}

export interface UpdaterController {
  readonly mode: UpdaterMode;
  getState(): UpdaterState;
  /** 啟動：載入後端、還原「稍後」版本、排定延遲與週期檢查。 */
  start(): Promise<void>;
  /** 停止計時器（測試／結束用）。 */
  stop(): void;
  check(input?: { manual?: boolean }): Promise<UpdaterState>;
  download(): Promise<UpdaterState>;
  install(input?: { force?: boolean }): Promise<UpdaterState>;
  later(): Promise<UpdaterState>;
  openReleasePage(): Promise<{ opened: boolean }>;
}

/** 這個環境是否應該啟用 updater（打包後、非 headless、三平台之一）。 */
export function shouldEnableUpdater(input: {
  platform: NodeJS.Platform;
  isPackaged: boolean;
  headless: boolean;
}): boolean {
  if (!input.isPackaged || input.headless) return false;
  return input.platform === "linux" || input.platform === "win32" || input.platform === "darwin";
}

function nowIso(): string {
  return new Date().toISOString();
}

/** 建立 updater；不符合啟用條件時回傳 disabled controller（所有操作都是 no-op）。 */
export function createUpdater(options: CreateUpdaterOptions): UpdaterController {
  if (!shouldEnableUpdater(options)) return createDisabledUpdater(options.currentVersion);
  return new Updater(options);
}

function createDisabledUpdater(currentVersion: string): UpdaterController {
  const state = createInitialUpdaterState({ currentVersion, mode: "disabled" });
  const getState = (): UpdaterState => ({ ...state });
  return {
    mode: "disabled",
    getState,
    start: async () => undefined,
    stop: () => undefined,
    check: async () => getState(),
    download: async () => getState(),
    install: async () => getState(),
    later: async () => getState(),
    openReleasePage: async () => ({ opened: false }),
  };
}

class Updater implements UpdaterController {
  readonly mode: UpdaterMode;

  private readonly options: CreateUpdaterOptions;
  private readonly github: { owner: string; repo: string };
  private readonly log: (message: string) => void;
  private readonly preflightError: UpdaterErrorInfo | null;

  private state: UpdaterState;
  private autoUpdater: ElectronUpdaterLike | null = null;
  private skippedVersion: string | null = null;
  private manualCheck = false;
  private started = false;

  private initialTimer: ReturnType<typeof setTimeout> | null = null;
  private intervalTimer: ReturnType<typeof setInterval> | null = null;
  private watchdogTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: CreateUpdaterOptions) {
    this.options = options;
    this.mode = options.platform === "darwin" ? "manual" : "auto";
    this.github = options.github ?? DEFAULT_GITHUB;
    this.log = options.log ?? (() => undefined);
    this.state = createInitialUpdaterState({ currentVersion: options.currentVersion, mode: this.mode });

    this.preflightError =
      options.platform === "linux"
        ? (() => {
            const check = detectLinuxUpdatableForm({
              env: options.env ?? process.env,
              argv: options.argv ?? process.argv,
              execPath: options.execPath ?? process.execPath,
            });
            return check.supported ? null : check.error;
          })()
        : null;
  }

  getState(): UpdaterState {
    return { ...this.state };
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    if (this.preflightError !== null) {
      this.failWith(this.preflightError);
      return;
    }

    if (this.mode === "auto") {
      const updater = await this.ensureAutoUpdater();
      if (updater === null) return;
    }

    await this.restoreSkippedVersion();
    this.scheduleChecks();
  }

  stop(): void {
    if (this.initialTimer !== null) clearTimeout(this.initialTimer);
    if (this.intervalTimer !== null) clearInterval(this.intervalTimer);
    this.clearWatchdog();
    this.initialTimer = null;
    this.intervalTimer = null;
  }

  async check(input: { manual?: boolean } = {}): Promise<UpdaterState> {
    if (this.mode === "disabled") return this.getState();
    // 檢查／下載／已下載／安裝中不重入；已下載的更新不應被一次檢查丟掉。
    if (
      this.state.state === "checking" ||
      this.state.state === "downloading" ||
      this.state.state === "downloaded" ||
      this.state.state === "installing"
    ) {
      return this.getState();
    }
    if (this.preflightError !== null) {
      this.failWith(this.preflightError);
      return this.getState();
    }

    this.manualCheck = input.manual === true;
    if (this.mode === "manual") return this.checkMac();
    return this.checkAuto();
  }

  async download(): Promise<UpdaterState> {
    if (this.mode !== "auto" || this.state.state !== "available") return this.getState();
    const updater = await this.ensureAutoUpdater();
    if (updater === null) return this.getState();

    this.transition("downloading", {
      progress: { percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 },
      error: null,
    });
    try {
      await updater.downloadUpdate();
    } catch (error) {
      this.fail(error, "download-failed");
    }
    return this.getState();
  }

  async install(input: { force?: boolean } = {}): Promise<UpdaterState> {
    if (this.mode !== "auto") return this.getState();

    // 只有兩種情況可以進入安裝：
    // 1. 已下載完成（downloaded）。
    // 2. 上次因備份失敗中止，使用者明確 force 確認仍要安裝（error + backup-failed）。
    //    這條路徑不會再呼叫備份；一般 install()（無 force）不得從 error 進入安裝。
    const retryAfterBackupFailure =
      input.force === true &&
      this.state.state === "error" &&
      this.state.error?.code === "backup-failed" &&
      this.state.availableVersion !== null;

    if (this.state.state !== "downloaded" && !retryAfterBackupFailure) return this.getState();

    const updater = this.autoUpdater;
    if (updater === null) return this.getState();

    // AppImageUpdater 會先把目前 AppImage 刪掉，未下載完成就呼叫 quitAndInstall()
    // 可能直接弄壞安裝（U0 §Q2）；上面兩種狀態都保證更新檔已下載完成。
    this.transition("installing", { error: null });

    // 1. 標記 quitting：既有的 before-quit 看到 true 就直接放行，不重複關 server。
    this.options.onQuitting?.();

    // 2. 只關 server（不 app.exit、不刪 runtime.json）。
    //    closeServerOnly 可重入：備份失敗後的重試會拿到同一個已完成結果。
    try {
      await this.options.closeServerOnly();
    } catch (error) {
      return this.abortInstall("install-failed", error);
    }

    // 3. 更新前備份：關閉 server 之後、安裝之前。失敗預設取消安裝；
    //    只有使用者明確 force（已確認風險）才繼續。
    //    備份失敗後的重試已取得使用者確認，直接跳過備份。
    const toVersion = this.state.availableVersion;
    if (toVersion === null) {
      this.log("缺少要安裝的版本，已取消安裝");
      return this.abortInstall("install-failed");
    }
    if (retryAfterBackupFailure) {
      this.log("使用者確認在更新前備份未完成的情況下仍要安裝（重試）");
    } else {
      const backup = this.options.backup ?? createNoopBackup();
      let result: BackupResult;
      try {
        result = await backup.beforeUpdate({ fromVersion: this.options.currentVersion, toVersion });
      } catch {
        if (input.force !== true) {
          this.log("更新前備份發生錯誤，已取消安裝");
          return this.abortInstall("backup-failed");
        }
        result = { ok: false, code: "copy-failed", message: "使用者選擇略過備份" };
      }
      if (!result.ok) {
        if (input.force !== true) {
          // 不把備份實作的細節（可能含路徑）放進 IPC 狀態或 log；UI 顯示固定訊息並讓使用者決定是否 force。
          this.log(`更新前備份失敗（${result.code}），已取消安裝`);
          return this.abortInstall("backup-failed");
        }
        // 使用者已明確確認：記錄一筆不含內容的 warning 後繼續安裝。
        this.log("使用者確認在更新前備份未完成的情況下仍要安裝");
      }
    }

    // 4. 交給 electron-updater 替換檔案／執行安裝程式並結束 App。
    try {
      updater.quitAndInstall();
    } catch (error) {
      return this.abortInstall("install-failed", error);
    }

    this.startInstallWatchdog();
    return this.getState();
  }

  async later(): Promise<UpdaterState> {
    if (this.state.state !== "available" || this.state.availableVersion === null) return this.getState();
    const version = this.state.availableVersion;
    this.skippedVersion = version;
    await this.persistSkippedVersion(version);
    this.transition("idle", {
      availableVersion: null,
      releaseNotes: null,
      releaseUrl: null,
      progress: null,
      error: null,
      skippedVersion: version,
      checkedAt: nowIso(),
    });
    return this.getState();
  }

  async openReleasePage(): Promise<{ opened: boolean }> {
    const url = this.state.releaseUrl;
    if (url === null || !isAllowedReleaseUrl(url) || this.options.openExternal === undefined) {
      return { opened: false };
    }
    try {
      await this.options.openExternal(url);
      return { opened: true };
    } catch {
      this.log("開啟更新下載頁失敗");
      return { opened: false };
    }
  }

  private async checkAuto(): Promise<UpdaterState> {
    const updater = await this.ensureAutoUpdater();
    if (updater === null) return this.getState();

    this.transition("checking", { error: null, progress: null });
    try {
      await updater.checkForUpdates();
    } catch (error) {
      this.fail(error, "check-failed");
    }
    // `isUpdaterActive()` 為 false 時 checkForUpdates() 會回 null 且不發事件：
    // 不要讓狀態卡在 checking。
    if (this.state.state === "checking") this.transition("idle", { checkedAt: nowIso() });
    return this.getState();
  }

  private async checkMac(): Promise<UpdaterState> {
    if (this.options.fetchImpl === undefined) {
      this.fail(new UpdaterFault("unexpected", "缺少更新檢查的網路實作。"), "check-failed");
      return this.getState();
    }

    this.transition("checking", { error: null, progress: null });
    try {
      const result = await checkMacRelease({
        currentVersion: this.options.currentVersion,
        owner: this.github.owner,
        repo: this.github.repo,
        fetchImpl: this.options.fetchImpl,
      });
      if (result.release === null) {
        this.transition("idle", {
          availableVersion: null,
          releaseNotes: null,
          releaseUrl: null,
          progress: null,
          error: null,
          checkedAt: nowIso(),
        });
      } else if (!this.manualCheck && this.skippedVersion === result.release.version) {
        this.transition("idle", {
          availableVersion: null,
          releaseNotes: null,
          releaseUrl: null,
          progress: null,
          error: null,
          checkedAt: nowIso(),
        });
      } else {
        this.transition("available", {
          availableVersion: result.release.version,
          releaseNotes: result.release.releaseNotes,
          releaseUrl: result.release.releaseUrl,
          progress: null,
          error: null,
          checkedAt: nowIso(),
        });
      }
    } catch (error) {
      this.fail(error, "check-failed");
    }
    return this.getState();
  }

  private async ensureAutoUpdater(): Promise<ElectronUpdaterLike | null> {
    if (this.autoUpdater !== null) return this.autoUpdater;
    try {
      const updater = await (this.options.loadAutoUpdater ?? loadElectronUpdater)();
      wireAutoUpdater(updater, this.hooks);
      this.autoUpdater = updater;
      return updater;
    } catch (error) {
      this.log("載入更新模組失敗");
      this.fail(error, "unexpected");
      return null;
    }
  }

  private readonly hooks: AutoUpdaterHooks = {
    onChecking: () => this.transition("checking", { error: null }),
    onAvailable: (info) => this.handleAvailable(info),
    onNotAvailable: () =>
      this.transition("idle", {
        availableVersion: null,
        releaseNotes: null,
        releaseUrl: null,
        progress: null,
        error: null,
        checkedAt: nowIso(),
      }),
    onProgress: (progress) => this.transition("downloading", { progress }),
    onDownloaded: (info) => this.handleDownloaded(info),
    onError: (error) => {
      const phase = this.state.state;
      const fallback: UpdaterErrorCode =
        phase === "downloading" ? "download-failed" : phase === "installing" ? "install-failed" : "check-failed";
      // 安裝期間的錯誤（例如唯讀目錄）代表這次不會結束行程：把 quitting 還原並停掉 watchdog。
      if (phase === "installing") {
        this.options.onQuitAborted?.();
        this.clearWatchdog();
      }
      this.fail(error, fallback);
    },
    onAppImageRenamed: (newPath) => this.handleAppImageRenamed(newPath),
  };

  private handleAvailable(info: AutoUpdateInfo): void {
    const version = normalizeVersion(info.version);
    if (version === null) {
      this.fail(new UpdaterFault("invalid-version"), "check-failed");
      return;
    }
    if (!this.manualCheck && this.skippedVersion === version) {
      // 使用者本次已按「稍後」：不要再跳回 available。
      this.transition("idle", {
        availableVersion: null,
        releaseNotes: null,
        releaseUrl: null,
        progress: null,
        error: null,
        checkedAt: nowIso(),
      });
      return;
    }
    this.transition("available", {
      availableVersion: version,
      releaseNotes: info.releaseNotes,
      releaseUrl: this.releaseUrlFor(version),
      progress: null,
      error: null,
      checkedAt: nowIso(),
    });
  }

  private handleDownloaded(info: AutoUpdateInfo): void {
    const version = normalizeVersion(info.version) ?? this.state.availableVersion;
    this.skippedVersion = null;
    void this.persistSkippedVersion(null);
    this.transition("downloaded", {
      availableVersion: version,
      progress: { percent: 100, transferred: 0, total: 0, bytesPerSecond: 0 },
      error: null,
    });
  }

  private handleAppImageRenamed(newPath: string): void {
    let notice: string | null = null;
    try {
      notice = this.options.onAppImageRenamed?.(newPath) ?? null;
    } catch {
      this.log("AppImage 改名後的處理失敗");
      notice = "更新後請重新開啟開機自啟";
    }
    if (notice === null) {
      this.log("AppImage 檔名已更新（未設定自啟項目處理）");
      return;
    }
    this.state = { ...this.state, notice };
    this.publish();
  }

  private releaseUrlFor(version: string): string {
    return releasePageUrl(this.github.owner, this.github.repo, version);
  }

  private async restoreSkippedVersion(): Promise<void> {
    let stored: string | null = null;
    try {
      stored = (await this.options.skippedVersionStore?.load()) ?? null;
    } catch {
      this.log("讀取「稍後」的更新版本失敗");
      return;
    }
    if (stored === null) return;
    const version = normalizeVersion(stored);
    if (version === null) return;
    const comparison = compareVersions(version, this.options.currentVersion);
    if (comparison === null || comparison <= 0) return;

    // 下次啟動再問：不沿用「本次已略過」的抑制狀態；自動檢查後仍會顯示 available。
    this.skippedVersion = null;
    this.transition("available", {
      availableVersion: version,
      releaseNotes: null,
      releaseUrl: this.releaseUrlFor(version),
      progress: null,
      error: null,
      checkedAt: nowIso(),
    });
  }

  private async persistSkippedVersion(version: string | null): Promise<void> {
    try {
      await this.options.skippedVersionStore?.save(version);
    } catch {
      this.log("儲存「稍後」的更新版本失敗");
    }
  }

  private scheduleChecks(): void {
    const initialDelay = this.options.initialCheckDelayMs ?? DEFAULT_INITIAL_CHECK_DELAY_MS;
    const interval = this.options.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS;

    if (initialDelay >= 0) {
      this.initialTimer = setTimeout(() => {
        void this.check({ manual: false });
      }, initialDelay);
      this.initialTimer.unref?.();
    }
    if (interval > 0) {
      this.intervalTimer = setInterval(() => {
        void this.check({ manual: false });
      }, interval);
      this.intervalTimer.unref?.();
    }
  }

  private startInstallWatchdog(): void {
    const timeout = this.options.installWatchdogMs ?? DEFAULT_INSTALL_WATCHDOG_MS;
    if (timeout <= 0) return;
    this.watchdogTimer = setTimeout(() => {
      if (this.state.state !== "installing") return;
      // 安裝沒有真的結束行程（例如安裝器起不來）：回到錯誤狀態，讓使用者知道要重啟。
      this.options.onQuitAborted?.();
      this.failWith(updaterError("install-failed"));
    }, timeout);
    this.watchdogTimer.unref?.();
  }

  private clearWatchdog(): void {
    if (this.watchdogTimer !== null) clearTimeout(this.watchdogTimer);
    this.watchdogTimer = null;
  }

  private abortInstall(code: UpdaterErrorCode, error?: unknown): UpdaterState {
    this.options.onQuitAborted?.();
    this.clearWatchdog();
    const info = error === undefined ? updaterError(code) : toUpdaterErrorInfo(error, code);
    this.failWith(info);
    return this.getState();
  }

  private fail(error: unknown, fallback: UpdaterErrorCode): void {
    this.failWith(toUpdaterErrorInfo(error, fallback));
  }

  private failWith(info: UpdaterErrorInfo): void {
    if (!canTransition(this.state.state, "error")) {
      this.log(`忽略無效的更新狀態轉移：${this.state.state} → error`);
      return;
    }
    this.state = { ...this.state, state: "error", error: info, progress: null };
    this.publish();
  }

  private transition(phase: UpdaterState["state"], patch: Partial<UpdaterState> = {}): void {
    if (!canTransition(this.state.state, phase)) {
      this.log(`忽略無效的更新狀態轉移：${this.state.state} → ${phase}`);
      return;
    }
    this.state = { ...this.state, ...patch, state: phase };
    this.publish();
  }

  private publish(): void {
    this.options.onStateChange?.(this.getState());
  }
}
