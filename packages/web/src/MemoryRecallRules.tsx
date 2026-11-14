import { useEffect, useRef, useState } from "react";
import { ConfirmDialog } from "./ConfirmDialog";
import {
  deleteMemoryRecallRule, getMemoryRecallRules, previewMemoryRecallRule, saveMemoryRecallRule, MemoryRecallConflictError,
  type MemoryRecallPolicy, type MemoryRecallRule, type MemoryRecallSettings, type MemoryRulePreview,
} from "./api";
import { memoryRuleSaveOptions, memoryRuleTargetLabel, RECALL_POLICY_LABEL } from "./memoryOrganization";

interface RuleForm {
  id: string | null;
  target: "project" | "writer" | "pair";
  project: string;
  writer: string;
  policy: MemoryRecallPolicy;
  applyExisting: boolean;
}
const initialForm: RuleForm = { id: null, target: "project", project: "", writer: "", policy: "project", applyExisting: false };
const fieldClass = "w-full min-w-0 rounded-lg border border-line bg-bg px-3 py-2 text-sm text-ink";

/** 規則的儲存必須承接同一份預覽；預設只套用到之後的寫入。 */
export function MemoryRecallRules({ projects, writers, revision, onChanged }: {
  projects: string[]; writers: string[]; revision: number; onChanged: () => void;
}) {
  const [settings, setSettings] = useState<MemoryRecallSettings | null>(null);
  const [form, setForm] = useState<RuleForm>(initialForm);
  const [preview, setPreview] = useState<{ rule: MemoryRecallRule; result: MemoryRulePreview } | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [remove, setRemove] = useState<MemoryRecallRule | null>(null);
  const [reload, setReload] = useState(0);
  const requestId = useRef(0);
  const pending = useRef<AbortController | null>(null);

  const invalidate = () => {
    requestId.current += 1;
    pending.current?.abort();
    setPreview(null);
    setPreviewBusy(false);
  };

  useEffect(() => {
    const abort = new AbortController();
    invalidate();
    void getMemoryRecallRules(abort.signal).then((value) => {
      if (!abort.signal.aborted) setSettings(value);
    }).catch((reason: unknown) => {
      if (!abort.signal.aborted) setError(reason instanceof Error ? reason.message : "讀取召回規則失敗。");
    });
    return () => { abort.abort(); requestId.current += 1; pending.current?.abort(); };
  }, [revision, reload]);

  const change = (patch: Partial<RuleForm>) => {
    invalidate(); setError(null); setMessage(null);
    setForm((previous) => ({ ...previous, ...patch }));
  };

  const runPreview = async () => {
    invalidate(); setError(null); setMessage(null);
    const project = form.project.trim();
    const writer = form.writer.trim();
    if ((form.target !== "writer" && project === "") || (form.target !== "project" && writer === "")) {
      setError("請填寫規則對象需要的專案與寫入者。"); return;
    }
    const rule: MemoryRecallRule = {
      id: form.id ?? crypto.randomUUID(), policy: form.policy,
      ...(form.target === "writer" ? {} : { project }), ...(form.target === "project" ? {} : { writer }),
    };
    const id = ++requestId.current;
    const abort = new AbortController(); pending.current = abort;
    setPreviewBusy(true);
    try {
      const result = await previewMemoryRecallRule(rule, abort.signal);
      if (requestId.current === id) setPreview({ rule, result });
    } catch (reason) {
      if (requestId.current === id) setError(reason instanceof Error ? reason.message : "預覽召回規則失敗。");
    } finally {
      if (requestId.current === id) setPreviewBusy(false);
    }
  };

  const handleFailure = (reason: unknown) => {
    invalidate();
    setError(reason instanceof Error ? reason.message : "保存召回規則失敗。");
    if (reason instanceof MemoryRecallConflictError) setReload((value) => value + 1);
  };

  const save = async () => {
    if (preview === null) return;
    setBusy(true); setError(null);
    try {
      const result = await saveMemoryRecallRule(preview.rule, memoryRuleSaveOptions(preview.result, form.applyExisting));
      setSettings(result.settings);
      setForm((previous) => ({ ...previous, id: preview.rule.id, applyExisting: false }));
      setMessage(form.applyExisting
        ? `已保存規則並更新 ${result.changed.sources} 個回合、${result.changed.memories} 則短記憶；單筆例外保留。`
        : "已保存規則，只套用之後新存入的記憶；既有記憶用途維持原樣。");
      invalidate(); onChanged();
    } catch (reason) { handleFailure(reason); }
    finally { setBusy(false); }
  };

  const confirmDelete = async () => {
    if (remove === null || settings === null) return;
    setBusy(true); setError(null);
    try {
      setSettings(await deleteMemoryRecallRule(remove.id, settings.revision));
      if (form.id === remove.id) setForm(initialForm);
      invalidate(); setRemove(null);
      setMessage("已刪除規則。之後寫入不再套用這條規則；既有記憶保留當時用途與規則快照。");
      onChanged();
    } catch (reason) { handleFailure(reason); setRemove(null); }
    finally { setBusy(false); }
  };

  const selectRule = (rule: MemoryRecallRule) => {
    invalidate(); setError(null); setMessage(null);
    setForm({ id: rule.id, target: rule.project !== undefined && rule.writer !== undefined ? "pair" : rule.project !== undefined ? "project" : "writer",
      project: rule.project ?? "", writer: rule.writer ?? "", policy: rule.policy, applyExisting: false });
  };

  const rules = [...(settings?.rules ?? [])].sort((a, b) =>
    (a.project !== undefined ? a.writer !== undefined ? 0 : 1 : 2) - (b.project !== undefined ? b.writer !== undefined ? 0 : 1 : 2));

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
      <div className="space-y-4 rounded-2xl border border-line bg-surface p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-medium text-ink">{form.id === null ? "新增召回規則" : "編輯召回規則"}</h3>
          {form.id !== null && <button type="button" disabled={busy} onClick={() => { invalidate(); setForm(initialForm); setMessage(null); setError(null); }} className="text-xs text-brand">改為新增規則</button>}
        </div>
        <fieldset disabled={busy} className="space-y-3 disabled:opacity-60">
          <label className="block space-y-1 text-xs text-muted"><span>規則對象</span>
            <select aria-label="規則對象" value={form.target} onChange={(event) => change({ target: event.target.value as RuleForm["target"] })} className={fieldClass}>
              <option value="project">專案</option><option value="writer">寫入者</option><option value="pair">專案＋寫入者</option>
            </select>
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            {form.target !== "writer" && <label className="block space-y-1 text-xs text-muted"><span>歸屬專案</span>
              <input aria-label="規則專案" list="memory-rule-projects" maxLength={200} value={form.project} placeholder="專案名稱" onChange={(event) => change({ project: event.target.value })} className={fieldClass} />
              <datalist id="memory-rule-projects">{projects.map((project) => <option key={project} value={project} />)}</datalist>
            </label>}
            {form.target !== "project" && <label className="block space-y-1 text-xs text-muted"><span>寫入者</span>
              <input aria-label="規則寫入者" list="memory-rule-writers" maxLength={200} value={form.writer} placeholder="精確的寫入者標記" onChange={(event) => change({ writer: event.target.value })} className={fieldClass} />
              <datalist id="memory-rule-writers">{writers.map((writer) => <option key={writer} value={writer} />)}</datalist>
            </label>}
          </div>
          <label className="block space-y-1 text-xs text-muted"><span>召回用途</span>
            <select aria-label="規則召回用途" value={form.policy} onChange={(event) => change({ policy: event.target.value as MemoryRecallPolicy })} className={fieldClass}>
              {Object.entries(RECALL_POLICY_LABEL).map(([policy, label]) => <option key={policy} value={policy}>{label}</option>)}
            </select>
          </label>
          <p className="text-xs leading-relaxed text-muted">{form.policy === "project" ? "同專案可由不同寫入者召回；未指定歸屬專案時不自動召回。" : form.policy === "agent" ? "召回端須明確提供與寫入者完全相同的標記；不自動猜測名稱對應。" : form.policy === "global" ? "這份本機記憶庫的所有專案都可召回；來源專案與寫入者仍保留。" : "記憶仍保留在清單，可查看原文；自動召回不納入。"}</p>
          <label className="flex items-start gap-2 rounded-lg bg-raised p-3 text-xs text-ink">
            <input type="checkbox" aria-label="一併套用符合條件的既有記憶" checked={form.applyExisting} onChange={(event) => change({ applyExisting: event.target.checked })} />
            <span>一併套用符合條件的既有記憶<span className="mt-1 block text-muted">預設只套用之後新存入的記憶；既有的單筆例外會保留。</span></span>
          </label>
          <button type="button" disabled={previewBusy || settings === null} onClick={() => void runPreview()} className="rounded-lg border border-line px-4 py-2 text-sm text-ink disabled:opacity-40">
            {previewBusy ? "預覽中…" : "預覽變更"}
          </button>
        </fieldset>
        {preview !== null && <div className="space-y-2 rounded-xl bg-tint p-4 text-xs text-ink" aria-live="polite">
          <p className="font-medium">{memoryRuleTargetLabel(preview.rule)} · {RECALL_POLICY_LABEL[preview.rule.policy]}</p>
          <p>符合條件：{preview.result.matched.sources} 個回合、{preview.result.matched.memories} 則短記憶。</p>
          <p>{form.applyExisting ? "預計更新用途／規則依據" : "若套用既有資料可更新用途／規則依據"}：{preview.result.changed.sources} 個回合、{preview.result.changed.memories} 則短記憶。</p>
          <p>保留單筆例外：{preview.result.preservedOverrides.sources} 個回合、{preview.result.preservedOverrides.memories} 則短記憶。</p>
          {!form.applyExisting && <p className="font-medium">這次只保存未來規則，不更動既有記憶。</p>}
          <button type="button" disabled={busy} onClick={() => void save()} className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-on-brand disabled:opacity-40">
            {busy ? "保存中…" : form.applyExisting ? "保存並套用既有記憶" : "保存規則（僅未來）"}
          </button>
        </div>}
        {error !== null && <div className="space-y-2"><p role="alert" className="text-xs text-danger">{error}</p><button type="button" onClick={() => { invalidate(); setError(null); setReload((value) => value + 1); }} className="text-xs text-brand">重新載入規則</button></div>}
        {message !== null && <p role="status" className="text-xs text-ink">{message}</p>}
      </div>
      <aside className="space-y-3 rounded-2xl border border-line p-4">
        <h3 className="text-sm font-medium text-ink">目前的召回規則</h3>
        <p className="text-xs leading-relaxed text-muted">優先順序：單筆例外 → 專案＋寫入者 → 專案 → 寫入者 → 寫入時預設。規則保存與刪除不會自動重算既有記憶。</p>
        {settings === null && <p className="text-xs text-muted">正在載入召回規則…</p>}
        {settings !== null && rules.length === 0 && <p className="rounded-lg bg-raised p-3 text-xs text-muted">尚無自訂規則。現有記憶沿用原用途，新記憶依寫入請求的預設用途保存。</p>}
        {rules.map((rule) => <div key={rule.id} className="space-y-2 rounded-xl border border-line bg-surface p-3">
          <p className="break-words text-xs font-medium text-ink">{memoryRuleTargetLabel(rule)}</p>
          <p className="text-sm text-ink">{RECALL_POLICY_LABEL[rule.policy]}</p>
          <div className="flex gap-3"><button type="button" disabled={busy} onClick={() => selectRule(rule)} className="text-xs text-brand">編輯規則</button>
            <button type="button" disabled={busy} onClick={() => setRemove(rule)} className="text-xs text-muted hover:text-danger">刪除規則</button></div>
        </div>)}
        <p className="border-t border-line pt-3 text-[11px] leading-relaxed text-muted">用途只控制這份本機記憶庫的召回，不是公開發布，也不是多使用者的權限隔離。套用後的記憶會保留規則快照，供之後追查。</p>
      </aside>
      {remove !== null && <ConfirmDialog open title="刪除這條召回規則？" description={`${memoryRuleTargetLabel(remove)}\n\n之後寫入不再套用這條規則。既有記憶保留原用途與歷史規則快照，不會被重新分類。`} confirmLabel="刪除規則" busy={busy} onCancel={() => setRemove(null)} onConfirm={() => void confirmDelete()} />}
    </div>
  );
}
