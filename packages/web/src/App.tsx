import { useCallback, useEffect, useState } from "react";
import {
  clearToken,
  getToken,
  listRoots,
  NetworkError,
  removeRoot,
  setToken,
  UNAUTHORIZED_EVENT,
  UnauthorizedApiError,
  type Root,
} from "./api";
import { AddRootFlow } from "./AddRootFlow";
import { BootstrapScreen } from "./BootstrapScreen";
import { ExplorerPanel } from "./ExplorerPanel";
import { MemoriesPanel } from "./MemoriesPanel";
import { RootsList } from "./RootsList";
import { SearchPanel } from "./SearchPanel";
import { SettingsPanel } from "./SettingsPanel";
import { TokenForm } from "./TokenForm";
import { useDesktopBridge, type DesktopBootstrapState, type DesktopSettingsState } from "./desktop";

/** 畫面的四種狀態。 */
type ViewState =
  | { kind: "need-token"; message: string | null }
  | { kind: "loading" }
  | { kind: "ready"; roots: Root[] }
  | { kind: "error"; message: string };

/** 連線後的主要檢視。 */
type View = "explorer" | "search" | "memories";

const NAV_LABEL: Record<View, string> = {
  explorer: "檔案總管",
  search: "搜尋",
  memories: "記憶管理",
};

/**
 * 應用根元件：token → 資料夾清單 → 三個主要檢視（檔案總管／搜尋／記憶管理）。
 *
 * 兩種執行環境共用同一份 UI：
 * - **桌面模式**（Electron 殼）：preload 掛上 `window.mnemoshelfDesktop`，token 由應用自己管
 *   （main process 以 `webRequest` 注入標頭），因此不出現手動貼 token 的畫面；
 *   模型下載進度也由殼推過來（`BootstrapScreen`），下載完成前先顯示進度。
 * - **瀏覽器模式**：直接開服務的網址，token 由使用者貼上（`TokenForm`），行為與 M3 相同。
 */
export function App() {
  const desktop = useDesktopBridge();
  const [state, setState] = useState<ViewState>(() =>
    desktop !== null ? { kind: "loading" } : getToken() === null ? { kind: "need-token", message: null } : { kind: "loading" },
  );
  const [selectedRootId, setSelectedRootId] = useState<number | null>(null);
  const [view, setView] = useState<View>("explorer");
  const [mode, setMode] = useState<"explorer" | "add-root">("explorer");
  /** 遞增以強制目錄樹與狀態重新載入。 */
  const [refreshKey, setRefreshKey] = useState(0);

  /** 桌面殼的模型下載狀態（瀏覽器模式永遠是 null）。 */
  const [bootstrap, setBootstrap] = useState<DesktopBootstrapState | null>(null);
  const [bootstrapBusy, setBootstrapBusy] = useState(false);
  /** 使用者在下載失敗時選擇「先進入應用」。 */
  const [bootstrapSkipped, setBootstrapSkipped] = useState(false);
  const [settings, setSettings] = useState<DesktopSettingsState | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    setState({ kind: "loading" });
    try {
      const roots = await listRoots();
      setState({ kind: "ready", roots });
    } catch (error) {
      if (error instanceof UnauthorizedApiError) {
        if (desktop !== null) {
          // 桌面模式的 token 由殼自己注入，401 代表殼與服務對不上（不該發生）：給可重試的錯誤。
          setState({
            kind: "error",
            message: "本機服務拒絕了這次請求（401）。請按「重試」；若持續失敗，請重新啟動應用程式。",
          });
          return;
        }
        setState({ kind: "need-token", message: "token 不正確或已失效，請重新輸入。" });
        return;
      }
      if (error instanceof NetworkError) {
        setState({ kind: "error", message: error.message });
        return;
      }
      setState({ kind: "error", message: error instanceof Error ? error.message : "發生未知的錯誤。" });
    }
  }, [desktop]);

  /** 桌面模式：訂閱模型下載狀態（掛載時先問一次目前狀態，之後收推播）。 */
  useEffect(() => {
    if (desktop === null) return;
    let alive = true;
    void desktop.bootstrap
      .getState()
      .then((current) => {
        if (alive && current !== null) setBootstrap(current);
      })
      .catch(() => undefined);
    const unsubscribe = desktop.bootstrap.onUpdate((current) => {
      if (alive) setBootstrap(current);
    });
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [desktop]);

  /** 桌面模式：取得設定（token 保存狀態、開機自啟）。 */
  useEffect(() => {
    if (desktop === null) return;
    let alive = true;
    void desktop.settings
      .get()
      .then((value) => {
        if (alive) setSettings(value);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [desktop]);

  /**
   * 只有「真的在下載（或下載失敗）」才擋住介面。
   *
   * `checking`／`idle` 也擋的話，模型本來就在磁碟上的使用者每次啟動都會閃一下下載畫面；
   * 模型不在磁碟時，狀態會在幾毫秒內變成 `downloading`，那時才擋（下載要幾分鐘，擋住是合理的）。
   */
  const bootstrapBlocking =
    desktop !== null &&
    bootstrap !== null &&
    (bootstrap.phase === "downloading" || bootstrap.phase === "verifying" || bootstrap.phase === "failed");
  const bootstrapReady = !bootstrapBlocking || bootstrapSkipped;

  // 掛載時若已有 token（同一分頁內重整）就直接載入，否則顯示 token 輸入。
  // 桌面模式則等模型就緒（UI 不需要 token）。
  useEffect(() => {
    if (!bootstrapReady) return;
    if (desktop !== null) {
      void load();
      return;
    }
    if (getToken() !== null) void load();
  }, [bootstrapReady, desktop, load]);

  // 任何請求收到 401（例如 server 換了 token）→ apiFetch 派送全域事件，這裡切回貼 token 畫面。
  useEffect(() => {
    const onUnauthorized = (): void => {
      setSelectedRootId(null);
      if (desktop !== null) {
        setState({
          kind: "error",
          message: "本機服務拒絕了這次請求（401）。請按「重試」；若持續失敗，請重新啟動應用程式。",
        });
        return;
      }
      setState({ kind: "need-token", message: "token 不正確或已失效，請重新輸入。" });
    };
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, [desktop]);

  /**
   * 只刷新側欄的 roots 清單，**不**切到 `loading` 狀態。
   *
   * `load()` 會把畫面切成 loading 而卸載正在進行的「加入資料夾」流程（元件狀態遺失），
   * 因此流程中途需要刷新側欄時用這個版本；失敗時靜默（不是關鍵路徑，下一次 `load()` 會修正）。
   */
  const refreshRoots = useCallback(async (): Promise<void> => {
    try {
      const roots = await listRoots();
      setState((current) => (current.kind === "ready" ? { kind: "ready", roots } : current));
    } catch {
      // 靜默失敗（含 401：apiFetch 已派送事件讓 UI 回到貼 token 畫面）。
    }
  }, []);

  const submitToken = (token: string): void => {
    setToken(token);
    void load();
  };

  const forgetToken = (): void => {
    clearToken();
    setSelectedRootId(null);
    setState({ kind: "need-token", message: null });
  };

  const retryBootstrap = useCallback(async (): Promise<void> => {
    if (desktop === null) return;
    setBootstrapBusy(true);
    try {
      const current = await desktop.bootstrap.retry();
      if (current !== null) setBootstrap(current);
    } catch {
      // 失敗狀態本身就會由推播更新；這裡吞掉例外即可。
    } finally {
      setBootstrapBusy(false);
    }
  }, [desktop]);

  const toggleAutostart = useCallback(
    async (enabled: boolean): Promise<void> => {
      if (desktop === null) return;
      setSettingsBusy(true);
      setSettingsError(null);
      try {
        setSettings(await desktop.settings.setAutostart(enabled));
      } catch (error) {
        setSettingsError(error instanceof Error ? error.message : "設定開機自啟失敗");
      } finally {
        setSettingsBusy(false);
      }
    },
    [desktop],
  );

  const onRootAdded = (root: Root): void => {
    setSelectedRootId(root.id);
    setView("explorer");
    setMode("explorer");
    setRefreshKey((current) => current + 1);
    void load();
  };

  const onRemoveRoot = async (root: Root): Promise<void> => {
    const confirmed = window.confirm(
      `要移除資料夾「${root.path}」嗎？\n移除後索引資料會一併刪除，但磁碟上的檔案不會被更動。`,
    );
    if (!confirmed) return;
    try {
      await removeRoot(root.id, true);
      if (selectedRootId === root.id) setSelectedRootId(null);
      await load();
    } catch (error) {
      setState({ kind: "error", message: error instanceof Error ? error.message : "移除資料夾失敗" });
    }
  };

  const selectedRoot =
    state.kind === "ready"
      ? (state.roots.find((root) => root.id === selectedRootId) ?? state.roots[0] ?? null)
      : null;

  /** 模型下載失敗且使用者選擇先進入應用時，在主畫面提醒（可重試）。 */
  const bootstrapFailed = desktop !== null && bootstrap !== null && bootstrap.phase === "failed";

  return (
    <div className="flex min-h-full flex-col bg-surface text-ink">
      {desktop !== null && !bootstrapReady && (
        <BootstrapScreen
          state={bootstrap}
          token={settings?.token ?? null}
          busy={bootstrapBusy}
          onRetry={() => void retryBootstrap()}
          onSkip={() => setBootstrapSkipped(true)}
        />
      )}

      {bootstrapReady && state.kind === "need-token" && <TokenForm message={state.message} onSubmit={submitToken} />}

      {bootstrapReady && state.kind === "loading" && (
        <div className="flex flex-1 items-center justify-center text-sm text-muted">正在連線到本機服務…</div>
      )}

      {bootstrapReady && state.kind === "error" && (
        <div className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center gap-4 px-6 text-center">
          <p role="alert" className="text-sm text-red-600">
            {state.message}
          </p>
          <div className="flex justify-center gap-2">
            <button
              type="button"
              onClick={() => void load()}
              className="rounded-md bg-ink px-3 py-2 text-sm font-medium text-white"
            >
              重試
            </button>
            {desktop === null && (
              <button
                type="button"
                onClick={forgetToken}
                className="rounded-md border border-line px-3 py-2 text-sm font-medium text-ink"
              >
                重新輸入 token
              </button>
            )}
          </div>
        </div>
      )}

      {bootstrapReady && state.kind === "ready" && (
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 py-8">
          <header className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h1 className="text-xl font-semibold text-ink">Mnemoshelf</h1>
              <p className="text-xs text-muted">已連線到本機服務（127.0.0.1）</p>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <nav
                aria-label="主要檢視"
                className="inline-flex overflow-hidden rounded-md border border-line"
              >
                {(["explorer", "search", "memories"] as const).map((item) => (
                  <button
                    key={item}
                    type="button"
                    aria-current={view === item ? "page" : undefined}
                    onClick={() => {
                      setView(item);
                      if (item === "explorer") setMode("explorer");
                    }}
                    className={`px-3 py-1.5 text-sm font-medium ${
                      view === item ? "bg-ink text-white" : "bg-white text-ink"
                    }`}
                  >
                    {NAV_LABEL[item]}
                  </button>
                ))}
              </nav>
              {desktop !== null && (
                <button
                  type="button"
                  onClick={() => setShowSettings((current) => !current)}
                  className="rounded-md border border-line px-3 py-1.5 text-sm text-ink"
                >
                  設定
                </button>
              )}
              {desktop === null && (
                <button
                  type="button"
                  onClick={forgetToken}
                  className="rounded-md border border-line px-3 py-1.5 text-sm text-ink"
                >
                  登出
                </button>
              )}
            </div>
          </header>

          {bootstrapFailed && (
            <div role="status" className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-line bg-white px-3 py-2">
              <p className="text-xs text-muted">
                模型尚未下載完成：建立索引時會再試一次。{bootstrap?.lastError !== null && bootstrap?.lastError !== undefined ? `（${bootstrap.lastError.message}）` : ""}
              </p>
              <button
                type="button"
                onClick={() => void retryBootstrap()}
                disabled={bootstrapBusy}
                className="rounded-md border border-line px-2.5 py-1 text-xs text-ink disabled:opacity-40"
              >
                {bootstrapBusy ? "重試中…" : "重試下載"}
              </button>
            </div>
          )}

          {desktop !== null && showSettings && (
            <SettingsPanel
              settings={settings}
              error={settingsError}
              busy={settingsBusy}
              onToggleAutostart={(enabled) => void toggleAutostart(enabled)}
              onClose={() => setShowSettings(false)}
            />
          )}

          {view === "explorer" && (
            <div className="grid gap-6 lg:grid-cols-[300px_minmax(0,1fr)]">
              <aside className="space-y-3">
                <div className="flex items-center justify-between">
                  <h2 className="text-base font-medium text-ink">
                    資料夾<span className="ml-1 text-xs text-muted">（{state.roots.length}）</span>
                  </h2>
                  <button
                    type="button"
                    onClick={() => setMode("add-root")}
                    className="rounded-md bg-ink px-2.5 py-1 text-xs font-medium text-white"
                  >
                    加入
                  </button>
                </div>
                <RootsList
                  roots={state.roots}
                  selectedRootId={selectedRoot?.id ?? null}
                  onSelect={(root) => {
                    setSelectedRootId(root.id);
                    setMode("explorer");
                  }}
                  onRemove={(root) => void onRemoveRoot(root)}
                />
              </aside>

              <main className="min-w-0">
                {mode === "add-root" ? (
                  <AddRootFlow
                    onCancel={() => {
                      setMode("explorer");
                      // 取消時可能已移除剛加入的 root：刷新側欄避免留下過期項目。
                      void refreshRoots();
                    }}
                    onDone={onRootAdded}
                    onRootCreated={(root) => {
                      // 加入成功後立即把 root 定入流程狀態並刷新側欄（不切 loading，流程不中斷）。
                      setSelectedRootId(root.id);
                      void refreshRoots();
                    }}
                  />
                ) : selectedRoot === null ? (
                  <div className="flex h-[60vh] items-center justify-center rounded-lg border border-dashed border-line bg-white/60 px-6 text-center">
                    <p className="text-sm text-muted">請先加入一個資料夾。</p>
                  </div>
                ) : (
                  <ExplorerPanel key={selectedRoot.id} root={selectedRoot} refreshKey={refreshKey} />
                )}
              </main>
            </div>
          )}

          {view === "search" && <SearchPanel roots={state.roots} onOpenMemories={() => setView("memories")} />}

          {view === "memories" && <MemoriesPanel />}
        </div>
      )}
    </div>
  );
}
