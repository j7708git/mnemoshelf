/**
 * C4a：per-root 影片大小上限（持久化與 API）的整合測試。
 *
 * 覆蓋：
 * - `POST /roots`／`PATCH /roots/:id` 接受 `videoMaxFileBytes`（number 設定、null 清除）、驗證 1–16 GiB；
 * - `GET /roots`／`GET /roots/:id` 回傳持久化值；未設定時欄位不存在；
 * - 生效值優先序：root 設定 → 行程層 `MNEMOSHELF_VIDEO_MAX_FILE_BYTES` → 512 MiB；
 * - preview／index／播放端點三處使用**同一個** per-root 生效值。
 *
 * 用 fake decoder＋FakeEmbedder，不需要 ffmpeg。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { IndexRootResult, Root, RootPreview } from "@mnemoshelf/core";
import { FakeEmbedder } from "@mnemoshelf/core/testing";
import type { DiagnosticsResponse } from "../src/index.js";
import { api, makeTempDir, removeTempDir, startTestServer, TEST_TOKEN, type TestServer } from "./helpers.js";
import { FakeMediaDecoder } from "./fake-media-decoder.js";

const GIB = 1024 * 1024 * 1024;

let server: TestServer | undefined;
const tempDirs: string[] = [];
afterEach(async () => {
  await server?.close();
  server = undefined;
  while (tempDirs.length > 0) await removeTempDir(tempDirs.pop()!);
});

/** 建立含兩個合成 mp4（512／2048 bytes）的 root 目錄。 */
async function makeVideoRoot(): Promise<string> {
  const dir = await makeTempDir("mnemoshelf-root-video-limit-");
  tempDirs.push(dir);
  await fs.writeFile(path.join(dir, "small.mp4"), Buffer.alloc(512, 0x11));
  await fs.writeFile(path.join(dir, "big.mp4"), Buffer.alloc(2048, 0x22));
  return dir;
}

async function startVideoServer(env: NodeJS.ProcessEnv = {}): Promise<void> {
  server = await startTestServer({
    embedder: new FakeEmbedder({ video: true }),
    decoder: new FakeMediaDecoder(),
    env,
  });
}

async function addVideoRoot(body: Record<string, unknown>): Promise<Root> {
  const dir = await makeVideoRoot();
  const created = await api(server!.instance, "POST", "/roots", { body: { path: dir, modalities: ["video"], ...body } });
  expect(created.status).toBe(201);
  return created.body as Root;
}

async function getRoot(id: number): Promise<Root> {
  const response = await api(server!.instance, "GET", `/roots/${id}`);
  expect(response.status).toBe(200);
  return response.body as Root;
}

async function mediaStatus(id: number, relPath: string): Promise<number> {
  const response = await fetch(
    `${server!.instance.url}/roots/${id}/media?path=${encodeURIComponent(relPath)}`,
    { headers: { authorization: `Bearer ${TEST_TOKEN}` } },
  );
  return response.status;
}

describe("POST／PATCH／GET：per-root 影片上限持久化", () => {
  it("POST 帶上限 → 回應與 GET 都回傳；未帶／null → 欄位不存在", async () => {
    await startVideoServer();
    const configured = await addVideoRoot({ videoMaxFileBytes: 2 * GIB });
    expect(configured.videoMaxFileBytes).toBe(2 * GIB);
    expect((await getRoot(configured.id)).videoMaxFileBytes).toBe(2 * GIB);

    const listed = (await api(server!.instance, "GET", "/roots")).body as { roots: Root[] };
    expect(listed.roots.find((root) => root.id === configured.id)?.videoMaxFileBytes).toBe(2 * GIB);

    // 未帶與 null 都是「未設定」：物件不得出現該鍵（不補 512 MiB）。
    const plain = await addVideoRoot({});
    expect(plain).not.toHaveProperty("videoMaxFileBytes");
    expect(await getRoot(plain.id)).not.toHaveProperty("videoMaxFileBytes");
    const explicitNull = await addVideoRoot({ videoMaxFileBytes: null });
    expect(explicitNull).not.toHaveProperty("videoMaxFileBytes");
  });

  it("PATCH：可只改上限（modalities 不變）、可與 modalities 一起改、null 清除", async () => {
    await startVideoServer();
    const root = await addVideoRoot({ modalities: ["text", "video"] });
    expect(root.videoMaxFileBytes).toBeUndefined();

    // 只給 videoMaxFileBytes：modalities 必須維持不變。
    const patched = await api(server!.instance, "PATCH", `/roots/${root.id}`, { body: { videoMaxFileBytes: 1024 } });
    expect(patched.status).toBe(200);
    const afterSet = patched.body as Root;
    expect(afterSet.videoMaxFileBytes).toBe(1024);
    expect(afterSet.modalities).toEqual(["text", "video"]);
    expect((await getRoot(root.id)).videoMaxFileBytes).toBe(1024);

    // 兩個欄位一起改。
    const both = await api(server!.instance, "PATCH", `/roots/${root.id}`, {
      body: { modalities: ["video"], videoMaxFileBytes: 4096 },
    });
    expect(both.status).toBe(200);
    expect((both.body as Root).modalities).toEqual(["video"]);
    expect((both.body as Root).videoMaxFileBytes).toBe(4096);

    // null＝清除（回行程層預設）。
    const cleared = await api(server!.instance, "PATCH", `/roots/${root.id}`, { body: { videoMaxFileBytes: null } });
    expect(cleared.status).toBe(200);
    expect(cleared.body as Root).not.toHaveProperty("videoMaxFileBytes");
    expect(await getRoot(root.id)).not.toHaveProperty("videoMaxFileBytes");

    // 之後只改 modalities 不得把已清除的狀態變成別的值。
    await api(server!.instance, "PATCH", `/roots/${root.id}`, { body: { modalities: ["text", "video"] } });
    expect(await getRoot(root.id)).not.toHaveProperty("videoMaxFileBytes");
  });

  it("值域 1–16 GiB：邊界可寫；0／負數／小數／超過／非數字 → 400 且不改資料", async () => {
    await startVideoServer();
    const min = await addVideoRoot({ videoMaxFileBytes: 1 });
    expect(min.videoMaxFileBytes).toBe(1);
    const max = await addVideoRoot({ videoMaxFileBytes: 16 * GIB });
    expect(max.videoMaxFileBytes).toBe(16 * GIB);

    const dir = await makeVideoRoot();
    // JSON 表達不了 NaN／Infinity（會被序列化成 null），那些值改在 core 契約測試直接驗證。
    const invalidValues: unknown[] = [0, -1, 1.5, 16 * GIB + 1, "1024", {}];
    for (const value of invalidValues) {
      const created = await api(server!.instance, "POST", "/roots", {
        body: { path: dir, modalities: ["video"], videoMaxFileBytes: value },
      });
      expect(created.status, String(value)).toBe(400);
      expect((created.body as { error: { name: string } }).error.name).toBe("ValidationError");
    }

    // PATCH 非法值：400 且既有值不變。
    for (const value of invalidValues) {
      const patched = await api(server!.instance, "PATCH", `/roots/${max.id}`, { body: { videoMaxFileBytes: value } });
      expect(patched.status, String(value)).toBe(400);
    }
    expect((await getRoot(max.id)).videoMaxFileBytes).toBe(16 * GIB);

    // 空物件（兩個欄位都沒提供）→ 400。
    const empty = await api(server!.instance, "PATCH", `/roots/${max.id}`, { body: {} });
    expect(empty.status).toBe(400);
  });
});

describe("生效值優先序：root → env → 512 MiB（preview／index／media 同值）", () => {
  it("root 設定覆寫 env；PATCH 後 preview／index／media 同步改變；清除後回 env", async () => {
    // 行程層預設 1 KiB：root 沒設定時 big.mp4（2048 bytes）會被擋。
    await startVideoServer({ MNEMOSHELF_VIDEO_MAX_FILE_BYTES: "1024" });

    const fallback = await addVideoRoot({});
    const fallbackPreview = (await api(server!.instance, "POST", `/roots/${fallback.id}/preview`)).body as RootPreview;
    expect(fallbackPreview.byKind.video.count).toBe(1);
    expect(fallbackPreview.skipped.some((entry) => entry.relPath === "big.mp4" && entry.reason === "video-too-large")).toBe(true);
    expect(await mediaStatus(fallback.id, "big.mp4")).toBe(413);

    // PATCH 放大到 4 KiB：preview 不再跳過、media 可讀、index 兩支都處理。
    const patched = await api(server!.instance, "PATCH", `/roots/${fallback.id}`, { body: { videoMaxFileBytes: 4096 } });
    expect(patched.status).toBe(200);
    const preview = (await api(server!.instance, "POST", `/roots/${fallback.id}/preview`)).body as RootPreview;
    expect(preview.byKind.video.count).toBe(2);
    expect(preview.skipped).toEqual([]);
    expect(await mediaStatus(fallback.id, "big.mp4")).toBe(200);
    const indexed = await api(server!.instance, "POST", `/roots/${fallback.id}/index`);
    expect(indexed.status).toBe(200);
    expect((indexed.body as IndexRootResult).processed).toBe(2);

    // 清除 → 回到 env 1 KiB：media 與 preview 都回到被擋。
    await api(server!.instance, "PATCH", `/roots/${fallback.id}`, { body: { videoMaxFileBytes: null } });
    expect(await mediaStatus(fallback.id, "big.mp4")).toBe(413);
    const clearedPreview = (await api(server!.instance, "POST", `/roots/${fallback.id}/preview`)).body as RootPreview;
    expect(clearedPreview.skipped.some((entry) => entry.relPath === "big.mp4" && entry.reason === "video-too-large")).toBe(true);

    // diagnostics 的每個 root 都回報實際生效值（root 未設定 → env 1024）。
    const diagnostics = (await api(server!.instance, "GET", "/diagnostics")).body as DiagnosticsResponse;
    expect(diagnostics.roots.find((root) => root.id === fallback.id)?.videoMaxFileBytes).toBe(1024);
    expect(diagnostics.video.maxFileBytes).toBe(1024); // 服務層預設（env）
  });

  it("root 設定優先於 env（index 的有界快照也吃同一個值）", async () => {
    await startVideoServer({ MNEMOSHELF_VIDEO_MAX_FILE_BYTES: "1024" });
    const configured = await addVideoRoot({ videoMaxFileBytes: 4096 });

    // env 只有 1 KiB，但這個 root 是 4 KiB：兩支都納入。
    const preview = (await api(server!.instance, "POST", `/roots/${configured.id}/preview`)).body as RootPreview;
    expect(preview.byKind.video.count).toBe(2);
    const indexed = await api(server!.instance, "POST", `/roots/${configured.id}/index`);
    expect((indexed.body as IndexRootResult).processed).toBe(2);
    expect(await mediaStatus(configured.id, "big.mp4")).toBe(200);

    const diagnostics = (await api(server!.instance, "GET", "/diagnostics")).body as DiagnosticsResponse;
    expect(diagnostics.roots.find((root) => root.id === configured.id)?.videoMaxFileBytes).toBe(4096);
  });

  it("重啟後仍保留（資料庫持久化，不是行程記憶體）", async () => {
    const dataDir = await makeTempDir("mnemoshelf-root-video-restart-");
    tempDirs.push(dataDir);
    const env = { MNEMOSHELF_VIDEO_MAX_FILE_BYTES: "1024" };

    server = await startTestServer({ embedder: new FakeEmbedder({ video: true }), decoder: new FakeMediaDecoder(), dataDir, env });
    const root = await addVideoRoot({ videoMaxFileBytes: 4096 });
    expect((await getRoot(root.id)).videoMaxFileBytes).toBe(4096);
    await server.close();

    // 同一份 SQLite 資料目錄重開：值必須從資料庫讀回（不是行程內 Map）。
    server = await startTestServer({ embedder: new FakeEmbedder({ video: true }), decoder: new FakeMediaDecoder(), dataDir, env });
    expect((await getRoot(root.id)).videoMaxFileBytes).toBe(4096);
    expect(await mediaStatus(root.id, "big.mp4")).toBe(200);
    const preview = (await api(server.instance, "POST", `/roots/${root.id}/preview`)).body as RootPreview;
    expect(preview.byKind.video.count).toBe(2);
  });

  it("沒有 env 時 fallback 512 MiB（一般大小的檔案都可用）", async () => {
    await startVideoServer();
    const root = await addVideoRoot({});
    const diagnostics = (await api(server!.instance, "GET", "/diagnostics")).body as DiagnosticsResponse;
    expect(diagnostics.video.maxFileBytes).toBe(512 * 1024 * 1024);
    expect(diagnostics.roots.find((item) => item.id === root.id)?.videoMaxFileBytes).toBe(512 * 1024 * 1024);
    expect(await mediaStatus(root.id, "big.mp4")).toBe(200);
  });
});
