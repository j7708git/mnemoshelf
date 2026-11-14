import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { runMemoryLibraryContract, runMemoryOrganizationContract, runMemorySourceStoreContract, runMetadataStoreContract } from "@mnemoshelf/core/testing";
import { PgMetadataStore } from "../src/index.js";
import { createFreshSchema, PG_ENABLED, startPgContainer, type StartedPgContainer } from "./helpers.js";

/**
 * MetadataStore 的 PostgreSQL 契約測試（`docs/storage-ports.md`）。
 *
 * 由 `MNEMOSHELF_PG=1` 閘控；未設時整個 suite skip（見 `helpers.ts`）。
 * 每個測試用一個全新 schema，factory 非同步建立 schema 後回傳 store。
 */
describe.skipIf(!PG_ENABLED)("PostgreSQL MetadataStore（需 MNEMOSHELF_PG=1）", () => {
  let container: StartedPgContainer | undefined;
  let pool: Pool | undefined;
  const schemas = new WeakMap<object, string>();

  beforeAll(async () => {
    container = await startPgContainer();
    pool = new Pool({ connectionString: container.getConnectionUri() });
  });

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  runMetadataStoreContract("postgres", async () => {
    if (pool === undefined) throw new Error("連線池尚未初始化（beforeAll 未執行）");
    const schema = await createFreshSchema(pool);
    const store = new PgMetadataStore(pool, { schema });
    schemas.set(store, schema);
    return store;
  }, async (store, input) => {
    const memory = await store.addMemory({ ...input, scope: "global", project: null });
    await pool!.query(`update "${schemas.get(store)!}".memories set scope = $1, project = $2, assigned_project = $2, recall_policy = $1, recall_policy_source = 'legacy' where id = $3`,
      [input.scope, input.project, memory.id]);
    return (await store.getMemory(memory.id))!;
  });

  runMemorySourceStoreContract("postgres", async () => {
    if (pool === undefined) throw new Error("連線池尚未初始化（beforeAll 未執行）");
    const connection = pool;
    const schema = await createFreshSchema(connection);
    return {
      store: new PgMetadataStore(connection, { schema }),
      async failSecondChunkInsert(enabled) {
        if (enabled) {
          await connection.query(`
            create function "${schema}".fail_chunk_insert() returns trigger language plpgsql as $$
            begin raise exception 'test_chunk_insert'; end; $$;
            create trigger fail_second_chunk before insert on "${schema}".memories
            for each row when (new.chunk_index = 1) execute function "${schema}".fail_chunk_insert()`);
        } else {
          await connection.query(`drop trigger fail_second_chunk on "${schema}".memories`);
        }
      },
      async failPolicyUpdate() {
        await connection.query(`
          create function "${schema}".fail_policy_update() returns trigger language plpgsql as $$
          begin raise exception 'test_policy_update'; end; $$;
          create trigger fail_policy_update before update on "${schema}".memory_policy
          for each row execute function "${schema}".fail_policy_update()`);
      },
    };
  });

  runMemoryLibraryContract("postgres", async () => {
    if (pool === undefined) throw new Error("連線池尚未初始化（beforeAll 未執行）");
    const schema = await createFreshSchema(pool);
    return new PgMetadataStore(pool, { schema });
  });
  runMemoryOrganizationContract("postgres", async () => {
    if (pool === undefined) throw new Error("連線池尚未初始化（beforeAll 未執行）");
    const schema = await createFreshSchema(pool);
    const connection = pool;
    return { store: new PgMetadataStore(pool, { schema }), async failOrganizationUpdate() {
      await connection.query(`create function "${schema}".fail_organization_update() returns trigger language plpgsql as $$
        begin raise exception 'organization_update_failed'; end; $$;
        create trigger fail_organization_update before update on "${schema}".memories for each row
        when (new.recall_policy = 'disabled' and old.chunk_index = 1) execute function "${schema}".fail_organization_update();`);
    } };
  });

  it("既有 PG schema 升級保留所有舊欄、向量、來源雜湊與 tombstone", async () => {
    if (pool === undefined) throw new Error("連線池尚未初始化");
    const schema = await createFreshSchema(pool);
    const store = new PgMetadataStore(pool, { schema });
    await store.migrate();
    // 移除本階段所有追加物件，回到此前 schema 再建立合成舊列。
    for (const table of ["memories", "memory_sources"]) {
      await pool.query(`drop trigger recall_insert_delete on "${schema}".${table}; drop trigger recall_update on "${schema}".${table};`);
      for (const column of ["origin_project", "assigned_project", "recall_policy", "recall_policy_source", "recall_rule_id", "recall_rule_revision"]) {
        await pool.query(`alter table "${schema}".${table} drop column ${column} cascade`);
      }
    }
    await pool.query(`alter table "${schema}".memories drop column dedupe_scope, drop column dedupe_project;
      drop function "${schema}".memory_recall_changed(); drop table "${schema}".memory_recall_settings;`);
    const messages = [{ sourceMessage: "msg", role: "user", content: "raw text", occurredAt: null }];
    await pool.query(`insert into "${schema}".memory_sources(id, agent, scope, project, source_session, source_turn, messages_json, request_hash, chunk_version, created_at)
      overriding system value values (7, 'writer', 'project', 'alpha', 'session', 'turn', $1, $2, 'raw-v1', '2026-01-01T00:00:00.000Z')`, [JSON.stringify(messages), "a".repeat(64)]);
    await pool.query(`insert into "${schema}".memories(id, content, kind, scope, project, agent, pinned, created_at, content_hash, embedding, embedding_embedder_id, embedding_state,
      source_id, message_index, chunk_index, source_start, source_end, chunk_version)
      overriding system value values (41, 'raw text', 'fact', 'project', 'alpha', 'writer', true, '2026-01-01T00:00:00.000Z', null, '[1,0]', 'model', 'ready', 7, 0, 0, 0, 8, 'raw-v1');
      insert into "${schema}".memories(id, content, kind, scope, project, agent, created_at, deleted_at, content_hash)
      overriding system value values (42, 'kept', 'fact', 'project', 'alpha', 'writer', '2026-01-01T00:00:00.000Z', null, 'existing-hash'),
        (43, 'deleted', 'fact', 'project', 'alpha', 'writer', '2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z', 'deleted-hash');`);
    await pool.query(`insert into "${schema}".deleted_memory_sources values ($1)`, ["b".repeat(64)]);
    const tables = ["memories", "memory_sources", "deleted_memory_sources"];
    const before: Array<Record<string, unknown>[]> = [];
    for (const table of tables) before.push((await pool.query(`select * from "${schema}".${table} order by 1`)).rows);
    await store.migrate(); await store.migrate();
    for (const [index, table] of tables.entries()) {
      const after: Record<string, unknown>[] = (await pool.query(`select * from "${schema}".${table} order by 1`)).rows;
      expect(after.map((row, position) => Object.fromEntries(Object.keys(before[index]![position]!).map((key) => [key, row[key]])))).toEqual(before[index]);
    }
    expect(await store.getMemory(41)).toMatchObject({ originProject: null, assignedProject: "alpha", recallPolicy: "project", recallPolicySource: "legacy" });
    expect(await store.getMemorySource(7)).toMatchObject({ originProject: null, assignedProject: "alpha", recallPolicy: "project", recallPolicySource: "legacy" });
    expect(await store.getMemoryRecallSettings()).toEqual({ revision: 1, dataRevision: 1, rules: [] });
  });
});
