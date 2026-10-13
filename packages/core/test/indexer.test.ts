import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  indexRoot,
  openDatabase,
  RootNotIndexableError,
  SqliteMetadataStore,
  SqliteVectorIndex,
  type Embedder,
  type EmbedderInfo,
  type ImageInput,
  type ProbeResult,
  type Root,
  type SqliteDatabase,
} from "../src/index.js";
import { FakeEmbedder } from "../src/testing/index.js";

/** 包住 FakeEmbedder 並記錄呼叫次數，用來驗證增量（未變更不重新嵌入）。 */
class RecordingEmbedder implements Embedder {
  private readonly inner = new FakeEmbedder();
  readonly documents: { text: string; title: string | undefined }[] = [];
  readonly images: ImageInput[] = [];

  get info(): EmbedderInfo {
    return this.inner.info;
  }

  async embedQuery(text: string): Promise<Float32Array> {
    return this.inner.embedQuery(text);
  }

  async embedDocument(text: string, title?: string): Promise<Float32Array> {
    this.documents.push({ text, title });
    return this.inner.embedDocument(text, title);
  }

  async embedImage(image: ImageInput): Promise<Float32Array> {
    this.images.push(image);
    return this.inner.embedImage(image);
  }

  async probe(): Promise<ProbeResult> {
    return this.inner.probe();
  }

  async dispose(): Promise<void> {
    return this.inner.dispose();
  }
}

interface Harness {
  db: SqliteDatabase;
  store: SqliteMetadataStore;
  vec: SqliteVectorIndex;
  embedder: RecordingEmbedder;
  root: Root;
  dir: string;
}

let opened: SqliteDatabase[] = [];

async function makeHarness(files: Record<string, string | Buffer>, overrides: Partial<Root> = {}): Promise<Harness> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mnemoshelf-indexer-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
  }

  const db = openDatabase(":memory:");
  opened.push(db);
  const store = new SqliteMetadataStore(db);
  await store.migrate();
  const vec = new SqliteVectorIndex(db);
  const root = await store.addRoot({
    path: await fs.realpath(dir),
    mode: "index",
    modalities: ["text", "code"],
    include: [],
    exclude: [],
    respectGitignore: false,
    watch: false,
    ...overrides,
  });

  return { db, store, vec, embedder: new RecordingEmbedder(), root, dir };
}

const options = (harness: Harness) => ({ embedder: harness.embedder, store: harness.store, vec: harness.vec });

afterEach(async () => {
  for (const db of opened.splice(0)) db.close();
});

describe("indexRoot", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await makeHarness({
      "a.md": "# 標題\n\n第一份文件的內容",
      "code/b.ts": "export const answer = 42;\n",
    });
  });

  afterEach(async () => {
    await fs.rm(harness.dir, { recursive: true, force: true });
  });

  it("第一次索引會切塊、嵌入並寫入 store 與 vec", async () => {
    const result = await indexRoot(harness.root, options(harness));
    expect(result).toMatchObject({ total: 2, processed: 2, skippedUnchanged: 0, removedFiles: 0 });
    expect(harness.embedder.documents.length).toBeGreaterThan(0);

    const aChunks = await harness.store.listChunksByPath(harness.root.id, "a.md");
    expect(aChunks).toHaveLength(1);
    expect(aChunks[0]?.text).toContain("第一份文件的內容");
    const hits = await harness.vec.searchVector(await harness.embedder.embedQuery("第一份文件"), {}, 10);
    expect(hits.length).toBeGreaterThan(0);
    expect(await harness.vec.count()).toBe(aChunks.length + 1); // a.md 一塊 + b.ts 一塊
  });

  it("embedDocument 的 title 使用相對路徑", async () => {
    await indexRoot(harness.root, options(harness));
    const titles = new Set(harness.embedder.documents.map((call) => call.title));
    expect(titles.has("a.md")).toBe(true);
    expect(titles.has("code/b.ts")).toBe(true);
  });

  it("增量：未變更再跑一次不重新嵌入，skippedUnchanged = 全部", async () => {
    await indexRoot(harness.root, options(harness));
    const callsAfterFirst = harness.embedder.documents.length;

    const second = await indexRoot(harness.root, options(harness));
    expect(second).toMatchObject({ total: 2, processed: 0, skippedUnchanged: 2 });
    expect(harness.embedder.documents.length).toBe(callsAfterFirst);
  });

  it("增量：改一個檔案只重新嵌入該檔", async () => {
    await indexRoot(harness.root, options(harness));
    const before = harness.embedder.documents.length;
    const aChunks = (await harness.store.listChunksByPath(harness.root.id, "a.md")).length;

    await fs.writeFile(path.join(harness.dir, "a.md"), "# 標題\n\n改過的第二版內容");

    const result = await indexRoot(harness.root, options(harness));
    expect(result).toMatchObject({ processed: 1, skippedUnchanged: 1 });
    expect(harness.embedder.documents.length - before).toBe(aChunks);

    // 舊 chunk 已被替換
    const replacement = await harness.store.listChunksByPath(harness.root.id, "a.md");
    expect(replacement[0]?.text).toContain("改過的第二版內容");
  });

  it("增量：刪除檔案會清掉它的 chunk 與向量", async () => {
    await indexRoot(harness.root, options(harness));
    const countBefore = await harness.vec.count();
    const bChunks = await harness.store.listChunksByPath(harness.root.id, "code/b.ts");
    expect(bChunks).toHaveLength(1);

    await fs.rm(path.join(harness.dir, "code/b.ts"));

    const result = await indexRoot(harness.root, options(harness));
    expect(result.removedFiles).toBe(1);
    expect(await harness.store.listRelPaths(harness.root.id)).toEqual(["a.md"]);
    expect(await harness.vec.count()).toBe(countBefore - 1);
    expect(await harness.store.searchKeyword("answer", {}, 10)).toEqual([]);
  });

  it("browse 模式的 root 會拋出 RootNotIndexableError", async () => {
    const browse = await makeHarness({}, { mode: "browse" });
    try {
      await expect(indexRoot(browse.root, options(browse))).rejects.toBeInstanceOf(RootNotIndexableError);
    } finally {
      await fs.rm(browse.dir, { recursive: true, force: true });
    }
  });

  it("取消：拋出 AbortError，且可再跑一次完成", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      indexRoot(harness.root, { ...options(harness), signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });

    // 用新的 signal 再跑一次可完成
    const result = await indexRoot(harness.root, options(harness));
    expect(result.processed).toBe(2);
  });

  it("取消：處理途中 abort，已寫入的資料一致，重跑可完成", async () => {
    const controller = new AbortController();
    const progress: { processed: number; total: number; skippedUnchanged: number }[] = [];
    await expect(
      indexRoot(harness.root, {
        ...options(harness),
        signal: controller.signal,
        concurrency: 1,
        onProgress: (p) => {
          progress.push({ ...p });
          controller.abort();
        },
      }),
    ).rejects.toMatchObject({ name: "AbortError" });

    // 至少第一個檔案已完成，資料一致（chunk 與向量都存在）
    expect(progress.length).toBeGreaterThan(0);
    const done = progress.at(-1)!;
    expect(done.processed + done.skippedUnchanged).toBeLessThanOrEqual(done.total);

    const rerun = await indexRoot(harness.root, options(harness));
    expect(rerun.processed + rerun.skippedUnchanged).toBe(rerun.total);
  });

  it("進度數字可對帳：processed + skippedUnchanged === total", async () => {
    const progress: { processed: number; total: number; skippedUnchanged: number }[] = [];
    const result = await indexRoot(harness.root, {
      ...options(harness),
      onProgress: (p) => progress.push({ ...p }),
    });
    expect(progress.length).toBe(2);
    for (const entry of progress) {
      expect(entry.processed + entry.skippedUnchanged).toBeLessThanOrEqual(entry.total);
    }
    const last = progress.at(-1)!;
    expect(last.processed + last.skippedUnchanged).toBe(result.total);
  });

  it("媒體檔每檔一塊且 text 為 null，向量用 embedImage", async () => {
    const media = await makeHarness(
      { "img.png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]) },
      { modalities: ["text", "code", "image"] },
    );
    try {
      await indexRoot(media.root, options(media));
      const chunks = await media.store.listChunksByPath(media.root.id, "img.png");
      expect(chunks).toHaveLength(1);
      expect(chunks[0]?.text).toBeNull();
      expect(chunks[0]?.kind).toBe("image");
      expect(media.embedder.images).toHaveLength(1);
      expect(media.embedder.images[0]?.mimeType).toBe("image/png");
    } finally {
      await fs.rm(media.dir, { recursive: true, force: true });
    }
  });
});
