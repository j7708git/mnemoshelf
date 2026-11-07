import { selectRows } from "../driver.js";
import type { Migration } from "./0001_init.js";

/** 新增原文來源、硬刪除事件記錄及記憶遮罩政策。既有記憶保留原 id。 */
export const migration0006RawMemory: Migration = {
  id: "0006_raw_memory",
  up(db): void {
    db.exec(`
      create table if not exists memory_policy (
        id integer primary key check (id = 1),
        mask_secrets integer not null check (mask_secrets in (0, 1)),
        version integer not null check (version >= 1)
      );
      create table if not exists memory_sources (
        id integer primary key autoincrement,
        agent text not null,
        scope text not null,
        project text,
        source_session text not null,
        source_turn text not null,
        messages_json text not null,
        request_hash text not null,
        chunk_version text not null,
        created_at text not null,
        deleted_at text,
        unique (agent, source_session, source_turn)
      );
      create table if not exists deleted_memory_sources (
        event_key_hash text primary key not null
      );
    `);
    const existing = new Set(selectRows(db, "pragma table_info(memories)").map((row) => String(row.name)));
    const columns = [
      ["source_id", "integer references memory_sources(id)"],
      ["message_index", "integer"],
      ["chunk_index", "integer"],
      ["source_start", "integer"],
      ["source_end", "integer"],
      ["chunk_version", "text"],
    ];
    for (const [column, type] of columns) {
      if (!existing.has(column)) db.exec(`alter table memories add column ${column} ${type};`);
    }
    db.exec("create unique index if not exists memories_source_chunk_idx on memories(source_id, chunk_index);");
  },
};
