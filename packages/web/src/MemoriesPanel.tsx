/**
 * 記憶管理畫面：列表（釘選標示、釘選優先排序）、釘選／取消、編輯（走 supersedes 語意——
 * 產生新版本並取代舊版）、刪除（需確認）、看來源。
 *
 * 記憶由 AI agent 透過 `remember` 寫入，這個畫面是管理面：不直接改動既有列，
 * 「編輯」一律建立新版本並把舊版標記軟刪除（`POST /memories` 帶 `supersedes`）。
 */
import { useCallback, useEffect, useState } from "react";
import { addMemory, deleteMemory, listMemories, pinMemory, type Memory } from "./api";
import { formatDateTime, MEMORY_KIND_LABEL, MEMORY_SCOPE_LABEL } from "./format";

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; memories: Memory[] }
  | { kind: "error"; message: string };

/** 釘選者優先，其次依 createdAt 由新到舊（伺服器已給新到舊，這裡穩定排序）。 */
function sortMemories(memories: Memory[]): Memory[] {
  return [...memories].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return Date.parse(b.createdAt) - Date.parse(a.createdAt);
  });
}

export function MemoriesPanel() {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [editingId, setEditingId] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [sourceId, setSourceId] = useState<number | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setState({ kind: "loading" });
    try {
      setState({ kind: "ready", memories: sortMemories(await listMemories()) });
    } catch (error) {
      setState({ kind: "error", message: error instanceof Error ? error.message : "讀取記憶清單失敗。" });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (id: number, action: () => Promise<void>, success: string): Promise<void> => {
    setBusyId(id);
    setActionError(null);
    setMessage(null);
    try {
      await action();
      setMessage(success);
      await load();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "操作失敗。");
    } finally {
      setBusyId(null);
    }
  };

  const togglePin = (memory: Memory): void => {
    void run(
      memory.id,
      async () => {
        await pinMemory(memory.id, !memory.pinned);
      },
      memory.pinned ? "已取消釘選。" : "已釘選。",
    );
  };

  const startEdit = (memory: Memory): void => {
    setEditingId(memory.id);
    setDraft(memory.content);
    setSourceId(null);
    setMessage(null);
    setActionError(null);
  };

  const saveEdit = async (memory: Memory): Promise<void> => {
    if (draft.trim() === "") {
      setActionError("記憶內容不得為空。");
      return;
    }
    setBusyId(memory.id);
    setActionError(null);
    setMessage(null);
    try {
      // supersedes 語意：建立新版本、舊版被標記取代（不再列出）。
      await addMemory({
        content: draft.trim(),
        agent: memory.agent,
        kind: memory.kind,
        scope: memory.scope,
        project: memory.project,
        supersedes: memory.id,
      });
      setMessage(`已更新：新版本已建立並取代舊版（#${memory.id}）。`);
      setEditingId(null);
      setDraft("");
      await load();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "儲存記憶失敗。");
    } finally {
      setBusyId(null);
    }
  };

  const remove = (memory: Memory): void => {
    const confirmed = window.confirm(
      `要刪除這筆記憶嗎？\n\n「${memory.content.slice(0, 80)}」\n\n刪除後搜尋不到，資料仍保留在資料庫（軟刪除）。`,
    );
    if (!confirmed) return;
    void run(
      memory.id,
      async () => {
        await deleteMemory(memory.id);
      },
      "已刪除記憶。",
    );
  };

  if (state.kind === "loading") {
    return <p className="text-sm text-muted">正在載入記憶清單…</p>;
  }
  if (state.kind === "error") {
    return (
      <div className="space-y-3">
        <p role="alert" className="rounded-lg border border-line bg-white px-4 py-3 text-sm text-red-600">
          {state.message}
        </p>
        <button
          type="button"
          onClick={() => void load()}
          className="rounded-md border border-line px-3 py-1.5 text-sm text-ink"
        >
          重試
        </button>
      </div>
    );
  }

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h2 className="text-base font-medium text-ink">
            記憶管理<span className="ml-1 text-xs text-muted">（{state.memories.length}）</span>
          </h2>
          <p className="mt-0.5 text-xs text-muted">釘選的記憶會優先顯示；編輯會產生新版本並取代舊版。</p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          className="rounded-md border border-line px-3 py-1.5 text-sm text-ink"
        >
          重新載入
        </button>
      </div>

      {message !== null && (
        <p className="rounded-lg border border-line bg-white px-4 py-2 text-sm text-ink">{message}</p>
      )}
      {actionError !== null && (
        <p role="alert" className="rounded-lg border border-line bg-white px-4 py-2 text-sm text-red-600">
          {actionError}
        </p>
      )}

      {state.memories.length === 0 ? (
        <div className="flex h-[40vh] items-center justify-center rounded-lg border border-dashed border-line bg-white/60 px-6 text-center text-sm text-muted">
          尚無記憶。AI agent 透過 remember 寫入的共享記憶會出現在這裡。
        </div>
      ) : (
        <ul className="space-y-3">
          {state.memories.map((memory) => {
            const editing = editingId === memory.id;
            const showSource = sourceId === memory.id;
            const busy = busyId === memory.id;
            return (
              <li
                key={memory.id}
                className={`rounded-lg border px-4 py-3 ${
                  memory.pinned ? "border-ink bg-white" : "border-line bg-white/70"
                }`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  {memory.pinned && (
                    <span className="rounded bg-ink px-1.5 py-0.5 text-[11px] font-medium text-white">已釘選</span>
                  )}
                  <span className="rounded bg-surface px-1.5 py-0.5 text-[11px] text-muted">
                    {MEMORY_KIND_LABEL[memory.kind]}
                  </span>
                  <span className="rounded bg-surface px-1.5 py-0.5 text-[11px] text-muted">
                    範圍 {MEMORY_SCOPE_LABEL[memory.scope]}
                    {memory.project === null ? "" : `：${memory.project}`}
                  </span>
                  <span className="text-[11px] text-muted">#{memory.id}</span>
                  <span className="ml-auto text-[11px] text-muted">{formatDateTime(memory.createdAt)}</span>
                </div>

                {editing ? (
                  <div className="mt-2 space-y-2">
                    <textarea
                      value={draft}
                      onChange={(event) => setDraft(event.target.value)}
                      rows={3}
                      aria-label="編輯記憶內容"
                      className="w-full rounded-md border border-line bg-white px-3 py-2 text-sm text-ink outline-none focus:border-ink"
                    />
                    <p className="text-[11px] text-muted">
                      儲存會建立新版本（agent／種類／範圍沿用）並把這一版標記為已取代。
                    </p>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void saveEdit(memory)}
                        className="rounded-md bg-ink px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40"
                      >
                        儲存新版本
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setEditingId(null);
                          setDraft("");
                        }}
                        className="rounded-md border border-line px-3 py-1.5 text-sm text-ink"
                      >
                        取消
                      </button>
                    </div>
                  </div>
                ) : (
                  <p className="mt-2 whitespace-pre-wrap break-words text-sm text-ink">{memory.content}</p>
                )}

                <div className="mt-2 flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => togglePin(memory)}
                    className="rounded-md border border-line px-2.5 py-1 text-xs text-ink disabled:opacity-40"
                  >
                    {memory.pinned ? "取消釘選" : "釘選"}
                  </button>
                  {!editing && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => startEdit(memory)}
                      className="rounded-md border border-line px-2.5 py-1 text-xs text-ink disabled:opacity-40"
                    >
                      編輯
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setSourceId(showSource ? null : memory.id)}
                    className="rounded-md border border-line px-2.5 py-1 text-xs text-ink"
                  >
                    {showSource ? "收起來源" : "看來源"}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => remove(memory)}
                    className="rounded-md border border-line px-2.5 py-1 text-xs text-muted hover:text-red-600 disabled:opacity-40"
                  >
                    刪除
                  </button>
                </div>

                {showSource && (
                  <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-md bg-surface px-3 py-2 text-xs text-muted">
                    <dt>寫入者</dt>
                    <dd className="break-all text-ink">{memory.agent}</dd>
                    <dt>種類</dt>
                    <dd className="text-ink">{MEMORY_KIND_LABEL[memory.kind]}</dd>
                    <dt>範圍</dt>
                    <dd className="text-ink">
                      {MEMORY_SCOPE_LABEL[memory.scope]}
                      {memory.project === null ? "" : `（${memory.project}）`}
                    </dd>
                    <dt>取代</dt>
                    <dd className="text-ink">{memory.supersedes === null ? "—" : `#${memory.supersedes}`}</dd>
                    <dt>建立時間</dt>
                    <dd className="text-ink">{formatDateTime(memory.createdAt)}</dd>
                  </dl>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
