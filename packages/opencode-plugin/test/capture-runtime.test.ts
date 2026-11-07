/** 以合成 durable events 驗證正式 runtime；宿主的模型介面一旦被存取就讓測試失敗。 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMemoryRuntime } from "../src/recall.js";
import type { SourceWriteRequest } from "../src/raw-memory.js";
import type { PluginContextLike } from "../src/types.js";

const location = path.join(path.parse(process.cwd()).root, "workspace", "synthetic-repo");
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function events() {
  const queue: unknown[] = [];
  let deliver: ((result: IteratorResult<unknown>) => void) | undefined;
  return {
    publish(value: unknown): void {
      if (deliver) {
        const pending = deliver;
        deliver = undefined;
        pending({ done: false, value });
      } else queue.push(value);
    },
    subscribe(): AsyncIterable<unknown> {
      return {
        [Symbol.asyncIterator]: () => ({
          next: () => queue.length > 0
            ? Promise.resolve({ done: false, value: queue.shift() })
            : new Promise<IteratorResult<unknown>>((resolve) => { deliver = resolve; }),
          return: async () => {
            deliver?.({ done: true, value: undefined });
            return { done: true, value: undefined };
          },
        }),
      };
    },
  };
}

function terminal(id = "e1", created = 9000, type = "succeeded", reason?: string) {
  return { id, created, type: `session.execution.${type}`, data: { sessionID: "s1", reason } };
}

async function setup(input: {
  options?: Record<string, unknown>;
  snapshot?: unknown[];
  parentID?: string;
  directory?: string;
  dir?: string;
}) {
  const dir = input.dir ?? await fs.mkdtemp(path.join(os.tmpdir(), "mnemoshelf-opencode-raw-"));
  if (!input.dir) dirs.push(dir);
  const bus = events();
  const posts: SourceWriteRequest[] = [];
  const attemptedRoutes: string[] = [];
  const logs: string[] = [];
  let hostReads = 0;
  let modelReads = 0;
  let maskSecrets = true;
  let version = 1;
  let mode: "normal" | "old" | "html" | "offline" | "oversize" | "conflict" = "normal";
  let snapshot = input.snapshot ?? [
    { id: "u1", type: "user", text: "不行", time: { created: 1000 } },
    { type: "assistant", content: [{ type: "text", text: "收到。" }] },
  ];

  const fetchImpl: typeof fetch = async (url, init) => {
    const route = new URL(String(url)).pathname;
    attemptedRoutes.push(route);
    if (route === "/memory-policy") {
      if (mode === "old") return new Response("missing", { status: 404 });
      if (mode === "offline") throw new Error("offline");
      return Response.json({ maskSecrets, version });
    }
    if (route !== "/memory-sources") throw new Error("unexpected HTTP route");
    const body = JSON.parse(String(init?.body)) as SourceWriteRequest;
    posts.push(body);
    if (mode === "html") return new Response("<html>not an API</html>");
    if (mode === "oversize") return Response.json({}, { status: 413 });
    if (mode === "conflict") return Response.json({}, { status: 409 });
    const duplicate = posts.slice(0, -1).some((entry) =>
      JSON.stringify(entry) === JSON.stringify(body));
    return Response.json({
      source: { ...body, id: 1, messages: undefined, messageCount: body.messages.length,
        createdAt: "2026-01-01T00:00:00.000Z", chunkVersion: "raw-v1" },
      policyVersion: version,
      memoryIds: [1],
      duplicate,
      saved: true,
      redacted: false,
      redactedCount: 0,
    }, { status: duplicate ? 200 : 201 });
  };

  const ctx: PluginContextLike = {
    options: input.options,
    location: { directory: location },
    session: {
      hook: async () => undefined,
      synthetic: async () => undefined,
      get: async () => ({ parentID: input.parentID, location: { directory: input.directory ?? location } }),
      context: async () => { hostReads += 1; return snapshot; },
    },
    event: bus,
  };
  for (const key of ["generate", "model"]) {
    Object.defineProperty(ctx, key, { get() { modelReads += 1; throw new Error("generation blocked"); } });
  }
  const runtime = await createMemoryRuntime(ctx, {
    env: { MNEMOSHELF_URL: "http://127.0.0.1:43117", MNEMOSHELF_TOKEN: "test-token" },
    log: (line) => logs.push(line),
    spoolDir: dir,
    disableStartupFlush: true,
    fetchImpl,
  });
  return {
    dir, runtime, posts, attemptedRoutes, logs,
    hostReads: () => hostReads,
    modelReads: () => modelReads,
    setMode: (value: typeof mode) => { mode = value; },
    setPolicy: (value: boolean) => { maskSecrets = value; version += 1; },
    setSnapshot: (value: unknown[]) => { snapshot = value; },
    async emit(value: unknown) {
      bus.publish(value);
      await new Promise<void>((resolve) => setImmediate(resolve));
      await runtime.awaitIdle?.();
    },
  };
}

describe("OpenCode 原文擷取", () => {
  it("未啟用與明確關閉都不讀宿主訊息或服務", async () => {
    for (const options of [{}, { digestEnabled: false }, { digestEnabled: true, captureEnabled: false }]) {
      const harness = await setup({ options });
      await harness.emit(terminal());
      expect(harness.hostReads()).toBe(0);
      expect(harness.attemptedRoutes).toEqual([]);
      expect(harness.modelReads()).toBe(0);
      expect(await fs.readdir(harness.dir)).toEqual([]);
      await harness.runtime();
    }
  });

  it("從舊設定遷移；多訊息、Unicode、空白、程式碼與中尾段逐字保存；零生成呼叫", async () => {
    const text = "  開始😀\r\n" + "中段程式碼 \t ".repeat(1500) + "\r\n`const 後段 = '原文';`  ";
    const snapshot = [
      { id: "old-u", type: "user", text: "上一輪", time: { created: 10 } },
      { id: "old-a", type: "assistant", content: [{ type: "text", text: "上一輪答覆" }], finish: "stop", time: { created: 20 } },
      { id: "u", type: "user", text: " 好\r\n", time: { created: 1000 } },
      { id: "system", type: "system", role: "user", text: "不要擷取的系統訊息" },
      { id: "injected", type: "synthetic", text: "<memory-context>注入記憶</memory-context>" },
      { id: "a0", type: "assistant", content: [{ type: "text", text: "先檢查  " }, { type: "reasoning", text: "隱藏推理" }, { type: "tool", text: "工具輸出" }], finish: "tool-calls" },
      { id: "u1", type: "user", text: "接著看尾段" },
      { id: "a1", type: "assistant", content: [
        { type: "text", text: text.slice(0, 1600) },
        { type: "image", text: "媒體附件" },
        { type: "text", text: text.slice(1600) + "<memory-context>助理回顯</memory-context>" },
      ], time: { created: 5000, completed: 7000 } },
      { id: "future", type: "user", text: "下一輪", time: { created: 10000 } },
    ];
    const harness = await setup({ options: { digestEnabled: true, digestModel: "invalid" }, snapshot });
    await harness.emit(terminal());
    expect(harness.posts).toHaveLength(1);
    expect(harness.posts[0]).toMatchObject({
      agent: "opencode-plugin/raw-turn", scope: "project", project: "synthetic-repo", sourceSession: "s1", sourceTurn: "e1",
      messages: [
        { sourceMessage: "u", role: "user", content: " 好\r\n", occurredAt: new Date(1000).toISOString() },
        { sourceMessage: "a0", role: "assistant", content: "先檢查  ", occurredAt: null },
        { sourceMessage: "u1", role: "user", content: "接著看尾段", occurredAt: null },
        { sourceMessage: "a1", role: "assistant", content: text, occurredAt: new Date(5000).toISOString() },
      ],
    });
    expect(harness.modelReads()).toBe(0);
    expect(harness.attemptedRoutes).toEqual(["/memory-policy", "/memory-sources"]);
    expect(await fs.readdir(harness.dir)).toEqual([]);
    await harness.runtime();
  });

  it("舊服務、HTML 及超限明確留存；重啟、切換政策與重新收到修改過的事件都保留第一份 payload", async () => {
    const value = "Q".repeat(36);
    const harness = await setup({
      options: { captureEnabled: true },
      snapshot: [{ id: "u", type: "user", text: `Bearer ${value}\n${"原文".repeat(6000)}` }],
    });
    harness.setMode("old");
    await harness.emit(terminal());
    expect(harness.posts).toEqual([]);
    const files = await fs.readdir(harness.dir);
    expect(files).toHaveLength(1);
    const spooledText = await fs.readFile(path.join(harness.dir, files[0]!), "utf8");
    expect(spooledText).not.toContain(value);
    expect(spooledText).toContain("[REDACTED:bearer]");
    expect(harness.logs.join("\n")).toContain("upgrade-required");
    await harness.runtime();

    const restarted = await setup({ options: { captureEnabled: true }, dir: harness.dir });
    restarted.setPolicy(false);
    restarted.setSnapshot([{ id: "u", type: "user", text: "後來的修改" }]);
    restarted.setMode("html");
    await restarted.emit(terminal());
    expect(restarted.posts[0]).toEqual(JSON.parse(spooledText).payload);
    expect(restarted.logs.join("\n")).toContain("upgrade-required");
    restarted.setMode("oversize");
    await restarted.runtime.flushCapture?.();
    expect(restarted.logs.join("\n")).toContain("source-too-large");
    expect(await fs.readdir(harness.dir)).toEqual(files);
    restarted.setMode("conflict");
    await restarted.runtime.flushCapture?.();
    expect(restarted.logs.join("\n")).toContain("source-conflict");
    expect(await fs.readdir(harness.dir)).toEqual(files);
    restarted.setMode("normal");
    await restarted.runtime.flushCapture?.();
    expect(restarted.posts).toHaveLength(4);
    expect(restarted.posts.every((body) => JSON.stringify(body) === JSON.stringify(restarted.posts[0]))).toBe(true);
    expect(await fs.readdir(harness.dir)).toEqual([]);
    await restarted.runtime();
  });

  it("無事件 id 時以回合首則 ID 決定重送，未知時間與缺少助理 ID 保持穩定", async () => {
    const harness = await setup({ options: { captureEnabled: true } });
    const event = { type: "session.execution.succeeded", data: { sessionID: "s1" } };
    await harness.emit(event);
    await harness.emit(event);
    expect(harness.posts).toHaveLength(2);
    expect(harness.posts[0]).toEqual(harness.posts[1]);
    expect(harness.posts[0]?.sourceTurn).toContain("u1");
    expect(harness.posts[0]?.messages[1]).toMatchObject({
      sourceMessage: "visible:assistant:1", occurredAt: null,
    });
    expect(harness.logs.join("\n")).toContain('"duplicate":true');
    await harness.runtime();
  });

  it("排除其他工作目錄、subagent、失敗、關機與 superseded 事件", async () => {
    for (const input of [{ directory: path.dirname(location) }, { parentID: "parent" }]) {
      const harness = await setup({ options: { captureEnabled: true }, ...input });
      await harness.emit(terminal());
      expect(harness.posts).toEqual([]);
      await harness.runtime();
    }
    const harness = await setup({ options: { captureEnabled: true, captureOnInterrupted: true } });
    await harness.emit(terminal("e1", 9000, "failed"));
    await harness.emit(terminal("e2", 9100, "interrupted", "shutdown"));
    await harness.emit(terminal("e3", 9200, "interrupted", "superseded"));
    expect(harness.hostReads()).toBe(0);
    expect(harness.posts).toEqual([]);
    await harness.runtime();
  });
});
