/**
 * **DEV-only** 的更新狀態模擬（`?updaterMock=<情境>`）。
 *
 * 用途：在瀏覽器（沒有 Electron、沒有真的 updater）逐一檢視／截圖每個狀態，
 * 並驗證按鈕流程（包含「稍後」不得呼叫 install）。
 *
 * 安全邊界：
 * - 只在 `import.meta.env.DEV` 時啟用；production build 中 `DEV` 是 `false`，
 *   `createDevUpdaterMock()` 一律回 null，不掛任何東西、不讀 query、不排 timer。
 * - 這是 dev 工具，不是產品功能；所有狀態與版本號都是合成資料，不含真實路徑或 token。
 */
import type {
  DesktopUpdaterBridge,
  UpdaterErrorCode,
  UpdaterMode,
  UpdaterPhase,
  UpdaterState,
} from "./desktop";

/** 支援的模擬情境（`?updaterMock=` 的值）。 */
export type UpdaterMockScenario =
  | "idle"
  | "latest"
  | "checking"
  | "available"
  | "mac-available"
  | "downloading"
  | "downloaded"
  | "installing"
  | "disabled"
  | "error-offline"
  | "error-not-found"
  | "error-rate-limit"
  | "error-checksum"
  | "error-read-only"
  | "error-unsupported-appimage"
  | "error-unsupported-tarball"
  | "error-signature"
  | "error-backup-failed"
  | "error-unknown"
  | "duplicate"
  | "flow";

const SCENARIOS: readonly UpdaterMockScenario[] = [
  "idle",
  "latest",
  "checking",
  "available",
  "mac-available",
  "downloading",
  "downloaded",
  "installing",
  "disabled",
  "error-offline",
  "error-not-found",
  "error-rate-limit",
  "error-checksum",
  "error-read-only",
  "error-unsupported-appimage",
  "error-unsupported-tarball",
  "error-signature",
  "error-backup-failed",
  "error-unknown",
  "duplicate",
  "flow",
];

const CURRENT_VERSION = "0.5.0";
const AVAILABLE_VERSION = "0.6.0";
const RELEASE_URL = "https://github.com/j7708git/mnemoshelf/releases/tag/v0.6.0";
const RELEASE_NOTES = [
  "## 0.6.0",
  "",
  "- 新增：應用程式內檢查與安裝更新",
  "- 修正：大型資料夾的索引進度偶爾停住",
  "- 改善：首次啟動的模型下載速度",
  "",
  "這一行的標籤會以純文字顯示：<b>不會被當成 HTML</b>",
  "",
  "更新完成後需要重新啟動應用程式。",
].join("\n");

const DOWNLOAD_TOTAL = 48 * 1024 * 1024;

/** 錯誤情境 → 錯誤代碼。 */
const ERROR_CODES: Partial<Record<UpdaterMockScenario, UpdaterErrorCode>> = {
  "error-offline": "offline",
  "error-not-found": "not-found",
  "error-rate-limit": "rate-limit",
  "error-checksum": "checksum",
  "error-read-only": "read-only",
  "error-unsupported-appimage": "unsupported-appimage",
  "error-unsupported-tarball": "unsupported-tarball",
  "error-signature": "invalid-signature",
  "error-backup-failed": "backup-failed",
  "error-unknown": "unexpected",
};

interface MockCalls {
  check: number;
  download: number;
  install: number;
  later: number;
  openReleasePage: number;
  restartApp: number;
}

/** 呼叫次數的快照（給 dev 面板顯示，證明某個動作有沒有被呼叫）。 */
export type MockCallsSnapshot = MockCalls;

/** 模擬 bridge：除了契約方法外，附上呼叫次數供驗證畫面顯示。 */
export interface DevUpdaterMock extends DesktopUpdaterBridge {
  readonly scenario: UpdaterMockScenario;
  readonly calls: MockCalls;
  dispose(): void;
}

/** 每個情境的初始狀態。 */
function initialState(scenario: UpdaterMockScenario): UpdaterState {
  const mode: UpdaterMode =
    scenario === "mac-available" ? "manual" : scenario === "disabled" ? "disabled" : "auto";
  const base: UpdaterState = {
    state: "idle",
    mode,
    currentVersion: CURRENT_VERSION,
    availableVersion: null,
    releaseNotes: null,
    releaseUrl: null,
    progress: null,
    error: null,
    skippedVersion: null,
    checkedAt: null,
    notice: null,
  };

  const available: UpdaterState = {
    ...base,
    state: "available",
    availableVersion: AVAILABLE_VERSION,
    releaseNotes: RELEASE_NOTES,
    releaseUrl: RELEASE_URL,
    checkedAt: null,
  };

  const errorCode = ERROR_CODES[scenario];
  if (errorCode !== undefined) {
    return {
      ...base,
      state: "error",
      error: { code: errorCode, message: "" },
      checkedAt: new Date().toISOString(),
    };
  }

  switch (scenario) {
    case "latest":
      return { ...base, checkedAt: new Date().toISOString() };
    case "checking":
      return { ...base, state: "checking" };
    case "available":
    case "flow":
      return scenario === "available" ? available : base;
    case "mac-available":
      return available;
    case "downloading":
      return {
        ...available,
        state: "downloading",
        progress: {
          percent: 42,
          transferred: Math.round(DOWNLOAD_TOTAL * 0.42),
          total: DOWNLOAD_TOTAL,
          bytesPerSecond: 2.4 * 1024 * 1024,
        },
      };
    case "downloaded":
      return {
        ...available,
        state: "downloaded",
        progress: { percent: 100, transferred: DOWNLOAD_TOTAL, total: DOWNLOAD_TOTAL, bytesPerSecond: 0 },
      };
    case "installing":
      return { ...available, state: "installing" };
    case "duplicate":
      return { ...base, state: "checking" };
    default:
      return base;
  }
}

/** 讀出 query 裡的模擬情境；非 DEV 或沒有參數時回 null。 */
export function devUpdaterMockScenario(search: string | null = typeof window === "undefined" ? null : window.location.search): string | null {
  if (!import.meta.env.DEV) return null;
  if (search === null || search === "") return null;
  const value = new URLSearchParams(search).get("updaterMock");
  return value === null || value.trim() === "" ? null : value.trim();
}

/** 建立模擬 bridge；非 DEV 或情境不認識時回 null（production 沒有任何副作用）。 */
export function createDevUpdaterMock(
  requestedScenario: string | null,
  onCallsChanged?: (calls: MockCallsSnapshot) => void,
): DevUpdaterMock | null {
  if (!import.meta.env.DEV) return null;
  if (requestedScenario === null) return null;
  if (!SCENARIOS.includes(requestedScenario as UpdaterMockScenario)) return null;

  const scenario = requestedScenario as UpdaterMockScenario;
  const listeners = new Set<(state: UpdaterState) => void>();
  const timers = new Set<number>();
  const calls: MockCalls = { check: 0, download: 0, install: 0, later: 0, openReleasePage: 0, restartApp: 0 };
  let state = initialState(scenario);
  let progressTimer: number | null = null;

  const copy = (): UpdaterState => ({
    ...state,
    progress: state.progress === null ? null : { ...state.progress },
    error: state.error === null ? null : { ...state.error },
  });

  const emit = (next: UpdaterState): void => {
    state = next;
    for (const listener of listeners) listener(copy());
  };

  const schedule = (fn: () => void, ms: number): void => {
    const timer = window.setTimeout(() => {
      timers.delete(timer);
      fn();
    }, ms);
    timers.add(timer);
  };

  const bump = (key: keyof MockCalls): void => {
    calls[key] += 1;
    onCallsChanged?.({ ...calls });
  };

  const stopProgress = (): void => {
    if (progressTimer !== null) {
      window.clearInterval(progressTimer);
      timers.delete(progressTimer);
      progressTimer = null;
    }
  };

  const toAvailable = (): void => {
    emit({
      ...state,
      state: "available",
      availableVersion: AVAILABLE_VERSION,
      releaseNotes: RELEASE_NOTES,
      releaseUrl: RELEASE_URL,
      progress: null,
      error: null,
      checkedAt: new Date().toISOString(),
    });
  };

  const toIdle = (skippedVersion: string | null): void => {
    emit({
      ...state,
      state: "idle",
      availableVersion: null,
      releaseNotes: null,
      releaseUrl: null,
      progress: null,
      error: null,
      skippedVersion,
      checkedAt: new Date().toISOString(),
    });
  };

  const fail = (code: UpdaterErrorCode): void => {
    emit({
      ...state,
      state: "error",
      error: { code, message: "" },
      progress: null,
      checkedAt: new Date().toISOString(),
    });
  };

  const startDownload = (): void => {
    stopProgress();
    const total = DOWNLOAD_TOTAL;
    emit({
      ...state,
      state: "downloading",
      progress: { percent: 0, transferred: 0, total, bytesPerSecond: 0 },
      error: null,
    });
    progressTimer = window.setInterval(() => {
      const current = state.progress;
      if (state.state !== "downloading" || current === null) {
        stopProgress();
        return;
      }
      const percent = Math.min(100, current.percent + 7);
      const transferred = Math.round((total * percent) / 100);
      if (percent >= 100) {
        stopProgress();
        emit({
          ...state,
          state: "downloaded",
          progress: { percent: 100, transferred: total, total, bytesPerSecond: 0 },
        });
        return;
      }
      emit({
        ...state,
        progress: { percent, transferred, total, bytesPerSecond: 3.1 * 1024 * 1024 },
      });
    }, 150);
    timers.add(progressTimer);
  };

  const api: DevUpdaterMock = {
    scenario,
    calls,
    getState: async () => copy(),
    check: async () => {
      bump("check");
      if (state.mode === "disabled") return copy();
      if (state.state === "downloading" || state.state === "downloaded" || state.state === "installing") {
        return copy();
      }
      emit({ ...state, state: "checking", error: null, progress: null });

      if (scenario === "checking") return copy();
      if (scenario === "duplicate") {
        schedule(() => {
          if (state.state === "checking") emit({ ...state });
        }, 80);
        schedule(() => fail("offline"), 700);
        schedule(() => fail("offline"), 760);
        return copy();
      }
      if (scenario === "latest" || scenario === "idle") {
        schedule(() => toIdle(null), 450);
        return copy();
      }
      const errorCode = ERROR_CODES[scenario];
      if (errorCode !== undefined) {
        schedule(() => fail(errorCode), 500);
        return copy();
      }
      schedule(toAvailable, 500);
      return copy();
    },
    download: async () => {
      bump("download");
      if (state.mode !== "auto" || state.state !== "available") return copy();
      startDownload();
      return copy();
    },
    install: async () => {
      bump("install");
      if (state.state !== "downloaded") return copy();
      stopProgress();
      emit({ ...state, state: "installing", error: null });
      return copy();
    },
    later: async () => {
      bump("later");
      if (state.state !== "available" || state.availableVersion === null) return copy();
      toIdle(state.availableVersion);
      return copy();
    },
    openReleasePage: async () => {
      bump("openReleasePage");
      return { opened: state.releaseUrl !== null };
    },
    restartApp: async () => {
      bump("restartApp");
    },
    onState: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose: () => {
      stopProgress();
      for (const timer of timers) window.clearTimeout(timer);
      timers.clear();
      listeners.clear();
    },
  };

  // 「duplicate」情境：模擬同一次檢查重複送達（不需使用者按檢查），
  // 驗證 UI 去重後只顯示一次 checking／error。
  if (scenario === "duplicate") {
    schedule(() => {
      if (state.state === "checking") emit({ ...state });
    }, 80);
    schedule(() => fail("offline"), 700);
    schedule(() => fail("offline"), 760);
  }

  return api;
}