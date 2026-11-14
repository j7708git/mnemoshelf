import type { Migration } from "./0001_init.js";

/** 僅追加欄位；不重建來源、內容、事件雜湊、向量或刪除歷史。 */
export const migration0010MemoryOrganization: Migration = {
  id: "0010_memory_organization",
  up(db) {
    for (const table of ["memories", "memory_sources"]) {
      db.exec(`alter table ${table} add column origin_project text;
        alter table ${table} add column assigned_project text;
        alter table ${table} add column recall_policy text not null default 'global';
        alter table ${table} add column recall_policy_source text not null default 'legacy';
        alter table ${table} add column recall_rule_id text;
        alter table ${table} add column recall_rule_revision integer;
        update ${table} set assigned_project = project, recall_policy = scope;`);
    }
    db.exec(`alter table memories add column dedupe_scope text;
      alter table memories add column dedupe_project text;
      update memories set dedupe_scope = scope, dedupe_project = project;
      create table memory_recall_settings (
      id integer primary key check (id = 1), revision integer not null, data_revision integer not null, rules_json text not null);
      insert into memory_recall_settings values (1, 1, 1, '[]');`);
    for (const table of ["memories", "memory_sources"]) {
      for (const event of ["insert", "delete"]) db.exec(`create trigger ${table}_recall_${event} after ${event} on ${table}
        begin update memory_recall_settings set data_revision = data_revision + 1 where id = 1; end;`);
      db.exec(`create trigger ${table}_recall_update after update on ${table}
        when old.deleted_at is not new.deleted_at or old.origin_project is not new.origin_project
          or old.assigned_project is not new.assigned_project or old.recall_policy is not new.recall_policy
          or old.recall_policy_source is not new.recall_policy_source or old.recall_rule_id is not new.recall_rule_id
          or old.recall_rule_revision is not new.recall_rule_revision
        begin update memory_recall_settings set data_revision = data_revision + 1 where id = 1; end;`);
    }
    db.exec("create index memories_assigned_writer_idx on memories(assigned_project, agent) where deleted_at is null");
  },
};
