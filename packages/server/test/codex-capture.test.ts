import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCodexCapture } from "../src/scripts/codex-capture.js";
import { captureTurn } from "../src/scripts/hook-core.js";

const baseUrl = "http://127.0.0.1:4321";
const sessionId = "session-synthetic";
const turnId = "turn-synthetic";
const userText = "  第一行\n\n保留空白與 emoji 🌿\n";
const finalText = "\n  合成回答\n第二行  \n";
const credential = ["synthetic", "credential"].join("-");
let temp: string;
let codexHome: string;
let transcriptPath: string;
let runtimeFile: string;
let stateDir: string;
let cwd: string;

function item(type: string, id: string, text: string, options: Record<string, unknown> = {}) {
  return { type, id, content: [{ type: type === "UserMessage" ? "text" : "Text", text }], ...options };
}

function completed(value: Record<string, unknown>, turn = turnId, extra: Record<string, unknown> = {}) {
  return { type: "event_msg", payload: {
    type: "item_completed", thread_id: sessionId, turn_id: turn, item: value,
    started_at_ms: 1700000000000, completed_at_ms: 1700000000010, ...extra,
  } };
}

function turnRows(turn = turnId) {
  return [
    { type: "event_msg", payload: { type: "task_started", turn_id: turn } },
    completed(item("UserMessage", `user-${turn}`, userText), turn),
    completed(item("AgentMessage", `assistant-${turn}`, finalText, { phase: "final_answer" }), turn),
  ];
}

function rows() {
  return [{ type: "session_meta", payload: { id: sessionId, session_id: sessionId } }, ...turnRows()];
}

async function transcript(values: unknown[] = rows(), file = transcriptPath): Promise<void> {
  await writeFile(file, values.map((value) => JSON.stringify(value)).join("\n") + "\n");
}

function payload(extra: Record<string, unknown> = {}) {
  return { hook_event_name: "Stop", session_id: sessionId, turn_id: turnId, cwd,
    transcript_path: transcriptPath, last_assistant_message: finalText, stop_hook_active: false, ...extra };
}

function service(post: (body: Record<string, unknown>) => Response | Promise<Response> = () =>
  Response.json({ saved: true, duplicate: false, source: { id: 1 } }, { status: 201 })) {
  return vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
    if (url === `${baseUrl}/health`) return Response.json({ service: "mnemoshelf" });
    if (url === `${baseUrl}/memory-policy`) return Response.json({ maskSecrets: false, version: 1 });
    if (url === `${baseUrl}/memory-sources`) return post(JSON.parse(String(init?.body)));
    throw new Error("非預期的測試請求");
  });
}

function options(fetchImpl: typeof fetch) {
  return { env: { CODEX_HOME: codexHome, MNEMOSHELF_RUNTIME_FILE: runtimeFile }, homeDir: temp, stateDir, fetchImpl };
}

async function run(fetchImpl: typeof fetch, extra: Record<string, unknown> = {}) {
  return runCodexCapture(Readable.from([JSON.stringify(payload(extra))]), options(fetchImpl));
}

beforeEach(async () => {
  temp = await mkdtemp(path.join(tmpdir(), "mnemoshelf-codex-capture-"));
  codexHome = path.join(temp, "codex");
  transcriptPath = path.join(codexHome, "sessions", "rollout-synthetic.jsonl");
  runtimeFile = path.join(temp, "runtime.json");
  stateDir = path.join(temp, "state");
  cwd = path.join(temp, "demo-project");
  await mkdir(path.dirname(transcriptPath), { recursive: true });
  await writeFile(runtimeFile, JSON.stringify({ schemaVersion: 1, url: baseUrl, token: credential,
    pid: process.pid, startedAt: "2026-01-01T00:00:00.000Z", appVersion: "0.9.1" }));
  await transcript();
});

afterEach(async () => {
  await rm(temp, { recursive: true, force: true });
});

describe("Codex Stop 原文保存", () => {
  it("按 session／turn／item ID 保存完整原文，保留空白與原始時間；重觸發由本機游標略過", async () => {
    const bodies: unknown[] = [];
    const fetchImpl = service((body) => {
      bodies.push(body);
      return Response.json({ saved: true, duplicate: false, source: { id: 7 } }, { status: 201 });
    });
    expect(await run(fetchImpl)).toEqual({});
    expect(bodies).toEqual([{
      agent: "codex/turn", scope: "project", project: "demo-project", sourceSession: sessionId, sourceTurn: turnId,
      messages: [
        { sourceMessage: `user-${turnId}`, role: "user", content: userText, occurredAt: "2023-11-14T22:13:20.000Z" },
        { sourceMessage: `assistant-${turnId}`, role: "assistant", content: finalText, occurredAt: "2023-11-14T22:13:20.000Z" },
      ],
    }]);
    const count = fetchImpl.mock.calls.length;
    expect(await run(fetchImpl)).toEqual({});
    expect(fetchImpl).toHaveBeenCalledTimes(count);
    const files = await readdir(stateDir);
    expect(files).toHaveLength(1);
    const stateFile = path.join(stateDir, files[0]!);
    const saved = await readFile(stateFile, "utf8");
    expect(saved).not.toContain(userText);
    expect(saved).not.toContain(sessionId);
    expect(JSON.parse(saved)).toMatchObject({ version: 1, saved: true });
    if (process.platform !== "win32") {
      expect((await stat(stateFile)).mode & 0o777).toBe(0o600);
      expect((await stat(stateDir)).mode & 0o777).toBe(0o700);
    }
  });

  it("排除 reasoning、工具與 response_item 系統注入，只收可見 commentary／final 與使用者文字", async () => {
    const markedUser = `保留前段<memory-context>注入<memory-context>巢狀</memory-context>仍是注入</memory-context>保留後段`;
    const markedFinal = "回答<system-reminder>宿主</system-reminder><thinking>推理</thinking>尾端";
    await transcript([
      rows()[0], turnRows()[0],
      { type: "response_item", payload: { role: "user", content: [{ type: "input_text", text: "自動環境" }] } },
      { type: "response_item", payload: { role: "developer", content: [{ type: "input_text", text: "注入記憶" }] } },
      completed(item("UserMessage", "u", markedUser, { content: [
        { type: "text", text: markedUser }, { type: "image", image_url: "合成附件" },
      ] })),
      completed({ type: "Reasoning", id: "r", summary_text: ["隱藏推理"], raw_content: ["隱藏原文"] }),
      completed(item("AgentMessage", "c", "進度說明", { phase: "commentary" })),
      completed({ type: "CommandExecution", id: "tool", command: ["合成命令"], aggregated_output: "工具輸出" }),
      completed(item("AgentMessage", "a", markedFinal, { phase: "final_answer" })),
      { type: "response_item", payload: { role: "assistant", content: [{ type: "output_text", text: markedFinal }] } },
    ]);
    const fetchImpl = service();
    await run(fetchImpl, { last_assistant_message: markedFinal });
    const body = JSON.parse(String(fetchImpl.mock.calls.at(-1)?.[1]?.body));
    expect(body.messages.map((m: { content: string }) => m.content)).toEqual(["保留前段保留後段", "進度說明", "回答尾端"]);
    expect(JSON.stringify(body)).not.toMatch(/隱藏|工具輸出|自動環境|注入記憶/);
  });

  it("無 phase 的已實測 CLI 格式可用；沒有原始時間時保持 null", async () => {
    await transcript([rows()[0], turnRows()[0],
      completed(item("UserMessage", "u", userText), turnId, { started_at_ms: null }),
      completed(item("AgentMessage", "a", finalText), turnId, { started_at_ms: null }),
    ]);
    const fetchImpl = service();
    await run(fetchImpl);
    const body = JSON.parse(String(fetchImpl.mock.calls.at(-1)?.[1]?.body));
    expect(body.messages.every((m: { occurredAt: unknown }) => m.occurredAt === null)).toBe(true);
  });

  it("最後回答僅含非可見區塊時，不以先前 commentary 冒充 final", async () => {
    const hiddenFinal = "<thinking>不保存的內容</thinking>";
    await transcript([rows()[0], turnRows()[0], turnRows()[1],
      completed(item("AgentMessage", "c", "先前進度", { phase: "commentary" })),
      completed(item("AgentMessage", "a", hiddenFinal, { phase: "final_answer" })),
    ]);
    const fetchImpl = service();
    await run(fetchImpl, { last_assistant_message: hiddenFinal });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("未收尾的注入區塊丟棄至文末，不把內容帶回記憶", async () => {
    await transcript([rows()[0], turnRows()[0],
      completed(item("UserMessage", "u", "可見文字\n<memory-context>未收尾注入")), turnRows()[2],
    ]);
    const fetchImpl = service();
    await run(fetchImpl);
    const body = JSON.parse(String(fetchImpl.mock.calls.at(-1)?.[1]?.body));
    expect(body.messages[0].content).toBe("可見文字\n");
  });

  it("只保存指定輪次，同字不同輪次各自保存，不回填歷史", async () => {
    await transcript([rows()[0], ...turnRows("old-turn"), ...turnRows(), ...turnRows("next-turn")]);
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = service((body) => {
      bodies.push(body);
      return Response.json({ saved: true, duplicate: false, source: { id: bodies.length } }, { status: 201 });
    });
    await run(fetchImpl);
    await run(fetchImpl, { turn_id: "next-turn" });
    expect(bodies.map((body) => body.sourceTurn)).toEqual([turnId, "next-turn"]);
    expect(await readdir(stateDir)).toHaveLength(2);
  });

  it("相同 item 重播只收一次；同回合多則使用者文字保留順序", async () => {
    const question = completed(item("UserMessage", "u", userText));
    await transcript([rows()[0], turnRows()[0], question, question,
      completed(item("AgentMessage", "c", "進度", { phase: "commentary" })),
      completed(item("UserMessage", "steering", "補充需求")), turnRows()[2],
    ]);
    const fetchImpl = service();
    await run(fetchImpl);
    const body = JSON.parse(String(fetchImpl.mock.calls.at(-1)?.[1]?.body));
    expect(body.messages.map((m: { role: string }) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
  });

  it.each([
    { hook_event_name: "Interrupt" }, { session_id: "" }, { turn_id: "x".repeat(201) },
    { transcript_path: "relative.jsonl" }, { cwd: "relative" }, { last_assistant_message: null },
    { stop_hook_active: undefined },
  ])("非法 Stop 輸入靜默略過 %#", async (extra) => {
    const fetchImpl = service();
    expect(await run(fetchImpl, extra)).toEqual({});
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(["bad json", "[]", "", JSON.stringify(payload({ last_assistant_message: "x".repeat(256 * 1024) }))])(
    "stdin 錯誤或超限不連線 %#", async (raw) => {
      const fetchImpl = service();
      expect(await runCodexCapture(Readable.from([raw]), options(fetchImpl))).toEqual({});
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it.each([
    "錯 session", "錯 thread", "缺 task_started", "缺使用者", "缺最後回答", "回答尚未 flush",
    "只有 commentary", "未知 phase", "重複 ID 內容衝突", "無效文字", "無效 content", "無效 JSON", "半行", "錯 UTF8",
  ])("不保存不完整或未知 transcript：%s", async (kind) => {
    let values: unknown[] = rows();
    if (kind === "錯 session") values[0] = { type: "session_meta", payload: { id: "another-session" } };
    if (kind === "錯 thread") values[2] = completed(item("UserMessage", "u", userText), turnId, { thread_id: "another-session" });
    if (kind === "缺 task_started") values.splice(1, 1);
    if (kind === "缺使用者") values.splice(2, 1);
    if (kind === "缺最後回答") values.pop();
    if (kind === "回答尚未 flush") values[3] = completed(item("AgentMessage", "a", "部分回答"));
    if (kind === "只有 commentary") values[3] = completed(item("AgentMessage", "a", finalText, { phase: "commentary" }));
    if (kind === "未知 phase") values[3] = completed(item("AgentMessage", "a", finalText, { phase: "analysis" }));
    if (kind === "重複 ID 內容衝突") values.splice(3, 0, completed(item("UserMessage", `user-${turnId}`, "變更內容")));
    if (kind === "無效文字") values[2] = completed(item("UserMessage", "u", "bad\0text"));
    if (kind === "無效 content") values[2] = completed(item("UserMessage", "u", "", { content: [{ type: "text", text: 4 }] }));
    await transcript(values);
    if (kind === "無效 JSON") await writeFile(transcriptPath, "{}\nbad\n");
    if (kind === "半行") await writeFile(transcriptPath, JSON.stringify(rows()[0]));
    if (kind === "錯 UTF8") await writeFile(transcriptPath, Buffer.from([255, 10]));
    const fetchImpl = service();
    expect(await run(fetchImpl)).toEqual({});
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("無法讀取、過大、越界與 symlink 逃逸的 transcript 都不讀入服務", async () => {
    const outside = path.join(temp, "outside.jsonl");
    await transcript(rows(), outside);
    const linked = path.join(path.dirname(transcriptPath), "escape.jsonl");
    await symlink(outside, linked);
    const sibling = path.join(codexHome, "sessions-other");
    await mkdir(sibling);
    const siblingFile = path.join(sibling, "rollout.jsonl");
    await transcript(rows(), siblingFile);
    const fetchImpl = service();
    for (const file of [outside, linked, siblingFile, path.join(temp, "missing.jsonl"), path.dirname(transcriptPath)]) {
      expect(await run(fetchImpl, { transcript_path: file })).toEqual({});
    }
    await truncate(transcriptPath, 32 * 1024 * 1024 + 1);
    expect(await run(fetchImpl)).toEqual({});
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("只有明示本機 runtime 可用；相對 CODEX_HOME 不讀取 transcript", async () => {
    const fetchImpl = service();
    for (const env of [{}, { CODEX_HOME: "relative", MNEMOSHELF_RUNTIME_FILE: runtimeFile },
      { CODEX_HOME: codexHome, MNEMOSHELF_RUNTIME_FILE: "relative" }]) {
      expect(await runCodexCapture(Readable.from([JSON.stringify(payload())]), { ...options(fetchImpl), env })).toEqual({});
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("服務離線不寫游標，同一 Stop 重試可成功", async () => {
    const offline = vi.fn<typeof fetch>().mockRejectedValue(new Error("offline"));
    expect(await run(offline)).toEqual({});
    expect(await readdir(stateDir).catch(() => [])).toEqual([]);
    const fetchImpl = service();
    await run(fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it.each([200, 201, 400, 409, 413, 500])("無有效 saved 確認時不寫游標，HTTP %s 可重觸發", async (status) => {
    const fetchImpl = service(() => Response.json({ ok: true }, { status }));
    await run(fetchImpl);
    await run(fetchImpl);
    expect(fetchImpl.mock.calls.filter(([url]) => url === `${baseUrl}/memory-sources`)).toHaveLength(2);
    expect(await readdir(stateDir).catch(() => [])).toEqual([]);
  });

  it("寫入逾時靜默放行且不確認游標", async () => {
    let posts = 0;
    const fetchImpl = service();
    fetchImpl.mockImplementation(async (url, init) => {
      if (url === `${baseUrl}/health`) return Response.json({ service: "mnemoshelf" });
      if (url === `${baseUrl}/memory-policy`) return Response.json({ maskSecrets: false });
      posts += 1;
      return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("timeout")), { once: true }));
    });
    expect(await run(fetchImpl)).toEqual({});
    expect(posts).toBe(1);
    expect(await readdir(stateDir).catch(() => [])).toEqual([]);
  });

  it("HTTP 200 HTML 不能確認保存，也不能抑制下一次重試", async () => {
    const fetchImpl = service(() => new Response("<html>不是 API 回應</html>", {
      status: 200, headers: { "content-type": "text/html" },
    }));
    await run(fetchImpl);
    await run(fetchImpl);
    expect(fetchImpl.mock.calls.filter(([url]) => url === `${baseUrl}/memory-sources`)).toHaveLength(2);
    expect(await readdir(stateDir).catch(() => [])).toEqual([]);
  });

  it("並行 Stop 使用同一事件與內容，伺服器等冪後本機游標也生效", async () => {
    const saved = new Map<string, string>();
    const fetchImpl = service(async (body) => {
      const key = `${body.sourceSession}:${body.sourceTurn}`;
      const duplicate = saved.has(key);
      if (duplicate) expect(JSON.stringify(body)).toBe(saved.get(key));
      saved.set(key, JSON.stringify(body));
      await new Promise((resolve) => setTimeout(resolve, 15));
      return Response.json({ saved: true, duplicate, source: { id: 8 } }, { status: duplicate ? 200 : 201 });
    });
    expect(await Promise.all([run(fetchImpl), run(fetchImpl)])).toEqual([{}, {}]);
    expect(saved.size).toBe(1);
    expect(await readdir(stateDir)).toHaveLength(1);
    const count = fetchImpl.mock.calls.length;
    await run(fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(count);
  });

  it("游標遺失或損壞時仍用相同事件重送，伺服器 duplicate 可重新確認", async () => {
    const fetchImpl = service();
    await run(fetchImpl);
    const file = path.join(stateDir, (await readdir(stateDir))[0]!);
    await writeFile(file, "broken");
    const duplicate = service(() => Response.json({ saved: true, duplicate: true, source: { id: 1 } }));
    await run(duplicate);
    expect(duplicate).toHaveBeenCalledTimes(3);
    expect(JSON.parse(await readFile(file, "utf8")).saved).toBe(true);
  });

  it("寫入遵守有效遮罩政策，游標不保存任何訊息內容", async () => {
    const syntheticSecret = ["fixture", "secret", "value"].join("-");
    const text = ["password", syntheticSecret].join("=");
    await transcript([rows()[0], turnRows()[0], completed(item("UserMessage", "u", text)), turnRows()[2]]);
    const bodies: string[] = [];
    const fetchImpl = service();
    fetchImpl.mockImplementation(async (url, init) => {
      if (url === `${baseUrl}/health`) return Response.json({ service: "mnemoshelf" });
      if (url === `${baseUrl}/memory-policy`) return Response.json({ maskSecrets: true, version: 1 });
      bodies.push(String(init?.body));
      return Response.json({ saved: true, duplicate: false, source: { id: 2 } }, { status: 201 });
    });
    await run(fetchImpl);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain("[REDACTED:assignment]");
    expect(bodies[0]).not.toContain(syntheticSecret);
    const saved = await readFile(path.join(stateDir, (await readdir(stateDir))[0]!), "utf8");
    expect(saved).not.toContain(syntheticSecret);
    expect(saved).not.toContain("password");
  });
});

describe("共用 captureTurn 成功確認", () => {
  it.each([{}, { saved: false, duplicate: false, source: { id: 1 } },
    { saved: true, duplicate: false, source: { id: 0 } },
    { saved: true, source: { id: 1 } },
  ])("不把未知成功 JSON 當已保存 %#", async (body) => {
    const fetchImpl = service(() => Response.json(body));
    expect(await captureTurn({ agent: "test/turn", sessionId, turnId, cwd, ...options(fetchImpl),
      messages: [{ messageId: "u", role: "user", content: userText, occurredAt: null }],
    })).toEqual({ status: "offline" });
  });
});
