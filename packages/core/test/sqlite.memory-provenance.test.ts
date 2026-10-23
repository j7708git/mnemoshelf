/**
 * D4a：SQLite 記憶來源欄位（`source_session`／`source_message`）的**升級路徑**測試
 * （migration 0005）。
 *
 * 契約測試（`runMetadataStoreContract`）已涵蓋寫入／讀回的語意；這裡補「舊資料庫升級」：
 * 0004 版、已有資料列（含已軟刪除者）的資料庫跑完遷移後，資料列數與內容不變、新欄位為 NULL，
 * 且遷移可重複呼叫。全部使用 in-memory 合成資料。
 */
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, SqliteMetadataStore, type SqliteDatabase } from "../src/index.js";
import {
  migration0001Init,
  migration0002MemoryPinned,
  migration0003MemoryEmbedding,
  migration0004MemoryContentHash,
  migration0005MemoryProvenance,
} from "../src/adapters/sqlite/migrations/index.js";

const opened: SqliteDatabase[] = [];

/** 造一個「0004 之後、0005 之前」的資料庫（一筆未刪除、一筆已軟刪除的記憶）。 */
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
  migration0003MemoryEmbedding.up(db);
  migration0004MemoryContentHash.up(db);
  const record = db.prepare("insert into schema_migrations(version, applied_at) values (?, ?)");
  record.run("0001_init", "2026-10-01T00:00:00.000Z");
  record.run("0002_memory_pinned", "2026-10-14T00:00:00.000Z");
  record.run("0003_memory_embedding", "2026-10-18T00:00:00.000Z");
  record.run("0004_memory_content_hash", "2026-10-19T00:00:00.000Z");
  db.exec(`
    insert into memories(content, kind, scope, project, agent, supersedes, pinned, created_at, deleted_at)
    values ('舊記憶 kept', 'fact', 'global', null, 'legacy-agent', null, 1,
            '2026-10-01T00:00:00.000Z', null);
    insert into memories(content, kind, scope, project, agent, supersedes, pinned, created_at, deleted_at)
    values ('舊記憶 deleted', 'pitfall', 'project', 'legacy-proj', 'legacy-agent', null, 0,
            '2026-10-02T00:00:00.000Z', '2026-10-03T00:00:00.000Z');
  `);
  return db;
}

/** 全部資料列（升級前後比對用；包含新欄位，升級前應不存在）。 */
function dumpRows(db: SqliteDatabase): Record<string, unknown>[] {
  return db.prepare("select * from memories order by id").all() as Record<string, unknown>[];
}

afterEach(() => {
  for (const db of opened.splice(0)) db.close();
});

describe("SQLite 記憶來源欄位（0005 migration）", () => {
  it("既有資料庫升級：補上兩個可空欄位、資料列數與內容不變、新欄位為 NULL", async () => {
    const db = makeLegacyDb();
    const before = dumpRows(db);
    expect(before).toHaveLength(2);

    const store = new SqliteMetadataStore(db);
    await store.migrate();

    const columns = (db.prepare("pragma table_info(memories)").all() as { name: string }[]).map((row) => row.name);
    expect(columns).toContain("source_session");
    expect(columns).toContain("source_message");

    // 資料列數與既有欄位內容不變（只多了兩個 NULL 欄位）。
    const after = dumpRows(db);
    expect(after).toHaveLength(before.length);
    for (const [index, row] of after.entries()) {
      const previous = before[index]!;
      for (const [key, value] of Object.entries(previous)) {
        expect(row[key], `欄位 ${key} 不應被遷移改動`).toEqual(value);
      }
      expect(row.source_session).toBeNull();
      expect(row.source_message).toBeNull();
    }

    // 公開讀取：舊資料照常讀得到，來源欄位是 null（不是空字串）。
    const kept = (await store.listMemories()).find((memory) => memory.content === "舊記憶 kept");
    expect(kept).toMatchObject({ sourceSession: null, sourceMessage: null, pinned: true });
    expect(await store.getMemory(2)).toMatchObject({
      content: "舊記憶 deleted",
      sourceSession: null,
      sourceMessage: null,
      deletedAt: "2026-10-03T00:00:00.000Z",
    });
  });

  it("migration 可重複呼叫：不重複加欄位、不覆寫既有來源值", async () => {
    const db = makeLegacyDb();
    const store = new SqliteMetadataStore(db);
    await store.migrate();

    const created = await store.addMemory({
      content: "升級後帶來源的新記憶",
      kind: "fact",
      scope: "global",
      project: null,
      agent: "provenance-agent",
      supersedes: null,
      sourceSession: "session-keep",
      sourceMessage: "message-keep",
    });

    // 直接再跑一次 0005 的 up（模擬中斷後重跑）與 store.migrate()（schema_migrations 已記錄）。
    migration0005MemoryProvenance.up(db);
    await store.migrate();
    await store.migrate();

    expect(await store.getMemory(created.id)).toMatchObject({
      sourceSession: "session-keep",
      sourceMessage: "message-keep",
    });
    expect(db.prepare("select count(*) as n from memories").get()).toEqual({ n: 3 });
  });

  it("全新資料庫：addMemory 與 addMemoryUnlessDuplicate 都寫入來源欄位；未帶則為 NULL", async () => {
    const db = openDatabase(":memory:");
    opened.push(db);
    const store = new SqliteMetadataStore(db);
    await store.migrate();

    const withSource = await store.addMemory({
      content: "全新資料庫的來源記憶",
      kind: "decision",
      scope: "global",
      project: null,
      agent: "provenance-agent",
      supersedes: null,
      sourceSession: "session-new",
      sourceMessage: "message-new",
    });
    expect(withSource).toMatchObject({ sourceSession: "session-new", sourceMessage: "message-new" });

    const withoutSource = await store.addMemory({
      content: "全新資料庫沒有來源的記憶",
      kind: "fact",
      scope: "global",
      project: null,
      agent: "provenance-agent",
      supersedes: null,
    });
    expect(withoutSource).toMatchObject({ sourceSession: null, sourceMessage: null });

    const dedup = await store.addMemoryUnlessDuplicate({
      content: "去重路徑的來源記憶",
      kind: "preference",
      scope: "global",
      project: null,
      agent: "provenance-agent",
      supersedes: null,
      sourceSession: "session-dedup",
      sourceMessage: null,
    });
    expect(dedup).toMatchObject({
      duplicate: false,
      memory: { sourceSession: "session-dedup", sourceMessage: null },
    });
  });
});
