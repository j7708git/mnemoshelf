import type { MemoryOrganization, MemoryRecallPolicy, MemoryRecallRule, MemoryRulePreview } from "./api";

export const RECALL_POLICY_LABEL: Record<MemoryRecallPolicy, string> = {
  project: "只在歸屬專案使用",
  global: "所有專案可使用",
  agent: "同寫入者可跨專案使用",
  disabled: "不納入自動召回",
};

/** 寫入時保存的規則快照，不因後來刪除或修改規則而假稱重新套用。 */
export function memoryPolicySourceLabel(memory: Pick<MemoryOrganization, "recallPolicySource" | "recallRuleId" | "recallRuleRevision">): string {
  switch (memory.recallPolicySource) {
    case "legacy": return "沿用舊資料用途";
    case "default": return "寫入時的預設用途";
    case "override": return "這筆記憶的單筆例外";
    case "rule": return `規則快照 ${memory.recallRuleId ?? "未知規則"}（修訂 ${memory.recallRuleRevision ?? "未知"}）`;
  }
}

export function memoryRuleTargetLabel(rule: MemoryRecallRule): string {
  return [rule.project === undefined ? null : `專案 ${rule.project}`, rule.writer === undefined ? null : `寫入者 ${rule.writer}`]
    .filter((value) => value !== null).join(" · ");
}

/** 未明選套用既有資料時，不送資料修訂，也不把預覽中的估算當成已修改。 */
export function memoryRuleSaveOptions(preview: MemoryRulePreview, applyExisting: boolean) {
  return {
    expectedRevision: preview.revision,
    applyExisting,
    ...(applyExisting ? { expectedDataRevision: preview.dataRevision } : {}),
  };
}
