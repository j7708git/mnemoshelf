import { describe, expect, it } from "vitest";
import { openDatabase, SqliteMetadataStore } from "../src/index.js";
import { MIGRATIONS, migration0007ChunkMedia } from "../src/adapters/sqlite/migrations/index.js";

describe("SQLite 音訊定位遷移", () => {
  it("舊資料庫升級保留原資料，重跑不覆寫既有定位", async () => {
    const db = openDatabase(":memory:");
    try {
      db.exec("create table schema_migrations(version text primary key, applied_at text not null)");
      for (const migration of MIGRATIONS.slice(0, 6)) {
        migration.up(db);
        db.prepare("insert into schema_migrations values (?, ?)").run(migration.id, "2026-11-08T00:00:00Z");
      }
      db.prepare("insert into chunks(root_id, rel_path, seq, kind, text, content_hash) values(1, 'old.txt', 0, 'text', '舊內容', 'old-hash')").run();
      const store = new SqliteMetadataStore(db);
      await store.migrate();
      const [old] = await store.getChunks([1]);
      expect(old).toMatchObject({ text: "舊內容", contentHash: "old-hash" });
      expect(old).not.toHaveProperty("media");
      const media = { startSeconds: 0, endSeconds: 2, track: "audio" as const, preprocessVersion: "v1", embedderId: "test", embeddingDim: 512 };
      const [chunk] = await store.replaceChunks(1, "sound.wav", [{ seq: 0, kind: "audio", text: null, contentHash: "audio", media }]);
      migration0007ChunkMedia.up(db);
      await store.migrate();
      expect((await store.getChunks([chunk!.id]))[0]?.media).toEqual(media);
    } finally { db.close(); }
  });
});
