import { afterEach } from "vitest";
import { SqliteMetadataStore, openDatabase, type SqliteDatabase } from "../src/index.js";
import { runMetadataStoreContract } from "../src/testing/index.js";

const opened: SqliteDatabase[] = [];

// 契約測試以 "sqlite" 為名註冊（輸出可見 `MetadataStore contract (sqlite)`）。
// 每個測試都開一條全新的 in-memory 連線，彼此獨立。
runMetadataStoreContract("sqlite", () => {
  const db = openDatabase(":memory:");
  opened.push(db);
  return new SqliteMetadataStore(db);
}, async (store, input) => {
  const memory = await store.addMemory({ ...input, scope: "global", project: null });
  const db = opened.at(-1)!;
  db.prepare("update memories set scope = ?, project = ?, assigned_project = ?, recall_policy = ?, recall_policy_source = 'legacy' where id = ?")
    .run(input.scope, input.project, input.project, input.scope, memory.id);
  return (await store.getMemory(memory.id))!;
});

afterEach(() => {
  for (const db of opened.splice(0)) db.close();
});
