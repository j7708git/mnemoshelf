import { afterEach, expect, it } from "vitest";
import { memoryContentHash, openDatabase, SqliteMetadataStore, type SqliteDatabase } from "../src/index.js";
import { MIGRATIONS } from "../src/adapters/sqlite/migrations/index.js";
import { runMemoryOrganizationContract } from "../src/testing/index.js";
const opened: SqliteDatabase[] = [];
runMemoryOrganizationContract("sqlite", () => {
  const db = openDatabase(); opened.push(db);
  return { store: new SqliteMetadataStore(db), async failOrganizationUpdate() {
    db.exec(`create trigger fail_organization_update before update on memories
      when new.recall_policy = 'disabled' and old.chunk_index = 1
      begin select raise(abort, 'organization_update_failed'); end;`);
  } };
});
afterEach(() => { for (const db of opened.splice(0)) db.close(); });

it("由 0009 真舊 schema 升級逐欄保留 ID、原文、來源雜湊、向量、釘選與刪除歷史", async () => {
  const db = openDatabase(); opened.push(db);
  db.exec("create table schema_migrations(version text primary key, applied_at text not null)");
  for (const migration of MIGRATIONS.slice(0, 9)) {
    migration.up(db);
    db.prepare("insert into schema_migrations values (?, ?)").run(migration.id, "2026-01-01T00:00:00.000Z");
  }
  const messages = [{ sourceMessage: "msg", role: "user", content: "raw text", occurredAt: null }];
  db.prepare(`insert into memory_sources(id, agent, scope, project, source_session, source_turn, messages_json, request_hash, chunk_version, created_at)
    values (7, 'writer', 'project', 'alpha', 'session', 'turn', ?, ?, 'raw-v1', '2026-01-01T00:00:00.000Z')`).run(JSON.stringify(messages), "a".repeat(64));
  db.prepare(`insert into memories(id, content, kind, scope, project, agent, pinned, created_at, deleted_at, content_hash, embedding, embedding_embedder_id, embedding_state,
    source_id, message_index, chunk_index, source_start, source_end, chunk_version)
    values (?, ?, 'fact', 'project', 'alpha', 'writer', 1, '2026-01-01T00:00:00.000Z', ?, ?, ?, 'model', 'ready', ?, ?, ?, ?, ?, ?)`)
    .run(41, "raw text", null, null, Buffer.from(new Float32Array([1, 0]).buffer), 7, 0, 0, 0, 8, "raw-v1");
  for (const [id, content, deleted] of [[42, "kept", null], [43, "deleted", "2026-02-01T00:00:00.000Z"]] as const) {
    db.prepare(`insert into memories(id, content, kind, scope, project, agent, created_at, deleted_at, content_hash)
      values (?, ?, 'fact', 'project', 'alpha', 'writer', '2026-01-01T00:00:00.000Z', ?, ?)`).run(id, content, deleted, memoryContentHash(content));
  }
  db.prepare("insert into deleted_memory_sources values (?)").run("b".repeat(64));
  const tables = ["memories", "memory_sources", "deleted_memory_sources"];
  const before = tables.map((table) => db.prepare(`select * from ${table} order by 1`).all() as Record<string, unknown>[]);
  const store = new SqliteMetadataStore(db);
  await store.migrate(); await store.migrate();
  for (const [index, table] of tables.entries()) {
    const after = db.prepare(`select * from ${table} order by 1`).all() as Record<string, unknown>[];
    expect(after.map((row, position) => Object.fromEntries(Object.keys(before[index]![position]!).map((key) => [key, row[key]])))).toEqual(before[index]);
  }
  expect(await store.getMemory(41)).toMatchObject({ originProject: null, assignedProject: "alpha", recallPolicy: "project", recallPolicySource: "legacy" });
  expect(await store.getMemorySource(7)).toMatchObject({ originProject: null, assignedProject: "alpha", recallPolicy: "project", recallPolicySource: "legacy" });
  expect(await store.getMemoryRecallSettings()).toEqual({ revision: 1, dataRevision: 1, rules: [] });
});
