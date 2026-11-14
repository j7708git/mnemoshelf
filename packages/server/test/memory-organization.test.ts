import { afterEach, describe, expect, it, vi } from "vitest";
import type { Memory, MemoryRecallSettings, MemorySource } from "@mnemoshelf/core";
import { api, startTestServer, TEST_TOKEN, type TestServer } from "./helpers.js";
import { organizationName, organizationOf, parseOrganizationOrigin, parseOrganizationSnapshot, parseRecallRule, revisionNumber } from "../src/memory-organization.js";

const servers: TestServer[] = [];
afterEach(async () => { for (const server of servers.splice(0).reverse()) await server.close(); });
async function start() { const server = await startTestServer(); servers.push(server); return server.instance; }
const source = (turn = "one") => ({ agent: "writer/raw", scope: "project", project: "alpha", sourceSession: "session", sourceTurn: turn,
  messages: [{ sourceMessage: "message", role: "user", content: "synthetic organization evidence ".repeat(20), occurredAt: null }] });

describe("組織與召回政策 REST", () => {
  it("規則預設只套未來；事件重送、原始 hash 與單筆覆寫不被新規則改寫", async () => {
    const server = await start();
    const saved = await api(server, "POST", "/memory-sources", { body: source() });
    const first = (saved.body as { source: MemorySource }).source;
    const original = await server.store.getMemorySource(first.id);
    const settings = (await api(server, "GET", "/memory-recall-rules")).body as MemoryRecallSettings;
    const rule = { id: "writer-rule", writer: "writer/raw", policy: "disabled" };
    const { id: _ruleId, ...ruleBody } = rule;
    const created = await api(server, "PUT", "/memory-recall-rules/writer-rule", { body: { ...ruleBody, expectedRevision: settings.revision } });
    expect(created.status).toBe(200);
    expect((await server.store.getMemorySource(first.id))?.recallPolicy).toBe("project");
    expect((await api(server, "POST", "/memory-sources", { body: source() })).body).toMatchObject({ duplicate: true, source: { recallPolicy: "project" } });
    expect((await api(server, "POST", "/memory-sources", { body: source("two") })).body).toMatchObject({ source: { recallPolicy: "disabled", originProject: "alpha", assignedProject: "alpha" } });
    expect((await api(server, "PATCH", `/memory-library/source/${first.id}/organization`, { body: { recallPolicy: "global" } })).status).toBe(200);
    const preview = (await api(server, "POST", "/memory-recall-rules/preview", { body: { rule } })).body as { revision: number; dataRevision: number };
    const applied = await api(server, "PUT", "/memory-recall-rules/writer-rule", { body: { ...ruleBody, applyExisting: true, expectedRevision: preview.revision, expectedDataRevision: preview.dataRevision } });
    expect(applied.body).toMatchObject({ preservedOverrides: { sources: 1, memories: 0 } });
    expect(await server.store.getMemorySource(first.id)).toMatchObject({ requestHash: original!.requestHash, originProject: "alpha", assignedProject: "alpha", recallPolicy: "global", recallPolicySource: "override" });
    expect((await api(server, "POST", "/memory-sources", { body: source() })).body).toMatchObject({ duplicate: true });
    await api(server, "DELETE", `/memory-sources/${first.id}?hard=true`);
    expect((await api(server, "POST", "/memory-sources", { body: source() })).status).toBe(409);
  });

  it("disabled 排除所有召回；管理全文仍可讀，政策變更使舊續讀游標失效", async () => {
    const server = await start();
    const saved = (await api(server, "POST", "/memory-sources", { body: source() })).body as { source: MemorySource };
    const id = saved.source.id;
    const page = (await api(server, "GET", `/memory-library/source/${id}?maxChars=30`)).body as { next: Record<string, number> };
    expect(page.next.recallVersion).toBeGreaterThan(0);
    await api(server, "PATCH", `/memory-library/source/${id}/organization`, { body: { recallPolicy: "disabled" } });
    expect((await api(server, "GET", `/memory-sources/${id}?project=alpha`)).status).toBe(404);
    expect((await api(server, "GET", `/memory-library/source/${id}`)).status).toBe(200);
    const params = new URLSearchParams(Object.entries(page.next).map(([key, value]) => [key, String(value)] as [string, string]));
    expect((await api(server, "GET", `/memory-library/source/${id}?${params}`)).status).toBe(409);
    expect((await api(server, "GET", "/memories/recent?project=alpha&writer=writer%2Fraw")).body).toMatchObject({ memories: [] });
    expect((await api(server, "POST", "/memories/search", { body: { query: "organization", project: "alpha" } })).body).toMatchObject({ hits: [] });
    expect((await api(server, "POST", "/search", { body: { query: "organization", mode: "keyword" } })).body).toMatchObject({ hits: [] });
    expect((await api(server, "GET", "/memory-library")).body).toMatchObject({ total: 1 });
  });

  it("writer 精確篩選獨立於召回身分；scope PATCH 保留原始來源，supersede 繼承政策", async () => {
    const server = await start();
    const created = (await api(server, "POST", "/memories", { body: { content: "synthetic policy needle", agent: "writer/raw", project: "alpha" } })).body as Memory;
    const id = created.id;
    await api(server, "PATCH", `/memories/${id}`, { body: { scope: "global" } });
    expect(await server.store.getMemory(id)).toMatchObject({ originProject: "alpha", assignedProject: "alpha", recallPolicy: "global", recallPolicySource: "override" });
    const hit = await api(server, "POST", "/memories/search", { body: { query: "needle", project: "beta", agent: "caller", writer: "writer/raw" } });
    expect((hit.body as { hits: Memory[] }).hits.map((row) => row.id)).toContain(id);
    expect((await api(server, "POST", "/memories/search", { body: { query: "needle", project: "beta", agent: "caller", writer: "another" } })).body).toMatchObject({ hits: [] });
    const replaced = await api(server, "POST", "/memories", { body: { content: "updated needle", agent: "writer/raw", scope: "global", supersedes: id } });
    expect(replaced.body).toMatchObject({ originProject: "alpha", assignedProject: "alpha", recallPolicy: "global", recallPolicySource: "override" });
  });

  it("v3 備份保留快照及規則；還原繞過現行規則，過期 CAS 不先寫入記憶", async () => {
    const original = await start();
    const added = (await api(original, "POST", "/memories", { body: { content: "backup organization needle", agent: "writer", project: "alpha" } })).body as Memory;
    await api(original, "PATCH", `/memory-library/memory/${added.id}/organization`, { body: { recallPolicy: "disabled" } });
    const backup = await fetch(`${original.url}/memories/export`, { headers: { authorization: `Bearer ${TEST_TOKEN}` } });
    expect(backup.status).toBe(200);
    const text = await backup.text();
    expect(JSON.parse(text.split("\n")[0]!)).toMatchObject({ schemaVersion: 3, type: "settings" });
    expect(text).not.toContain("requestHash");
    const target = await start();
    const settings = await target.store.getMemoryRecallSettings();
    await target.store.upsertMemoryRecallRule({ id: "all-writer", writer: "writer", policy: "global" }, { expectedRevision: settings.revision });
    const send = (query: string) => fetch(`${target.url}/memories/import${query}`, { method: "POST", headers: { authorization: `Bearer ${TEST_TOKEN}` }, body: text });
    expect((await send(`?rulesMode=replace&expectedRevision=${settings.revision}`)).status).toBe(409);
    expect(await target.store.listMemories()).toHaveLength(0);
    expect((await send("")).status).toBe(200);
    expect((await target.store.listMemories())[0]).toMatchObject({ originProject: "alpha", assignedProject: "alpha", recallPolicy: "disabled", recallPolicySource: "override" });
    expect((await target.store.getMemoryRecallSettings()).rules).toHaveLength(1);
  });
});

it("組織輸入驗證不允許來源修改、秘密或偽造政策快照", () => {
  const snapshot = { originProject: null, assignedProject: "alpha", recallPolicy: "project" as const, recallPolicySource: "legacy" as const, recallRuleId: null, recallRuleRevision: null };
  expect(organizationOf(snapshot)).toEqual(snapshot);
  expect(parseOrganizationSnapshot(snapshot)).toEqual(snapshot);
  expect(parseOrganizationOrigin({ originProject: " alpha ", assignedProject: null })).toEqual({ originProject: "alpha", assignedProject: null });
  expect(() => parseOrganizationOrigin({ organization: snapshot })).toThrow();
  expect(organizationName(" writer ", "writer")).toBe(" writer ");
  expect(revisionNumber(1, "revision")).toBe(1);
  expect(() => revisionNumber(0, "revision")).toThrow();
  expect(parseRecallRule({ id: "r", writer: "writer", policy: "disabled" })).toMatchObject({ id: "r", policy: "disabled" });
  expect(() => parseRecallRule({ id: "r", policy: "global" })).toThrow();
});


it("v1/v2 匯入維持 legacy 召回語意，v3 逐筆失敗如實回報已替換規則", async () => {
  const server = await start();
  const initial = await server.store.getMemoryRecallSettings();
  await server.store.upsertMemoryRecallRule({ id: "disabled-writer", writer: "legacy-writer", policy: "disabled" }, { expectedRevision: initial.revision });
  const send = (text: string, query = "") => fetch(`${server.url}/memories/import${query}`, { method: "POST", headers: { authorization: `Bearer ${TEST_TOKEN}` }, body: text });
  const legacy = { schemaVersion: 1, content: "legacy import needle", kind: "fact", scope: "project", project: "alpha", agent: "legacy-writer" };
  const raw = { schemaVersion: 2, type: "source", source: { ...source("legacy"), agent: "legacy-writer" }, createdAt: "2026-01-01T00:00:00Z" };
  expect((await send([legacy, raw].map((row) => JSON.stringify(row)).join("\n"))).status).toBe(200);
  const rows = await server.store.listMemories();
  expect(rows.every((row) => row.originProject === null && row.recallPolicy === "project" && row.recallPolicySource === "legacy")).toBe(true);
  const settings = await server.store.getMemoryRecallSettings();
  const organization = { originProject: null, assignedProject: "alpha", recallPolicy: "project", recallPolicySource: "legacy", recallRuleId: null, recallRuleRevision: null };
  const backup = [{ schemaVersion: 3, type: "settings", rules: [] }, ...["one", "two"].map((content) => ({ schemaVersion: 3, type: "memory", memory: { ...legacy, schemaVersion: 1, content }, organization, dedupe: { scope: "project", project: "alpha" } }))].map((row) => JSON.stringify(row)).join("\n");
  const add = server.store.addMemoryUnlessDuplicate.bind(server.store);
  let calls = 0;
  vi.spyOn(server.store, "addMemoryUnlessDuplicate").mockImplementation(async (input) => { if (++calls === 2) throw new Error("synthetic write failure"); return add(input); });
  const response = await send(backup, `?rulesMode=replace&expectedRevision=${settings.revision}`);
  expect(response.status).toBe(500);
  expect(await response.json()).toMatchObject({ partial: true, created: 1, duplicates: 0, failed: 1, pending: 0, rulesRestored: true, rules: { replaced: true } });
  expect((await server.store.getMemoryRecallSettings()).rules).toEqual([]);
});


it("原文與最近召回跨連線讀取競態不會將舊內容標成新版本", async () => {
  const server = await start();
  const saved = (await api(server, "POST", "/memory-sources", { body: source() })).body as { source: MemorySource };
  const originalRead = server.store.getMemorySource.bind(server.store);
  vi.spyOn(server.store, "getMemorySource").mockImplementationOnce(async (id) => {
    const old = await originalRead(id);
    await server.store.updateMemoryOrganization("source", id, { recallPolicy: "disabled" });
    return old;
  });
  expect(await api(server, "GET", `/memory-sources/${saved.source.id}?project=alpha`)).toMatchObject({ status: 409, body: { error: "policy-changed" } });
  await server.store.updateMemoryOrganization("source", saved.source.id, { recallPolicy: "project" });
  const originalList = server.store.listMemoriesForRecall.bind(server.store);
  vi.spyOn(server.store, "listMemoriesForRecall").mockImplementationOnce(async (filter) => {
    const old = await originalList(filter);
    await server.store.updateMemoryOrganization("source", saved.source.id, { recallPolicy: "disabled" });
    return old;
  });
  expect(await api(server, "GET", "/memories/recent?project=alpha")).toMatchObject({ status: 409, body: { error: "policy-changed" } });
});

it("v3 保存原始去重範圍，同庫匯回與 dry-run 一致且不合併不同原始請求", async () => {
  const server = await start();
  const post = (scope: string, project?: string) => api(server, "POST", "/memories", { body: { content: "same dedupe evidence", agent: "writer", scope, ...(project === undefined ? {} : { project }), assignedProject: "alpha" } });
  const first = (await post("project", "alpha")).body as Memory;
  await api(server, "PATCH", `/memory-library/memory/${first.id}/organization`, { body: { recallPolicy: "global" } });
  const second = (await post("global")).body as Memory;
  expect(second.id).not.toBe(first.id);
  const backup = await fetch(`${server.url}/memories/export`, { headers: { authorization: `Bearer ${TEST_TOKEN}` } });
  const text = await backup.text();
  const rows = text.trim().split("\n").map((line) => JSON.parse(line));
  expect(rows.filter((row) => row.type === "memory").map((row) => row.dedupe.scope)).toEqual(["project", "global"]);
  expect(await api(server, "GET", "/memories")).not.toHaveProperty("body.memories.0.dedupeScope");
  for (const query of ["?dryRun=1", ""]) {
    const response = await fetch(`${server.url}/memories/import${query}`, { method: "POST", headers: { authorization: `Bearer ${TEST_TOKEN}` }, body: text });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ duplicates: 2, created: 0, wouldCreate: 0 });
  }
  expect(await server.store.listMemories()).toHaveLength(2);
});


it("匯入已建立內容但釘選失敗時仍精確回報 created 與未嘗試筆數", async () => {
  const server = await start();
  vi.spyOn(server.store, "setMemoryPinned").mockRejectedValueOnce(new Error("synthetic pin failure"));
  const rows = ["first", "pending"].map((content) => ({ schemaVersion: 1, content, agent: "writer", scope: "global", project: null, pinned: true }));
  const response = await fetch(`${server.url}/memories/import`, { method: "POST", headers: { authorization: `Bearer ${TEST_TOKEN}` }, body: rows.map((row) => JSON.stringify(row)).join("\n") });
  expect(response.status).toBe(500);
  expect(await response.json()).toMatchObject({ partial: true, created: 1, duplicates: 0, failed: 1, failedAfterCreate: true, pending: 1 });
  expect(await server.store.listMemories()).toHaveLength(1);
});

it("規則端點拒絕未知欄位，拼錯 writer 不會擴大規則或修改資料", async () => {
  const server = await start();
  await api(server, "POST", "/memory-sources", { body: source() });
  const initial = await server.store.getMemoryRecallSettings();
  const rule = { id: "strict-rule", project: "alpha", writer: "writer/raw", policy: "global" };
  const { id, ...ruleBody } = rule;
  expect((await api(server, "PUT", `/memory-recall-rules/${id}`, {
    body: { ...ruleBody, expectedRevision: initial.revision },
  })).status).toBe(200);
  const before = await server.store.getMemoryRecallSettings();
  const memories = await server.store.listMemories();
  const sources = await server.store.listMemorySourcesForExport();
  const writeOptions = { expectedRevision: before.revision, applyExisting: true, expectedDataRevision: before.dataRevision };
  const cases: Array<{ method: string; path: string; body: unknown }> = [
    { method: "POST", path: "preview", body: { rule, applyExisting: true } },
    { method: "POST", path: "preview", body: { rule: { id, project: "alpha", writers: "writer/raw", policy: "global" } } },
    { method: "PUT", path: id, body: { project: "alpha", writers: "writer/raw", policy: "global", ...writeOptions } },
    { method: "PUT", path: id, body: { ...rule, ...writeOptions } },
    { method: "PUT", path: id, body: { ...ruleBody, originProject: "another", ...writeOptions } },
    { method: "DELETE", path: id, body: { expectedRevision: before.revision, applyExisting: true } },
  ];
  for (const test of cases) {
    const response = await api(server, test.method, `/memory-recall-rules/${test.path}`, { body: test.body });
    expect(response.status, JSON.stringify(test)).toBe(400);
    expect(await server.store.getMemoryRecallSettings()).toEqual(before);
    expect(await server.store.listMemories()).toEqual(memories);
    expect(await server.store.listMemorySourcesForExport()).toEqual(sources);
  }
  expect((await api(server, "DELETE", `/memory-recall-rules/${id}`, {
    body: { expectedRevision: before.revision },
  })).status).toBe(200);
});

it("v3 備份規則同樣拒絕未知欄位，整批驗證失敗不改規則或寫入記憶", async () => {
  const server = await start();
  const before = await server.store.getMemoryRecallSettings();
  const rows = [
    { schemaVersion: 3, type: "settings", rules: [{ id: "typo-rule", project: "alpha", writers: "writer", policy: "global" }] },
    { schemaVersion: 1, content: "不應匯入的合成記憶", agent: "writer", scope: "global", project: null },
  ];
  const response = await fetch(`${server.url}/memories/import`, {
    method: "POST", headers: { authorization: `Bearer ${TEST_TOKEN}` },
    body: rows.map((row) => JSON.stringify(row)).join("\n"),
  });
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ created: 0, invalid: [{ line: 1 }] });
  expect(await server.store.getMemoryRecallSettings()).toEqual(before);
  expect(await server.store.listMemories()).toEqual([]);
});
