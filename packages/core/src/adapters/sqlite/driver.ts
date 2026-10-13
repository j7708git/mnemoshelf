import Database from "better-sqlite3";

/**
 * SQLite 驅動（better-sqlite3）的型別入口。
 *
 * 型別全部來自官方 `@types/better-sqlite3`（devDependency，僅型別、零執行期），
 * 沒有任何自製的結構型別。這裡只做兩件事：
 * 1. 重新匯出官方型別，讓其他模組只相依本檔一個入口；
 * 2. 提供兩個讀取輔助，把「一列查詢結果」的形狀統一在一個地方（見 `selectRows`）。
 */

/** 資料庫連線。 */
export type SqliteDatabase = Database.Database;

/** 已編譯的 SQL 敘述。 */
export type SqliteStatement = Database.Statement;

/** 一列查詢結果。 */
export type SqliteRow = Record<string, unknown>;

/**
 * 讀取多列。
 *
 * 官方型別的 `prepare<BindParameters, Result>()` 可以指定每列的形狀；本專案的 SQL 是動態
 * 組出來的（`LIMIT`、`IN (...)` 的清單長度不固定），因此統一以 `SqliteRow` 當列型別，
 * 呼叫端再用 `rowToRoot`／`rowToChunk` 等逐欄位轉成領域型別。
 */
export function selectRows(db: SqliteDatabase, sql: string, ...params: unknown[]): SqliteRow[] {
  return db.prepare<unknown[], SqliteRow>(sql).all(...params);
}

/** 讀取單列；沒有資料時回傳 undefined。 */
export function selectRow(db: SqliteDatabase, sql: string, ...params: unknown[]): SqliteRow | undefined {
  return db.prepare<unknown[], SqliteRow>(sql).get(...params);
}
