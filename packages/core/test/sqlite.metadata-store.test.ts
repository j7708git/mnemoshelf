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
});

afterEach(() => {
  for (const db of opened.splice(0)) db.close();
});
