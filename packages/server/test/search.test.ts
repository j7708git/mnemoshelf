/**
 * 統一搜尋的行為測試（三種模式、RRF 合併、來源標註、驗證）。
 *
 * 直接用 in-memory SQLite＋FakeEmbedder，不經 HTTP。
 */
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  openDatabase,
  RRF_DEFAULT_K,
  SqliteMetadataStore,
  SqliteVectorIndex,
  type Chunk,
  type MetadataStore,
  type Root,
  type SqliteDatabase,
  type VectorIndex,
  type VectorItem,
} from "@mnemoshelf/core";
import { FakeEmbedder } from "@mnemoshelf/core/testing";
import {
  DEFAULT_SEARCH_MODE,
  fuseRanked,
  MAX_SEARCH_K,
  TEXT_SNIPPET_MAX_CHARS,
  unifiedSearch,
  ValidationError,
} from "../src/index.js";

const embedder = new FakeEmbedder();

let db: SqliteDatabase;
let store: MetadataStore;
let vec: VectorIndex;
let root: Root;
let otherRoot: Root;

/** 寫入一個檔案的多個 chunk 並嵌入（與 indexer 相同的順序：先寫 DB 再寫向量）。 */
async function addFile(targetRoot: Root, relPath: string, texts: string[]): Promise<Chunk[]> {
  const written = await store.replaceChunks(
    targetRoot.id,
    relPath,
    texts.map((text, index) => ({ seq: index, kind: "text" as const, text, contentHash: `hash-${relPath}` })),
  );
  const items: VectorItem[] = [];
  for (const chunk of written) {
    items.push({
      key: `c:${chunk.id}`,
      rootId: targetRoot.id,
      embedderId: embedder.info.id,
      vec: await embedder.embedDocument(chunk.text ?? "", relPath),
    });
  }
  await vec.upsert(items);
  return written;
}

beforeEach(async () => {
  db = openDatabase(":memory:");
  store = new SqliteMetadataStore(db);
  await store.migrate();
  vec = new SqliteVectorIndex(db, embedder.info.dim);

  const base = {
    mode: "index" as const,
    include: [] as string[],
    exclude: [] as string[],
    respectGitignore: true,
    watch: false,
  };
  root = await store.addRoot({ ...base, modalities: ["text"], path: path.join(os.tmpdir(), "fixture-a") });
  otherRoot = await store.addRoot({ ...base, modalities: ["text"], path: path.join(os.tmpdir(), "fixture-b") });

  await addFile(root, "notes.md", ["zorblat 是第一個關鍵字", "shared memory 與 RRF 合併說明"]);
  await addFile(root, "second.md", ["只有這個檔案提到 quibble"]);
  await addFile(otherRoot, "other.md", ["zorblat 也出現在另一個 root"]);
});

afterEach(() => {
  db.close();
});

describe("fuseRanked", () => {
  it("兩路都出現的鍵名次最前，分數為 Σ 1/(60+rank)", () => {
    const fused = fuseRanked([
      [
        { key: "c:1", rank: 1 },
        { key: "c:2", rank: 2 },
      ],
      [
        { key: "c:2", rank: 1 },
        { key: "c:3", rank: 2 },
      ],
    ]);

    expect(fused.map((hit) => hit.key)).toEqual(["c:2", "c:1", "c:3"]);
    expect(fused.map((hit) => hit.rank)).toEqual([1, 2, 3]);
    expect(fused[0]!.score).toBeCloseTo(1 / (RRF_DEFAULT_K + 1) + 1 / (RRF_DEFAULT_K + 2), 12);
    expect(fused[1]!.score).toBeCloseTo(1 / (RRF_DEFAULT_K + 1), 12);
    expect(fused[2]!.score).toBeCloseTo(1 / (RRF_DEFAULT_K + 2), 12);
  });

  it("單一路徑時名次與輸入一致", () => {
    const fused = fuseRanked([[{ key: "c:9", rank: 1 }, { key: "c:8", rank: 2 }]]);
    expect(fused.map((hit) => hit.key)).toEqual(["c:9", "c:8"]);
  });
});

describe("unifiedSearch", () => {
  it("keyword 模式：命中關鍵字所在 chunk，並帶完整來源欄位", async () => {
    const result = await unifiedSearch({ store, vec, embedder }, { query: "zorblat", mode: "keyword" });

    expect(result.mode).toBe("keyword");
    expect(result.hits.length).toBeGreaterThan(0);
    for (const hit of result.hits) {
      expect(hit.type).toBe("chunk");
      if (hit.type !== "chunk") continue;
      expect([root.id, otherRoot.id]).toContain(hit.rootId);
      expect(typeof hit.relPath).toBe("string");
      expect(typeof hit.seq).toBe("number");
      expect(hit.kind).toBe("text");
      expect(hit.text).not.toBeNull();
      expect(hit.rank).toBeGreaterThan(0);
      expect(hit.score).toBeGreaterThan(0);
    }
    expect(result.hits.map((hit) => hit.rank)).toEqual(result.hits.map((_hit, index) => index + 1));
  });

  it("vector 模式：有結果，且不含記憶（記憶不進向量索引）", async () => {
    await store.addMemory({ content: "vector 模式不該回傳這筆記憶", kind: "fact", scope: "global", project: null, agent: "tester", supersedes: null });

    const result = await unifiedSearch({ store, vec, embedder }, { query: "zorblat", mode: "vector" });
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.hits.every((hit) => hit.type === "chunk")).toBe(true);
  });

  it("不帶 mode 時走 vector（M2 契約修訂：預設由 hybrid 改為 vector）", async () => {
    // 放一筆關鍵字會命中的記憶：預設若仍是 keyword／hybrid，就會回傳這筆記憶。
    await store.addMemory({ content: "zorblat 的記憶（預設模式不該命中）", kind: "fact", scope: "global", project: null, agent: "tester", supersedes: null });

    const result = await unifiedSearch({ store, vec, embedder }, { query: "zorblat" });

    expect(DEFAULT_SEARCH_MODE).toBe("vector");
    expect(result.mode).toBe("vector");
    // 預設只跑向量那一路，因此不含記憶命中。
    expect(result.hits.every((hit) => hit.type === "chunk")).toBe(true);
  });

  it("hybrid 模式：合併兩路、rank 從 1 連續、關鍵字命中排在前面", async () => {
    const result = await unifiedSearch({ store, vec, embedder }, { query: "quibble", mode: "hybrid" });

    expect(result.mode).toBe("hybrid");
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.hits.map((hit) => hit.rank)).toEqual(result.hits.map((_hit, index) => index + 1));

    const top = result.hits[0]!;
    expect(top.type).toBe("chunk");
    if (top.type === "chunk") expect(top.relPath).toBe("second.md");

    const keywordOnly = await unifiedSearch({ store, vec, embedder }, { query: "quibble", mode: "keyword" });
    const vectorOnly = await unifiedSearch({ store, vec, embedder }, { query: "quibble", mode: "vector" });
    expect(keywordOnly.hits[0]).toMatchObject({ type: "chunk", relPath: "second.md", rank: 1 });
    expect(vectorOnly.hits.length).toBeGreaterThan(0);
  });

  it("記憶命中帶 agent 與 scope 來源", async () => {
    const memory = await store.addMemory({
      content: "zorblat 也寫進了一筆記憶",
      kind: "pitfall",
      scope: "project",
      project: "mnemoshelf",
      agent: "agent-x",
      supersedes: null,
    });

    const result = await unifiedSearch({ store, vec, embedder }, { query: "zorblat", mode: "keyword" });
    const hit = result.hits.find((entry) => entry.type === "memory");
    expect(hit).toBeDefined();
    if (hit?.type !== "memory") return;
    expect(hit.id).toBe(memory.id);
    expect(hit.agent).toBe("agent-x");
    expect(hit.kind).toBe("pitfall");
    expect(hit.scope).toBe("project");
    expect(hit.project).toBe("mnemoshelf");
  });

  it("rootIds 過濾：只回傳指定 root 的 chunk，且不含記憶", async () => {
    await store.addMemory({ content: "zorblat 記憶", kind: "fact", scope: "global", project: null, agent: "tester", supersedes: null });

    const result = await unifiedSearch(
      { store, vec, embedder },
      { query: "zorblat", mode: "hybrid", rootIds: [otherRoot.id] },
    );
    expect(result.hits.length).toBeGreaterThan(0);
    for (const hit of result.hits) {
      expect(hit.type).toBe("chunk");
      if (hit.type === "chunk") expect(hit.rootId).toBe(otherRoot.id);
    }
  });

  it("文字片段有長度上限並標記截斷", async () => {
    const long = `longtext ${"a".repeat(TEXT_SNIPPET_MAX_CHARS + 200)}`;
    await addFile(root, "long.md", [long]);

    const result = await unifiedSearch({ store, vec, embedder }, { query: "longtext", mode: "keyword" });
    const hit = result.hits.find((entry) => entry.type === "chunk" && entry.relPath === "long.md");
    expect(hit).toBeDefined();
    if (hit?.type !== "chunk") return;
    expect(hit.textTruncated).toBe(true);
    expect(hit.text!.length).toBe(TEXT_SNIPPET_MAX_CHARS);
  });

  it("k 夾在上限內；關鍵字查不到時回傳空清單", async () => {
    const capped = await unifiedSearch({ store, vec, embedder }, { query: "zorblat", k: 5000 });
    expect(capped.k).toBe(MAX_SEARCH_K);
    expect(capped.hits.length).toBeLessThanOrEqual(MAX_SEARCH_K);

    // 關鍵字那一路沒有命中就是空的。
    const empty = await unifiedSearch({ store, vec, embedder }, { query: "no-such-token-anywhere", mode: "keyword" });
    expect(empty.hits).toEqual([]);

    // 向量那一路沒有相關性門檻，一律回傳 k 個最近鄰（本卡不做分數門檻，見回報）。
    const vectorOnly = await unifiedSearch({ store, vec, embedder }, { query: "no-such-token-anywhere", mode: "vector" });
    expect(vectorOnly.hits.length).toBeGreaterThan(0);
  });

  it("選項不合法 → ValidationError", async () => {
    const cases: unknown[] = [
      { query: "" },
      { query: "   " },
      { query: "x", mode: "wat" },
      { query: "x", k: 0 },
      { query: "x", k: 1.5 },
      { query: "x", rootIds: [] },
      { query: "x", rootIds: [1, -2] },
    ];
    for (const options of cases) {
      await expect(unifiedSearch({ store, vec, embedder }, options as never)).rejects.toBeInstanceOf(ValidationError);
    }
  });
});
