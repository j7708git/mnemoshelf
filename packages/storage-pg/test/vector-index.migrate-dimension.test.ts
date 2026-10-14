/**
 * `PgVectorIndex.migrate()` 的**既有欄位維度驗證**測試。
 *
 * 契約測試每個測試都用全新 schema，因此碰不到「表已存在且維度與本次 `dim` 不符」的情境；
 * 真實使用（固定 schema、跨版本重啟、dim 設定改變）會踩到，而且 `create table if not exists`
 * 不會報錯也不會改型別，若不驗證就會延到寫入／查詢才以 PostgreSQL 原始維度錯誤爆出。
 *
 * 由 `MNEMOSHELF_PG=1` 閘控（與其他契約測試同一套 helpers／image）。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { PgVectorIndex, VectorColumnDimensionError } from "../src/index.js";
import { createFreshSchema, PG_ENABLED, startPgContainer, type StartedPgContainer } from "./helpers.js";

describe.skipIf(!PG_ENABLED)("PgVectorIndex.migrate 既有欄位維度驗證（需 MNEMOSHELF_PG=1）", () => {
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

  function getPool(): Pool {
    if (pool === undefined) throw new Error("連線池尚未初始化（beforeAll 未執行）");
    return pool;
  }

  /** 直接問 PostgreSQL 既有 `vectors.embedding` 欄位的型別字串（例如 `vector(512)`）。 */
  async function readEmbeddingType(schema: string): Promise<string | undefined> {
    const result = await getPool().query(
      `select format_type(a.atttypid, a.atttypmod) as type
         from pg_attribute a
         join pg_class c on c.oid = a.attrelid
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = $1 and c.relname = 'vectors' and a.attname = 'embedding'`,
      [schema],
    );
    return result.rows[0] === undefined ? undefined : String(result.rows[0].type);
  }

  it("表不存在時照常建立，且維度相同時可重複 migrate（冪等）", async () => {
    const schema = await createFreshSchema(getPool());

    await new PgVectorIndex(getPool(), { schema, dim: 256 }).migrate();
    expect(await readEmbeddingType(schema)).toBe("vector(256)");

    // 同一實例再呼叫一次，以及模擬「重啟後以同 dim 再 migrate」的另一個實例，都應通過。
    await expect(new PgVectorIndex(getPool(), { schema, dim: 256 }).migrate()).resolves.toBeUndefined();
    await expect(new PgVectorIndex(getPool(), { schema, dim: 256 }).migrate()).resolves.toBeUndefined();
    expect(await readEmbeddingType(schema)).toBe("vector(256)");
  });

  it("既有欄位維度與本次 dim 不符時明確拋錯，訊息含期望／實際維度與 schema.表名", async () => {
    const schema = await createFreshSchema(getPool());
    await new PgVectorIndex(getPool(), { schema, dim: 512 }).migrate();

    const mismatch = new PgVectorIndex(getPool(), { schema, dim: 256 });
    const error = await mismatch.migrate().then(
      () => null,
      (thrown: unknown) => thrown,
    );

    // 必須是本套件的具名錯誤，不是 PostgreSQL 原始維度錯誤。
    expect(error).toBeInstanceOf(VectorColumnDimensionError);
    const dimensionError = error as VectorColumnDimensionError;
    expect(dimensionError.expected).toBe(256);
    expect(dimensionError.actual).toBe(512);
    expect(dimensionError.actualType).toBe("vector(512)");
    expect(dimensionError.schema).toBe(schema);
    expect(dimensionError.table).toBe("vectors");
    expect(dimensionError.message).toContain("256");
    expect(dimensionError.message).toContain("512");
    expect(dimensionError.message).toContain(schema);
    expect(dimensionError.message).toContain("vectors");

    // 只拋錯，不靜默改型別／重建表：既有欄位仍是原本的 vector(512)。
    expect(await readEmbeddingType(schema)).toBe("vector(512)");
  });

  it("既有欄位是未帶維度的 vector 時也視為不符（不靜默放行）", async () => {
    const schema = await createFreshSchema(getPool());
    // 模擬「表由他人／舊版本以無維度 vector 建立」：這種欄位什麼長度都收，
    // 若放行就會讓不同維度的向量混進同一欄，因此 migrate 必須明確失敗。
    await getPool().query(`create table "${schema}"."vectors" (key text primary key, embedding vector)`);

    const error = await new PgVectorIndex(getPool(), { schema, dim: 512 }).migrate().then(
      () => null,
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(VectorColumnDimensionError);
    const dimensionError = error as VectorColumnDimensionError;
    expect(dimensionError.actual).toBeNull();
    expect(dimensionError.actualType).toBe("vector");
    expect(dimensionError.message).toContain("512");
    expect(await readEmbeddingType(schema)).toBe("vector");
  });
});
