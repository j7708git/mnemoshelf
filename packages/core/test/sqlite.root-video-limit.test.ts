/**
 * SQLite 0008 遷移：per-root 影片上限（nullable）的升級與冪等性。
 *
 * 重點：
 * - 0007 的舊資料庫（roots 沒有 `video_max_file_bytes`）升級後，舊 row 可讀且**不出現**該鍵
 *   （不補 512 MiB：預設值屬呼叫端語意）；
 * - 遷移可重複呼叫（冪等）；
 * - 升級後可寫入／清除上限，並在重跑遷移後保留。
 */
import { describe, expect, it } from "vitest";
import { openDatabase, SqliteMetadataStore } from "../src/index.js";
import { MIGRATIONS, migration0008RootVideoMaxFileBytes } from "../src/adapters/sqlite/migrations/index.js";

/** 建到 0007 的舊資料庫，插入一筆沒有影片上限的 root，回傳 id 與 store。 */
async function openOldDatabase(): Promise<{ db: ReturnType<typeof openDatabase>; store: SqliteMetadataStore; rootId: number }> {
  const db = openDatabase(":memory:");
  db.exec("create table schema_migrations(version text primary key, applied_at text not null)");
  for (const migration of MIGRATIONS.slice(0, 7)) {
    migration.up(db);
    db.prepare("insert into schema_migrations values (?, ?)").run(migration.id, "2026-11-08T00:00:00Z");
  }
  db.prepare(
    `insert into roots(path, mode, modalities, include_rules, exclude_rules, respect_gitignore, watch, created_at)
     values ('old/root', 'index', '["text","video"]', '[]', '[]', 1, 0, '2026-11-08T00:00:00Z')`,
  ).run();
  const rootId = Number((db.prepare("select id from roots where path = 'old/root'").get() as { id: number }).id);
  return { db, store: new SqliteMetadataStore(db), rootId };
}

describe("SQLite 0008 root 影片上限遷移", () => {
  it("0007 舊資料庫升級：舊 row 可讀、欄位不存在；寫入後保留", async () => {
    const { db, store, rootId } = await openOldDatabase();
    try {
      // 升級前沒有欄位。
      expect(db.prepare("pragma table_info(roots)").all().map((row) => String((row as { name: unknown }).name))).not.toContain(
        "video_max_file_bytes",
      );

      await store.migrate();
      const migrated = await store.getRoot(rootId);
      expect(migrated).not.toBeNull();
      expect(migrated).not.toHaveProperty("videoMaxFileBytes");
      expect(migrated?.path).toBe("old/root");
      expect(migrated?.modalities).toEqual(["text", "video"]);

      // 升級後可寫入；重跑遷移不覆寫。
      const updated = await store.updateRoot(rootId, { videoMaxFileBytes: 3 * 1024 ** 3 });
      expect(updated?.videoMaxFileBytes).toBe(3 * 1024 ** 3);
      await store.migrate();
      migration0008RootVideoMaxFileBytes.up(db);
      expect((await store.getRoot(rootId))?.videoMaxFileBytes).toBe(3 * 1024 ** 3);

      // 清除後欄位消失。
      expect((await store.updateRoot(rootId, { videoMaxFileBytes: null }))?.videoMaxFileBytes).toBeUndefined();
      expect(await store.getRoot(rootId)).not.toHaveProperty("videoMaxFileBytes");
    } finally {
      db.close();
    }
  });

  it("新資料庫：addRoot 帶上限／不帶上限都正確往返", async () => {
    const db = openDatabase(":memory:");
    try {
      const store = new SqliteMetadataStore(db);
      await store.migrate();
      const withLimit = await store.addRoot({
        path: "new/root-a",
        mode: "index",
        modalities: ["text", "video"],
        include: [],
        exclude: [],
        respectGitignore: true,
        watch: false,
        videoMaxFileBytes: 1024,
      });
      expect(withLimit.videoMaxFileBytes).toBe(1024);
      expect((await store.getRoot(withLimit.id))?.videoMaxFileBytes).toBe(1024);

      const withoutLimit = await store.addRoot({
        path: "new/root-b",
        mode: "index",
        modalities: ["text"],
        include: [],
        exclude: [],
        respectGitignore: true,
        watch: false,
      });
      expect(withoutLimit).not.toHaveProperty("videoMaxFileBytes");
      // 兩次 migrate 都不影響資料。
      await store.migrate();
      expect((await store.listRoots()).map((root) => root.videoMaxFileBytes)).toEqual([1024, undefined]);
    } finally {
      db.close();
    }
  });
});
