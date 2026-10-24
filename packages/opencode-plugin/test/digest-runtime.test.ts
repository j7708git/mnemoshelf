/**
 * digest 的 runtime 整合測試：假事件 → 真 `createMemoryRuntime` → fetch stub 收 POST。
 *
 * 這裡刻意不用 mock 掉 digest 流程：事件、快照、排隊、模型呼叫、寫入與 `/memory` 狀態
 * 都走正式程式碼，只有宿主（`ctx`）與 HTTP 端點是替身。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createMemoryRuntime, type RuntimeCleanup, type RuntimeDeps } from "../src/recall.js";
import { formatDay } from "../src/digest.js";
import type {
  CommandEditorLike,
  CommandInvocationLike,
  ModelDomainLike,
  ModelInfoLike,
  PluginContextLike,
  StorageLike,
} from "../src/types.js";

const LOCATION = "/work/mnemoshelf";
const ENV = {
  MNEMOSHELF_URL: "http://127.0.0.1:43117",
  MNEMOSHELF_TOKEN: "test-token-value",
};
const CHEAP_MODEL = "cheap/test-model";

/** 每個測試自己的 digest 診斷紀錄檔（不要寫進真正的家目錄）。 */
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

/** 假宿主的可用模型清單（`providerID` + `id` 與 `CHEAP_MODEL` 相符）。 */
const AVAILABLE_MODELS: readonly ModelInfoLike[] = [
  { id: "test-model", modelID: "test-model", providerID: "cheap" },
];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function tick(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function text(value: string): unknown {
  return { type: "text", text: value };
}

function user(id: string, value: string): unknown {
  return { id, type: "user", time: { created: 0 }, text: value };
}

function assistant(id: string, ...parts: unknown[]): unknown {
  return { id, type: "assistant", time: { created: 0 }, content: parts };
}

function succeeded(sessionID = "s1"): unknown {
  return { id: `evt-${sessionID}-${Math.random()}`, type: "session.execution.succeeded", data: { sessionID } };
}

function interrupted(sessionID = "s1", reason = "user"): unknown {
  return {
    id: `evt-${sessionID}-${Math.random()}`,
    type: "session.execution.interrupted",
    data: { sessionID, reason },
  };
}

class EventFeed {
  private items: unknown[] = [];
  private resolver: ((result: IteratorResult<unknown>) => void) | undefined;

  push(value: unknown): void {
    if (this.resolver !== undefined) {
      const resolve = this.resolver;
      this.resolver = undefined;
      resolve({ value, done: false });
      return;
    }
    this.items.push(value);
  }

  async *stream(): AsyncGenerator<unknown, void, void> {
    for (;;) {
      if (this.items.length > 0) {
        yield this.items.shift();
        continue;
      }
      const next = await new Promise<IteratorResult<unknown>>((resolve) => {
        this.resolver = resolve;
      });
      if (next.done === true) return;
      yield next.value;
    }
  }
}

function memoryStorage(): StorageLike & { map: Map<string, unknown> } {
  const map = new Map<string, unknown>();
  return {
    map,
    get: async (key) => map.get(key),
    set: async (key, value) => {
      map.set(key, value);
    },
    remove: async (key) => {
      map.delete(key);
    },
    scan: async ({ prefix, after, limit }) => {
      const keys = [...map.keys()].filter((key) => key.startsWith(prefix)).sort();
      const start = after === undefined ? 0 : keys.indexOf(after) + 1;
      const size = limit ?? 100;
      const page = keys.slice(start, start + size);
      const next = keys[start + page.length];
      return {
        entries: page.map((key) => ({ key, value: map.get(key) })),
        ...(next === undefined ? {} : { next }),
      };
    },
  };
}

interface CapturedCommand {
  name: string;
  execute: (input: CommandInvocationLike) => Promise<void>;
}

interface Harness {
  cleanup: RuntimeCleanup;
  logs: string[];
  /** 收攏 `POST /memories` 的請求（假 DB 的寫入紀錄）。 */
  posts: { body: Record<string, unknown>; attempt: number }[];
  generateCalls: { prompt: string; model: unknown }[];
  storage: ReturnType<typeof memoryStorage>;
  messages: Map<string, unknown[]>;
  info: Map<string, unknown>;
  synthetic: { sessionID: string; text: string }[];
  /** `ctx.model.list()` 被呼叫的次數（啟動期驗證只該打一次）。 */
  modelListCalls: { value: number };
  /** digest 診斷紀錄檔（每個測試獨立）。 */
  logFile: string;
  /** 讀診斷紀錄的每一行（檔案不存在或讀不到回空陣列）。 */
  readLog: () => Promise<string[]>;
  generate: (input: { prompt: string; model?: unknown }) => Promise<{ text: string }>;
  postMemory: (body: Record<string, unknown>, attempt: number) => Response | Promise<Response>;
  setTurn: (messages: unknown[], sessionID?: string) => void;
  setInfo: (info: unknown, sessionID?: string) => void;
  dispatch: (event: unknown) => Promise<void>;
  settle: (event: unknown) => Promise<void>;
  status: () => Promise<string>;
}

async function setup(input: {
  settings?: Record<string, unknown>;
  env?: Record<string, string>;
  storage?: ReturnType<typeof memoryStorage>;
  withoutEventApi?: boolean;
  extraDeps?: Partial<RuntimeDeps>;
  /** 這個 plugin 實例的 location 目錄（預設一般專案 `LOCATION`）。 */
  location?: string;
  /**
   * 假宿主的可用模型清單：
   * - 省略＝`AVAILABLE_MODELS`（`digestModel` 合法）
   * - 傳陣列＝自訂清單
   * - 傳函式＝自訂回應（可丟錯，模擬 `ctx.model.list()` 失敗）
   * - `null`＝宿主沒有 `ctx.model`
   */
  models?: readonly ModelInfoLike[] | null | (() => Promise<unknown>);
  /** 宿主沒有 `ctx.generate`（模擬「不支援 generate」的宿主）。 */
  withoutGenerate?: boolean;
} = {}): Promise<Harness> {
  const logs: string[] = [];
  const posts: Harness["posts"] = [];
  const generateCalls: Harness["generateCalls"] = [];
  const synthetic: Harness["synthetic"] = [];
  const messages = new Map<string, unknown[]>();
  const info = new Map<string, unknown>();
  const modelListCalls = { value: 0 };
  const feed = new EventFeed();
  const commands = new Map<string, CapturedCommand>();
  const storage = input.storage ?? memoryStorage();
  const location = input.location ?? LOCATION;
  const logDir = await fs.mkdtemp(path.join(os.tmpdir(), "mnemoshelf-digest-"));
  tempDirs.push(logDir);
  const logFile = input.extraDeps?.digestLogFile ?? path.join(logDir, "digest.log");

  const harness = {
    logs,
    posts,
    generateCalls,
    storage,
    messages,
    info,
    synthetic,
    modelListCalls,
    logFile,
  } as unknown as Harness;

  harness.generate = async () => ({ text: '{"items":[]}' });
  harness.postMemory = async () => jsonResponse({ id: 1, duplicate: false }, 201);

  const fetchImpl: typeof fetch = async (request, init) => {
    const url = String(request);
    if (url.endsWith("/memories/search")) return jsonResponse({ hits: [] });
    if (url.endsWith("/memories")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      const attempt = posts.filter((post) => post.body.sourceMessage === body.sourceMessage).length + 1;
      posts.push({ body, attempt });
      return harness.postMemory(body, attempt);
    }
    return jsonResponse({}, 404);
  };

  const ctx: PluginContextLike = {
    app: { version: "2.1.1" },
    options: input.settings ?? {},
    location: { directory: location, project: { canonical: location, directory: location } },
    session: {
      hook: async () => ({ dispose: async () => undefined }),
      synthetic: async (payload) => {
        synthetic.push(payload);
        return {};
      },
      get: async ({ sessionID }) => info.get(sessionID) ?? { location: { directory: location } },
      context: async ({ sessionID }) => messages.get(sessionID) ?? [],
    },
    command: {
      transform: async (callback: (editor: CommandEditorLike) => void) => {
        callback({
          add: (definition) => {
            commands.set(definition.name, definition);
          },
        });
        return { dispose: async () => undefined };
      },
    },
    ...(input.withoutGenerate === true
      ? {}
      : {
          generate: {
            text: async (payload) => {
              generateCalls.push({ prompt: payload.prompt, model: payload.model });
              return harness.generate(payload);
            },
          },
        }),
    ...(input.models === null
      ? {}
      : {
          model: {
            list: async () => {
              modelListCalls.value += 1;
              const models = input.models;
              if (typeof models === "function") {
                return (await models()) as { data?: readonly ModelInfoLike[] };
              }
              return { data: models ?? AVAILABLE_MODELS };
            },
          } satisfies ModelDomainLike,
        }),
    storage,
    ...(input.withoutEventApi === true ? {} : { event: { subscribe: () => feed.stream() } }),
  };

  const cleanup = await createMemoryRuntime(ctx, {
    env: input.env ?? ENV,
    platform: "linux",
    log: (line) => logs.push(line),
    fetchImpl,
    readFileImpl: async () => {
      throw new Error("ENOENT");
    },
    connectionWaitMs: 100,
    digestLogFile: logFile,
    ...input.extraDeps,
  });
  // 等背景連線解析完成（env 來源只需要 microtask）。
  await tick();

  harness.cleanup = cleanup;
  harness.setTurn = (turn, sessionID = "s1") => {
    messages.set(sessionID, turn);
  };
  harness.setInfo = (value, sessionID = "s1") => {
    info.set(sessionID, value);
  };
  harness.dispatch = async (event) => {
    feed.push(event);
    await tick();
  };
  harness.settle = async (event) => {
    feed.push(event);
    await tick();
    await cleanup.awaitIdle?.();
    // 等 fire-and-forget 的 storage 寫入落地。
    await tick();
  };
  harness.status = async () => {
    await commands.get("memory")?.execute({ sessionID: "s1", prompt: { text: "" } });
    return synthetic.at(-1)?.text ?? "";
  };
  harness.readLog = async () => {
    try {
      const text = await fs.readFile(logFile, "utf8");
      return text.split("\n").filter((line) => line !== "");
    } catch {
      return [];
    }
  };
  return harness;
}

const TURN1_USER = "第一回合：請說明為什麼要把 digest 設成預設關閉，並列出兩個具體理由。";
const TURN1_ASSISTANT =
  "理由一，避免把對話在未經允許時送給另一個模型；理由二，每回合抽取的成本會隨對話長度成長。";
const TURN2_USER = "第二回合：請說明 digest 的去重鍵長什麼樣子，以及為什麼要這樣設計。";
const TURN2_ASSISTANT = "去重鍵是 digest:<sessionID>:<assistantMessageID>，寫入成功才設定，避免重複寫入。";
const TURN3_USER = "第三回合：請說明 interrupted 的預設行為是什麼，以及什麼時候應該開啟它。";
const TURN3_ASSISTANT = "interrupted 預設跳過，關機造成的也跳過；只有在想保留部分成果時才開啟。";

function threeTurns(): unknown[] {
  return [
    user("u1", TURN1_USER),
    assistant("a1", text(TURN1_ASSISTANT)),
    user("u2", TURN2_USER),
    assistant("a2", text(TURN2_ASSISTANT)),
    user("u3", TURN3_USER),
    assistant("a3", text(TURN3_ASSISTANT)),
  ];
}

function digestSettings(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { digestEnabled: true, digestModel: CHEAP_MODEL, ...overrides };
}

function itemsFor(content: string, quote: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ items: [{ content, kind: "decision", quote, ...extra }] });
}

describe("digest：回合寫入", () => {
  it("回合結束後寫入卡片，來源欄位正確，且同事件重送不重複", async () => {
    const harness = await setup({ settings: digestSettings() });
    harness.setTurn([user("u1", TURN1_USER), assistant("a1", text(TURN1_ASSISTANT))]);
    harness.generate = async () =>
      ({
        text: itemsFor("digest 預設關閉，避免未經允許的模型呼叫。", "為什麼要把 digest 設成預設關閉"),
      }) as { text: string };

    await harness.settle(succeeded());

    expect(harness.posts).toHaveLength(1);
    expect(harness.posts[0].body).toMatchObject({
      content: "digest 預設關閉，避免未經允許的模型呼叫。",
      kind: "decision",
      scope: "project",
      project: "mnemoshelf",
      agent: "opencode-plugin",
      sourceSession: "s1",
      sourceMessage: "a1",
    });
    expect(harness.generateCalls).toHaveLength(1);
    expect(harness.generateCalls[0].model).toEqual({ providerID: "cheap", id: "test-model" });

    // 同一事件重送：去重鍵已寫入 → 不再呼叫模型、不再寫入。
    await harness.settle(succeeded());
    expect(harness.generateCalls).toHaveLength(1);
    expect(harness.posts).toHaveLength(1);
    expect(harness.logs.join("\n")).toContain('"reason":"already"');
  });

  it("去重狀態存在 ctx.storage：新 runtime 也不會重寫同一回合", async () => {
    const storage = memoryStorage();
    const first = await setup({ settings: digestSettings(), storage });
    first.setTurn([user("u1", TURN1_USER), assistant("a1", text(TURN1_ASSISTANT))]);
    first.generate = async () => ({ text: itemsFor("卡片", "預設關閉") });
    await first.settle(succeeded());
    expect(first.posts).toHaveLength(1);
    await first.cleanup();

    const second = await setup({ settings: digestSettings(), storage });
    second.setTurn([user("u1", TURN1_USER), assistant("a1", text(TURN1_ASSISTANT))]);
    await second.settle(succeeded());
    expect(second.generateCalls).toHaveLength(0);
    expect(second.posts).toHaveLength(0);
    expect(second.logs.join("\n")).toContain('"reason":"already"');
  });

  it("並行邊界：上一回合未完成時下一回合結束，兩次寫入不互相污染", async () => {
    const harness = await setup({ settings: digestSettings() });
    let releaseFirst: (() => void) | undefined;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    harness.generate = async (input) => {
      if (input.prompt.includes("第一回合")) {
        await firstBlocked;
        return { text: itemsFor("第一回合的卡片", "為什麼要把 digest 設成預設關閉") };
      }
      return { text: itemsFor("第二回合的卡片", "去重鍵長什麼樣子") };
    };

    harness.setTurn([user("u1", TURN1_USER), assistant("a1", text(TURN1_ASSISTANT))]);
    await harness.dispatch(succeeded());

    // 第二回合結束（第一回合的模型呼叫仍卡住）；之後又冒出第三回合的訊息。
    harness.setTurn(threeTurns().slice(0, 4));
    await harness.dispatch(succeeded());
    harness.setTurn(threeTurns());

    releaseFirst?.();
    await harness.cleanup.awaitIdle?.();
    await tick();

    // 兩次寫入各自對應自己的回合，沒有第三回合（它的事件還沒來）。
    expect(harness.posts).toHaveLength(2);
    expect(harness.posts.map((post) => post.body.sourceMessage)).toEqual(["a1", "a2"]);
    expect(harness.posts.map((post) => post.body.content)).toEqual(["第一回合的卡片", "第二回合的卡片"]);

    // 串行：第二回合的模型呼叫必須等第一回合完成後才發生。
    expect(harness.generateCalls).toHaveLength(2);
    expect(harness.generateCalls[0].prompt).toContain("第一回合");
    expect(harness.generateCalls[0].prompt).not.toContain("第二回合");
    expect(harness.generateCalls[1].prompt).toContain("第二回合");
    expect(harness.generateCalls[1].prompt).not.toContain("第三回合");
  });

  it("fire-and-forget：模型失敗只記狀態，事件流與後續回合照常運作", async () => {
    const harness = await setup({ settings: digestSettings() });
    harness.setTurn([user("u1", TURN1_USER), assistant("a1", text(TURN1_ASSISTANT))]);
    let calls = 0;
    harness.generate = async () => {
      calls += 1;
      if (calls === 1) throw new Error("model exploded");
      return { text: itemsFor("後續回合仍可寫入", "去重鍵長什麼樣子") };
    };

    // 事件處理本身不得拋錯，也不得擋住訂閱。
    await expect(harness.settle(succeeded())).resolves.toBeUndefined();
    expect(harness.posts).toHaveLength(0);
    expect(harness.logs.join("\n")).toContain('"state":"failed"');

    harness.setTurn(threeTurns().slice(0, 4));
    await harness.settle(succeeded());
    expect(harness.posts).toHaveLength(1);
    expect(harness.posts[0].body.sourceMessage).toBe("a2");
  });
});

function turnOutput(turn: string, items: { content: string; kind: string; quote: string }[] = []): string {
  return JSON.stringify({ turn, items });
}

describe("digest：回合紀錄（episodic memory）", () => {
  it("成功回合先寫 1 張回合卡（agent／kind／來源欄位正確），再寫原子記憶", async () => {
    const harness = await setup({ settings: digestSettings() });
    harness.setTurn([user("u1", TURN1_USER), assistant("a1", text(TURN1_ASSISTANT))]);
    const turnText = "討論 digest 預設值；結論：關閉並用便宜模型；下一步：實測延遲。";
    harness.generate = async () => ({
      text: turnOutput(turnText, [
        { content: "digest 預設關閉，避免未經允許的模型呼叫。", kind: "decision", quote: "為什麼要把 digest 設成預設關閉" },
      ]),
    });

    await harness.settle(succeeded());

    expect(harness.posts).toHaveLength(2);
    expect(harness.posts[0].body).toMatchObject({
      content: turnText,
      kind: "fact",
      scope: "project",
      project: "mnemoshelf",
      agent: "opencode-plugin/turn",
      sourceSession: "s1",
      sourceMessage: "a1",
      force: true,
    });
    expect(harness.posts[1].body).toMatchObject({
      content: "digest 預設關閉，避免未經允許的模型呼叫。",
      kind: "decision",
      agent: "opencode-plugin",
      sourceSession: "s1",
      sourceMessage: "a1",
    });
    // 原子記憶仍走 server 去重（不帶 force）。
    expect(harness.posts[1].body).not.toHaveProperty("force");
    expect(harness.logs.join("\n")).toContain('"written":2');
  });

  it("turn 是空字串時不寫回合卡，只寫 items", async () => {
    const harness = await setup({ settings: digestSettings() });
    harness.setTurn([user("u1", TURN1_USER), assistant("a1", text(TURN1_ASSISTANT))]);
    harness.generate = async () => ({
      text: turnOutput("", [
        { content: "digest 預設關閉。", kind: "decision", quote: "為什麼要把 digest 設成預設關閉" },
      ]),
    });

    await harness.settle(succeeded());

    expect(harness.posts).toHaveLength(1);
    expect(harness.posts[0].body.agent).toBe("opencode-plugin");
    expect(harness.posts[0].body.kind).toBe("decision");
  });

  it("回合卡不套用去重：連續兩回合相同 turn 文字仍寫兩張（帶 force）", async () => {
    const harness = await setup({ settings: digestSettings() });
    const turnText = "討論同一個主題；結論相同；下一步相同。";
    harness.generate = async () => ({ text: turnOutput(turnText) });

    harness.setTurn(threeTurns().slice(0, 2));
    await harness.settle(succeeded());
    harness.setTurn(threeTurns().slice(0, 4));
    await harness.settle(succeeded());

    expect(harness.posts).toHaveLength(2);
    expect(harness.posts.map((post) => post.body.content)).toEqual([turnText, turnText]);
    expect(harness.posts.every((post) => post.body.agent === "opencode-plugin/turn")).toBe(true);
    expect(harness.posts.every((post) => post.body.force === true)).toBe(true);
    // 來源（assistant message id）各自正確，不是同一張卡重送。
    expect(harness.posts.map((post) => post.body.sourceMessage)).toEqual(["a1", "a2"]);
  });

  it("回合卡寫入失敗不影響 items", async () => {
    const harness = await setup({ settings: digestSettings() });
    harness.setTurn([user("u1", TURN1_USER), assistant("a1", text(TURN1_ASSISTANT))]);
    harness.generate = async () => ({
      text: turnOutput("討論主題；結論：照舊。", [
        { content: "digest 預設關閉。", kind: "decision", quote: "為什麼要把 digest 設成預設關閉" },
      ]),
    });
    harness.postMemory = async (body) => {
      if (body.agent === "opencode-plugin/turn") return jsonResponse({ error: "boom" }, 400);
      return jsonResponse({ id: 1, duplicate: false }, 201);
    };

    await harness.settle(succeeded());

    // 回合卡 400 不重試（1 次）＋ item 成功 1 次。
    expect(harness.posts).toHaveLength(2);
    expect(harness.posts[1].body.agent).toBe("opencode-plugin");
    expect(harness.logs.join("\n")).toContain('"written":1');
  });
});

describe("digest：聊天 session 的記憶歸屬（D4d）", () => {
  /** 模擬 OpenChamber 聊天 session 的 location（`…/openchamber/chats/<日期>/session-<uuid>`）。 */
  const CHAT_LOCATION = "/work/.config/openchamber/chats/2026-10-22/session-7a4cbf23-fe33-4fa1-8e10-f0be38497381";

  it("聊天 session 寫入 scope:global、不帶 project", async () => {
    const harness = await setup({ settings: digestSettings(), location: CHAT_LOCATION });
    harness.setTurn([user("u1", TURN1_USER), assistant("a1", text(TURN1_ASSISTANT))]);
    harness.generate = async () => ({ text: itemsFor("聊天寫入的記憶歸到 global。", "預設關閉") });

    await harness.settle(succeeded());

    expect(harness.posts).toHaveLength(1);
    const body = harness.posts[0].body;
    expect(body.scope).toBe("global");
    expect(body).not.toHaveProperty("project");
    expect(body).toMatchObject({
      kind: "decision",
      agent: "opencode-plugin",
      sourceSession: "s1",
      sourceMessage: "a1",
    });

    // 狀態文字要說明這是聊天 session 的 global 範圍（不是「未解析」）。
    const status = await harness.status();
    expect(status).toContain("OpenChamber 聊天 session");
    expect(status).toContain("global");
  });

  it("解析不到且不是聊天目錄：維持 fail closed（不呼叫模型、不寫入）", async () => {
    const harness = await setup({ settings: digestSettings(), location: "" });
    harness.setTurn([user("u1", TURN1_USER), assistant("a1", text(TURN1_ASSISTANT))]);
    harness.generate = async () => ({ text: itemsFor("不該寫入", "預設關閉") });

    await harness.settle(succeeded());

    expect(harness.generateCalls).toHaveLength(0);
    expect(harness.posts).toHaveLength(0);
    expect(harness.logs.join("\n")).toContain('"reason":"project-unresolved"');
  });
});

describe("digest：前置跳過（省錢）", () => {
  it("只有 synthetic 的 /memory 回合不呼叫模型（即使前面有真回合）", async () => {
    const harness = await setup({ settings: digestSettings() });
    harness.setTurn([
      user("u1", TURN1_USER),
      assistant("a1", text(TURN1_ASSISTANT)),
      { id: "s1", type: "synthetic", text: "[[mnemoshelf-status]] [mnemoshelf] 記憶外掛狀態", time: { created: 0 } },
      assistant("a2", text("（/memory 之後的助理回覆，不該被摘要。）")),
    ]);
    harness.generate = async () => ({ text: itemsFor("不該出現", "預設關閉") });
    await harness.settle(succeeded());
    expect(harness.generateCalls).toHaveLength(0);
    expect(harness.posts).toHaveLength(0);
    expect(harness.logs.join("\n")).toContain('"reason":"status-turn"');
  });

  it("短回話（<40 字）不呼叫模型", async () => {
    const harness = await setup({ settings: digestSettings() });
    harness.setTurn([user("u1", "好，照這樣做。"), assistant("a1", text("了解。"))]);
    await harness.settle(succeeded());
    expect(harness.generateCalls).toHaveLength(0);
    expect(harness.posts).toHaveLength(0);
    expect(harness.logs.join("\n")).toContain('"reason":"short"');
  });

  it("未設定 digestModel：跳過並在 /memory 標示", async () => {
    const harness = await setup({ settings: { digestEnabled: true } });
    harness.setTurn([user("u1", TURN1_USER), assistant("a1", text(TURN1_ASSISTANT))]);
    await harness.settle(succeeded());
    expect(harness.generateCalls).toHaveLength(0);
    expect(harness.logs.join("\n")).toContain('"state":"no-model"');
    const status = await harness.status();
    expect(status).toContain("已開啟但未指定模型");
    expect(status).toContain("最近摘要");
    expect(status).toContain("digestModel 未設定");
  });

  it("預設關閉：0 次模型呼叫，/memory 顯示關閉", async () => {
    const harness = await setup();
    harness.setTurn([user("u1", TURN1_USER), assistant("a1", text(TURN1_ASSISTANT))]);
    harness.generate = async () => ({ text: itemsFor("不該出現", "預設關閉") });
    await harness.settle(succeeded());
    expect(harness.generateCalls).toHaveLength(0);
    expect(harness.posts).toHaveLength(0);
    const status = await harness.status();
    expect(status).toContain("摘要：關閉");
    expect(status).not.toContain("摘要：開啟");
  });

  it("未連線時跳過（記一次 warning），不呼叫模型", async () => {
    const harness = await setup({ settings: digestSettings(), env: {} });
    harness.setTurn([user("u1", TURN1_USER), assistant("a1", text(TURN1_ASSISTANT))]);
    await harness.settle(succeeded());
    await harness.settle(succeeded());
    expect(harness.generateCalls).toHaveLength(0);
    expect(harness.logs.join("\n")).toContain('"state":"offline"');
  });
});

describe("digest：啟動期模型驗證", () => {
  it("digestModel 不存在：只驗證一次、每回合 0 次 generate、狀態 model-unavailable", async () => {
    const harness = await setup({ settings: digestSettings({ digestModel: "cheap/missing" }) });
    harness.setTurn([user("u1", TURN1_USER), assistant("a1", text(TURN1_ASSISTANT))]);
    harness.generate = async () => ({ text: itemsFor("不該出現", "預設關閉") });

    await harness.settle(succeeded());
    await harness.settle(succeeded());

    expect(harness.generateCalls).toHaveLength(0);
    expect(harness.posts).toHaveLength(0);
    // 模型清單只查一次（不是每回合查／每回合失敗一次）。
    expect(harness.modelListCalls.value).toBe(1);

    const log = harness.logs.join("\n");
    expect(log.match(/"state":"model-unavailable"/g) ?? []).toHaveLength(1);
    expect(log).toContain('"reason":"model-unavailable"');

    const status = await harness.status();
    expect(status).toContain("摘要：已開啟但模型不可用（cheap/missing");
    expect(status).toContain("digestModel 不存在或未啟用");
  });

  it("digestModel 存在：行為不變（照常呼叫模型並寫入）", async () => {
    const harness = await setup({ settings: digestSettings() });
    harness.setTurn([user("u1", TURN1_USER), assistant("a1", text(TURN1_ASSISTANT))]);
    harness.generate = async () => ({ text: itemsFor("驗證通過後照常寫入", "預設關閉") });

    await harness.settle(succeeded());

    expect(harness.modelListCalls.value).toBe(1);
    expect(harness.generateCalls).toHaveLength(1);
    expect(harness.posts).toHaveLength(1);
    const log = harness.logs.join("\n");
    expect(log).not.toContain("model-unavailable");
    expect(log).not.toContain("model-unchecked");
  });

  it("模型清單取不到：記一次 warning、退回不驗證，digest 照常運作", async () => {
    const harness = await setup({
      settings: digestSettings(),
      models: async () => {
        throw new Error("list is down");
      },
    });
    harness.setTurn([user("u1", TURN1_USER), assistant("a1", text(TURN1_ASSISTANT))]);
    harness.generate = async () => ({ text: itemsFor("清單取不到仍照舊", "預設關閉") });

    await harness.settle(succeeded());

    expect(harness.generateCalls).toHaveLength(1);
    expect(harness.posts).toHaveLength(1);
    const log = harness.logs.join("\n");
    expect(log.match(/"state":"model-unchecked"/g) ?? []).toHaveLength(1);
    expect(log).toContain('"reason":"list-error"');
    const status = await harness.status();
    expect(status).toContain("模型清單取不到，未驗證模型是否存在");
  });
});

describe("digest：注入塊與隱私", () => {
  it("注入塊內容不回存，也不進模型 prompt", async () => {
    const harness = await setup({ settings: digestSettings() });
    const injected = [
      '<memory-context source="mnemoshelf" trust="untrusted" project="mnemoshelf">',
      "- [decision][2026-10-18][0.82] 注入的機密卡片內容",
      "</memory-context>",
    ].join("\n");
    harness.setTurn([
      user("u1", `${TURN1_USER}\n${injected}`),
      assistant("a1", text(TURN1_ASSISTANT)),
    ]);
    harness.generate = async () => ({
      text: itemsFor("注入內容不該被寫入", "注入的機密卡片內容"),
    });
    await harness.settle(succeeded());
    expect(harness.posts).toHaveLength(0);
    expect(harness.generateCalls).toHaveLength(1);
    expect(harness.generateCalls[0].prompt).not.toContain("注入的機密卡片內容");
    expect(harness.logs.join("\n")).not.toContain("注入的機密卡片內容");
    // 模型仍可寫這一回合真正的內容。
    expect(harness.logs.join("\n")).toContain('"written":0');
  });

  it("送模型的內容不含工具輸出與檔案內容；log 不含內容與 token", async () => {
    const harness = await setup({ settings: digestSettings() });
    harness.setTurn([
      user("u1", `${TURN1_USER}\n<file name="secret.txt">FILE-CONTENT-SECRET</file>`),
      assistant(
        "a1",
        { type: "tool", id: "t1", name: "read", state: { output: "TOOL-OUTPUT-SECRET" } },
        text(TURN1_ASSISTANT),
      ),
    ]);
    harness.generate = async () => ({ text: itemsFor("卡片內容", "預設關閉") });
    await harness.settle(succeeded());

    const prompt = harness.generateCalls[0].prompt;
    expect(prompt).not.toContain("TOOL-OUTPUT-SECRET");
    expect(prompt).not.toContain("FILE-CONTENT-SECRET");
    expect(prompt).toContain("預設關閉");

    const log = harness.logs.join("\n");
    expect(log).not.toContain("測試內容");
    expect(log).not.toContain(TURN1_USER);
    expect(log).not.toContain("test-token-value");
    expect(log).not.toContain("卡片內容");
  });
});

describe("digest：失敗與邊界", () => {
  it("failed 事件、subagent、非本 location 都不寫", async () => {
    const harness = await setup({ settings: digestSettings() });
    harness.setTurn([user("u1", TURN1_USER), assistant("a1", text(TURN1_ASSISTANT))]);
    harness.generate = async () => ({ text: itemsFor("卡片", "預設關閉") });

    await harness.settle({ type: "session.execution.failed", data: { sessionID: "s1" } });
    harness.setInfo({ parentID: "parent-1", location: { directory: LOCATION } });
    await harness.settle(succeeded());
    harness.setInfo({ location: { directory: "/work/other-project" } });
    await harness.settle(succeeded());

    expect(harness.generateCalls).toHaveLength(0);
    expect(harness.posts).toHaveLength(0);
    const log = harness.logs.join("\n");
    expect(log).toContain('"reason":"subagent"');
    expect(log).toContain('"reason":"other-location"');
    // failed 事件完全不出現在 log（連 skip 都不記）。
    expect(log).not.toContain("failed");
  });

  it("interrupted 預設跳過；開啟後才補寫，且 shutdown 一律跳過", async () => {
    const off = await setup({ settings: digestSettings() });
    off.setTurn([user("u1", TURN1_USER), assistant("a1", text(TURN1_ASSISTANT))]);
    await off.settle(interrupted());
    expect(off.generateCalls).toHaveLength(0);

    const on = await setup({ settings: digestSettings({ digestOnInterrupted: true }) });
    on.setTurn([user("u1", TURN1_USER), assistant("a1", text(TURN1_ASSISTANT))]);
    on.generate = async () => ({ text: itemsFor("中斷前完成的內容", "預設關閉") });
    await on.settle(interrupted());
    expect(on.posts).toHaveLength(1);
    expect(on.posts[0].body.sourceMessage).toBe("a1");

    await on.settle(interrupted("s1", "shutdown"));
    expect(on.posts).toHaveLength(1);
  });

  it("模型回非 JSON：DB 0 筆、log 只有原因", async () => {
    const harness = await setup({ settings: digestSettings() });
    harness.setTurn([user("u1", TURN1_USER), assistant("a1", text(TURN1_ASSISTANT))]);
    harness.generate = async () => ({ text: "這不是 JSON，裡面有對話原文片段" });
    await harness.settle(succeeded());
    expect(harness.posts).toHaveLength(0);
    const log = harness.logs.join("\n");
    expect(log).toContain('"reason":"not-json"');
    expect(log).not.toContain("對話原文片段");
  });

  it("quote 對不上原文：整批丟棄，且不重複花模型錢", async () => {
    const harness = await setup({ settings: digestSettings() });
    harness.setTurn([user("u1", TURN1_USER), assistant("a1", text(TURN1_ASSISTANT))]);
    harness.generate = async () => ({ text: itemsFor("無中生有", "這句話不在對話裡") });
    await harness.settle(succeeded());
    expect(harness.posts).toHaveLength(0);
    expect(harness.logs.join("\n")).toContain('"written":0');

    // 0 筆是「處理完成」而非失敗：同一事件重送不再呼叫模型。
    await harness.settle(succeeded());
    expect(harness.generateCalls).toHaveLength(1);
  });

  it("POST /memories 500：請求 ≤2 次、不標記去重", async () => {
    const harness = await setup({ settings: digestSettings() });
    harness.setTurn([user("u1", TURN1_USER), assistant("a1", text(TURN1_ASSISTANT))]);
    harness.generate = async () => ({ text: itemsFor("卡片", "預設關閉") });
    harness.postMemory = async () => jsonResponse({ error: "boom" }, 500);
    await harness.settle(succeeded());
    expect(harness.posts).toHaveLength(2);
    expect(harness.logs.join("\n")).toContain('"reason":"http-500"');

    // 沒寫成功就不標記去重：同事件再來一次仍會再試（仍是最多 2 次）。
    await harness.settle(succeeded());
    expect(harness.posts.length).toBeLessThanOrEqual(4);
    expect(harness.logs.join("\n")).not.toContain("卡片");
  });

  it("摘要逾時：不寫入、log 只記 timeout", async () => {
    const harness = await setup({
      settings: digestSettings(),
      extraDeps: { digestTimeoutMs: 20 },
    });
    harness.setTurn([user("u1", TURN1_USER), assistant("a1", text(TURN1_ASSISTANT))]);
    harness.generate = () => new Promise<{ text: string }>(() => undefined);
    await harness.settle(succeeded());
    expect(harness.posts).toHaveLength(0);
    expect(harness.logs.join("\n")).toContain('"reason":"timeout"');
  });

  it("模型失敗：reason 為 <name>: <message>、不含對話內容，且今日統計只記呼叫與回合失敗", async () => {
    const harness = await setup({ settings: digestSettings() });
    harness.setTurn([user("u1", TURN1_USER), assistant("a1", text(TURN1_ASSISTANT))]);
    harness.generate = async () => {
      const error = new Error(`Model unavailable: ${CHEAP_MODEL}`);
      error.name = "Generate.ModelSelectionError";
      throw error;
    };

    await harness.settle(succeeded());

    expect(harness.generateCalls).toHaveLength(1);
    expect(harness.posts).toHaveLength(0);

    const log = harness.logs.join("\n");
    expect(log).toContain('"state":"failed"');
    // 真正有用的訊息要留下（不再只有型別名），且不含對話內容。
    expect(log).toContain('"reason":"Generate.ModelSelectionError: Model unavailable: cheap/test-model"');
    expect(log).not.toContain(TURN1_USER);
    expect(log).not.toContain(TURN1_ASSISTANT);

    // 模型失敗：沒有寫入統計，只記一次呼叫與一次回合失敗。
    const statsKey = [...harness.storage.map.keys()].find((key) => key.startsWith("digest-stats:"));
    expect(statsKey).toBeDefined();
    expect(harness.storage.map.get(statsKey as string)).toMatchObject({
      calls: 1,
      ok: 0,
      duplicate: 0,
      failed: 0,
      callFailed: 1,
    });

    const status = await harness.status();
    expect(status).toContain("今日 呼叫 1｜寫入 0｜重複 0｜失敗 0（回合 1）");
    expect(status).toContain("失敗：Generate.ModelSelectionError: Model unavailable: cheap/test-model");
  });

  it("宿主沒有 generate：不計呼叫、只記一次回合失敗", async () => {
    const harness = await setup({ settings: digestSettings(), withoutGenerate: true });
    harness.setTurn([user("u1", TURN1_USER), assistant("a1", text(TURN1_ASSISTANT))]);

    await harness.settle(succeeded());

    expect(harness.posts).toHaveLength(0);
    expect(harness.logs.join("\n")).toContain('"reason":"no-generate"');

    // 模型從未被呼叫：calls 維持 0，回合失敗仍算 1。
    const statsKey = [...harness.storage.map.keys()].find((key) => key.startsWith("digest-stats:"));
    expect(statsKey).toBeDefined();
    expect(harness.storage.map.get(statsKey as string)).toMatchObject({
      calls: 0,
      ok: 0,
      duplicate: 0,
      failed: 0,
      callFailed: 1,
    });

    const status = await harness.status();
    expect(status).toContain("今日 呼叫 0｜寫入 0｜重複 0｜失敗 0（回合 1）");
  });
});

describe("digest：檔案型診斷紀錄", () => {
  it("失敗時寫一行 JSON（含 latencyMs、reason），且不含對話內容、token 或卡片內容", async () => {
    const harness = await setup({ settings: digestSettings() });
    const marker = "MARKER-對話內容-9f3a";
    harness.setTurn([user("u1", `${TURN1_USER}\n${marker}`), assistant("a1", text(TURN1_ASSISTANT))]);
    harness.generate = async () => {
      await tick(10);
      const error = new Error("model exploded");
      error.name = "Generate.ModelError";
      throw error;
    };

    await harness.settle(succeeded());

    const lines = await harness.readLog();
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(entry).toMatchObject({
      session: expect.stringMatching(/^[0-9a-f]{8}$/),
      state: "failed",
      reason: "Generate.ModelError: model exploded",
      model: CHEAP_MODEL,
      items: 0,
      written: 0,
    });
    expect(typeof entry.at).toBe("string");
    expect(entry.latencyMs as number).toBeGreaterThanOrEqual(5);
    expect(lines[0]).not.toContain(marker);
    expect(lines[0]).not.toContain(TURN1_USER);
    expect(lines[0]).not.toContain("test-token-value");
  });

  it("成功與跳過也各寫一行；紀錄不含卡片內容", async () => {
    const harness = await setup({ settings: digestSettings() });
    harness.setTurn([user("u1", TURN1_USER), assistant("a1", text(TURN1_ASSISTANT))]);
    harness.generate = async () => ({ text: itemsFor("卡片內容-MARK", "預設關閉") });
    await harness.settle(succeeded());

    // 同一事件重送：skip/already 也要留一行。
    await harness.settle(succeeded());

    const lines = await harness.readLog();
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toMatchObject({ state: "ok", items: 1, written: 1, model: CHEAP_MODEL });
    expect(JSON.parse(lines[1])).toMatchObject({ state: "skipped", reason: "already", items: 0, written: 0 });
    expect(lines.join("\n")).not.toContain("卡片內容-MARK");
  });

  it("紀錄檔不可寫時不影響 digest 結果", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mnemoshelf-digest-blocked-"));
    tempDirs.push(dir);
    // 把紀錄檔路徑放在一個「檔案」底下：mkdir 必然失敗。
    const blocker = path.join(dir, "not-a-dir");
    await fs.writeFile(blocker, "x");
    const harness = await setup({
      settings: digestSettings(),
      extraDeps: { digestLogFile: path.join(blocker, "digest.log") },
    });
    harness.setTurn([user("u1", TURN1_USER), assistant("a1", text(TURN1_ASSISTANT))]);
    harness.generate = async () => ({ text: itemsFor("照常寫入", "預設關閉") });

    await harness.settle(succeeded());

    expect(harness.posts).toHaveLength(1);
    expect(harness.logs.join("\n")).toContain('"state":"ok"');
    await expect(harness.cleanup.awaitIdle?.()).resolves.toBeUndefined();
    expect(await harness.readLog()).toEqual([]);
  });

  it("/memory 失敗時多一行紀錄路徑", async () => {
    const harness = await setup({ settings: digestSettings() });
    harness.setTurn([user("u1", TURN1_USER), assistant("a1", text(TURN1_ASSISTANT))]);
    harness.generate = async () => {
      throw new Error("model exploded");
    };
    await harness.settle(succeeded());

    const status = await harness.status();
    expect(status).toContain("失敗：");
    expect(status).toContain(`紀錄：${harness.logFile}`);
    expect(status).not.toContain("test-token-value");
  });
});

describe("digest：寫入結果與今日統計", () => {
  it("模型回空：不寫卡、不造假回合卡、標記去重、state ok", async () => {
    const harness = await setup({ settings: digestSettings() });
    harness.setTurn([user("u1", TURN1_USER), assistant("a1", text(TURN1_ASSISTANT))]);
    harness.generate = async () => ({ text: '{"turn":"","items":[]}' });

    await harness.settle(succeeded());

    expect(harness.posts).toHaveLength(0);
    expect(harness.generateCalls).toHaveLength(1);
    // 去重鍵有寫入：同一事件重送不再花模型錢。
    expect(harness.storage.map.has("digest:s1:a1")).toBe(true);
    const last = JSON.parse((await harness.readLog()).at(-1) ?? "{}") as Record<string, unknown>;
    expect(last).toMatchObject({ state: "ok", written: 0, items: 0, duplicates: 0, failed: 0, cards: [] });

    await harness.settle(succeeded());
    expect(harness.generateCalls).toHaveLength(1);
  });

  it("duplicate 不計入 written，逐卡結果寫進 digest.log", async () => {
    const harness = await setup({ settings: digestSettings() });
    harness.setTurn([user("u1", TURN1_USER), assistant("a1", text(TURN1_ASSISTANT))]);
    harness.generate = async () => ({ text: itemsFor("既有卡片", "預設關閉") });
    harness.postMemory = async () => jsonResponse({ id: 7, duplicate: true }, 200);

    await harness.settle(succeeded());

    expect(harness.posts).toHaveLength(1);
    const entry = JSON.parse((await harness.readLog()).at(-1) ?? "{}") as Record<string, unknown>;
    expect(entry).toMatchObject({ state: "ok", written: 0, duplicates: 1, failed: 0 });
    expect(entry.cards).toEqual([{ role: "item", state: "duplicate" }]);

    const status = await harness.status();
    expect(status).toContain("成功寫入 0 筆（重複 1 筆）");
    expect(status).toContain("今日 呼叫 1｜寫入 0｜重複 1｜失敗 0（回合 0）");
  });

  it("部分失敗：state ok、written 1／failed 1，失敗卡恰好請求 2 次", async () => {
    const harness = await setup({ settings: digestSettings() });
    harness.setTurn([user("u1", TURN1_USER), assistant("a1", text(TURN1_ASSISTANT))]);
    harness.generate = async () => ({
      text: turnOutput("討論主題；結論：部分失敗照樣完成。", [
        { content: "原子記憶會失敗", kind: "decision", quote: "預設關閉" },
      ]),
    });
    harness.postMemory = async (body) => {
      if (body.agent === "opencode-plugin") return jsonResponse({ error: "boom" }, 500);
      return jsonResponse({ id: 1, duplicate: false }, 201);
    };

    await harness.settle(succeeded());

    // 回合卡 1 次成功；item 卡重試後共 2 次。
    expect(harness.posts).toHaveLength(3);
    expect(harness.posts.filter((post) => post.body.agent === "opencode-plugin/turn")).toHaveLength(1);
    expect(harness.posts.filter((post) => post.body.agent === "opencode-plugin")).toHaveLength(2);

    const entry = JSON.parse((await harness.readLog()).at(-1) ?? "{}") as Record<string, unknown>;
    expect(entry).toMatchObject({ state: "ok", written: 1, failed: 1, duplicates: 0 });
    expect(entry.cards).toEqual([
      { role: "turn", state: "ok" },
      { role: "item", state: "failed", status: 500 },
    ]);

    const status = await harness.status();
    expect(status).toContain("成功寫入 1 筆（失敗 1 筆）");
  });

  it("全部失敗：state failed、逐卡結果仍可見、不標記去重", async () => {
    const harness = await setup({ settings: digestSettings() });
    harness.setTurn([user("u1", TURN1_USER), assistant("a1", text(TURN1_ASSISTANT))]);
    harness.generate = async () => ({ text: turnOutput("討論主題；結論：全失敗。") });
    harness.postMemory = async () => jsonResponse({ error: "boom" }, 500);

    await harness.settle(succeeded());

    expect(harness.posts).toHaveLength(2);
    const entry = JSON.parse((await harness.readLog()).at(-1) ?? "{}") as Record<string, unknown>;
    expect(entry).toMatchObject({ state: "failed", reason: "http-500", written: 0, failed: 1 });
    expect(entry.cards).toEqual([{ role: "turn", state: "failed", status: 500 }]);
    expect(harness.storage.map.has("digest:s1:a1")).toBe(false);
  });

  it("/memory 顯示今日統計：三種結果各自計數", async () => {
    const harness = await setup({ settings: digestSettings() });
    const turns = threeTurns();
    harness.generate = async (input) => {
      if (input.prompt.includes("第一回合")) return { text: itemsFor("成功卡", "預設關閉") };
      if (input.prompt.includes("第二回合")) return { text: itemsFor("重複卡", "去重鍵") };
      return { text: itemsFor("失敗卡", "interrupted") };
    };
    harness.postMemory = async (body) => {
      if (body.content === "成功卡") return jsonResponse({ id: 1, duplicate: false }, 201);
      if (body.content === "重複卡") return jsonResponse({ id: 2, duplicate: true }, 200);
      return jsonResponse({ error: "boom" }, 500);
    };

    harness.setTurn(turns.slice(0, 2));
    await harness.settle(succeeded());
    harness.setTurn(turns.slice(0, 4));
    await harness.settle(succeeded());
    harness.setTurn(turns);
    await harness.settle(succeeded());

    const status = await harness.status();
    expect(status).toContain("今日 呼叫 3｜寫入 1｜重複 1｜失敗 1（回合 0）");
  });

  it("未連線時 /memory 說「未知（未連線）」，不拿本機數字冒充", async () => {
    const harness = await setup({ settings: digestSettings(), env: {} });
    harness.setTurn([user("u1", TURN1_USER), assistant("a1", text(TURN1_ASSISTANT))]);
    await harness.settle(succeeded());

    const status = await harness.status();
    expect(status).toContain("今日：未知（未連線）");
  });

  it("統計讀不到時 /memory 說「今日：未知」", async () => {
    const storage = memoryStorage();
    storage.scan = async () => {
      throw new Error("storage down");
    };
    const harness = await setup({ settings: digestSettings(), storage });

    const status = await harness.status();
    expect(status).toContain("今日：未知");
    expect(status).not.toContain("今日：未知（未連線）");
  });

  it("重啟後仍看得到今天數字：從 storage 讀回且不被 prune", async () => {
    const now = new Date("2026-10-22T10:00:00.000Z");
    const day = formatDay(now);
    const storage = memoryStorage();
    storage.map.set(`digest-stats:${day}`, {
      calls: 5,
      ok: 4,
      duplicate: 1,
      failed: 0,
      callFailed: 1,
      updatedAt: now.toISOString(),
    });

    // 新的 runtime（等同重啟）：今日數字必須從 storage 讀回，而不是從 0 起算。
    const harness = await setup({
      settings: digestSettings(),
      storage,
      extraDeps: { now: () => now },
    });

    const status = await harness.status();
    expect(status).toContain("今日 呼叫 5｜寫入 4｜重複 1｜失敗 0（回合 1）");
    expect(storage.map.has(`digest-stats:${day}`)).toBe(true);
  });

  it("/memory 顯示 digest 開關、模型、今日統計與最近結果（不再有 max）", async () => {
    const harness = await setup({ settings: digestSettings() });
    harness.setTurn([user("u1", TURN1_USER), assistant("a1", text(TURN1_ASSISTANT))]);
    harness.generate = async () => ({ text: itemsFor("卡片一", "預設關閉") });
    await harness.settle(succeeded());

    const status = await harness.status();
    expect(status).toContain("摘要：開啟（模型 cheap/test-model");
    expect(status).toContain("今日 呼叫 1｜寫入 1｜重複 0｜失敗 0（回合 0）");
    expect(status).toContain("成功寫入 1 筆");
    expect(status).not.toContain("每回合 ≤");
    expect(status).not.toContain("每 session ≤");
    expect(status).not.toContain("每日 ≤");
    expect(status).not.toContain("test-token-value");
  });

  it("啟動時 prune 超過 30 天的去重鍵與今日統計", async () => {
    const storage = memoryStorage();
    storage.map.set("digest:s1:old-assistant", { day: "2020-01-01" });
    storage.map.set("digest-stats:2020-01-01", {
      calls: 5,
      ok: 7,
      duplicate: 0,
      failed: 0,
      callFailed: 0,
      updatedAt: "2020-01-01T00:00:00.000Z",
    });

    const harness = await setup({
      settings: digestSettings(),
      storage,
      extraDeps: { now: () => new Date("2026-10-22T10:00:00.000Z") },
    });
    harness.setTurn([user("u1", TURN1_USER), assistant("a1", text(TURN1_ASSISTANT))]);
    harness.generate = async () => ({ text: itemsFor("卡片", "預設關閉") });
    await harness.settle(succeeded());
    await tick();

    expect(storage.map.has("digest:s1:old-assistant")).toBe(false);
    expect(storage.map.has("digest-stats:2020-01-01")).toBe(false);
    // 當日的統計仍保留。
    expect([...storage.map.keys()].some((key) => key.startsWith("digest-stats:"))).toBe(true);
  });
});
