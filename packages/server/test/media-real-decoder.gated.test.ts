/**
 * C1：真 FFmpeg decoder 的 gated 整合測試（server → indexer → 真 probe／解碼）。
 *
 * 為什麼 gated：CI（ubuntu verify）沒有 ffmpeg binary，不能因缺檔失敗。要跑這組需要：
 * - Windows x64（A1 只驗過這個平台）；
 * - `MNEMOSHELF_FFMPEG_PATH`／`MNEMOSHELF_FFPROBE_PATH` 指向既有 LGPL 候選；
 * - `MNEMOSHELF_VIDEO_E2E_FIXTURE` 指向一個既有合成 MP4（例如 A1 的
 *   `.tmp/video-a/decoder/fixtures/h264-aac-4s.mp4`）。
 *
 * 缺任何一項整組 skip（不是失敗）。這組只驗「接線與資料形狀」；畫質／召回品質是 D 的範圍。
 */
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { IndexRootResult } from "@mnemoshelf/core";
import { FakeEmbedder } from "@mnemoshelf/core/testing";
import type { DiagnosticsResponse, UnifiedSearchResult } from "../src/index.js";
import { api, makeTempDir, removeTempDir, startTestServer, TEST_TOKEN, type TestServer } from "./helpers.js";

const ffmpegPath = process.env.MNEMOSHELF_FFMPEG_PATH ?? "";
const ffprobePath = process.env.MNEMOSHELF_FFPROBE_PATH ?? "";
const fixturePath = process.env.MNEMOSHELF_VIDEO_E2E_FIXTURE ?? "";
const gated =
  process.platform === "win32" &&
  ffmpegPath !== "" &&
  ffprobePath !== "" &&
  fixturePath !== "" &&
  existsSync(fixturePath);

const suite = gated ? describe : describe.skip;

let server: TestServer | undefined;
const tempDirs: string[] = [];
afterEach(async () => {
  await server?.close();
  server = undefined;
  while (tempDirs.length > 0) await removeTempDir(tempDirs.pop()!);
});

suite("真 FFmpeg decoder（gated）", () => {
  it("服務啟動可用性、索引真實 MP4、搜尋保留時間、Range 播放", async () => {
    const dir = await makeTempDir("mnemoshelf-video-real-");
    tempDirs.push(dir);
    await fs.copyFile(fixturePath, path.join(dir, "clip.mp4"));

    server = await startTestServer({
      embedder: new FakeEmbedder({ video: true }),
      env: { MNEMOSHELF_FFMPEG_PATH: ffmpegPath, MNEMOSHELF_FFPROBE_PATH: ffprobePath },
    });

    // 啟動時的可用性檢查結果（版本字串不含路徑）。
    const before = (await api(server.instance, "GET", "/diagnostics")).body as DiagnosticsResponse;
    expect(before.video.state).toBe("available");
    expect(before.video.ffmpegVersion).toContain("ffmpeg version");
    expect(before.video.ffprobeVersion).toContain("ffprobe version");

    const created = await api(server.instance, "POST", "/roots", { body: { path: dir, modalities: ["video"] } });
    expect(created.status).toBe(201);
    const rootId = (created.body as { id: number }).id;

    const indexed = await api(server.instance, "POST", `/roots/${rootId}/index`);
    expect(indexed.status).toBe(200);
    const result = indexed.body as IndexRootResult;
    expect(result.processed).toBe(1);
    expect(result.failedFiles).toEqual([]);

    const found = await api(server.instance, "POST", "/search", {
      body: { query: "anything", mode: "vector", rootIds: [rootId], k: 20 },
    });
    const hits = (found.body as UnifiedSearchResult).hits.filter((hit) => hit.type === "chunk");
    expect(hits.length).toBeGreaterThanOrEqual(1);
    for (const hit of hits) {
      if (hit.type !== "chunk") continue;
      expect(hit.media?.track).toBe("video");
      expect(hit.media?.frameTimesSeconds).toHaveLength(1);
      const frameTime = hit.media!.frameTimesSeconds![0]!;
      expect(frameTime).toBeGreaterThanOrEqual(hit.media!.startSeconds);
      expect(frameTime).toBeLessThanOrEqual(hit.media!.endSeconds);
    }

    // Range 播放：真 decoder 產生的索引對應的真實檔案也能透過受守衛端點讀取。
    const playback = await fetch(
      `${server.instance.url}/roots/${rootId}/media?path=${encodeURIComponent("clip.mp4")}`,
      { headers: { authorization: `Bearer ${TEST_TOKEN}`, range: "bytes=0-99" } },
    );
    expect(playback.status).toBe(206);
    expect(playback.headers.get("content-type")).toBe("video/mp4");
    expect((await playback.arrayBuffer()).byteLength).toBe(100);
  });
});
