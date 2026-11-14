import type { MemoryPatch, MemoryScope } from "../ports/types.js";

export type MemoryRecallPolicy = MemoryScope | "disabled";
export interface MemoryOrganization {
  originProject: string | null;
  assignedProject: string | null;
  recallPolicy: MemoryRecallPolicy;
  recallPolicySource: "legacy" | "default" | "rule" | "override";
  recallRuleId: string | null;
  recallRuleRevision: number | null;
}
export interface MemoryRecallRule { id: string; project?: string; writer?: string; policy: MemoryRecallPolicy }
export interface MemoryRecallSettings { revision: number; dataRevision: number; rules: MemoryRecallRule[] }
export interface MemoryOrganizationCounts { sources: number; memories: number }
export interface MemoryRecallRulePreview {
  revision: number;
  dataRevision: number;
  matched: MemoryOrganizationCounts;
  changed: MemoryOrganizationCounts;
  preservedOverrides: MemoryOrganizationCounts;
}
export interface MemoryRecallRuleWriteOptions {
  expectedRevision: number;
  applyExisting?: boolean;
  expectedDataRevision?: number;
}
export interface MemoryRecallRuleWriteResult extends MemoryRecallRulePreview { settings: MemoryRecallSettings }
export interface MemoryOrganizationPatch {
  assignedProject?: string | null;
  recallPolicy?: MemoryRecallPolicy | null;
  expectedDataRevision?: number;
}
export interface MemoryOrganizationInput {
  originProject?: string | null;
  assignedProject?: string | null;
  /** 受信任的匯入／版本繼承通道；一般寫入端不得直接透傳。 */
  organization?: MemoryOrganization;
}
export interface MemoryDedupeIdentity { scope: MemoryScope; project: string | null }
/** 僅供備份復原；原請求維度與目前用途投影分開保存。 */
export function memoryDedupeIdentity(input: MemoryDedupeIdentity & { restoreDedupe?: MemoryDedupeIdentity }): MemoryDedupeIdentity {
  const identity = input.restoreDedupe ?? input;
  if (!["global", "project", "agent"].includes(identity.scope) ||
    (identity.project !== null && (typeof identity.project !== "string" || identity.project.length > 200 || identity.project.includes("\0")))) throw new TypeError("備份去重維度不合法");
  return { scope: identity.scope, project: identity.project };
}
export interface MemoryOrganizationItem extends MemoryOrganization { type: "source" | "memory"; id: number; agent: string }

export class MemoryRecallConflictError extends Error {
  readonly code = "recall-conflict";
  constructor() { super("記憶或召回規則已變更，請重新預覽後再儲存"); this.name = "MemoryRecallConflictError"; }
}

export const MEMORY_ORGANIZATION_COLUMNS = "origin_project, assigned_project, recall_policy, recall_policy_source, recall_rule_id, recall_rule_revision";
const policies: readonly unknown[] = ["project", "global", "agent", "disabled"];
const sources: readonly unknown[] = ["legacy", "default", "rule", "override"];

function projectName(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.trim() === "" || value.length > 200 || value.includes("\0")) throw new TypeError("專案必須是非空文字或 null");
  return value.trim();
}
function policyValue(value: unknown): MemoryRecallPolicy {
  if (!policies.includes(value)) throw new TypeError("recallPolicy 必須是 project/global/agent/disabled");
  return value as MemoryRecallPolicy;
}
export function assertMemoryRecallRevision(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new TypeError("revision 必須是正整數");
}
export function normalizeMemoryRecallRule(value: MemoryRecallRule): MemoryRecallRule {
  if (value === null || typeof value !== "object" || typeof value.id !== "string" || value.id.trim() === "" || value.id.length > 200 || value.id.includes("\0")) throw new TypeError("規則 id 必須是非空文字");
  const rule: MemoryRecallRule = { id: value.id, policy: policyValue(value.policy) };
  if (value.project !== undefined) {
    const project = projectName(value.project);
    if (project === null) throw new TypeError("規則 project 不可為 null");
    rule.project = project;
  }
  if (value.writer !== undefined) {
    if (typeof value.writer !== "string" || value.writer.trim() === "" || value.writer.length > 200 || value.writer.includes("\0")) throw new TypeError("規則 writer 必須是非空文字");
    rule.writer = value.writer;
  }
  if (rule.project === undefined && rule.writer === undefined) throw new TypeError("規則至少要指定 project 或 writer");
  return rule;
}
export function normalizeMemoryRecallRules(values: MemoryRecallRule[]): MemoryRecallRule[] {
  if (!Array.isArray(values)) throw new TypeError("rules 必須是陣列");
  const rules = values.map(normalizeMemoryRecallRule);
  const ids = new Set<string>(); const selectors = new Set<string>();
  for (const rule of rules) {
    const selector = JSON.stringify([rule.project ?? null, rule.writer ?? null]);
    if (ids.has(rule.id) || selectors.has(selector)) throw new TypeError("規則 id 與 selector 必須唯一");
    ids.add(rule.id); selectors.add(selector);
  }
  return rules;
}
export function readMemoryRecallSettings(row: Record<string, unknown>): MemoryRecallSettings {
  return { revision: Number(row.revision), dataRevision: Number(row.data_revision), rules: normalizeMemoryRecallRules(JSON.parse(String(row.rules_json)) as MemoryRecallRule[]) };
}
export function readMemoryOrganization(row: Record<string, unknown>): MemoryOrganization {
  return { originProject: row.origin_project == null ? null : String(row.origin_project), assignedProject: row.assigned_project == null ? null : String(row.assigned_project),
    recallPolicy: String(row.recall_policy) as MemoryRecallPolicy, recallPolicySource: String(row.recall_policy_source) as MemoryOrganization["recallPolicySource"],
    recallRuleId: row.recall_rule_id == null ? null : String(row.recall_rule_id), recallRuleRevision: row.recall_rule_revision == null ? null : Number(row.recall_rule_revision) };
}
export function normalizeMemoryOrganization(value: MemoryOrganization): MemoryOrganization {
  if (value === null || typeof value !== "object" || !sources.includes(value.recallPolicySource)) throw new TypeError("組織快照不合法");
  const result = { originProject: projectName(value.originProject), assignedProject: projectName(value.assignedProject), recallPolicy: policyValue(value.recallPolicy),
    recallPolicySource: value.recallPolicySource, recallRuleId: value.recallRuleId, recallRuleRevision: value.recallRuleRevision };
  if (result.recallPolicy === "project" && result.assignedProject === null) result.recallPolicy = "disabled";
  if (result.recallRuleId !== null && (typeof result.recallRuleId !== "string" || result.recallRuleId.length === 0 || result.recallRuleId.length > 200)) throw new TypeError("recallRuleId 不合法");
  if (result.recallRuleRevision !== null) assertMemoryRecallRevision(result.recallRuleRevision);
  if ((result.recallRuleId === null) !== (result.recallRuleRevision === null)) throw new TypeError("規則 id 與 revision 須同時提供");
  return result;
}
export function memoryRuleMatches(rule: MemoryRecallRule, item: Pick<MemoryOrganizationItem, "assignedProject" | "agent">): boolean {
  return (rule.project === undefined || rule.project === item.assignedProject) && (rule.writer === undefined || rule.writer === item.agent);
}
export function resolveMemoryOrganization(current: MemoryOrganization, writer: string, settings: MemoryRecallSettings, fallback: MemoryRecallPolicy): MemoryOrganization {
  if (current.recallPolicySource === "override") return { ...current, recallPolicy: current.recallPolicy === "project" && current.assignedProject === null ? "disabled" : current.recallPolicy };
  const rule = settings.rules.filter((rule) => memoryRuleMatches(rule, { ...current, agent: writer }))
    .sort((a, b) => (Number(b.project !== undefined) * 2 + Number(b.writer !== undefined)) - (Number(a.project !== undefined) * 2 + Number(a.writer !== undefined)))[0];
  const policy = rule?.policy ?? fallback;
  return { ...current, recallPolicy: policy === "project" && current.assignedProject === null ? "disabled" : policy,
    recallPolicySource: rule === undefined ? "default" : "rule", recallRuleId: rule?.id ?? null, recallRuleRevision: rule === undefined ? null : settings.revision };
}
export function newMemoryOrganization(input: MemoryOrganizationInput & { project: string | null; scope: MemoryScope; agent: string }, settings: MemoryRecallSettings): MemoryOrganization {
  if (input.organization !== undefined) return normalizeMemoryOrganization(input.organization);
  const current: MemoryOrganization = { originProject: projectName(input.originProject === undefined ? input.project : input.originProject),
    assignedProject: projectName(input.assignedProject === undefined ? input.project : input.assignedProject), recallPolicy: input.scope,
    recallPolicySource: "default", recallRuleId: null, recallRuleRevision: null };
  return resolveMemoryOrganization(current, input.agent, settings, input.scope);
}
export function projectMemoryOrganization(value: MemoryOrganization): { scope: MemoryScope; project: string | null } {
  return { scope: value.recallPolicy === "disabled" ? (value.assignedProject === null ? "agent" : "project") : value.recallPolicy,
    project: value.recallPolicy === "project" || (value.recallPolicy === "disabled" && value.assignedProject !== null) ? value.assignedProject : null };
}
export function memoryOrganizationValues(value: MemoryOrganization): unknown[] {
  const projection = projectMemoryOrganization(value);
  return [value.originProject, value.assignedProject, value.recallPolicy, value.recallPolicySource, value.recallRuleId, value.recallRuleRevision, projection.scope, projection.project];
}
export function patchMemoryOrganization(current: MemoryOrganization, writer: string, patch: MemoryOrganizationPatch, settings: MemoryRecallSettings): MemoryOrganization {
  if (patch.assignedProject === undefined && patch.recallPolicy === undefined) throw new TypeError("至少提供歸屬或用途");
  const next = { ...current, assignedProject: patch.assignedProject === undefined ? current.assignedProject : projectName(patch.assignedProject) };
  if (patch.recallPolicy !== undefined && patch.recallPolicy !== null) return { ...next,
    recallPolicy: policyValue(patch.recallPolicy) === "project" && next.assignedProject === null ? "disabled" : patch.recallPolicy,
    recallPolicySource: "override", recallRuleId: null, recallRuleRevision: null };
  if (patch.recallPolicy === null) next.recallPolicySource = "default";
  return resolveMemoryOrganization(next, writer, settings, next.assignedProject === null ? "disabled" : "project");
}
export function legacyMemoryOrganizationPatch(current: MemoryOrganization & { scope: MemoryScope; project: string | null }, patch: MemoryPatch): MemoryOrganizationPatch {
  const scope = patch.scope ?? current.scope;
  if (!["global", "project", "agent"].includes(scope) || (patch.scope === undefined && patch.project === undefined)) throw new TypeError("scope patch 不合法");
  if (scope === "project") {
    const assignedProject = projectName(patch.project === undefined ? current.assignedProject : patch.project);
    if (assignedProject === null) throw new TypeError("project 用途必須指定專案");
    return { assignedProject, recallPolicy: scope };
  }
  if (patch.project != null) throw new TypeError("global/agent 的相容 project 必須是 null");
  return { recallPolicy: scope };
}
export function planMemoryRecallRule(settings: MemoryRecallSettings, ruleInput: MemoryRecallRule, items: MemoryOrganizationItem[]): {
  rules: MemoryRecallRule[]; preview: MemoryRecallRulePreview; updates: Array<{ item: MemoryOrganizationItem; organization: MemoryOrganization }>;
} {
  const rule = normalizeMemoryRecallRule(ruleInput);
  const rules = normalizeMemoryRecallRules([...settings.rules.filter((existing) => existing.id !== rule.id), rule]);
  const preview: MemoryRecallRulePreview = { revision: settings.revision, dataRevision: settings.dataRevision,
    matched: { sources: 0, memories: 0 }, changed: { sources: 0, memories: 0 }, preservedOverrides: { sources: 0, memories: 0 } };
  const updates: Array<{ item: MemoryOrganizationItem; organization: MemoryOrganization }> = [];
  for (const item of items) {
    if (!memoryRuleMatches(rule, item)) continue;
    const key = item.type === "source" ? "sources" : "memories";
    preview.matched[key] += 1;
    if (item.recallPolicySource === "override") { preview.preservedOverrides[key] += 1; continue; }
    const organization = resolveMemoryOrganization(item, item.agent, { ...settings, revision: settings.revision + 1, rules }, item.recallPolicy);
    if (JSON.stringify(memoryOrganizationValues(item)) !== JSON.stringify(memoryOrganizationValues(organization))) {
      preview.changed[key] += 1; updates.push({ item, organization });
    }
  }
  return { rules, preview, updates };
}
