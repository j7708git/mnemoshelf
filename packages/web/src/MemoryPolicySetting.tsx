import type { MemoryPolicy } from "./api";

export type MemoryPolicyState =
  | { kind: "loading" }
  | { kind: "unavailable" | "error"; message: string }
  | { kind: "ready" | "saving"; value: MemoryPolicy; error: string | null };

export function MemoryPolicySetting({
  state,
  onChange,
  onRetry,
}: {
  state: MemoryPolicyState;
  onChange: (enabled: boolean) => void;
  onRetry: () => void;
}) {
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium text-ink">記憶隱私</h3>
      <label className="flex items-center gap-2 text-sm text-ink">
        {(state.kind === "ready" || state.kind === "saving") && (
          <input
            id="mnemoshelf-memory-policy"
            type="checkbox"
            checked={state.value.maskSecrets}
            disabled={state.kind === "saving"}
            aria-describedby="mnemoshelf-memory-policy-detail"
            onChange={(event) => onChange(event.target.checked)}
            className="h-4 w-4"
          />
        )}
        自動遮罩記憶中的機密
      </label>
      <p id="mnemoshelf-memory-policy-detail" className="text-xs text-muted">
        遮罩可辨識的密碼與 API key。關閉後，接入的 Agent 可能讀取這些內容。遮罩可能誤判或漏判。切換不改寫既有資料，也無法還原已遮罩的文字。
        此設定只影響記憶內容。檔案索引與中繼資料沿用原有規則。
      </p>
      {state.kind === "loading" && <p role="status" className="text-xs text-muted">讀取中…</p>}
      {state.kind === "saving" && <p role="status" className="text-xs text-muted">儲存中…</p>}
      {(state.kind === "unavailable" || state.kind === "error") && (
        <p role="alert" className="text-xs text-red-600">{state.message}</p>
      )}
      {state.kind === "error" && (
        <button type="button" onClick={onRetry} className="rounded-md border border-line px-2.5 py-1 text-xs text-ink">
          重新讀取
        </button>
      )}
      {state.kind === "ready" && state.error !== null && (
        <p role="alert" className="text-xs text-red-600">{state.error} 請再次切換以重試。</p>
      )}
    </div>
  );
}
