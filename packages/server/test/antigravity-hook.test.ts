import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseAntigravityTurns,
  runAntigravityPreInvocation,
  runAntigravityStop,
} from "../src/scripts/antigravity-hook.js";
import { captureTurn, recallForPrompt, sanitizeRawText } from "../src/scripts/hook-core.js";

const baseUrl = "http://127.0.0.1:4321";
const credential = ["synthetic", "ag", "token"].join("-");
const homeDir = path.join(path.parse(tmpdir()).root, "synthetic-home");
const workspaceDir = path.join(homeDir, "work", "demo-app");

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
  it("sanitizeRawText 會移除 NUL 與孤立 surrogate，保留合法 emoji", () => {
    const dirty = `abc\0def\uD800ghi\uDC00jkl🪴`;
    expect(sanitizeRawText(dirty)).toBe("abcdefghijkl🪴");
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
              score: 0.91,
              content: "專案預設使用 pnpm",
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
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("Stop 解析 transcript.jsonl（含 transcript_full 補全），排除工具輸出並維持游標去重", async () => {
    const transcriptFile = path.join(tempDir, "transcript.jsonl");
    const fullTranscriptFile = path.join(tempDir, "transcript_full.jsonl");

    const lines = [
      { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: "2026-11-13T10:00:00Z", content: "第一題截斷...", truncated_fields: ["content"] },
      { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-13T10:00:01Z", thinking: "內部思考", tool_calls: [{ name: "run_command" }] },
      { step_index: 2, source: "MODEL", type: "GENERIC", status: "DONE", created_at: "2026-11-13T10:00:02Z", content: "工具輸出不應保存" },
      { step_index: 3, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-13T10:00:03Z", content: "第一題完整回答" },
      { step_index: 4, source: "SYSTEM", type: "USER_INPUT", status: "DONE", created_at: "2026-11-13T10:00:04Z", content: "系統注入不應保存" },
    ];
    await writeFile(transcriptFile, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    await writeFile(
      fullTranscriptFile,
      JSON.stringify({ step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: "2026-11-13T10:00:00Z", content: "第一題完整提問內容" }) + "\n",
    );

    const parsed = await parseAntigravityTurns(transcriptFile);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.userStep.content).toBe("第一題完整提問內容");
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
      workspacePaths: [workspaceDir],
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
      messages: [
        { sourceMessage: "step-0", role: "user", content: "第一題完整提問內容" },
        { sourceMessage: "step-3", role: "assistant", content: "第一題完整回答" },
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
