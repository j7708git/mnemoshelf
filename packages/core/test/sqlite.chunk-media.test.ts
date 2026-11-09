import { describe, expect, it } from "vitest";
import { openDatabase, SqliteMetadataStore } from "../src/index.js";
import { MIGRATIONS, migration0007ChunkMedia } from "../src/adapters/sqlite/migrations/index.js";

describe("SQLite 媒體定位遷移（舊音訊與影片 additive）", () => {
  it("舊資料庫升級保留原資料；重跑不覆寫既有音訊／影片定位", async () => {
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

      // 音訊里程碑的形狀：沒有 container／streamIndex／frameTimesSeconds。
      const audioMedia = { startSeconds: 0, endSeconds: 2, track: "audio" as const, preprocessVersion: "v1", embedderId: "test", embeddingDim: 512 };
      const [audioChunk] = await store.replaceChunks(1, "sound.wav", [{ seq: 0, kind: "audio", text: null, contentHash: "audio", media: audioMedia }]);
      // 影片視覺／音軌的形狀：container、streamIndex、frameTimesSeconds（media_json 內 additive，不需新欄位）。
      const visualMedia = {
        startSeconds: 0, endSeconds: 4, track: "video" as const, container: "mp4" as const, frameTimesSeconds: [2],
        preprocessVersion: "video-v1", embedderId: "video-test", embeddingDim: 512,
      };
      const videoAudioMedia = {
        startSeconds: 0, endSeconds: 10, track: "video-audio" as const, container: "mp4" as const, streamIndex: 1,
        preprocessVersion: "audio-v1", embedderId: "audio-test", embeddingDim: 512,
      };
      const [visualChunk] = await store.replaceChunks(1, "clip.mp4", [
        { seq: 0, kind: "video", text: null, contentHash: "video", media: visualMedia },
        { seq: 1, kind: "audio", text: null, contentHash: "video", media: videoAudioMedia },
      ]);

      // 冪等：重跑遷移不得清掉或改寫既有定位（也不需要新 migration）。
      migration0007ChunkMedia.up(db);
      await store.migrate();
      expect((await store.getChunks([audioChunk!.id]))[0]?.media).toEqual(audioMedia);
      expect((await store.getChunks([visualChunk!.id]))[0]?.media).toEqual(visualMedia);
      expect((await store.listChunksByPath(1, "clip.mp4")).map((chunk) => chunk.media)).toEqual([visualMedia, videoAudioMedia]);
      expect((await store.getChunks([1]))[0]?.media).toBeUndefined();
    } finally { db.close(); }
  });
});
