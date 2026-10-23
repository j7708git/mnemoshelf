import { beforeEach, describe, expect, it } from "vitest";
import { DuplicateRootError } from "../errors.js";
import {
  MEMORY_LIST_DEFAULT_LIMIT,
  MEMORY_LIST_MAX_LIMIT,
  type MemoryFilter,
  type MemorySearchFilter,
  type MetadataStore,
} from "../ports/metadata-store.js";
import type { MemoryPatch, MemoryScope, NewMemory, NewRoot } from "../ports/types.js";

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

/** 記憶的測試資料（只覆寫關心的欄位）。 */
function memoryInput(overrides: Partial<NewMemory> = {}): NewMemory {
  return {
    content: "契約測試記憶",
    kind: "fact",
    scope: "global",
    project: null,
    agent: "contract-agent",
    supersedes: null,
    ...overrides,
  };
}

/**
 * 記憶向量的測試資料（只驗證儲存與狀態流程，不求 L2 正規化——契約不驗證正規化，
 * 正規化由 embedder 保證）。數值刻意簡單、可重現。
 */
function embeddingVector(values: number[] = [0.1, 0.2, 0.3]): Float32Array {
  return new Float32Array(values);
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

    it("updateRoot 更新 modalities 並回傳更新後的 root（其他欄位不變）", async () => {
      const root = await store.addRoot(
        rootInput({ modalities: ["text", "code"], include: [], exclude: ["**/skip/**"] }),
      );

      const updated = await store.updateRoot(root.id, { modalities: ["text", "code", "image"] });
      expect(updated).not.toBeNull();
      expect(updated?.id).toBe(root.id);
      expect(updated?.modalities).toEqual(["text", "code", "image"]);
      // 不可變欄位原樣保留。
      expect(updated?.path).toBe(root.path);
      expect(updated?.mode).toBe(root.mode);
      expect(updated?.exclude).toEqual(["**/skip/**"]);
      expect(updated?.createdAt).toBe(root.createdAt);

      // 讀回來也要是新的值（不能只改回傳物件）。
      expect(await store.getRoot(root.id)).toEqual(updated);
      expect((await store.listRoots())[0]?.modalities).toEqual(["text", "code", "image"]);
    });

    it("updateRoot 是冪等的，也可以把模態關掉", async () => {
      const root = await store.addRoot(rootInput({ modalities: ["text", "code", "image"] }));

      const first = await store.updateRoot(root.id, { modalities: ["text"] });
      const second = await store.updateRoot(root.id, { modalities: ["text"] });
      expect(first).toEqual(second);
      expect(second?.modalities).toEqual(["text"]);

      // 空陣列＝全部關閉（與 addRoot 接受空陣列一致）。
      expect((await store.updateRoot(root.id, { modalities: [] }))?.modalities).toEqual([]);
    });

    it("updateRoot 不提供欄位時只回傳現值（無變更）", async () => {
      const root = await store.addRoot(rootInput());
      expect(await store.updateRoot(root.id, {})).toEqual(root);
    });

    it("updateRoot 對不存在的 id 回傳 null（不拋錯、不建立列）", async () => {
      expect(await store.updateRoot(987654, { modalities: ["text"] })).toBeNull();
      expect(await store.updateRoot(987654, {})).toBeNull();
      expect(await store.listRoots()).toEqual([]);
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

    it("listChunksByPath 依 seq 回傳該路徑的 chunk，其他路徑不受影響", async () => {
      const root = await store.addRoot(rootInput());
      await store.replaceChunks(root.id, "notes/a.md", [
        { seq: 1, kind: "text", text: "第二塊", contentHash: "fa" },
        { seq: 0, kind: "text", text: "第一塊", contentHash: "fa" },
      ]);
      await store.replaceChunks(root.id, "notes/b.md", [{ seq: 0, kind: "text", text: "別檔", contentHash: "fb" }]);

      const chunks = await store.listChunksByPath(root.id, "notes/a.md");
      expect(chunks.map((c) => c.seq)).toEqual([0, 1]);
      expect(chunks.map((c) => c.relPath)).toEqual(["notes/a.md", "notes/a.md"]);
      expect(chunks.map((c) => c.contentHash)).toEqual(["fa", "fa"]);

      expect(await store.listChunksByPath(root.id, "notes/missing.md")).toEqual([]);
    });

    it("listRelPaths 回傳去重並排序的路徑", async () => {
      const root = await store.addRoot(rootInput());
      await store.replaceChunks(root.id, "notes/b.md", [{ seq: 0, kind: "text", text: "b", contentHash: "b" }]);
      await store.replaceChunks(root.id, "notes/a.md", [
        { seq: 0, kind: "text", text: "a0", contentHash: "a" },
        { seq: 1, kind: "text", text: "a1", contentHash: "a" },
      ]);
      await store.replaceChunks(root.id, "z.txt", [{ seq: 0, kind: "text", text: "z", contentHash: "z" }]);

      expect(await store.listRelPaths(root.id)).toEqual(["notes/a.md", "notes/b.md", "z.txt"]);
      expect(await store.listRelPaths(987654)).toEqual([]);
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

    it("setMemoryPinned 設定與取消釘選（冪等），pinned 反映在 getMemory 與 listMemories", async () => {
      const memory = await store.addMemory(memoryInput({ content: "要被釘選的記憶" }));
      // 新增的記憶預設不釘選。
      expect(memory.pinned).toBe(false);
      expect((await store.getMemory(memory.id))?.pinned).toBe(false);

      await store.setMemoryPinned(memory.id, true);
      expect((await store.getMemory(memory.id))?.pinned).toBe(true);
      // 冪等：重複設定同樣的值不會出錯，狀態不變。
      await store.setMemoryPinned(memory.id, true);
      expect((await store.getMemory(memory.id))?.pinned).toBe(true);

      // 列表回傳的完整 Memory 也帶正確的 pinned。
      expect((await store.listMemories()).find((item) => item.id === memory.id)?.pinned).toBe(true);

      await store.setMemoryPinned(memory.id, false);
      expect((await store.getMemory(memory.id))?.pinned).toBe(false);
      expect((await store.listMemories()).find((item) => item.id === memory.id)?.pinned).toBe(false);
    });

    it("setMemoryPinned 對不存在的 id 是無操作（比照 forgetMemory 的風格，不拋錯）", async () => {
      await expect(store.setMemoryPinned(987654, true)).resolves.toBeUndefined();
      expect(await store.getMemory(987654)).toBeNull();
      // 不存在的 id 不會被憑空建立。
      expect(await store.listMemories()).toEqual([]);
    });

    it("記憶來源欄位：帶 sourceSession／sourceMessage 寫入→讀回一致、未帶→null、updateMemory 不改來源", async () => {
      // 帶來源：addMemory 與 getMemory／listMemories／listMemoriesForExport 都一致。
      const withSource = await store.addMemory(
        memoryInput({ content: "帶來源的記憶", sourceSession: "session-alpha", sourceMessage: "message-alpha" }),
      );
      expect(withSource.sourceSession).toBe("session-alpha");
      expect(withSource.sourceMessage).toBe("message-alpha");
      expect(await store.getMemory(withSource.id)).toMatchObject({
        sourceSession: "session-alpha",
        sourceMessage: "message-alpha",
      });
      expect((await store.listMemories()).find((item) => item.id === withSource.id)).toMatchObject({
        sourceSession: "session-alpha",
        sourceMessage: "message-alpha",
      });
      expect((await store.listMemoriesForExport()).find((item) => item.id === withSource.id)).toMatchObject({
        sourceSession: "session-alpha",
        sourceMessage: "message-alpha",
      });

      // 未帶（或 null）→ 一律 null（不是空字串）。
      const plain = await store.addMemory(memoryInput({ content: "沒有來源的記憶" }));
      expect(plain.sourceSession).toBeNull();
      expect(plain.sourceMessage).toBeNull();
      const explicitNull = await store.addMemory(
        memoryInput({ content: "明示 null 的來源", sourceSession: null, sourceMessage: null }),
      );
      expect(explicitNull).toMatchObject({ sourceSession: null, sourceMessage: null });

      // 去重路徑同樣寫入／帶回來源；且來源**不在**去重 key 內（同內容不同來源＝重複）。
      const dedup = await store.addMemoryUnlessDuplicate(
        memoryInput({ content: "去重路徑帶來源", sourceSession: "session-beta", sourceMessage: null }),
      );
      expect(dedup.duplicate).toBe(false);
      expect(dedup.memory).toMatchObject({ sourceSession: "session-beta", sourceMessage: null });
      const sameContent = await store.addMemoryUnlessDuplicate(
        memoryInput({ content: "去重路徑帶來源", sourceSession: "session-gamma" }),
      );
      expect(sameContent.duplicate).toBe(true);
      expect(sameContent.memory.id).toBe(dedup.memory.id);
      expect(sameContent.memory.sourceSession).toBe("session-beta");

      // 來源欄位不可變：updateMemory 只改 scope／project，來源原樣保留。
      const updated = await store.updateMemory(withSource.id, { scope: "global", project: null });
      expect(updated).toMatchObject({
        sourceSession: "session-alpha",
        sourceMessage: "message-alpha",
        scope: "global",
        project: null,
      });
    });

    it("updateMemory 更新 scope／project 並回傳更新後的完整記憶（不可變欄位原樣保留）", async () => {
      const previous = await store.addMemory(
        memoryInput({ content: "被取代的舊記憶", kind: "decision", scope: "global", project: null }),
      );
      const memory = await store.addMemory({
        content: "共享開關的契約測試記憶",
        kind: "pitfall",
        scope: "project",
        project: "contract-project",
        agent: "contract-agent-update",
        supersedes: previous.id,
      });
      await store.setMemoryPinned(memory.id, true);
      const before = (await store.getMemory(memory.id))!;

      // project → global：project 應被清為 null，其餘欄位原樣。
      const updated = await store.updateMemory(memory.id, { scope: "global" });
      expect(updated).not.toBeNull();
      expect(updated).toMatchObject({
        id: before.id,
        content: before.content,
        kind: before.kind,
        agent: before.agent,
        supersedes: before.supersedes,
        pinned: before.pinned,
        createdAt: before.createdAt,
        deletedAt: null,
        scope: "global",
        project: null,
      });
      // 讀回來也要是新的值（不能只改回傳物件）。
      expect(await store.getMemory(memory.id)).toEqual(updated);
      expect((await store.listMemories({ scope: "global" })).find((item) => item.id === memory.id)?.project).toBeNull();

      // global → project（專案名稱 trim 後儲存）。
      const back = await store.updateMemory(memory.id, { scope: "project", project: "  contract-project  " });
      expect(back).toMatchObject({ scope: "project", project: "contract-project", pinned: true });
      expect((await store.getMemory(memory.id))?.project).toBe("contract-project");
      // 不可變的 supersedes 關係仍可追溯。
      expect((await store.getMemory(memory.id))?.supersedes).toBe(previous.id);
      expect((await store.getMemory(previous.id))?.deletedAt).not.toBeNull();
    });

    it("updateMemory 的 scope 非 project 時一律把 project 清為 null，且可只改 project", async () => {
      const project = await store.addMemory(
        memoryInput({ content: "專案記憶", scope: "project", project: "proj-a" }),
      );
      const toAgent = await store.updateMemory(project.id, { scope: "agent" });
      expect(toAgent).toMatchObject({ scope: "agent", project: null });

      // 只帶 project（scope 沿用現值 project）＝改專案名稱。
      const project2 = await store.addMemory(memoryInput({ content: "另一筆專案記憶", scope: "project", project: "proj-c" }));
      expect(await store.updateMemory(project2.id, { project: "proj-d" })).toMatchObject({
        scope: "project",
        project: "proj-d",
      });
    });

    it("updateMemory 是冪等的：同一個 patch 重複套用結果相同", async () => {
      const memory = await store.addMemory(
        memoryInput({ content: "冪等測試", scope: "project", project: "proj-idem" }),
      );

      const first = await store.updateMemory(memory.id, { scope: "global" });
      const second = await store.updateMemory(memory.id, { scope: "global" });
      expect(second).toEqual(first);
      expect(second).toMatchObject({ scope: "global", project: null });

      // 已切回專案之後再套用同一個 project patch，結果也一樣。
      const toProject = await store.updateMemory(memory.id, { scope: "project", project: "proj-idem" });
      const again = await store.updateMemory(memory.id, { scope: "project", project: "proj-idem" });
      expect(again).toEqual(toProject);
    });

    it("updateMemory 對不存在的 id 回傳 null（不拋錯、不建立列）", async () => {
      expect(await store.updateMemory(987654, { scope: "global" })).toBeNull();
      // 不存在優先於 patch 驗證：空 patch 也是回 null，不是拋錯（不洩漏存在性以外的資訊）。
      expect(await store.updateMemory(987654, {})).toBeNull();
      expect(await store.listMemories()).toEqual([]);
    });

    it("updateMemory 對已軟刪除的記憶回傳 null 且不改資料", async () => {
      const memory = await store.addMemory(
        memoryInput({ content: "已刪除的記憶", scope: "project", project: "proj-gone" }),
      );
      await store.forgetMemory(memory.id);

      expect(await store.updateMemory(memory.id, { scope: "global" })).toBeNull();
      const after = await store.getMemory(memory.id);
      expect(after).toMatchObject({ scope: "project", project: "proj-gone" });
      expect(after?.deletedAt).not.toBeNull();
    });

    it("updateMemory 的非法 patch 會拋錯：空 patch、scope=project 缺專案、scope!=project 帶專案", async () => {
      const project = await store.addMemory(
        memoryInput({ content: "非法 patch 的測試記憶", scope: "project", project: "proj-x" }),
      );
      const global = await store.addMemory(memoryInput({ content: "全域記憶", scope: "global", project: null }));

      // 兩個欄位都沒給。
      const emptyPatch: MemoryPatch = {};
      await expect(store.updateMemory(project.id, emptyPatch)).rejects.toThrow();
      // scope=project 但解析不到非空 project。
      await expect(store.updateMemory(global.id, { scope: "project" })).rejects.toThrow();
      await expect(store.updateMemory(project.id, { project: null })).rejects.toThrow();
      await expect(store.updateMemory(project.id, { scope: "project", project: "" })).rejects.toThrow();
      await expect(store.updateMemory(project.id, { scope: "project", project: "   " })).rejects.toThrow();
      // scope!=project 時明確帶非 null project。
      await expect(store.updateMemory(global.id, { scope: "global", project: "proj-x" })).rejects.toThrow();
      await expect(store.updateMemory(project.id, { scope: "agent", project: "proj-x" })).rejects.toThrow();
      // 不合法的 scope 值（runtime；型別外）。
      await expect(store.updateMemory(project.id, { scope: "bogus" as MemoryScope })).rejects.toThrow();
      // 不合法的 project 型別（runtime；型別外）。
      await expect(store.updateMemory(project.id, { project: 42 as unknown as string })).rejects.toThrow();

      // 以上全部不得留下任何變更。
      expect(await store.getMemory(project.id)).toMatchObject({ scope: "project", project: "proj-x" });
      expect(await store.getMemory(global.id)).toMatchObject({ scope: "global", project: null });
    });

    it("記憶向量：markMemoryEmbedded 把狀態設為 ready、list 不再需要、stats 反映", async () => {
      const memory = await store.addMemory(memoryInput({ content: "要嵌入的記憶" }));
      const embedderId = "contract-embedder@1";

      // 新記憶預設 pending：stats 與待嵌清單都看得到。
      expect(await store.memoryEmbeddingStats(embedderId)).toEqual({
        total: 1,
        pending: 1,
        ready: 0,
        failed: 0,
        tooLong: 0,
        stale: 0,
      });
      expect((await store.listMemoriesNeedingEmbedding(embedderId)).map((item) => item.id)).toEqual([memory.id]);

      await store.markMemoryEmbedded(memory.id, embedderId, embeddingVector());

      const stats = await store.memoryEmbeddingStats(embedderId);
      expect(stats).toEqual({ total: 1, pending: 0, ready: 1, failed: 0, tooLong: 0, stale: 0 });
      // 四個狀態數必須自洽。
      expect(stats.total).toBe(stats.pending + stats.ready + stats.failed + stats.tooLong);
      expect(await store.listMemoriesNeedingEmbedding(embedderId)).toEqual([]);
      // `Memory` 型別不暴露向量；既有的讀取行為不變。
      expect((await store.getMemory(memory.id))?.content).toBe("要嵌入的記憶");
    });

    it("換 embedder 後 ready 記憶成為 stale 並重新列入待嵌清單", async () => {
      const memory = await store.addMemory(memoryInput({ content: "換 embedder 的記憶" }));
      await store.markMemoryEmbedded(memory.id, "embedder-a@1", embeddingVector());
      expect((await store.memoryEmbeddingStats("embedder-a@1")).stale).toBe(0);

      expect(await store.memoryEmbeddingStats("embedder-b@2")).toEqual({
        total: 1,
        pending: 0,
        ready: 1,
        failed: 0,
        tooLong: 0,
        stale: 1,
      });
      expect((await store.listMemoriesNeedingEmbedding("embedder-b@2")).map((item) => item.id)).toEqual([memory.id]);

      // 用新 embedder 重嵌 → stale 消失、不再需要重嵌。
      await store.markMemoryEmbedded(memory.id, "embedder-b@2", embeddingVector([0.4, 0.5]));
      expect(await store.memoryEmbeddingStats("embedder-b@2")).toMatchObject({ ready: 1, stale: 0 });
      expect(await store.listMemoriesNeedingEmbedding("embedder-b@2")).toEqual([]);
    });

    it("markMemoryEmbeddingFailed：failed 可重試、too-long 永久排除，stats 自洽", async () => {
      const retryable = await store.addMemory(memoryInput({ content: "可重試的記憶" }));
      const skipped = await store.addMemory(memoryInput({ content: "太長的記憶" }));
      const embedderId = "contract-embedder@1";

      await store.markMemoryEmbeddingFailed(retryable.id, "failed");
      await store.markMemoryEmbeddingFailed(skipped.id, "too-long");

      // failed 會再被列出（下次回填重試）；too-long 不會。
      expect((await store.listMemoriesNeedingEmbedding(embedderId)).map((item) => item.id)).toEqual([retryable.id]);
      const stats = await store.memoryEmbeddingStats(embedderId);
      expect(stats).toEqual({ total: 2, pending: 0, ready: 0, failed: 1, tooLong: 1, stale: 0 });
      expect(stats.total).toBe(stats.pending + stats.ready + stats.failed + stats.tooLong);

      // failed 之後成功 → ready；too-long 不受影響。
      await store.markMemoryEmbedded(retryable.id, embedderId, embeddingVector());
      expect(await store.memoryEmbeddingStats(embedderId)).toMatchObject({ ready: 1, failed: 0, tooLong: 1 });
    });

    it("mark* 對未知或已軟刪除的 id 是 no-op（不拋錯、不建立列）", async () => {
      const embedderId = "contract-embedder@1";
      const memory = await store.addMemory(memoryInput({ content: "已刪除的記憶" }));
      await store.forgetMemory(memory.id);

      await expect(store.markMemoryEmbedded(987654, embedderId, embeddingVector())).resolves.toBeUndefined();
      await expect(store.markMemoryEmbeddingFailed(987654, "failed")).resolves.toBeUndefined();
      await expect(store.markMemoryEmbedded(memory.id, embedderId, embeddingVector())).resolves.toBeUndefined();
      await expect(store.markMemoryEmbeddingFailed(memory.id, "too-long")).resolves.toBeUndefined();

      // 已刪除者不列入統計與待嵌清單；未知 id 也不會被憑空建立。
      expect(await store.memoryEmbeddingStats(embedderId)).toEqual({
        total: 0,
        pending: 0,
        ready: 0,
        failed: 0,
        tooLong: 0,
        stale: 0,
      });
      expect(await store.listMemoriesNeedingEmbedding(embedderId)).toEqual([]);
      expect(await store.getMemory(memory.id)).toMatchObject({ deletedAt: expect.any(String) });
    });

    it("mark* 的非法輸入會拋 TypeError", async () => {
      const memory = await store.addMemory(memoryInput({ content: "非法輸入的記憶" }));
      const embedderId = "contract-embedder@1";

      await expect(store.markMemoryEmbedded(memory.id, "   ", embeddingVector())).rejects.toBeInstanceOf(TypeError);
      await expect(store.markMemoryEmbedded(memory.id, "", embeddingVector())).rejects.toBeInstanceOf(TypeError);
      await expect(store.markMemoryEmbedded(memory.id, embedderId, new Float32Array(0))).rejects.toBeInstanceOf(
        TypeError,
      );
      await expect(
        store.markMemoryEmbedded(memory.id, embedderId, new Float32Array([Number.NaN, 0.1])),
      ).rejects.toBeInstanceOf(TypeError);
      await expect(
        store.markMemoryEmbedded(memory.id, embedderId, new Float32Array([Number.POSITIVE_INFINITY])),
      ).rejects.toBeInstanceOf(TypeError);
      await expect(store.markMemoryEmbeddingFailed(memory.id, "bogus" as "failed")).rejects.toBeInstanceOf(TypeError);

      // 全部被拒之後狀態仍是 pending。
      expect((await store.memoryEmbeddingStats(embedderId)).pending).toBe(1);
    });

    it("listMemoriesNeedingEmbedding：只回未刪除者、新到舊排序、支援 limit 邊界", async () => {
      const embedderId = "contract-embedder@1";
      const first = await store.addMemory(memoryInput({ content: "第一筆待嵌" }));
      const second = await store.addMemory(memoryInput({ content: "第二筆待嵌" }));
      const third = await store.addMemory(memoryInput({ content: "第三筆待嵌" }));
      const deleted = await store.addMemory(memoryInput({ content: "被刪除的待嵌" }));
      await store.forgetMemory(deleted.id);
      await store.markMemoryEmbeddingFailed(third.id, "too-long");

      // 排序與 listMemories 相同：新到舊，同毫秒以 id 決勝；too-long 與已刪除者排除。
      expect((await store.listMemoriesNeedingEmbedding(embedderId)).map((item) => item.id)).toEqual([
        second.id,
        first.id,
      ]);
      expect((await store.listMemoriesNeedingEmbedding(embedderId, 1)).map((item) => item.id)).toEqual([second.id]);
      // <= 0 或非正整數 → 空清單（沿用 normalizeMemoryLimit）。
      expect(await store.listMemoriesNeedingEmbedding(embedderId, 0)).toEqual([]);
      expect(await store.listMemoriesNeedingEmbedding(embedderId, -3)).toEqual([]);
      expect(await store.listMemoriesNeedingEmbedding(embedderId, 1.5)).toEqual([]);
      // 未指定 limit → 預設 100；超過上限夾到 500。此處資料少於上限，兩者都回全部。
      expect(await store.listMemoriesNeedingEmbedding(embedderId, 10_000)).toHaveLength(2);
    });

    it("searchMemoriesByVector：bucket 過濾在排名前生效（global／project／所有專案／agent）", async () => {
      const embedderId = "contract-embedder-vec@1";
      const add = async (overrides: Partial<NewMemory>): Promise<number> =>
        (await store.addMemory(memoryInput(overrides))).id;

      const global = await add({ content: "全域記憶", scope: "global", project: null, kind: "fact" });
      const projA = await add({ content: "專案 A", scope: "project", project: "proj-a", kind: "decision" });
      const projB = await add({ content: "專案 B", scope: "project", project: "proj-b", kind: "fact" });
      const agentX = await add({ content: "agent X", scope: "agent", project: null, agent: "agent-x", kind: "fact" });
      const agentY = await add({ content: "agent Y", scope: "agent", project: null, agent: "agent-y", kind: "fact" });

      // 分數嚴格遞減（query [1,0,0]），且彼此不同以便驗證排序。
      await store.markMemoryEmbedded(global, embedderId, new Float32Array([1, 0, 0]));
      await store.markMemoryEmbedded(projA, embedderId, new Float32Array([0.9, 0.1, 0]));
      await store.markMemoryEmbedded(projB, embedderId, new Float32Array([0.8, 0.2, 0]));
      await store.markMemoryEmbedded(agentX, embedderId, new Float32Array([0.7, 0.3, 0]));
      await store.markMemoryEmbedded(agentY, embedderId, new Float32Array([0.6, 0.4, 0]));

      const query = new Float32Array([1, 0, 0]);
      const ids = async (filter: MemorySearchFilter, k = 10): Promise<number[]> =>
        (await store.searchMemoriesByVector(query, embedderId, filter, k)).map((hit) => hit.id);

      // 未提供 buckets＝全部 scope，依 cosine 降冪。
      expect(await ids({})).toEqual([global, projA, projB, agentX, agentY]);
      expect(await ids({ buckets: [{ scope: "global" }] })).toEqual([global]);
      expect(await ids({ buckets: [{ scope: "global" }, { scope: "project", project: "proj-a" }] })).toEqual([
        global,
        projA,
      ]);
      // project bucket 省略 project＝所有專案。
      expect(await ids({ buckets: [{ scope: "project" }] })).toEqual([projA, projB]);
      // agent 只在使用者明確提供時納入（bucket 的 agent 精確比對）。
      expect(await ids({ buckets: [{ scope: "agent", agent: "agent-x" }] })).toEqual([agentX]);
      // kind 精確過濾（先過濾再排名）。
      expect(await ids({ kind: "fact" })).toEqual([global, projB, agentX, agentY]);
      // 空 bucket 陣列＝沒有可見範圍。
      expect(await ids({ buckets: [] })).toEqual([]);

      // 分數是 cosine：query [1,0,0] 對 [1,0,0] 為 1。
      const top = await store.searchMemoriesByVector(query, embedderId, {}, 1);
      expect(top).toHaveLength(1);
      expect(top[0]).toMatchObject({ id: global });
      expect(top[0]!.score).toBeCloseTo(1, 5);
    });

    it("searchMemoriesByVector：只取 ready＋embedder 相符、排除 failed／pending／已刪除；同分 id 升冪", async () => {
      const embedderId = "contract-embedder-ready@1";
      const other = await store.addMemory(memoryInput({ content: "別的 embedder" }));
      const failed = await store.addMemory(memoryInput({ content: "失敗的向量" }));
      const pending = await store.addMemory(memoryInput({ content: "尚未嵌入" }));
      const deleted = await store.addMemory(memoryInput({ content: "已刪除的向量" }));
      const tieA = await store.addMemory(memoryInput({ content: "同分 A" }));
      const tieB = await store.addMemory(memoryInput({ content: "同分 B" }));

      await store.markMemoryEmbedded(other.id, "contract-embedder-other@1", new Float32Array([1, 0]));
      await store.markMemoryEmbedded(failed.id, embedderId, new Float32Array([1, 0]));
      await store.markMemoryEmbeddingFailed(failed.id, "failed"); // 保留向量但狀態 failed → 不採
      await store.markMemoryEmbedded(deleted.id, embedderId, new Float32Array([1, 0]));
      await store.forgetMemory(deleted.id);
      await store.markMemoryEmbedded(tieA.id, embedderId, new Float32Array([1, 0]));
      await store.markMemoryEmbedded(tieB.id, embedderId, new Float32Array([1, 0]));

      const hits = await store.searchMemoriesByVector(new Float32Array([1, 0]), embedderId, {}, 10);
      // tieA/tieB 分數相同 → 依 id 升冪；pending／failed／別的 embedder／已刪除都不列入。
      expect(hits.map((hit) => hit.id)).toEqual([tieA.id, tieB.id]);
      expect(hits[0]!.score).toBeCloseTo(hits[1]!.score, 6);
      expect(pending.deletedAt).toBeNull();
    });

    it("searchMemoriesByVector：k 邊界、非法查詢向量與維度不符都正確", async () => {
      const embedderId = "contract-embedder-k@1";
      const created: number[] = [];
      for (const content of ["k 一", "k 二", "k 三"]) {
        const memory = await store.addMemory(memoryInput({ content }));
        await store.markMemoryEmbedded(memory.id, embedderId, new Float32Array([1, 0]));
        created.push(memory.id);
      }
      const query = new Float32Array([1, 0]);
      expect((await store.searchMemoriesByVector(query, embedderId, {}, 1)).length).toBe(1);
      expect(await store.searchMemoriesByVector(query, embedderId, {}, 0)).toEqual([]);
      expect(await store.searchMemoriesByVector(query, embedderId, {}, -3)).toEqual([]);
      expect(await store.searchMemoriesByVector(query, embedderId, {}, 1.5)).toEqual([]);
      // 上限 500：資料少於上限時回全部。
      expect(await store.searchMemoriesByVector(query, embedderId, {}, 10_000)).toHaveLength(created.length);

      // 非法查詢向量 → TypeError。
      await expect(store.searchMemoriesByVector(new Float32Array(0), embedderId, {}, 5)).rejects.toBeInstanceOf(
        TypeError,
      );
      await expect(
        store.searchMemoriesByVector(new Float32Array([Number.NaN, 0.5]), embedderId, {}, 5),
      ).rejects.toBeInstanceOf(TypeError);

      // 同一 embedder 下混入不同維度（模擬損壞資料）：查詢維度不符 → TypeError，不得默默跳過。
      const corrupt = await store.addMemory(memoryInput({ content: "維度不符的向量" }));
      await store.markMemoryEmbedded(corrupt.id, embedderId, new Float32Array([0.1, 0.2, 0.3]));
      await expect(store.searchMemoriesByVector(query, embedderId, {}, 5)).rejects.toBeInstanceOf(TypeError);
    });

    it("searchMemoriesKeyword：bucket／kind 先過濾、排除已刪除、不混 chunk、rank 連續", async () => {
      // 同一關鍵詞的 chunk 不得混進記憶檢索。
      const root = await store.addRoot(rootInput());
      await store.replaceChunks(root.id, "shared.md", [
        { seq: 0, kind: "text", text: "專案共享關鍵詞 chunk 版本", contentHash: "shared-hash" },
      ]);

      const global = await store.addMemory(
        memoryInput({ content: "專案共享關鍵詞 全域", scope: "global", project: null, kind: "fact" }),
      );
      const projA = await store.addMemory(
        memoryInput({ content: "專案共享關鍵詞 甲專案", scope: "project", project: "proj-a", kind: "decision" }),
      );
      const projB = await store.addMemory(
        memoryInput({ content: "專案共享關鍵詞 乙專案", scope: "project", project: "proj-b", kind: "fact" }),
      );
      const agentX = await store.addMemory(
        memoryInput({ content: "專案共享關鍵詞 agent", scope: "agent", project: null, agent: "agent-x" }),
      );
      const deleted = await store.addMemory(memoryInput({ content: "專案共享關鍵詞 已刪除", kind: "fact" }));
      await store.forgetMemory(deleted.id);

      const ids = async (filter: MemorySearchFilter, k = 10): Promise<number[]> =>
        (await store.searchMemoriesKeyword("共享關鍵詞", filter, k)).map((hit) => hit.id);

      // 未提供 buckets：global／project／agent 都在，已刪除與 chunk 不在。
      const all = await ids({});
      expect(all.sort()).toEqual([global.id, projA.id, projB.id, agentX.id].sort());

      expect(await ids({ buckets: [{ scope: "global" }] })).toEqual([global.id]);
      expect(await ids({ buckets: [{ scope: "project", project: "proj-a" }] })).toEqual([projA.id]);
      expect(new Set(await ids({ buckets: [{ scope: "project" }] }))).toEqual(new Set([projA.id, projB.id]));
      expect(await ids({ buckets: [{ scope: "agent", agent: "agent-x" }] })).toEqual([agentX.id]);
      expect(new Set(await ids({ kind: "fact" }))).toEqual(new Set([global.id, projB.id, agentX.id]));
      expect(await ids({ buckets: [] })).toEqual([]);

      // rank 從 1 起算且連續；k 邊界。
      const ranked = await store.searchMemoriesKeyword("共享關鍵詞", {}, 10);
      expect(ranked.map((hit) => hit.rank)).toEqual(ranked.map((_hit, index) => index + 1));
      expect(await store.searchMemoriesKeyword("共享關鍵詞", {}, 1)).toHaveLength(1);
      expect(await store.searchMemoriesKeyword("共享關鍵詞", {}, 0)).toEqual([]);
      expect(await store.searchMemoriesKeyword("   ", {}, 5)).toEqual([]);
      expect(await store.searchMemoriesKeyword("，。！", {}, 5)).toEqual([]);
    });

    it("兩個記憶檢索方法對非法 bucket 都拋 TypeError（兩後端一致）", async () => {
      const memory = await store.addMemory(memoryInput({ content: "非法 bucket 的測試記憶" }));
      const embedderId = "contract-embedder-invalid@1";
      await store.markMemoryEmbedded(memory.id, embedderId, new Float32Array([1, 0]));
      const query = new Float32Array([1, 0]);

      const invalidFilters: MemorySearchFilter[] = [
        { buckets: [{ scope: "bogus" as MemoryScope }] },
        { buckets: [{ scope: "global", project: "proj" }] },
        { buckets: [{ scope: "global", agent: "agent" }] },
        { buckets: [{ scope: "agent" }] },
        { buckets: [{ scope: "agent", agent: "   " }] },
        { buckets: [{ scope: "project", project: 42 as unknown as string }] },
      ];
      for (const filter of invalidFilters) {
        await expect(store.searchMemoriesByVector(query, embedderId, filter, 5)).rejects.toBeInstanceOf(TypeError);
        await expect(store.searchMemoriesKeyword("測試記憶", filter, 5)).rejects.toBeInstanceOf(TypeError);
      }
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
    });

    it("listMemories 列出未刪除的記憶，createdAt 由新到舊", async () => {
      const first = await store.addMemory(memoryInput({ content: "第一筆記憶" }));
      const second = await store.addMemory(memoryInput({ content: "第二筆記憶" }));
      const third = await store.addMemory(memoryInput({ content: "第三筆記憶" }));

      const listed = await store.listMemories();
      // 同一毫秒內新增時以 id 由大到小決勝，因此等於反向的插入順序。
      expect(listed.map((memory) => memory.id)).toEqual([third.id, second.id, first.id]);

      const times = listed.map((memory) => Date.parse(memory.createdAt));
      for (let index = 1; index < times.length; index += 1) {
        expect(times[index - 1]!).toBeGreaterThanOrEqual(times[index]!);
      }

      // 回傳的是完整的 Memory（欄位與 addMemory 的回傳一致）。
      expect(listed[0]).toEqual(third);
      expect(listed[0]?.deletedAt).toBeNull();
    });

    it("listMemories 不列出軟刪除與被取代的記憶", async () => {
      const kept = await store.addMemory(memoryInput({ content: "保留的記憶" }));
      const forgotten = await store.addMemory(memoryInput({ content: "要忘掉的記憶" }));
      const replaced = await store.addMemory(memoryInput({ content: "被取代的舊記憶" }));
      const replacement = await store.addMemory(
        memoryInput({ content: "取代後的新記憶", supersedes: replaced.id }),
      );

      await store.forgetMemory(forgotten.id);

      const listed = await store.listMemories();
      const ids = listed.map((memory) => memory.id);
      expect(ids).toEqual([replacement.id, kept.id]);
      expect(ids).not.toContain(forgotten.id);
      expect(ids).not.toContain(replaced.id);
      // 軟刪除的資料仍在（只是不列出）。
      expect((await store.getMemory(forgotten.id))?.deletedAt).not.toBeNull();
    });

    it("listMemories 的 filter 各自生效，且可組合", async () => {
      const m1 = await store.addMemory(
        memoryInput({ content: "m1", kind: "fact", scope: "global", project: null, agent: "agent-1" }),
      );
      const m2 = await store.addMemory(
        memoryInput({ content: "m2", kind: "decision", scope: "project", project: "proj-1", agent: "agent-1" }),
      );
      const m3 = await store.addMemory(
        memoryInput({ content: "m3", kind: "pitfall", scope: "project", project: "proj-2", agent: "agent-2" }),
      );
      const m4 = await store.addMemory(
        memoryInput({ content: "m4", kind: "fact", scope: "agent", project: null, agent: "agent-2" }),
      );

      const ids = async (filter: MemoryFilter): Promise<number[]> =>
        (await store.listMemories(filter)).map((memory) => memory.id);

      expect(await ids({ kind: "fact" })).toEqual([m4.id, m1.id]);
      expect(await ids({ scope: "project" })).toEqual([m3.id, m2.id]);
      expect(await ids({ scope: "global" })).toEqual([m1.id]);
      expect(await ids({ project: "proj-1" })).toEqual([m2.id]);
      expect(await ids({ project: "proj-none" })).toEqual([]);
      expect(await ids({ agent: "agent-1" })).toEqual([m2.id, m1.id]);
      expect(await ids({ agent: "agent-2", kind: "pitfall" })).toEqual([m3.id]);
      expect(await ids({ agent: "agent-2", kind: "decision" })).toEqual([]);
      expect(await ids({ project: "proj-2", scope: "global" })).toEqual([]);
      // 未指定的欄位＝不過濾
      expect(await ids({})).toHaveLength(4);
    });

    it("listMemories 的 limit：預設 100、指定生效、上限 500、<= 0 回傳空清單", async () => {
      const created: number[] = [];
      for (let index = 0; index < 105; index += 1) {
        const memory = await store.addMemory(memoryInput({ content: `大量記憶 ${index}` }));
        created.push(memory.id);
      }

      // 預設 100
      expect(await store.listMemories()).toHaveLength(MEMORY_LIST_DEFAULT_LIMIT);
      // 指定生效，且仍是最新的在前
      expect((await store.listMemories({ limit: 3 })).map((memory) => memory.id)).toEqual(created.slice(-3).reverse());
      expect(await store.listMemories({ limit: 105 })).toHaveLength(105);
      // 超過上限夾到 500（資料只有 105 筆，因此只驗證不會出錯且拿到全部）
      expect(await store.listMemories({ limit: 10_000 })).toHaveLength(105);
      // 非正整數 → 空清單
      expect(await store.listMemories({ limit: 0 })).toEqual([]);
      expect(await store.listMemories({ limit: -5 })).toEqual([]);
      expect(await store.listMemories({ limit: 1.5 })).toEqual([]);
    });

    it("listMemories 的 limit 上限真的夾在 500", async () => {
      for (let index = 0; index < MEMORY_LIST_MAX_LIMIT + 5; index += 1) {
        await store.addMemory(memoryInput({ content: `超量記憶 ${index}` }));
      }
      expect(await store.listMemories({ limit: MEMORY_LIST_MAX_LIMIT + 1000 })).toHaveLength(MEMORY_LIST_MAX_LIMIT);
      expect(await store.listMemories()).toHaveLength(MEMORY_LIST_DEFAULT_LIMIT);
    });

    it("listMemoriesForExport 只列未刪除、createdAt 由舊到新（與 listMemories 相反）", async () => {
      const first = await store.addMemory(memoryInput({ content: "匯出第一筆" }));
      const forgotten = await store.addMemory(memoryInput({ content: "匯出已刪除" }));
      const second = await store.addMemory(memoryInput({ content: "匯出第二筆" }));
      const replaced = await store.addMemory(memoryInput({ content: "匯出被取代的舊版" }));
      const replacement = await store.addMemory(
        memoryInput({ content: "匯出取代後的新版", supersedes: replaced.id }),
      );

      await store.forgetMemory(forgotten.id);

      // 同一毫秒內新增時以 id 由小到大決勝，因此等於插入順序；軟刪除與被取代者都不列。
      const exported = await store.listMemoriesForExport();
      expect(exported.map((memory) => memory.id)).toEqual([first.id, second.id, replacement.id]);
      expect(exported.map((memory) => memory.id)).not.toContain(forgotten.id);
      expect(exported.map((memory) => memory.id)).not.toContain(replaced.id);

      // 時間由舊到新；回傳完整的 Memory（欄位與 addMemory 的回傳一致）。
      const times = exported.map((memory) => Date.parse(memory.createdAt));
      for (let index = 1; index < times.length; index += 1) {
        expect(times[index]!).toBeGreaterThanOrEqual(times[index - 1]!);
      }
      expect(exported[0]).toEqual(first);
      expect(exported[0]?.deletedAt).toBeNull();

      // 與 `listMemories` 的排序對照：後者是前者的精確反向。
      expect((await store.listMemories()).map((memory) => memory.id)).toEqual(
        exported.map((memory) => memory.id).reverse(),
      );
    });

    it("listMemoriesForExport 不受 listMemories 的 500 筆上限限制", async () => {
      const total = MEMORY_LIST_MAX_LIMIT + 3;
      const created: number[] = [];
      for (let index = 0; index < total; index += 1) {
        const memory = await store.addMemory(memoryInput({ content: `匯出全量記憶 ${index}` }));
        created.push(memory.id);
      }

      expect(await store.listMemories()).toHaveLength(MEMORY_LIST_DEFAULT_LIMIT);
      const exported = await store.listMemoriesForExport();
      expect(exported).toHaveLength(total);
      expect(exported.map((memory) => memory.id)).toEqual(created);
    });

    // -------------------------------------------------------------------------
    // 卡 C2：寫入去重／legacy scope 正規化／硬刪除
    // -------------------------------------------------------------------------

    it("addMemoryUnlessDuplicate：同內容只差空白／換行 → duplicate、回既有列、不新增", async () => {
      const first = await store.addMemoryUnlessDuplicate(
        memoryInput({ content: "去重測試的第一行\n第二行", scope: "project", project: "proj-dedupe" }),
      );
      expect(first.duplicate).toBe(false);
      expect(first.memory.project).toBe("proj-dedupe");

      // 只差前後空白、換行與 Tab：正規化後同 hash → 視為重複。
      const second = await store.addMemoryUnlessDuplicate(
        memoryInput({ content: "  去重測試的第一行\r\n\r\n第二行\t ", scope: "project", project: "proj-dedupe" }),
      );
      expect(second.duplicate).toBe(true);
      expect(second.memory.id).toBe(first.memory.id);
      // 內容保留「第一次寫入」的原文（呼叫端看到的是既有記憶）。
      expect(second.memory.content).toBe("去重測試的第一行\n第二行");

      expect(await store.listMemories({ project: "proj-dedupe" })).toHaveLength(1);
      // 重複時不新增 FTS 列：關鍵字只會命中一筆。
      expect(await store.searchMemoriesKeyword("去重測試", {}, 10)).toHaveLength(1);
    });

    it("addMemoryUnlessDuplicate：不同 scope／project／agent 不誤判（null-safe 的 project 比較）", async () => {
      const base = { content: "同一段內容", kind: "fact", supersedes: null } as const;
      const globalMemory = await store.addMemoryUnlessDuplicate(
        memoryInput({ ...base, scope: "global", project: null, agent: "dedupe-agent" }),
      );
      expect(globalMemory.duplicate).toBe(false);

      // agent 不同 → 不同 key。
      const otherAgent = await store.addMemoryUnlessDuplicate(
        memoryInput({ ...base, scope: "global", project: null, agent: "dedupe-agent-2" }),
      );
      expect(otherAgent.duplicate).toBe(false);

      // scope 不同（project 都是 null）→ 不同 key。
      const agentScope = await store.addMemoryUnlessDuplicate(
        memoryInput({ ...base, scope: "agent", project: null, agent: "dedupe-agent" }),
      );
      expect(agentScope.duplicate).toBe(false);

      // project 不同 → 不同 key；同名專案才是重複。
      const projectA = await store.addMemoryUnlessDuplicate(
        memoryInput({ ...base, scope: "project", project: "dedupe-proj-a", agent: "dedupe-agent" }),
      );
      expect(projectA.duplicate).toBe(false);
      const projectB = await store.addMemoryUnlessDuplicate(
        memoryInput({ ...base, scope: "project", project: "dedupe-proj-b", agent: "dedupe-agent" }),
      );
      expect(projectB.duplicate).toBe(false);
      const projectAAgain = await store.addMemoryUnlessDuplicate(
        memoryInput({ ...base, scope: "project", project: "dedupe-proj-a", agent: "dedupe-agent" }),
      );
      expect(projectAAgain.duplicate).toBe(true);
      expect(projectAAgain.memory.id).toBe(projectA.memory.id);

      expect(await store.listMemories()).toHaveLength(5);
    });

    it("addMemoryUnlessDuplicate：軟刪除後可再新增同內容；force（一般 addMemory）可新增第二筆", async () => {
      const content = "可以重複的內容：軟刪除與 force";
      const first = await store.addMemoryUnlessDuplicate(memoryInput({ content }));
      expect(first.duplicate).toBe(false);

      // 軟刪除者不計入去重 → 可以再新增一筆。
      await store.forgetMemory(first.memory.id);
      const afterDelete = await store.addMemoryUnlessDuplicate(memoryInput({ content }));
      expect(afterDelete.duplicate).toBe(false);
      expect(afterDelete.memory.id).not.toBe(first.memory.id);
      expect((await store.listMemories()).map((memory) => memory.id)).toEqual([afterDelete.memory.id]);

      // force 語意＝走一般 addMemory：即使已存在未刪除的同內容，也新增第二筆。
      const forced = await store.addMemory(memoryInput({ content }));
      expect(forced.id).not.toBe(afterDelete.memory.id);
      expect((await store.listMemories({ limit: 10 })).map((memory) => memory.id).sort()).toEqual(
        [afterDelete.memory.id, forced.id].sort(),
      );
    });

    it("addMemoryUnlessDuplicate：帶 supersedes 時仍會軟刪除被取代者", async () => {
      const original = await store.addMemory(memoryInput({ content: "被取代的原文" }));
      const replacement = await store.addMemoryUnlessDuplicate(
        memoryInput({ content: "取代後的新文", supersedes: original.id }),
      );
      expect(replacement.duplicate).toBe(false);
      expect(replacement.memory.supersedes).toBe(original.id);
      expect((await store.getMemory(original.id))?.deletedAt).not.toBeNull();
      expect((await store.listMemories()).map((memory) => memory.id)).toEqual([replacement.memory.id]);
    });

    it("normalizeLegacyMemoryScopes：矛盾組合各一列＋合法列不動、回傳更新數、第二次為 0", async () => {
      const globalWithProject = await store.addMemory(
        memoryInput({ content: "legacy：global 帶 project", scope: "global", project: "legacy-proj" }),
      );
      const agentWithProject = await store.addMemory(
        memoryInput({ content: "legacy：agent 帶 project", scope: "agent", project: "legacy-proj", agent: "legacy-agent" }),
      );
      const projectWithoutProject = await store.addMemory(
        memoryInput({ content: "legacy：project 沒有 project", scope: "project", project: null }),
      );
      const projectWithBlankProject = await store.addMemory(
        memoryInput({ content: "legacy：project 只有空白", scope: "project", project: "   " }),
      );
      const legalProject = await store.addMemory(
        memoryInput({ content: "合法：project 有 project", scope: "project", project: "legal-proj" }),
      );
      const legalGlobal = await store.addMemory(
        memoryInput({ content: "合法：global 無 project", scope: "global", project: null }),
      );
      const legalAgent = await store.addMemory(
        memoryInput({ content: "合法：agent 無 project", scope: "agent", project: null, agent: "legal-agent" }),
      );

      expect(await store.normalizeLegacyMemoryScopes()).toEqual({ updated: 4 });

      expect(await store.getMemory(globalWithProject.id)).toMatchObject({ scope: "global", project: null });
      expect(await store.getMemory(agentWithProject.id)).toMatchObject({ scope: "agent", project: null });
      expect(await store.getMemory(projectWithoutProject.id)).toMatchObject({ scope: "global", project: null });
      expect(await store.getMemory(projectWithBlankProject.id)).toMatchObject({ scope: "global", project: null });
      // 合法列原樣保留（含 scope=project 的專案名稱）。
      expect(await store.getMemory(legalProject.id)).toMatchObject({ scope: "project", project: "legal-proj" });
      expect(await store.getMemory(legalGlobal.id)).toMatchObject({ scope: "global", project: null });
      expect(await store.getMemory(legalAgent.id)).toMatchObject({ scope: "agent", project: null });
      // 不清除、不合併：列數不變。
      expect(await store.listMemories({ limit: 20 })).toHaveLength(7);

      // 冪等：再跑一次沒有任何更新。
      expect(await store.normalizeLegacyMemoryScopes()).toEqual({ updated: 0 });
      expect(await store.getMemory(legalProject.id)).toMatchObject({ scope: "project", project: "legal-proj" });
    });

    it("hardDeleteMemory：列與 FTS 真的消失（可刪已軟刪除者）、未知 id 回 false", async () => {
      const embedderId = "contract-embedder-hard-delete@1";
      const memory = await store.addMemory(memoryInput({ content: "硬刪除測試的鰻魚飯" }));
      await store.markMemoryEmbedded(memory.id, embedderId, embeddingVector());
      expect(await store.memoryEmbeddingStats(embedderId)).toMatchObject({ total: 1, ready: 1 });

      // 未刪除時兩條搜尋都找得到；軟刪除後只剩硬刪除前的「列還在」。
      expect((await store.searchMemoriesKeyword("鰻魚飯", {}, 10)).map((hit) => hit.id)).toEqual([memory.id]);
      expect((await store.searchKeyword("鰻魚飯", {}, 10)).map((hit) => hit.key)).toEqual([`m:${memory.id}`]);

      // 可刪已軟刪除者：先軟刪除，再硬刪除。
      await store.forgetMemory(memory.id);
      expect(await store.hardDeleteMemory(memory.id)).toBe(true);

      expect(await store.getMemory(memory.id)).toBeNull();
      expect((await store.listMemories()).find((item) => item.id === memory.id)).toBeUndefined();
      // 記憶 FTS 與一般（chunk＋記憶）搜尋都不得再命中。
      expect(await store.searchMemoriesKeyword("鰻魚飯", {}, 10)).toEqual([]);
      expect(await store.searchKeyword("鰻魚飯", {}, 10)).toEqual([]);
      // 向量是同一列的欄位，隨列消失（統計歸零）。
      expect(await store.memoryEmbeddingStats(embedderId)).toMatchObject({ total: 0, ready: 0 });

      // 同一 id 再刪 → false；未知 id → false；都不會建立列。
      expect(await store.hardDeleteMemory(memory.id)).toBe(false);
      expect(await store.hardDeleteMemory(987654)).toBe(false);
      expect(await store.listMemories()).toEqual([]);
    });

    it("hardDeleteMemory：其他記憶的 supersedes 參照不受影響", async () => {
      const original = await store.addMemory(memoryInput({ content: "被硬刪除的舊版本" }));
      const replacement = await store.addMemory(
        memoryInput({ content: "取代後的新版本", supersedes: original.id }),
      );

      expect(await store.hardDeleteMemory(original.id)).toBe(true);
      const after = await store.getMemory(replacement.id);
      expect(after).toMatchObject({ supersedes: original.id, deletedAt: null });
      expect(await store.listMemories()).toEqual([after]);
    });
  });
}
