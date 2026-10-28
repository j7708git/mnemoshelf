/**
 * 設定頁的「更新」區塊。
 *
 * 資料全部來自桌面殼的 `updater` IPC（U2）：UI 只顯示狀態、送操作，不自己推算版本或
 * 拼 GitHub API。重點行為：
 * - **事件冪等**：U2 的狀態機允許同一階段轉同一階段（一次檢查可能送兩次 `checking`／
 *   `error`）。這裡用 `mergeUpdaterState` 把完全相同的狀態吃掉，畫面不重複播報、不閃爍。
 * - **進度節流**：下載事件最多每 100ms 套用一次；狀態區有固定最小高度，0%→100% 不跳動。
 * - **「稍後」只呼叫 `later()`**，不碰 `install()`；按完顯示「已略過…，下次啟動再提醒」。
 * - **非 Electron／v1 殼**：不呼叫不存在的物件、不拋錯，只顯示「僅桌面版可用」。
 * - **DEV 模擬**：`?updaterMock=<情境>`（僅 dev build）可逐一檢視狀態，production 無副作用。
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  getDesktopUpdater,
  useDesktopBridge,
  type DesktopUpdaterBridge,
  type UpdaterState,
} from "./desktop";
import {
  isUnsupportedInstallForm,
  mergeUpdaterState,
  progressPercent,
  progressSummary,
  updaterErrorMessage,
} from "./updaterState";
import {
  createDevUpdaterMock,
  devUpdaterMockScenario,
  type DevUpdaterMock,
  type MockCallsSnapshot,
} from "./updaterDevMock";

export interface UpdaterPanelProps {
  /** 桌面設定裡的版本；updater 狀態還沒回來時先顯示這個。 */
  currentVersion?: string | null;
}

/** 下載進度事件的最小套用間隔（毫秒）。 */
const PROGRESS_INTERVAL_MS = 100;

/** 專案公開的 Release 頁面；只在 U2 沒有提供 `releaseUrl` 的手動更新說明裡使用。 */
const RELEASES_PAGE = "https://github.com/j7708git/mnemoshelf/releases/latest";

/**
 * 本次執行已按「稍後」的版本（模組層級，設定頁關閉再開仍保留；重新啟動即清除）。
 *
 * U2 的 `later()` 在 `downloaded` 階段是 no-op（只接受 `available`），但卡片要求
 * 下載完成後也能「稍後」。用這個旗標記住使用者的選擇，讓「下次啟動再提醒」在
 * 同一次執行內一致；真正的持久化與下次啟動重問由 U2 負責。
 */
let sessionDeferredVersion: string | null = null;

const PRIMARY_CLASS =
  "updater-action min-w-40 rounded-md bg-ink px-3 py-2 text-sm font-medium text-white disabled:opacity-40";
const SECONDARY_CLASS =
  "updater-action min-w-40 rounded-md border border-line px-3 py-2 text-sm font-medium text-ink disabled:opacity-40";

function Spinner(): ReactNode {
  return (
    <span
      aria-hidden="true"
      className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent align-[-2px]"
    />
  );
}

/** 狀態文字（繁中；錯誤時不把離線說成「已是最新」）。 */
function describeUpdaterStatus(state: UpdaterState | null, loadError: string | null): string {
  if (loadError !== null) return `讀取更新狀態失敗：${loadError}`;
  if (state === null) return "讀取更新狀態…";
  if (state.mode === "disabled") return "此版本不提供應用程式內更新（開發模式或未封裝版本）。";
  switch (state.state) {
    case "idle":
      if (state.skippedVersion !== null) {
        return `已略過此版本（v${state.skippedVersion}），下次啟動再提醒。`;
      }
      if (state.checkedAt !== null) return "已是最新版本。";
      return "尚未檢查更新。";
    case "checking":
      return "正在檢查更新…";
    case "available":
      return state.availableVersion === null
        ? "有新版本可用。"
        : `有新版本 v${state.availableVersion} 可用。${state.mode === "manual" ? "macOS 需手動下載安裝。" : ""}`;
    case "downloading":
      return "正在下載更新…";
    case "downloaded":
      return state.availableVersion === null
        ? "更新已下載，重新啟動後安裝。"
        : `版本 v${state.availableVersion} 已下載，重新啟動後安裝。`;
    case "installing":
      return "正在安裝更新，應用程式即將重新啟動…";
    case "error": {
      const code = state.error?.code ?? "unexpected";
      return updaterErrorMessage(code, state.error?.message ?? null);
    }
  }
}

/** 版本字串統一加 `v`（IPC 的版本不含 `v`，桌面設定的版本也不含）。 */
function versionLabel(version: string | null): string {
  if (version === null || version.trim() === "") return "讀取中…";
  return version.startsWith("v") ? version : `v${version}`;
}

/**
 * 訂閱 updater 狀態：掛載時先抓一次，之後收推播。
 *
 * - 初始狀態只在還沒收到任何事件時套用（避免 `getState()` 較慢回來的舊狀態蓋掉新事件）。
 * - 相同狀態不重繪（重複的 `checking`／`error` 不會造成閃爍）。
 * - `downloading` 的進度事件以 100ms 節流；最後一個事件一定會補上。
 */
function useUpdaterState(updater: DesktopUpdaterBridge | null): {
  state: UpdaterState | null;
  loadError: string | null;
  applyState: (next: UpdaterState) => void;
} {
  const [state, setState] = useState<UpdaterState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const stateRef = useRef<UpdaterState | null>(null);
  const lastProgressAt = useRef(0);
  const pendingProgress = useRef<UpdaterState | null>(null);
  const flushTimer = useRef<number | null>(null);

  const applyState = useCallback((next: UpdaterState, initial = false) => {
    const current = stateRef.current;
    if (initial && current !== null) return;
    const merged = mergeUpdaterState(current, next);
    if (merged === current) return;
    stateRef.current = merged;
    setState(merged);
  }, []);

  useEffect(() => {
    stateRef.current = null;
    pendingProgress.current = null;
    lastProgressAt.current = 0;
    setState(null);
    setLoadError(null);
    if (flushTimer.current !== null) {
      window.clearTimeout(flushTimer.current);
      flushTimer.current = null;
    }
    if (updater === null) return;

    let alive = true;

    const clearFlush = (): void => {
      if (flushTimer.current !== null) {
        window.clearTimeout(flushTimer.current);
        flushTimer.current = null;
      }
      pendingProgress.current = null;
    };

    const flush = (): void => {
      flushTimer.current = null;
      const next = pendingProgress.current;
      pendingProgress.current = null;
      if (next !== null) applyState(next);
    };

    const listener = (next: UpdaterState): void => {
      if (!alive) return;
      if (next.state === "downloading" && stateRef.current?.state === "downloading") {
        const elapsed = Date.now() - lastProgressAt.current;
        if (elapsed < PROGRESS_INTERVAL_MS) {
          pendingProgress.current = next;
          if (flushTimer.current === null) {
            flushTimer.current = window.setTimeout(flush, PROGRESS_INTERVAL_MS - elapsed);
          }
          return;
        }
        lastProgressAt.current = Date.now();
        pendingProgress.current = null;
      } else {
        // 換階段時不要讓排隊中的舊進度在之後補上。
        lastProgressAt.current = 0;
        clearFlush();
      }
      applyState(next);
    };

    void updater
      .getState()
      .then((next) => {
        if (alive) applyState(next, true);
      })
      .catch((error: unknown) => {
        if (!alive) return;
        setLoadError(error instanceof Error ? error.message : "未知的錯誤");
      });
    const unsubscribe = updater.onState(listener);

    return () => {
      alive = false;
      unsubscribe();
      clearFlush();
    };
  }, [updater, applyState]);

  return { state, loadError, applyState };
}

export function UpdaterPanel({ currentVersion = null }: UpdaterPanelProps) {
  const bridge = useDesktopBridge();
  const desktopUpdater = getDesktopUpdater(bridge);
  const [mockCalls, setMockCalls] = useState<MockCallsSnapshot | null>(null);
  const [mock, setMock] = useState<DevUpdaterMock | null>(null);
  // DEV 模擬要在 effect 裡建立／銷毀：StrictMode 會 effect→cleanup→effect，
  // 放在 useState 初始化器會被第一次 cleanup 永久清掉 listener。
  useEffect(() => {
    const created = createDevUpdaterMock(devUpdaterMockScenario(), setMockCalls);
    setMock(created);
    if (created === null) return;
    return () => {
      created.dispose();
    };
  }, []);

  const updater = mock ?? desktopUpdater;
  const { state, loadError, applyState } = useUpdaterState(updater);
  const [pendingAction, setPendingAction] = useState<"check" | "download" | "install" | "later" | "open" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [openNotice, setOpenNotice] = useState<string | null>(null);
  /**
   * 本地的「已略過」版本。
   *
   * U2 的 `later()` 目前只接受 `available`（`downloaded` 會原樣返回）；但卡片要求
   * 「下載完成後也能稍後」。下載完成時按稍後仍然呼叫 `later()`（不觸發安裝），
   * 若 U2 沒有把狀態收回 idle，就用這個標記顯示同一句提示——下次啟動 U2 會重新檢查，
   * 不會靜默安裝（`autoInstallOnAppQuit=false`）。
   */
  const [deferredVersion, setDeferredVersion] = useState<string | null>(() => sessionDeferredVersion);
  const statusRef = useRef<HTMLDivElement | null>(null);

  const rememberDeferred = useCallback((version: string | null): void => {
    sessionDeferredVersion = version;
    setDeferredVersion(version);
  }, []);

  // 離開「已下載」階段（例如真的開始安裝、換了新版本、或回到 idle）就清掉本次的
  // 「已略過」；只有 downloaded 階段需要這個本地標記。
  useEffect(() => {
    if (deferredVersion === null || state === null) return;
    if (state.state !== "downloaded") rememberDeferred(null);
  }, [state, deferredVersion, rememberDeferred]);

  const run = useCallback(
    async (action: "check" | "download" | "install" | "later" | "open"): Promise<void> => {
      if (updater === null) return;
      setPendingAction(action);
      setActionError(null);
      setOpenNotice(null);
      if (action !== "later") rememberDeferred(null);
      try {
        if (action === "open") {
          const result = await updater.openReleasePage();
          setOpenNotice(result.opened ? "已開啟下載頁。" : "無法開啟下載頁，請確認系統瀏覽器可用後再試。");
          return;
        }
        const call =
          action === "check"
            ? updater.check()
            : action === "download"
              ? updater.download()
              : action === "install"
                ? updater.install()
                : updater.later();
        const next = await call;
        applyState(next);
        if (action === "later") {
          if (next.state === "idle" && next.skippedVersion !== null) {
            rememberDeferred(null);
          } else {
            const skipped = next.availableVersion ?? state?.availableVersion ?? null;
            if (skipped !== null) rememberDeferred(skipped);
          }
        }
        // 按下後按鈕會消失的操作（下載／安裝／稍後）：把焦點移到狀態區，鍵盤焦點不落地。
        if (action === "download" || action === "install" || action === "later") {
          statusRef.current?.focus();
        }
      } catch (error) {
        setActionError(error instanceof Error ? error.message : "更新操作失敗，請稍後再試。");
      } finally {
        setPendingAction(null);
      }
    },
    [updater, applyState, state, rememberDeferred],
  );

  if (updater === null) {
    return (
      <div className="space-y-1" data-testid="updater-panel">
        <h3 className="text-sm font-medium text-ink">更新</h3>
        <p className="text-xs text-muted">
          {bridge !== null
            ? "目前的桌面殼版本不支援應用程式內更新，請下載新版本。"
            : "更新功能僅桌面版可用（瀏覽器模式無法檢查或安裝更新）。"}
        </p>
      </div>
    );
  }

  const busy = pendingAction !== null;
  const phase = state?.state ?? "idle";
  const mode = state?.mode ?? null;
  const isChecking = phase === "checking";
  const isInstalling = phase === "installing";
  const unsupported =
    state?.state === "error" && state.error !== null && isUnsupportedInstallForm(state.error.code);
  const readOnly = state?.state === "error" && state.error?.code === "read-only";
  const canOpenReleasePage = state !== null && state.releaseUrl !== null;
  const actions: ReactNode[] = [];

  if (state === null) {
    actions.push(
      <button
        key="check-loading"
        type="button"
        disabled={loadError === null || busy}
        onClick={() => void run("check")}
        className={PRIMARY_CLASS}
      >
        {loadError === null ? "檢查更新" : pendingAction === "check" ? "重試中…" : "重試"}
      </button>,
    );
  } else if (mode === "disabled") {
    // 開發模式／未封裝：沒有任何可用的更新操作。
  } else if (phase === "idle") {
    actions.push(
      <button
        key="check"
        type="button"
        disabled={busy}
        onClick={() => void run("check")}
        className={PRIMARY_CLASS}
      >
        {pendingAction === "check" ? "檢查中…" : "檢查更新"}
      </button>,
    );
  } else if (phase === "checking") {
    actions.push(
      <button key="checking" type="button" disabled className={PRIMARY_CLASS}>
        <Spinner /> <span className="ml-1 align-middle">正在檢查…</span>
      </button>,
    );
  } else if (phase === "available") {
    if (mode === "manual") {
      actions.push(
        <button
          key="open"
          type="button"
          disabled={busy || !canOpenReleasePage}
          onClick={() => void run("open")}
          className={PRIMARY_CLASS}
        >
          {pendingAction === "open" ? "開啟中…" : "開啟下載頁"}
        </button>,
      );
    } else {
      actions.push(
        <button
          key="download"
          type="button"
          disabled={busy}
          onClick={() => void run("download")}
          className={PRIMARY_CLASS}
        >
          {pendingAction === "download" ? "開始下載…" : "下載並安裝"}
        </button>,
      );
    }
  } else if (phase === "downloading") {
    actions.push(
      <button key="downloading" type="button" disabled className={PRIMARY_CLASS}>
        正在下載…
      </button>,
    );
  } else if (phase === "downloaded") {
    actions.push(
      <button
        key="install"
        type="button"
        disabled={busy}
        onClick={() => void run("install")}
        className={PRIMARY_CLASS}
      >
        {pendingAction === "install" ? "正在重新啟動…" : "重啟並安裝"}
      </button>,
      <button
        key="later"
        type="button"
        disabled={busy}
        onClick={() => void run("later")}
        className={SECONDARY_CLASS}
      >
        稍後
      </button>,
    );
  } else if (phase === "installing") {
    actions.push(
      <button key="installing" type="button" disabled className={PRIMARY_CLASS}>
        <Spinner /> <span className="ml-1 align-middle">正在安裝…</span>
      </button>,
    );
  } else if (phase === "error") {
    actions.push(
      <button
        key="retry"
        type="button"
        disabled={busy}
        onClick={() => void run("check")}
        className={PRIMARY_CLASS}
      >
        {pendingAction === "check" ? "重試中…" : "重試"}
      </button>,
    );
  }

  const progress = state?.progress ?? null;
  const percent = progressPercent(progress);
  const showProgress = phase === "downloading" && progress !== null;
  const deferred = deferredVersion !== null && state !== null && state.state === "downloaded";
  const statusLine = deferred
    ? `已略過此版本（v${deferredVersion}），下次啟動再提醒。`
    : describeUpdaterStatus(state, loadError);
  if (deferred) actions.length = 0;

  return (
    <div className="space-y-3" data-testid="updater-panel">
      <h3 className="text-sm font-medium text-ink">更新</h3>
      <p className="text-xs text-muted" data-testid="updater-current-version">
        目前版本：{versionLabel(state?.currentVersion ?? currentVersion)}
      </p>

      <div className="updater-status">
        <div
          ref={statusRef}
          tabIndex={-1}
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className="updater-status-message updater-focusable flex items-start gap-2 text-sm text-ink"
          data-testid="updater-status"
        >
          {(isChecking || isInstalling) && (
            <span className="mt-0.5 text-muted">
              <Spinner />
            </span>
          )}
          <span>{statusLine}</span>
        </div>

        {state?.state === "error" && state.error !== null && (
          <p className="mt-1 text-xs text-muted" data-testid="updater-error-code">
            錯誤代碼：<code>{state.error.code}</code>
          </p>
        )}

        {state?.notice !== null && state?.notice !== undefined && (
          <p className="mt-1 text-xs text-muted" data-testid="updater-notice">
            {state.notice}
          </p>
        )}

        <div className="updater-progress-area">
          {showProgress ? (
            <>
              <div
                role="progressbar"
                aria-label="更新下載進度"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent}
                aria-valuetext={progressSummary(progress)}
                className="h-2 w-full overflow-hidden rounded-full bg-line"
                data-testid="updater-progressbar"
              >
                <div className="h-full bg-ink transition-[width] duration-150" style={{ width: `${percent}%` }} />
              </div>
              <p className="mt-1 text-xs text-muted" data-testid="updater-progress-text">
                {progressSummary(progress)}
              </p>
            </>
          ) : null}
        </div>
      </div>

      {actions.length > 0 && (
        <div className="flex flex-wrap items-center gap-2" data-testid="updater-actions">
          {actions}
        </div>
      )}

      {actionError !== null && (
        <p role="alert" className="text-xs text-red-600">
          {actionError}
        </p>
      )}
      {openNotice !== null && (
        <p role="status" className="text-xs text-muted">
          {openNotice}
        </p>
      )}

      {!deferred && state?.releaseNotes !== null && state?.releaseNotes !== undefined && (
        <div className="space-y-1">
          <h4 className="text-xs font-medium text-ink">更新內容</h4>
          {/* 純文字顯示：React 會跳脫 HTML；不要用 dangerouslySetInnerHTML（XSS）。 */}
          <div className="updater-notes rounded-md border border-line bg-surface px-3 py-2 text-xs text-muted" data-testid="updater-notes">
            {state.releaseNotes}
          </div>
        </div>
      )}

      {mode === "manual" && (
        <div className="rounded-md border border-line bg-surface px-3 py-2 text-xs text-muted" data-testid="updater-macos-help">
          <p className="font-medium text-ink">macOS 目前不支援 App 內自動安裝</p>
          <p className="mt-1">按「開啟下載頁」下載 .dmg 後手動安裝：</p>
          <ol className="mt-1 list-decimal space-y-1 pl-5">
            <li>開啟 .dmg，把 Mnemoshelf 拖進「應用程式」資料夾並覆蓋舊版。</li>
            <li>
              第一次開啟若被 Gatekeeper 擋下：對 App 按右鍵 →「打開」，或到「系統設定 → 隱私權與安全性」按「仍要打開」。
            </li>
            <li>
              若顯示「已損毀，無法打開」（未簽章／未公證的常見情況），在終端機執行{" "}
              <code className="break-all">xattr -dr com.apple.quarantine /Applications/Mnemoshelf.app</code> 後再開。
            </li>
          </ol>
        </div>
      )}

      {unsupported && (
        <div className="rounded-md border border-line bg-surface px-3 py-2 text-xs text-muted" data-testid="updater-manual-help">
          <p>{readOnly ? "此位置無法自動更新，手動更新方式：" : "此安裝形式不支援應用程式內更新。手動更新方式："}</p>
          <p className="mt-1">
            到 GitHub Releases 下載新版本的安裝檔，關閉應用程式後覆蓋安裝；Linux AppImage 請下載新的
            .AppImage、保留執行權限（<code>chmod +x</code>）後再開啟。tar.gz／解壓目錄請解壓到新目錄替換舊版。
          </p>
          <div className="mt-2">
            {canOpenReleasePage ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => void run("open")}
                className="updater-action rounded-md border border-line px-3 py-1.5 text-xs font-medium text-ink disabled:opacity-40"
              >
                開啟下載頁
              </button>
            ) : (
              <a
                className="updater-link underline"
                href={RELEASES_PAGE}
                target="_blank"
                rel="noreferrer"
              >
                到 GitHub Releases 下載
              </a>
            )}
          </div>
        </div>
      )}

      {import.meta.env.DEV && mock !== null && (
        <p className="text-xs text-muted" data-testid="updater-mock-trace">
          開發模擬（{mock.scenario}）：check {mockCalls?.check ?? 0}｜download {mockCalls?.download ?? 0}｜install{" "}
          {mockCalls?.install ?? 0}｜later {mockCalls?.later ?? 0}｜open {mockCalls?.openReleasePage ?? 0}
        </p>
      )}
    </div>
  );
}
