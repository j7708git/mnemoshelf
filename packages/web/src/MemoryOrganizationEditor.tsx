import { useState } from "react";
import { MemoryRecallConflictError, updateMemoryOrganization, type MemoryLibraryEntry, type MemoryRecallPolicy } from "./api";
import { memoryPolicySourceLabel, RECALL_POLICY_LABEL } from "./memoryOrganization";

/** 歸屬可整理，來源不改寫；單筆例外套用完整回合或一則短記憶。 */
export function MemoryOrganizationEditor({ entry, projects, dataRevision, onSaved, onReload }: {
  entry: MemoryLibraryEntry; projects: string[]; dataRevision: number | undefined;
  onSaved: () => void; onReload: () => void;
}) {
  const { memory } = entry;
  const [assignedProject, setAssignedProject] = useState(memory.assignedProject ?? "");
  const [policy, setPolicy] = useState<"keep" | "rules" | MemoryRecallPolicy>("keep");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);

  const save = async () => {
    setBusy(true); setError(null); setConflict(false);
    try {
      await updateMemoryOrganization(entry.type, entry.id, {
        assignedProject: assignedProject.trim() === "" ? null : assignedProject.trim(),
        ...(policy === "keep" ? {} : { recallPolicy: policy === "rules" ? null : policy }),
        expectedDataRevision: dataRevision,
      });
      onSaved();
    } catch (reason) {
      setConflict(reason instanceof MemoryRecallConflictError);
      setError(reason instanceof Error ? reason.message : "保存記憶歸屬與用途失敗。");
    } finally { setBusy(false); }
  };

  return (
    <details className="mt-3 border-t border-line pt-3 text-xs text-muted">
      <summary className="cursor-pointer">整理歸屬與單筆例外</summary>
      <div className="mt-3 space-y-3">
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
          <dt>寫入時來源專案</dt><dd className="break-words text-ink">{memory.originProject ?? "來源未知"}</dd>
          <dt>寫入者</dt><dd className="break-all text-ink">{memory.agent}</dd>
          <dt>目前召回用途</dt><dd className="text-ink">{RECALL_POLICY_LABEL[memory.recallPolicy]}</dd>
          <dt>用途依據</dt><dd className="break-all text-ink">{memoryPolicySourceLabel(memory)}</dd>
        </dl>
        {memory.recallPolicySource === "rule" && <p className="text-[11px]">這是套用時保存的歷史規則快照；規則之後修改或刪除，不會自動改變這筆記憶。</p>}
        <fieldset disabled={busy || conflict} className="grid gap-3 sm:grid-cols-2 disabled:opacity-60">
          <label className="space-y-1"><span>歸屬專案（可留空）</span>
            <input aria-label={`歸屬專案（${entry.type} #${entry.id}）`} value={assignedProject} list={`memory-projects-${entry.type}-${entry.id}`} maxLength={200}
              onChange={(event) => setAssignedProject(event.target.value)} placeholder="未指定專案"
              className="w-full min-w-0 rounded-lg border border-line bg-bg px-3 py-2 text-sm text-ink" />
            <datalist id={`memory-projects-${entry.type}-${entry.id}`}>{projects.map((project) => <option key={project} value={project} />)}</datalist>
          </label>
          <label className="space-y-1"><span>單筆召回用途</span>
            <select aria-label={`單筆召回用途（${entry.type} #${entry.id}）`} value={policy} onChange={(event) => setPolicy(event.target.value as typeof policy)}
              className="w-full min-w-0 rounded-lg border border-line bg-bg px-3 py-2 text-sm text-ink">
              <option value="keep">{memory.recallPolicySource === "override" ? "保留目前單筆例外" : "依規則整理（不新增例外）"}</option><option value="rules">依目前規則決定（清除單筆例外）</option>
              {Object.entries(RECALL_POLICY_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <p className="sm:col-span-2">{entry.type === "source" ? "此設定套用整個原文回合與所有檢索片段。" : "此設定只套用這則短記憶。"}來源專案與寫入者保留不變。</p>
          {policy === "keep" && <p className="sm:col-span-2">{memory.recallPolicySource === "override" ? "變更歸屬時保留這筆記憶的單筆例外；若只限專案使用卻移除歸屬，將不自動召回。" : "變更歸屬時，依新的專案與寫入者重新套用目前規則；沒有規則時只在歸屬專案使用，未指定專案則不自動召回。"}</p>}
          {policy === "rules" && <p className="sm:col-span-2">依目前規則重新決定用途；無規則時只在歸屬專案使用，未指定專案則不自動召回。</p>}
          <div className="sm:col-span-2"><button type="button" disabled={busy || dataRevision === undefined} onClick={() => void save()} className="rounded-lg bg-brand px-3 py-2 text-sm font-medium text-on-brand disabled:opacity-40">
            {busy ? "保存中…" : "保存歸屬與用途"}
          </button></div>
        </fieldset>
        {error !== null && <p role="alert" className="text-danger">{error}</p>}
        {conflict && <button type="button" onClick={onReload} className="text-brand">重新載入記憶清單</button>}
      </div>
    </details>
  );
}
