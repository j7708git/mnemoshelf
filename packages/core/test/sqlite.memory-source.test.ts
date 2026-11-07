import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  chunkMemorySourceMessages,
  memorySourceRequestHash,
  openDatabase,
  RAW_MEMORY_CHUNK_VERSION,
  SqliteMetadataStore,
  type NewMemorySource,
  type SqliteDatabase,
} from "../src/index.js";
import { MIGRATIONS } from "../src/adapters/sqlite/migrations/index.js";
import { runMemorySourceStoreContract } from "../src/testing/index.js";

const opened: SqliteDatabase[] = [];

runMemorySourceStoreContract("sqlite", () => {
  const db = openDatabase();
  opened.push(db);
  return {
    store: new SqliteMetadataStore(db),
    async failSecondChunkInsert(enabled) {
      if (enabled) {
        db.exec(`
          create trigger fail_second_chunk before insert on memories
          when new.chunk_index = 1 begin select raise(abort, 'test_chunk_insert'); end`);
      } else {
        db.exec("drop trigger fail_second_chunk");
      }
    },
    async failPolicyUpdate() {
      db.exec(`
        create trigger fail_policy_update before update on memory_policy
        begin select raise(abort, 'test_policy_update'); end`);
    },
  };
});

afterEach(() => {
  for (const db of opened.splice(0)) db.close();
});

it("重新開啟 SQLite 檔後保留政策版本", async () => {
  const tmp = join(import.meta.dirname, "..", "..", "..", ".tmp");
  mkdirSync(tmp, { recursive: true });
  const dir = mkdtempSync(join(tmp, "memory-policy-"));
  const file = join(dir, "test.sqlite");
  try {
    const initial = openDatabase(file);
    try {
      const store = new SqliteMetadataStore(initial);
      await store.migrate();
      await store.setMemoryPolicy(false);
    } finally {
      initial.close();
    }
    const reopened = openDatabase(file);
    try {
      const store = new SqliteMetadataStore(reopened);
      await store.migrate();
      expect(await store.getMemoryPolicy()).toEqual({ maskSecrets: false, version: 2 });
      expect(await store.setMemoryPolicy(true)).toEqual({ maskSecrets: true, version: 3 });
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("SQLite 損毀的政策資料明確失敗", async () => {
  const db = openDatabase();
  opened.push(db);
  const store = new SqliteMetadataStore(db);
  await store.migrate();
  db.pragma("ignore_check_constraints = ON");
  db.prepare("insert into memory_policy (id, mask_secrets, version) values (1, 2, 1)").run();
  await expect(store.getMemoryPolicy()).rejects.toThrow("記憶遮罩政策資料不合法");
  await expect(store.setMemoryPolicy(false)).rejects.toThrow("記憶遮罩政策資料不合法");
});

it("SQLite 從 0005 升級保留舊資料與 id，只補六個空的來源欄位", async () => {
  const db = openDatabase();
  opened.push(db);
  db.exec("create table schema_migrations (version text primary key, applied_at text not null)");
  const createdAt = "2026-11-06T00:00:00.000Z";
  const record = db.prepare("insert into schema_migrations (version, applied_at) values (?, ?)");
  for (const migration of MIGRATIONS.slice(0, 5)) {
    migration.up(db);
    record.run(migration.id, createdAt);
  }
  db.prepare(`
    insert into memories (id, content, kind, scope, agent, source_session, source_message, created_at)
    values (42, '舊版內容', 'fact', 'global', 'legacy', 'session', 'message', ?)`).run(createdAt);
  const store = new SqliteMetadataStore(db);
  await store.migrate();
  await store.migrate();
  expect(await store.getMemory(42)).toMatchObject({
    id: 42, content: "舊版內容", sourceSession: "session", sourceMessage: "message", createdAt,
    sourceId: null, messageIndex: null, chunkIndex: null, sourceStart: null, sourceEnd: null, chunkVersion: null,
  });
  expect(await store.listMemorySourcesForExport()).toEqual([]);
  expect(await store.getMemoryPolicy()).toEqual({ maskSecrets: true, version: 1 });
});

it("硬刪除只留下事件雜湊，寫入失敗及硬刪除都不留下 SQLite FTS 列", async () => {
  const db = openDatabase();
  opened.push(db);
  const store = new SqliteMetadataStore(db);
  await store.migrate();
  const payload = {
    agent: "test-agent", scope: "global", project: null, sourceSession: "test-session", sourceTurn: "test-turn",
    messages: [
      { sourceMessage: "one", role: "user", content: "第一個片段", occurredAt: null },
      { sourceMessage: "two", role: "assistant", content: "第二個片段", occurredAt: null },
    ],
  } satisfies Omit<NewMemorySource, "requestHash" | "chunkVersion">;
  const input = { ...payload, requestHash: memorySourceRequestHash(payload), chunkVersion: RAW_MEMORY_CHUNK_VERSION };
  const chunks = chunkMemorySourceMessages(payload.messages);
  db.exec(`
    create trigger fail_second_chunk before insert on memories
    when new.chunk_index = 1 begin select raise(abort, 'test_chunk_insert'); end`);
  await expect(store.addMemorySource(input, chunks)).rejects.toThrow("test_chunk_insert");
  expect(db.prepare("select rowid from memories_fts").all()).toEqual([]);
  db.exec("drop trigger fail_second_chunk");
  const { source } = await store.addMemorySource(input, chunks);
  expect(db.prepare("select rowid from memories_fts").all()).toHaveLength(2);
  expect(await store.deleteMemorySource(source.id, true)).toBe(true);
  expect(db.prepare("select rowid from memories_fts").all()).toEqual([]);
  const tombstones = db.prepare("select * from deleted_memory_sources").all();
  expect(tombstones).toEqual([{ event_key_hash: expect.stringMatching(/^[0-9a-f]{64}$/) }]);
  expect(tombstones).not.toEqual([{ event_key_hash: input.requestHash }]);
});
