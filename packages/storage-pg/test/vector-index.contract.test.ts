import { afterAll, beforeAll, describe } from "vitest";
import { Pool } from "pg";
import { runVectorIndexContract } from "@mnemoshelf/core/testing";
import { PgVectorIndex } from "../src/index.js";
import { createFreshSchema, PG_ENABLED, startPgContainer, type StartedPgContainer } from "./helpers.js";

/** 契約測試用的向量維度（與 SQLite 後端的預設一致）。 */
const TEST_DIM = 512;

/**
 * VectorIndex 的 PostgreSQL 契約測試（`docs/storage-ports.md`）。
 *
 * 由 `MNEMOSHELF_PG=1` 閘控；未設時整個 suite skip（見 `helpers.ts`）。
 * 每個測試用一個全新 schema，factory 建立 schema、migrate（擴充＋表＋HNSW 索引）後回傳 index。
 */
describe.skipIf(!PG_ENABLED)("PostgreSQL VectorIndex（需 MNEMOSHELF_PG=1）", () => {
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

  runVectorIndexContract("postgres", async () => {
    if (pool === undefined) throw new Error("連線池尚未初始化（beforeAll 未執行）");
    const schema = await createFreshSchema(pool);
    const index = new PgVectorIndex(pool, { schema, dim: TEST_DIM });
    await index.migrate();
    return index;
  });
});
