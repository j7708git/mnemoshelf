import { maskSecrets, type MemoryOrganization, type MemoryRecallRule } from "@mnemoshelf/core";
import { ValidationError } from "./errors.js";

export const RECALL_POLICIES = ["project", "global", "agent", "disabled"] as const;

/** 原始來源只在建立時接受；呼叫端不能傳入政策快照。 */
export function parseOrganizationOrigin(body: Record<string, unknown>) {
  const result: { originProject?: string | null; assignedProject?: string | null } = {};
  for (const key of ["originProject", "assignedProject"] as const) {
    if (Object.hasOwn(body, key)) result[key] = organizationName(body[key], key, true);
  }
  if (Object.hasOwn(body, "organization")) throw new ValidationError("organization", "政策快照只能由備份還原");
  return result;
}

export function organizationName(value: unknown, field: string, nullable = false): string | null {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || value.trim() === "" || value.length > 200 || value.includes("\0") || maskSecrets(value).redacted) {
    throw new ValidationError(field, "必須是 1 到 200 字元且不含機密的標記");
  }
  return field === "writer" ? value : value.trim();
}

export function revisionNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new ValidationError(field, "必須是正安全整數");
  }
  return value;
}

export function parseRecallRule(value: unknown, id?: string): MemoryRecallRule {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new ValidationError("rule", "必須是物件");
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some((key) => !["id", "project", "writer", "policy"].includes(key))) {
    throw new ValidationError("rule", "含有不支援的欄位");
  }
  const ruleId = organizationName(id ?? body.id, "id")!;
  const project = body.project === undefined ? undefined : organizationName(body.project, "project")!;
  const writer = body.writer === undefined ? undefined : organizationName(body.writer, "writer")!;
  if (project === undefined && writer === undefined) throw new ValidationError("rule", "必須指定專案或寫入者");
  if (!RECALL_POLICIES.includes(body.policy as typeof RECALL_POLICIES[number])) throw new ValidationError("policy", "召回政策不合法");
  return { id: ruleId, ...(project === undefined ? {} : { project }), ...(writer === undefined ? {} : { writer }), policy: body.policy as MemoryRecallRule["policy"] };
}

/** 從完整資料擷取快照，避免把內容或來源 hash 帶進備份。 */
export function organizationOf(value: MemoryOrganization): MemoryOrganization {
  return {
    originProject: value.originProject, assignedProject: value.assignedProject,
    recallPolicy: value.recallPolicy, recallPolicySource: value.recallPolicySource,
    recallRuleId: value.recallRuleId, recallRuleRevision: value.recallRuleRevision,
  };
}

export function parseOrganizationSnapshot(value: unknown): MemoryOrganization {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new ValidationError("organization", "必須是完整政策快照");
  const row = value as Record<string, unknown>;
  const originProject = organizationName(row.originProject, "originProject", true);
  const assignedProject = organizationName(row.assignedProject, "assignedProject", true);
  if (!RECALL_POLICIES.includes(row.recallPolicy as typeof RECALL_POLICIES[number])) throw new ValidationError("recallPolicy", "不合法");
  if (!["legacy", "default", "rule", "override"].includes(String(row.recallPolicySource))) throw new ValidationError("recallPolicySource", "不合法");
  const recallRuleId = row.recallRuleId === null ? null : organizationName(row.recallRuleId, "recallRuleId");
  const recallRuleRevision = row.recallRuleRevision === null ? null : revisionNumber(row.recallRuleRevision, "recallRuleRevision");
  if ((recallRuleId === null) !== (recallRuleRevision === null) || (row.recallPolicySource === "rule") !== (recallRuleId !== null && recallRuleRevision !== null)) throw new ValidationError("organization", "規則來源與版本不一致");
  return { originProject, assignedProject, recallPolicy: row.recallPolicy as MemoryOrganization["recallPolicy"], recallPolicySource: row.recallPolicySource as MemoryOrganization["recallPolicySource"], recallRuleId, recallRuleRevision };
}
