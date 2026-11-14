import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryLibraryEntry } from "../memory/library.js";
import { chunkMemorySourceMessages, memorySourceRequestHash, RAW_MEMORY_CHUNK_VERSION } from "../memory/source.js";
import type { MetadataStore } from "../ports/metadata-store.js";
import type { NewMemory } from "../ports/types.js";
import type { MetadataStoreFactory } from "./metadata-store.contract.js";

const memory = (overrides: Partial<NewMemory> = {}): NewMemory => ({
  content: "合成記憶", kind: "fact", scope: "project", project: "current", agent: "writer-current", supersedes: null, ...overrides,
});

/** 同一套管理查詢契約由兩個真實 adapter 執行。 */
export function runMemoryLibraryContract(name: string, factory: MetadataStoreFactory): void {
  describe(`記憶管理查詢契約 (${name})`, () => {
    let store: MetadataStore;
    beforeEach(async () => { store = await factory(); await store.migrate(); });
    afterEach(() => { vi.restoreAllMocks(); });

    async function source(turn: string, contents = ["回合第一片", "回合尾片 endmarker 100%_done"]) {
      const input = {
        agent: "writer-source", scope: "project" as const, project: "source-project", sourceSession: "session", sourceTurn: turn,
        messages: contents.map((content, index) => ({ sourceMessage: `message-${index}`, role: "user" as const, content, occurredAt: null })),
        chunkVersion: RAW_MEMORY_CHUNK_VERSION,
      };
      return store.addMemorySource({ ...input, requestHash: memorySourceRequestHash(input) }, chunkMemorySourceMessages(input.messages));
    }

    it("空庫有完整且一致的統計與空選單", async () => {
      expect(await store.listMemoryLibrary()).toEqual({ entries: [], total: 0, counts: { sources: 0, memories: 0 },
        facets: { projects: [], writers: [], hasUnassigned: false }, nextCursor: null });
    });

    it("超過 500 筆仍完整分頁；舊釘選前置，同毫秒無重複遺漏，選單不取自當頁", async () => {
      const time = vi.spyOn(Date.prototype, "toISOString").mockReturnValue("2026-01-01T00:00:00.000Z");
      const old = await store.addMemory(memory({ project: "old-project", agent: "writer-old" }));
      await store.setMemoryPinned(old.id, true);
      time.mockReturnValue("2026-02-01T00:00:00.000Z");
      const ids: number[] = [];
      for (let index = 0; index < 505; index += 1) ids.push((await store.addMemory(memory({ content: `記憶 ${index}` }))).id);
      const raw = await source("same-time");
      const missing = await store.addMemory(memory({ scope: "agent", project: null, agent: "writer-agent" }));
      const removed = await store.addMemory(memory({ project: "removed-project", agent: "writer-removed" }));
      await store.forgetMemory(removed.id);
      time.mockRestore();
      const first = await store.listMemoryLibrary({ limit: 2 });
      expect(first.entries[0]?.id).toBe(old.id);
      expect(first).toMatchObject({ total: 508, counts: { memories: 507, sources: 1 }, facets: {
        projects: ["current", "old-project", "source-project"], writers: ["writer-agent", "writer-current", "writer-old", "writer-source"], hasUnassigned: true,
      } });
      const all: MemoryLibraryEntry[] = [];
      let cursor: string | undefined;
      do {
        const page = await store.listMemoryLibrary({ limit: 73, ...(cursor === undefined ? {} : { cursor }) });
        expect(page.total).toBe(508);
        all.push(...page.entries);
        cursor = page.nextCursor ?? undefined;
      } while (cursor !== undefined);
      expect(all.map(({ type, id }) => `${type}:${id}`)).toEqual([
        `memory:${old.id}`, `memory:${missing.id}`, ...ids.reverse().map((id) => `memory:${id}`), `source:${raw.source.id}`,
      ]);
      expect((await store.listMemoryLibrary({ project: "old-project", writer: "writer-old" })).entries.map(({ id }) => id)).toEqual([old.id]);
      expect((await store.listMemoryLibrary({ project: "old-project", writer: "writer-current" })).total).toBe(0);
      expect((await store.listMemoryLibrary({ writer: "writer-agent", unassigned: true })).entries.map(({ id }) => id)).toEqual([missing.id]);
      expect((await store.listMemoryLibrary({ writer: "writer-source", type: "source" })).entries.map(({ id }) => id)).toEqual([raw.source.id]);
    }, 30_000);

    it("完整回合先聚合；尾片命中仍使用穩定代表，字面 %/_ 不展開", async () => {
      const raw = await source("large", ["first " + "甲".repeat(10_000), "endmarker 100%_done"]);
      const short = await store.addMemory(memory({ content: "endmarker 100XXdone" }));
      expect(raw.memories.length).toBeGreaterThan(2);
      const page = await store.listMemoryLibrary({ query: "endmarker", limit: 1 });
      expect(page.total).toBe(2);
      const literal = await store.listMemoryLibrary({ query: "100%_done", type: "source" });
      expect(literal.entries).toHaveLength(1);
      expect(literal.entries[0]).toMatchObject({ type: "source", id: raw.source.id,
        memory: { id: raw.memories[0]!.id, content: raw.memories[0]!.content }, chunkCount: raw.memories.length });
      expect((await store.listMemoryLibrary({ query: "endmarker", project: "current", type: "memory" })).entries[0]?.id).toBe(short.id);
      await store.setMemoryPinned(raw.memories.at(-1)!.id, true);
      expect((await store.listMemoryLibrary({ limit: 1 })).entries[0]?.id).toBe(raw.source.id);
      await store.forgetMemory(raw.memories.at(-1)!.id);
      const after = await store.listMemoryLibrary();
      expect(after).toMatchObject({ total: 1, counts: { sources: 0, memories: 1 }, facets: { projects: ["current"], writers: ["writer-current"] } });
    });

    it("writer 對 global/project/agent 一律精確匹配，名稱 all 不代表全部", async () => {
      for (const scope of ["global", "project", "agent"] as const) {
        await store.addMemory(memory({ scope, project: scope === "project" ? "all" : null, agent: "all" }));
      }
      await store.addMemory(memory({ agent: "all-extra" }));
      expect((await store.listMemoryLibrary({ writer: "all" })).total).toBe(3);
      expect((await store.listMemoryLibrary({ writer: "all", project: "all" })).total).toBe(1);
      expect((await store.listMemoryLibrary({ writer: "all", unassigned: true })).total).toBe(2);
    });

    it("游標綁定篩選，拒絕畸形與錯誤類型；limit 預設 25、上限 100", async () => {
      for (let index = 0; index < 102; index += 1) await store.addMemory(memory({ content: `entry-${index}` }));
      expect((await store.listMemoryLibrary()).entries).toHaveLength(25);
      expect((await store.listMemoryLibrary({ limit: 101 })).entries).toHaveLength(100);
      const first = await store.listMemoryLibrary({ limit: 1 });
      await expect(store.listMemoryLibrary({ cursor: first.nextCursor!, writer: "different" })).rejects.toThrow("cursor");
      for (const cursor of ["invalid", "e30", "bnVsbA", "x".repeat(1025)]) {
        await expect(store.listMemoryLibrary({ cursor })).rejects.toThrow("cursor");
      }
      const decoded = JSON.parse(Buffer.from(first.nextCursor!, "base64url").toString("utf8")) as Record<string, unknown>;
      for (const patch of [{ id: 0 }, { pinned: 2 }, { type: "other" }, { createdAt: "2026-02-31T00:00:00.000Z" }]) {
        const cursor = Buffer.from(JSON.stringify({ ...decoded, ...patch })).toString("base64url");
        await expect(store.listMemoryLibrary({ cursor })).rejects.toThrow("cursor");
      }
      await expect(store.listMemoryLibrary({ project: "current", unassigned: true })).rejects.toThrow("不可同時");
      for (const limit of [0, -1, 1.5, NaN]) await expect(store.listMemoryLibrary({ limit })).rejects.toThrow("limit");
      // 合法變更頁大小不會改變篩選與續頁起點。
      const next = await store.listMemoryLibrary({ limit: 2, cursor: first.nextCursor! });
      expect(next.entries).toHaveLength(2);
      expect(next.entries.some(({ id }) => id === first.entries[0]!.id)).toBe(false);
    });
  });
}
