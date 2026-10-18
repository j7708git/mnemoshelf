/**
 * MCP stdio 入口測試（in-process，但走真正的 stdio 框架）：
 * 用 `runStdio({ stdin, stdout })` 把 stdio 入口接到一對 `PassThrough`，
 * 另一端用 SDK 的 `Client` 連上同一個框架（newline-delimited JSON），
 * 因此 initialize／tools/list／tools/call 都是真的協定往返。
 *
 * 驗收 3：initialize → tools/list（5 工具）→ tools/call（remember→search 找回同一筆；forget 後搜不到）；
 * token 錯誤時工具回報錯誤。
 */
import { PassThrough } from "node:stream";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  api,
  makeFixtureRoot,
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
  it("initialize → tools/list（5 工具，描述含不受信任資料警語）", async () => {
    const harness = await startMcp();
    rest = harness.rest;
    mcp = harness.mcp;

    expect(harness.mcp.client.getServerVersion()?.name).toBe("mnemoshelf");

    const tools = await harness.mcp.client.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
      "forget",
      "list_roots",
      "recall",
      "remember",
      "search",
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

  it("token 錯誤：initialize 仍成功，工具呼叫回報 401 錯誤", async () => {
    const harness = await startMcp("wrong-token-value");
    rest = harness.rest;
    mcp = harness.mcp;

    // 協定握手不需要 token（MCP 不重複實作授權）
    expect(harness.mcp.client.getServerVersion()?.name).toBe("mnemoshelf");
    expect((await harness.mcp.client.listTools()).tools).toHaveLength(5);

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
  it("缺少 MNEMOSHELF_URL／TOKEN → 具名錯誤", async () => {
    await expect(runStdio({ env: {} })).rejects.toMatchObject({ name: "MissingMcpConfigError" });
    await expect(runStdio({ env: { MNEMOSHELF_URL: "http://127.0.0.1:1" } })).rejects.toMatchObject({
      name: "MissingMcpConfigError",
    });
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
