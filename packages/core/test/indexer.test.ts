import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BINARY_SNIFF_BYTES,
  indexRoot,
  looksBinary,
  openDatabase,
  RootNotIndexableError,
  SqliteMetadataStore,
  SqliteVectorIndex,
  type DocumentInput,
  type Embedder,
  type EmbedderInfo,
  type EmbedDocumentsOptions,
  type ImageInput,
  type IndexProgress,
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
  /** 每次 `embedDocuments` 的輸入筆數（驗證「每檔一次批次呼叫」）。 */
  readonly batchSizes: number[] = [];
  /** 測試掛鉤：每次嵌入一批文件前、逐項呼叫（可在掃描與讀取之間製造競態）。 */
  beforeEmbed: ((text: string) => Promise<void> | void) | undefined;

  get info(): EmbedderInfo {
    return this.inner.info;
  }

  async embedQuery(text: string): Promise<Float32Array> {
    return this.inner.embedQuery(text);
  }

  async embedDocument(text: string, title?: string): Promise<Float32Array> {
    await this.beforeEmbed?.(text);
    this.documents.push({ text, title });
    return this.inner.embedDocument(text, title);
  }

  async embedDocuments(
    inputs: readonly DocumentInput[],
    opts?: EmbedDocumentsOptions,
  ): Promise<Float32Array[]> {
    this.batchSizes.push(inputs.length);
    for (const input of inputs) {
      await this.beforeEmbed?.(input.text);
      this.documents.push({ text: input.text, title: input.title });
    }
    return this.inner.embedDocuments(inputs, opts);
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

/** 進行嵌入時立即中止的 embedder，用來驗證「embed 中止 → DB 不動」。 */
class AbortingEmbedder extends RecordingEmbedder {
  constructor(private readonly controller: AbortController) {
    super();
  }

  override async embedDocuments(
    inputs: readonly DocumentInput[],
    opts?: EmbedDocumentsOptions,
  ): Promise<Float32Array[]> {
    this.controller.abort();
    return super.embedDocuments(inputs, opts);
  }
}

/**
 * 對含特定標記的文字整批拋錯的 embedder，用來驗證「單檔失敗不中斷整輪」。
 *
 * 錯誤帶 `code`（模擬 Node 檔案系統錯誤的形狀），驗證 `failedFiles.reason` 會取用 `code`。
 */
class FailingEmbedder extends RecordingEmbedder {
  constructor(private readonly marker: string) {
    super();
  }

  override async embedDocuments(
    inputs: readonly DocumentInput[],
    opts?: EmbedDocumentsOptions,
  ): Promise<Float32Array[]> {
    if (inputs.some((input) => input.text.includes(this.marker))) {
      throw Object.assign(new Error("模擬嵌入失敗（訊息含 /絕對/路徑 也必須被丟棄）"), { code: "EMODELFAIL" });
    }
    return super.embedDocuments(inputs, opts);
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

  it("文字檔每檔一次批次呼叫（檔案內不再逐塊 await）", async () => {
    const multi = await makeHarness({ "big.md": `# 標題\n\n${"內容".repeat(800)}` });
    try {
      await indexRoot(multi.root, options(multi));
      const chunks = await multi.store.listChunksByPath(multi.root.id, "big.md");
      expect(chunks.length).toBeGreaterThan(1); // 確認真的有多塊
      // 一次呼叫、涵蓋該檔所有塊（不是逐塊呼叫）。
      expect(multi.embedder.batchSizes).toEqual([chunks.length]);
    } finally {
      await fs.rm(multi.dir, { recursive: true, force: true });
    }
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
    const progress: IndexProgress[] = [];
    const result = await indexRoot(harness.root, {
      ...options(harness),
      onProgress: (p) => progress.push({ ...p }),
    });
    // 每個檔案至少一次回報（切塊完成時與完成時各一次；見逐塊進度一節）。
    expect(progress.length).toBeGreaterThanOrEqual(2);
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

  // ── 修復輪：資料完整性與安全 ──────────────────────────────────────────────

  it("Blocker 1：改檔後不收留舊向量，count 等於現有 chunk 數", async () => {
    await indexRoot(harness.root, options(harness));
    const oldChunks = await harness.store.listChunksByPath(harness.root.id, "a.md");
    const oldKeys = oldChunks.map((chunk) => `c:${chunk.id}`);
    expect(oldKeys.length).toBeGreaterThan(0);

    // 改成會切成兩塊的內容（塊數改變，新 chunk 會有新 id）
    await fs.writeFile(path.join(harness.dir, "a.md"), `# 標題\n\n${"內容".repeat(800)}`);

    await indexRoot(harness.root, options(harness));

    const newChunks = await harness.store.listChunksByPath(harness.root.id, "a.md");
    expect(newChunks.length).toBe(2);
    expect(await harness.vec.count()).toBe(newChunks.length + 1); // a.md 兩塊 + b.ts 一塊

    // 舊 key 已被回收，不再出現在索引
    expect([...(await harness.vec.existingKeys(oldKeys))]).toEqual([]);
    const hits = await harness.vec.searchVector(await harness.embedder.embedQuery("內容"), {}, 20);
    for (const hit of hits) {
      expect(oldKeys).not.toContain(hit.key);
    }
  });

  it("Blocker 2：embed 中止時 DB 完全未動，重跑可完成且向量齊", async () => {
    const controller = new AbortController();
    const aborting = new AbortingEmbedder(controller);

    await expect(
      indexRoot(harness.root, {
        embedder: aborting,
        store: harness.store,
        vec: harness.vec,
        signal: controller.signal,
        concurrency: 1,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });

    // 中止發生在寫入 DB 之前：沒有留下任何 chunk 或向量。
    expect(await harness.store.listRelPaths(harness.root.id)).toEqual([]);
    expect(await harness.vec.count()).toBe(0);

    const rerun = await indexRoot(harness.root, options(harness));
    expect(rerun.processed).toBe(2);
    expect(await harness.vec.count()).toBe(2);
  });

  it("Blocker 2(b)：DB 有 hash 但缺向量時，下輪重做補齊", async () => {
    await indexRoot(harness.root, options(harness));
    const chunks = await harness.store.listChunksByPath(harness.root.id, "a.md");
    const missingKey = `c:${chunks[0]!.id}`;
    await harness.vec.deleteByKeys([missingKey]); // 模擬 replaceChunks→upsert 之間失敗

    const before = harness.embedder.documents.length;
    const result = await indexRoot(harness.root, options(harness));

    expect(result).toMatchObject({ processed: 1, skippedUnchanged: 1 }); // 只有 a.md 重做
    expect(harness.embedder.documents.length).toBeGreaterThan(before);
    expect(await harness.vec.count()).toBe(2);

    const repaired = await harness.store.listChunksByPath(harness.root.id, "a.md");
    const repairedKey = `c:${repaired[0]!.id}`;
    expect([...(await harness.vec.existingKeys([repairedKey]))]).toEqual([repairedKey]);
    expect([...(await harness.vec.existingKeys([missingKey]))]).toEqual([]);
  });

  it("Non-blocker 3：新近被排除的檔案會從索引清出（chunk 與向量）", async () => {
    await indexRoot(harness.root, options(harness));
    const bChunks = await harness.store.listChunksByPath(harness.root.id, "code/b.ts");
    const bKeys = bChunks.map((chunk) => `c:${chunk.id}`);
    expect(bKeys.length).toBeGreaterThan(0);

    // 加入 exclude 後重跑（以更新後的 root 設定模擬使用者改了規則）
    const excludedRoot: Root = { ...harness.root, exclude: ["code/**"] };
    const result = await indexRoot(excludedRoot, options(harness));

    expect(result).toMatchObject({ processed: 0, skippedUnchanged: 1, removedFiles: 1 });
    expect(await harness.store.listChunksByPath(harness.root.id, "code/b.ts")).toEqual([]);
    expect(await harness.store.searchKeyword("answer", {}, 10)).toEqual([]);
    expect([...(await harness.vec.existingKeys(bKeys))]).toEqual([]);
    expect(await harness.vec.count()).toBe(1); // 只剩 a.md
  });

  it("Non-blocker 4：掃描後路徑被換成 root 外 symlink → 該檔 skipped 且整輪不中斷", async (ctx) => {
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "mnemoshelf-outside-"));
    const outsideFile = path.join(outsideDir, "outside.md");
    await fs.writeFile(outsideFile, "# 外部檔案");

    const bPath = path.join(harness.dir, "code", "b.ts");
    try {
      // 先確認平台支援 symlink
      const probe = path.join(harness.dir, "probe-link");
      try {
        await fs.symlink(outsideFile, probe, "file");
        await fs.rm(probe);
      } catch {
        ctx.skip();
        return;
      }

      // 在讀取 b.ts 之前（a.md 嵌入時）把它換成指向 root 外的 symlink。
      harness.embedder.beforeEmbed = async () => {
        await fs.rm(bPath);
        await fs.symlink(outsideFile, bPath, "file");
      };

      const result = await indexRoot(harness.root, { ...options(harness), concurrency: 1 });

      expect(result.processed).toBe(1);
      expect(result.skippedFiles).toEqual([{ relPath: "code/b.ts", reason: "unresolved-symlink" }]);
      expect(await harness.store.listChunksByPath(harness.root.id, "code/b.ts")).toEqual([]);
      // 整輪沒有中斷，a.md 仍正常索引
      expect(await harness.store.listChunksByPath(harness.root.id, "a.md")).toHaveLength(1);
    } finally {
      await fs.rm(outsideDir, { recursive: true, force: true });
    }
  });
});

describe("內容層二進位偵測（binary-content）", () => {
  /** 假的二進位內容：像 `.parquet`／`.h5` 之類未列進 BINARY_EXTS 的格式（含 NUL 位元組）。 */
  const nulBytes = (): Buffer => Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x08, 0x00, 0xff, 0xfe]);

  it("looksBinary：NUL／高比例不可印字元判為二進位，正常文字不誤判", () => {
    expect(looksBinary(new Uint8Array(0))).toBe(false);
    expect(looksBinary(Buffer.from("# 標題\n\n第一行\t縮排\r\n"))).toBe(false);
    expect(looksBinary(Buffer.from("中文內容 emoji 🙂\n"))).toBe(false);
    expect(looksBinary(Buffer.from([0x00]))).toBe(true);
    expect(looksBinary(nulBytes())).toBe(true);
    // 沒有 NUL 位元組，但幾乎全是非法 UTF-8 位元組（解碼後為 U+FFFD）
    expect(looksBinary(Buffer.from(Array.from({ length: 200 }, () => 0x80)))).toBe(true);
  });

  it("前段剛好切在半個中文字中間時不誤判（8 KB 邊界）", () => {
    const bytes = Buffer.from("中文內容測試。\n".repeat(1200), "utf8");
    expect(bytes.length).toBeGreaterThan(BINARY_SNIFF_BYTES);
    expect(looksBinary(bytes.subarray(0, BINARY_SNIFF_BYTES))).toBe(false);
  });

  it("含 NUL 的 text 檔被跳過：不切塊、不嵌入，其餘檔案照常索引", async () => {
    const h = await makeHarness({ "ok.md": "# 標題\n\n正常內容", "fake.md": nulBytes() });
    try {
      const result = await indexRoot(h.root, options(h));
      expect(result).toMatchObject({ total: 2, processed: 1, skippedUnchanged: 0 });
      expect(result.skippedFiles).toEqual([{ relPath: "fake.md", reason: "binary-content" }]);
      expect(await h.store.listChunksByPath(h.root.id, "fake.md")).toEqual([]);
      expect(await h.embedder.batchSizes).toEqual([1]); // 只有 ok.md 被嵌入
      expect(await h.store.listChunksByPath(h.root.id, "ok.md")).toHaveLength(1);
    } finally {
      await fs.rm(h.dir, { recursive: true, force: true });
    }
  });

  it("改為二進位後，先前索引的 chunk 與向量被清除", async () => {
    const h = await makeHarness({ "a.md": "# 標題\n\n第一份文件" });
    try {
      await indexRoot(h.root, options(h));
      expect(await h.vec.count()).toBe(1);
      const stale = (await h.store.listChunksByPath(h.root.id, "a.md")).map((chunk) => `c:${chunk.id}`);

      await fs.writeFile(path.join(h.dir, "a.md"), nulBytes());
      const result = await indexRoot(h.root, options(h));

      expect(result).toMatchObject({ total: 1, processed: 0, skippedUnchanged: 0 });
      expect(result.skippedFiles).toEqual([{ relPath: "a.md", reason: "binary-content" }]);
      expect(await h.store.listChunksByPath(h.root.id, "a.md")).toEqual([]);
      expect(await h.vec.count()).toBe(0);
      expect([...(await h.vec.existingKeys(stale))]).toEqual([]);
      expect(await h.store.searchKeyword("標題", {}, 10)).toEqual([]);
    } finally {
      await fs.rm(h.dir, { recursive: true, force: true });
    }
  });

  it("進度對帳：processed + skippedUnchanged + skipped === total", async () => {
    const h = await makeHarness({ "ok.md": "# 標題\n\n正常", "fake.md": nulBytes() });
    try {
      const progress: IndexProgress[] = [];
      const result = await indexRoot(h.root, {
        ...options(h),
        concurrency: 1,
        onProgress: (p) => progress.push({ ...p }),
      });
      expect(progress.length).toBeGreaterThanOrEqual(2);
      const last = progress.at(-1)!;
      expect(last.skipped).toBe(1);
      expect(last.processed + last.skippedUnchanged + last.skipped).toBe(last.total);
      expect(last.processed + last.skippedUnchanged + result.skippedFiles.length).toBe(result.total);
    } finally {
      await fs.rm(h.dir, { recursive: true, force: true });
    }
  });

  it("既有索引的系統檔資料：重新索引後舊 chunk 與向量被清除（.DS_Store 舊資料）", async () => {
    const h = await makeHarness({ ".DS_Store": Buffer.from([0x00, 0x01]), "ok.md": "# 標題\n\n內容" });
    try {
      // 模擬舊版留下的壞資料：.DS_Store 曾被當文字索引（含 chunk 與向量）。
      const legacy = await h.store.replaceChunks(h.root.id, ".DS_Store", [
        { seq: 0, kind: "text", text: "亂碼內容", contentHash: "deadbeef" },
      ]);
      await h.vec.upsert([
        {
          key: `c:${legacy[0]!.id}`,
          rootId: h.root.id,
          embedderId: h.embedder.info.id,
          vec: await h.embedder.embedQuery("亂碼內容"),
        },
      ]);
      expect(await h.store.searchKeyword("亂碼", {}, 10)).toHaveLength(1);

      const result = await indexRoot(h.root, options(h));
      expect(result).toMatchObject({ total: 1, processed: 1, removedFiles: 1 });
      expect(await h.store.listRelPaths(h.root.id)).toEqual(["ok.md"]);
      expect(await h.store.searchKeyword("亂碼", {}, 10)).toEqual([]);
      expect(await h.vec.count()).toBe(1); // 只剩 ok.md
    } finally {
      await fs.rm(h.dir, { recursive: true, force: true });
    }
  });

  it("正常中文多行文件不誤判（對照組）", async () => {
    const h = await makeHarness({
      "long.md": `# 標題\n\n${"中文內容測試。\n".repeat(1200)}`,
      "multi.md": "# 標題\n\n第一行\n第二行\n\t縮排\n",
    });
    try {
      const result = await indexRoot(h.root, options(h));
      expect(result).toMatchObject({ total: 2, processed: 2 });
      expect(result.skippedFiles).toEqual([]);
    } finally {
      await fs.rm(h.dir, { recursive: true, force: true });
    }
  });
});

describe("單檔失敗不中斷整輪（failedFiles）", () => {
  it("壞檔記入 failedFiles，其餘檔案照常索引；重跑即自癒", async () => {
    const h = await makeHarness({
      "good.md": "# 標題\n\n正常內容",
      "bad.md": "# 標題\n\nBADMARK 內容",
    });
    try {
      const result = await indexRoot(h.root, {
        embedder: new FailingEmbedder("BADMARK"),
        store: h.store,
        vec: h.vec,
      });

      expect(result).toMatchObject({ total: 2, processed: 1, skippedUnchanged: 0 });
      // reason 取錯誤的 `code`，**不含**原始訊息（訊息裡有假的路徑字串）。
      expect(result.failedFiles).toEqual([{ relPath: "bad.md", reason: "EMODELFAIL" }]);
      expect(JSON.stringify(result.failedFiles)).not.toContain("絕對");

      // 好檔不受影響；壞檔沒有任何 chunk 或向量。
      expect(await h.store.listChunksByPath(h.root.id, "good.md")).toHaveLength(1);
      expect(await h.store.listChunksByPath(h.root.id, "bad.md")).toEqual([]);
      expect(await h.vec.count()).toBe(1);

      // 下一輪用正常 embedder：壞檔被重做，整輪無失敗。
      const rerun = await indexRoot(h.root, options(h));
      expect(rerun).toMatchObject({ processed: 1, skippedUnchanged: 1 });
      expect(rerun.failedFiles).toEqual([]);
      expect(await h.vec.count()).toBe(2);
    } finally {
      await fs.rm(h.dir, { recursive: true, force: true });
    }
  });

  it("失敗檔的既有索引資料保留（不 purge），下一輪重試才替換", async () => {
    const h = await makeHarness({ "a.md": "# 標題\n\n第一版內容" });
    try {
      await indexRoot(h.root, options(h));
      const before = (await h.store.listChunksByPath(h.root.id, "a.md")).map((chunk) => `c:${chunk.id}`);
      expect(before).toHaveLength(1);

      await fs.writeFile(path.join(h.dir, "a.md"), "# 標題\n\n第二版 BADMARK 內容");
      const failed = await indexRoot(h.root, {
        embedder: new FailingEmbedder("BADMARK"),
        store: h.store,
        vec: h.vec,
      });
      expect(failed.failedFiles).toEqual([{ relPath: "a.md", reason: "EMODELFAIL" }]);
      expect([...(await h.vec.existingKeys(before))]).toEqual(before);

      const rerun = await indexRoot(h.root, options(h));
      expect(rerun).toMatchObject({ processed: 1, failedFiles: [] });
      const after = await h.store.listChunksByPath(h.root.id, "a.md");
      expect(after[0]?.text).toContain("第二版");
      expect([...(await h.vec.existingKeys(before))]).toEqual([]);
    } finally {
      await fs.rm(h.dir, { recursive: true, force: true });
    }
  });

  it("進度對帳：processed + skippedUnchanged + skipped + failed === total", async () => {
    const nulBytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0xff]);
    const h = await makeHarness({
      "ok.md": "# 標題\n\n正常內容",
      "fake.md": nulBytes,
      "bad.md": "# 標題\n\nBADMARK 內容",
    });
    try {
      const progress: IndexProgress[] = [];
      const result = await indexRoot(h.root, {
        embedder: new FailingEmbedder("BADMARK"),
        store: h.store,
        vec: h.vec,
        concurrency: 1,
        onProgress: (p) => progress.push({ ...p }),
      });

      const last = progress.at(-1)!;
      expect(last.processed).toBe(1);
      expect(last.skipped).toBe(1);
      expect(last.failed).toBe(1);
      expect(last.skippedUnchanged).toBe(0);
      expect(last.processed + last.skippedUnchanged + last.skipped + last.failed).toBe(last.total);
      expect(
        last.processed + last.skippedUnchanged + result.skippedFiles.length + result.failedFiles.length,
      ).toBe(result.total);
    } finally {
      await fs.rm(h.dir, { recursive: true, force: true });
    }
  });
});

describe("逐塊進度（processedChunks／estimatedChunks）", () => {
  it("預估塊數在嵌入前先累加，完成後 processedChunks 等於實際塊數", async () => {
    const h = await makeHarness({ "big.md": `# 標題\n\n${"內容".repeat(800)}` });
    try {
      const progress: IndexProgress[] = [];
      await indexRoot(h.root, { ...options(h), onProgress: (p) => progress.push({ ...p }) });
      const chunks = (await h.store.listChunksByPath(h.root.id, "big.md")).length;
      expect(chunks).toBeGreaterThan(1);

      // 第一次回報來自「切塊完成、即將嵌入」：預估已加上，但還沒有任何塊完成。
      expect(progress[0]).toMatchObject({ processed: 0, processedChunks: 0, estimatedChunks: chunks });
      // 檔案完成後：實際完成量等於該檔塊數。
      expect(progress.at(-1)).toMatchObject({ processed: 1, processedChunks: chunks, estimatedChunks: chunks });
    } finally {
      await fs.rm(h.dir, { recursive: true, force: true });
    }
  });

  it("進度數字只增不減（UI 輪詢不會倒退），且 estimatedChunks 是下界", async () => {
    const h = await makeHarness({
      "a.md": "# 標題\n\n第一份文件",
      "b.md": `# 標題\n\n${"內容".repeat(400)}`,
      "c.md": "# 標題\n\n第三份文件",
    });
    try {
      const progress: IndexProgress[] = [];
      await indexRoot(h.root, {
        ...options(h),
        concurrency: 2,
        onProgress: (p) => progress.push({ ...p }),
      });
      expect(progress.length).toBeGreaterThanOrEqual(3);

      const keys = ["processed", "skippedUnchanged", "skipped", "failed", "processedChunks", "estimatedChunks"] as const;
      for (let index = 1; index < progress.length; index += 1) {
        const previous = progress[index - 1]!;
        const current = progress[index]!;
        for (const key of keys) {
          expect(current[key]).toBeGreaterThanOrEqual(previous[key]);
        }
        expect(current.total).toBe(previous.total);
      }

      const last = progress.at(-1)!;
      expect(last.processedChunks).toBeLessThanOrEqual(last.estimatedChunks);
      expect(last.processedChunks).toBeGreaterThan(0);
    } finally {
      await fs.rm(h.dir, { recursive: true, force: true });
    }
  });
});
