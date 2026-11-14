import {
  assertMemoryRecallRevision, MemoryRecallConflictError, memoryOrganizationValues, newMemoryOrganization,
  normalizeMemoryRecallRules, patchMemoryOrganization, planMemoryRecallRule, readMemoryOrganization, readMemoryRecallSettings,
  type MemoryOrganization, type MemoryOrganizationInput, type MemoryOrganizationItem, type MemoryOrganizationPatch,
  type MemoryRecallRule, type MemoryRecallRuleWriteOptions, type MemoryRecallSettings, type MemoryScope,
} from "@mnemoshelf/core";
import type { Pool, PoolClient } from "pg";
import { withTransaction } from "./connection.js";
import { qualified } from "./schema.js";

/** 規則寫入與一般寫入先鎖 settings，確保預覽 CAS 與快照求值使用同一序列。 */
export class PgMemoryOrganizationStore {
  readonly settingsTable: string;
  private readonly memories: string;
  private readonly sources: string;
  constructor(private readonly pool: Pool, private readonly schema: string) {
    this.settingsTable = qualified(schema, "memory_recall_settings");
    this.memories = qualified(schema, "memories"); this.sources = qualified(schema, "memory_sources");
  }
  async migrate(): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      // 新增 nullable 欄位後只回填 null，反覆 migrate 不覆蓋既有組織快照。
      for (const table of [this.memories, this.sources]) {
        await client.query(`alter table ${table} add column if not exists origin_project text;
          alter table ${table} add column if not exists assigned_project text;
          alter table ${table} add column if not exists recall_policy text;
          alter table ${table} add column if not exists recall_policy_source text;
          alter table ${table} add column if not exists recall_rule_id text;
          alter table ${table} add column if not exists recall_rule_revision integer;
          update ${table} set assigned_project = project, recall_policy = scope, recall_policy_source = 'legacy' where recall_policy is null;
          alter table ${table} alter column recall_policy set not null;
          alter table ${table} alter column recall_policy set default 'global';
          alter table ${table} alter column recall_policy_source set not null;
          alter table ${table} alter column recall_policy_source set default 'legacy';`);
      }
      await client.query(`alter table ${this.memories} add column if not exists dedupe_scope text;
        alter table ${this.memories} add column if not exists dedupe_project text;
        update ${this.memories} set dedupe_scope = scope, dedupe_project = project where dedupe_scope is null;
        create table if not exists ${this.settingsTable} (id integer primary key check(id = 1), revision integer not null, data_revision bigint not null, rules_json text not null);
        insert into ${this.settingsTable} values (1, 1, 1, '[]') on conflict do nothing;
        create or replace function ${qualified(this.schema, "memory_recall_changed")}() returns trigger language plpgsql as $$
        begin
          update ${this.settingsTable} set data_revision = data_revision + 1 where id = 1;
          return null;
        end; $$;`);
      for (const table of [this.memories, this.sources]) {
        await client.query(`drop trigger if exists recall_insert_delete on ${table};
          create trigger recall_insert_delete after insert or delete on ${table} for each row execute function ${qualified(this.schema, "memory_recall_changed")}();
          drop trigger if exists recall_update on ${table};
          create trigger recall_update after update on ${table} for each row
          when (old.deleted_at is distinct from new.deleted_at or old.origin_project is distinct from new.origin_project
            or old.assigned_project is distinct from new.assigned_project or old.recall_policy is distinct from new.recall_policy
            or old.recall_policy_source is distinct from new.recall_policy_source or old.recall_rule_id is distinct from new.recall_rule_id
            or old.recall_rule_revision is distinct from new.recall_rule_revision)
          execute function ${qualified(this.schema, "memory_recall_changed")}();`);
      }
      await client.query(`create index if not exists memories_assigned_writer_idx on ${this.memories}(assigned_project, agent) where deleted_at is null`);
    });
  }
  async settings(connection: Pool | PoolClient = this.pool, lock = false): Promise<MemoryRecallSettings> {
    const result = await connection.query(`select * from ${this.settingsTable} where id = 1 ${lock ? "for update" : ""}`);
    return readMemoryRecallSettings(result.rows[0]!);
  }
  private async items(client: PoolClient): Promise<MemoryOrganizationItem[]> {
    const result = await client.query(`select 'memory' as type, id, agent, origin_project, assigned_project, recall_policy, recall_policy_source, recall_rule_id, recall_rule_revision
      from ${this.memories} where deleted_at is null and source_id is null union all
      select 'source', id, agent, origin_project, assigned_project, recall_policy, recall_policy_source, recall_rule_id, recall_rule_revision
      from ${this.sources} where deleted_at is null`);
    return result.rows.map((row) => ({ ...readMemoryOrganization(row), type: row.type as "source" | "memory", id: Number(row.id), agent: String(row.agent) }));
  }
  async forWrite(client: PoolClient, input: MemoryOrganizationInput & { project: string | null; scope: MemoryScope; agent: string; supersedes?: number | null }): Promise<MemoryOrganization> {
    const settings = await this.settings(client, true);
    if (input.supersedes != null) {
      const result = await client.query(`select * from ${this.memories} where id = $1 and source_id is null`, [input.supersedes]);
      if (result.rows[0] !== undefined) return readMemoryOrganization(result.rows[0]);
    }
    return newMemoryOrganization(input, settings);
  }
  async write(client: PoolClient, type: "source" | "memory", id: number, organization: MemoryOrganization): Promise<void> {
    const assignment = "origin_project = $1, assigned_project = $2, recall_policy = $3, recall_policy_source = $4, recall_rule_id = $5, recall_rule_revision = $6, scope = $7, project = $8";
    const values = [...memoryOrganizationValues(organization), id];
    await client.query(`update ${type === "source" ? this.sources : this.memories} set ${assignment} where id = $9`, values);
    if (type === "source") await client.query(`update ${this.memories} set ${assignment} where source_id = $9`, values);
  }
  async preview(rule: MemoryRecallRule) {
    return withTransaction(this.pool, async (client) => {
      const settings = await this.settings(client, true);
      return planMemoryRecallRule(settings, rule, await this.items(client)).preview;
    });
  }
  async upsert(rule: MemoryRecallRule, options: MemoryRecallRuleWriteOptions) {
    assertMemoryRecallRevision(options.expectedRevision);
    if (options.applyExisting !== undefined && typeof options.applyExisting !== "boolean") throw new TypeError("applyExisting 必須是布林值");
    if (options.applyExisting) assertMemoryRecallRevision(options.expectedDataRevision);
    return withTransaction(this.pool, async (client) => {
      const settings = await this.settings(client, true);
      if (settings.revision !== options.expectedRevision || (options.applyExisting && settings.dataRevision !== options.expectedDataRevision)) throw new MemoryRecallConflictError();
      const plan = planMemoryRecallRule(settings, rule, await this.items(client));
      await client.query(`update ${this.settingsTable} set revision = revision + 1, rules_json = $1 where id = 1`, [JSON.stringify(plan.rules)]);
      if (options.applyExisting) for (const update of plan.updates) await this.write(client, update.item.type, update.item.id, update.organization);
      const next = await this.settings(client);
      return { ...plan.preview, revision: next.revision, dataRevision: next.dataRevision, settings: next,
        changed: options.applyExisting ? plan.preview.changed : { sources: 0, memories: 0 } };
    });
  }
  async replace(rules: MemoryRecallRule[], expectedRevision: number): Promise<MemoryRecallSettings> {
    assertMemoryRecallRevision(expectedRevision); const normalized = normalizeMemoryRecallRules(rules);
    return withTransaction(this.pool, async (client) => {
      if ((await this.settings(client, true)).revision !== expectedRevision) throw new MemoryRecallConflictError();
      await client.query(`update ${this.settingsTable} set revision = revision + 1, rules_json = $1 where id = 1`, [JSON.stringify(normalized)]);
      return this.settings(client);
    });
  }
  async delete(id: string, expectedRevision: number): Promise<MemoryRecallSettings> {
    assertMemoryRecallRevision(expectedRevision);
    return withTransaction(this.pool, async (client) => {
      const settings = await this.settings(client, true);
      if (settings.revision !== expectedRevision) throw new MemoryRecallConflictError();
      await client.query(`update ${this.settingsTable} set revision = revision + 1, rules_json = $1 where id = 1`, [JSON.stringify(settings.rules.filter((rule) => rule.id !== id))]);
      return this.settings(client);
    });
  }
  async update(client: PoolClient, type: "source" | "memory", id: number, patch: MemoryOrganizationPatch): Promise<{ type: "source" | "memory"; id: number } | null> {
    if (type !== "source" && type !== "memory") throw new TypeError("type 必須是 source 或 memory");
    if (!Number.isSafeInteger(id) || id <= 0) throw new TypeError("id 必須是正整數");
    if (patch.expectedDataRevision !== undefined) assertMemoryRecallRevision(patch.expectedDataRevision);
    const settings = await this.settings(client, true);
    if (patch.expectedDataRevision !== undefined && patch.expectedDataRevision !== settings.dataRevision) throw new MemoryRecallConflictError();
    let result = await client.query(`select * from ${type === "source" ? this.sources : this.memories} where id = $1 and deleted_at is null`, [id]);
    let row = result.rows[0];
    if (row === undefined) return null;
    if (type === "memory" && row.source_id != null) { type = "source"; id = Number(row.source_id);
      result = await client.query(`select * from ${this.sources} where id = $1 and deleted_at is null`, [id]); row = result.rows[0]; }
    if (row === undefined) return null;
    await this.write(client, type, id, patchMemoryOrganization(readMemoryOrganization(row), String(row.agent), patch, settings));
    return { type, id };
  }
}
