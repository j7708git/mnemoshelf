import {
  assertMemoryRecallRevision, MemoryRecallConflictError, memoryOrganizationValues, newMemoryOrganization,
  normalizeMemoryRecallRules, patchMemoryOrganization, planMemoryRecallRule, readMemoryOrganization, readMemoryRecallSettings,
  type MemoryOrganization, type MemoryOrganizationInput, type MemoryOrganizationItem, type MemoryOrganizationPatch,
  type MemoryRecallRule, type MemoryRecallRuleWriteOptions, type MemoryRecallSettings,
} from "../../memory/organization.js";
import type { MemoryScope } from "../../ports/types.js";
import { selectRow, selectRows, type SqliteDatabase } from "./driver.js";

/** 同步方法僅供 adapter 的 SQLite 交易內使用。 */
export class SqliteMemoryOrganizationStore {
  constructor(private readonly db: SqliteDatabase) {}
  settings(): MemoryRecallSettings {
    return readMemoryRecallSettings(selectRow(this.db, "select * from memory_recall_settings where id = 1")!);
  }
  private items(): MemoryOrganizationItem[] {
    return selectRows(this.db, `select 'memory' as type, id, agent, origin_project, assigned_project, recall_policy, recall_policy_source, recall_rule_id, recall_rule_revision
      from memories where deleted_at is null and source_id is null union all
      select 'source', id, agent, origin_project, assigned_project, recall_policy, recall_policy_source, recall_rule_id, recall_rule_revision
      from memory_sources where deleted_at is null`).map((row) => ({ ...readMemoryOrganization(row), type: row.type as "source" | "memory", id: Number(row.id), agent: String(row.agent) }));
  }
  forWrite(input: MemoryOrganizationInput & { project: string | null; scope: MemoryScope; agent: string; supersedes?: number | null }): MemoryOrganization {
    if (input.supersedes != null) {
      const previous = selectRow(this.db, "select * from memories where id = ? and source_id is null", input.supersedes);
      if (previous !== undefined) return readMemoryOrganization(previous);
    }
    return newMemoryOrganization(input, this.settings());
  }
  write(type: "source" | "memory", id: number, organization: MemoryOrganization): void {
    const assignment = "origin_project = ?, assigned_project = ?, recall_policy = ?, recall_policy_source = ?, recall_rule_id = ?, recall_rule_revision = ?, scope = ?, project = ?";
    this.db.prepare(`update ${type === "source" ? "memory_sources" : "memories"} set ${assignment} where id = ?`).run(...memoryOrganizationValues(organization), id);
    if (type === "source") this.db.prepare(`update memories set ${assignment} where source_id = ?`).run(...memoryOrganizationValues(organization), id);
  }
  preview(rule: MemoryRecallRule) { return this.db.transaction(() => planMemoryRecallRule(this.settings(), rule, this.items()).preview)(); }
  upsert(rule: MemoryRecallRule, options: MemoryRecallRuleWriteOptions) {
    assertMemoryRecallRevision(options.expectedRevision);
    if (options.applyExisting !== undefined && typeof options.applyExisting !== "boolean") throw new TypeError("applyExisting 必須是布林值");
    if (options.applyExisting) assertMemoryRecallRevision(options.expectedDataRevision);
    return this.db.transaction(() => {
      const settings = this.settings();
      if (settings.revision !== options.expectedRevision || (options.applyExisting && settings.dataRevision !== options.expectedDataRevision)) throw new MemoryRecallConflictError();
      const plan = planMemoryRecallRule(settings, rule, this.items());
      this.db.prepare("update memory_recall_settings set revision = revision + 1, rules_json = ? where id = 1").run(JSON.stringify(plan.rules));
      if (options.applyExisting) for (const update of plan.updates) this.write(update.item.type, update.item.id, update.organization);
      const next = this.settings();
      return { ...plan.preview, revision: next.revision, dataRevision: next.dataRevision, settings: next,
        changed: options.applyExisting ? plan.preview.changed : { sources: 0, memories: 0 } };
    }).immediate();
  }
  replace(rules: MemoryRecallRule[], expectedRevision: number): MemoryRecallSettings {
    assertMemoryRecallRevision(expectedRevision);
    const normalized = normalizeMemoryRecallRules(rules);
    return this.db.transaction(() => {
      if (this.settings().revision !== expectedRevision) throw new MemoryRecallConflictError();
      this.db.prepare("update memory_recall_settings set revision = revision + 1, rules_json = ? where id = 1").run(JSON.stringify(normalized));
      return this.settings();
    }).immediate();
  }
  delete(id: string, expectedRevision: number): MemoryRecallSettings {
    return this.db.transaction(() => this.replace(this.settings().rules.filter((rule) => rule.id !== id), expectedRevision)).immediate();
  }
  update(type: "source" | "memory", id: number, patch: MemoryOrganizationPatch): { type: "source" | "memory"; id: number } | null {
    if (type !== "source" && type !== "memory") throw new TypeError("type 必須是 source 或 memory");
    if (!Number.isSafeInteger(id) || id <= 0) throw new TypeError("id 必須是正整數");
    if (patch.expectedDataRevision !== undefined) assertMemoryRecallRevision(patch.expectedDataRevision);
    const settings = this.settings();
    if (patch.expectedDataRevision !== undefined && patch.expectedDataRevision !== settings.dataRevision) throw new MemoryRecallConflictError();
    let row = selectRow(this.db, `select * from ${type === "source" ? "memory_sources" : "memories"} where id = ? and deleted_at is null`, id);
    if (row === undefined) return null;
    if (type === "memory" && row.source_id != null) { type = "source"; id = Number(row.source_id); row = selectRow(this.db, "select * from memory_sources where id = ? and deleted_at is null", id); }
    if (row === undefined) return null;
    this.write(type, id, patchMemoryOrganization(readMemoryOrganization(row), String(row.agent), patch, settings));
    return { type, id };
  }
}
