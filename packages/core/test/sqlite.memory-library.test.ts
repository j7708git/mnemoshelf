import { afterEach, expect, it } from "vitest";
import { chunkMemorySourceMessages, memorySourceRequestHash, openDatabase, RAW_MEMORY_CHUNK_VERSION, SqliteMetadataStore, type SqliteDatabase } from "../src/index.js";
import { runMemoryLibraryContract } from "../src/testing/index.js";

const opened: SqliteDatabase[] = [];
runMemoryLibraryContract("sqlite", () => {
  const db = openDatabase();
  opened.push(db);
  return new SqliteMetadataStore(db);
});
afterEach(() => { for (const db of opened.splice(0)) db.close(); });

it("舊來源片段釘選不一致時以回合聚合狀態顯示，讀取不修改原列", async () => {
  const db = openDatabase();
  opened.push(db);
  const store = new SqliteMetadataStore(db);
  await store.migrate();
  const input = {
    agent: "writer", scope: "global" as const, project: null, sourceSession: "session", sourceTurn: "turn",
    messages: ["first", "second"].map((content) => ({ sourceMessage: content, content, role: "user" as const, occurredAt: null })),
    chunkVersion: RAW_MEMORY_CHUNK_VERSION,
  };
  const raw = await store.addMemorySource({ ...input, requestHash: memorySourceRequestHash(input) }, chunkMemorySourceMessages(input.messages));
  db.prepare("update memories set pinned = 1 where id = ?").run(raw.memories[1]!.id);
  const page = await store.listMemoryLibrary();
  expect(page.entries[0]?.memory).toMatchObject({ id: raw.memories[0]!.id, pinned: true });
  expect((await store.getMemory(raw.memories[0]!.id))?.pinned).toBe(false);
});
