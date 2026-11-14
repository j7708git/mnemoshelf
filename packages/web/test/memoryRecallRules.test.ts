import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deleteMemoryRecallRule, getMemoryRecallRules, importMemories, MemoryImportError, MemoryRecallConflictError,
  previewMemoryRecallRule, saveMemoryRecallRule, updateMemoryOrganization,
  type MemoryOrganization, type MemoryRulePreview,
} from "../src/api";
import { memoryPolicySourceLabel, memoryRuleSaveOptions, memoryRuleTargetLabel } from "../src/memoryOrganization";

const preview: MemoryRulePreview = { revision: 3, dataRevision: 12, matched: { sources: 4, memories: 2 }, changed: { sources: 3, memories: 1 }, preservedOverrides: { sources: 1, memories: 1 } };
const rule = { id: "fixture-rule", project: "all", writer: "writer-a", policy: "global" as const };
const settings = { revision: 3, dataRevision: 12, rules: [rule] };
afterEach(() => vi.unstubAllGlobals());

describe("召回規則寫入契約", () => {
  it("預設只影響未來；明選既有資料才帶預覽的資料修訂", async () => {
    const fetch = vi.fn().mockImplementation(async () => Response.json({ settings, ...preview })); vi.stubGlobal("fetch", fetch);
    await saveMemoryRecallRule(rule, memoryRuleSaveOptions(preview, false));
    await saveMemoryRecallRule(rule, memoryRuleSaveOptions(preview, true));
    const [future, existing] = fetch.mock.calls.map((call) => JSON.parse(call[1].body));
    expect(future).toEqual({ project: "all", writer: "writer-a", policy: "global", expectedRevision: 3, applyExisting: false });
    expect(existing).toEqual({ ...future, applyExisting: true, expectedDataRevision: 12 });
  });

  it("讀取、預覽與刪除使用同一規則識別；刪除不攜帶批次歷史套用", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(Response.json(settings)).mockResolvedValueOnce(Response.json(preview)).mockResolvedValueOnce(Response.json({ ...settings, rules: [] }));
    vi.stubGlobal("fetch", fetch);
    expect((await getMemoryRecallRules()).rules).toEqual([rule]);
    expect(await previewMemoryRecallRule(rule)).toEqual(preview);
    await deleteMemoryRecallRule(rule.id, settings.revision);
    expect(fetch.mock.calls[1][0]).toBe("/memory-recall-rules/preview");
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ rule });
    expect(fetch.mock.calls[2][1].method).toBe("DELETE");
    expect(JSON.parse(fetch.mock.calls[2][1].body)).toEqual({ expectedRevision: 3 });
  });

  it("組織更新用完整回合 id，policy=null 清除例外，來源與寫入者不被修改", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ source: {}, recallVersion: 13 })); vi.stubGlobal("fetch", fetch);
    await updateMemoryOrganization("source", 7, { assignedProject: "next", recallPolicy: null, expectedDataRevision: 12 });
    expect(fetch.mock.calls[0][0]).toBe("/memory-library/source/7/organization");
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ assignedProject: "next", recallPolicy: null, expectedDataRevision: 12 });
  });

  it("規則和資料修訂衝突需要重新預覽", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: { message: "conflict" } }, { status: 409 })));
    await expect(saveMemoryRecallRule(rule, memoryRuleSaveOptions(preview, true))).rejects.toBeInstanceOf(MemoryRecallConflictError);
    await expect(updateMemoryOrganization("memory", 8, { recallPolicy: "disabled", expectedDataRevision: 1 })).rejects.toThrow("重新載入並預覽");
  });

  it("用途標籤區分歷史規則、舊資料與單筆例外", () => {
    expect(memoryRuleTargetLabel(rule)).toBe("專案 all · 寫入者 writer-a");
    const metadata: MemoryOrganization = { originProject: null, assignedProject: "all", recallPolicy: "global", recallPolicySource: "rule", recallRuleId: rule.id, recallRuleRevision: 3 };
    expect(memoryPolicySourceLabel(metadata)).toContain("規則快照 fixture-rule（修訂 3）");
    expect(memoryPolicySourceLabel({ ...metadata, recallPolicySource: "legacy" })).toBe("沿用舊資料用途");
    expect(memoryPolicySourceLabel({ ...metadata, recallPolicySource: "override" })).toBe("這筆記憶的單筆例外");
    expect(memoryPolicySourceLabel({ ...metadata, recallPolicySource: "default" })).toBe("寫入時的預設用途");
  });
});

describe("備份規則選擇與部分完成", () => {
  it("預設保留目前規則，明確還原時乾跑與正式匯入都帶修訂", async () => {
    const result = { dryRun: true, total: 1, valid: 1, invalid: [], duplicates: 0, redacted: 0, created: 0, wouldCreate: 1,
      rules: { mode: "preserve", available: 1, availableInBackup: true, replaced: false, revision: 3 } };
    const fetch = vi.fn().mockImplementation(async () => Response.json(result)); vi.stubGlobal("fetch", fetch);
    await importMemories("fixture", { dryRun: true, rulesMode: "preserve" });
    await importMemories("fixture", { dryRun: true, rulesMode: "replace", expectedRevision: 3 });
    await importMemories("fixture", { dryRun: false, rulesMode: "replace", expectedRevision: 3 });
    expect(fetch.mock.calls.map((call) => call[0])).toEqual([
      "/memories/import?dryRun=1&rulesMode=preserve", "/memories/import?dryRun=1&rulesMode=replace&expectedRevision=3", "/memories/import?rulesMode=replace&expectedRevision=3",
    ]);
  });

  it("CAS失敗與已部分匯入不同，後者保留成功筆數與規則還原結果", async () => {
    const partial = { partial: true, created: 2, duplicates: 1, failed: 1, pending: 3, rulesRestored: true };
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ error: { message: "revision conflict" } }, { status: 409 }))
      .mockResolvedValueOnce(Response.json({ ...partial, error: { message: "import interrupted" } }, { status: 409 }));
    vi.stubGlobal("fetch", fetch);
    await expect(importMemories("fixture", { dryRun: false, rulesMode: "replace", expectedRevision: 1 })).rejects.toBeInstanceOf(MemoryRecallConflictError);
    try { await importMemories("fixture", { dryRun: false }); throw new Error("應拒絕部分失敗"); }
    catch (error) {
      expect(error).toBeInstanceOf(MemoryImportError);
      expect((error as MemoryImportError).partial).toMatchObject(partial);
    }
  });
});
