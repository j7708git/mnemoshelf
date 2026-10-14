import { afterAll, beforeAll, describe } from "vitest";
import { Pool } from "pg";
import { runMetadataStoreContract } from "@mnemoshelf/core/testing";
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
});
