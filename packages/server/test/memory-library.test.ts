import { afterEach, describe, expect, it } from "vitest";
import type { MemoryLibraryPage, NewMemory } from "@mnemoshelf/core";
import { api, startTestServer, type TestServer } from "./helpers.js";

let server: TestServer | undefined;
afterEach(async () => { await server?.close(); server = undefined; });

const memory = (overrides: Partial<NewMemory> = {}): NewMemory => ({
  content: "合成短記憶", kind: "fact", scope: "project", project: "alpha", agent: "writer-a", supersedes: null, ...overrides,
});

describe("GET /memory-library", () => {
  it("完整管理查詢先過濾再分頁，舊端點維持最近 100 筆契約", async () => {
    server = await startTestServer();
    const { instance } = server;
    const old = await instance.store.addMemory(memory({ project: "old-project", agent: "writer-old" }));
    await instance.store.setMemoryPinned(old.id, true);
    for (let index = 0; index < 105; index += 1) await instance.store.addMemory(memory({ content: `合成記憶 ${index}` }));
    await instance.store.addMemory(memory({ scope: "agent", project: null, agent: "writer-agent" }));
    const response = await api(instance, "GET", "/memory-library?limit=1");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.body).toMatchObject({ entries: [{ type: "memory", id: old.id, chunkCount: 1 }], total: 107,
      counts: { memories: 107, sources: 0 }, facets: { projects: ["alpha", "old-project"], writers: ["writer-a", "writer-agent", "writer-old"], hasUnassigned: true },
      untrusted: true, policyVersion: 1 });
    const first = response.body as MemoryLibraryPage;
    const second = await api(instance, "GET", `/memory-library?limit=1&cursor=${first.nextCursor!}`);
    expect(second.status).toBe(200);
    expect((second.body as MemoryLibraryPage).entries[0]?.id).not.toBe(old.id);
    const filtered = await api(instance, "GET", "/memory-library?project=old-project&writer=writer-old&type=memory");
    expect(filtered.body).toMatchObject({ total: 1, entries: [{ id: old.id }], nextCursor: null });
    expect((await api(instance, "GET", "/memory-library?project=old-project&writer=writer-a")).body).toMatchObject({ total: 0, entries: [] });
    expect((await api(instance, "GET", "/memory-library?unassigned=true&writer=writer-agent")).body).toMatchObject({ total: 1 });
    expect(((await api(instance, "GET", "/memories")).body as { memories: unknown[] }).memories).toHaveLength(100);
  });

  it("回合以一筆呈現、尾片可搜尋、代表列可整回合釘選與刪除", async () => {
    server = await startTestServer();
    const { instance } = server;
    const created = await api(instance, "POST", "/memory-sources", { body: {
      agent: "writer-source", scope: "project", project: "source-project", sourceSession: "session", sourceTurn: "turn",
      messages: [
        { sourceMessage: "first", role: "user", content: "開頭 " + "甲".repeat(9000), occurredAt: null },
        { sourceMessage: "last", role: "assistant", content: "尾片 needle 100%_done", occurredAt: null },
      ],
    } });
    expect(created.status).toBe(201);
    const written = created.body as { source: { id: number }; memoryIds: number[] };
    const response = await api(instance, "GET", `/memory-library?query=${encodeURIComponent("100%_done")}&type=source&limit=1`);
    expect(response.status).toBe(200);
    const page = response.body as MemoryLibraryPage;
    expect(page).toMatchObject({ total: 1, counts: { sources: 1, memories: 0 }, nextCursor: null, entries: [{ type: "source", id: written.source.id,
      chunkCount: written.memoryIds.length, memory: { id: written.memoryIds[0], sourceId: written.source.id } }] });
    expect(page.entries[0]?.memory.content).toContain("開頭");
    const id = page.entries[0]!.memory.id;
    expect((await api(instance, "POST", `/memories/${id}/pin`, { body: { pinned: true } })).status).toBe(200);
    expect((await instance.store.listMemorySourceChunks(written.source.id)).every(({ pinned }) => pinned)).toBe(true);
    expect((await api(instance, "DELETE", `/memories/${id}`)).status).toBe(200);
    expect((await api(instance, "GET", "/memory-library")).body).toMatchObject({ total: 0, entries: [], facets: { projects: [], writers: [] } });
  });

  it("保留記憶與選單 metadata 遮罩；切換政策只影響內容，讀取不改既有資料", async () => {
    server = await startTestServer();
    const { instance } = server;
    const secret = "api_key=" + "synthetic-value-123456789";
    const saved = await instance.store.addMemory(memory({ content: secret, project: secret, agent: secret }));
    const masked = await api(instance, "GET", "/memory-library");
    expect(masked.status).toBe(200);
    expect(JSON.stringify(masked.body)).not.toContain("synthetic-value-123456789");
    expect(JSON.stringify(masked.body)).toContain("[REDACTED:assignment]");
    await api(instance, "PATCH", "/memory-policy", { body: { maskSecrets: false } });
    const raw = (await api(instance, "GET", "/memory-library")).body as MemoryLibraryPage;
    expect(raw.entries[0]?.memory.content).toBe(secret);
    expect(raw.facets.projects).not.toContain(secret);
    expect(raw.facets.writers).not.toContain(secret);
    expect(await instance.store.getMemory(saved.id)).toEqual(saved);
  });

  it("錯誤篩選與游標回 400，token/方法/未知子路徑保持 API 邊界", async () => {
    server = await startTestServer();
    const { instance } = server;
    for (const query of ["unassigned=1", "project=alpha&unassigned=true", "type=other", "limit=0", "limit=1.5", "cursor=bad", "writer=", "query=", `project=${"x".repeat(201)}`, "writer=%00"]) {
      expect((await api(instance, "GET", `/memory-library?${query}`)).status, query).toBe(400);
    }
    await instance.store.addMemory(memory());
    await instance.store.addMemory(memory({ content: "另一筆" }));
    const first = (await api(instance, "GET", "/memory-library?limit=1")).body as MemoryLibraryPage;
    expect((await api(instance, "GET", `/memory-library?writer=other&cursor=${first.nextCursor!}`)).status).toBe(400);
    expect((await api(instance, "GET", "/memory-library", { token: null })).status).toBe(401);
    const wrongMethod = await api(instance, "POST", "/memory-library");
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("allow")).toBe("GET");
    expect((await api(instance, "GET", "/memory-library/other")).status).toBe(404);
  });
});
