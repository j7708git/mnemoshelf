import { afterAll, beforeAll, describe } from "vitest";
import { Pool } from "pg";
import { runMemoryLibraryContract, runMemorySourceStoreContract, runMetadataStoreContract } from "@mnemoshelf/core/testing";
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
    return new PgMetadataStore(pool, { schema });
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
});
