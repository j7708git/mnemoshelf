import type { MemorySourceMessage } from "@mnemoshelf/core";
import { FakeEmbedder } from "@mnemoshelf/core/testing";
import { afterEach, expect, it, vi } from "vitest";
import { createServer, type MnemoshelfServer } from "../src/index.js";
import { MAX_MEMORY_SOURCE_BYTES, type SourceWriteRequest } from "../src/memory-source.js";
import { api, startTestServer, TEST_TOKEN, type TestServer } from "./helpers.js";

const servers: TestServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0).reverse()) await server.close();
});

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function start() {
  const server = await startTestServer();
  servers.push(server);
  return server.instance;
}

function message(
  sourceMessage: string, content: string, role: MemorySourceMessage["role"] = "user", occurredAt: string | null = null,
): MemorySourceMessage {
  return { sourceMessage, content, role, occurredAt };
}

function event(overrides: Partial<SourceWriteRequest> = {}): SourceWriteRequest {
  return {
    agent: "raw-test", scope: "project", project: "rain-lab", sourceSession: "session-a", sourceTurn: "turn-a",
    messages: [message("message-a", "合成觀測紀錄")], ...overrides,
  };
}

type Written = {
  source: { id: number; scope: string; project: string | null };
  memoryIds: number[];
  duplicate: boolean;
  saved: true;
  policyVersion: number;
  redacted: boolean;
  redactedCount: number;
};

async function write(instance: MnemoshelfServer, source: SourceWriteRequest, status = 201): Promise<Written> {
  const response = await api(instance, "POST", "/memory-sources", { body: source });
  expect(response.status, JSON.stringify(response.body)).toBe(status);
  expect(response.body).not.toHaveProperty("source.requestHash");
  expect(response.body).not.toHaveProperty("source.messages");
  return response.body as Written;
}

async function setMask(instance: MnemoshelfServer, maskSecrets: boolean) {
  return api(instance, "PATCH", "/memory-policy", { body: { maskSecrets } });
}

type Page = {
  messages: Array<MemorySourceMessage & { messageIndex: number; start: number; end: number; totalChars: number }>;
  next: { messageIndex: number; offset: number; policyVersion: number } | null;
  indexState: { total: number };
  policyVersion: number;
  untrusted: true;
};

async function read(instance: MnemoshelfServer, id: number, scope = "project=rain-lab"): Promise<Page> {
  const response = await api(instance, "GET", `/memory-sources/${id}?${scope}`);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body as Page;
}

async function backup(instance: MnemoshelfServer) {
  const result = await fetch(`${instance.url}/memories/export`, { headers: { authorization: `Bearer ${TEST_TOKEN}` } });
  expect(result.status).toBe(200);
  return result.text();
}

async function restore(instance: MnemoshelfServer, body: string, dryRun = false) {
  const result = await fetch(`${instance.url}/memories/import${dryRun ? "?dryRun=1" : ""}`, {
    method: "POST", headers: { authorization: `Bearer ${TEST_TOKEN}` }, body,
  });
  return { status: result.status, body: await result.json() };
}

it("以 UTF-16 安全分頁逐字還原長回合、空訊息、emoji 與 CRLF，保留角色及時間", async () => {
  const instance = await start();
  const payload = event({ messages: [
    message("empty", ""),
    message("question", "  原問題？\r\n"),
    message("answer", "甲".repeat(7999) + "🧪" + "\r\n  const code = 42;\r\n" + "風向".repeat(3800),
      "assistant", "2026-01-02T03:04:05+08:00"),
  ] });
  const saved = await write(instance, payload);
  expect(saved).toMatchObject({ duplicate: false, saved: true, policyVersion: 1, redacted: false, redactedCount: 0 });
  const sourceId = saved.source.id;
  expect(saved.memoryIds.length).toBeGreaterThan(12);
  expect(await api(instance, "GET", `/memory-sources/${sourceId}`, { token: null })).toMatchObject({ status: 401 });
  expect(await api(instance, "GET", `/memory-sources/${sourceId}`)).toMatchObject({ status: 400 });
  expect(await api(instance, "GET", `/memory-sources/${sourceId}?project=other`)).toMatchObject({ status: 404 });
  expect(await api(instance, "GET", `/memory-sources/${sourceId}?project=rain-lab&offset=3`)).toMatchObject({ status: 400 });

  const reassembled = new Map<number, string>();
  let page = await read(instance, sourceId, `project=rain-lab&maxChars=${8000 + payload.messages[1]!.content.length}`);
  for (let round = 0; ; round += 1) {
    expect(round).toBeLessThan(5);
    expect(page.untrusted).toBe(true);
    expect(page.indexState.total).toBe(saved.memoryIds.length);
    for (const slice of page.messages) {
      const source = payload.messages[slice.messageIndex]!;
      expect(slice.content).not.toMatch(/[\uD800-\uDFFF]/u);
      expect(slice.content).toBe(source.content.slice(slice.start, slice.end));
      expect(slice.totalChars).toBe(source.content.length);
      expect(slice.role).toBe(source.role);
      expect(slice.occurredAt).toBe(source.occurredAt);
      reassembled.set(slice.messageIndex, (reassembled.get(slice.messageIndex) ?? "") + slice.content);
    }
    if (page.next === null) break;
    const { messageIndex, offset, policyVersion } = page.next;
    page = await read(instance, sourceId, `project=rain-lab&messageIndex=${messageIndex}&offset=${offset}&policyVersion=${policyVersion}`);
  }
  expect([...reassembled.values()]).toEqual(payload.messages.map(({ content }) => content));
});

it("跨片段機密在所有讀取出口遮罩，原文與嵌入資料不因政策改寫", async () => {
  const instance = await start();
  expect((await api(instance, "GET", "/memory-policy")).body).toEqual({ maskSecrets: true, version: 1 });
  expect((await setMask(instance, false)).body).toEqual({ maskSecrets: false, version: 2 });
  expect((await setMask(instance, false)).body).toEqual({ maskSecrets: false, version: 2 });
  const secretFront = "fixture-prefix".repeat(27);
  const secretTail = "fixture-fragment".repeat(27);
  const assigned = ["password", ' = "', secretFront, " ", secretTail, '"'].join("");
  const content = "a".repeat(920) + " " + assigned + " sampleanchor " + "b".repeat(220);
  const payload = event({ messages: [message("message-a", content, "assistant")] });
  const saved = await write(instance, payload);
  const legacy = await api(instance, "POST", "/memories", { body: { agent: "legacy", content: assigned + " sampleanchor" } });
  expect(JSON.stringify(legacy.body)).toContain(secretFront);
  expect((await read(instance, saved.source.id)).messages[0]?.content).toBe(content);
  const before = await read(instance, saved.source.id, "project=rain-lab&maxChars=950");
  expect(before.next).not.toBeNull();

  expect((await setMask(instance, true)).body).toEqual({ maskSecrets: true, version: 3 });
  const stale = before.next!;
  expect(await api(instance, "GET", `/memory-sources/${saved.source.id}?project=rain-lab&messageIndex=${stale.messageIndex}&offset=${stale.offset}&policyVersion=${stale.policyVersion}`))
    .toMatchObject({ status: 409, body: { error: "policy-changed" } });
  const full = (await read(instance, saved.source.id)).messages[0]!.content;
  expect(full).toContain("[REDACTED:assignment]");
  expect(full).not.toContain(secretFront.slice(0, 30));
  expect(full).not.toContain(secretTail.slice(-30));
  const slices = await read(instance, saved.source.id, "project=rain-lab&maxChars=940");
  const maskedNext = slices.next!;
  const following = await read(instance, saved.source.id,
    `project=rain-lab&messageIndex=${maskedNext.messageIndex}&offset=${maskedNext.offset}&policyVersion=3`);
  expect(slices.messages[0]!.content + following.messages[0]!.content).toBe(full);

  const pin = await api(instance, "POST", `/memories/${saved.memoryIds[1]}/pin`);
  const patch = await api(instance, "PATCH", `/memories/${saved.memoryIds[1]}`, { body: { project: "rain-lab" } });
  const list = await api(instance, "GET", "/memories");
  const recall = await api(instance, "POST", "/memories/search", { body: { project: "rain-lab", query: "sampleanchor" } });
  const search = await api(instance, "POST", "/search", { body: { mode: "keyword", query: "sampleanchor" } });
  for (const response of [pin, patch, list, recall, search]) {
    expect(response.status).toBe(200);
    expect(response.headers.get("x-mnemoshelf-policy-version")).toBe("3");
    expect(JSON.stringify(response.body)).not.toMatch(/fixture-(prefix|fragment)/);
    expect(JSON.stringify(response.body)).toContain("[REDACTED:assignment]");
  }
  expect(await backup(instance)).not.toMatch(/fixture-(prefix|fragment)/);
  expect((await instance.store.getMemorySource(saved.source.id))?.messages[0]?.content).toBe(content);

  const protectedWrite = await write(instance, { ...payload, sourceTurn: "masked-write" });
  expect(protectedWrite).toMatchObject({ redacted: true, redactedCount: 1 });
  await setMask(instance, false);
  expect((await read(instance, protectedWrite.source.id)).messages[0]?.content).toBe(full);
  expect((await read(instance, saved.source.id)).messages[0]?.content).toBe(content);
  const retry = await write(instance, payload, 200);
  expect(retry).toMatchObject({ source: { id: saved.source.id }, duplicate: true, redacted: false, redactedCount: 0 });
});

it("輸出前重讀在搜尋期間切換的政策，設定失敗不變更已保存的版本", async () => {
  const instance = await start();
  await setMask(instance, false);
  const synthetic = "fixture-value-" + "x".repeat(30);
  const payload = event({ messages: [message("message-a", ['pendingquery', 'password = "', synthetic, '"'].join(" "))] });
  await write(instance, payload);
  const entered = signal();
  const release = signal();
  const actual = instance.store.searchKeyword.bind(instance.store);
  vi.spyOn(instance.store, "searchKeyword").mockImplementationOnce(async (...args) => {
    const hits = await actual(...args);
    entered.resolve();
    await release.promise;
    return hits;
  });

  const pending = api(instance, "POST", "/search", { body: { mode: "keyword", query: "pendingquery" } });
  try {
    await entered.promise;
    expect((await setMask(instance, true)).body).toEqual({ maskSecrets: true, version: 3 });
  } finally {
    release.resolve();
  }
  const search = await pending;
  expect(search.status).toBe(200);
  expect(search.body).toMatchObject({ policyVersion: 3, hits: [{ sourceType: "raw-turn" }] });
  expect(JSON.stringify(search.body)).not.toContain(synthetic);
  vi.spyOn(instance.store, "setMemoryPolicy").mockRejectedValueOnce(new Error("模擬設定寫入失敗"));
  expect((await setMask(instance, false)).status).toBe(500);
  expect((await api(instance, "GET", "/memory-policy")).body).toEqual({ maskSecrets: true, version: 3 });
});

it("找到長原文中段與尾段，回傳命中節錄、原座標，並限制同來源占用名額", async () => {
  const instance = await start();
  vi.spyOn(instance.store, "memoryEmbeddingStats").mockResolvedValue({
    total: 0, ready: 0, pending: 0, failed: 0, tooLong: 0, stale: 0,
  });
  const padding = "placeholder ".repeat(400);
  const content = `${padding}audiostar 音量設定 83。${padding}meteorlog 結果為待確認。`;
  const saved = await write(instance, event({ messages: [message("answer", content, "assistant")] }));
  await write(instance, event({ sourceTurn: "repeated", messages: [message("message-b", "audiostar ".repeat(250))] }));
  await write(instance, event({ sourceTurn: "another", project: "other", messages: [message("message-c", "meteorlog")] }));
  for (const query of ["audiostar", "meteorlog"]) {
    const response = await api(instance, "POST", "/memories/search", { body: { query, project: "rain-lab", k: 5 } });
    expect(response.status).toBe(200);
    const { hits } = response.body as { hits: Array<Record<string, unknown> & { content: string }> };
    const raw = hits.find(({ sourceId }) => sourceId === saved.source.id);
    expect(raw).toMatchObject({ sourceType: "raw-turn", role: "assistant", hasMore: true, truncated: true, project: "rain-lab" });
    expect(raw?.content).toContain(query);
    expect(raw?.content.length).toBeLessThanOrEqual(420);
    expect(raw?.content).toBe(content.slice(raw?.snippetStart as number, raw?.snippetEnd as number));
    expect(hits.every(({ project }) => project === "rain-lab")).toBe(true);
    const counts = new Map<number, number>();
    for (const { sourceId } of hits) counts.set(sourceId as number, (counts.get(sourceId as number) ?? 0) + 1);
    expect(Math.max(...counts.values())).toBeLessThanOrEqual(2);
  }
});

it.each([
  {
    query: "校正記錄完成後，請問最後存檔的桁架識別標記以及圖示為何？",
    filler: "校正記錄已留給值班人員，保留紙本以供後續核對。".repeat(25),
    answer: "最後確認，桁架識別標記是 FRAME-X17 🧭。",
    evidence: "FRAME-X17 🧭",
    anchor: "桁架識別標記",
  },
  {
    query: "instrumentation north latch clearance",
    filler: "Instrumentation readings were collected today. ".repeat(13),
    answer: "For the north bay, check the latch on the sample. The clearance is 1.8 mm.",
    evidence: "1.8 mm",
    anchor: "clearance",
  },
])("在長片段中優先定位緊鄰的查詢詞組而非較早的重複詞", async ({ query, filler, answer, evidence, anchor }) => {
  const instance = await start();
  vi.spyOn(instance.store, "memoryEmbeddingStats").mockResolvedValue({
    total: 0, ready: 0, pending: 0, failed: 0, tooLong: 0, stale: 0,
  });
  const content = filler + answer;
  const saved = await write(instance, event({ messages: [message("answer", content, "assistant")] }));
  expect(saved.memoryIds).toHaveLength(1);
  const response = await api(instance, "POST", "/memories/search", {
    body: { query, project: "rain-lab" },
  });
  expect(response.status).toBe(200);
  const { hits: [hit] } = response.body as { hits: Array<{
    content: string; snippetStart: number; snippetEnd: number; snippetAnchor: number;
  }> };
  expect(hit?.content).toContain(evidence);
  expect(hit?.content.length).toBeLessThan(200);
  expect(hit?.content).toBe(content.slice(hit!.snippetStart, hit!.snippetEnd));
  expect(hit?.snippetAnchor).toBeLessThanOrEqual(97);
  expect(hit?.content.slice(hit.snippetAnchor)).toMatch(new RegExp(`^${anchor}`, "u"));
});

it("節錄錨點對應遮罩後的內容，保存座標與完整遮罩字樣維持一致", async () => {
  const instance = await start();
  vi.spyOn(instance.store, "memoryEmbeddingStats").mockResolvedValue({
    total: 0, ready: 0, pending: 0, failed: 0, tooLong: 0, stale: 0,
  });
  await setMask(instance, false);
  const value = "fixture-synthetic-value-".repeat(9);
  const assignment = ['password = "', value, '"'].join("");
  const query = "calibration latch";
  const content = "background ".repeat(44) + assignment + " " + query + " remains fixed 🧭.";
  const saved = await write(instance, event({ messages: [message("answer", content, "assistant")] }));
  await setMask(instance, true);
  const response = await api(instance, "POST", "/memories/search", { body: { query, project: "rain-lab" } });
  expect(response.status).toBe(200);
  const { hits: [hit] } = response.body as { hits: Array<{
    content: string; sourceId: number; snippetStart: number; snippetEnd: number; snippetAnchor: number;
  }> };
  expect(hit?.sourceId).toBe(saved.source.id);
  expect(hit?.content).toContain("[REDACTED:assignment]");
  expect(hit?.content).not.toContain("fixture-synthetic-value");
  expect(hit?.content.slice(hit.snippetAnchor)).toBe("calibration latch remains fixed 🧭.");
  expect(hit?.snippetAnchor).not.toBe(content.indexOf(query) - hit!.snippetStart);
  expect(hit!.snippetEnd - hit!.snippetStart).toBeLessThanOrEqual(420);
});

it.each(["semantic", "keyword"] as const)(
  "同一路徑的原文互補以較強來源的另一則訊息補位，保留其他結果的順序（%s）",
  async (lane) => {
    const instance = await start();
    const best = await write(instance, event({ messages: [
      message("question", "裝配檢查的觀察"),
      message("answer", "實際肇因是墊片的厚度", "assistant"),
    ] }));
    const repeated = await write(instance, event({ sourceTurn: "secondary", messages: [
      message("question", "另一輪的裝配問題"),
      message("answer", "另一輪的裝配說明", "assistant"),
    ] }));
    const independent = await write(instance, event({ sourceTurn: "independent" }));
    const invisible = await write(instance, event({ sourceTurn: "hidden", project: "other-project" }));
    const ids = [best.memoryIds[0]!, repeated.memoryIds[0]!, repeated.memoryIds[1]!, independent.memoryIds[0]!,
      invisible.memoryIds[0]!, best.memoryIds[1]!];
    const scores = [0.95, 0.9, 0.85, 0.8, 0.75, 0.7];
    vi.spyOn(instance.store, "memoryEmbeddingStats").mockResolvedValue({
      total: ids.length, ready: lane === "semantic" ? ids.length : 0, pending: 0, failed: 0, tooLong: 0, stale: 0,
    });
    const keyword = vi.spyOn(instance.store, "searchMemoriesKeyword").mockResolvedValue(
      ids.map((id, index) => ({ id, rank: index + 1 })),
    );
    vi.spyOn(instance.store, "searchMemoriesByVector").mockResolvedValue(
      ids.map((id, index) => ({ id, score: scores[index]! })),
    );

    const response = await api(instance, "POST", "/memories/search", {
      body: { query: "裝配記錄", project: "rain-lab", k: 4, minScore: 0.65 },
    });
    expect(response.status).toBe(200);
    const { hits } = response.body as { hits: Array<{ id: number; rank: number; score: number; source: string }> };
    expect(hits.map(({ id }) => id)).toEqual([ids[0], ids[1], ids[3], ids[5]]);
    expect(hits.map(({ rank }) => rank)).toEqual([1, 2, 3, 4]);
    expect(hits.every(({ source }) => source === lane)).toBe(true);
    expect(hits.at(-1)?.score).toBe(lane === "semantic" ? scores[5] : 1 / 6);
    if (lane === "semantic") expect(keyword).not.toHaveBeenCalled();
  },
);

it("關鍵字補位不借用語意順位來源來取代其他關鍵字候選", async () => {
  const instance = await start();
  const semantic = await write(instance, event({ messages: [
    message("question", "第一來源提問"),
    message("answer", "第一來源答覆", "assistant"),
  ] }));
  const keyword = await write(instance, event({ sourceTurn: "keyword", messages: [
    message("question", "第二來源提問"),
    message("answer", "第二來源答覆", "assistant"),
  ] }));
  vi.spyOn(instance.store, "memoryEmbeddingStats").mockResolvedValue({
    total: 4, ready: 1, pending: 3, failed: 0, tooLong: 0, stale: 0,
  });
  vi.spyOn(instance.store, "searchMemoriesByVector").mockResolvedValue([{ id: semantic.memoryIds[0]!, score: 0.9 }]);
  vi.spyOn(instance.store, "searchMemoriesKeyword").mockResolvedValue([
    ...keyword.memoryIds.map((id, index) => ({ id, rank: index + 1 })),
    { id: semantic.memoryIds[1]!, rank: 3 },
  ]);

  const response = await api(instance, "POST", "/memories/search", {
    body: { query: "來源提問", project: "rain-lab", k: 3 },
  });
  expect(response.status).toBe(200);
  const { hits } = response.body as { hits: Array<{ id: number; source: string }> };
  expect(hits.map(({ id }) => id)).toEqual([semantic.memoryIds[0], ...keyword.memoryIds]);
  expect(hits.map(({ source }) => source)).toEqual(["semantic", "keyword", "keyword"]);
});

it("透過舊片段生命週期操作整來源，政策有效的游標仍要重新檢查範圍", async () => {
  const instance = await start();
  const payload = event({ messages: [message("a", "padded text ".repeat(800))] });
  const saved = await write(instance, payload);
  const { id } = saved.source;
  const initial = await read(instance, id);
  expect(initial.next).not.toBeNull();
  expect(await api(instance, "POST", "/memories", { body: {
    agent: "raw-test", content: "fake chunk", sourceId: id,
  } })).toMatchObject({ status: 400 });
  expect(await api(instance, "POST", "/memories", { body: {
    agent: "raw-test", content: "replacement", supersedes: saved.memoryIds[0],
  } })).toMatchObject({ status: 409, body: { error: { code: "source-conflict" } } });
  expect(await api(instance, "POST", `/memories/${saved.memoryIds[0]}/pin`)).toMatchObject({ status: 200 });
  expect((await instance.store.listMemorySourceChunks(id)).every(({ pinned }) => pinned)).toBe(true);

  expect(await api(instance, "PATCH", `/memories/${saved.memoryIds[0]}`, { body: { project: "new-project" } }))
    .toMatchObject({ status: 200, body: { project: "new-project" } });
  const cursor = initial.next!;
  expect(await api(instance, "GET", `/memory-sources/${id}?project=rain-lab&messageIndex=${cursor.messageIndex}&offset=${cursor.offset}&policyVersion=${cursor.policyVersion}`))
    .toMatchObject({ status: 404 });
  expect((await read(instance, id, "project=new-project")).messages[0]?.content).not.toBe("");
  const retry = await write(instance, payload, 200);
  expect(retry.source.project).toBe("new-project");
  expect(await api(instance, "PATCH", `/memory-sources/${id}`, { body: { scope: "global" } }))
    .toMatchObject({ status: 200, body: { source: { scope: "global", project: null }, policyVersion: 1 } });

  expect(await api(instance, "DELETE", `/memories/${saved.memoryIds[1]}`)).toMatchObject({ status: 200 });
  expect(await api(instance, "GET", `/memory-sources/${id}?scope=global`)).toMatchObject({ status: 404 });
  expect(await api(instance, "POST", "/memory-sources", { body: payload })).toMatchObject({ status: 409 });
  expect(await api(instance, "DELETE", `/memory-sources/${id}?hard=true`)).toMatchObject({
    status: 200, body: { deleted: true, hard: true },
  });
  expect(await api(instance, "POST", "/memory-sources", { body: payload })).toMatchObject({ status: 409 });
  expect(await backup(instance)).toBe("");
});

it("拒絕 8 MiB 超限、非法 Unicode 或未允許的角色，且不留下來源", async () => {
  const instance = await start();
  const large = event({ messages: [message("message-a", "x".repeat(MAX_MEMORY_SOURCE_BYTES))] });
  expect((await api(instance, "POST", "/memory-sources", { body: large })).status).toBe(413);
  for (const content of ["\u0000", "\ud800", "\udc00", " \t\n"]) {
    expect((await api(instance, "POST", "/memory-sources", { body: event({ messages: [message("a", content)] }) })).status).toBe(400);
  }
  const invalidRole = { ...event(), messages: [{ ...message("a", "內容"), role: "tool" }] };
  expect((await api(instance, "POST", "/memory-sources", { body: invalidRole })).status).toBe(400);
  expect(await instance.store.listMemorySourcesForExport()).toEqual([]);
  expect(await instance.store.listMemoriesForExport()).toEqual([]);
});

it("v2 備份保存來源關係，重複匯入去重且預檢衝突時全批未寫入", async () => {
  const original = await start();
  const target = await start();
  const payload = event({ messages: [
    message("question", "合成提問"),
    message("answer", "  原文答覆\r\n🧪", "assistant", "2026-02-02T03:04:05Z"),
  ] });
  const saved = await write(original, payload);
  expect((await api(original, "POST", "/memories", { body: { agent: "legacy", content: "舊記憶" } })).status).toBe(201);
  expect((await api(original, "GET", "/memories/export?schemaVersion=1")).status).toBe(409);
  const file = await backup(original);
  const rows = file.trim().split("\n").map((line) => JSON.parse(line));
  expect(rows).toHaveLength(2);
  expect(rows[0]).toMatchObject({ schemaVersion: 2, type: "memory", memory: { content: "舊記憶" } });
  expect(rows[1]).toMatchObject({ schemaVersion: 2, type: "source", source: payload });
  expect(file).not.toContain("requestHash");
  expect(file).not.toContain("memoryIds");

  expect(await restore(target, file, true)).toMatchObject({ status: 200, body: { created: 0, wouldCreate: 2 } });
  expect(await target.store.listMemorySourcesForExport()).toEqual([]);
  expect(await restore(target, file)).toMatchObject({ status: 200, body: { created: 2, duplicates: 0 } });
  expect(await restore(target, file)).toMatchObject({ status: 200, body: { created: 0, duplicates: 2 } });
  const [restored] = await target.store.listMemorySourcesForExport();
  expect(restored?.messages).toEqual(payload.messages);
  expect((await target.store.listMemorySourceChunks(restored!.id))).toHaveLength(saved.memoryIds.length);

  const changed = { ...rows[1], source: { ...payload, messages: [message("question", "衝突版本")] } };
  const newLegacy = { ...rows[0], memory: { ...rows[0].memory, content: "不應新增" } };
  const newSource = { ...rows[1], source: { ...payload, sourceTurn: "new-source" } };
  const conflict = [newLegacy, newSource, changed].map((row) => JSON.stringify(row)).join("\n");
  for (const dryRun of [true, false]) {
    expect(await restore(target, conflict, dryRun)).toMatchObject({
      status: 409, body: { error: { code: "source-conflict" } },
    });
  }
  expect(await target.store.listMemorySourcesForExport()).toHaveLength(1);
  expect(await backup(target)).not.toContain("不應新增");
});

it.each([true, false])("v2 備份還原到空庫後保留原文整回合的釘選狀態（pinned=%s）", async (pinned) => {
  const original = await start();
  const target = await start();
  const saved = await write(original, event({ messages: [
    message("question", "需要保留的合成提問"),
    message("answer", "完整合成答覆".repeat(240), "assistant"),
  ] }));
  expect(saved.memoryIds.length).toBeGreaterThan(2);
  const memoryId = saved.memoryIds[1]!;
  expect((await api(original, "POST", `/memories/${memoryId}/pin`)).status).toBe(200);
  if (!pinned) expect((await api(original, "POST", `/memories/${memoryId}/pin`, { body: { pinned: false } })).status).toBe(200);
  expect((await original.store.listMemorySourceChunks(saved.source.id)).every((memory) => memory.pinned === pinned)).toBe(true);

  const file = await backup(original);
  expect(JSON.parse(file)).toMatchObject({ schemaVersion: 2, type: "source", pinned });
  expect(await restore(target, file, true)).toMatchObject({ status: 200, body: { created: 0, wouldCreate: 1 } });
  expect(await target.store.listMemoriesForExport()).toEqual([]);
  expect(await target.store.listMemorySourcesForExport()).toEqual([]);
  expect(await restore(target, file)).toMatchObject({ status: 200, body: { created: 1, duplicates: 0 } });
  const [source] = await target.store.listMemorySourcesForExport();
  const chunks = await target.store.listMemorySourceChunks(source!.id);
  expect(chunks).toHaveLength(saved.memoryIds.length);
  expect(chunks.map((memory) => memory.pinned)).toEqual(saved.memoryIds.map(() => pinned));

  // 同事件重送不應將使用者後來的釘選選擇還原成備份時的值。
  expect((await api(target, "POST", `/memories/${chunks[0]!.id}/pin`, { body: { pinned: !pinned } })).status).toBe(200);
  for (const dryRun of [true, false]) {
    expect(await restore(target, file, dryRun)).toMatchObject({ status: 200, body: { created: 0, duplicates: 1 } });
    expect((await target.store.listMemorySourceChunks(source!.id)).map((memory) => memory.pinned))
      .toEqual(saved.memoryIds.map(() => !pinned));
  }
  expect(JSON.parse(await backup(target))).toMatchObject({ pinned: !pinned });
});

it("舊 v2 來源備份未帶 pinned 時仍可預檢及還原，預設整回合未釘選", async () => {
  const target = await start();
  const payload = event({ messages: [message("question", "合成提問"), message("answer", "合成答覆", "assistant")] });
  const file = JSON.stringify({ schemaVersion: 2, type: "source", source: payload, createdAt: "2026-01-01T00:00:00Z" });
  expect(await restore(target, file, true)).toMatchObject({ status: 200, body: { created: 0, wouldCreate: 1 } });
  expect(await target.store.listMemorySourcesForExport()).toEqual([]);
  expect(await restore(target, file)).toMatchObject({ status: 200, body: { created: 1 } });
  const [source] = await target.store.listMemorySourcesForExport();
  expect(source?.messages).toEqual(payload.messages);
  expect((await target.store.listMemorySourceChunks(source!.id)).map((memory) => memory.pinned)).toEqual([false, false]);
});

it.each([null, 1, "true", [], {}].map((pinned) => ({ pinned })))(
  "v2 原文 pinned 非布林值時預檢與匯入都拒絕整批（$pinned）",
  async ({ pinned }) => {
    const target = await start();
    const row = { schemaVersion: 2, type: "source", source: event(), createdAt: "2026-01-01T00:00:00Z", pinned: true };
    const file = [
      row,
      { schemaVersion: 2, type: "memory", memory: { content: "不應寫入的短記憶", agent: "legacy" } },
      { ...row, source: event({ sourceTurn: "another" }), pinned },
    ].map((value) => JSON.stringify(value)).join("\n");
    for (const dryRun of [true, false]) {
      expect(await restore(target, file, dryRun)).toMatchObject({
        status: 400, body: { created: 0, wouldCreate: 0, invalid: [{ line: 3, reason: "pinned 必須是布林值" }] },
      });
      expect(await target.store.listMemoriesForExport()).toEqual([]);
      expect(await target.store.listMemorySourcesForExport()).toEqual([]);
    }
  },
);

it("匯入預檢與其他來源寫入共用佇列，衝突事件不會搶在批次內寫入", async () => {
  const instance = await start();
  const payload = event();
  const file = JSON.stringify({
    schemaVersion: 2, type: "source", source: payload, createdAt: "2026-01-01T00:00:00Z",
  });
  const preflight = signal();
  const release = signal();
  const received = signal();
  const check = instance.store.checkMemorySource.bind(instance.store);
  vi.spyOn(instance.store, "checkMemorySource").mockImplementationOnce(async (input) => {
    const state = await check(input);
    preflight.resolve();
    await release.promise;
    return state;
  });
  const add = vi.spyOn(instance.store, "addMemorySource");
  instance.server.on("request", (request) => {
    if (request.url === "/memory-sources") request.once("end", received.resolve);
  });
  const importing = restore(instance, file);
  let competing;
  try {
    await preflight.promise;
    competing = api(instance, "POST", "/memory-sources", {
      body: { ...payload, messages: [message("message-a", "另一份衝突資料")] },
    });
    await received.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(add).not.toHaveBeenCalled();
  } finally {
    release.resolve();
  }
  expect(await importing).toMatchObject({ status: 200, body: { created: 1, duplicates: 0 } });
  expect(await competing).toMatchObject({ status: 409, body: { error: { code: "source-conflict" } } });
  const [saved] = await instance.store.listMemorySourcesForExport();
  expect(saved?.messages).toEqual(payload.messages);
});

it("軟刪來源後，在途嵌入完成也無法復活片段或新增檔案向量", async () => {
  const instance = await start();
  const entered = signal();
  const release = signal();
  const embed = instance.embedder.embedDocument.bind(instance.embedder);
  vi.spyOn(instance.embedder, "embedDocument").mockImplementationOnce(async (text) => {
    entered.resolve();
    await release.promise;
    return embed(text);
  });
  const saved = await write(instance, event());
  const { id } = saved.source;
  try {
    await entered.promise;
    expect(await api(instance, "DELETE", `/memory-sources/${id}`)).toMatchObject({ status: 200 });
  } finally {
    release.resolve();
  }
  await vi.waitFor(() => expect(instance.memoryEmbedder.stats().processing).toBe(0));
  expect(await instance.store.listMemorySourceChunks(id)).toEqual([]);
  expect(await instance.store.memorySourceEmbeddingStats(id, instance.embedder.info.id)).toMatchObject({
    total: 0, ready: 0,
  });
  expect(await instance.vec.count()).toBe(0);
});

it("政策設定重啟後仍保留，拒絕額外欄位", async () => {
  const server = await startTestServer();
  servers.push(server);
  expect((await api(server.instance, "PATCH", "/memory-policy", {
    body: { maskSecrets: false, unexpected: true },
  })).status).toBe(400);
  expect((await setMask(server.instance, false)).body).toEqual({ maskSecrets: false, version: 2 });
  await server.instance.close();
  const restarted = await createServer({
    env: {}, token: TEST_TOKEN, dataDir: server.dataDir, port: 0, embedder: new FakeEmbedder(),
  });
  try {
    expect((await api(restarted, "GET", "/memory-policy")).body).toEqual({ maskSecrets: false, version: 2 });
  } finally {
    await restarted.close();
  }
});

const recallSearch = (instance: MnemoshelfServer) => api(instance, "POST", "/memories/search", {
  body: { query: "visibilityanchor", project: "rain-lab" },
});
const unifiedKeywordSearch = (instance: MnemoshelfServer) => api(instance, "POST", "/search", {
  body: { query: "visibilityanchor", mode: "keyword" },
});
const scopedList = (instance: MnemoshelfServer) => api(instance, "GET", "/memories?scope=project&project=rain-lab");

it.each([
  { read: recallSearch, key: "hits", mutate: "move" },
  { read: unifiedKeywordSearch, key: "hits", mutate: "delete" },
  { read: scopedList, key: "memories", mutate: "move" },
] as const)("最終來源讀取與 $mutate 在同一佇列，變更後的 $key 不再回傳來源", async ({ read, key, mutate }) => {
  const instance = await start();
  const saved = await write(instance, event({ messages: [message("message-a", "visibilityanchor 合成資料")] }));
  vi.spyOn(instance.store, "memoryEmbeddingStats").mockResolvedValue({
    total: 0, ready: 0, pending: 0, failed: 0, tooLong: 0, stale: 0,
  });
  const sourceLoaded = signal();
  const releaseRead = signal();
  const mutationReceived = signal();
  const getSource = instance.store.getMemorySource.bind(instance.store);
  vi.spyOn(instance.store, "getMemorySource").mockImplementationOnce(async (id) => {
    const snapshot = await getSource(id);
    sourceLoaded.resolve();
    await releaseRead.promise;
    return snapshot;
  });
  const id = saved.source.id;
  const path = `/memory-sources/${id}`;
  const operation = mutate === "delete"
    ? vi.spyOn(instance.store, "deleteMemorySource")
    : vi.spyOn(instance.store, "updateMemorySource");
  instance.server.on("request", (request) => {
    if (request.url === path && request.method === "PATCH") request.once("end", mutationReceived.resolve);
    if (request.url === `${path}?hard=true` && request.method === "DELETE") mutationReceived.resolve();
  });

  const pendingRead = read(instance);
  let pendingWrite;
  try {
    await sourceLoaded.promise;
    pendingWrite = mutate === "delete"
      ? api(instance, "DELETE", `${path}?hard=true`)
      : api(instance, "PATCH", path, { body: { project: "another-project" } });
    await mutationReceived.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(operation).not.toHaveBeenCalled();
  } finally {
    releaseRead.resolve();
  }

  expect(await pendingRead).toMatchObject({
    status: 200, body: { [key]: [{ sourceId: id, project: "rain-lab" }] },
  });
  expect(await pendingWrite).toMatchObject({ status: 200 });
  expect(await read(instance)).toMatchObject({ status: 200, body: { [key]: [] } });
});

it.each([recallSearch, unifiedKeywordSearch])("排名取到舊版記憶後先完成硬刪除，搜尋回應不帶舊內容", async (read) => {
  const instance = await start();
  const saved = await api(instance, "POST", "/memories", {
    body: { agent: "legacy-fixture", content: "visibilityanchor 舊版資料" },
  });
  expect(saved.status).toBe(201);
  vi.spyOn(instance.store, "memoryEmbeddingStats").mockResolvedValue({
    total: 0, ready: 0, pending: 0, failed: 0, tooLong: 0, stale: 0,
  });
  const { id } = saved.body as { id: number };
  const snapshotLoaded = signal();
  const releaseRanking = signal();
  const getMemory = instance.store.getMemory.bind(instance.store);
  vi.spyOn(instance.store, "getMemory").mockImplementationOnce(async (memoryId) => {
    const snapshot = await getMemory(memoryId);
    snapshotLoaded.resolve();
    await releaseRanking.promise;
    return snapshot;
  });
  const pending = read(instance);
  try {
    await snapshotLoaded.promise;
    expect(await api(instance, "DELETE", `/memories/${id}?hard=true`)).toMatchObject({ status: 200 });
  } finally {
    releaseRanking.resolve();
  }
  expect(await pending).toMatchObject({ status: 200, body: { hits: [] } });
});
