import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseAntigravityTurns,
  runAntigravityPreInvocation,
  runAntigravityStop,
  sanitizeAntigravityText,
} from "../src/scripts/antigravity-hook.js";
import {
  captureTurn,
  DEFAULT_HOOK_DEDUPE_TTL,
  formatRecallBlock,
  formatRecallBlockWithMeta,
  hookStateFile,
  memoryDedupeKey,
  parseHookDedupeState,
  queryFromPrompt,
  recallForPrompt,
  recordHookInjections,
  resolveHookDedupeTTL,
  resolveWorkspaceCwd,
  sanitizeRawText,
} from "../src/scripts/hook-core.js";

const baseUrl = "http://127.0.0.1:4321";
const credential = ["synthetic", "ag", "token"].join("-");
const homeDir = path.join(path.parse(tmpdir()).root, "synthetic-home");
const workspaceDir = path.join(homeDir, "work", "demo-app");
const containerDir = path.dirname(workspaceDir);
const siblingDir = path.join(containerDir, "other-app");
const workspaces = [containerDir, workspaceDir, siblingDir];
const globalHit = { id: 17, source: "semantic", scope: "global", kind: "fact", score: 0.9, content: "已注入的合成記憶" };

let tempDir: string;
let runtimeFile: string;
let stateDir: string;

async function writeRuntime(url = baseUrl): Promise<void> {
  await writeFile(
    runtimeFile,
    JSON.stringify({
      schemaVersion: 1,
      url,
      token: credential,
      pid: process.pid,
      startedAt: "2026-11-13T00:00:00.000Z",
      appVersion: "0.9.1",
    }),
  );
}

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "mnemoshelf-ag-hook-test-"));
  runtimeFile = path.join(tempDir, "runtime.json");
  stateDir = path.join(tempDir, "state");
  await writeRuntime();
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("Hook Core 與 Antigravity Adapter", () => {
  it("工作區解析依最深祖先、葉節點和原順序選擇絕對路徑", () => {
    const root = path.parse(homeDir).root;
    const options = { homeDir };
    const workspacePaths = ["relative", 12, root, homeDir, ...workspaces];
    expect(resolveWorkspaceCwd({ workspacePaths, cwd: path.join(workspaceDir, "src") }, options)).toBe(workspaceDir);
    expect(resolveWorkspaceCwd({ workspacePaths, cwd: siblingDir }, options)).toBe(siblingDir);
    const outside = path.join(homeDir, "work-other");
    expect(resolveWorkspaceCwd({ workspacePaths, cwd: outside }, options)).toBe(outside);
    expect(resolveWorkspaceCwd({ workspacePaths, cwd: homeDir }, options)).toBe(containerDir);
    expect(resolveWorkspaceCwd({ workspacePaths, cwd: root }, options)).toBe(containerDir);
    expect(resolveWorkspaceCwd({
      workspacePaths: [containerDir, workspaceDir, `${workspaceDir}${path.sep}.`],
      cwd: "relative",
    }, options)).toBe(workspaceDir);
    expect(resolveWorkspaceCwd({ workspacePaths: [null, root, homeDir, "relative", `${workspaceDir}\0`] }, options))
      .toBeUndefined();
  });

  it.each([
    ["請確認（DEMO-APP）上次的建置指令", workspaceDir],
    ["請幫我看demo-app的建置指令", workspaceDir],
    ["@[Quote] 請確認other-app怎麼跑測試", siblingDir],
    ["請確認 other-app 的建置指令", siblingDir],
    ["請確認 my-demo-app、demo-app-v2 和 predemo-app2 的建置指令", containerDir],
    ["請比較 demo-app 與 other-app 的建置指令", containerDir],
    ["請比較demo-app與other-app的建置指令", containerDir],
    ["目前工作區要怎麼建置？", containerDir],
    [undefined, containerDir],
  ])("只用明確且唯一的資料夾名稱判定工作區（%s）", (prompt, expected) => {
    expect(resolveWorkspaceCwd({ workspacePaths: workspaces }, { homeDir, prompt })).toBe(expected);
  });

  it("同名葉節點有歧義，單字元名稱不參與提示比對", () => {
    const otherWithSameName = path.join(siblingDir, path.basename(workspaceDir));
    expect(resolveWorkspaceCwd({ workspacePaths: [containerDir, workspaceDir, otherWithSameName] }, {
      homeDir, prompt: "請檢查 demo-app",
    })).toBe(containerDir);
    expect(resolveWorkspaceCwd({ workspacePaths: [containerDir, path.join(containerDir, "a"), siblingDir] }, {
      homeDir, prompt: "請檢查 a",
    })).toBe(containerDir);
  });

  it.each([
    [{ cwd: path.join(siblingDir, "src"), lastUserInput: "請檢查 demo-app 的建置" }, {}, "other-app"],
    [{ lastUserInput: "請檢查 DEMO-APP 的建置" }, {}, "demo-app"],
    [{ cwd: workspaceDir, lastUserInput: "請檢查建置指令" }, { MNEMOSHELF_PROJECT: "override" }, "override"],
  ])("PreInvocation 傳送解析後的專案", async (input, extraEnv, project) => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (url) =>
      url === `${baseUrl}/health`
        ? Response.json({ service: "mnemoshelf" })
        : Response.json({ degraded: false, hits: [globalHit] }));
    await runAntigravityPreInvocation(
      Readable.from([JSON.stringify({ workspacePaths: workspaces, ...input })]),
      { env: { MNEMOSHELF_RUNTIME_FILE: runtimeFile, ...extraEnv }, fetchImpl, homeDir, stateDir },
    );
    expect(JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body))).toMatchObject({ project });
  });

  it.each([
    [undefined, DEFAULT_HOOK_DEDUPE_TTL], ["", 8], ["-1", 8], ["2.5", 8],
    ["2e1", 8], ["9007199254740992", 8], [" 0 ", 0], ["3", 3],
  ])("解析回合去重門檻（%s → %s）", (raw, expected) => {
    expect(resolveHookDedupeTTL({ MNEMOSHELF_RECALL_DEDUPE_TTL: raw })).toBe(expected);
  });

  it("記憶鍵以正整數 ID 為準，無 ID 時雜湊來源和正規化文字", () => {
    const fallback = { sourceType: "raw-turn", sourceId: 7, kind: "fact", content: "片段\n Café" };
    const key = memoryDedupeKey(fallback);
    expect(key).toMatch(/^content:[a-f0-9]{16}$/);
    expect(memoryDedupeKey({ ...fallback, id: 0, content: " 片段 Cafe\u0301 " })).toBe(key);
    expect(memoryDedupeKey({ ...fallback, sourceId: 8 })).not.toBe(key);
    expect(memoryDedupeKey({ ...fallback, kind: "pitfall" })).not.toBe(key);
    expect(memoryDedupeKey({ ...fallback, sourceType: "memory" })).not.toBe(key);
    expect(memoryDedupeKey({ ...fallback, id: 9 })).toBe("id:9");
  });

  it("格式化只回報實際納入區塊的命中，舊介面仍回傳相同文字", () => {
    const result = { degraded: false, hits: [
      { ...globalHit, id: 1, content: "字".repeat(1000) },
      { ...globalHit, id: 2, content: "未納入的內容" },
    ] };
    const formatted = formatRecallBlockWithMeta(result, null);
    expect(formatted?.block).toBe(formatRecallBlock(result, null));
    expect(formatted?.block).toContain("…");
    expect(formatted?.hits.map((hit) => hit.key)).toEqual(["id:1"]);
    const injected = recordHookInjections(undefined, formatted!.hits, 1);
    const next = formatRecallBlockWithMeta(result, null, { dedupe: { turn: 2, ttl: 8, injected } });
    expect(next?.block).toContain("未納入的內容");
    expect(next?.hits.map((hit) => hit.key)).toEqual(["id:2"]);
  });

  it("去重狀態只保留最近注入的 256 筆，忽略舊版和無效記錄", () => {
    let injected = {};
    for (let turn = 1; turn <= 257; turn += 1) {
      injected = recordHookInjections(injected, [{ key: `id:${turn}`, kind: "fact", pinned: false, sourceType: "memory" }], turn);
    }
    expect(Object.keys(injected)).toHaveLength(256);
    expect(injected).not.toHaveProperty("id:1");
    expect(injected).toHaveProperty("id:2");
    expect(parseHookDedupeState({ lastInitialNumSteps: 2 })).toEqual({});
    expect(parseHookDedupeState({ turnCount: 257, injected: {
      ...injected, invalid: { turn: 257 }, "id:258": { turn: 258 },
    } })).toEqual({ turnCount: 257, injected });
  });

  it("sanitizeRawText 會移除 NUL 與孤立 surrogate，保留合法 emoji", () => {
    const dirty = `abc\0def\uD800ghi\uDC00jkl🪴`;
    expect(sanitizeRawText(dirty)).toBe("abcdefghijkl🪴");
  });

  it("queryFromPrompt 與 sanitizeAntigravityText 會拆解 USER_REQUEST 並剝除宿主系統標籤", () => {
    const wrapped = [
      "<USER_REQUEST>",
      "請幫我確認上次的建置流程",
      "另外檢查測試腳本",
      "</USER_REQUEST>",
      "<ADDITIONAL_METADATA>",
      "The current local time is: 2026-11-21T19:00:00+08:00.",
      "</ADDITIONAL_METADATA>",
      "<USER_SETTINGS_CHANGE>",
      "The user changed setting Model Selection.",
      "</USER_SETTINGS_CHANGE>",
      "The following is a <SYSTEM_MESSAGE> not actually sent by the user. It is provided by the system as important information to pay attention to.",
      "",
      "<SYSTEM_MESSAGE>",
      '<memory-context source="mnemoshelf">不應保留的舊注入</memory-context>',
      "</SYSTEM_MESSAGE>",
    ].join("\n");

    expect(sanitizeAntigravityText(wrapped)).toBe("請幫我確認上次的建置流程\n另外檢查測試腳本");
    expect(queryFromPrompt(wrapped)).toBe("請幫我確認上次的建置流程\n另外檢查測試腳本");

    // 未閉合系統區塊應丟棄至尾端，不外洩內容
    expect(sanitizeAntigravityText("正常提問<ADDITIONAL_METADATA>未閉合中繼資料")).toBe("正常提問");
    // 純文字原樣保留
    expect(sanitizeAntigravityText("純文字問題")).toBe("純文字問題");
  });

  it("recallForPrompt 在離線時靜默回傳 null", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error("ECONNREFUSED"));
    const result = await recallForPrompt({
      prompt: "測試查詢",
      cwd: workspaceDir,
      env: { MNEMOSHELF_RUNTIME_FILE: runtimeFile },
      homeDir,
      fetchImpl,
    });
    expect(result).toBeNull();
  });

  it("captureTurn 依序處理 saved / duplicate / conflict / offline", async () => {
    const bodies: unknown[] = [];
    let postStatus = 201;
    let postBody: unknown = { saved: true, duplicate: false, source: { id: 42 } };

    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
      if (url === `${baseUrl}/health`) return Response.json({ service: "mnemoshelf" });
      if (url === `${baseUrl}/memory-policy`) return Response.json({ maskSecrets: true, version: 1 });
      if (url === `${baseUrl}/memory-sources`) {
        bodies.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify(postBody), {
          status: postStatus,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected url: ${String(url)}`);
    });

    const baseInput = {
      agent: "antigravity/turn",
      sessionId: "conv-1",
      turnId: "turn-0",
      cwd: workspaceDir,
      env: { MNEMOSHELF_RUNTIME_FILE: runtimeFile },
      homeDir,
      fetchImpl,
      messages: [
        { messageId: "step-0", role: "user" as const, content: "請問架構？", occurredAt: "2026-11-13T10:00:00Z" },
        { messageId: "step-2", role: "assistant" as const, content: "使用 SQLite。", occurredAt: "2026-11-13T10:00:05Z" },
      ],
    };

    expect(await captureTurn(baseInput)).toEqual({ status: "saved", sourceId: 42, duplicate: false });
    expect(bodies[0]).toMatchObject({
      agent: "antigravity/turn",
      scope: "project",
      project: "demo-app",
      sourceSession: "conv-1",
      sourceTurn: "turn-0",
    });

    postStatus = 200;
    postBody = { saved: true, duplicate: true, source: { id: 42 } };
    expect(await captureTurn(baseInput)).toEqual({ status: "saved", sourceId: 42, duplicate: true });

    postStatus = 409;
    postBody = { error: { name: "ConflictError" } };
    expect(await captureTurn(baseInput)).toEqual({ status: "conflict" });

    const offlineFetch = vi.fn<typeof fetch>().mockRejectedValue(new Error("down"));
    expect(await captureTurn({ ...baseInput, fetchImpl: offlineFetch })).toEqual({ status: "offline" });
  });

  it("PreInvocation 於新提問注入記憶，同一輪工具迴圈內不重複注入，換新問題再觸發", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
      if (url === `${baseUrl}/health`) return Response.json({ service: "mnemoshelf" });
      if (url === `${baseUrl}/memories/search`) {
        const { query } = JSON.parse(String(init?.body));
        return Response.json({
          degraded: false,
          policyVersion: 1,
          hits: [
            {
              source: "semantic",
              scope: "project",
              project: "demo-app",
              kind: "decision",
              score: 0.91,
              content: query === "那測試指令是什麼？" ? "測試指令為 pnpm test" : "專案預設使用 pnpm",
              createdAt: "2026-11-10T00:00:00Z",
            },
          ],
        });
      }
      throw new Error(`unexpected url: ${String(url)}`);
    });

    const opts = {
      env: { MNEMOSHELF_RUNTIME_FILE: runtimeFile },
      homeDir,
      fetchImpl,
      stateDir,
    };

    // 第一次提問：應注入
    const first = await runAntigravityPreInvocation(
      Readable.from([
        JSON.stringify({
          conversationId: "conv-loop-1",
          workspacePaths: [workspaceDir],
          lastUserInput: "怎麼建置專案？",
          invocationNum: 1,
        }),
      ]),
      opts,
    );
    expect(first.injectSteps).toHaveLength(1);
    expect(first.injectSteps?.[0]?.systemMessage.systemMessage).toContain("專案預設使用 pnpm");
    expect(first.terminationBehavior).toBe("");

    // 同一回合第 2 次 invocation（tool loop）：lastUserInput 未變且無記憶線索 -> 不重複注入
    const second = await runAntigravityPreInvocation(
      Readable.from([
        JSON.stringify({
          conversationId: "conv-loop-1",
          workspacePaths: [workspaceDir],
          lastUserInput: "怎麼建置專案？",
          invocationNum: 2,
        }),
      ]),
      opts,
    );
    expect(second).toEqual({});
    expect(fetchImpl).toHaveBeenCalledTimes(2); // 只有第一次的 health + search

    // 新一輪提問：lastUserInput 改變 -> 再次注入
    const third = await runAntigravityPreInvocation(
      Readable.from([
        JSON.stringify({
          conversationId: "conv-loop-1",
          workspacePaths: [workspaceDir],
          lastUserInput: "那測試指令是什麼？",
          invocationNum: 3,
        }),
      ]),
      opts,
    );
    expect(third.injectSteps).toHaveLength(1);
    expect(third.injectSteps?.[0]?.systemMessage.systemMessage).toContain("測試指令為 pnpm test");
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("PreInvocation 在提問含記憶關鍵字時，同一回合多步工具迴圈內絕不重複注入", async () => {
    let hitText = "專案預設使用 pnpm";
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (url) => {
      if (url === `${baseUrl}/health`) return Response.json({ service: "mnemoshelf" });
      if (url === `${baseUrl}/memories/search`) {
        return Response.json({
          degraded: false,
          policyVersion: 1,
          hits: [
            {
              source: "semantic",
              scope: "project",
              project: "demo-app",
              kind: "decision",
              score: 0.92,
              content: hitText,
              createdAt: "2026-11-10T00:00:00Z",
            },
          ],
        });
      }
      throw new Error(`unexpected url: ${String(url)}`);
    });

    const opts = {
      env: { MNEMOSHELF_RUNTIME_FILE: runtimeFile },
      homeDir,
      fetchImpl,
      stateDir,
    };

    // 第 1 輪第 1 步（含記憶關鍵字「記得」「上次」）-> 應注入
    const step1 = await runAntigravityPreInvocation(
      Readable.from([
        JSON.stringify({
          conversationId: "conv-explicit-loop",
          workspacePaths: [workspaceDir],
          lastUserInput: "你記得上次我們討論的建置指令嗎？",
          initialNumSteps: 0,
          invocationNum: 1,
        }),
      ]),
      opts,
    );
    expect(step1.injectSteps).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    // 同一回合第 2、3 步（相同 initialNumSteps）-> 不重複注入也不再查詢
    const step2 = await runAntigravityPreInvocation(
      Readable.from([
        JSON.stringify({
          conversationId: "conv-explicit-loop",
          workspacePaths: [workspaceDir],
          lastUserInput: "你記得上次我們討論的建置指令嗎？",
          initialNumSteps: 0,
          invocationNum: 2,
        }),
      ]),
      opts,
    );
    expect(step2).toEqual({});
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    // 即使缺少 initialNumSteps（舊版／簡化 payload），同提問含記憶詞仍不重複注入
    const step3NoSteps = await runAntigravityPreInvocation(
      Readable.from([
        JSON.stringify({
          conversationId: "conv-explicit-loop",
          workspacePaths: [workspaceDir],
          lastUserInput:
            "<USER_REQUEST>\n你記得上次我們討論的建置指令嗎？\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-11-21T19:01:00+08:00.\n</ADDITIONAL_METADATA>",
          invocationNum: 3,
        }),
      ]),
      opts,
    );
    expect(step3NoSteps).toEqual({});
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    // 若同提問在新的 initialNumSteps 重送且召回區塊完全相同 -> lastInjectedBlockHash 擋下重複注入
    const retrySameBlock = await runAntigravityPreInvocation(
      Readable.from([
        JSON.stringify({
          conversationId: "conv-explicit-loop",
          workspacePaths: [workspaceDir],
          lastUserInput: "你記得上次我們討論的建置指令嗎？",
          initialNumSteps: 4,
          invocationNum: 1,
        }),
      ]),
      { ...opts, env: { ...opts.env, MNEMOSHELF_RECALL_DEDUPE_TTL: "0" } },
    );
    expect(retrySameBlock).toEqual({});
    expect(fetchImpl).toHaveBeenCalledTimes(4);

    // 若新回合是不同問題（同樣含記憶關鍵字）-> 再次注入
    hitText = "測試指令為 pnpm test";
    const nextTurn = await runAntigravityPreInvocation(
      Readable.from([
        JSON.stringify({
          conversationId: "conv-explicit-loop",
          workspacePaths: [workspaceDir],
          lastUserInput: "那上次的測試指令是什麼？",
          initialNumSteps: 8,
          invocationNum: 1,
        }),
      ]),
      opts,
    );
    expect(nextTurn.injectSteps).toHaveLength(1);
    expect(nextTurn.injectSteps?.[0]?.systemMessage.systemMessage).toContain("測試指令為 pnpm test");

    // MNEMOSHELF_RECALL_MODE=every-turn 仍允許同回合再次召回
    const everyTurn = await runAntigravityPreInvocation(
      Readable.from([
        JSON.stringify({
          conversationId: "conv-explicit-loop",
          workspacePaths: [workspaceDir],
          lastUserInput: "那上次的測試指令是什麼？",
          initialNumSteps: 8,
          invocationNum: 2,
        }),
      ]),
      {
        ...opts,
        env: { MNEMOSHELF_RUNTIME_FILE: runtimeFile, MNEMOSHELF_RECALL_MODE: "every-turn" },
      },
    );
    expect(everyTurn.injectSteps).toHaveLength(1);
  });

  it.each([
    ["decision", { kind: "decision" }, true],
    ["pitfall", { kind: "pitfall" }, true],
    ["pinned", { pinned: true }, true],
    ["raw-turn", { sourceType: "raw-turn", sourceId: 21, role: "assistant" }, true],
    ["fact", {}, false],
    ["preference", { kind: "preference" }, false],
  ])("跨回合去重保留 %s 的到期規則", async (_kind, metadata, canRepeat) => {
    let hits: Array<Record<string, unknown>> = [{ ...globalHit, ...metadata }];
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (url) =>
      url === `${baseUrl}/health`
        ? Response.json({ service: "mnemoshelf" })
        : Response.json({ degraded: false, hits }));
    const opts = { env: { MNEMOSHELF_RUNTIME_FILE: runtimeFile }, fetchImpl, homeDir, stateDir };
    const run = (initialNumSteps: number, extraEnv: NodeJS.ProcessEnv = {}) => runAntigravityPreInvocation(
      Readable.from([JSON.stringify({
        conversationId: "dedupe-session",
        initialNumSteps,
        lastUserInput: `請確認第 ${initialNumSteps} 輪的專案設定`,
      })]),
      { ...opts, env: { ...opts.env, ...extraEnv } },
    );

    expect((await run(1)).injectSteps?.[0]?.systemMessage.systemMessage).toContain(globalHit.content);
    expect(await run(2)).toEqual({});
    hits = [{ ...globalHit, ...metadata, score: 0.98, content: "同一筆記憶的更新文字" },
      { ...globalHit, id: 18, content: "本輪新記憶" }];
    const third = (await run(3)).injectSteps?.[0]?.systemMessage.systemMessage;
    expect(third).toContain("本輪新記憶");
    expect(third).not.toContain("同一筆記憶的更新文字");

    hits = hits.slice(0, 1);
    for (let turn = 4; turn <= DEFAULT_HOOK_DEDUPE_TTL; turn += 1) expect(await run(turn)).toEqual({});
    const expired = await run(DEFAULT_HOOK_DEDUPE_TTL + 1);
    if (canRepeat) expect(expired.injectSteps?.[0]?.systemMessage.systemMessage).toContain("同一筆記憶的更新文字");
    else expect(expired).toEqual({});

    const disabled = await run(DEFAULT_HOOK_DEDUPE_TTL + 2, { MNEMOSHELF_RECALL_DEDUPE_TTL: "0" });
    expect(disabled.injectSteps).toHaveLength(1);
    expect(await run(DEFAULT_HOOK_DEDUPE_TTL + 2, { MNEMOSHELF_RECALL_DEDUPE_TTL: "0" })).toEqual({});
    const everyTurn = await run(DEFAULT_HOOK_DEDUPE_TTL + 2, { MNEMOSHELF_RECALL_MODE: "every-turn" });
    expect(everyTurn.injectSteps).toHaveLength(1);
  });

  it("舊版狀態保留回合步數與擷取游標，下一輪開始記錄跨回合去重", async () => {
    const conversationId = "legacy-state";
    const file = hookStateFile(stateDir, conversationId);
    await mkdir(stateDir, { mode: 0o700 });
    await writeFile(file, JSON.stringify({ lastInitialNumSteps: 3, lastCapturedUserStepIndex: 2 }), { mode: 0o600 });
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (url) =>
      url === `${baseUrl}/health`
        ? Response.json({ service: "mnemoshelf" })
        : Response.json({ degraded: false, hits: [globalHit] }));
    const run = (initialNumSteps: number) => runAntigravityPreInvocation(
      Readable.from([JSON.stringify({ conversationId, initialNumSteps, lastUserInput: "請確認專案設定" })]),
      { env: { MNEMOSHELF_RUNTIME_FILE: runtimeFile }, fetchImpl, homeDir, stateDir },
    );
    expect(await run(3)).toEqual({});
    expect(fetchImpl).not.toHaveBeenCalled();
    expect((await run(4)).injectSteps).toHaveLength(1);
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({
      lastCapturedUserStepIndex: 2, lastInitialNumSteps: 4, turnCount: 1,
      injected: { "id:17": { turn: 1, kind: "fact", pinned: false } },
    });
  });

  it("Stop 解析 transcript.jsonl（含真實宿主標籤與過場步驟過濾）並維持游標去重", async () => {
    const transcriptFile = path.join(tempDir, "transcript.jsonl");
    const fullTranscriptFile = path.join(tempDir, "transcript_full.jsonl");

    const wrappedUserFull = [
      "<USER_REQUEST>",
      "@[Quote] 第一題完整提問內容",
      "</USER_REQUEST>",
      "<ADDITIONAL_METADATA>",
      "The current local time is: 2026-11-21T19:00:00+08:00.",
      "</ADDITIONAL_METADATA>",
      "<USER_SETTINGS_CHANGE>",
      "The user changed setting Model Selection.",
      "</USER_SETTINGS_CHANGE>",
    ].join("\n");

    const lines = [
      {
        step_index: 0,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        status: "DONE",
        created_at: "2026-11-13T10:00:00Z",
        content: "<USER_REQUEST>\n第一題截斷...",
        truncated_fields: ["content"],
      },
      {
        step_index: 1,
        source: "SYSTEM_SDK",
        type: "SYSTEM_MESSAGE",
        status: "DONE",
        created_at: "2026-11-13T10:00:00Z",
        content: "The following is a <SYSTEM_MESSAGE> not actually sent by the user.\n<SYSTEM_MESSAGE>注入</SYSTEM_MESSAGE>",
      },
      {
        step_index: 2,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        status: "DONE",
        created_at: "2026-11-13T10:00:01Z",
        content: "我先幫您讀取專案設定，請稍候…",
        thinking: "內部思考",
        tool_calls: [{ name: "run_command" }],
      },
      {
        step_index: 3,
        source: "MODEL",
        type: "GENERIC",
        status: "DONE",
        created_at: "2026-11-13T10:00:02Z",
        content: "工具輸出不應保存",
      },
      {
        step_index: 4,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        status: "DONE",
        created_at: "2026-11-13T10:00:03Z",
        content: '<memory-context source="mnemoshelf">不應殘留</memory-context>\n第一題完整回答',
      },
      {
        step_index: 5,
        source: "SYSTEM",
        type: "USER_INPUT",
        status: "DONE",
        created_at: "2026-11-13T10:00:04Z",
        content: "系統注入不應保存",
      },
      // 第二回合只有工具過場句、沒有最終實質回覆 -> 應整回合略過
      {
        step_index: 6,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        status: "DONE",
        created_at: "2026-11-13T10:01:00Z",
        content: "<USER_REQUEST>\n未完成的第二題\n</USER_REQUEST>",
      },
      {
        step_index: 7,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        status: "DONE",
        created_at: "2026-11-13T10:01:01Z",
        content: "正在幫您檢查…",
        tool_calls: [{ name: "read_file" }],
      },
    ];
    await writeFile(transcriptFile, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    await writeFile(
      fullTranscriptFile,
      JSON.stringify({
        step_index: 0,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        status: "DONE",
        created_at: "2026-11-13T10:00:00Z",
        content: wrappedUserFull,
      }) + "\n",
    );

    const parsed = await parseAntigravityTurns(transcriptFile);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.userStep.content).toBe("@[Quote] 第一題完整提問內容");
    expect(parsed[0]?.assistantSteps).toHaveLength(1);
    expect(parsed[0]?.assistantSteps[0]?.content).toBe("第一題完整回答");

    const captured: unknown[] = [];
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
      if (url === `${baseUrl}/health`) return Response.json({ service: "mnemoshelf" });
      if (url === `${baseUrl}/memory-policy`) return Response.json({ maskSecrets: false, version: 1 });
      if (url === `${baseUrl}/memory-sources`) {
        captured.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ saved: true, duplicate: false, source: { id: 99 } }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected url: ${String(url)}`);
    });

    const stopPayload = JSON.stringify({
      conversationId: "conv-stop-1",
      workspacePaths: workspaces,
      cwd: path.join(workspaceDir, "src"),
      transcriptPath: transcriptFile,
      terminationReason: "NO_TOOL_CALL",
    });

    const opts = {
      env: { MNEMOSHELF_RUNTIME_FILE: runtimeFile },
      homeDir,
      fetchImpl,
      stateDir,
    };

    expect(await runAntigravityStop(Readable.from([stopPayload]), opts)).toEqual({});
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      agent: "antigravity/turn",
      sourceSession: "conv-stop-1",
      sourceTurn: "turn-0",
      project: "demo-app",
      messages: [
        { sourceMessage: "step-0", role: "user", content: "@[Quote] 第一題完整提問內容" },
        { sourceMessage: "step-4", role: "assistant", content: "第一題完整回答" },
      ],
    });

    // 再次觸發 Stop（無新回合）：游標阻擋重複送出
    expect(await runAntigravityStop(Readable.from([stopPayload]), opts)).toEqual({});
    expect(captured).toHaveLength(1);
  });

  it("Stop 遇到 ERROR / USER_CANCELED 時略過不保存", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const out = await runAntigravityStop(
      Readable.from([
        JSON.stringify({
          conversationId: "conv-err",
          workspacePaths: [workspaceDir],
          transcriptPath: path.join(tempDir, "missing.jsonl"),
          terminationReason: "USER_CANCELED",
        }),
      ]),
      { env: { MNEMOSHELF_RUNTIME_FILE: runtimeFile }, homeDir, fetchImpl, stateDir },
    );
    expect(out).toEqual({});
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
