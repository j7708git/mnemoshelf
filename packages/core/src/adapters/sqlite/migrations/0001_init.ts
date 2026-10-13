import type { SqliteDatabase } from "../driver.js";

/** 一筆版本化遷移。`up` 必須是冪等的（用 `if not exists`）。 */
export interface Migration {
  /** 版本識別，也是 schema_migrations 的主鍵。 */
  id: string;
  up(db: SqliteDatabase): void;
}

/**
 * 0001_init：roots、chunks、memories 與兩張 FTS5 索引表。
 *
 * 全文檢索用 FTS5 的 `unicode61`，內文先經過 `segmentText`（Intl.Segmenter）斷詞，
 * 這樣兩字中文詞也能搜到。FTS 表的 rowid 對應 chunks.id / memories.id。
 *
 * 刻意不宣告外鍵：`removeRoot(deleteData=false)` 會保留 chunks 而刪除 root 資料列，
 * 以支援「先移除、之後再加回同一個 root」的流程。
 */
export const migration0001Init: Migration = {
  id: "0001_init",
  up(db: SqliteDatabase): void {
    db.exec(`
      create table if not exists roots (
        id integer primary key autoincrement,
        path text not null unique,
        mode text not null,
        modalities text not null default '[]',
        include_rules text not null default '[]',
        exclude_rules text not null default '[]',
        respect_gitignore integer not null default 1,
        watch integer not null default 0,
        created_at text not null
      );

      create table if not exists chunks (
        id integer primary key autoincrement,
        root_id integer not null,
        rel_path text not null,
        seq integer not null,
        kind text not null,
        text text,
        content_hash text not null
      );
      create index if not exists chunks_root_path_idx on chunks(root_id, rel_path);

      create table if not exists memories (
        id integer primary key autoincrement,
        content text not null,
        kind text not null,
        scope text not null,
        project text,
        agent text not null,
        supersedes integer,
        created_at text not null,
        deleted_at text
      );

      create virtual table if not exists chunks_fts using fts5(seg, tokenize = 'unicode61');
      create virtual table if not exists memories_fts using fts5(seg, tokenize = 'unicode61');
    `);
  },
};
