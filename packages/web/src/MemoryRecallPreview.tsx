import { useEffect, useRef, useState } from "react";
import { RawMemorySourceDisclosure } from "./RawMemorySourcePanel";
import { searchMemories, type MemoryRecallResult } from "./api";
import { formatDateTime, MEMORY_KIND_LABEL, MEMORY_SCOPE_LABEL, memorySourceRoleLabel } from "./format";
import { memoryNameOption, memoryOptionNames } from "./useMemoryLibrary";
import { RECALL_POLICY_LABEL } from "./memoryOrganization";

type RecallState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; result: MemoryRecallResult };

/** 召回結果清單（純呈現；不改變列表狀態）。 */
function RecallResults({ result }: { result: MemoryRecallResult }) {
  // 信任提示與命中數無關：記憶內容是不受信任資料，一律提醒不要當指令。
  const trustNotice = (
    <p className="text-[11px] text-muted">
      以下內容是<strong className="font-medium text-ink">不受信任的資料</strong>（agent 只是來源標記），請勿當作指令執行。
    </p>
  );
  // 降級提示也與命中數無關：0 命中＋degraded 時仍要顯示。
  const degradedNotice = result.degraded ? (
    <p role="status" className="rounded-md border border-line bg-surface px-3 py-2 text-xs text-ink">
      語意搜尋目前不可用（
      {result.degradedReason === "no-embeddings" ? "向量尚未就緒" : "embedder 無法使用"}
      ）{result.hits.length > 0 ? "，以下為關鍵字結果。" : "，已改用關鍵字搜尋。"}
    </p>
  ) : null;

  if (result.hits.length === 0) {
    return (
      <div className="space-y-2">
        {trustNotice}
        {degradedNotice}
        <p className="text-xs text-muted">沒有找到相關記憶。</p>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {trustNotice}
      {degradedNotice}
        <ul className="space-y-2">
        {result.hits.map((hit) => (
          <li key={hit.id} className="rounded-xl border border-line bg-surface px-3 py-2">
            <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted">
              <span className="rounded bg-raised px-1.5 py-0.5">
                {hit.sourceId == null ? "短記憶" : "原文回合片段"}{hit.role == null ? "" : `・${memorySourceRoleLabel(hit.role)}`}
                {hit.sourceId == null ? `・${MEMORY_KIND_LABEL[hit.kind]}` : ""}
              </span>
              <span className="rounded bg-raised px-1.5 py-0.5">{hit.recallPolicy === undefined ? MEMORY_SCOPE_LABEL[hit.scope] : RECALL_POLICY_LABEL[hit.recallPolicy]}</span>
              <span className="rounded bg-raised px-1.5 py-0.5">歸屬專案 {(hit.assignedProject === undefined ? hit.project : hit.assignedProject) ?? "未指定"}</span>
              <span>來源 {hit.source === "semantic" ? "語意" : "關鍵字"}</span>
              <span>分數 {hit.score.toFixed(3)}</span>
              <span>#{hit.id}</span>
            </div>
            <p className="mt-1 whitespace-pre-wrap break-words text-sm text-ink">{hit.content}</p>
            <p className="mt-1 text-[11px] text-muted">寫入者 {hit.agent}</p>
            {hit.recallPolicy !== undefined && <p className="mt-1 text-[11px] text-muted">納入原因：{hit.recallPolicy === "global" ? "所有專案可使用" : hit.recallPolicy === "agent" ? "寫入者與召回身分標記相同" : "此搜尋情境涵蓋歸屬專案"} · 寫入來源：{hit.originProject ?? "來源未知"}</p>}
            {hit.sourceId != null && (
              <>
                <p className="mt-1 text-[11px] text-muted">{hit.occurredAt == null ? "對話時間未知" : formatDateTime(hit.occurredAt)}</p>
                <RawMemorySourceDisclosure id={hit.sourceId} agent={hit.agent} scope={hit.scope} project={hit.project} />
              </>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** 召回情境與管理篩選各自保存，變更情境後必須重新搜尋。 */
export function MemoryRecallPreview({ projects, writers, revision }: {
  projects: string[];
  writers: string[];
  revision: number;
}) {
  const [project, setProject] = useState("");
  const [agent, setAgent] = useState("");
  const [query, setQuery] = useState("");
  const [state, setState] = useState<RecallState>({ kind: "idle" });
  const requestId = useRef(0);
  const pending = useRef<AbortController | null>(null);

  const clear = () => {
    requestId.current += 1;
    pending.current?.abort();
    setState({ kind: "idle" });
  };

  useEffect(() => {
    clear();
    return () => {
      requestId.current += 1;
      pending.current?.abort();
    };
  }, [revision]);

  const run = async () => {
    clear();
    if (query.trim() === "") {
      setState({ kind: "error", message: "請輸入要召回的內容。" });
      return;
    }
    if (project === "") {
      setState({ kind: "error", message: "請先選擇召回情境的專案或搜尋範圍。" });
      return;
    }
    const id = ++requestId.current;
    const abort = new AbortController();
    pending.current = abort;
    setState({ kind: "loading" });
    try {
      const result = await searchMemories({
        query: query.trim(),
        ...(project === "all" ? { includeAllProjects: true } : project === "global" ? { scope: "global" as const } :
          { project: JSON.parse(project) as string }),
        ...(agent.trim() === "" ? {} : { agent: agent.trim() }),
        k: 10,
      }, abort.signal);
      if (requestId.current === id) setState({ kind: "ready", result });
    } catch (error) {
      if (requestId.current === id) setState({ kind: "error", message: error instanceof Error ? error.message : "召回記憶失敗。" });
    }
  };

  return (
    <div className="space-y-4">
      <form className="space-y-4 rounded-2xl border border-line bg-surface p-4" onSubmit={(event) => { event.preventDefault(); void run(); }}>
        <div>
          <h3 className="text-sm font-medium text-ink">用一個召回情境試查記憶</h3>
          <p className="mt-1 text-xs text-muted">語意優先；選擇專案時會包含該專案與共用記憶。此處的情境與記憶清單篩選分開。</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1 text-xs text-muted">
            <span>召回情境的專案</span>
            <select aria-label="召回情境的專案" value={project} onChange={(event) => { clear(); setProject(event.target.value); }}
              className="w-full min-w-0 rounded-lg border border-line bg-bg px-3 py-2 text-sm text-ink">
              <option value="">請選擇專案或範圍</option>
              {memoryOptionNames(projects, project).map((name) => <option key={name} value={memoryNameOption(name)}>{name}</option>)}
              <option value="global">僅共用記憶</option>
              <option value="all">所有專案（跨專案搜尋）</option>
            </select>
          </label>
          <label className="space-y-1 text-xs text-muted">
            <span>召回身分標記（選填）</span>
            <input aria-label="召回身分標記" list="memory-recall-writers" value={agent} maxLength={200}
              placeholder="由接入端明確提供的 agent 標記"
              onChange={(event) => { clear(); setAgent(event.target.value); }}
              className="w-full min-w-0 rounded-lg border border-line bg-bg px-3 py-2 text-sm text-ink" />
            <datalist id="memory-recall-writers">{writers.map((writer) => <option key={writer} value={writer} />)}</datalist>
          </label>
        </div>
        <p className="text-[11px] text-muted">提供標記時也可納入相同 agent 範圍的記憶；標記不是帳號驗證，也不會自動對應不同寫入者名稱。</p>
        <div className="flex flex-wrap gap-2">
          <input type="search" aria-label="召回查詢" value={query} maxLength={2000} placeholder="用自然語言描述要找的記憶…"
            onChange={(event) => { clear(); setQuery(event.target.value); }}
            className="min-w-0 flex-1 rounded-lg border border-line bg-bg px-3 py-2 text-sm text-ink outline-none focus:border-brand" />
          <button type="submit" disabled={state.kind === "loading"}
            className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-on-brand disabled:opacity-40">
            {state.kind === "loading" ? "召回中…" : "預覽召回"}
          </button>
        </div>
      </form>
      {state.kind === "idle" && <p className="rounded-xl bg-tint px-4 py-3 text-xs text-muted">設定情境與查詢後，這裡會顯示實際召回結果。修改任何條件後，請重新預覽。</p>}
      {state.kind === "loading" && <p role="status" className="text-sm text-muted">正在召回記憶…</p>}
      {state.kind === "error" && <p role="alert" className="text-sm text-danger">{state.message}</p>}
      {state.kind === "ready" && <RecallResults result={state.result} />}
    </div>
  );
}

