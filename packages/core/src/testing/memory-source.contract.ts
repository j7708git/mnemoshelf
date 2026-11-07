import { beforeEach, describe, expect, it } from "vitest";
import {
  chunkMemorySourceMessages,
  memorySourceRequestHash,
  RAW_MEMORY_CHUNK_VERSION,
  type NewMemorySource,
} from "../memory/source.js";
import type { MetadataStore } from "../ports/metadata-store.js";
import type { NewMemory } from "../ports/types.js";

export interface MemorySourceContractFixture {
  store: MetadataStore;
  failSecondChunkInsert(enabled: boolean): Promise<void>;
  failPolicyUpdate(): Promise<void>;
}

function sourceInput(overrides: Partial<NewMemorySource> = {}): NewMemorySource {
  const input = {
    agent: "contract-agent",
    scope: "project",
    project: "contract-project",
    sourceSession: "session-a",
    sourceTurn: "turn-a",
    messages: [
      { sourceMessage: "msg-user", role: "user", content: "開頭 😺", occurredAt: null },
      { sourceMessage: "msg-assistant", role: "assistant", content: "結尾 🧪", occurredAt: "2026-11-06T08:07:06.000Z" },
    ],
    chunkVersion: RAW_MEMORY_CHUNK_VERSION,
    ...overrides,
  } satisfies Omit<NewMemorySource, "requestHash">;
  return { ...input, requestHash: memorySourceRequestHash(input) };
}

const EMPTY_STATS = { total: 0, pending: 0, ready: 0, failed: 0, tooLong: 0, stale: 0 };

export function runMemorySourceStoreContract(
  name: string,
  factory: () => Promise<MemorySourceContractFixture> | MemorySourceContractFixture,
): void {
  describe(`原文來源儲存契約 (${name})`, () => {
    let fixture: MemorySourceContractFixture;
    let store: MetadataStore;

    beforeEach(async () => {
      fixture = await factory();
      store = fixture.store;
      await store.migrate();
    });

    function writeSource(input: NewMemorySource) {
      return store.addMemorySource(input, chunkMemorySourceMessages(input.messages));
    }

    it("保留超過 8,000 字元的原文、角色、順序及未知時間，並可搜尋靠近尾段的字", async () => {
      const content = "  開頭\r\n" + "中文 😺\r\n    console.log(value);\r\n".repeat(300) + " endmarker  ";
      const input = sourceInput({
        messages: [
          { sourceMessage: "one", role: "user", content, occurredAt: null },
          { sourceMessage: "two", role: "assistant", content: "   \r\n", occurredAt: "2026-11-06T09:01:02.000+08:00" },
        ],
      });
      expect(content.length).toBeGreaterThan(8000);
      const result = await writeSource(input);
      expect(result.source.messages).toEqual(input.messages);
      await store.migrate();
      expect(await store.getMemorySource(result.source.id)).toEqual(result.source);
      expect(await store.listMemorySourceChunks(result.source.id)).toEqual(result.memories);
      const chunks = result.memories;
      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks.every((memory) => memory.messageIndex === 0 && memory.sourceId === result.source.id)).toBe(true);
      expect(chunks.map((memory) => memory.chunkIndex)).toEqual(chunks.map((_, index) => index));
      for (const memory of chunks) {
        expect(memory.content).toBe(content.slice(memory.sourceStart!, memory.sourceEnd!));
      }
      expect(chunks.at(-1)?.sourceEnd).toBe(content.length);
      const hits = await store.searchMemoriesKeyword("endmarker", { buckets: [{ scope: "project", project: input.project! }] }, 10);
      expect(hits.map((hit) => hit.id)).toContain(chunks.at(-1)?.id);
      expect(await store.searchMemoriesKeyword("endmarker", { buckets: [{ scope: "global" }] }, 10)).toEqual([]);
    });

    it("同一事件同時寫入只新增一次，改 scope 不影響重送，文字相同的其他事件各自保存", async () => {
      const input = sourceInput();
      expect(await store.checkMemorySource(input)).toBe("available");
      const results = await Promise.all([writeSource(input), writeSource(input)]);
      const first = results.find((result) => !result.duplicate)!;
      expect(results.filter((result) => !result.duplicate)).toHaveLength(1);
      expect(results[0]?.memories).toEqual(results[1]?.memories);
      expect(await store.checkMemorySource(input)).toBe("duplicate");
      const moved = await store.updateMemorySource(first.source.id, { scope: "agent" });
      expect(moved).toMatchObject({ scope: "agent", project: null, requestHash: input.requestHash });
      const replay = await writeSource(input);
      expect(replay).toMatchObject({ duplicate: true, source: moved });
      expect(replay.memories.every((memory) => memory.scope === "agent" && memory.project === null)).toBe(true);
      const different = sourceInput({ scope: "global", project: null });
      await expect(store.checkMemorySource(different)).rejects.toMatchObject({ code: "source-conflict" });
      await expect(writeSource(different)).rejects.toMatchObject({ code: "source-conflict" });
      const revision = await writeSource(sourceInput({ sourceTurn: "turn-b" }));
      expect(revision.duplicate).toBe(false);
      expect(revision.source.id).not.toBe(first.source.id);
      expect((await store.listMemorySourcesForExport()).map(({ id }) => id)).toEqual([first.source.id, revision.source.id]);
    });

    it("片段與來源整組更新、釘選、軟刪及硬刪，且拒絕透過舊 API 取代片段", async () => {
      const input = sourceInput();
      const { source, memories: [first, second] } = await writeSource(input);
      expect(await store.updateMemory(second!.id, { scope: "global" })).toMatchObject({ scope: "global", project: null });
      expect(await store.getMemorySource(source.id)).toMatchObject({ scope: "global", project: null });
      expect((await store.getMemory(first!.id))?.scope).toBe("global");
      await store.setMemoryPinned(second!.id, true);
      expect((await store.listMemorySourceChunks(source.id)).map(({ pinned }) => pinned)).toEqual([true, true]);

      const legacy: NewMemory = {
        content: first!.content, kind: "fact", scope: "global", project: null, agent: source.agent, supersedes: second!.id,
      };
      await expect(store.addMemory(legacy)).rejects.toMatchObject({ code: "source-conflict" });
      await expect(store.addMemoryUnlessDuplicate(legacy)).rejects.toMatchObject({ code: "source-conflict" });
      const independent = await store.addMemoryUnlessDuplicate({ ...legacy, supersedes: null });
      expect(independent).toMatchObject({ duplicate: false, memory: {
        sourceId: null, messageIndex: null, chunkIndex: null, sourceStart: null, sourceEnd: null, chunkVersion: null,
      } });

      await store.markMemoryEmbedded(first!.id, "test-model", new Float32Array([1, 0]));
      await store.forgetMemory(second!.id);
      const removed = await store.getMemorySource(source.id);
      expect(removed?.deletedAt).toEqual(expect.any(String));
      expect((await store.getMemory(first!.id))?.deletedAt).toBe(removed?.deletedAt);
      expect((await store.getMemory(second!.id))?.deletedAt).toBe(removed?.deletedAt);
      expect(await store.listMemorySourceChunks(source.id)).toEqual([]);
      expect(await store.memorySourceEmbeddingStats(source.id, "test-model")).toEqual(EMPTY_STATS);
      expect(await store.updateMemorySource(source.id, { scope: "agent" })).toBeNull();
      expect(await store.replaceMemorySourceChunks(source.id, "raw-v2", [])).toEqual([]);
      expect(await store.listMemorySourcesForExport()).toEqual([]);
      await expect(writeSource(input)).rejects.toMatchObject({ code: "source-conflict" });
      await expect(store.checkMemorySource(input)).rejects.toMatchObject({ code: "source-conflict" });

      expect(await store.hardDeleteMemory(first!.id)).toBe(true);
      expect(await store.getMemory(first!.id)).toBeNull();
      expect(await store.getMemory(second!.id)).toBeNull();
      expect(await store.getMemorySource(source.id)).toBeNull();
      expect(await store.deleteMemorySource(source.id, true)).toBe(false);
      await expect(writeSource(input)).rejects.toMatchObject({ code: "source-conflict" });
      await expect(store.checkMemorySource(input)).rejects.toMatchObject({ code: "source-conflict" });
      expect(await store.listMemories()).toEqual([independent.memory]);
    });

    it("直接刪除來源也會處理整組片段，未知來源統計為全零", async () => {
      const result = await writeSource(sourceInput());
      const id = result.source.id;
      expect(await store.deleteMemorySource(id)).toBe(true);
      expect((await store.getMemorySource(id))?.deletedAt).toEqual(expect.any(String));
      expect(await store.deleteMemorySource(id, true)).toBe(true);
      expect(await store.getMemorySource(id)).toBeNull();
      expect(await store.getMemory(result.memories[0]!.id)).toBeNull();
      expect(await store.memorySourceEmbeddingStats(id, "test-model")).toEqual(EMPTY_STATS);
      expect(await store.listMemorySourceChunks(id)).toEqual([]);
    });

    it("新增中途資料庫失敗會回滾來源及片段，可以原事件重試", async () => {
      const input = sourceInput();
      const invalidChunks = chunkMemorySourceMessages(input.messages);
      invalidChunks[1]!.content = "不符合來源的片段";
      await expect(store.addMemorySource(input, invalidChunks)).rejects.toBeInstanceOf(TypeError);
      await fixture.failSecondChunkInsert(true);
      await expect(writeSource(input)).rejects.toThrow("test_chunk_insert");
      expect(await store.listMemorySourcesForExport()).toEqual([]);
      expect(await store.listMemories()).toEqual([]);
      expect(await store.checkMemorySource(input)).toBe("available");
      await fixture.failSecondChunkInsert(false);
      expect((await writeSource(input)).duplicate).toBe(false);
    });

    it("重建失敗回滾舊片段、向量與版本，成功只留新版本並保留釘選", async () => {
      const input = sourceInput();
      const { source, memories } = await writeSource(input);
      const id = source.id;
      const firstId = memories[0]!.id;
      await store.setMemoryPinned(firstId, true);
      await store.markMemoryEmbedded(firstId, "test-model", new Float32Array([1, 0]));
      await store.markMemoryEmbeddingFailed(memories[1]!.id, "too-long");
      const before = await store.listMemorySourceChunks(id);
      const chunks = chunkMemorySourceMessages(input.messages);
      expect(await store.memorySourceEmbeddingStats(id, "new-model")).toEqual({
        total: 2, pending: 0, ready: 1, failed: 0, tooLong: 1, stale: 1,
      });

      await fixture.failSecondChunkInsert(true);
      await expect(store.replaceMemorySourceChunks(id, "raw-v2", chunks)).rejects.toThrow("test_chunk_insert");
      expect(await store.getMemorySource(id)).toEqual(source);
      expect(await store.listMemorySourceChunks(id)).toEqual(before);
      expect((await store.memorySourceEmbeddingStats(id, "test-model")).ready).toBe(1);
      await fixture.failSecondChunkInsert(false);

      const after = await store.replaceMemorySourceChunks(id, "raw-v2", chunks);
      expect(await store.getMemorySource(id)).toEqual({ ...source, chunkVersion: "raw-v2" });
      expect(after.every((memory) => memory.pinned && memory.chunkVersion === "raw-v2")).toBe(true);
      expect(after.map((memory) => memory.id)).not.toContain(firstId);
      await store.markMemoryEmbedded(firstId, "test-model", new Float32Array([1, 0]));
      expect(await store.getMemory(firstId)).toBeNull();
      expect(await store.memorySourceEmbeddingStats(id, "test-model")).toEqual({ ...EMPTY_STATS, total: 2, pending: 2 });
      expect(await writeSource(input)).toMatchObject({ duplicate: true, memories: after });
    });

    it("完整列出超過 500 個片段，嵌入回填可越過第一批失敗項", async () => {
      const input = sourceInput({
        messages: Array.from({ length: 504 }, (_, i) => ({
          sourceMessage: `msg-${i}`, role: "assistant", content: `片段 ${i}`, occurredAt: null,
        })),
      });
      const { source, memories } = await writeSource(input);
      expect(await store.listMemorySourceChunks(source.id)).toEqual(memories);
      expect(memories).toHaveLength(504);
      const firstBatch = await store.listMemoriesNeedingEmbedding("test-model", 100);
      await Promise.all(firstBatch.map((memory) => store.markMemoryEmbeddingFailed(memory.id, "failed")));
      const nextBatch = await store.listMemoriesNeedingEmbedding("test-model", 100, firstBatch.at(-1)!);
      expect(nextBatch.map(({ id }) => id)).toEqual(memories.slice(304, 404).reverse().map(({ id }) => id));
      await expect(store.listMemoriesNeedingEmbedding("test-model", 100, { id: 1, createdAt: "bad" }))
        .rejects.toBeInstanceOf(TypeError);
    });

    it("持久政策同值不增版，寫入失敗不改有效值", async () => {
      expect(await store.getMemoryPolicy()).toEqual({ maskSecrets: true, version: 1 });
      expect(await store.setMemoryPolicy(true)).toEqual({ maskSecrets: true, version: 1 });
      const toggles = await Promise.all([store.setMemoryPolicy(false), store.setMemoryPolicy(false)]);
      expect(toggles).toEqual([{ maskSecrets: false, version: 2 }, { maskSecrets: false, version: 2 }]);
      await fixture.failPolicyUpdate();
      await expect(store.setMemoryPolicy(true)).rejects.toThrow("test_policy_update");
      expect(await store.getMemoryPolicy()).toEqual({ maskSecrets: false, version: 2 });
      await expect(store.setMemoryPolicy("false" as unknown as boolean)).rejects.toBeInstanceOf(TypeError);
    });
  });
}
