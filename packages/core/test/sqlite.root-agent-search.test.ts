/**
 * SQLite 0009 遷移：root 的 agent 分享開關與通用單檔上限。
 *
 * 重點：
 * - 0008 的舊資料庫（roots 沒有 `allow_agent_search`／`max_file_bytes`）升級後，
 *   既有 root 的 `allowAgentSearch` 一律 `false`，且**不出現** `maxFileBytes` 鍵
 *   （不補 10 MiB：預設值屬呼叫端語意）；
 * - 遷移可重複呼叫（冪等），重跑不覆寫已寫入的值；
 * - 升級後可寫入／清除兩欄位。
 */
import { describe, expect, it } from "vitest";
import { openDatabase, SqliteMetadataStore } from "../src/index.js";
import { MIGRATIONS, migration0009RootAgentSearchAndMaxFileBytes } from "../src/adapters/sqlite/migrations/index.js";

/** 建到 0008 的舊資料庫，插入一筆沒有新欄位的 root，回傳 id 與 store。 */
async function openOldDatabase(): Promise<{
  db: ReturnType<typeof openDatabase>;
  store: SqliteMetadataStore;
  rootId: number;
}> {
  const db = openDatabase(":memory:");
  db.exec("create table schema_migrations(version text primary key, applied_at text not null)");
  for (const migration of MIGRATIONS.slice(0, 8)) {
    migration.up(db);
    db.prepare("insert into schema_migrations values (?, ?)").run(migration.id, "2026-11-12T00:00:00Z");
  }
  db.prepare(
    `insert into roots(path, mode, modalities, include_rules, exclude_rules, respect_gitignore, watch, created_at)
     values ('old/root', 'index', '["text","code"]', '[]', '[]', 1, 0, '2026-11-12T00:00:00Z')`,
  ).run();
  const rootId = Number((db.prepare("select id from roots where path = 'old/root'").get() as { id: number }).id);
  return { db, store: new SqliteMetadataStore(db), rootId };
}

describe("SQLite 0009 root 分享開關與通用上限遷移", () => {
  it("0008 舊資料庫升級：既有 root 預設 false、通用上限欄位不存在；寫入後保留", async () => {
    const { db, store, rootId } = await openOldDatabase();
    try {
      const columns = db.prepare("pragma table_info(roots)").all().map((row) => String((row as { name: unknown }).name));
      expect(columns).not.toContain("allow_agent_search");
      expect(columns).not.toContain("max_file_bytes");

      await store.migrate();
      const migrated = await store.getRoot(rootId);
      expect(migrated).not.toBeNull();
      expect(migrated?.allowAgentSearch).toBe(false);
      expect(migrated).not.toHaveProperty("maxFileBytes");
      expect(migrated?.path).toBe("old/root");

      // 升級後可寫入；重跑遷移不覆寫。
      const updated = await store.updateRoot(rootId, { allowAgentSearch: true, maxFileBytes: 3 * 1024 ** 2 });
      expect(updated?.allowAgentSearch).toBe(true);
      expect(updated?.maxFileBytes).toBe(3 * 1024 ** 2);
      await store.migrate();
      migration0009RootAgentSearchAndMaxFileBytes.up(db);
      const reread = await store.getRoot(rootId);
      expect(reread?.allowAgentSearch).toBe(true);
      expect(reread?.maxFileBytes).toBe(3 * 1024 ** 2);

      // 清除後通用上限欄位消失；分享開關維持 true。
      const cleared = await store.updateRoot(rootId, { maxFileBytes: null });
      expect(cleared).not.toHaveProperty("maxFileBytes");
      expect(cleared?.allowAgentSearch).toBe(true);
    } finally {
      db.close();
    }
  });

  it("新資料庫：addRoot 可帶兩欄位；省略時預設 false／不補通用上限", async () => {
    const db = openDatabase(":memory:");
    try {
      const store = new SqliteMetadataStore(db);
      await store.migrate();
      const configured = await store.addRoot({
        path: "new/root-a",
        mode: "index",
        modalities: ["text"],
        include: [],
        exclude: [],
        respectGitignore: true,
        watch: false,
        allowAgentSearch: true,
        maxFileBytes: 1024,
      });
      expect(configured.allowAgentSearch).toBe(true);
      expect(configured.maxFileBytes).toBe(1024);

      const plain = await store.addRoot({
        path: "new/root-b",
        mode: "index",
        modalities: ["text"],
        include: [],
        exclude: [],
        respectGitignore: true,
        watch: false,
      });
      expect(plain.allowAgentSearch).toBe(false);
      expect(plain).not.toHaveProperty("maxFileBytes");

      // 兩次 migrate 都不影響資料。
      await store.migrate();
      const roots = await store.listRoots();
      expect(roots.map((root) => root.allowAgentSearch)).toEqual([true, false]);
      expect(roots.map((root) => root.maxFileBytes)).toEqual([1024, undefined]);
    } finally {
      db.close();
    }
  });
});
