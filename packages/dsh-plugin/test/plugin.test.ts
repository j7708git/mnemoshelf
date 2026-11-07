import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRuntime } from "../src/index.js";
import type { SourceWriteRequest } from "../src/raw-memory.js";
import type {
  MessageLike,
  PluginContextLike,
  PreStepDecisionLike,
  PreStepPayloadLike,
  RuntimeDeps,
} from "../src/types.js";

const SESSION_ID = "session-abc";

interface RecordedCall {
  url: string;
  body: Record<string, unknown> | null;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function human(text: string): MessageLike {
  return {
    id: "m-user",
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: "user" },
  };
}

function createCtx(): {
  ctx: PluginContextLike;
  invoke: (event: string, ...args: unknown[]) => Promise<unknown>;
  count: (event: string) => number;
} {
  const handlers = new Map<string, Array<(...args: never[]) => unknown>>();
  return {
    ctx: {
      on(event: string, listener: (...args: never[]) => unknown) {
        const list = handlers.get(event) ?? [];
        list.push(listener);
        handlers.set(event, list);
        return undefined;
      },
    },
    async invoke(event: string, ...args: unknown[]) {
      const list = handlers.get(event) ?? [];
      const fn = list.at(-1);
      if (fn === undefined) throw new Error(`no handler for ${event}`);
      return await (fn as unknown as (...inner: unknown[]) => unknown)(...args);
    },
    count(event: string) {
      return handlers.get(event)?.length ?? 0;
    },
  };
}

function preStepPayload(messages: MessageLike[], step = 1): PreStepPayloadLike {
  return {
    agent: { session: { id: SESSION_ID } },
    messages,
    turn: 1,
    step,
    signal: new AbortController().signal,
  };
}

const enter = (messages: MessageLike[]): PreStepDecisionLike => ({ kind: "enter", messages });

let dir = "";
let logs: Array<{ event: string; fields?: Record<string, unknown> }> = [];

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "mnemoshelf-dsh-plugin-test-"));
  logs = [];
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function deps(overrides: Partial<RuntimeDeps> = {}): RuntimeDeps {
  return {
    env: { MNEMOSHELF_URL: "http://127.0.0.1:9999", MNEMOSHELF_TOKEN: "test-token" },
    home: dir,
    cwd: path.join(dir, "repo"),
    spoolDir: path.join(dir, "spool"),
    disableStartupFlush: true,
    now: () => new Date("2026-10-28T10:00:00.000Z"),
    log: (event, fields) => {
      logs.push({ event, ...(fields === undefined ? {} : { fields }) });
    },
    ...overrides,
  };
}

function hasLog(event: string, reason?: string): boolean {
  return logs.some(
    (entry) =>
      entry.event === event && (reason === undefined || entry.fields?.reason === reason),
  );
}

describe("召回注入", () => {
  it("pre-step 追加一則 user/message，帶 source kind／form 與區塊", async () => {
    const calls: RecordedCall[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/memory-policy")) return jsonResponse({ maskSecrets: true, version: 1 });
      calls.push({
        url: String(url),
        body: init?.body === undefined ? null : JSON.parse(String(init.body)),
      });
      return jsonResponse({
        hits: [{ id: 1, content: "使用者偏好深色模式", kind: "fact", createdAt: "2026-10-20" }],
        degraded: false,
        policyVersion: 1,
      });
    }) as typeof fetch;

    const { ctx, invoke } = createCtx();
    createRuntime(ctx, { project: "mnemoshelf" }, deps({ fetchImpl }));

    const payload = preStepPayload([human("我們之前說偏好什麼主題？")]);
    const result = (await invoke("agent/pre-step", payload, async () => enter(payload.messages))) as {
      kind: string;
      messages: MessageLike[];
    };

    expect(result.kind).toBe("enter");
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]).toBe(payload.messages[0]);
    const injected = result.messages[1] as MessageLike;
    expect(injected.role).toBe("user");
    expect(injected.source).toEqual({ kind: "mnemoshelf-recall", form: "recall" });
    const text = (injected.content as Array<{ text: string }>)[0].text;
    expect(text).toContain('<memory-context source="mnemoshelf"');
    expect(text).toContain('trust="untrusted"');
    expect(text).toContain('form="recall"');
    expect(text).toContain("使用者偏好深色模式");
    expect([...text].length).toBeLessThanOrEqual(900);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toMatchObject({ project: "mnemoshelf", k: 8, minScore: 0.65 });
  });

  it("空召回不注入，decision 原樣回傳", async () => {
    const fetchImpl: typeof fetch = async (url) => String(url).endsWith("/memory-policy")
      ? jsonResponse({ maskSecrets: true, version: 1 })
      : jsonResponse({ hits: [], degraded: false, policyVersion: 1 });
    const { ctx, invoke } = createCtx();
    createRuntime(ctx, {}, deps({ fetchImpl }));

    const payload = preStepPayload([human("今天天氣如何？")]);
    const result = (await invoke("agent/pre-step", payload, async () => enter(payload.messages))) as {
      messages: MessageLike[];
    };
    expect(result.messages).toHaveLength(1);
    expect(hasLog("recall-skip", "no-hits")).toBe(true);
  });

  it("degraded 不注入", async () => {
    const fetchImpl: typeof fetch = async (url) => String(url).endsWith("/memory-policy")
      ? jsonResponse({ maskSecrets: true, version: 1 })
      : jsonResponse({
        hits: [{ id: 1, content: "關鍵字補位", kind: "fact", createdAt: "2026-10-20" }],
        degraded: true,
        policyVersion: 1,
      });
    const { ctx, invoke } = createCtx();
    createRuntime(ctx, {}, deps({ fetchImpl }));

    const payload = preStepPayload([human("今天天氣如何？")]);
    const result = (await invoke("agent/pre-step", payload, async () => enter(payload.messages))) as {
      messages: MessageLike[];
    };
    expect(result.messages).toHaveLength(1);
    expect(hasLog("recall-skip", "degraded")).toBe(true);
  });

  it("沒有真人訊息、或不是第一步時不查服務", async () => {
    let count = 0;
    const fetchImpl = (async () => {
      count += 1;
      return jsonResponse({ hits: [], degraded: false });
    }) as typeof fetch;
    const { ctx, invoke } = createCtx();
    createRuntime(ctx, {}, deps({ fetchImpl }));

    const runtimeOnly: MessageLike[] = [
      {
        id: "m-runtime",
        role: "user",
        content: [{ type: "text", text: "runtime" }],
        source: { kind: "runtime-context" },
      },
    ];
    const first = (await invoke(
      "agent/pre-step",
      preStepPayload(runtimeOnly),
      async () => enter(runtimeOnly),
    )) as { messages: MessageLike[] };
    expect(first.messages).toHaveLength(1);

    const stepTwo = (await invoke(
      "agent/pre-step",
      preStepPayload([human("問題")], 2),
      async () => enter([human("問題")]),
    )) as { messages: MessageLike[] };
    expect(stepTwo.messages).toHaveLength(1);
    expect(count).toBe(0);
  });

  it("召回請求失敗時 fail-open，不拋錯", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    const { ctx, invoke } = createCtx();
    createRuntime(ctx, {}, deps({ fetchImpl }));

    const payload = preStepPayload([human("問題")]);
    const result = (await invoke("agent/pre-step", payload, async () => enter(payload.messages))) as {
      messages: MessageLike[];
    };
    expect(result.messages).toHaveLength(1);
    expect(hasLog("recall-skip", "policy-unavailable")).toBe(true);
  });
});

describe("原文回合寫入", () => {
  function writeStub(posts: SourceWriteRequest[]) {
    const urls: string[] = [];
    let state: "old" | "failed" | "ready" = "ready";
    const fetchImpl: typeof fetch = async (url, init) => {
      const route = new URL(String(url)).pathname;
      urls.push(route);
      if (route === "/memory-policy") return state === "old"
        ? new Response("not supported", { status: 404 })
        : jsonResponse({ maskSecrets: true, version: 1 });
      if (route !== "/memory-sources") throw new Error("unexpected route");
      const payload = JSON.parse(String(init?.body)) as SourceWriteRequest;
      posts.push(payload);
      if (state === "failed") return jsonResponse({}, 503);
      const duplicate = posts.slice(0, -1).some((previous) => JSON.stringify(previous) === JSON.stringify(payload));
      return jsonResponse({
        source: { ...payload, id: 1, createdAt: "2026-01-01T00:00:00.000Z", chunkVersion: "raw-v1", messageCount: payload.messages.length },
        saved: true, duplicate, policyVersion: 1, memoryIds: [1], redacted: false, redactedCount: 0,
      }, duplicate ? 200 : 201);
    };
    return { urls, fetchImpl, setState: (next: typeof state) => { state = next; } };
  }

  async function sendTurn(
    invoke: ReturnType<typeof createCtx>["invoke"],
    assistant: string,
    { reason = "completed", session = SESSION_ID, turn = 1 } = {},
  ) {
    const event = (type: string, data: Record<string, unknown>, time?: number) =>
      invoke("session/event", { id: session }, { type, time, data });
    await event("turn/start", { turn });
    await event("user/message", {
      id: "u1", content: [{ type: "text", text: " 不行\r\n" }], source: { kind: "user" },
    }, 2000);
    await event("user/message", {
      id: "recall", content: [{ type: "text", text: "不擷取的注入內容" }], source: { kind: "mnemoshelf-recall" },
    });
    await event("assistant/message", {
      turn, step: 1, message: { id: "a1", content: [
        { type: "text", text: "第一個可見步驟。" },
        { type: "tool", text: "工具結果不擷取" },
        { type: "reasoning", text: "隱藏推理" },
      ] },
    }, 3000);
    await event("user/message", { id: "u2", content: [{ type: "text", text: "再看中段" }], source: { kind: "user" } });
    await event("assistant/message", { turn: turn + 1, message: { id: "wrong-turn", content: "不擷取的異輪內容" } });
    await event("assistant/message", { turn, step: 2, message: {
      content: [{ type: "text", text: assistant + "<memory-context>回顯內容</memory-context>" }],
    } });
    await event("turn/end", { turn, reason: { kind: reason } });
  }

  it("完整有序保留短輸入、長中尾、程式碼、空白與原始時間；重播同一事件保持同 key", async () => {
    const posts: SourceWriteRequest[] = [];
    const { fetchImpl, urls } = writeStub(posts);
    const { ctx, invoke } = createCtx();
    const runtime = createRuntime(ctx, { project: "fixture" }, deps({ fetchImpl }));
    const content = "  開頭🏷️\r\n" + "`中段程式碼`\r\n".repeat(3000) + "\t尾段  ";
    await invoke("agent/created", { agent: { session: { id: SESSION_ID } } });
    await sendTurn(invoke, content);
    await runtime.awaitIdle();
    await sendTurn(invoke, content);
    await runtime.awaitIdle();
    expect(posts).toHaveLength(2);
    expect(posts[1]).toEqual(posts[0]);
    expect(posts[0]).toMatchObject({
      agent: "dsh/turn", scope: "project", project: "fixture", sourceSession: SESSION_ID, sourceTurn: "1",
      messages: [
        { sourceMessage: "u1", role: "user", content: " 不行\r\n", occurredAt: new Date(2000).toISOString() },
        { sourceMessage: "a1", role: "assistant", content: "第一個可見步驟。", occurredAt: new Date(3000).toISOString() },
        { sourceMessage: "u2", role: "user", content: "再看中段", occurredAt: null },
        { sourceMessage: "visible:assistant:3", role: "assistant", content, occurredAt: null },
      ],
    });
    expect(urls).toEqual(["/memory-policy", "/memory-sources", "/memory-policy", "/memory-sources"]);
    expect(await readdir(path.join(dir, "spool"))).toEqual([]);
    runtime.dispose();
  });

  it("舊服務先保留並提示升級；服務恢復補送原文", async () => {
    const posts: SourceWriteRequest[] = [];
    const stub = writeStub(posts);
    const { ctx, invoke } = createCtx();
    const runtime = createRuntime(ctx, {}, deps({ fetchImpl: stub.fetchImpl }));
    stub.setState("old");
    await invoke("agent/created", { agent: { session: { id: SESSION_ID } } });
    await sendTurn(invoke, "原文尾巴");
    await runtime.awaitIdle();
    expect(posts).toEqual([]);
    expect(hasLog("spool-deferred", "upgrade-required")).toBe(true);
    expect(await readdir(path.join(dir, "spool"))).toHaveLength(1);
    stub.setState("ready");
    await runtime.flush();
    expect(posts[0]?.messages.at(-1)?.content).toBe("原文尾巴");
    expect(await readdir(path.join(dir, "spool"))).toEqual([]);
    runtime.dispose();
  });

  it("其他 session、不完整／失敗回合、關閉及未設定服務都不擷取", async () => {
    const posts: SourceWriteRequest[] = [];
    const { fetchImpl, urls } = writeStub(posts);
    const { ctx, invoke } = createCtx();
    const runtime = createRuntime(ctx, {}, deps({ fetchImpl }));
    await invoke("agent/created", { agent: { session: { id: SESSION_ID } } });
    await sendTurn(invoke, "不應送", { session: "foreign" });
    await sendTurn(invoke, "不應送", { reason: "error" });
    await invoke("session/event", { id: SESSION_ID }, { type: "turn/end", data: { turn: 5, reason: { kind: "completed" } } });
    await runtime.awaitIdle();
    expect(hasLog("turn-skip", "incomplete-turn")).toBe(true);
    expect(hasLog("turn-skip", "not-completed")).toBe(true);
    expect(urls).toEqual([]);
    runtime.dispose();

    for (const [config, env] of [[{ captureEnabled: false }, undefined], [{}, {}]] as const) {
      const disabled = createCtx();
      const result = createRuntime(disabled.ctx, config, deps({ fetchImpl, ...(env ? { env } : {}) }));
      await disabled.invoke("agent/created", { agent: { session: { id: SESSION_ID } } });
      await sendTurn(disabled.invoke, "不應送");
      await result.awaitIdle();
      await result.flush();
      expect(urls).toEqual([]);
      result.dispose();
    }
    expect(hasLog("write-disabled", "no-config")).toBe(true);
    await expect(readdir(path.join(dir, "spool"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
