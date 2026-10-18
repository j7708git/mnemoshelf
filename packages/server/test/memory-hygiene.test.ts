/**
 * 卡 C2：記憶衛生的 REST 測試（精確去重／legacy scope 清理／硬刪除）。
 *
 * 全部使用合成資料與暫存資料目錄；不讀取任何使用者檔案。重點：
 * - `POST /memories` 的重複判定回 `200`＋`duplicate: true`（不新增、不排入嵌入），`force` 可強制新增；
 * - `supersedes`（編輯流程）跳過去重；
 * - `DELETE /memories/:id?hard=true` 真的刪除列與 FTS，值域嚴格（只接受 `true`／`1`）；
 * - 啟動時的 legacy 正規化只記筆數、不記錄內容，且重啟後不再更新。
 */
import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeEmbedder } from "@mnemoshelf/core/testing";
import { createServer, type AddMemoryResponse, type ListMemoriesResponse, type MnemoshelfServer } from "../src/index.js";
import { api, makeTempDir, removeTempDir, startTestServer, TEST_TOKEN, type TestServer } from "./helpers.js";

/** 以片段拼接組出「看起來像憑證」的合成樣本（原始碼不出現連續的憑證字面值）。 */
function fake(...parts: string[]): string {
  return parts.join("");
}

/** 取出 REST 錯誤的具名錯誤（`{error:{name,message}}`）。 */
function errorName(body: unknown): unknown {
  return (body as { error?: { name?: unknown } } | null)?.error?.name;
}

/** 依序建立記憶，回傳解析後的回應。 */
async function postMemory(
  instance: MnemoshelfServer,
  body: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> {
  return await api(instance, "POST", "/memories", { body });
}

let server: TestServer | undefined;
let custom: MnemoshelfServer | undefined;
const dirs: string[] = [];

afterEach(async () => {
  await custom?.close();
  custom = undefined;
  await server?.close();
  server = undefined;
  while (dirs.length > 0) await removeTempDir(dirs.pop()!);
});

describe("REST：POST /memories 精確去重", () => {
  it("同內容只差空白／換行 → 200 duplicate: true、回既有 id、不新增；force 可新增第二筆", async () => {
    server = await startTestServer();
    const instance = server.instance;
    const content = "去重 REST 測試\n第二行";

    const first = await postMemory(instance, { content, agent: "agent-hygiene", scope: "global" });
    expect(first.status).toBe(201);
    const created = first.body as AddMemoryResponse;
    expect(created.duplicate).toBe(false);
    expect(created.redacted).toBe(false);

    const second = await postMemory(instance, {
      content: "  去重 REST 測試\r\n\r\n第二行\t ",
      agent: "agent-hygiene",
      scope: "global",
    });
    expect(second.status).toBe(200);
    const duplicate = second.body as AddMemoryResponse;
    expect(duplicate.duplicate).toBe(true);
    expect(duplicate.id).toBe(created.id);
    expect(duplicate.content).toBe(content);
    // 重複時沒有寫入任何內容，redacted 一律 false／0（不是「既有記憶被遮罩」的意思）。
    expect(duplicate.redacted).toBe(false);
    expect(duplicate.redactedCount).toBe(0);

    const listed = (await api(instance, "GET", "/memories")).body as ListMemoriesResponse;
    expect(listed.memories).toHaveLength(1);
    // 沒有因為重複而多排一次背景嵌入。
    expect((await api(instance, "GET", "/diagnostics")).body).toMatchObject({ memories: { total: 1 } });

    // force=true 走一般新增：即使已有相同內容也建立第二筆。
    const forced = await postMemory(instance, { content, agent: "agent-hygiene", scope: "global", force: true });
    expect(forced.status).toBe(201);
    const forcedBody = forced.body as AddMemoryResponse;
    expect(forcedBody.duplicate).toBe(false);
    expect(forcedBody.id).not.toBe(created.id);

    const afterForce = (await api(instance, "GET", "/memories")).body as ListMemoriesResponse;
    expect(afterForce.memories.map((memory) => memory.id).sort()).toEqual([created.id, forcedBody.id].sort());

    // force 非 boolean → 400，且不寫入。
    for (const force of ["true", 1, null]) {
      const bad = await postMemory(instance, { content: `${content} force 型別`, agent: "agent-hygiene", force });
      expect(bad.status, String(force)).toBe(400);
      expect(errorName(bad.body)).toBe("ValidationError");
    }
    expect(((await api(instance, "GET", "/memories")).body as ListMemoriesResponse).memories).toHaveLength(2);
  });

  it("不同 scope／project／agent 不誤判為重複", async () => {
    server = await startTestServer();
    const instance = server.instance;
    const content = "同一段內容，不同範圍";

    const bodies = [
      { content, agent: "agent-hygiene", scope: "global" },
      { content, agent: "agent-hygiene", scope: "project", project: "proj-hygiene-a" },
      { content, agent: "agent-hygiene", scope: "project", project: "proj-hygiene-b" },
      { content, agent: "agent-hygiene-2", scope: "global" },
      { content, agent: "agent-hygiene", scope: "agent" },
    ];
    const ids: number[] = [];
    for (const body of bodies) {
      const response = await postMemory(instance, body);
      expect(response.status, JSON.stringify(body)).toBe(201);
      expect((response.body as AddMemoryResponse).duplicate).toBe(false);
      ids.push((response.body as AddMemoryResponse).id);
    }
    expect(new Set(ids).size).toBe(ids.length);
    expect(((await api(instance, "GET", "/memories")).body as ListMemoriesResponse).memories).toHaveLength(
      bodies.length,
    );
  });

  it("去重比較的是遮罩後內容：憑證不同但遮罩後同文 → duplicate", async () => {
    server = await startTestServer();
    const instance = server.instance;
    const contentA = `部署金鑰 ${fake("gh", "p_", "0123456789abcdefghijklmn")}`;
    const contentB = `部署金鑰 ${fake("gh", "p_", "abcdefghijklmn9876543210")}`;

    const first = await postMemory(instance, { content: contentA, agent: "agent-hygiene-mask" });
    expect(first.status).toBe(201);
    const firstBody = first.body as AddMemoryResponse;
    expect(firstBody.redacted).toBe(true);
    expect(firstBody.redactedCount).toBe(1);
    expect(firstBody.content).not.toContain("0123456789abcdefghijklmn");

    const second = await postMemory(instance, { content: contentB, agent: "agent-hygiene-mask" });
    expect(second.status).toBe(200);
    const secondBody = second.body as AddMemoryResponse;
    expect(secondBody.duplicate).toBe(true);
    expect(secondBody.id).toBe(firstBody.id);
    // 回的是既有的遮罩後內容（不含任何一組原始憑證）。
    expect(secondBody.content).not.toContain("abcdefghijklmn9876543210");
    expect(((await api(instance, "GET", "/memories")).body as ListMemoriesResponse).memories).toHaveLength(1);
  });

  it("帶 supersedes 時跳過去重（編輯流程優先），仍回 201＋新版本", async () => {
    server = await startTestServer();
    const instance = server.instance;
    const content = "編輯流程要跳過去重";

    const existing = (await postMemory(instance, { content, agent: "agent-hygiene-edit" })).body as AddMemoryResponse;
    expect(existing.duplicate).toBe(false);
    const toReplace = (
      await postMemory(instance, { content: "要被取代的舊版本", agent: "agent-hygiene-edit" })
    ).body as AddMemoryResponse;

    // 內容與 existing 完全相同，但帶 supersedes → 不去重，建立新版本並軟刪除被取代者。
    const replacement = await postMemory(instance, {
      content,
      agent: "agent-hygiene-edit",
      supersedes: toReplace.id,
    });
    expect(replacement.status).toBe(201);
    const replacementBody = replacement.body as AddMemoryResponse;
    expect(replacementBody.duplicate).toBe(false);
    expect(replacementBody.id).not.toBe(existing.id);
    expect(replacementBody.supersedes).toBe(toReplace.id);

    const listed = (await api(instance, "GET", "/memories")).body as ListMemoriesResponse;
    expect(listed.memories.map((memory) => memory.id).sort()).toEqual([existing.id, replacementBody.id].sort());
    expect(listed.memories.map((memory) => memory.id)).not.toContain(toReplace.id);
  });
});

describe("REST：DELETE /memories/:id?hard=true（硬刪除）", () => {
  it("hard=true 真的刪除列與 FTS；未知 id／重複刪除都 404", async () => {
    server = await startTestServer();
    const instance = server.instance;
    const content = "硬刪除 REST 測試的鰻魚飯";

    const created = (await postMemory(instance, { content, agent: "agent-hygiene-hard" })).body as AddMemoryResponse;
    // 未刪除時關鍵字搜尋（含記憶）找得到。
    const found = await api(instance, "POST", "/search", { body: { query: "鰻魚飯", mode: "keyword" } });
    expect((found.body as { hits: { type: string }[] }).hits.some((hit) => hit.type === "memory")).toBe(true);

    const deleted = await api(instance, "DELETE", `/memories/${created.id}?hard=true`);
    expect(deleted.status).toBe(200);
    expect(deleted.body).toEqual({ id: created.id, deleted: true, hard: true });

    // 列真的消失了（不是軟刪除），FTS 也不再命中。
    expect(await instance.store.getMemory(created.id)).toBeNull();
    expect(((await api(instance, "GET", "/memories")).body as ListMemoriesResponse).memories).toEqual([]);
    const after = await api(instance, "POST", "/search", { body: { query: "鰻魚飯", mode: "keyword" } });
    expect((after.body as { hits: { type: string }[] }).hits.filter((hit) => hit.type === "memory")).toEqual([]);

    // 同一 id 再刪、以及未知 id → 404（與軟刪除一致）。
    expect((await api(instance, "DELETE", `/memories/${created.id}?hard=true`)).status).toBe(404);
    expect((await api(instance, "DELETE", "/memories/987654?hard=true")).status).toBe(404);
  });

  it("hard=1 也可；其他值（含 false／空字串）一律 400 且不刪除", async () => {
    server = await startTestServer();
    const instance = server.instance;
    const created = (
      await postMemory(instance, { content: "hard 參數值域的測試記憶", agent: "agent-hygiene-hard-flag" })
    ).body as AddMemoryResponse;

    for (const query of ["hard=false", "hard=yes", "hard=TRUE", "hard=", "hard=0"]) {
      const response = await api(instance, "DELETE", `/memories/${created.id}?${query}`);
      expect(response.status, query).toBe(400);
      expect(errorName(response.body)).toBe("ValidationError");
      expect(await instance.store.getMemory(created.id)).not.toBeNull();
    }

    const viaOne = await api(instance, "DELETE", `/memories/${created.id}?hard=1`);
    expect(viaOne.status).toBe(200);
    expect(await instance.store.getMemory(created.id)).toBeNull();
  });

  it("未帶 hard＝既有軟刪除語意不變；已軟刪除者可再硬刪除", async () => {
    server = await startTestServer();
    const instance = server.instance;
    const created = (
      await postMemory(instance, { content: "軟刪除後再硬刪除的記憶", agent: "agent-hygiene-soft" })
    ).body as AddMemoryResponse;

    const soft = await api(instance, "DELETE", `/memories/${created.id}`);
    expect(soft.status).toBe(200);
    expect(soft.body).toEqual({ id: created.id, deleted: true });
    // 軟刪除：資料列還在，只是不再列出／搜尋。
    const stored = await instance.store.getMemory(created.id);
    expect(stored).not.toBeNull();
    expect(stored?.deletedAt).not.toBeNull();
    expect(((await api(instance, "GET", "/memories")).body as ListMemoriesResponse).memories).toEqual([]);
    // 重複軟刪除：回 deleted: false（既有行為）。
    expect((await api(instance, "DELETE", `/memories/${created.id}`)).body).toEqual({ id: created.id, deleted: false });

    const hard = await api(instance, "DELETE", `/memories/${created.id}?hard=true`);
    expect(hard.status).toBe(200);
    expect(hard.body).toEqual({ id: created.id, deleted: true, hard: true });
    expect(await instance.store.getMemory(created.id)).toBeNull();
  });
});

describe("啟動：legacy 記憶 scope 正規化", () => {
  /** 在既有資料目錄上開一個服務（與 `startTestServer` 不同，用來模擬「重啟」）。 */
  async function startOn(dataDir: string): Promise<MnemoshelfServer> {
    return await createServer({
      env: {},
      token: TEST_TOKEN,
      dataDir,
      port: 0,
      embedder: new FakeEmbedder(),
      homeDir: os.homedir(),
    });
  }

  it("啟動時冪等正規化矛盾資料、只記筆數（不記內容）；第二次啟動不再更新", async () => {
    const dataDir = await makeTempDir("mnemoshelf-legacy-scope-");
    dirs.push(dataDir);

    // 第一階段：用 store 直接寫入 REST 不會允許的矛盾組合（模擬舊版遺留資料）。
    custom = await startOn(dataDir);
    const legacy = custom.store;
    const globalWithProject = await legacy.addMemory({
      content: "legacy global 帶 project",
      kind: "fact",
      scope: "global",
      project: "legacy-proj",
      agent: "legacy-agent",
      supersedes: null,
    });
    const agentWithProject = await legacy.addMemory({
      content: "legacy agent 帶 project",
      kind: "fact",
      scope: "agent",
      project: "legacy-proj",
      agent: "legacy-agent",
      supersedes: null,
    });
    const projectWithoutProject = await legacy.addMemory({
      content: "legacy project 沒有 project",
      kind: "fact",
      scope: "project",
      project: null,
      agent: "legacy-agent",
      supersedes: null,
    });
    const legalProject = await legacy.addMemory({
      content: "合法專案記憶",
      kind: "fact",
      scope: "project",
      project: "legal-proj",
      agent: "legacy-agent",
      supersedes: null,
    });
    await custom.close();
    custom = undefined;

    // 第二階段：重啟 → 啟動時正規化；stderr 只記筆數、不得含記憶內容。
    const messages: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      messages.push(args.map((arg) => String(arg)).join(" "));
    });
    try {
      custom = await startOn(dataDir);
      const normalizedMessages = messages.filter((message) => message.includes("已正規化"));
      expect(normalizedMessages).toHaveLength(1);
      expect(normalizedMessages[0]).toContain("3 筆");
      for (const content of ["legacy global 帶 project", "legacy agent 帶 project", "legacy project 沒有 project"]) {
        expect(normalizedMessages[0]).not.toContain(content);
      }
    } finally {
      spy.mockRestore();
    }

    const running = custom;
    if (running === undefined) throw new Error("第二階段的服務未啟動");
    const listed = (await api(running, "GET", "/memories")).body as ListMemoriesResponse;
    const byId = new Map(listed.memories.map((memory) => [memory.id, memory]));
    expect(byId.get(globalWithProject.id)).toMatchObject({ scope: "global", project: null });
    expect(byId.get(agentWithProject.id)).toMatchObject({ scope: "agent", project: null });
    expect(byId.get(projectWithoutProject.id)).toMatchObject({ scope: "global", project: null });
    expect(byId.get(legalProject.id)).toMatchObject({ scope: "project", project: "legal-proj" });
    await custom.close();
    custom = undefined;

    // 第三階段：再重啟一次 → 已冪等，updated 0，因此沒有正規化訊息。
    const secondMessages: string[] = [];
    const secondSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      secondMessages.push(args.map((arg) => String(arg)).join(" "));
    });
    try {
      custom = await startOn(dataDir);
      expect(secondMessages.filter((message) => message.includes("已正規化"))).toEqual([]);
    } finally {
      secondSpy.mockRestore();
    }
  });
});
