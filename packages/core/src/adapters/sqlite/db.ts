import Database from "better-sqlite3";
import { load as loadSqliteVec } from "sqlite-vec";
import { selectRows, type SqliteDatabase } from "./driver.js";
import { MIGRATIONS, type Migration } from "./migrations/index.js";

/** 預設向量維度（embedder-contract.md：EmbeddingGemma 2 截斷為 512 維）。 */
export const DEFAULT_DIM = 512;

/** 載入 sqlite-vec 擴充（載入後 `vec0` 虛擬表與 vec_* 函式才可用）。 */
export function loadVectorExtension(db: SqliteDatabase): void {
  loadSqliteVec(db);
}

/**
 * 開啟資料庫連線：載入 sqlite-vec、設定 pragma（外鍵、WAL）。
 * `file` 省略時使用 in-memory 資料庫。
 */
export function openDatabase(file = ":memory:", options: { readonly?: boolean } = {}): SqliteDatabase {
  const readonly = options.readonly === true;
  const db = readonly ? new Database(file, { readonly: true, fileMustExist: true }) : new Database(file);

  db.pragma("foreign_keys = ON");
  if (!readonly) {
    // WAL：一寫多讀（spike Q7 實測可行）。
    db.pragma("journal_mode = WAL");
  }
  loadVectorExtension(db);
  return db;
}

/**
 * 套用未執行的遷移；已套用者略過，因此可重複呼叫（冪等）。
 * 版本記錄在 `schema_migrations`。
 */
export function runMigrations(db: SqliteDatabase): void {
  db.exec(`
    create table if not exists schema_migrations (
      version text primary key,
      applied_at text not null
    );
  `);

  const applied = new Set(selectRows(db, "select version from schema_migrations").map((row) => String(row.version)));
  const record = db.prepare("insert into schema_migrations(version, applied_at) values (?, ?)");

  const applyPending = db.transaction((migrations: readonly Migration[]) => {
    for (const migration of migrations) {
      if (applied.has(migration.id)) continue;
      migration.up(db);
      record.run(migration.id, new Date().toISOString());
      applied.add(migration.id);
    }
  });

  applyPending(MIGRATIONS);
}
