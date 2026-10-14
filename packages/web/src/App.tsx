import { useCallback, useEffect, useState } from "react";
import {
  clearToken,
  getToken,
  listRoots,
  NetworkError,
  setToken,
  UnauthorizedApiError,
  type Root,
} from "./api";
import { RootsList } from "./RootsList";
import { TokenForm } from "./TokenForm";

/** 畫面的四種狀態。 */
type ViewState =
  | { kind: "need-token"; message: string | null }
  | { kind: "loading" }
  | { kind: "ready"; roots: Root[] }
  | { kind: "error"; message: string };

/**
 * 應用根元件：先確認 token，再顯示 roots 清單。
 *
 * 本卡範圍只有：token 輸入、連線狀態、roots 列表。其餘畫面留白，不做假的按鈕。
 */
export function App() {
  const [state, setState] = useState<ViewState>(() =>
    getToken() === null ? { kind: "need-token", message: null } : { kind: "loading" },
  );

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

  const submitToken = (token: string): void => {
    setToken(token);
    void load();
  };

  const forgetToken = (): void => {
    clearToken();
    setState({ kind: "need-token", message: null });
  };

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
        <div className="mx-auto flex max-w-3xl flex-col gap-6 px-6 py-8">
          <header className="flex items-center justify-between gap-3">
            <div>
              <h1 className="text-xl font-semibold text-ink">Mnemoshelf</h1>
              <p className="text-xs text-muted">已連線到本機服務（127.0.0.1）</p>
            </div>
            <button
              type="button"
              onClick={forgetToken}
              className="rounded-md border border-line px-3 py-1.5 text-sm text-ink"
            >
              登出
            </button>
          </header>

          <section className="space-y-3">
            <div className="flex items-baseline justify-between">
              <h2 className="text-base font-medium text-ink">已加入的資料夾</h2>
              <span className="text-xs text-muted">共 {state.roots.length} 個</span>
            </div>
            <RootsList roots={state.roots} />
          </section>
        </div>
      )}
    </div>
  );
}
