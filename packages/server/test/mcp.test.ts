/**
 * MCP stdio 入口測試（in-process，但走真正的 stdio 框架）：
 * 用 `runStdio({ stdin, stdout })` 把 stdio 入口接到一對 `PassThrough`，
 * 另一端用 SDK 的 `Client` 連上同一個框架（newline-delimited JSON），
 * 因此 initialize／tools/list／tools/call 都是真的協定往返。
 *
 * 驗收 3：initialize → tools/list（6 工具）→ tools/call（remember→search 找回同一筆；forget 後搜不到）；
 * token 錯誤時工具回報錯誤。
 */
import { PassThrough } from "node:stream";
import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  api,
  makeFixtureRoot,
  makeTempDir,
  NOTE_TOKEN,
  removeTempDir,
  startTestServer,
  TEST_TOKEN,
  type TestServer,
} from "./helpers.js";
import { loadMcpConfig, resolveProjectName, runStdio } from "../src/index.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";

interface McpHarness {
  client: Client;
  mcpServer: Server;
  close(): Promise<void>;
}

/** `startMcp` 的額外選項：MCP 環境變數與 cwd／家目錄注入。 */
interface McpExtraOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  homeDir?: string;
}

/** 啟動 REST ＋ MCP，並把兩端接起來。 */
async function startMcp(token = TEST_TOKEN, extra: McpExtraOptions = {}): Promise<{ rest: TestServer; mcp: McpHarness }> {
  const rest = await startTestServer();
  const clientToServer = new PassThrough();
  const serverToClient = new PassThrough();

  const started = await runStdio({
    env: { MNEMOSHELF_URL: rest.instance.url, MNEMOSHELF_TOKEN: token, ...extra.env },
    ...(extra.cwd === undefined ? {} : { cwd: extra.cwd }),
    ...(extra.homeDir === undefined ? {} : { homeDir: extra.homeDir }),
    stdin: clientToServer,
    stdout: serverToClient,
  });

  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(new StdioServerTransport(serverToClient, clientToServer));

  return {
    rest,
    mcp: {
      client,
      mcpServer: started.server,
      async close(): Promise<void> {
        await client.close();
        await started.server.close();
      },
    },
  };
}

/** 取出工具回應的第一段文字。 */
function textOf(result: unknown): string {
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) throw new Error("工具回應沒有內容");
  const first = content[0] as { type?: unknown; text?: unknown } | undefined;
  if (first === undefined || first.type !== "text" || typeof first.text !== "string") {
    throw new Error("工具回應沒有文字內容");
  }
  return first.text;
}

/** 解析工具回應的文字（我們的工具一律回傳 JSON 字串）。 */
function jsonOf<T>(result: unknown): T {
  return JSON.parse(textOf(result)) as T;
}

let rest: TestServer | undefined;
let mcp: McpHarness | undefined;
const dirs: string[] = [];

afterEach(async () => {
  await mcp?.close();
  mcp = undefined;
  await rest?.close();
  rest = undefined;
  while (dirs.length > 0) await removeTempDir(dirs.pop()!);
});

describe("MCP stdio 入口", () => {
  it("initialize → tools/list（6 工具，描述含不受信任資料警語）", async () => {
    const harness = await startMcp();
    rest = harness.rest;
    mcp = harness.mcp;

    expect(harness.mcp.client.getServerVersion()?.name).toBe("mnemoshelf");
    // 信任模型與不受信任資料的說明要出現在 server instructions（讓 agent 一開始就知道限制）。
    const instructions = harness.mcp.client.getInstructions() ?? "";
    expect(instructions).toContain("單一 token");
    expect(instructions).toContain("不受信任");

    const tools = await harness.mcp.client.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
      "forget",
      "list_roots",
      "recall",
      "remember",
      "search",
      "search_memories",
    ]);
    for (const tool of tools.tools) {
      expect(tool.description ?? "").toContain("不受信任");
      expect(tool.inputSchema.type).toBe("object");
    }
    const search = tools.tools.find((tool) => tool.name === "search")!;
    expect(Object.keys((search.inputSchema.properties ?? {}) as Record<string, unknown>).sort()).toEqual([
      "k",
      "mode",
      "query",
      "rootIds",
    ]);

    // 卡 C2：remember 多了 additive 的 force 參數（描述要講清楚 duplicate 與 force 的差異）。
    const remember = tools.tools.find((tool) => tool.name === "remember")!;
    expect(Object.keys((remember.inputSchema.properties ?? {}) as Record<string, unknown>).sort()).toEqual([
      "content",
      "force",
      "kind",
      "project",
      "scope",
    ]);
    expect(remember.description).toContain("duplicate: true");
    expect(remember.description).toContain("force");

    const searchMemories = tools.tools.find((tool) => tool.name === "search_memories")!;
    expect(Object.keys((searchMemories.inputSchema.properties ?? {}) as Record<string, unknown>).sort()).toEqual([
      "includeAllProjects",
      "k",
      "kind",
      "minScore",
      "project",
      "query",
      "scope",
    ]);
    expect(searchMemories.description).toContain("MNEMOSHELF_PROJECT");
    expect(searchMemories.description).toContain("includeAllProjects");
  });

  it("list_roots／search 轉發 REST，命中帶來源", async () => {
    const harness = await startMcp();
    rest = harness.rest;
    mcp = harness.mcp;

    const dir = await makeFixtureRoot();
    dirs.push(dir);
    const created = await api(rest.instance, "POST", "/roots", {
      body: { path: dir, modalities: ["text", "code", "image"] },
    });
    const root = created.body as { id: number };
    await api(rest.instance, "POST", `/roots/${root.id}/index`);

    const rootsResult = await mcp.client.callTool({ name: "list_roots", arguments: {} });
    expect(rootsResult.isError).toBeFalsy();
    const roots = jsonOf<{ roots: { id: number; path: string }[] }>(rootsResult);
    expect(roots.roots).toHaveLength(1);
    expect(roots.roots[0]!.id).toBe(root.id);

    const searchResult = await mcp.client.callTool({ name: "search", arguments: { query: NOTE_TOKEN, mode: "hybrid" } });
    expect(searchResult.isError).toBeFalsy();
    const hits = jsonOf<{ mode: string; hits: { type: string; rank: number; rootId?: number; relPath?: string; kind?: string }[] }>(searchResult);
    expect(hits.mode).toBe("hybrid");
    expect(hits.hits.length).toBeGreaterThan(0);
    const chunk = hits.hits.find((hit) => hit.type === "chunk")!;
    expect(chunk.rootId).toBe(root.id);
    expect(typeof chunk.relPath).toBe("string");
    expect(hits.hits.map((hit) => hit.rank)).toEqual(hits.hits.map((_hit, index) => index + 1));
  });

  it("remember → search 找回同一筆（agent 取自 MCP 客戶端名稱）→ forget 後搜不到", async () => {
    const harness = await startMcp();
    rest = harness.rest;
    mcp = harness.mcp;

    const content = `remember 的測試內容 unique-marker-77`;
    const remembered = await mcp.client.callTool({
      name: "remember",
      arguments: { content, kind: "fact", scope: "global" },
    });
    expect(remembered.isError).toBeFalsy();
    const memory = jsonOf<{ id: number; agent: string; content: string }>(remembered);
    expect(memory.content).toBe(content);
    expect(memory.agent).toBe("test-client");

    // 記憶只在 keyword／hybrid 命中（M2 起不帶 mode 的預設是 vector）。
    const found = await mcp.client.callTool({ name: "search", arguments: { query: "unique-marker-77", mode: "keyword" } });
    const hits = jsonOf<{ hits: { type: string; id?: number; agent?: string }[] }>(found);
    const memoryHit = hits.hits.find((hit) => hit.type === "memory");
    expect(memoryHit).toBeDefined();
    expect(memoryHit!.id).toBe(memory.id);
    expect(memoryHit!.agent).toBe("test-client");

    const forgotten = await mcp.client.callTool({ name: "forget", arguments: { id: memory.id } });
    expect(forgotten.isError).toBeFalsy();

    const afterForget = await mcp.client.callTool({ name: "search", arguments: { query: "unique-marker-77", mode: "keyword" } });
    const remaining = jsonOf<{ hits: { type: string }[] }>(afterForget).hits.filter((hit) => hit.type === "memory");
    expect(remaining).toHaveLength(0);
  });

  it("remember 精確去重：重複回既有記憶＋duplicate: true；force 可新增；非 boolean force 回工具錯誤", async () => {
    const harness = await startMcp();
    rest = harness.rest;
    mcp = harness.mcp;

    const base = { content: "MCP 去重測試內容 unique-marker-dedupe", kind: "fact", scope: "global" } as const;
    const first = jsonOf<{ id: number; duplicate?: boolean }>(
      await mcp.client.callTool({ name: "remember", arguments: base }),
    );
    expect(first.duplicate).toBe(false);

    // 只差前後空白 → 同 key，不新增；回應是既有記憶＋duplicate: true。
    const second = jsonOf<{ id: number; duplicate?: boolean }>(
      await mcp.client.callTool({ name: "remember", arguments: { ...base, content: `  ${base.content}  ` } }),
    );
    expect(second.duplicate).toBe(true);
    expect(second.id).toBe(first.id);

    const recalled = jsonOf<{ memories: { id: number }[] }>(
      await mcp.client.callTool({ name: "recall", arguments: {} }),
    );
    expect(recalled.memories.map((memory) => memory.id)).toEqual([first.id]);

    // force: true → 一般新增（第二筆同內容）。
    const forced = jsonOf<{ id: number; duplicate?: boolean }>(
      await mcp.client.callTool({ name: "remember", arguments: { ...base, force: true } }),
    );
    expect(forced.duplicate).toBe(false);
    expect(forced.id).not.toBe(first.id);
    const recalledAfterForce = jsonOf<{ memories: { id: number }[] }>(
      await mcp.client.callTool({ name: "recall", arguments: {} }),
    );
    expect(recalledAfterForce.memories.map((memory) => memory.id).sort()).toEqual([first.id, forced.id].sort());

    // `force` 原樣轉發給 REST：非 boolean → 400，工具回報 ValidationError。
    const badForce = await mcp.client.callTool({
      name: "remember",
      arguments: { ...base, content: "force 型別錯誤", force: "true" },
    });
    expect(badForce.isError).toBe(true);
    expect(textOf(badForce)).toContain("ValidationError");
  });

  it("recall 列出記憶（可帶 filter），forget 後不再列出", async () => {
    const harness = await startMcp();
    rest = harness.rest;
    mcp = harness.mcp;

    const first = jsonOf<{ id: number }>(
      await mcp.client.callTool({ name: "remember", arguments: { content: "recall 的第一筆 recall-marker-a", kind: "fact" } }),
    );
    const second = jsonOf<{ id: number }>(
      await mcp.client.callTool({
        name: "remember",
        arguments: { content: "recall 的第二筆 recall-marker-b", kind: "pitfall", scope: "project", project: "proj-r" },
      }),
    );

    const listed = await mcp.client.callTool({ name: "recall", arguments: {} });
    expect(listed.isError).toBeFalsy();
    const memories = jsonOf<{ memories: { id: number; agent: string; kind: string; project: string | null }[] }>(listed).memories;
    expect(memories.map((memory) => memory.id)).toEqual([second.id, first.id]);
    expect(memories[0]).toMatchObject({ agent: "test-client", kind: "pitfall", project: "proj-r" });

    // filter 轉發到 REST
    const filtered = jsonOf<{ memories: { id: number }[] }>(
      await mcp.client.callTool({ name: "recall", arguments: { kind: "fact" } }),
    );
    expect(filtered.memories.map((memory) => memory.id)).toEqual([first.id]);

    const limited = jsonOf<{ memories: { id: number }[] }>(
      await mcp.client.callTool({ name: "recall", arguments: { limit: 1 } }),
    );
    expect(limited.memories.map((memory) => memory.id)).toEqual([second.id]);

    // 軟刪除後不再列出
    await mcp.client.callTool({ name: "forget", arguments: { id: first.id } });
    const afterForget = jsonOf<{ memories: { id: number }[] }>(await mcp.client.callTool({ name: "recall", arguments: {} }));
    expect(afterForget.memories.map((memory) => memory.id)).toEqual([second.id]);

    // 參數不合法 → 轉發 REST 的 400
    const bad = await mcp.client.callTool({ name: "recall", arguments: { scope: "nope" } });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toContain("ValidationError");
  });

  it("recall 與 remember 的回應帶來源欄位（sourceSession／sourceMessage；additive）", async () => {
    const harness = await startMcp();
    rest = harness.rest;
    mcp = harness.mcp;

    // 由 REST（自動寫入者的路徑）寫入一筆帶來源的記憶；MCP 只負責轉發與呈現。
    const created = await api(rest.instance, "POST", "/memories", {
      body: {
        content: "MCP 來源欄位測試 recall-marker-provenance",
        agent: "opencode-plugin@0.1.0",
        scope: "global",
        sourceSession: "ses_mcp_0001",
        sourceMessage: "msg_mcp_0001",
      },
    });
    expect(created.status).toBe(201);
    const createdId = (created.body as { id: number }).id;

    const listed = await mcp.client.callTool({ name: "recall", arguments: {} });
    expect(listed.isError).toBeFalsy();
    const memories = jsonOf<{
      memories: { id: number; agent: string; sourceSession: string | null; sourceMessage: string | null }[];
    }>(listed).memories;
    expect(memories.find((memory) => memory.id === createdId)).toMatchObject({
      agent: "opencode-plugin@0.1.0",
      sourceSession: "ses_mcp_0001",
      sourceMessage: "msg_mcp_0001",
    });

    // MCP remember 沒有 session 資訊：來源欄位存在但為 null（不是空字串）。
    const remembered = jsonOf<{ sourceSession: string | null; sourceMessage: string | null }>(
      await mcp.client.callTool({ name: "remember", arguments: { content: "MCP 寫入沒有來源", scope: "global" } }),
    );
    expect(remembered).toMatchObject({ sourceSession: null, sourceMessage: null });
  });

  it("工具參數不合法時回報 REST 的錯誤（不吞掉）", async () => {
    const harness = await startMcp();
    rest = harness.rest;
    mcp = harness.mcp;

    const noQuery = await mcp.client.callTool({ name: "search", arguments: {} });
    expect(noQuery.isError).toBe(true);
    expect(textOf(noQuery)).toContain("ValidationError");

    const badId = await mcp.client.callTool({ name: "forget", arguments: { id: "abc" } });
    expect(badId.isError).toBe(true);
    expect(textOf(badId)).toContain("ValidationError");
  });

  it("search_memories：預設專案＋global＋自己的 agent 範圍；includeAllProjects 跨專案", async () => {
    const harness = await startMcp();
    rest = harness.rest;
    mcp = harness.mcp;
    const instance = rest.instance;

    // 預設專案＝cwd basename（測試的 cwd 是 packages/server → "server"）。
    const memoryBody = { agent: "agent-mcp-recall", content: "mcp 召回測試記憶" };
    const created: number[] = [];
    for (const body of [
      { ...memoryBody, scope: "global", content: "mcp 召回 全域" },
      { ...memoryBody, scope: "project", project: "server", content: "mcp 召回 本專案" },
      { ...memoryBody, scope: "project", project: "other-proj", content: "mcp 召回 其他專案" },
    ]) {
      const response = await api(instance, "POST", "/memories", { body });
      expect(response.status).toBe(201);
      created.push((response.body as { id: number }).id);
    }
    // agent 範圍：由 MCP remember 寫入（agent 取自 client 名稱）。
    const remembered = await harness.mcp.client.callTool({
      name: "remember",
      arguments: { content: "mcp 召回 agent 範圍", scope: "agent" },
    });
    const agentMemory = jsonOf<{ id: number }>(remembered);
    created.push(agentMemory.id);

    // 等所有記憶向量就緒（語意路徑才會啟用）。
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const diagnostics = (await api(instance, "GET", "/diagnostics")).body as { memories?: { ready?: number } };
      if ((diagnostics.memories?.ready ?? 0) >= 4) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const defaults = await harness.mcp.client.callTool({ name: "search_memories", arguments: { query: "mcp 召回" } });
    expect(defaults.isError).toBeFalsy();
    const body = jsonOf<{
      degraded: boolean;
      k: number;
      memoryEmbedding: { ready: number };
      hits: { id: number; rank: number; score: number; source: string; content: string }[];
    }>(defaults);
    expect(body.degraded).toBe(false);
    expect(body.memoryEmbedding.ready).toBeGreaterThanOrEqual(4);
    expect(body.hits.map((hit) => hit.rank)).toEqual(body.hits.map((_hit, index) => index + 1));
    for (const hit of body.hits) {
      expect(["semantic", "keyword"]).toContain(hit.source);
      expect(typeof hit.score).toBe("number");
      expect(typeof hit.content).toBe("string");
    }
    const defaultIds = body.hits.map((hit) => hit.id);
    // 預設含 global＋本專案＋自己的 agent；不含其他專案。
    expect(defaultIds).toEqual(expect.arrayContaining(created.slice(0, 2)));
    expect(defaultIds).toContain(agentMemory.id);
    expect(defaultIds).not.toContain(created[2]);

    // includeAllProjects：跨專案（含 other-proj）。
    const all = await harness.mcp.client.callTool({
      name: "search_memories",
      arguments: { query: "mcp 召回", includeAllProjects: true },
    });
    const allBody = jsonOf<{ hits: { id: number }[] }>(all);
    expect(allBody.hits.map((hit) => hit.id)).toContain(created[2]);
  });

  it("search_memories：解析不到專案且未 includeAllProjects → 清楚工具錯誤；scope=global 不需專案", async () => {
    const fakeHome = path.resolve("synthetic-workspace", "fake-home", "someone");
    const harness = await startMcp(TEST_TOKEN, { cwd: fakeHome, homeDir: fakeHome });
    rest = harness.rest;
    mcp = harness.mcp;

    const unresolved = await harness.mcp.client.callTool({
      name: "search_memories",
      arguments: { query: "沒有專案" },
    });
    expect(unresolved.isError).toBe(true);
    expect(textOf(unresolved)).toContain("MNEMOSHELF_PROJECT");
    expect(textOf(unresolved)).toContain("includeAllProjects");

    // 明確 scope=global 不需要專案，可直接查（沒有資料 → 空結果但不是錯誤）。
    const globalScope = await harness.mcp.client.callTool({
      name: "search_memories",
      arguments: { query: "x", scope: "global" },
    });
    expect(globalScope.isError).toBeFalsy();
    expect(jsonOf<{ hits: unknown[] }>(globalScope).hits).toEqual([]);

    // includeAllProjects 也不需要專案。
    const allProjects = await harness.mcp.client.callTool({
      name: "search_memories",
      arguments: { query: "x", includeAllProjects: true },
    });
    expect(allProjects.isError).toBeFalsy();
  });

  it("recall／search_memories 讀取時遮罩既有機密、內容標 untrusted；agent 僅來源標記", async () => {
    const harness = await startMcp();
    rest = harness.rest;
    mcp = harness.mcp;

    // 直接寫入未遮罩資料（模擬舊版內容），驗證 MCP 讀取路徑（經 REST）會再遮。
    const fakeToken = ["s", "k-", "TEST_", "0123456789abcdefghij"].join("");
    const legacy = await rest.instance.store.addMemory({
      content: `legacy MCP 機密 ${fakeToken} 與一般文字`,
      kind: "fact",
      scope: "global",
      project: null,
      agent: "legacy-agent",
      supersedes: null,
    });

    const recalled = jsonOf<{
      untrusted: boolean;
      memories: { id: number; content: string }[];
    }>(await harness.mcp.client.callTool({ name: "recall", arguments: {} }));
    const recalledLegacy = recalled.memories.find((memory) => memory.id === legacy.id);
    expect(recalled.untrusted).toBe(true);
    expect(recalledLegacy?.content).toContain("[REDACTED:token]");
    expect(recalledLegacy?.content).not.toContain("0123456789abcdefghij");

    const searched = jsonOf<{
      hits: { id: number; content: string; untrusted: boolean }[];
    }>(await harness.mcp.client.callTool({ name: "search_memories", arguments: { query: "legacy" } }));
    const searchedLegacy = searched.hits.find((hit) => hit.id === legacy.id);
    expect(searchedLegacy).toBeDefined();
    expect(searchedLegacy?.untrusted).toBe(true);
    expect(searchedLegacy?.content).toContain("[REDACTED:token]");
    expect(searchedLegacy?.content).not.toContain("0123456789abcdefghij");
  });

  it("O4：remember 的非字串 scope 原樣轉 REST（400），不靜默套預設", async () => {
    const harness = await startMcp();
    rest = harness.rest;
    mcp = harness.mcp;

    for (const scope of [42, true, { scope: "global" }] as const) {
      const result = await harness.mcp.client.callTool({
        name: "remember",
        arguments: { content: "非字串 scope 的記憶", scope },
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("ValidationError");
    }
    // `null` 也是非字串：不得被當成「未指定」而套預設。
    const nullScope = await harness.mcp.client.callTool({
      name: "remember",
      arguments: { content: "null scope 的記憶", scope: null },
    });
    expect(nullScope.isError).toBe(true);
    expect(textOf(nullScope)).toContain("ValidationError");

    // 全部被 REST 拒絕 → 沒有任何記憶被寫入。
    const listed = (await api(rest.instance, "GET", "/memories")).body as { memories: unknown[] };
    expect(listed.memories).toEqual([]);
  });

  it("token 錯誤：initialize 仍成功，工具呼叫回報 401 錯誤", async () => {
    const harness = await startMcp("wrong-token-value");
    rest = harness.rest;
    mcp = harness.mcp;

    // 協定握手不需要 token（MCP 不重複實作授權）
    expect(harness.mcp.client.getServerVersion()?.name).toBe("mnemoshelf");
    expect((await harness.mcp.client.listTools()).tools).toHaveLength(6);

    const result = await harness.mcp.client.callTool({ name: "list_roots", arguments: {} });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("UnauthorizedError");
    expect(textOf(result)).not.toContain("wrong-token-value");
  });

  it("REST 的錯誤名稱原樣轉發（未知 root 的 search 不會偽裝成功）", async () => {
    const harness = await startMcp();
    rest = harness.rest;
    mcp = harness.mcp;

    const result = await mcp.client.callTool({ name: "search", arguments: { query: "x", rootIds: [999999] } });
    // rootIds 只是過濾條件，未知 root 不回錯，只是沒有結果
    expect(result.isError).toBeFalsy();
    expect(jsonOf<{ hits: unknown[] }>(result).hits).toEqual([]);

    const missing = await mcp.client.callTool({ name: "forget", arguments: { id: 987654 } });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toContain("NotFoundError");
  });
});

describe("MCP：remember 的專案解析（參數 > 環境變數 > cwd basename > 退回 global）", () => {
  // 合成路徑（不涉及任何真實使用者目錄）。
  const cwdProject = path.resolve("synthetic-workspace", "proj-from-cwd");
  const fakeHome = path.resolve("synthetic-workspace", "fake-home", "someone");

  /** 呼叫 remember 並取出 REST 回傳的記憶（工具回應是 JSON 字串）。 */
  async function callRemember(
    harness: McpHarness,
    args: Record<string, unknown>,
  ): Promise<{ id: number; scope: string; project: string | null }> {
    const result = await harness.client.callTool({ name: "remember", arguments: args });
    expect(result.isError).toBeFalsy();
    return jsonOf<{ id: number; scope: string; project: string | null }>(result);
  }

  it("工具參數最優先；未帶參數時用 MNEMOSHELF_PROJECT", async () => {
    const harness = await startMcp(TEST_TOKEN, {
      env: { MNEMOSHELF_PROJECT: "proj-env" },
      cwd: cwdProject,
      homeDir: fakeHome,
    });
    rest = harness.rest;
    mcp = harness.mcp;

    // 參數 > 環境變數（參數值 trim）。
    expect(await callRemember(harness.mcp, { content: "參數優先的記憶", project: "  proj-arg  " })).toMatchObject({
      scope: "project",
      project: "proj-arg",
    });
    expect(await callRemember(harness.mcp, { content: "環境變數專案的記憶" })).toMatchObject({
      scope: "project",
      project: "proj-env",
    });

    // 工具描述要說明預設專案來源與「全域要明確指定」。
    const tools = await harness.mcp.client.listTools();
    const remember = tools.tools.find((tool) => tool.name === "remember")!;
    expect(remember.description).toContain("MNEMOSHELF_PROJECT");
    expect(remember.description).toContain("全域");
  });

  it("沒有參數與環境變數時，用 cwd 的資料夾名稱當專案", async () => {
    const harness = await startMcp(TEST_TOKEN, { cwd: cwdProject, homeDir: fakeHome });
    rest = harness.rest;
    mcp = harness.mcp;

    expect(await callRemember(harness.mcp, { content: "cwd 專案的記憶" })).toMatchObject({
      scope: "project",
      project: "proj-from-cwd",
    });
  });

  it("cwd 就是家目錄時跳過（不把使用者名稱當專案），退回 global", async () => {
    const harness = await startMcp(TEST_TOKEN, { cwd: fakeHome, homeDir: fakeHome });
    rest = harness.rest;
    mcp = harness.mcp;

    expect(await callRemember(harness.mcp, { content: "家目錄下退回全域的記憶" })).toMatchObject({
      scope: "global",
      project: null,
    });
  });

  it("明確 scope: project 但解析不到專案 → 工具錯誤（提示可帶 project 或設 MNEMOSHELF_PROJECT）", async () => {
    const harness = await startMcp(TEST_TOKEN, { cwd: fakeHome, homeDir: fakeHome });
    rest = harness.rest;
    mcp = harness.mcp;

    const result = await harness.mcp.client.callTool({
      name: "remember",
      arguments: { content: "不該被送出的記憶", scope: "project" },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("MNEMOSHELF_PROJECT");
    expect(textOf(result)).toContain("project");
  });

  it("明確 scope: global 不受環境變數與 project 參數影響（project 一律 null）", async () => {
    const harness = await startMcp(TEST_TOKEN, {
      env: { MNEMOSHELF_PROJECT: "proj-env" },
      cwd: cwdProject,
      homeDir: fakeHome,
    });
    rest = harness.rest;
    mcp = harness.mcp;

    expect(await callRemember(harness.mcp, { content: "明確全域的記憶", scope: "global" })).toMatchObject({
      scope: "global",
      project: null,
    });
    expect(
      await callRemember(harness.mcp, { content: "明確全域且帶 project 參數的記憶", scope: "global", project: "proj-arg" }),
    ).toMatchObject({ scope: "global", project: null });
  });
});

describe("MCP：resolveProjectName 的純函式優先序", () => {
  const cwdProject = path.resolve("synthetic-workspace", "proj-from-cwd");
  const fakeHome = path.resolve("synthetic-workspace", "fake-home", "someone");

  it("參數 > 環境變數 > cwd basename", () => {
    expect(resolveProjectName({ argument: "proj-arg", configProject: "proj-env", cwd: cwdProject, homeDir: fakeHome })).toEqual({
      project: "proj-arg",
      source: "argument",
    });
    expect(resolveProjectName({ configProject: "proj-env", cwd: cwdProject, homeDir: fakeHome })).toEqual({
      project: "proj-env",
      source: "env",
    });
    expect(resolveProjectName({ cwd: cwdProject, homeDir: fakeHome })).toEqual({
      project: "proj-from-cwd",
      source: "cwd",
    });
  });

  it("空白或非字串的參數／設定視為未設定，繼續往下退", () => {
    expect(resolveProjectName({ argument: "   ", configProject: "  ", cwd: cwdProject, homeDir: fakeHome })).toEqual({
      project: "proj-from-cwd",
      source: "cwd",
    });
    expect(resolveProjectName({ argument: 42, configProject: undefined, cwd: cwdProject, homeDir: fakeHome })).toEqual({
      project: "proj-from-cwd",
      source: "cwd",
    });
  });

  it("cwd 等於家目錄、或 cwd 解析不出名稱時回 none", () => {
    expect(resolveProjectName({ cwd: fakeHome, homeDir: fakeHome })).toEqual({ project: null, source: "none" });
    expect(resolveProjectName({ cwd: path.parse(cwdProject).root, homeDir: fakeHome })).toEqual({
      project: null,
      source: "none",
    });
  });
});

describe("MCP 啟動設定", () => {
  it("沒有任何連線來源 → 具名錯誤（會先嘗試 agent 連線資訊檔）", async () => {
    // 注入空的暫存家目錄：確保不會連到本機正在執行的 Mnemoshelf（測試必須自我隔離）。
    const home = await makeTempDir("mnemoshelf-mcp-home-");
    try {
      await expect(runStdio({ env: {}, homeDir: home })).rejects.toMatchObject({
        name: "McpConnectionError",
        reason: "no-config",
      });
      // 只有網址、沒有 token：同樣落到連線資訊檔；找不到就回 no-config。
      await expect(runStdio({ env: { MNEMOSHELF_URL: "http://127.0.0.1:1" }, homeDir: home })).rejects.toMatchObject({
        name: "McpConnectionError",
        reason: "no-config",
      });
    } finally {
      await removeTempDir(home);
    }
  });

  it("loadMcpConfig 讀選配的 MNEMOSHELF_PROJECT（trim；空白視為未設定）", () => {
    const base = { MNEMOSHELF_URL: "http://127.0.0.1:1", MNEMOSHELF_TOKEN: "synthetic-token" };
    const withoutProject = loadMcpConfig(base);
    expect(withoutProject.project).toBeUndefined();
    expect(loadMcpConfig({ ...base, MNEMOSHELF_PROJECT: "  proj-config  " }).project).toBe("proj-config");
    expect(loadMcpConfig({ ...base, MNEMOSHELF_PROJECT: "   " }).project).toBeUndefined();
    expect(loadMcpConfig({ ...base, MNEMOSHELF_PROJECT: "" }).project).toBeUndefined();
  });
});

describe("MCP：連線層失敗時重解析並重試一次", () => {
  const HOME = path.resolve("synthetic-workspace", "fake-home", "someone");
  const OLD_URL = "http://127.0.0.1:54321";
  const NEW_URL = "http://127.0.0.1:54322";
  const OLD_TOKEN = "synthetic-token-old";
  const NEW_TOKEN = "synthetic-token-new";
  const HEALTHY = { status: "ok", service: "mnemoshelf", appVersion: "0.4.0" };

  /** 造的 runtime.json 內容（合成資料）。 */
  function runtimeJson(url: string, token: string): string {
    return JSON.stringify({
      schemaVersion: 1,
      url,
      token,
      pid: 4242,
      startedAt: "2026-01-01T00:00:00.000Z",
      appVersion: "0.4.0",
    });
  }

  /** JSON 回應。 */
  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  /**
   * 假的讀檔：只認得指定路徑，並依序回傳 `versions`（最後一份會一直重複）。
   * `reads()` 用來斷言「重試前只重讀了一次」。
   */
  function runtimeReader(
    file: string,
    versions: string[],
  ): { readFileImpl: (target: string) => Promise<string>; reads: () => number } {
    let reads = 0;
    return {
      reads: () => reads,
      readFileImpl: async (target: string) => {
        if (target !== file) {
          const error = new Error("ENOENT") as NodeJS.ErrnoException;
          error.code = "ENOENT";
          throw error;
        }
        const text = versions[Math.min(reads, versions.length - 1)]!;
        reads += 1;
        return text;
      },
    };
  }

  interface InjectedHarness {
    client: Client;
    close(): Promise<void>;
  }

  /** 以注入的環境變數／fetch／讀檔啟動真正的 stdio 入口（協定往返是真的）。 */
  async function startInjected(input: {
    env: NodeJS.ProcessEnv;
    fetchImpl: typeof fetch;
    readFileImpl: (target: string) => Promise<string>;
    log?: string[];
  }): Promise<InjectedHarness> {
    const clientToServer = new PassThrough();
    const serverToClient = new PassThrough();
    const logs = input.log;
    const started = await runStdio({
      env: input.env,
      stdin: clientToServer,
      stdout: serverToClient,
      platform: "linux",
      homeDir: HOME,
      readFileImpl: input.readFileImpl,
      killImpl: () => undefined,
      fetchImpl: input.fetchImpl,
      ...(logs === undefined ? {} : { log: (message: string) => logs.push(message) }),
    });
    const client = new Client({ name: "retry-client", version: "0.0.0" });
    await client.connect(new StdioServerTransport(serverToClient, clientToServer));
    return {
      client,
      async close(): Promise<void> {
        await client.close();
        await started.server.close();
      },
    };
  }

  it("舊網址連線層失敗 → 重讀 runtime.json 並重做身分檢查 → 重試一次成功（用新 token）", async () => {
    const home = await makeTempDir("mnemoshelf-mcp-retry-");
    dirs.push(home);
    const file = path.join(home, "runtime.json");
    const { readFileImpl, reads } = runtimeReader(file, [
      runtimeJson(OLD_URL, OLD_TOKEN),
      runtimeJson(NEW_URL, NEW_TOKEN),
    ]);

    const requests: { url: string; authorization?: string }[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      requests.push({
        url,
        ...(headers.authorization === undefined ? {} : { authorization: headers.authorization }),
      });
      if (url.endsWith("/health")) return jsonResponse(HEALTHY);
      // 舊服務已經結束（換埠重啟）→ 連線層失敗。
      if (url.startsWith(OLD_URL)) throw new TypeError("fetch failed");
      if (url.startsWith(NEW_URL)) return jsonResponse({ roots: [] });
      throw new Error(`未預期的網址：${url}`);
    }) as unknown as typeof fetch;

    const logs: string[] = [];
    const harness = await startInjected({
      env: { MNEMOSHELF_RUNTIME_FILE: file },
      fetchImpl,
      readFileImpl,
      log: logs,
    });
    try {
      const result = await harness.client.callTool({ name: "list_roots", arguments: {} });
      expect(result.isError).toBeFalsy();
      expect(jsonOf<{ roots: unknown[] }>(result).roots).toEqual([]);
    } finally {
      await harness.close();
    }

    // 舊網址只打一次（失敗的那次），新網址只打一次（重試）；沒有第二次重試。
    const oldCalls = requests.filter((request) => request.url === `${OLD_URL}/roots`);
    const newCalls = requests.filter((request) => request.url === `${NEW_URL}/roots`);
    expect(oldCalls).toHaveLength(1);
    expect(newCalls).toHaveLength(1);
    // 重連後用新的 token（不是舊的）。
    expect(newCalls[0]?.authorization).toBe(`Bearer ${NEW_TOKEN}`);
    // 身分檢查重做：兩個網址各打一次 /health。
    expect(requests.filter((request) => request.url.endsWith("/health")).map((request) => request.url)).toEqual([
      `${OLD_URL}/health`,
      `${NEW_URL}/health`,
    ]);
    // 只重讀一次 runtime.json。
    expect(reads()).toBe(2);

    const logText = logs.join("\n");
    expect(logText).toContain("重試一次");
    expect(logText).not.toContain(OLD_TOKEN);
    expect(logText).not.toContain(NEW_TOKEN);
    expect(logText).not.toContain(file);
  });

  it("重試仍連線層失敗 → 只重試一次（共兩次 REST 呼叫），工具回報穩定代碼", async () => {
    const home = await makeTempDir("mnemoshelf-mcp-retry-fail-");
    dirs.push(home);
    const file = path.join(home, "runtime.json");
    const { readFileImpl, reads } = runtimeReader(file, [
      runtimeJson(OLD_URL, OLD_TOKEN),
      runtimeJson(NEW_URL, NEW_TOKEN),
    ]);

    const requests: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      requests.push(url);
      if (url.endsWith("/health")) return jsonResponse(HEALTHY);
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;

    const harness = await startInjected({
      env: { MNEMOSHELF_RUNTIME_FILE: file },
      fetchImpl,
      readFileImpl,
    });
    try {
      const result = await harness.client.callTool({ name: "list_roots", arguments: {} });
      expect(result.isError).toBe(true);
      // 使用者只看得到穩定代碼與解法，不是 fetch 的實作細節。
      expect(textOf(result)).toContain("connection-lost");
      expect(textOf(result)).not.toContain("fetch failed");
      expect(textOf(result)).toContain("請確認 Mnemoshelf 正在執行");
    } finally {
      await harness.close();
    }

    // 兩次嘗試，沒有第三次。
    expect(requests.filter((url) => url === `${OLD_URL}/roots`)).toHaveLength(1);
    expect(requests.filter((url) => url === `${NEW_URL}/roots`)).toHaveLength(1);
    expect(reads()).toBe(2);
  });

  it("環境變數來源換埠：重解析不讀 runtime.json，第二次仍打同一個網址（失敗）", async () => {
    // 使用者明確用環境變數指定連線：入口不得自行改讀連線資訊檔，也不得更換網址。
    const requests: string[] = [];
    const reads = { count: 0 };
    const readFileImpl = async (): Promise<string> => {
      reads.count += 1;
      const error = new Error("ENOENT") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    };
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      requests.push(url);
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;

    const harness = await startInjected({
      env: { MNEMOSHELF_URL: OLD_URL, MNEMOSHELF_TOKEN: OLD_TOKEN },
      fetchImpl,
      readFileImpl,
    });
    try {
      const result = await harness.client.callTool({ name: "list_roots", arguments: {} });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("connection-lost");
    } finally {
      await harness.close();
    }

    // 完全沒有讀檔：環境變數是使用者明確指定的連線。
    expect(reads.count).toBe(0);
    // 重試仍打舊網址（連線失敗），沒有 /health 身分檢查、沒有新埠。
    expect(requests).toEqual([`${OLD_URL}/roots`, `${OLD_URL}/roots`]);
  });

  it("remember 帶 force: true 連線失敗 → 不重試，回穩定代碼並請使用者先查詢", async () => {
    const home = await makeTempDir("mnemoshelf-mcp-force-no-retry-");
    dirs.push(home);
    const file = path.join(home, "runtime.json");
    const { readFileImpl, reads } = runtimeReader(file, [runtimeJson(OLD_URL, OLD_TOKEN)]);

    const requests: string[] = [];
    const logs: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      requests.push(url);
      if (url.endsWith("/health")) return jsonResponse(HEALTHY);
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;

    const harness = await startInjected({
      env: { MNEMOSHELF_RUNTIME_FILE: file },
      fetchImpl,
      readFileImpl,
      log: logs,
    });
    try {
      const result = await harness.client.callTool({
        name: "remember",
        arguments: { content: "force 寫入不重試", scope: "global", force: true },
      });
      expect(result.isError).toBe(true);
      const text = textOf(result);
      expect(text).toContain("connection-lost");
      expect(text).toContain("請先查詢確認");
      expect(text).toContain("寫入");
      expect(text).not.toContain("fetch failed");
      expect(text).not.toContain(OLD_TOKEN);
      expect(text).not.toContain(home);
    } finally {
      await harness.close();
    }

    // 只有第一次 REST 呼叫；沒有重讀 runtime 檔（重試才會），也沒有第二次請求。
    expect(requests.filter((url) => url === `${OLD_URL}/memories`)).toHaveLength(1);
    expect(reads()).toBe(1);
    // 原始錯誤只寫進 stderr 診斷輸出，且不含 token／路徑。
    const logText = logs.join("\n");
    expect(logText).toContain("不自動重試");
    expect(logText).toContain("fetch failed");
    expect(logText).not.toContain(OLD_TOKEN);
    expect(logText).not.toContain(home);
  });

  it("forget 連線失敗 → 不重試（避免 404 被誤當成刪除失敗）", async () => {
    const home = await makeTempDir("mnemoshelf-mcp-forget-no-retry-");
    dirs.push(home);
    const file = path.join(home, "runtime.json");
    const { readFileImpl, reads } = runtimeReader(file, [runtimeJson(OLD_URL, OLD_TOKEN)]);

    const requests: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      requests.push(url);
      if (url.endsWith("/health")) return jsonResponse(HEALTHY);
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;

    const harness = await startInjected({
      env: { MNEMOSHELF_RUNTIME_FILE: file },
      fetchImpl,
      readFileImpl,
    });
    try {
      const result = await harness.client.callTool({ name: "forget", arguments: { id: 7 } });
      expect(result.isError).toBe(true);
      const text = textOf(result);
      expect(text).toContain("connection-lost");
      expect(text).toContain("刪除");
      expect(text).toContain("請先查詢確認");
      expect(text).not.toContain("fetch failed");
    } finally {
      await harness.close();
    }

    expect(requests.filter((url) => url === `${OLD_URL}/memories/7`)).toHaveLength(1);
    expect(reads()).toBe(1);
  });

  it("remember（沒有 force）連線失敗 → 重新解析後重試一次並成功", async () => {
    const home = await makeTempDir("mnemoshelf-mcp-remember-retry-");
    dirs.push(home);
    const file = path.join(home, "runtime.json");
    const { readFileImpl, reads } = runtimeReader(file, [
      runtimeJson(OLD_URL, OLD_TOKEN),
      runtimeJson(NEW_URL, NEW_TOKEN),
    ]);

    const requests: { url: string; authorization?: string }[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      requests.push({
        url,
        ...(headers.authorization === undefined ? {} : { authorization: headers.authorization }),
      });
      if (url.endsWith("/health")) return jsonResponse(HEALTHY);
      if (url.startsWith(OLD_URL)) throw new TypeError("fetch failed");
      return jsonResponse({ id: 11, content: "重試後寫入", scope: "global", duplicate: false }, 201);
    }) as unknown as typeof fetch;

    const harness = await startInjected({
      env: { MNEMOSHELF_RUNTIME_FILE: file },
      fetchImpl,
      readFileImpl,
    });
    try {
      const result = await harness.client.callTool({
        name: "remember",
        arguments: { content: "重試後寫入", scope: "global" },
      });
      expect(result.isError).toBeFalsy();
      expect(jsonOf<{ id: number }>(result).id).toBe(11);
    } finally {
      await harness.close();
    }

    const oldCalls = requests.filter((request) => request.url === `${OLD_URL}/memories`);
    const newCalls = requests.filter((request) => request.url === `${NEW_URL}/memories`);
    expect(oldCalls).toHaveLength(1);
    expect(newCalls).toHaveLength(1);
    // 重試用的是重連後的新 token。
    expect(newCalls[0]?.authorization).toBe(`Bearer ${NEW_TOKEN}`);
    expect(reads()).toBe(2);
  });

  it("重連成功後，下一次呼叫直接用新網址、不再重連", async () => {
    const home = await makeTempDir("mnemoshelf-mcp-persist-");
    dirs.push(home);
    const file = path.join(home, "runtime.json");
    const { readFileImpl, reads } = runtimeReader(file, [
      runtimeJson(OLD_URL, OLD_TOKEN),
      runtimeJson(NEW_URL, NEW_TOKEN),
    ]);

    const requests: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      requests.push(url);
      if (url.endsWith("/health")) return jsonResponse(HEALTHY);
      if (url.startsWith(OLD_URL)) throw new TypeError("fetch failed");
      return jsonResponse({ roots: [] });
    }) as unknown as typeof fetch;

    const harness = await startInjected({
      env: { MNEMOSHELF_RUNTIME_FILE: file },
      fetchImpl,
      readFileImpl,
    });
    try {
      expect((await harness.client.callTool({ name: "list_roots", arguments: {} })).isError).toBeFalsy();
      // 第二次呼叫：state 已是新網址，直接打，不應再失敗或重連。
      expect((await harness.client.callTool({ name: "list_roots", arguments: {} })).isError).toBeFalsy();
    } finally {
      await harness.close();
    }

    expect(requests.filter((url) => url === `${NEW_URL}/roots`)).toHaveLength(2);
    expect(requests.filter((url) => url === `${OLD_URL}/roots`)).toHaveLength(1);
    // 只有第一次重連會重做身分檢查與重讀檔案。
    expect(requests.filter((url) => url.endsWith("/health"))).toHaveLength(2);
    expect(reads()).toBe(2);
  });

  it("HTTP 層錯誤（401）不重試、也不重讀 runtime.json", async () => {
    const home = await makeTempDir("mnemoshelf-mcp-no-retry-");
    dirs.push(home);
    const file = path.join(home, "runtime.json");
    const { readFileImpl, reads } = runtimeReader(file, [runtimeJson(OLD_URL, OLD_TOKEN)]);

    const requests: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      requests.push(url);
      if (url.endsWith("/health")) return jsonResponse(HEALTHY);
      // 伺服器有回應，只是 token 不對：這是答案，重試沒有意義。
      return jsonResponse({ error: { name: "UnauthorizedError", message: "缺少或錯誤的 Authorization: Bearer token" } }, 401);
    }) as unknown as typeof fetch;

    const harness = await startInjected({
      env: { MNEMOSHELF_RUNTIME_FILE: file },
      fetchImpl,
      readFileImpl,
    });
    try {
      const result = await harness.client.callTool({ name: "list_roots", arguments: {} });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("UnauthorizedError");
    } finally {
      await harness.close();
    }

    expect(requests).toEqual([`${OLD_URL}/health`, `${OLD_URL}/roots`]);
    // 沒有重讀 runtime 檔（重試才會重讀）。
    expect(reads()).toBe(1);
  });

  it("重驗失敗 → 工具回報對應的失敗代碼（url-not-loopback），且不送請求到新網址", async () => {
    const home = await makeTempDir("mnemoshelf-mcp-reverify-");
    dirs.push(home);
    const file = path.join(home, "runtime.json");
    const { readFileImpl } = runtimeReader(file, [
      runtimeJson(OLD_URL, OLD_TOKEN),
      // 換成非 loopback 網址：重新解析時必須拒絕，不能把 token 送出去。
      runtimeJson("http://192.168.1.9:54322", NEW_TOKEN),
    ]);

    const requests: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      requests.push(url);
      if (url.endsWith("/health")) return jsonResponse(HEALTHY);
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;

    const harness = await startInjected({
      env: { MNEMOSHELF_RUNTIME_FILE: file },
      fetchImpl,
      readFileImpl,
    });
    try {
      const result = await harness.client.callTool({ name: "list_roots", arguments: {} });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("url-not-loopback");
      // 錯誤訊息不含 token。
      expect(textOf(result)).not.toContain(OLD_TOKEN);
      expect(textOf(result)).not.toContain(NEW_TOKEN);
    } finally {
      await harness.close();
    }

    expect(requests).toEqual([`${OLD_URL}/health`, `${OLD_URL}/roots`]);
  });

  it("stdout 只有 JSON-RPC；stderr 有連線來源說明（不含 token 與路徑）", async () => {
    const dir = await makeTempDir("mnemoshelf-mcp-io-");
    dirs.push(dir);
    const runtimeFile = path.join(dir, "runtime.json");
    await fs.writeFile(runtimeFile, runtimeJson(OLD_URL, OLD_TOKEN), "utf8");

    const stderr: string[] = [];
    const stdoutChunks: string[] = [];
    const clientToServer = new PassThrough();
    const serverToClient = new PassThrough();
    // tee：同一份位元組既給 Client 讀，也留一份給測試檢查。
    const stdoutTee = new PassThrough();
    stdoutTee.on("data", (chunk: Buffer) => stdoutChunks.push(chunk.toString("utf8")));
    stdoutTee.pipe(serverToClient);

    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/health")) return jsonResponse(HEALTHY);
      return jsonResponse({ roots: [] });
    }) as unknown as typeof fetch;

    const started = await runStdio({
      env: { MNEMOSHELF_RUNTIME_FILE: runtimeFile },
      stdin: clientToServer,
      stdout: stdoutTee,
      platform: "linux",
      homeDir: HOME,
      killImpl: () => undefined,
      fetchImpl,
      log: (message: string) => stderr.push(message),
    });
    const client = new Client({ name: "io-client", version: "0.0.0" });
    await client.connect(new StdioServerTransport(serverToClient, clientToServer));
    try {
      expect((await client.listTools()).tools).toHaveLength(6);
      const result = await client.callTool({ name: "list_roots", arguments: {} });
      expect(result.isError).toBeFalsy();
    } finally {
      await client.close();
      await started.server.close();
    }

    // stdout 是協定通道：每一行都必須是 JSON-RPC。
    const lines = stdoutChunks.join("").split("\n").filter((line) => line.trim() !== "");
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      const message = JSON.parse(line) as { jsonrpc?: string };
      expect(message.jsonrpc).toBe("2.0");
    }

    const stderrText = stderr.join("\n");
    expect(stderrText).toContain("連線來源：連線資訊檔");
    expect(stderrText).toContain("127.0.0.1:54321");
    expect(stderrText).not.toContain(OLD_TOKEN);
    expect(stderrText).not.toContain(runtimeFile);
    expect(stderrText).not.toContain(HOME);
  });

  it("環境變數只給一半而改用連線資訊檔時，說明哪一個被忽略（不印值）", async () => {
    const home = await makeTempDir("mnemoshelf-mcp-partial-env-");
    dirs.push(home);
    const file = path.join(home, "runtime.json");
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/health")) return jsonResponse(HEALTHY);
      return jsonResponse({ roots: [] });
    }) as unknown as typeof fetch;

    // 只有 token：token 被忽略（網址與 token 都改由檔案提供）。
    const tokenOnlyLogs: string[] = [];
    const tokenOnly = await startInjected({
      env: { MNEMOSHELF_RUNTIME_FILE: file, MNEMOSHELF_TOKEN: "synthetic-ignored-token" },
      fetchImpl,
      readFileImpl: runtimeReader(file, [runtimeJson(OLD_URL, OLD_TOKEN)]).readFileImpl,
      log: tokenOnlyLogs,
    });
    await tokenOnly.close();
    expect(tokenOnlyLogs.join("\n")).toContain("已忽略環境變數 MNEMOSHELF_TOKEN");
    expect(tokenOnlyLogs.join("\n")).not.toContain("synthetic-ignored-token");

    // 只有網址：網址被忽略（必須與檔案一致，實際使用的是檔案裡的網址）。
    const urlOnlyLogs: string[] = [];
    const urlOnly = await startInjected({
      env: { MNEMOSHELF_RUNTIME_FILE: file, MNEMOSHELF_URL: OLD_URL },
      fetchImpl,
      readFileImpl: runtimeReader(file, [runtimeJson(OLD_URL, OLD_TOKEN)]).readFileImpl,
      log: urlOnlyLogs,
    });
    await urlOnly.close();
    expect(urlOnlyLogs.join("\n")).toContain("已忽略環境變數 MNEMOSHELF_URL");
  });
});
