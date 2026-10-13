import { beforeEach, describe, expect, it } from "vitest";
import { DuplicateRootError } from "../errors.js";
import type { MetadataStore } from "../ports/metadata-store.js";
import type { NewRoot } from "../ports/types.js";

/** 每個測試都要拿到全新、獨立的實例（暫存目錄或 :memory:）。 */
export type MetadataStoreFactory = () => MetadataStore | Promise<MetadataStore>;

/** path 對 MetadataStore 是不透明的字串（不做檔案系統存取），用相對字串當測試資料。 */
function rootInput(overrides: Partial<NewRoot> = {}): NewRoot {
  return {
    path: "contract/root-alpha",
    mode: "index",
    modalities: ["text", "code"],
    include: ["**/*"],
    exclude: ["**/node_modules/**"],
    respectGitignore: true,
    watch: false,
    ...overrides,
  };
}

/**
 * MetadataStore 的契約測試。任何實作（SQLite、PostgreSQL…）只要通過同一組測試，
 * 就符合 docs/storage-ports.md 的介面契約。
 */
export function runMetadataStoreContract(name: string, factory: MetadataStoreFactory): void {
  describe(`MetadataStore contract (${name})`, () => {
    let store: MetadataStore;

    beforeEach(async () => {
      store = await factory();
      await store.migrate();
    });

    it("migrate() 可重複呼叫", async () => {
      await store.migrate();
      await store.migrate();
      expect(await store.listRoots()).toEqual([]);
    });

    it("新增、列出與取得 root", async () => {
      const alpha = await store.addRoot(rootInput());
      const beta = await store.addRoot(rootInput({ path: "contract/root-beta", mode: "browse", watch: true }));

      expect(alpha.id).toBeGreaterThan(0);
      expect(Number.isNaN(Date.parse(alpha.createdAt))).toBe(false);
      expect(alpha.mode).toBe("index");
      expect(alpha.modalities).toEqual(["text", "code"]);
      expect(alpha.respectGitignore).toBe(true);
      expect(alpha.watch).toBe(false);

      expect(await store.getRoot(alpha.id)).toEqual(alpha);
      expect(await store.getRoot(beta.id)).toEqual(beta);
      expect(await store.getRoot(987654)).toBeNull();

      const roots = await store.listRoots();
      expect(roots.map((r) => r.id)).toEqual([alpha.id, beta.id]);
      expect(roots[1]?.watch).toBe(true);
    });

    it("同一個 path 重複加入會拋出 DuplicateRootError", async () => {
      await store.addRoot(rootInput());
      await expect(store.addRoot(rootInput())).rejects.toBeInstanceOf(DuplicateRootError);
    });

    it("replaceChunks 先清舊再寫新（冪等）", async () => {
      const root = await store.addRoot(rootInput());
      const first = await store.replaceChunks(root.id, "notes/a.md", [
        { seq: 0, kind: "text", text: "舊的內容：儲存介面", contentHash: "hash-1" },
      ]);
      expect(first).toHaveLength(1);
      expect(first[0]?.relPath).toBe("notes/a.md");
      expect(first[0]?.rootId).toBe(root.id);
      expect(first[0]?.seq).toBe(0);

      const second = await store.replaceChunks(root.id, "notes/a.md", [
        { seq: 0, kind: "text", text: "新的內容：向量搜尋", contentHash: "hash-2" },
        { seq: 1, kind: "code", text: "const answer = 42;", contentHash: "hash-3" },
      ]);
      expect(second).toHaveLength(2);
      expect(second.map((c) => c.id)).not.toContain(first[0]?.id);
      // 舊 chunk 已不存在
      expect(await store.getChunks([first[0]?.id ?? -1])).toEqual([]);

      // 同內容重複呼叫不應累積
      await store.replaceChunks(root.id, "notes/a.md", [
        { seq: 0, kind: "text", text: "新的內容：向量搜尋", contentHash: "hash-2" },
        { seq: 1, kind: "code", text: "const answer = 42;", contentHash: "hash-3" },
      ]);
      expect((await store.searchKeyword("向量搜尋", {}, 10)).length).toBe(1);
    });

    it("deleteChunksByPath 回傳被刪除的 id 且不再被搜到", async () => {
      const root = await store.addRoot(rootInput());
      const chunks = await store.replaceChunks(root.id, "notes/b.md", [
        { seq: 0, kind: "text", text: "唯一詞彙：鰻魚飯", contentHash: "h" },
      ]);
      expect(await store.searchKeyword("鰻魚飯", {}, 5)).toHaveLength(1);

      const removed = await store.deleteChunksByPath(root.id, "notes/b.md");
      expect(removed).toEqual(chunks.map((c) => c.id));
      expect(await store.searchKeyword("鰻魚飯", {}, 5)).toHaveLength(0);
      expect(await store.getChunks(removed)).toEqual([]);
    });

    it("getChunks 依傳入順序回傳，缺漏者略過", async () => {
      const root = await store.addRoot(rootInput());
      const chunks = await store.replaceChunks(root.id, "notes/c.md", [
        { seq: 0, kind: "text", text: "第一塊", contentHash: "h1" },
        { seq: 1, kind: "text", text: "第二塊", contentHash: "h2" },
      ]);
      const ids = chunks.map((c) => c.id);
      const reversed = await store.getChunks([ids[1] ?? -1, ids[0] ?? -1, -99]);
      expect(reversed.map((c) => c.id)).toEqual([ids[1], ids[0]]);
    });

    it("removeRoot(deleteData=true) 刪除該 root 的 chunks 並回傳 id", async () => {
      const root = await store.addRoot(rootInput());
      const chunks = await store.replaceChunks(root.id, "notes/d.md", [
        { seq: 0, kind: "text", text: "要被刪掉的鮭魚卵", contentHash: "h" },
      ]);
      expect(await store.searchKeyword("鮭魚卵", {}, 5)).toHaveLength(1);

      const result = await store.removeRoot(root.id, true);
      expect(result.removedChunkIds).toEqual(chunks.map((c) => c.id));
      expect(await store.getRoot(root.id)).toBeNull();
      expect(await store.getChunks(chunks.map((c) => c.id))).toEqual([]);
      expect(await store.searchKeyword("鮭魚卵", {}, 5)).toHaveLength(0);
    });

    it("removeRoot(deleteData=false) 保留 chunk 資料", async () => {
      const root = await store.addRoot(rootInput());
      const chunks = await store.replaceChunks(root.id, "notes/e.md", [
        { seq: 0, kind: "text", text: "留下來的明太子", contentHash: "h" },
      ]);

      const result = await store.removeRoot(root.id, false);
      expect(result.removedChunkIds).toEqual([]);
      expect(await store.getRoot(root.id)).toBeNull();
      expect(await store.getChunks(chunks.map((c) => c.id))).toHaveLength(1);
      expect(await store.searchKeyword("明太子", {}, 5)).toHaveLength(1);
    });

    it("searchKeyword 找得到兩字中文詞", async () => {
      const root = await store.addRoot(rootInput());
      const chunks = await store.replaceChunks(root.id, "notes/zh.md", [
        { seq: 0, kind: "text", text: "向量搜尋與儲存介面的設計", contentHash: "h" },
      ]);

      const hits = await store.searchKeyword("向量", {}, 10);
      expect(hits).toEqual([{ key: `c:${chunks[0]?.id}`, rank: 1 }]);
      // 同一個 chunk 用另一個兩字詞也搜得到
      expect(await store.searchKeyword("儲存介面", {}, 10)).toEqual([{ key: `c:${chunks[0]?.id}`, rank: 1 }]);
    });

    it("searchKeyword 找得到英文與數字詞", async () => {
      const root = await store.addRoot(rootInput());
      await store.replaceChunks(root.id, "notes/en.md", [
        { seq: 0, kind: "text", text: "partition key filter keeps results exact", contentHash: "h" },
      ]);

      expect((await store.searchKeyword("partition", {}, 10)).length).toBeGreaterThan(0);
      expect((await store.searchKeyword("PARTITION", {}, 10)).length).toBeGreaterThan(0);
      expect(await store.searchKeyword("nonexistentword", {}, 10)).toHaveLength(0);
    });

    it("searchKeyword 的 rootIds 過濾只回傳該 root 的 chunk", async () => {
      const alpha = await store.addRoot(rootInput());
      const beta = await store.addRoot(rootInput({ path: "contract/root-beta" }));
      const alphaChunk = (await store.replaceChunks(alpha.id, "a.md", [
        { seq: 0, kind: "text", text: "共同的關鍵詞是海膽", contentHash: "a" },
      ]))[0];
      const betaChunk = (await store.replaceChunks(beta.id, "b.md", [
        { seq: 0, kind: "text", text: "共同的關鍵詞是海膽", contentHash: "b" },
      ]))[0];

      const all = await store.searchKeyword("海膽", {}, 10);
      expect(all.map((h) => h.key).sort()).toEqual([`c:${alphaChunk?.id}`, `c:${betaChunk?.id}`].sort());

      const filtered = await store.searchKeyword("海膽", { rootIds: [beta.id] }, 10);
      expect(filtered.map((h) => h.key)).toEqual([`c:${betaChunk?.id}`]);

      // 空陣列＝沒有任何可見 root
      expect(await store.searchKeyword("海膽", { rootIds: [] }, 10)).toHaveLength(0);
    });

    it("addMemory 帶 supersedes 時被取代者不再出現在搜尋", async () => {
      const first = await store.addMemory({
        content: "舊偏好：一律用四個空白縮排",
        kind: "preference",
        scope: "global",
        project: null,
        agent: "implementer",
        supersedes: null,
      });
      expect(first.deletedAt).toBeNull();

      const second = await store.addMemory({
        content: "新偏好：一律用兩個空白縮排",
        kind: "preference",
        scope: "global",
        project: null,
        agent: "implementer",
        supersedes: first.id,
      });

      expect((await store.getMemory(first.id))?.deletedAt).not.toBeNull();
      expect(second.supersedes).toBe(first.id);

      const hits = await store.searchKeyword("縮排", {}, 10);
      expect(hits.map((h) => h.key)).toEqual([`m:${second.id}`]);
    });

    it("forgetMemory 軟刪除後搜尋不到，但資料仍在", async () => {
      const memory = await store.addMemory({
        content: "踩坑：WAL 下不要開多個寫入者",
        kind: "pitfall",
        scope: "project",
        project: "mnemoshelf",
        agent: "implementer",
        supersedes: null,
      });
      expect((await store.searchKeyword("寫入者", {}, 10)).map((h) => h.key)).toEqual([`m:${memory.id}`]);

      await store.forgetMemory(memory.id);

      expect(await store.searchKeyword("寫入者", {}, 10)).toHaveLength(0);
      const forgotten = await store.getMemory(memory.id);
      expect(forgotten?.deletedAt).not.toBeNull();
      expect(forgotten?.content).toBe(memory.content);
    });

    it("搜尋會同時包含 chunk 與未刪除的記憶", async () => {
      const root = await store.addRoot(rootInput());
      const chunk = (await store.replaceChunks(root.id, "m.md", [
        { seq: 0, kind: "text", text: "文件 chunk 提到蒸籠", contentHash: "h" },
      ]))[0];
      const memory = await store.addMemory({
        content: "記憶提到蒸籠的用法",
        kind: "fact",
        scope: "global",
        project: null,
        agent: "implementer",
        supersedes: null,
      });

      const keys = (await store.searchKeyword("蒸籠", {}, 10)).map((h) => h.key).sort();
      expect(keys).toEqual([`c:${chunk?.id}`, `m:${memory.id}`].sort());
    });

    it("k <= 0 或空查詢回傳空清單", async () => {
      const root = await store.addRoot(rootInput());
      await store.replaceChunks(root.id, "k.md", [
        { seq: 0, kind: "text", text: "一些文字內容", contentHash: "h" },
      ]);
      expect(await store.searchKeyword("文字", {}, 0)).toEqual([]);
      expect(await store.searchKeyword("   ", {}, 10)).toEqual([]);
      expect(await store.searchKeyword("，。！", {}, 10)).toEqual([]);
    });  });
}
