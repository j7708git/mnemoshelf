/**
 * 卡 B1：SQLite 記憶向量欄位的**升級路徑**測試（migration 0003）。
 *
 * 契約測試（`runMetadataStoreContract`）已涵蓋四個新方法的語意；這裡補「從卡 A 的舊 schema
 * 升級到卡 B1」這條路徑：既有資料庫要能補上向量欄位、既有資料預設 `pending`、已軟刪除者
 * 不列入回填、`migrate()` 重複呼叫不會重複加欄位。全部使用 in-memory 合成資料。
 */
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, SqliteMetadataStore, type SqliteDatabase } from "../src/index.js";
import { migration0001Init, migration0002MemoryPinned } from "../src/adapters/sqlite/migrations/index.js";

const opened: SqliteDatabase[] = [];

/** 造一個「卡 A 之後、卡 B1 之前」的資料庫（只有 0001／0002，且已有一筆記憶）。 */
function makeLegacyDb(): SqliteDatabase {
  const db = openDatabase(":memory:");
  opened.push(db);
  db.exec(`
    create table schema_migrations (
      version text primary key,
      applied_at text not null
    );
  `);
  migration0001Init.up(db);
  migration0002MemoryPinned.up(db);
  const record = db.prepare("insert into schema_migrations(version, applied_at) values (?, ?)");
  record.run("0001_init", "2026-10-01T00:00:00.000Z");
  record.run("0002_memory_pinned", "2026-10-14T00:00:00.000Z");
  db.exec(`
    insert into memories(content, kind, scope, project, agent, supersedes, pinned, created_at, deleted_at)
    values ('既有記憶', 'fact', 'project', 'legacy-proj', 'legacy-agent', null, 0, '2026-10-01T00:00:00.000Z', null);
  `);
  return db;
}

afterEach(() => {
  for (const db of opened.splice(0)) db.close();
});

describe("SQLite 記憶向量欄位（0003 migration）", () => {
  it("既有資料庫升級：補上向量欄位，既有資料預設 pending 且可寫入向量", async () => {
    const db = makeLegacyDb();
    const store = new SqliteMetadataStore(db);
    await store.migrate();

    // 舊資料仍讀得到（公開 Memory 不變），且列為待嵌入。
    expect((await store.listMemories()).map((memory) => memory.content)).toEqual(["既有記憶"]);
    expect(await store.memoryEmbeddingStats("legacy-embedder@test")).toEqual({
      total: 1,
      pending: 1,
      ready: 0,
      failed: 0,
      tooLong: 0,
      stale: 0,
    });
    const needing = await store.listMemoriesNeedingEmbedding("legacy-embedder@test");
    expect(needing.map((memory) => memory.content)).toEqual(["既有記憶"]);

    // 升級後的資料庫可以正常寫入向量。
    await store.markMemoryEmbedded(needing[0]!.id, "legacy-embedder@test", new Float32Array([0.25, 0.5]));
    expect(await store.memoryEmbeddingStats("legacy-embedder@test")).toMatchObject({ ready: 1, pending: 0 });
  });

  it("已軟刪除的既有資料預設 pending，但不列入統計與待嵌清單", async () => {
    const db = makeLegacyDb();
    db.exec("update memories set deleted_at = '2026-10-02T00:00:00.000Z'");
    const store = new SqliteMetadataStore(db);
    await store.migrate();

    expect(await store.memoryEmbeddingStats("legacy-embedder@test")).toEqual({
      total: 0,
      pending: 0,
      ready: 0,
      failed: 0,
      tooLong: 0,
      stale: 0,
    });
    expect(await store.listMemoriesNeedingEmbedding("legacy-embedder@test")).toEqual([]);
  });

  it("migrate() 重複呼叫不會重複加欄位，也不會改掉既有狀態", async () => {
    const db = makeLegacyDb();
    const store = new SqliteMetadataStore(db);
    await store.migrate();
    const first = await store.listMemoriesNeedingEmbedding("legacy-embedder@test");
    await store.markMemoryEmbedded(first[0]!.id, "legacy-embedder@test", new Float32Array([0.1, 0.2]));
    const before = await store.memoryEmbeddingStats("legacy-embedder@test");

    await store.migrate();

    expect(await store.memoryEmbeddingStats("legacy-embedder@test")).toEqual(before);
    const columns = db
      .prepare<unknown[], { name: string }>("pragma table_info(memories)")
      .all()
      .map((row) => row.name);
    for (const column of ["embedding", "embedding_embedder_id", "embedding_state"]) {
      expect(columns.filter((name) => name === column)).toHaveLength(1);
    }
  });
});
