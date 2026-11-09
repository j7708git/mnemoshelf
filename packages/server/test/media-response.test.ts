/**
 * `buildMediaResponse` 的單元測試（影片播放端點的資料層，不經 HTTP）。
 *
 * 重點：回傳的是**串流**而不是整個檔案的 Buffer（5 MiB 檔案、4 MiB 上限時只會拿到 4 MiB），
 * HEAD／416 沒有 body，且所有路徑都先過 root 守衛。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import type { Root } from "@mnemoshelf/core";
import { buildMediaResponse, MEDIA_RANGE_MAX_BYTES } from "../src/index.js";
import { makeTempDir, removeTempDir } from "./helpers.js";

const CLIP_BYTES = 5 * 1024 * 1024;

const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length > 0) await removeTempDir(dirs.pop()!);
});

function rootAt(dir: string): Root {
  return {
    id: 1,
    path: dir,
    mode: "index",
    modalities: ["video"],
    include: [],
    exclude: [],
    respectGitignore: true,
    watch: false,
    createdAt: "2026-11-08T00:00:00.000Z",
  };
}

async function makeRootWithClip(): Promise<{ root: Root; parent: string; dir: string; clip: Buffer }> {
  // 上層暫存目錄放 root 外的檔案（traversal 負向測試），避免污染系統 temp 根目錄。
  const parent = await makeTempDir("mnemoshelf-media-response-");
  dirs.push(parent);
  const dir = path.join(parent, "root");
  await fs.mkdir(dir);
  const clip = Buffer.alloc(CLIP_BYTES);
  for (let index = 0; index < clip.length; index += 1) clip[index] = index % 251;
  await fs.writeFile(path.join(dir, "clip.mp4"), clip);
  await fs.writeFile(path.join(dir, "notes.md"), "not a video");
  // root.path 契約是 realpath：手動建 Root 時也要先解析（Windows 的 temp 可能含短檔名）。
  return { root: rootAt(await fs.realpath(dir)), parent, dir, clip };
}

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

describe("buildMediaResponse", () => {
  it("無 Range → 200 整檔串流（不是整檔 Buffer）", async () => {
    const { root, clip } = await makeRootWithClip();
    const result = await buildMediaResponse(
      root,
      { relPath: "clip.mp4", rangeHeader: undefined, headOnly: false },
      { maxFileBytes: 512 * 1024 * 1024 },
    );
    expect(result.status).toBe(200);
    expect(result.headers["content-length"]).toBe(String(CLIP_BYTES));
    expect(result.stream).not.toBeNull();
    expect((await readAll(result.stream!)).equals(clip)).toBe(true);
  });

  it("開放式 Range → 206 且只回單次上限（4 MiB），串流不讀整檔", async () => {
    const { root } = await makeRootWithClip();
    const result = await buildMediaResponse(
      root,
      { relPath: "clip.mp4", rangeHeader: "bytes=0-", headOnly: false },
      { maxFileBytes: 512 * 1024 * 1024 },
    );
    expect(result.status).toBe(206);
    expect(result.headers["content-range"]).toBe(`bytes 0-${MEDIA_RANGE_MAX_BYTES - 1}/${CLIP_BYTES}`);
    expect(result.headers["content-length"]).toBe(String(MEDIA_RANGE_MAX_BYTES));
    expect((await readAll(result.stream!)).length).toBe(MEDIA_RANGE_MAX_BYTES);
  });

  it("HEAD → 只回 header（stream 為 null）", async () => {
    const { root } = await makeRootWithClip();
    const result = await buildMediaResponse(
      root,
      { relPath: "clip.mp4", rangeHeader: undefined, headOnly: true },
      { maxFileBytes: 512 * 1024 * 1024 },
    );
    expect(result.status).toBe(200);
    expect(result.stream).toBeNull();
    expect(result.headers["content-length"]).toBe(String(CLIP_BYTES));
  });

  it("416（越界）→ 沒有 body、帶 Content-Range", async () => {
    const { root } = await makeRootWithClip();
    const result = await buildMediaResponse(
      root,
      { relPath: "clip.mp4", rangeHeader: "bytes=99999999-", headOnly: false },
      { maxFileBytes: 512 * 1024 * 1024 },
    );
    expect(result.status).toBe(416);
    expect(result.stream).toBeNull();
    expect(result.headers["content-range"]).toBe(`bytes */${CLIP_BYTES}`);
    expect(result.headers["content-length"]).toBe("0");
  });

  it("非 .mp4 → UnsupportedFileTypeError；缺 path → ValidationError", async () => {
    const { root } = await makeRootWithClip();
    await expect(
      buildMediaResponse(root, { relPath: "notes.md", rangeHeader: undefined, headOnly: false }, { maxFileBytes: 512 * 1024 * 1024 }),
    ).rejects.toMatchObject({ name: "UnsupportedFileTypeError" });
    await expect(
      buildMediaResponse(root, { relPath: null, rangeHeader: undefined, headOnly: false }, { maxFileBytes: 512 * 1024 * 1024 }),
    ).rejects.toMatchObject({ name: "ValidationError" });
  });

  it("逃出 root → PathOutsideRootError（不讀 root 外內容）", async () => {
    const { root, parent } = await makeRootWithClip();
    await fs.writeFile(path.join(parent, "outside.mp4"), "outside");
    await expect(
      buildMediaResponse(
        root,
        { relPath: path.join("..", "outside.mp4"), rangeHeader: undefined, headOnly: false },
        { maxFileBytes: 512 * 1024 * 1024 },
      ),
    ).rejects.toMatchObject({ name: "PathOutsideRootError" });
  });

  it("超過單檔上限 → FileTooLargeError（與 indexer 同一個值）", async () => {
    const { root } = await makeRootWithClip();
    await expect(
      buildMediaResponse(root, { relPath: "clip.mp4", rangeHeader: undefined, headOnly: false }, { maxFileBytes: 1024 }),
    ).rejects.toMatchObject({ name: "FileTooLargeError" });
  });
});
