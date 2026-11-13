/**
 * PostgreSQL 舊表升級路徑測試（卡 1B：`roots.allow_agent_search`／`max_file_bytes`）。
 *
 * 為什麼要這個測試：`metadataSchemaSql` 用 `create table if not exists` 建表，既有部署的
 * 舊表不會被重建；新欄位只靠 `alter table … add column if not exists` 補上。契約測試每次
 * 都建全新 schema，`create table` 已含新欄位，那些 `alter` 全是 no-op——真正的升級風險
 * （舊表補欄位、既有列取得預設值、之後可正常讀寫）沒有被驗證。這裡刻意先手動建立
 * 「本卡之前」的 roots 表並插入既有資料，再呼叫 `migrate()` 走一次真實升級路徑。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { PgMetadataStore } from "../src/index.js";
import { qualified } from "../src/schema.js";
import { createFreshSchema, PG_ENABLED, startPgContainer, type StartedPgContainer } from "./helpers.js";

describe.skipIf(!PG_ENABLED)("PostgreSQL roots 舊表升級（需 MNEMOSHELF_PG=1）", () => {
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

  it("舊版 roots 表由 migrate() 補上新欄位，既有列可正常讀寫", async () => {
    if (pool === undefined) throw new Error("連線池尚未初始化（beforeAll 未執行）");
    const schema = await createFreshSchema(pool);
    const roots = qualified(schema, "roots");

    // 舊版表：只含本卡之前的欄位，刻意不含 allow_agent_search 與 max_file_bytes。
    await pool.query(`
      create table ${roots} (
        id integer generated always as identity primary key,
        path text not null unique,
        mode text not null,
        modalities text not null default '[]',
        include_rules text not null default '[]',
        exclude_rules text not null default '[]',
        respect_gitignore boolean not null default true,
        watch boolean not null default false,
        created_at text not null,
        video_max_file_bytes bigint
      )`);
    await pool.query(
      `insert into ${roots} (path, mode, created_at) values ($1, 'index', $2)`,
      ["/fixture/legacy-root", "2026-01-01T00:00:00.000Z"],
    );

    const store = new PgMetadataStore(pool, { schema });
    await store.migrate();

    const [existing] = await store.listRoots();
    expect(existing).toBeDefined();
    // `allow_agent_search` 有 not null default false：既有列升級後是未分享。
    expect(existing!.allowAgentSearch).toBe(false);
    // 舊列沒有設定通用上限：回應不該出現這個鍵（契約是 optional，不是 null）。
    expect(Object.prototype.hasOwnProperty.call(existing, "maxFileBytes")).toBe(false);

    // 升級後兩個新欄位都要能正常寫入與讀回。
    const updated = await store.updateRoot(existing!.id, {
      allowAgentSearch: true,
      maxFileBytes: 5 * 1024 * 1024,
    });
    expect(updated).not.toBeNull();
    expect(updated!.allowAgentSearch).toBe(true);
    expect(updated!.maxFileBytes).toBe(5 * 1024 * 1024);

    const reread = await store.getRoot(existing!.id);
    expect(reread).toEqual(updated);
  });
});
