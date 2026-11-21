import { useEffect, useState } from "react";
import {
  getMemoryAutoInjectSettings,
  MemoryAutoInjectUnavailableError,
  MemoryRecallConflictError,
  updateMemoryAutoInjectSettings,
  type AutoInjectMode,
  type MemoryAutoInjectPatch,
  type MemoryAutoInjectSettings,
} from "./api";

export const AUTO_INJECT_MODE_LABEL: Record<AutoInjectMode, string> = {
  all: "精煉優先＋原文補位",
  "refined-only": "僅自動注入精煉記憶",
  off: "停用自動注入",
};

const AUTO_INJECT_MODES: readonly AutoInjectMode[] = ["all", "refined-only", "off"];
const fieldClass = "w-full min-w-0 rounded-lg border border-line bg-bg px-3 py-2 text-sm text-ink";

/** 專案級與全域自動注入控制面板（僅影響自動帶入背景，不影響 MCP 主動搜尋）。 */
export function MemoryAutoInjectPanel({ projects, revision }: { projects: string[]; revision: number }) {
  const [settings, setSettings] = useState<MemoryAutoInjectSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [projectInput, setProjectInput] = useState("");
  const [projectMode, setProjectMode] = useState<AutoInjectMode>("all");
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const abort = new AbortController();
    setLoading(true);
    setUnavailable(false);

    void Promise.resolve(getMemoryAutoInjectSettings(abort.signal))
      .then((value) => {
        if (abort.signal.aborted) return;
        if (value === undefined) {
          setSettings(null);
          setUnavailable(true);
          setLoading(false);
          return;
        }
        setSettings(value);
        setLoading(false);
      })
      .catch((reason: unknown) => {
        if (abort.signal.aborted) return;
        setLoading(false);
        if (reason instanceof MemoryAutoInjectUnavailableError) {
          setSettings(null);
          setUnavailable(true);
          setError(null);
          return;
        }
        setError(reason instanceof Error ? reason.message : "讀取自動注入設定失敗。");
      });

    return () => {
      abort.abort();
    };
  }, [revision, reload]);

  const applyPatch = async (patch: MemoryAutoInjectPatch, successMessage: string): Promise<boolean> => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const updated = await updateMemoryAutoInjectSettings(patch);
      setSettings(updated);
      setMessage(successMessage);
      return true;
    } catch (reason: unknown) {
      if (reason instanceof MemoryAutoInjectUnavailableError) {
        setSettings(null);
        setUnavailable(true);
        setError(null);
        return false;
      }
      setError(reason instanceof Error ? reason.message : "更新自動注入設定失敗。");
      if (reason instanceof MemoryRecallConflictError) {
        setReload((value) => value + 1);
      }
      return false;
    } finally {
      setBusy(false);
    }
  };

  const changeDefaultMode = async (defaultMode: AutoInjectMode) => {
    if (settings === null || busy || loading) return;
    await applyPatch(
      { expectedRevision: settings.revision, defaultMode },
      `已更新全域預設模式為「${AUTO_INJECT_MODE_LABEL[defaultMode]}」。`,
    );
  };

  const applyProjectOverride = async () => {
    if (settings === null || busy || loading) return;
    const project = projectInput.trim();
    if (project === "") {
      setError("請輸入要設定覆寫的專案名稱。");
      setMessage(null);
      return;
    }
    if (project.includes("\0")) {
      setError("專案名稱不可包含空字元。");
      setMessage(null);
      return;
    }
    const ok = await applyPatch(
      { expectedRevision: settings.revision, projects: { [project]: projectMode } },
      `已將專案「${project}」設為「${AUTO_INJECT_MODE_LABEL[projectMode]}」。`,
    );
    if (ok) {
      setProjectInput("");
    }
  };

  const changeProjectOverride = async (project: string, mode: AutoInjectMode) => {
    if (settings === null || busy || loading) return;
    await applyPatch(
      { expectedRevision: settings.revision, projects: { [project]: mode } },
      `已將專案「${project}」設為「${AUTO_INJECT_MODE_LABEL[mode]}」。`,
    );
  };

  const resetProjectOverride = async (project: string) => {
    if (settings === null || busy || loading) return;
    await applyPatch(
      { expectedRevision: settings.revision, projects: { [project]: null } },
      `已將專案「${project}」回復沿用全域預設模式。`,
    );
  };

  const projectSuggestions = Array.from(new Set(projects));
  const overrideEntries = settings === null
    ? []
    : Object.entries(settings.projects).sort(([a], [b]) => a.localeCompare(b));

  return (
    <section className="space-y-4 rounded-2xl border border-line bg-surface p-4" aria-label="自動注入設定">
      <div className="space-y-1">
        <h3 className="text-sm font-medium text-ink">自動注入設定（不影響 MCP 主動搜尋）</h3>
        <p className="text-xs leading-relaxed text-muted">
          停用自動注入只關閉 Hook／外掛自動帶入對話背景，Agent 仍可透過 MCP search_memories／recall 主動搜尋記憶；這與上方的「召回用途＝停用（完全排除召回）」不同。
        </p>
      </div>

      {loading && settings === null && !unavailable && (
        <p role="status" className="text-xs text-muted">正在載入自動注入設定…</p>
      )}

      {unavailable && (
        <p role="status" className="rounded-lg bg-raised p-3 text-xs text-muted">
          本機服務尚未支援自動注入設定（HTTP 404）；升級服務後即可設定全域預設與專案覆寫。
        </p>
      )}

      {settings !== null && !unavailable && (
        <fieldset disabled={busy || loading} className="space-y-4 disabled:opacity-60">
          <div className="space-y-1">
            <label className="block space-y-1 text-xs text-muted">
              <span>全域預設模式</span>
              <select
                aria-label="全域預設自動注入模式"
                value={settings.defaultMode}
                onChange={(event) => void changeDefaultMode(event.target.value as AutoInjectMode)}
                className={fieldClass}
              >
                {AUTO_INJECT_MODES.map((mode) => (
                  <option key={mode} value={mode}>{AUTO_INJECT_MODE_LABEL[mode]}</option>
                ))}
              </select>
            </label>
          </div>

          <div className="space-y-3 border-t border-line pt-4">
            <h4 className="text-xs font-medium text-ink">新增或更新專案覆寫</h4>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void applyProjectOverride();
              }}
              className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end"
            >
              <label className="block space-y-1 text-xs text-muted">
                <span>專案名稱</span>
                <input
                  aria-label="自動注入專案名稱"
                  list="memory-auto-inject-projects"
                  maxLength={200}
                  value={projectInput}
                  placeholder="專案名稱"
                  onChange={(event) => {
                    setError(null);
                    setMessage(null);
                    setProjectInput(event.target.value);
                  }}
                  className={fieldClass}
                />
                <datalist id="memory-auto-inject-projects">
                  {projectSuggestions.map((project) => <option key={project} value={project} />)}
                </datalist>
              </label>

              <label className="block space-y-1 text-xs text-muted">
                <span>專案注入模式</span>
                <select
                  aria-label="專案自動注入模式"
                  value={projectMode}
                  onChange={(event) => {
                    setError(null);
                    setMessage(null);
                    setProjectMode(event.target.value as AutoInjectMode);
                  }}
                  className={fieldClass}
                >
                  {AUTO_INJECT_MODES.map((mode) => (
                    <option key={mode} value={mode}>{AUTO_INJECT_MODE_LABEL[mode]}</option>
                  ))}
                </select>
              </label>

              <button
                type="submit"
                disabled={busy || loading}
                className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-on-brand disabled:opacity-40"
              >
                套用專案設定
              </button>
            </form>
          </div>

          <div className="space-y-2 border-t border-line pt-4">
            <h4 className="text-xs font-medium text-ink">已設定專案覆寫</h4>
            {overrideEntries.length === 0 ? (
              <p className="rounded-lg bg-raised p-3 text-xs text-muted">
                尚未設定專案覆寫；所有專案目前皆沿用全域預設模式。
              </p>
            ) : (
              <div className="space-y-2">
                {overrideEntries.map(([project, mode]) => (
                  <div
                    key={project}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line bg-bg p-3"
                  >
                    <span className="min-w-0 break-all text-xs font-medium text-ink">{project}</span>
                    <div className="flex flex-wrap items-center gap-2">
                      <select
                        aria-label={`專案 ${project} 自動注入模式`}
                        value={mode}
                        onChange={(event) => void changeProjectOverride(project, event.target.value as AutoInjectMode)}
                        className="rounded-lg border border-line bg-surface px-2.5 py-1.5 text-xs text-ink"
                      >
                        {AUTO_INJECT_MODES.map((itemMode) => (
                          <option key={itemMode} value={itemMode}>{AUTO_INJECT_MODE_LABEL[itemMode]}</option>
                        ))}
                      </select>
                      <button
                        type="button"
                        aria-label={`回復預設（${project}）`}
                        onClick={() => void resetProjectOverride(project)}
                        className="rounded-lg border border-line bg-surface px-2.5 py-1.5 text-xs text-ink hover:bg-raised disabled:opacity-40"
                      >
                        回復預設
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </fieldset>
      )}

      {error !== null && (
        <div className="space-y-2">
          <p role="alert" className="text-xs text-danger">{error}</p>
          <button
            type="button"
            onClick={() => {
              setError(null);
              setReload((value) => value + 1);
            }}
            className="text-xs text-brand"
          >
            重新載入設定
          </button>
        </div>
      )}

      {message !== null && <p role="status" className="text-xs text-ink">{message}</p>}
    </section>
  );
}
