import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { createMemoryRuntime, STATUS_SENTINEL, type RuntimeDeps } from "../src/recall.js";
import type {
  CommandEditorLike,
  CommandInvocationLike,
  ContextEventLike,
  PluginContextLike,
} from "../src/types.js";

interface CapturedCommand {
  name: string;
  execute: (input: CommandInvocationLike) => Promise<void>;
}

interface Harness {
  ctx: PluginContextLike;
  handler: (event: ContextEventLike) => Promise<void>;
  commands: Map<string, CapturedCommand>;
  synthetic: { sessionID: string; text: string }[];
  logs: string[];
  cleanup: () => Promise<void>;
  fetchCalls: { url: string; body: Record<string, unknown>; authorization: string | null }[];
}

const ENV = {
  MNEMOSHELF_URL: "http://127.0.0.1:43117",
  MNEMOSHELF_TOKEN: "test-token-value",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function memoryHits() {
  return {
    query: "ignored",
    k: 8,
    degraded: false,
    degradedReason: null,
    memoryEmbedding: {},
    hits: [
      {
        id: 1,
        content: "記憶向量改存 memories 自有欄位，不放共用 vectors 表。",
        kind: "decision",
        scope: "project",
        project: "mnemoshelf",
        agent: "user",
        supersedes: null,
        pinned: false,
        createdAt: "2026-10-18T00:00:00.000Z",
        deletedAt: null,
        rank: 1,
        score: 0.82,
        source: "semantic",
        untrusted: true,
      },
      {
        id: 2,
        content: "舊索引要重跑該 root 才會套用新的遮罩。",
        kind: "pitfall",
        scope: "project",
        project: "mnemoshelf",
        agent: "user",
        supersedes: null,
        pinned: false,
        createdAt: "2026-10-19T00:00:00.000Z",
        deletedAt: null,
        rank: 2,
        score: 1,
        source: "keyword",
        untrusted: true,
      },
    ],
  };
}

async function setup(
  options: Record<string, unknown> = {},
  fetchImpl?: typeof fetch,
  location?: PluginContextLike["location"],
  env: Record<string, string> = ENV,
  /** 覆寫 runtime 依賴（例如提供真的讀檔／pid 檢查）；未提供的沿用測試預設。 */
  extraDeps: Partial<RuntimeDeps> = {},
): Promise<Harness> {
  let handler: ((event: ContextEventLike) => Promise<void>) | undefined;
  const commands = new Map<string, CapturedCommand>();
  const synthetic: { sessionID: string; text: string }[] = [];
  const logs: string[] = [];
  const fetchCalls: { url: string; body: Record<string, unknown>; authorization: string | null }[] = [];

  const recordingFetch: typeof fetch = async (input, init) => {
    fetchCalls.push({
      url: String(input),
      body: JSON.parse(String(init?.body ?? "{}")),
      // 召回請求才帶 Authorization；`/health` 身分檢查一律不帶。
      authorization: new Headers(init?.headers).get("authorization"),
    });
    if (fetchImpl !== undefined) return fetchImpl(input, init);
    return jsonResponse(memoryHits());
  };

  const ctx: PluginContextLike = {
    app: { version: "2.1.1" },
    options,
    location: location ?? {
      directory: "/work/mnemoshelf",
      project: { canonical: "/work/mnemoshelf", directory: "/work/mnemoshelf" },
    },
    session: {
      hook: async (_name, callback) => {
        handler = callback as (event: ContextEventLike) => Promise<void>;
        return { dispose: async () => undefined };
      },
      synthetic: async (input) => {
        synthetic.push(input);
        return {};
      },
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
  };

  const cleanup = await createMemoryRuntime(ctx, {
    env,
    platform: "linux",
    fetchImpl: recordingFetch,
    log: (line) => logs.push(line),
    readFileImpl: async () => {
      throw new Error("ENOENT");
    },
    connectionWaitMs: 100,
    ...extraDeps,
  });
  // 等背景連線解析完成（env 來源只需要 microtask）。
  await new Promise((resolve) => setTimeout(resolve, 0));
  if (handler === undefined) throw new Error("context hook 未註冊");
  return { ctx, handler, commands, synthetic, logs, cleanup, fetchCalls };
}

function userEvent(text: string, id = "m1", kind?: string): ContextEventLike {
  const message = { id, role: "user", content: [{ type: "text", text }] };
  return {
    sessionID: "session-1",
    ...(kind === undefined ? {} : { kind }),
    messages: [message],
    system: [],
  };
}

function latestText(event: ContextEventLike): string {
  const last = event.messages[event.messages.length - 1] as {
    content: { type: string; text?: string }[];
  };
  return last.content.map((part) => part.text ?? "").join("\n");
}

const FIRST_QUERY = "請說明我們之前決定把記憶向量存在哪個表，以及背後的理由是什麼";

describe("context hook 召回", () => {
  it("第一輪召回並注入最新 user 訊息，不碰 system", async () => {
    const harness = await setup();
    const event = userEvent(FIRST_QUERY);
    await harness.handler(event);

    expect(harness.fetchCalls).toHaveLength(1);
    expect(harness.fetchCalls[0].url).toBe("http://127.0.0.1:43117/memories/search");
    expect(harness.fetchCalls[0].body).toEqual({
      query: FIRST_QUERY,
      project: "mnemoshelf",
      k: 8,
      minScore: 0.65,
    });
    expect(harness.fetchCalls[0].body).not.toHaveProperty("includeAllProjects");

    const text = latestText(event);
    expect(text).toContain('<memory-context source="mnemoshelf"');
    expect(text).toContain("[decision][2026-10-18][0.82]");
    expect(text).toContain("[pitfall][2026-10-19][kw]");
    expect(event.system).toHaveLength(0);
  });

  it("同一個 user turn 的 tool 續跑只查一次、每次都注入同一塊", async () => {
    const harness = await setup();
    const first = userEvent(FIRST_QUERY, "m1");
    const second = userEvent(FIRST_QUERY, "m1");
    await harness.handler(first);
    await harness.handler(second);

    expect(harness.fetchCalls).toHaveLength(1);
    expect(latestText(first)).toContain("<memory-context");
    expect(latestText(second)).toContain("<memory-context");
  });

  it("第二輪普通訊息不召回", async () => {
    const harness = await setup();
    const event: ContextEventLike = {
      sessionID: "session-1",
      messages: [
        { id: "u1", role: "user", content: [{ type: "text", text: FIRST_QUERY }] },
        { id: "a1", role: "assistant", content: [{ type: "text", text: "回答" }] },
        {
          id: "u2",
          role: "user",
          content: [{ type: "text", text: "請把目前的測試全部跑過一次並整理失敗原因與修正建議" }],
        },
      ],
      system: [],
    };
    await harness.handler(event);
    expect(harness.fetchCalls).toHaveLength(0);
    expect(latestText(event)).toBe("請把目前的測試全部跑過一次並整理失敗原因與修正建議");
  });

  it("第二輪含明示線索時召回", async () => {
    const harness = await setup();
    const event: ContextEventLike = {
      sessionID: "session-1",
      messages: [
        { id: "u1", role: "user", content: [{ type: "text", text: FIRST_QUERY }] },
        { id: "a1", role: "assistant", content: [{ type: "text", text: "回答" }] },
        {
          id: "u2",
          role: "user",
          content: [{ type: "text", text: "上次那個向量表的決定，後來還有調整嗎？請再說明一次" }],
        },
      ],
      system: [],
    };
    await harness.handler(event);
    expect(harness.fetchCalls).toHaveLength(1);
    expect(latestText(event)).toContain("<memory-context");
  });

  it("trigger=every-turn 時每輪都召回", async () => {
    const harness = await setup({ trigger: "every-turn" });
    const event: ContextEventLike = {
      sessionID: "session-1",
      messages: [
        { id: "u1", role: "user", content: [{ type: "text", text: FIRST_QUERY }] },
        { id: "a1", role: "assistant", content: [{ type: "text", text: "回答" }] },
        {
          id: "u2",
          role: "user",
          content: [{ type: "text", text: "請把目前的測試全部跑過一次並整理失敗原因與修正建議" }],
        },
      ],
      system: [],
    };
    await harness.handler(event);
    expect(harness.fetchCalls).toHaveLength(1);
    expect(latestText(event)).toContain("<memory-context");
  });

  it("kind 存在且非 primary 時跳過；kind 不存在時照常", async () => {
    const harness = await setup();
    const skipped = userEvent(FIRST_QUERY, "m1", "compaction");
    await harness.handler(skipped);
    expect(harness.fetchCalls).toHaveLength(0);

    const normal = userEvent(FIRST_QUERY, "m2");
    await harness.handler(normal);
    expect(harness.fetchCalls).toHaveLength(1);
  });

  it("少於 20 字與 slash command 不召回", async () => {
    const harness = await setup();
    await harness.handler(userEvent("太短了"));
    const first = userEvent("/memory-all 查詢一些很長的東西", "m2");
    await harness.handler(first);
    expect(harness.fetchCalls).toHaveLength(0);
  });

  it("幾乎全是程式碼的訊息不召回", async () => {
    const harness = await setup();
    const text = ["```ts", "const a = 1", "const b = 2", "const c = 3", "```"].join("\n");
    await harness.handler(userEvent(text));
    expect(harness.fetchCalls).toHaveLength(0);
  });

  it("空召回完全不注入", async () => {
    const harness = await setup({}, async () =>
      jsonResponse({ hits: [], degraded: false }),
    );
    const event = userEvent(FIRST_QUERY);
    await harness.handler(event);
    expect(latestText(event)).toBe(FIRST_QUERY);
    expect(event.system).toHaveLength(0);
  });

  it("同 session 去重：下一輪不再注入同一筆 fact", async () => {
    const harness = await setup();
    const first = userEvent(FIRST_QUERY, "m1");
    await harness.handler(first);
    expect(latestText(first)).toContain("記憶向量改存");

    const second: ContextEventLike = {
      sessionID: "session-1",
      messages: [
        { id: "u1", role: "user", content: [{ type: "text", text: FIRST_QUERY }] },
        { id: "a1", role: "assistant", content: [{ type: "text", text: "回答" }] },
        {
          id: "u2",
          role: "user",
          content: [{ type: "text", text: "之前提到的向量表決定，請再確認一次細節" }],
        },
      ],
      system: [],
    };
    await harness.handler(second);
    expect(latestText(second)).not.toContain("記憶向量改存");
  });

  it("召回快取有上限：超過 32 筆時淘汰最舊的一筆，最近的一筆仍命中", async () => {
    const harness = await setup();
    const text = "請說明這個專案在這一輪要處理什麼內容與背後的理由是什麼";
    for (let i = 1; i <= 33; i += 1) {
      await harness.handler(userEvent(text, `m${i}`));
    }
    expect(harness.fetchCalls).toHaveLength(33);

    // 最近的一筆還在快取：同一個 user turn 的 tool 續跑不重打 server。
    await harness.handler(userEvent(text, "m33"));
    expect(harness.fetchCalls).toHaveLength(33);

    // 最舊的一筆（m1）已被淘汰：新的 user turn 會重新查詢。
    await harness.handler(userEvent(text, "m1"));
    expect(harness.fetchCalls).toHaveLength(34);
  });

  it("去重 TTL：未過期保留、過期後重新注入", async () => {
    const pinnedOnly = async (): Promise<Response> =>
      jsonResponse({
        hits: [
          {
            id: 7,
            content: "這一筆是 pinned 記憶，用來檢查 TTL 過期後會重新注入。",
            kind: "fact",
            scope: "project",
            project: "mnemoshelf",
            agent: "user",
            supersedes: null,
            pinned: true,
            createdAt: "2026-10-20T00:00:00.000Z",
            deletedAt: null,
            rank: 1,
            score: 0.9,
            source: "semantic",
            untrusted: true,
          },
        ],
        degraded: false,
      });
    const harness = await setup({}, pinnedOnly);
    const text = "請說明這個專案在這一輪要處理什麼內容與背後的理由是什麼";
    const injectedTurns: number[] = [];
    for (let i = 1; i <= 10; i += 1) {
      const event = userEvent(text, `t${i}`);
      await harness.handler(event);
      if (latestText(event).includes("<memory-context")) injectedTurns.push(i);
    }
    // 第 1 輪注入；第 2–8 輪在 TTL 內一律算重複；第 9 輪 diff==TTL，pinned 可重新注入。
    expect(injectedTurns).toEqual([1, 9]);
  });

  it("去重 TTL：一般 fact 在 TTL 後仍不重注（prune 不得把它放行）", async () => {
    const factOnly = async (): Promise<Response> =>
      jsonResponse({
        hits: [
          {
            id: 9,
            content: "一般 fact 在同一個 session 內不應重複注入。",
            kind: "fact",
            scope: "project",
            project: "mnemoshelf",
            agent: "user",
            supersedes: null,
            pinned: false,
            createdAt: "2026-10-20T00:00:00.000Z",
            deletedAt: null,
            rank: 1,
            score: 0.9,
            source: "semantic",
            untrusted: true,
          },
        ],
        degraded: false,
      });
    const harness = await setup({}, factOnly);
    const text = "請說明這個專案在這一輪要處理什麼內容與背後的理由是什麼";
    const injectedTurns: number[] = [];
    for (let i = 1; i <= 10; i += 1) {
      const event = userEvent(text, `f${i}`);
      await harness.handler(event);
      if (latestText(event).includes("<memory-context")) injectedTurns.push(i);
    }
    // 第 10 輪的 diff=9 已超過 TTL：fact 的去重項仍必須保留，因此不得重新注入。
    expect(injectedTurns).toEqual([1]);
  });

  it("未連線時 fail-open：不注入、不拋錯、log 只記原因", async () => {
    const harness = await setup({}, undefined, undefined, {});
    const event = userEvent(FIRST_QUERY);
    await expect(harness.handler(event)).resolves.toBeUndefined();
    expect(harness.fetchCalls).toHaveLength(0);
    expect(latestText(event)).toBe(FIRST_QUERY);
    expect(harness.logs.join("\n")).toContain("offline");
    expect(harness.logs.join("\n")).not.toContain(FIRST_QUERY);

    // 初始解析失敗：狀態文字也必須是離線，且不帶任何「已連線」字樣。
    await harness.commands.get("memory")?.execute({ sessionID: "session-1", prompt: { text: "" } });
    const status = harness.synthetic.at(-1)?.text ?? "";
    expect(status).toContain("連線：未連線（找不到連線設定");
    expect(status).not.toContain("已連線");
  });

  it("逾時 fail-open，log 標 timeout", async () => {
    const harness = await setup(
      { baseUrl: "http://127.0.0.1:9", token: "test-token", timeoutMs: 100 },
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          );
        }),
    );
    const event = userEvent(FIRST_QUERY);
    await harness.handler(event);
    expect(latestText(event)).toBe(FIRST_QUERY);
    expect(harness.logs.join("\n")).toContain('"skipped":"timeout"');
  });

  it("HTTP 錯誤只記狀態碼，不記 token 或 query", async () => {
    const harness = await setup(
      { baseUrl: "http://127.0.0.1:9", token: "test-token" },
      async () => jsonResponse({ error: { name: "UnauthorizedError", message: "no" } }, 401),
    );
    const event = userEvent(FIRST_QUERY);
    await harness.handler(event);
    const joined = harness.logs.join("\n");
    expect(joined).toContain('"status":401');
    expect(joined).not.toContain("test-token");
    expect(joined).not.toContain(FIRST_QUERY);
  });

  it("專案名解析不到時 fail closed", async () => {
    const harness = await setup({}, undefined, { directory: "" }, {
      MNEMOSHELF_URL: "http://127.0.0.1:43117",
      MNEMOSHELF_TOKEN: "test-token",
    });
    const event = userEvent(FIRST_QUERY);
    await harness.handler(event);
    expect(harness.fetchCalls).toHaveLength(0);
    expect(harness.logs.join("\n")).toContain("project-unresolved");
  });
});

describe("指令", () => {
  it("/memory 顯示連線、專案、召回統計，不含 token", async () => {
    const harness = await setup();
    await harness.handler(userEvent(FIRST_QUERY));
    const memory = harness.commands.get("memory");
    expect(memory).toBeDefined();
    await memory?.execute({ sessionID: "session-1", prompt: { text: "" } });

    const output = harness.synthetic.at(-1)?.text ?? "";
    expect(output.startsWith(STATUS_SENTINEL)).toBe(true);
    expect(output).toContain("已連線");
    expect(output).toContain("專案：mnemoshelf");
    expect(output).toContain("trigger=first-turn+explicit");
    expect(output).toContain("最近召回");
    expect(output).not.toContain("test-token-value");
  });

  it("/memory 重新檢查時 runtime 檔消失：顯示未連線與原因，下一輪不召回", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mnemoshelf-plugin-runtime-"));
    const runtimeFile = path.join(dir, "runtime.json");
    try {
      await fs.writeFile(
        runtimeFile,
        `${JSON.stringify({
          schemaVersion: 1,
          url: "http://127.0.0.1:43117",
          token: "runtime-token",
          pid: 4321,
          startedAt: "2026-10-21T00:00:00.000Z",
          appVersion: "0.3.0",
        })}\n`,
        { mode: 0o600 },
      );
      const harness = await setup(
        {},
        async (input) => {
          if (String(input).endsWith("/health")) {
            return jsonResponse({ status: "ok", service: "mnemoshelf", appVersion: "0.3.0" });
          }
          return jsonResponse(memoryHits());
        },
        undefined,
        { MNEMOSHELF_RUNTIME_FILE: runtimeFile },
        {
          readFileImpl: (file) => fs.readFile(file, "utf8"),
          killImpl: () => undefined,
        },
      );

      const memory = harness.commands.get("memory");
      await memory?.execute({ sessionID: "session-1", prompt: { text: "" } });
      expect(harness.synthetic.at(-1)?.text ?? "").toContain("連線：已連線（runtime");

      // 服務關閉／runtime 檔被刪：重新檢查必須反映現況，不能留著舊的連線。
      await fs.rm(runtimeFile, { force: true });
      await memory?.execute({ sessionID: "session-1", prompt: { text: "" } });
      const output = harness.synthetic.at(-1)?.text ?? "";
      expect(output).toContain("連線：未連線（runtime 檔不存在");
      expect(output).not.toContain("已連線");
      expect(output).not.toContain("未連線（已連線");

      // 狀態說離線，召回行為也必須離線：不得再拿初始解析的舊連線去查詢／注入。
      const searches = (): number =>
        harness.fetchCalls.filter((call) => call.url.endsWith("/memories/search")).length;
      expect(searches()).toBe(0);
      const event = userEvent(FIRST_QUERY, "after-offline");
      await harness.handler(event);
      expect(searches()).toBe(0);
      expect(latestText(event)).toBe(FIRST_QUERY);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("暫時性 health 失敗：保留上次連線、狀態顯示警告、下一輪仍注入；成功後清掉警告", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mnemoshelf-plugin-runtime-"));
    const runtimeFile = path.join(dir, "runtime.json");
    try {
      await fs.writeFile(
        runtimeFile,
        `${JSON.stringify({
          schemaVersion: 1,
          url: "http://127.0.0.1:43117",
          token: "runtime-token",
          pid: 4321,
          startedAt: "2026-10-21T00:00:00.000Z",
          appVersion: "0.3.0",
        })}\n`,
        { mode: 0o600 },
      );
      type HealthMode = "ok" | "timeout" | "unreachable";
      let healthMode: HealthMode = "ok";
      // 每次查詢回不同 id，避免同一 session 的去重讓「有沒有注入」難以判讀。
      let nextHitId = 100;
      const harness = await setup(
        {},
        async (input, init) => {
          if (String(input).endsWith("/health")) {
            if (healthMode === "timeout") {
              // 模擬 `/health` 不回應：等 checkHealth 的 AbortController 觸發。
              return await new Promise<Response>((_resolve, reject) => {
                init?.signal?.addEventListener("abort", () =>
                  reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
                );
              });
            }
            if (healthMode === "unreachable") throw new TypeError("fetch failed");
            return jsonResponse({ status: "ok", service: "mnemoshelf", appVersion: "0.3.0" });
          }
          nextHitId += 1;
          return jsonResponse({
            hits: [
              {
                id: nextHitId,
                content: `暫時性 health 測試的記憶 ${nextHitId}`,
                kind: "decision",
                scope: "project",
                project: "mnemoshelf",
                agent: "user",
                supersedes: null,
                pinned: false,
                createdAt: "2026-10-20T00:00:00.000Z",
                deletedAt: null,
                rank: 1,
                score: 0.9,
                source: "semantic",
                untrusted: true,
              },
            ],
            degraded: false,
          });
        },
        undefined,
        { MNEMOSHELF_RUNTIME_FILE: runtimeFile },
        {
          readFileImpl: (file) => fs.readFile(file, "utf8"),
          killImpl: () => undefined,
        },
      );

      const memory = harness.commands.get("memory");
      await memory?.execute({ sessionID: "session-1", prompt: { text: "" } });
      expect(harness.synthetic.at(-1)?.text ?? "").not.toContain("最近一次檢查失敗");

      // health 逾時：連線保留（召回仍可用），狀態顯示警告。
      healthMode = "timeout";
      await memory?.execute({ sessionID: "session-1", prompt: { text: "" } });
      const warned = harness.synthetic.at(-1)?.text ?? "";
      expect(warned).toContain("連線：已連線（runtime");
      expect(warned).toContain("最近一次檢查失敗：GET /health 逾時");
      expect(warned).toContain("召回仍使用上次連線");

      // 行為與狀態一致：下一輪仍用上次連線注入。
      const searches = (): number =>
        harness.fetchCalls.filter((call) => call.url.endsWith("/memories/search")).length;
      const event = userEvent(FIRST_QUERY, "after-transient");
      await harness.handler(event);
      expect(searches()).toBe(1);
      expect(latestText(event)).toContain("<memory-context");

      // 下一次成功檢查要清掉警告。
      healthMode = "ok";
      await memory?.execute({ sessionID: "session-1", prompt: { text: "" } });
      const recovered = harness.synthetic.at(-1)?.text ?? "";
      expect(recovered).toContain("連線：已連線（runtime");
      expect(recovered).not.toContain("最近一次檢查失敗");

      // health-unreachable（fetch 拋錯／連不上）同樣是暫時性：保留連線、下一輪仍注入。
      healthMode = "unreachable";
      await memory?.execute({ sessionID: "session-1", prompt: { text: "" } });
      const unreachableWarn = harness.synthetic.at(-1)?.text ?? "";
      expect(unreachableWarn).toContain("連線：已連線（runtime");
      expect(unreachableWarn).toContain("最近一次檢查失敗：GET /health 連線失敗");
      const unreachableEvent = userEvent(FIRST_QUERY, "after-unreachable");
      await harness.handler(unreachableEvent);
      expect(searches()).toBe(2);
      expect(latestText(unreachableEvent)).toContain("<memory-context");

      healthMode = "ok";
      await memory?.execute({ sessionID: "session-1", prompt: { text: "" } });
      expect(harness.synthetic.at(-1)?.text ?? "").not.toContain("最近一次檢查失敗");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("確定性身分失敗：/health 不是 mnemoshelf 時清掉連線，下一輪 0 次 search、不帶 Authorization", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mnemoshelf-plugin-runtime-"));
    const runtimeFile = path.join(dir, "runtime.json");
    try {
      await fs.writeFile(
        runtimeFile,
        `${JSON.stringify({
          schemaVersion: 1,
          url: "http://127.0.0.1:43117",
          token: "runtime-token",
          pid: 4321,
          startedAt: "2026-10-21T00:00:00.000Z",
          appVersion: "0.3.0",
        })}\n`,
        { mode: 0o600 },
      );
      type HealthMode = "ok" | "wrong-service" | "not-json" | "http-error";
      let healthMode: HealthMode = "ok";
      const harness = await setup(
        {},
        async (input) => {
          if (!String(input).endsWith("/health")) return jsonResponse(memoryHits());
          switch (healthMode) {
            case "wrong-service":
              // 同一個埠被別的程式占用：有回應，但沒有 service 欄位。
              return jsonResponse({ status: "ok" });
            case "not-json":
              return new Response("<html>not mnemoshelf</html>", { status: 200 });
            case "http-error":
              return jsonResponse({ error: "boom" }, 500);
            default:
              return jsonResponse({ status: "ok", service: "mnemoshelf", appVersion: "0.3.0" });
          }
        },
        undefined,
        { MNEMOSHELF_RUNTIME_FILE: runtimeFile },
        {
          readFileImpl: (file) => fs.readFile(file, "utf8"),
          killImpl: () => undefined,
        },
      );

      const memory = harness.commands.get("memory");
      for (const mode of ["wrong-service", "not-json", "http-error"] as const) {
        // 先回到正常服務，確定每個情境都是「已連線 → 身分失敗」。
        healthMode = "ok";
        await memory?.execute({ sessionID: "session-1", prompt: { text: "" } });
        expect(harness.synthetic.at(-1)?.text ?? "").toContain("連線：已連線（runtime");

        healthMode = mode;
        await memory?.execute({ sessionID: "session-1", prompt: { text: "" } });
        const status = harness.synthetic.at(-1)?.text ?? "";
        expect(status).toContain("連線：未連線（GET /health 回應不是 mnemoshelf");
        expect(status).toContain("不送 token");

        // 狀態說離線，行為也必須離線：下一次召回不得查詢、不得注入、不得帶 Authorization。
        const before = harness.fetchCalls.length;
        const event = userEvent(FIRST_QUERY, `identity-${mode}`);
        await harness.handler(event);
        const callsAfter = harness.fetchCalls.slice(before);
        expect(callsAfter.filter((call) => call.url.endsWith("/memories/search"))).toHaveLength(0);
        expect(callsAfter.some((call) => call.authorization !== null)).toBe(false);
        expect(latestText(event)).toBe(FIRST_QUERY);
      }

      // 整個流程中 `/health` 一律不帶 Authorization（全權 token 不能送給身分不明的程式）。
      expect(
        harness.fetchCalls.filter(
          (call) => call.url.endsWith("/health") && call.authorization !== null,
        ),
      ).toHaveLength(0);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("自己的狀態訊息（synthetic）不觸發召回", async () => {
    const harness = await setup();
    await harness.commands.get("memory")?.execute({ sessionID: "session-1", prompt: { text: "" } });
    const status = harness.synthetic.at(-1)?.text ?? "";
    expect(status.startsWith(STATUS_SENTINEL)).toBe(true);

    const before = harness.fetchCalls.length;
    const statusEvent = userEvent(status, "status-1");
    await harness.handler(statusEvent);
    expect(harness.fetchCalls).toHaveLength(before);
    expect(harness.logs.join("\n")).toContain('"skipped":"status"');
    expect(latestText(statusEvent)).toBe(status);

    // 一般訊息照常召回。
    await harness.handler(userEvent(FIRST_QUERY, "m1"));
    expect(harness.fetchCalls).toHaveLength(before + 1);
  });

  it("/memory-all 只送 includeAllProjects，不帶 project", async () => {
    const harness = await setup();
    const command = harness.commands.get("memory-all");
    expect(command).toBeDefined();
    await command?.execute({ sessionID: "session-1", prompt: { text: "向量表 決定" } });

    expect(harness.fetchCalls).toHaveLength(1);
    expect(harness.fetchCalls[0].body).toEqual({
      query: "向量表 決定",
      includeAllProjects: true,
      k: 8,
      minScore: 0.65,
    });
    expect(harness.fetchCalls[0].body).not.toHaveProperty("project");
    const output = harness.synthetic.at(-1)?.text ?? "";
    expect(output.startsWith(STATUS_SENTINEL)).toBe(true);
    expect(output).toContain("跨專案查詢");
    expect(output).toContain("記憶向量改存");
  });

  it("/memory-all 查無結果時明確說沒有找到", async () => {
    const harness = await setup({}, async () => jsonResponse({ hits: [] }));
    await harness.commands.get("memory-all")?.execute({
      sessionID: "session-1",
      prompt: { text: "不存在的關鍵字" },
    });
    expect(harness.synthetic.at(-1)?.text).toContain("沒有找到");
  });

  it("/memory-all 沒有參數時給用法、不打 server", async () => {
    const harness = await setup();
    await harness.commands.get("memory-all")?.execute({ sessionID: "session-1", prompt: { text: "  " } });
    expect(harness.fetchCalls).toHaveLength(0);
    expect(harness.synthetic.at(-1)?.text).toContain("需要查詢文字");
  });
});
