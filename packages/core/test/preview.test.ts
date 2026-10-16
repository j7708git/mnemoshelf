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
    // 分解相加等於總秒數（見 PreviewEstimate 的契約）。
    expect(preview.estimated.seconds).toBe(preview.estimatedSeconds);
    expect(preview.estimated.imageSeconds).toBe(0);
    expect(preview.estimated.seconds).toBe(
      preview.estimated.textSeconds + preview.estimated.imageSeconds + preview.estimated.otherSeconds,
    );
    // 這個 root：a.md（1 塊）＋ code/b.ts（1 塊）＋ big.txt（5000 bytes ⇒ 6 塊）＝ 8 塊。
    expect(preview.estimatedChunks).toBe(8);
    expect(preview.estimated.textSeconds).toBe(4);
  });

  it("文字預估不再離譜樂觀：以實測的 2.6–2.9 塊/秒為基準反推（誤差 < 1.5×）", async () => {
    // 合成一份已知 chunk 數的語料：900 bytes/chunk ⇒ 4 塊。
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mnemoshelf-preview-text-"));
    try {
      await fs.writeFile(path.join(dir, "long.md"), "x".repeat(3600));

      const preview = await previewRoot({ path: dir, modalities: ["text"] });
      expect(preview.estimatedChunks).toBe(4);

      // 實測（x86、q4）：2.6–2.9 塊/秒 → 4 塊約 1.4–1.5 秒；預估必須**不低於**實測，
      // 且不得超過 2 倍（否則就從樂觀變成嚇人）。
      const actualSeconds = preview.estimatedChunks / 2.75;
      expect(preview.estimatedSeconds).toBeGreaterThanOrEqual(actualSeconds);
      expect(preview.estimatedSeconds).toBeLessThan(actualSeconds * 2);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("圖片預估不再低估：每張至少 2.4 秒（實測下界），1,000 張不低於 40 分鐘", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mnemoshelf-preview-image-"));
    try {
      // 用 1,000 個空 PNG 佔位檔（預覽只列舉、不讀內容，所以內容不重要）。
      const names = Array.from({ length: 1000 }, (_, index) => `photo-${String(index).padStart(4, "0")}.png`);
      for (const name of names) await fs.writeFile(path.join(dir, name), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

      const preview = await previewRoot({ path: dir, modalities: ["image"] });
      expect(preview.byKind.image.count).toBe(1000);
      // 舊模型：1,000 塊 ÷ 8 塊/秒 = 125 秒（低估 20–40 倍）。
      expect(preview.estimated.imageSeconds).toBeGreaterThanOrEqual(1000 * 2.4);
      // 也必須涵蓋實測區間上界（40–85 分鐘）的下緣。
      expect(preview.estimatedSeconds).toBeGreaterThanOrEqual(40 * 60);
      expect(preview.estimatedSeconds).toBeLessThanOrEqual(120 * 60);
      // 圖片不計入文字秒數。
      expect(preview.estimated.textSeconds).toBe(0);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
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
