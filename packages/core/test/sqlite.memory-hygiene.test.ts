/**
 * 卡 C2：SQLite `memories.content_hash` 的**升級路徑**與寫入測試（migration 0004）。
 *
 * 契約測試（`runMetadataStoreContract`）已涵蓋去重／legacy 正規化／硬刪除的語意；這裡補
 * 「舊資料庫升級到有 content_hash 的 schema」這條路徑與欄位層級的不變量：
 * 既有列（含已軟刪除者）要能回填、`addMemory`／`addMemoryUnlessDuplicate` 都要寫入 hash、
 * 遷移可重複呼叫且不覆寫已回填的值。全部使用 in-memory 合成資料。
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  memoryContentHash,
  openDatabase,
  SqliteMetadataStore,
  type SqliteDatabase,
} from "../src/index.js";
import {
  migration0001Init,
  migration0002MemoryPinned,
  migration0003MemoryEmbedding,
  migration0004MemoryContentHash,
} from "../src/adapters/sqlite/migrations/index.js";

const opened: SqliteDatabase[] = [];

/** 造一個「0003 之後、0004 之前」的資料庫（已有一筆未刪除、一筆已軟刪除的記憶）。 */
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
  const record = db.prepare("insert into schema_migrations(version, applied_at) values (?, ?)");
  record.run("0001_init", "2026-10-01T00:00:00.000Z");
  record.run("0002_memory_pinned", "2026-10-14T00:00:00.000Z");
  record.run("0003_memory_embedding", "2026-10-18T00:00:00.000Z");
  db.exec(`
    insert into memories(content, kind, scope, project, agent, supersedes, pinned, created_at, deleted_at)
    values ('  舊記憶的第一行\r\n\r\n第二行  ', 'fact', 'global', 'legacy-proj', 'legacy-agent', null, 0,
            '2026-10-01T00:00:00.000Z', null);
    insert into memories(content, kind, scope, project, agent, supersedes, pinned, created_at, deleted_at)
    values ('已軟刪除的舊記憶', 'pitfall', 'project', 'legacy-proj', 'legacy-agent', null, 0,
            '2026-10-02T00:00:00.000Z', '2026-10-03T00:00:00.000Z');
  `);
  return db;
}

/** 讀出某列的 content_hash（測試刻意直接查欄位；公開 `Memory` 不暴露 hash）。 */
function readHash(db: SqliteDatabase, content: string): unknown {
  const row = db.prepare("select content_hash from memories where content = ?").get(content) as
    | { content_hash: unknown }
    | undefined;
  return row?.content_hash;
}

afterEach(() => {
  for (const db of opened.splice(0)) db.close();
});

describe("SQLite 記憶內容 hash（0004 migration）", () => {
  it("既有資料庫升級：補上 content_hash 欄位與索引，並回填所有既有列（含已軟刪除）", async () => {
    const db = makeLegacyDb();
    const store = new SqliteMetadataStore(db);
    await store.migrate();

    const columns = (db.prepare("pragma table_info(memories)").all() as { name: string }[]).map((row) => row.name);
    expect(columns).toContain("content_hash");
    const indexes = (db.prepare("pragma index_list(memories)").all() as { name: string }[]).map((row) => row.name);
    expect(indexes).toContain("idx_memories_content_hash");

    // 回填的是「正規化後內容」的 hash（空白／換行不影響）。
    expect(readHash(db, "  舊記憶的第一行\r\n\r\n第二行  ")).toBe(memoryContentHash("舊記憶的第一行 第二行"));
    expect(readHash(db, "已軟刪除的舊記憶")).toBe(memoryContentHash("已軟刪除的舊記憶"));

    // 公開讀取行為不變：Memory 不帶 hash，資料照常讀得到。
    expect((await store.listMemories()).map((memory) => memory.content)).toEqual(["  舊記憶的第一行\r\n\r\n第二行  "]);
    expect(await store.getMemory(2)).toMatchObject({ deletedAt: "2026-10-03T00:00:00.000Z" });

    // 回填完成後沒有任何 null。
    expect(db.prepare("select count(*) as n from memories where content_hash is null").get()).toEqual({ n: 0 });
  });

  it("migration 可重複呼叫：不重複加欄位、不覆寫已回填的 hash", async () => {
    const db = makeLegacyDb();
    const store = new SqliteMetadataStore(db);
    await store.migrate();
    const before = readHash(db, "已軟刪除的舊記憶");

    // 直接再跑一次 0004 的 up（模擬中斷後重跑）與 store.migrate()（schema_migrations 已記錄）。
    migration0004MemoryContentHash.up(db);
    await store.migrate();
    await store.migrate();

    expect(readHash(db, "已軟刪除的舊記憶")).toBe(before);
    expect(db.prepare("select count(*) as n from memories").get()).toEqual({ n: 2 });
  });

  it("全新資料庫：addMemory 與 addMemoryUnlessDuplicate 都會寫入正規化後的 hash", async () => {
    const db = openDatabase(":memory:");
    opened.push(db);
    const store = new SqliteMetadataStore(db);
    await store.migrate();

    const created = await store.addMemory({
      content: "  兩行\r\n內容  ",
      kind: "fact",
      scope: "global",
      project: null,
      agent: "hash-agent",
      supersedes: null,
    });
    expect(readHash(db, "  兩行\r\n內容  ")).toBe(memoryContentHash("兩行 內容"));

    // 去重路徑的新增也寫 hash。
    const unique = await store.addMemoryUnlessDuplicate({
      content: "去重路徑的內容",
      kind: "decision",
      scope: "project",
      project: "proj-hash",
      agent: "hash-agent",
      supersedes: null,
    });
    expect(unique.duplicate).toBe(false);
    expect(readHash(db, "去重路徑的內容")).toBe(memoryContentHash("去重路徑的內容"));

    // 同一內容再走一次去重 → 不新增、既有列（含 hash）不變。
    const duplicate = await store.addMemoryUnlessDuplicate({
      content: "去重路徑的內容\n",
      kind: "fact",
      scope: "project",
      project: "proj-hash",
      agent: "hash-agent",
      supersedes: null,
    });
    expect(duplicate.duplicate).toBe(true);
    expect(duplicate.memory.id).toBe(unique.memory.id);
    expect(db.prepare("select count(*) as n from memories").get()).toEqual({ n: 2 });
    expect(created.id).not.toBe(unique.memory.id);
  });
});
