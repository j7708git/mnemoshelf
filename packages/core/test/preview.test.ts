import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDatabase, previewRoot, SqliteMetadataStore, type SqliteDatabase } from "../src/index.js";

let base = "";
let rootPath = "";
let mdBytes = 0;
let tsBytes = 0;

beforeAll(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), "mnemoshelf-preview-"));
  rootPath = path.join(base, "root");
  await fs.mkdir(path.join(rootPath, "code"), { recursive: true });

  await fs.writeFile(path.join(rootPath, "a.md"), "# 標題\n\n一份文件");
  await fs.writeFile(path.join(rootPath, "code", "b.ts"), "export const answer = 42;\n");
  await fs.writeFile(path.join(rootPath, "img.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await fs.writeFile(path.join(rootPath, ".env"), "SECRET=1");
  await fs.writeFile(path.join(rootPath, "big.txt"), "x".repeat(5000));

  mdBytes = (await fs.stat(path.join(rootPath, "a.md"))).size;
  tsBytes = (await fs.stat(path.join(rootPath, "code", "b.ts"))).size;
});

afterAll(async () => {
  await fs.rm(base, { recursive: true, force: true });
});

describe("previewRoot", () => {
  it("統計與實際檔案相符，並回報各類型分佈", async () => {
    const preview = await previewRoot({ path: rootPath, modalities: ["text", "code"], maxFileBytes: 1000 });

    expect(preview.totalFiles).toBe(2);
    expect(preview.totalBytes).toBe(mdBytes + tsBytes);
    expect(preview.byKind.text).toEqual({ count: 1, bytes: mdBytes });
    expect(preview.byKind.code).toEqual({ count: 1, bytes: tsBytes });
    expect(preview.byKind.image).toEqual({ count: 0, bytes: 0 });
  });

  it("skipped 原因正確（blocked／modality-off／too-large）", async () => {
    const preview = await previewRoot({ path: rootPath, modalities: ["text", "code"], maxFileBytes: 1000 });
    expect(preview.skipped).toContainEqual({ relPath: ".env", reason: "blocked" });
    expect(preview.skipped).toContainEqual({ relPath: "img.png", reason: "modality-off" });
    expect(preview.skipped).toContainEqual({ relPath: "big.txt", reason: "too-large" });
  });

  it("開啟 image 模態後圖片納入統計", async () => {
    const preview = await previewRoot({ path: rootPath, modalities: ["text", "code", "image"], maxFileBytes: 1000 });
    expect(preview.byKind.image.count).toBe(1);
    expect(preview.skipped.some((entry) => entry.relPath === "img.png")).toBe(false);
  });

  it("estimatedChunks／estimatedSeconds 是合理的預估數字", async () => {
    const preview = await previewRoot({ path: rootPath, modalities: ["text", "code"] });
    expect(preview.estimatedChunks).toBeGreaterThan(0);
    expect(preview.estimatedSeconds).toBe(Math.ceil(preview.estimatedChunks / 8));
  });

  it("root 內的 `.gitignore` 是目錄時，視為沒有可讀的 .gitignore（不拋 EISDIR）", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mnemoshelf-preview-eisdir-"));
    try {
      await fs.mkdir(path.join(dir, ".gitignore"));
      await fs.writeFile(path.join(dir, "note.md"), "# 標題\n\n內容");

      const preview = await previewRoot({ path: dir, modalities: ["text", "code"] });
      expect(preview.totalFiles).toBe(1);
      expect(preview.byKind.text.count).toBe(1);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("預覽不寫入任何 DB", async () => {
    const db: SqliteDatabase = openDatabase(":memory:");
    try {
      const store = new SqliteMetadataStore(db);
      await store.migrate();
      await previewRoot({ path: rootPath, modalities: ["text", "code", "image"] });
      expect(await store.listRoots()).toEqual([]);
      expect(await store.searchKeyword("標題", {}, 10)).toEqual([]);
    } finally {
      db.close();
    }
  });
});
