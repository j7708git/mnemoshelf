import { afterEach, expect, it } from "vitest";
import { DEFAULT_DIM, SqliteVectorIndex, openDatabase, type SqliteDatabase } from "../src/index.js";
import { runVectorIndexContract } from "../src/testing/index.js";

/** 契約測試用的小維度（vec0 支援任意維度；小維度讓測試更快）。 */
const TEST_DIM = 8;

const opened: SqliteDatabase[] = [];

// 契約測試以 "sqlite" 為名註冊（輸出可見 `VectorIndex contract (sqlite)`）。
runVectorIndexContract("sqlite", () => {
  const db = openDatabase(":memory:");
  opened.push(db);
  return new SqliteVectorIndex(db, TEST_DIM);
});

it("預設維度為 512", () => {
  const db = openDatabase(":memory:");
  opened.push(db);
  expect(new SqliteVectorIndex(db).dim).toBe(DEFAULT_DIM);
});

it("同一個資料庫上維度不一致時明確報錯", () => {
  const db = openDatabase(":memory:");
  opened.push(db);
  new SqliteVectorIndex(db, 8);
  expect(() => new SqliteVectorIndex(db, 512)).toThrow(/維度/);
});

afterEach(() => {
  for (const db of opened.splice(0)) db.close();
});
