import { beforeEach, describe, expect, it } from "vitest";
import { chunkMemorySourceMessages, memorySourceRequestHash, RAW_MEMORY_CHUNK_VERSION, type NewMemorySource } from "../memory/source.js";
import { MemoryRecallConflictError, type MemoryOrganization, type MemoryRecallRule } from "../memory/organization.js";
import type { MetadataStore } from "../ports/metadata-store.js";
import type { NewMemory } from "../ports/types.js";
export interface MemoryOrganizationContractFixture {
  store: MetadataStore;
  failOrganizationUpdate(): Promise<void>;
}

const input = (overrides: Partial<NewMemory> = {}): NewMemory => ({ content: "synthetic needle", kind: "fact", scope: "project", project: "alpha", agent: "writer-a", supersedes: null, ...overrides });
const organization = (overrides: Partial<MemoryOrganization> = {}): MemoryOrganization => ({ originProject: "original", assignedProject: "restored", recallPolicy: "agent", recallPolicySource: "override", recallRuleId: null, recallRuleRevision: null, ...overrides });

/** 規則優先序、快照保留與 CAS 的兩後端共同契約。 */
export function runMemoryOrganizationContract(name: string, factory: () => MemoryOrganizationContractFixture | Promise<MemoryOrganizationContractFixture>): void {
  describe(`記憶組織與召回規則契約 (${name})`, () => {
    let store: MetadataStore;
    let fixture: MemoryOrganizationContractFixture;
    beforeEach(async () => { fixture = await factory(); store = fixture.store; await store.migrate(); });
    async function save(rule: MemoryRecallRule, applyExisting = false) {
      const preview = await store.previewMemoryRecallRule(rule);
      return store.upsertMemoryRecallRule(rule, { expectedRevision: preview.revision, applyExisting, ...(applyExisting ? { expectedDataRevision: preview.dataRevision } : {}) });
    }
    async function raw(turn = "turn", extra: Partial<NewMemorySource> = {}) {
      const request = { agent: "writer-a", scope: "project" as const, project: "alpha", sourceSession: "session", sourceTurn: turn,
        messages: ["first needle", "last needle"].map((content, index) => ({ sourceMessage: `message-${index}`, role: "user" as const, content, occurredAt: null })),
        chunkVersion: RAW_MEMORY_CHUNK_VERSION, ...extra };
      const source = { ...request, requestHash: memorySourceRequestHash(request) };
      return { input: source, result: await store.addMemorySource(source, chunkMemorySourceMessages(source.messages)) };
    }

    it("新寫入保留原始專案，改用途不清來源與歸屬，管理依歸屬查詢", async () => {
      const memory = await store.addMemory(input());
      expect(memory).toMatchObject({ originProject: "alpha", assignedProject: "alpha", recallPolicy: "project", recallPolicySource: "default" });
      const moved = await store.updateMemory(memory.id, { scope: "global" });
      expect(moved).toMatchObject({ scope: "global", project: null, originProject: "alpha", assignedProject: "alpha", recallPolicy: "global", recallPolicySource: "override" });
      expect((await store.listMemoryLibrary({ project: "alpha" })).entries[0]?.id).toBe(memory.id);
      const page = await store.listMemoryLibrary();
      expect(page.recallVersion).toBe((await store.getMemoryRecallSettings()).dataRevision);
      const corrected = await store.updateMemory(memory.id, { scope: "project", project: "beta" });
      expect(corrected).toMatchObject({ originProject: "alpha", assignedProject: "beta", project: "beta" });
      const global = await store.addMemory(input({ scope: "global", project: null, originProject: "cwd", assignedProject: "bucket" }));
      expect(global).toMatchObject({ originProject: "cwd", assignedProject: "bucket", scope: "global", project: null });
    });

    it("組合 > 專案 > 寫入者 > 原請求，缺專案的 project 用途降 disabled", async () => {
      await save({ id: "writer", writer: "writer-a", policy: "global" });
      await save({ id: "project", project: "alpha", policy: "agent" });
      await save({ id: "pair", project: "alpha", writer: "writer-a", policy: "disabled" });
      expect(await store.addMemory(input())).toMatchObject({ recallPolicy: "disabled", recallRuleId: "pair", recallPolicySource: "rule" });
      expect(await store.addMemory(input({ agent: "writer-b" }))).toMatchObject({ recallPolicy: "agent", recallRuleId: "project" });
      expect(await store.addMemory(input({ project: "beta" }))).toMatchObject({ recallPolicy: "global", recallRuleId: "writer", assignedProject: "beta" });
      expect(await store.addMemory(input({ project: "beta", agent: "writer-b" }))).toMatchObject({ recallPolicy: "project", recallPolicySource: "default" });
      await save({ id: "writer", writer: "writer-a", policy: "project" });
      expect(await store.addMemory(input({ scope: "global", project: null }))).toMatchObject({ recallPolicy: "disabled", scope: "agent", project: null });
    });

    it("預設僅未來套用，改規則後重送短記憶或來源不變更既有快照", async () => {
      const short = await store.addMemoryUnlessDuplicate(input());
      const source = await raw();
      await save({ id: "future", project: "alpha", policy: "global" });
      expect(await store.getMemory(short.memory.id)).toEqual(short.memory);
      expect(await store.getMemorySource(source.result.source.id)).toEqual(source.result.source);
      expect(await store.addMemoryUnlessDuplicate(input())).toEqual({ memory: short.memory, duplicate: true });
      const replay = await store.addMemorySource(source.input, chunkMemorySourceMessages(source.input.messages));
      expect(replay).toEqual({ ...source.result, duplicate: true });
      expect(await store.addMemory(input({ content: "new entry" }))).toMatchObject({ recallPolicy: "global", assignedProject: "alpha" });
      const globalA = await store.addMemoryUnlessDuplicate(input({ scope: "global", project: null, assignedProject: "a" }));
      const globalB = await store.addMemoryUnlessDuplicate(input({ scope: "global", project: null, assignedProject: "b" }));
      expect(globalA.duplicate).toBe(false); expect(globalB.duplicate).toBe(false);
      expect(globalA.memory.id).not.toBe(globalB.memory.id);
    });

    it("明選既有套用按完整項目計數，override保留，來源與所有片段一致", async () => {
      const short = await store.addMemory(input());
      const override = await store.addMemory(input({ content: "override" }));
      await store.updateMemoryOrganization("memory", override.id, { recallPolicy: "agent" });
      const source = await raw();
      await store.markMemoryEmbedded(short.id, "model", new Float32Array([1, 0]));
      await store.setMemoryPinned(source.result.memories[0]!.id, true);
      const rule = { id: "all-alpha", project: "alpha", policy: "global" as const };
      const preview = await store.previewMemoryRecallRule(rule);
      expect(preview).toMatchObject({ matched: { sources: 1, memories: 2 }, changed: { sources: 1, memories: 1 }, preservedOverrides: { sources: 0, memories: 1 } });
      const result = await store.upsertMemoryRecallRule(rule, { expectedRevision: preview.revision, expectedDataRevision: preview.dataRevision, applyExisting: true });
      expect(result.changed).toEqual(preview.changed);
      expect(result.dataRevision).toBeGreaterThan(preview.dataRevision);
      expect(await store.getMemory(override.id)).toMatchObject({ recallPolicy: "agent", recallPolicySource: "override" });
      expect(await store.getMemorySource(source.result.source.id)).toMatchObject({ recallPolicy: "global", originProject: "alpha", requestHash: source.result.source.requestHash });
      const chunks = await store.listMemorySourceChunks(source.result.source.id);
      expect(chunks.map(({ id }) => id)).toEqual(source.result.memories.map(({ id }) => id));
      expect(chunks.every((memory) => memory.recallPolicy === "global" && memory.assignedProject === "alpha" && memory.pinned)).toBe(true);
      expect(await store.searchMemoriesByVector(new Float32Array([1, 0]), "model", { buckets: [{ scope: "global" }] }, 1)).toEqual([{ id: short.id, score: 1 }]);
    });

    it("版本競態拒絕套用，失敗不改規則或資料；selector唯一", async () => {
      await store.addMemory(input());
      const rule = { id: "rule", project: "alpha", policy: "disabled" as const };
      const preview = await store.previewMemoryRecallRule(rule);
      await store.addMemory(input({ content: "arrived after preview" }));
      await expect(store.upsertMemoryRecallRule(rule, { expectedRevision: preview.revision, expectedDataRevision: preview.dataRevision, applyExisting: true })).rejects.toBeInstanceOf(MemoryRecallConflictError);
      expect((await store.getMemoryRecallSettings()).rules).toEqual([]);
      await expect(store.upsertMemoryRecallRule(rule, { expectedRevision: preview.revision, applyExisting: true })).rejects.toBeInstanceOf(TypeError);
      await save(rule);
      await expect(store.deleteMemoryRecallRule("rule", preview.revision)).rejects.toBeInstanceOf(MemoryRecallConflictError);
      await expect(store.replaceMemoryRecallRules([], { expectedRevision: preview.revision })).rejects.toBeInstanceOf(MemoryRecallConflictError);
      await expect(store.previewMemoryRecallRule({ ...rule, id: "duplicate-selector" })).rejects.toBeInstanceOf(TypeError);
      const before = await store.getMemoryRecallSettings();
      await expect(store.replaceMemoryRecallRules([{ id: "empty", policy: "global" }], { expectedRevision: before.revision })).rejects.toBeInstanceOf(TypeError);
      expect(await store.getMemoryRecallSettings()).toEqual(before);
    });

    it("disabled 在排名及 limit 前排除，writer跨全部用途，近期與通用記憶搜尋共用條件", async () => {
      const eligible = await store.addMemory(input({ scope: "global", project: null }));
      await store.markMemoryEmbedded(eligible.id, "model", new Float32Array([0, 1]));
      const wrong = await store.addMemory(input({ agent: "writer-b", scope: "global", project: null }));
      await store.markMemoryEmbedded(wrong.id, "model", new Float32Array([1, 0]));
      const disabled = await store.addMemory(input({ content: "needle needle needle" }));
      await store.markMemoryEmbedded(disabled.id, "model", new Float32Array([1, 0]));
      await store.updateMemoryOrganization("memory", disabled.id, { recallPolicy: "disabled" });
      const filter = { buckets: [{ scope: "global" as const }], writer: "writer-a" };
      expect((await store.searchMemoriesByVector(new Float32Array([1, 0]), "model", filter, 1)).map(({ id }) => id)).toEqual([eligible.id]);
      expect((await store.searchMemoriesKeyword("needle", filter, 1)).map(({ id }) => id)).toEqual([eligible.id]);
      expect((await store.listMemoriesForRecall({ ...filter, limit: 1 })).map(({ id }) => id)).toEqual([eligible.id]);
      expect((await store.searchKeyword("needle", { memoryFilter: filter }, 1)).map(({ key }) => key)).toEqual([`m:${eligible.id}`]);
      expect(await store.listMemoriesForRecall({ buckets: [] })).toEqual([]);
      expect(await store.searchKeyword("needle", { memoryFilter: { buckets: [] } }, 10)).toEqual([]);
      expect((await store.listMemoryLibrary()).total).toBe(3);
    });

    it("整理歸屬重求規則；override保留，清除例外後按目前規則求值，刪規則只影響未來", async () => {
      const memory = await store.addMemory(input());
      await save({ id: "beta", project: "beta", policy: "global" });
      const moved = await store.updateMemoryOrganization("memory", memory.id, { assignedProject: "beta" });
      expect(moved).toMatchObject({ originProject: "alpha", assignedProject: "beta", recallPolicy: "global", recallRuleId: "beta" });
      await store.updateMemoryOrganization("memory", memory.id, { recallPolicy: "agent" });
      await store.updateMemoryOrganization("memory", memory.id, { assignedProject: "alpha" });
      expect(await store.getMemory(memory.id)).toMatchObject({ recallPolicy: "agent", recallPolicySource: "override" });
      await store.updateMemoryOrganization("memory", memory.id, { recallPolicy: null });
      expect(await store.getMemory(memory.id)).toMatchObject({ recallPolicy: "project", recallPolicySource: "default" });
      await store.updateMemoryOrganization("memory", memory.id, { assignedProject: "beta" });
      const snapshot = await store.getMemory(memory.id);
      const settings = await store.getMemoryRecallSettings();
      await store.deleteMemoryRecallRule("beta", settings.revision);
      expect(await store.getMemory(memory.id)).toEqual(snapshot);
      await store.updateMemoryOrganization("memory", memory.id, { recallPolicy: null });
      expect(await store.getMemory(memory.id)).toMatchObject({ recallPolicy: "project", recallRuleId: null });
      const stale = (await store.getMemoryRecallSettings()).dataRevision;
      await store.addMemory(input({ content: "new" }));
      await expect(store.updateMemoryOrganization("memory", memory.id, { recallPolicy: "disabled", expectedDataRevision: stale })).rejects.toBeInstanceOf(MemoryRecallConflictError);
    });

    it("supersede、rechunk繼承快照；受信任備份復原不被目前規則覆寫", async () => {
      const original = await store.addMemory(input());
      const source = await raw();
      await save({ id: "new-rule", project: "alpha", policy: "disabled" });
      const revision = await store.addMemory(input({ content: "edited", supersedes: original.id }));
      expect(revision).toMatchObject({ originProject: "alpha", assignedProject: "alpha", recallPolicy: "project", recallPolicySource: "default" });
      await store.setMemoryPinned(source.result.memories[0]!.id, true);
      const chunks = await store.replaceMemorySourceChunks(source.result.source.id, RAW_MEMORY_CHUNK_VERSION, chunkMemorySourceMessages(source.input.messages));
      expect(chunks.every((chunk) => chunk.recallPolicy === "project" && chunk.pinned)).toBe(true);
      const snapshot = organization();
      const restored = await store.addMemoryUnlessDuplicate(input({ content: "restored", organization: snapshot }));
      expect(restored.memory).toMatchObject(snapshot);
      const restoredSource = await raw("restored-turn", { organization: snapshot });
      expect(restoredSource.result.source).toMatchObject(snapshot);
      expect(restoredSource.result.memories.every((chunk) => chunk.originProject === "original" && chunk.assignedProject === "restored" && chunk.recallPolicy === "agent")).toBe(true);
      const settings = await store.getMemoryRecallSettings();
      await store.replaceMemoryRecallRules([{ id: "restored-rule", writer: "writer-a", policy: "global" }], { expectedRevision: settings.revision });
      expect(await store.getMemory(restored.memory.id)).toEqual(restored.memory);
    });

    it("備份保留原去重維度，同庫匯入冪等且不同原請求不因有效投影相同而被合併", async () => {
      const original = await store.addMemory(input());
      await store.updateMemoryOrganization("memory", original.id, { recallPolicy: "global" });
      const snapshot = (await store.getMemory(original.id))!;
      const record = (await store.listMemoriesForExport())[0]!;
      expect(record).toMatchObject({ scope: "global", project: null, dedupeScope: "project", dedupeProject: "alpha" });
      expect(snapshot).not.toHaveProperty("dedupeScope");
      const restored = await store.addMemoryUnlessDuplicate(input({ scope: snapshot.scope, project: snapshot.project, organization: snapshot,
        restoreDedupe: { scope: record.dedupeScope, project: record.dedupeProject } }));
      expect(restored).toEqual({ memory: snapshot, duplicate: true });
      expect((await store.listMemoryLibrary()).total).toBe(1);
      expect(await store.addMemoryUnlessDuplicate(input())).toEqual({ memory: snapshot, duplicate: true });
      const other = await store.addMemoryUnlessDuplicate(input({ scope: "global", project: null, originProject: "alpha", assignedProject: "alpha" }));
      expect(other.duplicate).toBe(false);
      expect(other.memory.id).not.toBe(original.id);
      const records = await store.listMemoriesForExport();
      for (const backup of records) {
        const replay = await store.addMemoryUnlessDuplicate(input({ scope: backup.scope, project: backup.project, organization: backup,
          restoreDedupe: { scope: backup.dedupeScope, project: backup.dedupeProject } }));
        expect(replay.duplicate).toBe(true); expect(replay.memory.id).toBe(backup.id);
      }
      expect((await store.listMemoryLibrary()).total).toBe(2);
    });

    it("刪除與硬刪會推進dataRevision，舊source tombstone與去重仍有效", async () => {
      const source = await raw();
      const first = await store.getMemoryRecallSettings();
      await store.deleteMemorySource(source.result.source.id, true);
      expect((await store.getMemoryRecallSettings()).dataRevision).toBeGreaterThan(first.dataRevision);
      await expect(store.addMemorySource(source.input, chunkMemorySourceMessages(source.input.messages))).rejects.toMatchObject({ code: "source-conflict" });
      const short = await store.addMemory(input());
      const before = await store.getMemoryRecallSettings();
      await store.forgetMemory(short.id);
      expect((await store.getMemoryRecallSettings()).dataRevision).toBeGreaterThan(before.dataRevision);
    });

    it("套規則中途失敗回滾規則、版本、短記憶、來源與所有片段", async () => {
      const short = await store.addMemory(input());
      const source = await raw();
      await store.markMemoryEmbedded(short.id, "model", new Float32Array([1, 0]));
      const beforeSettings = await store.getMemoryRecallSettings();
      const beforeMemories = await store.listMemoriesForExport();
      const beforeSources = await store.listMemorySourcesForExport();
      await fixture.failOrganizationUpdate();
      await expect(store.upsertMemoryRecallRule({ id: "fail", project: "alpha", policy: "disabled" }, {
        expectedRevision: beforeSettings.revision, expectedDataRevision: beforeSettings.dataRevision, applyExisting: true,
      })).rejects.toThrow("organization_update_failed");
      expect(await store.getMemoryRecallSettings()).toEqual(beforeSettings);
      expect(await store.listMemoriesForExport()).toEqual(beforeMemories);
      expect(await store.listMemorySourcesForExport()).toEqual(beforeSources);
      expect((await store.listMemorySourceChunks(source.result.source.id)).every((chunk) => chunk.recallPolicy === "project")).toBe(true);
      expect(await store.searchMemoriesByVector(new Float32Array([1, 0]), "model", {}, 1)).toEqual([{ id: short.id, score: 1 }]);
    });
  });
}
