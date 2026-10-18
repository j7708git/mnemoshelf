/**
 * 記憶管理畫面：列表（釘選標示、釘選優先排序）、釘選／取消、編輯（走 supersedes 語意——
 * 產生新版本並取代舊版）、刪除（需確認）、看來源，以及專案／範圍篩選與共享開關。
 *
 * 記憶由 AI agent 透過 `remember` 寫入，這個畫面是管理面：不直接改動既有列，
 * 「編輯」一律建立新版本並把舊版標記軟刪除（`POST /memories` 帶 `supersedes`）。
 * 共享開關只允許 `project` ↔ `global`（`PATCH /memories/:id`）；`agent` 範圍在本版唯讀。
 */
import { useCallback, useEffect, useState } from "react";
import {
  addMemory,
  deleteMemory,
  listMemories,
  pinMemory,
  updateMemory,
  type Memory,
  type MemoryScope,
} from "./api";
import { formatDateTime, MEMORY_KIND_LABEL, MEMORY_SCOPE_LABEL } from "./format";

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; memories: Memory[] }
  | { kind: "error"; message: string };

/** 篩選值：`"all"` 表示不過濾。 */
type ScopeFilter = MemoryScope | "all";
const ALL_PROJECTS = "all";

/** 釘選者優先，其次依 createdAt 由新到舊（伺服器已給新到舊，這裡穩定排序）。 */
function sortMemories(memories: Memory[]): Memory[] {
  return [...memories].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return Date.parse(b.createdAt) - Date.parse(a.createdAt);
  });
}

/** 清單中出現過的專案名稱（去重、排序；供篩選與「改回專案」的目標選單使用）。 */
function collectProjectNames(memories: Memory[]): string[] {
  return [...new Set(memories.map((memory) => memory.project).filter((project): project is string => project !== null))].sort(
    (a, b) => a.localeCompare(b),
  );
}

export function MemoriesPanel() {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [editingId, setEditingId] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [sourceId, setSourceId] = useState<number | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  /** 範圍篩選（`all`＝全部）。 */
  const [scopeFilter, setScopeFilter] = useState<ScopeFilter>("all");
  /** 專案篩選（`all`＝全部專案；其餘為專案名稱）。 */
  const [projectFilter, setProjectFilter] = useState<string>(ALL_PROJECTS);
  /** 每筆「改回專案」目前選定的目標專案（未選時用清單第一個可選專案）。 */
  const [shareTargets, setShareTargets] = useState<Record<number, string>>({});

  /** 清單中出現過的專案名稱（供篩選與共享開關的目標選單）。 */
  const availableProjects = state.kind === "ready" ? collectProjectNames(state.memories) : [];

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

  /** 共享開關：專案記憶 → 全域共享（`PATCH {scope:"global"}`）。 */
  const shareGlobally = (memory: Memory): void => {
    void run(
      memory.id,
      async () => {
        await updateMemory(memory.id, { scope: "global" });
      },
      "已設為全域共享。",
    );
  };

  /**
   * 共享開關：全域記憶 → 改回專案（`PATCH {scope:"project", project}`）。
   *
   * 目標專案以清單中出現過的專案名為選項；沒有可選專案時按鈕會停用，這裡再擋一次並提示。
   */
  const moveToProject = (memory: Memory): void => {
    const target = shareTargets[memory.id] ?? availableProjects[0];
    if (target === undefined) {
      setActionError("目前清單沒有可選的專案名稱，無法把這筆記憶改回專案範圍。");
      return;
    }
    void run(
      memory.id,
      async () => {
        await updateMemory(memory.id, { scope: "project", project: target });
      },
      `已改回專案「${target}」。`,
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

  // 篩選一律在前端做（清單已是 `GET /memories` 的完整結果；不另外打伺服器、行為與畫面一致）。
  const filteredMemories = state.memories.filter(
    (memory) =>
      (scopeFilter === "all" || memory.scope === scopeFilter) &&
      (projectFilter === ALL_PROJECTS || memory.project === projectFilter),
  );

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h2 className="text-base font-medium text-ink">
            記憶管理
            <span className="ml-1 text-xs text-muted">
              （
              {filteredMemories.length === state.memories.length
                ? state.memories.length
                : `${filteredMemories.length} / ${state.memories.length}`}
              ）
            </span>
          </h2>
          <p className="mt-0.5 text-xs text-muted">
            釘選的記憶會優先顯示；編輯會產生新版本並取代舊版。共享開關只在專案與全域之間切換，agent 範圍為唯讀。
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          className="rounded-md border border-line px-3 py-1.5 text-sm text-ink"
        >
          重新載入
        </button>
      </div>

      {state.memories.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 text-xs text-muted">
          <label className="flex items-center gap-1.5">
            專案
            <select
              aria-label="依專案篩選"
              value={projectFilter}
              onChange={(event) => setProjectFilter(event.target.value)}
              className="rounded-md border border-line bg-white px-2 py-1 text-xs text-ink"
            >
              <option value={ALL_PROJECTS}>全部專案</option>
              {availableProjects.map((project) => (
                <option key={project} value={project}>
                  {project}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1.5">
            範圍
            <select
              aria-label="依範圍篩選"
              value={scopeFilter}
              onChange={(event) => setScopeFilter(event.target.value as ScopeFilter)}
              className="rounded-md border border-line bg-white px-2 py-1 text-xs text-ink"
            >
              <option value="all">全部範圍</option>
              <option value="global">全域</option>
              <option value="project">專案</option>
              <option value="agent">agent</option>
            </select>
          </label>
          {(scopeFilter !== "all" || projectFilter !== ALL_PROJECTS) && (
            <button
              type="button"
              onClick={() => {
                setScopeFilter("all");
                setProjectFilter(ALL_PROJECTS);
              }}
              className="rounded-md border border-line px-2 py-1 text-xs text-ink"
            >
              清除篩選
            </button>
          )}
        </div>
      )}

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
      ) : filteredMemories.length === 0 ? (
        <div className="flex h-[30vh] items-center justify-center rounded-lg border border-dashed border-line bg-white/60 px-6 text-center text-sm text-muted">
          沒有符合目前篩選條件的記憶。
        </div>
      ) : (
        <ul className="space-y-3">
          {filteredMemories.map((memory) => {
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
                  </span>
                  <span className="rounded bg-surface px-1.5 py-0.5 text-[11px] text-muted">
                    專案 {memory.project ?? "全域"}
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
                  {memory.scope === "agent" ? (
                    <span className="rounded-md border border-line px-2.5 py-1 text-xs text-muted">
                      agent 範圍（唯讀）
                    </span>
                  ) : memory.scope === "project" ? (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => shareGlobally(memory)}
                      className="rounded-md border border-line px-2.5 py-1 text-xs text-ink disabled:opacity-40"
                    >
                      設為全域共享
                    </button>
                  ) : (
                    <>
                      <select
                        aria-label={`選擇要改回的專案（記憶 #${memory.id}）`}
                        value={shareTargets[memory.id] ?? availableProjects[0] ?? ""}
                        onChange={(event) =>
                          setShareTargets((previous) => ({ ...previous, [memory.id]: event.target.value }))
                        }
                        disabled={busy || availableProjects.length === 0}
                        className="rounded-md border border-line bg-white px-2 py-1 text-xs text-ink disabled:opacity-40"
                      >
                        {availableProjects.length === 0 ? (
                          <option value="">沒有可選專案</option>
                        ) : (
                          availableProjects.map((project) => (
                            <option key={project} value={project}>
                              {project}
                            </option>
                          ))
                        )}
                      </select>
                      <button
                        type="button"
                        disabled={busy || availableProjects.length === 0}
                        onClick={() => moveToProject(memory)}
                        className="rounded-md border border-line px-2.5 py-1 text-xs text-ink disabled:opacity-40"
                      >
                        改回專案
                      </button>
                    </>
                  )}
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
