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
import { ExplorerPanel } from "./ExplorerPanel";
import { MemoriesPanel } from "./MemoriesPanel";
import { RootsList } from "./RootsList";
import { SearchPanel } from "./SearchPanel";
import { TokenForm } from "./TokenForm";

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
 * 本卡範圍：統一搜尋畫面（模式選擇器，預設 hybrid）與記憶管理（列表、釘選、編輯、刪除、來源）。
 */
export function App() {
  const [state, setState] = useState<ViewState>(() =>
    getToken() === null ? { kind: "need-token", message: null } : { kind: "loading" },
  );
  const [selectedRootId, setSelectedRootId] = useState<number | null>(null);
  const [view, setView] = useState<View>("explorer");
  const [mode, setMode] = useState<"explorer" | "add-root">("explorer");
  /** 遞增以強制目錄樹與狀態重新載入。 */
  const [refreshKey, setRefreshKey] = useState(0);

  const load = useCallback(async (): Promise<void> => {
    setState({ kind: "loading" });
    try {
      const roots = await listRoots();
      setState({ kind: "ready", roots });
    } catch (error) {
      if (error instanceof UnauthorizedApiError) {
        setState({ kind: "need-token", message: "token 不正確或已失效，請重新輸入。" });
        return;
      }
      if (error instanceof NetworkError) {
        setState({ kind: "error", message: error.message });
        return;
      }
      setState({ kind: "error", message: error instanceof Error ? error.message : "發生未知的錯誤。" });
    }
  }, []);

  // 掛載時若已有 token（同一分頁內重整）就直接載入，否則顯示 token 輸入。
  useEffect(() => {
    if (getToken() !== null) void load();
  }, [load]);

  // 任何請求收到 401（例如 server 換了 token）→ apiFetch 派送全域事件，這裡切回貼 token 畫面。
  useEffect(() => {
    const onUnauthorized = (): void => {
      setSelectedRootId(null);
      setState({ kind: "need-token", message: "token 不正確或已失效，請重新輸入。" });
    };
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, []);

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

  return (
    <div className="flex min-h-full flex-col bg-surface text-ink">
      {state.kind === "need-token" && <TokenForm message={state.message} onSubmit={submitToken} />}

      {state.kind === "loading" && (
        <div className="flex flex-1 items-center justify-center text-sm text-muted">正在連線到本機服務…</div>
      )}

      {state.kind === "error" && (
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
            <button
              type="button"
              onClick={forgetToken}
              className="rounded-md border border-line px-3 py-2 text-sm font-medium text-ink"
            >
              重新輸入 token
            </button>
          </div>
        </div>
      )}

      {state.kind === "ready" && (
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
              <button
                type="button"
                onClick={forgetToken}
                className="rounded-md border border-line px-3 py-1.5 text-sm text-ink"
              >
                登出
              </button>
            </div>
          </header>

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
