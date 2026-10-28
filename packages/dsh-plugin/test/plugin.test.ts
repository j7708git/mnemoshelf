import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRuntime } from "../src/index.js";
import type {
  MessageLike,
  PluginContextLike,
  PreStepDecisionLike,
  PreStepPayloadLike,
  RuntimeDeps,
} from "../src/types.js";

const USER_TEXT = "使用者這次明確要求把召回 timeout 固定成八百毫秒，並且把 k 上限設為四。";
const ASSISTANT_TEXT = "收到，會照這個契約實作，召回失敗時 fail-open 不影響回覆。";
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

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("waitFor timeout");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("召回注入", () => {
  it("pre-step 追加一則 user/message，帶 source kind／form 與區塊", async () => {
    const calls: RecordedCall[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(url),
        body: init?.body === undefined ? null : JSON.parse(String(init.body)),
      });
      return jsonResponse({
        hits: [{ id: 1, content: "使用者偏好深色模式", kind: "fact", createdAt: "2026-10-20" }],
        degraded: false,
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
    expect(calls[0]?.body).toMatchObject({ project: "mnemoshelf", k: 4, minScore: 0.65 });
  });

  it("空召回不注入，decision 原樣回傳", async () => {
    const fetchImpl = (async () => jsonResponse({ hits: [], degraded: false })) as typeof fetch;
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
    const fetchImpl = (async () =>
      jsonResponse({
        hits: [{ id: 1, content: "關鍵字補位", kind: "fact", createdAt: "2026-10-20" }],
        degraded: true,
      })) as typeof fetch;
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
    expect(hasLog("recall-skip", "network")).toBe(true);
  });
});

describe("回合寫入", () => {
  function writeFetch(calls: RecordedCall[], response: () => Response = () => jsonResponse({ id: 1 }, 201)) {
    return (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(url),
        body: init?.body === undefined ? null : JSON.parse(String(init.body)),
      });
      return response();
    }) as typeof fetch;
  }

  async function endTurn(
    invoke: (event: string, ...args: unknown[]) => Promise<unknown>,
    input: { user: string; assistant: string; turn?: number },
  ): Promise<void> {
    await invoke("agent/created", { agent: { session: { id: SESSION_ID } } });
    await invoke("session/event", { id: SESSION_ID }, { type: "turn/start", data: { turn: input.turn ?? 1 } });
    await invoke(
      "session/event",
      { id: SESSION_ID },
      {
        type: "user/message",
        data: { id: "u1", content: [{ type: "text", text: input.user }], source: { kind: "user" } },
      },
    );
    await invoke(
      "session/event",
      { id: SESSION_ID },
      {
        type: "assistant/message",
        data: { turn: input.turn ?? 1, step: 1, message: { content: [{ type: "text", text: input.assistant }] } },
      },
    );
    await invoke("session/event", { id: SESSION_ID }, { type: "turn/end", data: { turn: input.turn ?? 1, reason: { kind: "completed" } } });
  }

  it("寫一張 dsh/turn 卡，欄位與內容正確、不含注入塊", async () => {
    const calls: RecordedCall[] = [];
    const { ctx, invoke } = createCtx();
    createRuntime(ctx, { project: "mnemoshelf" }, deps({ fetchImpl: writeFetch(calls) }));
    await endTurn(invoke, { user: USER_TEXT, assistant: ASSISTANT_TEXT });

    await waitFor(() => calls.some((call) => call.url.endsWith("/memories")));
    await waitFor(() => hasLog("write-ok"));
    const write = calls.find((call) => call.url.endsWith("/memories"));
    expect(write?.body).toMatchObject({
      kind: "fact",
      scope: "project",
      project: "mnemoshelf",
      agent: "dsh/turn",
      sourceSession: SESSION_ID,
      sourceMessage: "1",
    });
    const content = String(write?.body?.content);
    expect(content).toBe(`User: ${USER_TEXT}\nAssistant: ${ASSISTANT_TEXT}`);
    expect(content).not.toContain("memory-context");
    expect(hasLog("write-ok")).toBe(true);
  });

  it("注入塊不進卡片：長注入塊＋短真人輸入 → 不寫", async () => {
    const calls: RecordedCall[] = [];
    const { ctx, invoke } = createCtx();
    createRuntime(ctx, {}, deps({ fetchImpl: writeFetch(calls) }));
    const dirtyUser = `好\n<memory-context source="mnemoshelf" trust="untrusted">\n${"舊記憶。".repeat(100)}\n</memory-context>`;
    await endTurn(invoke, { user: dirtyUser, assistant: ASSISTANT_TEXT });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(calls.filter((call) => call.url.endsWith("/memories"))).toHaveLength(0);
    expect(hasLog("turn-skip", "short")).toBe(true);
  });

  it("短回合（<40 字元）不寫、不報錯", async () => {
    const calls: RecordedCall[] = [];
    const { ctx, invoke } = createCtx();
    createRuntime(ctx, {}, deps({ fetchImpl: writeFetch(calls) }));
    await endTurn(invoke, { user: "太短了", assistant: ASSISTANT_TEXT });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(calls.filter((call) => call.url.endsWith("/memories"))).toHaveLength(0);
    expect(hasLog("turn-skip", "short")).toBe(true);
  });

  it("沒有助手的空白回覆不寫", async () => {
    const calls: RecordedCall[] = [];
    const { ctx, invoke } = createCtx();
    createRuntime(ctx, {}, deps({ fetchImpl: writeFetch(calls) }));
    await endTurn(invoke, { user: USER_TEXT, assistant: "" });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(calls.filter((call) => call.url.endsWith("/memories"))).toHaveLength(0);
    expect(hasLog("turn-skip", "no-assistant")).toBe(true);
  });

  it("別人的 session 事件不進緩衝、不寫卡", async () => {
    const calls: RecordedCall[] = [];
    const { ctx, invoke } = createCtx();
    createRuntime(ctx, {}, deps({ fetchImpl: writeFetch(calls) }));
    await invoke("agent/created", { agent: { session: { id: SESSION_ID } } });
    await invoke("session/event", { id: "foreign" }, { type: "turn/start", data: { turn: 1 } });
    await invoke(
      "session/event",
      { id: "foreign" },
      {
        type: "user/message",
        data: { content: [{ type: "text", text: "FOREIGN" }], source: { kind: "user" } },
      },
    );
    await invoke("session/event", { id: "foreign" }, { type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(calls).toHaveLength(0);
  });

  it("duplicate 回應視為成功，不進 spool", async () => {
    const calls: RecordedCall[] = [];
    const { ctx, invoke } = createCtx();
    createRuntime(
      ctx,
      {},
      deps({ fetchImpl: writeFetch(calls, () => jsonResponse({ duplicate: true }, 200)) }),
    );
    await endTurn(invoke, { user: USER_TEXT, assistant: ASSISTANT_TEXT });
    await waitFor(() => calls.length > 0);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(await readdir(path.join(dir, "spool")).catch(() => [])).toEqual([]);
    expect(hasLog("write-ok")).toBe(true);
  });

  it("寫入失敗進 spool；恢復後 flush 補送並刪除", async () => {
    const calls: RecordedCall[] = [];
    let failing = true;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(url),
        body: init?.body === undefined ? null : JSON.parse(String(init.body)),
      });
      return failing ? jsonResponse({}, 503) : jsonResponse({ id: 1, duplicate: false }, 201);
    }) as typeof fetch;

    const { ctx, invoke } = createCtx();
    const runtime = createRuntime(ctx, { project: "mnemoshelf" }, deps({ fetchImpl }));
    await endTurn(invoke, { user: USER_TEXT, assistant: ASSISTANT_TEXT });
    await waitFor(() => hasLog("write-spooled"));

    const files = await readdir(path.join(dir, "spool"));
    expect(files).toHaveLength(1);
    expect(hasLog("spool-write")).toBe(true);

    failing = false;
    await runtime.flush();
    expect(await readdir(path.join(dir, "spool"))).toEqual([]);
    expect(hasLog("spool-flush")).toBe(true);
  });

  it("服務停止（pid-dead／連線失敗）時不讓回合失敗，spool 留檔", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    const { ctx, invoke } = createCtx();
    createRuntime(ctx, {}, deps({ fetchImpl }));
    await endTurn(invoke, { user: USER_TEXT, assistant: ASSISTANT_TEXT });
    await waitFor(() => hasLog("write-spooled"));
    expect(await readdir(path.join(dir, "spool"))).toHaveLength(1);
  });

  it("runtime.json 被正常關閉刪除、但資料目錄還在 → 仍進 spool", async () => {
    const home = path.join(dir, "home");
    await mkdir(path.join(home, ".config", "Mnemoshelf", "data"), { recursive: true });
    const { ctx, invoke } = createCtx();
    createRuntime(
      ctx,
      { project: "mnemoshelf" },
      deps({
        env: {},
        home,
        fetchImpl: (async () => {
          throw new Error("should not call");
        }) as typeof fetch,
      }),
    );
    await endTurn(invoke, { user: USER_TEXT, assistant: ASSISTANT_TEXT });
    await waitFor(() => hasLog("write-spooled"));
    expect(await readdir(path.join(dir, "spool"))).toHaveLength(1);
  });
});
