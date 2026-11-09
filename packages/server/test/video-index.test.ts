/**
 * C1：server 影片接線的整合測試（preview／index／search／diagnostics／播放）。
 *
 * 用 `FakeEmbedder({ video: true })` ＋ `FakeMediaDecoder` 走完整條產品流程，不需要 ffmpeg
 * binary（CI 可跑）。覆蓋：
 * - 未設定 decoder／設定但不可用／embedder 不支援影片 三種能力狀態；
 * - preview 候選與 skip 原因、index 的具名 failed／skipped、增量重跑；
 * - `videoMaxFileBytes` 同時套用到 preview／index／播放端點；
 * - `/search` 與 MCP 的 video chunk 保留 `media.track`／時間／`frameTimesSeconds`；
 * - `/diagnostics.video` 不含任何路徑。
 *
 * 真 decoder 另以環境變數 gated（`media-real-decoder.gated.test.ts`）。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  MediaDecoderError,
  visualPreprocessingVersion,
  type IndexRootResult,
  type RootPreview,
} from "@mnemoshelf/core";
import { FakeEmbedder } from "@mnemoshelf/core/testing";
import {
  runStdio,
  type DiagnosticsResponse,
  type UnifiedSearchResult,
  type VideoCapability,
} from "../src/index.js";
import { api, makeTempDir, removeTempDir, startTestServer, TEST_TOKEN, type TestServer } from "./helpers.js";
import {
  aacStream,
  FAKE_FFMPEG_VERSION,
  FakeMediaDecoder,
  makeVideoProbe,
} from "./fake-media-decoder.js";

/** 合成「MP4」bytes（播放端點不解碼，內容不重要；只用來驗證位元組服務）。 */
function syntheticMp4(size = 4096): Buffer {
  return Buffer.alloc(size, 0x5a);
}

let server: TestServer | undefined;
let mcp: { client: Client; close(): Promise<void> } | undefined;
const tempDirs: string[] = [];
afterEach(async () => {
  await mcp?.close();
  mcp = undefined;
  await server?.close();
  server = undefined;
  while (tempDirs.length > 0) await removeTempDir(tempDirs.pop()!);
});

/** 建立含影片檔的 root 目錄（不自動加入 root）。 */
async function makeVideoRoot(files: Record<string, Buffer> = { "clip.mp4": syntheticMp4() }): Promise<string> {
  const dir = await makeTempDir("mnemoshelf-video-root-");
  tempDirs.push(dir);
  for (const [name, bytes] of Object.entries(files)) await fs.writeFile(path.join(dir, name), bytes);
  await fs.writeFile(path.join(dir, "notes.md"), "# 一般文字檔\n", "utf8");
  return dir;
}

/** 加入 root 並回傳 id。 */
async function addRoot(dir: string, modalities: string[]): Promise<number> {
  const created = await api(server!.instance, "POST", "/roots", { body: { path: dir, modalities } });
  expect(created.status).toBe(201);
  return (created.body as { id: number }).id;
}

type PreviewBody = RootPreview & { videoCapability: VideoCapability };
type SearchBody = UnifiedSearchResult;

describe("影片能力三態（未設定／設定但不可用／可用）", () => {
  it("未設定 decoder：video 不宣告，.mp4 以 unsupported-modality 跳過，服務正常", async () => {
    server = await startTestServer({ embedder: new FakeEmbedder({ video: true }) });
    const rootId = await addRoot(await makeVideoRoot(), ["video"]);

    const roots = await api(server.instance, "GET", "/roots");
    expect(roots.status).toBe(200);
    expect((roots.body as { video: VideoCapability }).video).toMatchObject({
      available: false,
      state: "disabled",
      reason: null,
      embedderVideo: true,
      maxFileBytes: 512 * 1024 * 1024,
      durationLimitSeconds: 600,
    });

    const preview = await api(server.instance, "POST", `/roots/${rootId}/preview`);
    expect(preview.status).toBe(200);
    const body = preview.body as PreviewBody;
    expect(body.byKind.video.count).toBe(0);
    expect(body.skipped.some((entry) => entry.reason === "unsupported-modality")).toBe(true);
    expect(body.videoCapability.state).toBe("disabled");

    const indexed = await api(server.instance, "POST", `/roots/${rootId}/index`);
    expect(indexed.status).toBe(200);
    expect((indexed.body as IndexRootResult).processed).toBe(0);
    expect((indexed.body as IndexRootResult).scanSkippedFiles?.some((entry) => entry.reason === "unsupported-modality")).toBe(true);

    const diagnostics = (await api(server.instance, "GET", "/diagnostics")).body as DiagnosticsResponse;
    expect(diagnostics.video.state).toBe("disabled");
    expect(diagnostics.video.available).toBe(false);
    expect(diagnostics.video.ffmpegVersion).toBeNull();
  });

  it("decoder 設定但不可用：preview 不列候選、index 具名 failed video-decoder-unavailable", async () => {
    const decoder = new FakeMediaDecoder({ availability: { available: false, reason: "missing-ffmpeg" } });
    server = await startTestServer({ embedder: new FakeEmbedder({ video: true }), decoder });
    const rootId = await addRoot(await makeVideoRoot(), ["video"]);

    const roots = await api(server.instance, "GET", "/roots");
    expect((roots.body as { video: VideoCapability }).video).toMatchObject({
      available: false,
      state: "unavailable",
      reason: "missing-ffmpeg",
    });

    const preview = (await api(server.instance, "POST", `/roots/${rootId}/preview`)).body as PreviewBody;
    // 不可用時預覽不宣告 video（候選 0）；原因由 videoCapability 明確回報，不讓 UI 誤以為可用。
    expect(preview.byKind.video.count).toBe(0);
    expect(preview.videoCapability).toMatchObject({ state: "unavailable", reason: "missing-ffmpeg" });

    const indexed = await api(server.instance, "POST", `/roots/${rootId}/index`);
    expect(indexed.status).toBe(200);
    const result = indexed.body as IndexRootResult;
    expect(result.processed).toBe(0);
    // 具名失敗（不是靜默 unsupported-modality、也不是整輪 500）。
    expect(result.failedFiles).toEqual([{ relPath: "clip.mp4", reason: "video-decoder-unavailable" }]);

    const diagnostics = (await api(server.instance, "GET", "/diagnostics")).body as DiagnosticsResponse;
    expect(diagnostics.video).toMatchObject({ available: false, state: "unavailable", reason: "missing-ffmpeg" });
    expect(diagnostics.video.indexing.runs).toBe(1);
    expect(diagnostics.video.indexing.failedByReason).toEqual({ "video-decoder-unavailable": 1 });
  });

  it("embedder 不支援影片：decoder 可用也不宣告；原因 embedder-video-unsupported", async () => {
    server = await startTestServer({ embedder: new FakeEmbedder(), decoder: new FakeMediaDecoder() });
    const rootId = await addRoot(await makeVideoRoot(), ["video"]);

    const preview = (await api(server.instance, "POST", `/roots/${rootId}/preview`)).body as PreviewBody;
    expect(preview.byKind.video.count).toBe(0);
    expect(preview.videoCapability).toMatchObject({
      available: false,
      state: "unavailable",
      reason: "embedder-video-unsupported",
      embedderVideo: false,
    });

    const diagnostics = (await api(server.instance, "GET", "/diagnostics")).body as DiagnosticsResponse;
    expect(diagnostics.video.state).toBe("unavailable");
    expect(diagnostics.video.reason).toBe("embedder-video-unsupported");
  });

  it("env 指向不存在的 binary：服務照常啟動、video 具名不可用、索引 failed", async () => {
    const missing = await makeTempDir("mnemoshelf-missing-bin-");
    tempDirs.push(missing);
    server = await startTestServer({
      embedder: new FakeEmbedder({ video: true }),
      env: {
        MNEMOSHELF_FFMPEG_PATH: path.join(missing, "ffmpeg-missing"),
        MNEMOSHELF_FFPROBE_PATH: path.join(missing, "ffprobe-missing"),
      },
    });
    const rootId = await addRoot(await makeVideoRoot(), ["video"]);

    const diagnostics = (await api(server.instance, "GET", "/diagnostics")).body as DiagnosticsResponse;
    expect(diagnostics.video.state).toBe("unavailable");
    expect(diagnostics.video.reason).toBe("missing-ffmpeg");
    expect(diagnostics.video.available).toBe(false);

    const indexed = await api(server.instance, "POST", `/roots/${rootId}/index`);
    expect(indexed.status).toBe(200);
    expect((indexed.body as IndexRootResult).failedFiles[0]?.reason).toBe("video-decoder-unavailable");
  });
});

describe("影片索引與搜尋（decoder 可用＋embedder 支援）", () => {
  it("preview→index→search→diagnostics→重跑未變→播放端點", async () => {
    const decoder = new FakeMediaDecoder();
    server = await startTestServer({ embedder: new FakeEmbedder({ video: true }), decoder });
    const rootId = await addRoot(await makeVideoRoot(), ["video"]);

    // preview：候選數、影片上界物件、能力可用。
    const preview = (await api(server.instance, "POST", `/roots/${rootId}/preview`)).body as PreviewBody;
    expect(preview.byKind.video.count).toBe(1);
    expect(preview.video).toMatchObject({ files: 1, durationKnown: false, includesAudioTrack: false });
    expect(preview.videoCapability).toMatchObject({
      available: true,
      state: "available",
      reason: null,
      ffmpegVersion: FAKE_FFMPEG_VERSION,
    });

    // index：8 秒影片 → 2 個視覺片段（4 秒一段）。
    const indexed = await api(server.instance, "POST", `/roots/${rootId}/index`);
    expect(indexed.status).toBe(200);
    const result = indexed.body as IndexRootResult;
    expect(result.total).toBe(1);
    expect(result.processed).toBe(1);
    expect(result.failedFiles).toEqual([]);

    // search：video chunk 的 media.track／時間／frameTimes 必須完整保留（vector 模式）。
    const found = await api(server.instance, "POST", "/search", {
      body: { query: "anything", mode: "vector", rootIds: [rootId], k: 20 },
    });
    expect(found.status).toBe(200);
    const hits = (found.body as SearchBody).hits.filter((hit) => hit.type === "chunk");
    expect(hits).toHaveLength(2);
    for (const hit of hits) {
      if (hit.type !== "chunk") continue;
      expect(hit.kind).toBe("video");
      expect(hit.media).toBeDefined();
      expect(hit.media?.track).toBe("video");
      expect(hit.media?.container).toBe("mp4");
      expect(hit.media?.frameTimesSeconds).toHaveLength(1);
      expect(hit.media?.preprocessVersion).toContain(visualPreprocessingVersion());
      expect(hit.media?.preprocessVersion).toContain("n9.0.2-fake");
    }
    const starts = hits.map((hit) => (hit.type === "chunk" ? hit.media?.startSeconds : undefined)).sort((a, b) => (a ?? 0) - (b ?? 0));
    expect(starts).toEqual([0, 4]);

    // diagnostics：能力＋索引統計；不含路徑／檔名。
    const diagnostics = (await api(server.instance, "GET", "/diagnostics")).body as DiagnosticsResponse;
    expect(diagnostics.video).toMatchObject({
      available: true,
      state: "available",
      maxFileBytes: 512 * 1024 * 1024,
      durationLimitSeconds: 600,
    });
    expect(diagnostics.video.indexing.runs).toBe(1);
    expect(typeof diagnostics.video.indexing.lastFinishedAt).toBe("string");
    expect(diagnostics.video.indexing.previewCandidateFiles).toBe(1);
    expect(diagnostics.video.indexing.failedByReason).toEqual({});
    const serialized = JSON.stringify(diagnostics.video);
    expect(serialized).not.toContain("clip.mp4");
    expect(serialized).not.toContain(tempDirs[0] ?? "\u0000");

    // 未變重跑：增量跳過（不重新解碼／嵌入）。
    const rerun = await api(server.instance, "POST", `/roots/${rootId}/index`);
    expect((rerun.body as IndexRootResult).skippedUnchanged).toBe(1);
    const afterRerun = (await api(server.instance, "GET", "/diagnostics")).body as DiagnosticsResponse;
    expect(afterRerun.video.indexing.runs).toBe(2);

    // 播放端點：同一個 root／path 可讀（受 token 與 root 守衛；見 media-http.test.ts 的 Range 細節）。
    const playback = await fetch(
      `${server.instance.url}/roots/${rootId}/media?path=${encodeURIComponent("clip.mp4")}`,
      { headers: { authorization: `Bearer ${TEST_TOKEN}`, range: "bytes=0-99" } },
    );
    expect(playback.status).toBe(206);
    expect(playback.headers.get("content-type")).toBe("video/mp4");
    expect((await playback.arrayBuffer()).byteLength).toBe(100);
  });

  it("video＋audio：影片音軌片段保留 track=video-audio 與 streamIndex", async () => {
    const probe = makeVideoProbe({
      hasAudio: true,
      audioStreams: [aacStream(1)],
      selectedAudio: aacStream(1),
    });
    const decoder = new FakeMediaDecoder({ probeResult: probe });
    server = await startTestServer({
      embedder: new FakeEmbedder({ video: true, audio: true }),
      decoder,
    });
    const rootId = await addRoot(await makeVideoRoot(), ["video", "audio"]);

    const indexed = await api(server.instance, "POST", `/roots/${rootId}/index`);
    expect(indexed.status).toBe(200);
    expect((indexed.body as IndexRootResult).processed).toBe(1);

    const found = await api(server.instance, "POST", "/search", {
      body: { query: "anything", mode: "vector", rootIds: [rootId], k: 20 },
    });
    const hits = (found.body as SearchBody).hits.filter((hit) => hit.type === "chunk");
    // 8 秒：2 個畫面片段＋1 個 10 秒音軌片段（尾段）。
    expect(hits).toHaveLength(3);
    const audioHit = hits.find((hit) => hit.type === "chunk" && hit.media?.track === "video-audio");
    expect(audioHit).toBeDefined();
    if (audioHit?.type === "chunk") {
      expect(audioHit.kind).toBe("audio");
      expect(audioHit.media?.streamIndex).toBe(1);
      expect(audioHit.media?.startSeconds).toBe(0);
      expect(audioHit.media?.endSeconds).toBe(8);
    }
    const visualHit = hits.find((hit) => hit.type === "chunk" && hit.media?.track === "video");
    expect(visualHit?.type === "chunk" ? visualHit.media?.frameTimesSeconds : undefined).toHaveLength(1);
  });

  it("videoMaxFileBytes（env）同時套用到 preview／index／播放端點", async () => {
    const decoder = new FakeMediaDecoder();
    server = await startTestServer({
      embedder: new FakeEmbedder({ video: true }),
      decoder,
      env: { MNEMOSHELF_VIDEO_MAX_FILE_BYTES: "1024" },
    });
    const rootId = await addRoot(
      await makeVideoRoot({ "small.mp4": syntheticMp4(512), "big.mp4": syntheticMp4(2048) }),
      ["video"],
    );

    const preview = (await api(server.instance, "POST", `/roots/${rootId}/preview`)).body as PreviewBody;
    expect(preview.videoCapability.maxFileBytes).toBe(1024);
    expect(preview.byKind.video.count).toBe(1);
    expect(preview.skipped.some((entry) => entry.relPath === "big.mp4" && entry.reason === "video-too-large")).toBe(true);

    const indexed = await api(server.instance, "POST", `/roots/${rootId}/index`);
    const result = indexed.body as IndexRootResult;
    expect(result.processed).toBe(1);
    expect(result.scanSkippedFiles?.some((entry) => entry.relPath === "big.mp4" && entry.reason === "video-too-large")).toBe(true);

    const diagnostics = (await api(server.instance, "GET", "/diagnostics")).body as DiagnosticsResponse;
    expect(diagnostics.video.maxFileBytes).toBe(1024);
    expect(diagnostics.video.indexing.scanSkippedByReason).toEqual({ "video-too-large": 1 });

    const tooLarge = await fetch(
      `${server.instance.url}/roots/${rootId}/media?path=${encodeURIComponent("big.mp4")}`,
      { headers: { authorization: `Bearer ${TEST_TOKEN}` } },
    );
    expect(tooLarge.status).toBe(413);
  });

  it("deterministic 媒體問題 → skipped（invalid-video），不是 failed", async () => {
    const decoder = new FakeMediaDecoder({ probeError: new MediaDecoderError("invalid-video") });
    server = await startTestServer({ embedder: new FakeEmbedder({ video: true }), decoder });
    const rootId = await addRoot(await makeVideoRoot(), ["video"]);

    const indexed = await api(server.instance, "POST", `/roots/${rootId}/index`);
    expect(indexed.status).toBe(200);
    const result = indexed.body as IndexRootResult;
    expect(result.processed).toBe(0);
    expect(result.failedFiles).toEqual([]);
    expect(result.skippedFiles).toEqual([{ relPath: "clip.mp4", reason: "invalid-video" }]);

    const diagnostics = (await api(server.instance, "GET", "/diagnostics")).body as DiagnosticsResponse;
    expect(diagnostics.video.indexing.skippedByReason).toEqual({ "invalid-video": 1 });
    expect(diagnostics.video.indexing.failedByReason).toEqual({});
  });

  it("MCP search 轉發 video chunk 的 media.track／時間／frameTimes", async () => {
    const decoder = new FakeMediaDecoder();
    server = await startTestServer({ embedder: new FakeEmbedder({ video: true }), decoder });
    const rootId = await addRoot(await makeVideoRoot(), ["video"]);
    await api(server.instance, "POST", `/roots/${rootId}/index`);

    const clientToServer = new PassThrough();
    const serverToClient = new PassThrough();
    const started = await runStdio({
      env: { MNEMOSHELF_URL: server.instance.url, MNEMOSHELF_TOKEN: TEST_TOKEN },
      log: () => undefined,
      stdin: clientToServer,
      stdout: serverToClient,
    });
    const client = new Client({ name: "video-test-client", version: "0.0.0" });
    await client.connect(new StdioServerTransport(serverToClient, clientToServer));
    mcp = {
      client,
      async close() {
        await client.close();
        await started.server.close();
      },
    };

    const toolResult = await client.callTool({
      name: "search",
      arguments: { query: "anything", mode: "vector", rootIds: [rootId], k: 20 },
    });
    expect(toolResult.isError).toBeFalsy();
    const content = (toolResult as { content?: { type?: string; text?: string }[] }).content;
    const text = content?.[0]?.type === "text" ? content[0].text : undefined;
    expect(typeof text).toBe("string");
    const parsed = JSON.parse(text!) as SearchBody;
    const hits = parsed.hits.filter((hit) => hit.type === "chunk");
    expect(hits.length).toBe(2);
    for (const hit of hits) {
      if (hit.type !== "chunk") continue;
      expect(hit.media?.track).toBe("video");
      expect(hit.media?.frameTimesSeconds).toHaveLength(1);
      expect(typeof hit.media?.startSeconds).toBe("number");
      expect(typeof hit.media?.endSeconds).toBe("number");
    }
  });
});