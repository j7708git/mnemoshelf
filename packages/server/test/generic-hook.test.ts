import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseGenericHookArgs, readFieldPath, runGenericRecall } from "../src/scripts/generic-hook.js";
import { isCodeHeavy, queryFromPrompt, shouldSkipAutoRecallPrompt } from "../src/scripts/hook-core.js";

const baseUrl = "http://127.0.0.1:4322";
const credential = ["synthetic", "gen", "token"].join("-");
const homeDir = path.join(path.parse(tmpdir()).root, "synthetic-home");
const workspaceDir = path.join(homeDir, "repos", "my-app");

let tempDir: string;
let runtimeFile: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "mnemoshelf-generic-hook-test-"));
  runtimeFile = path.join(tempDir, "runtime.json");
  await writeFile(
    runtimeFile,
    JSON.stringify({
      schemaVersion: 1,
      url: baseUrl,
      token: credential,
      pid: process.pid,
      startedAt: "2026-11-13T00:00:00.000Z",
      appVersion: "0.9.1",
    }),
  );
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

function mockFetch() {
  return vi.fn<typeof fetch>().mockImplementation(async (url) => {
    if (url === `${baseUrl}/health`) return Response.json({ service: "mnemoshelf" });
    if (url === `${baseUrl}/memories/search`) {
      return Response.json({
        degraded: false,
        policyVersion: 1,
        hits: [
          {
            source: "semantic",
            scope: "project",
            project: "my-app",
            kind: "fact",
            score: 0.88,
            content: "通用測試記憶",
          },
        ],
      });
    }
    throw new Error(`unexpected url: ${String(url)}`);
  });
}

describe("通用 Hook CLI 入口", () => {
  it("以 60% 圍欄占比及 10 行、平均行長小於 20 判定程式碼", () => {
    expect(isCodeHeavy("12345\n```abc```")).toBe(true);
    expect(isCodeHeavy("123456\n```abc```")).toBe(false);
    expect(isCodeHeavy("~~~\nconst ok = true;\n~~~")).toBe(true);
    expect(isCodeHeavy(Array(10).fill("x".repeat(19)).join("\r\n"))).toBe(true);
    expect(isCodeHeavy(Array(10).fill("x".repeat(20)).join("\n"))).toBe(false);
    expect(isCodeHeavy(Array(9).fill("at run()").join("\n"))).toBe(false);
    expect(isCodeHeavy(" \n ")).toBe(false);
  });

  it.each(["@[qUoTe] 好", "@[Quote]", "```ts\nconst ok = true;\n```", Array(12).fill("at run()").join("\n")])(
    "低資訊提示不發 HTTP（%j）",
    async (prompt) => {
      const fetchImpl = mockFetch();
      expect(shouldSkipAutoRecallPrompt(prompt)).toBe(true);
      expect(await runGenericRecall(
        Readable.from([JSON.stringify({ prompt, cwd: workspaceDir })]),
        parseGenericHookArgs(["--preset", "claude-code"]),
        { env: { MNEMOSHELF_RUNTIME_FILE: runtimeFile }, homeDir, fetchImpl },
      )).toBeNull();
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it("向量查詢剝除引用標記，保留明確的短提示與正常問題", async () => {
    const fetchImpl = mockFetch();
    const prompt = "@[qUoTe] 請幫我確認上次建置指令";
    const query = "請幫我確認上次建置指令";
    expect(queryFromPrompt(prompt)).toBe(query);
    expect(shouldSkipAutoRecallPrompt("@[Quote] 上次呢")).toBe(false);
    expect(await runGenericRecall(
      Readable.from([JSON.stringify({ prompt, cwd: workspaceDir })]),
      parseGenericHookArgs(["--preset", "claude-code"]),
      { env: { MNEMOSHELF_RUNTIME_FILE: runtimeFile }, homeDir, fetchImpl },
    )).toMatchObject({ hookSpecificOutput: { additionalContext: expect.stringContaining("通用測試記憶") } });
    expect(JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body))).toMatchObject({ query });
  });

  it("支援點號路徑讀取巢狀物件與陣列索引", () => {
    expect(readFieldPath({ workspacePaths: [workspaceDir] }, "workspacePaths.0")).toBe(workspaceDir);
    expect(readFieldPath({ a: { b: "ok" } }, "a.b")).toBe("ok");
    expect(readFieldPath({ workspacePaths: [] }, "workspacePaths.0")).toBeUndefined();
  });

  it("依 --preset 對應各家輸入欄位與輸出格式", async () => {
    const fetchImpl = mockFetch();
    const env = { MNEMOSHELF_RUNTIME_FILE: runtimeFile };

    const claudeCfg = parseGenericHookArgs(["--preset", "claude-code"]);
    const claudeOut = await runGenericRecall(
      Readable.from([JSON.stringify({ prompt: "請問架構是什麼？", cwd: workspaceDir })]),
      claudeCfg,
      { env, homeDir, fetchImpl },
    );
    expect(claudeOut).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: expect.stringContaining("通用測試記憶"),
      },
    });

    const agCfg = parseGenericHookArgs(["--preset", "antigravity"]);
    const agOut = await runGenericRecall(
      Readable.from([JSON.stringify({ lastUserInput: "請問架構是什麼？", workspacePaths: [workspaceDir] })]),
      agCfg,
      { env, homeDir, fetchImpl },
    );
    expect(agOut).toMatchObject({
      injectSteps: [{ systemMessage: { systemMessage: expect.stringContaining("通用測試記憶") } }],
      terminationBehavior: "",
    });

    const cursorCfg = parseGenericHookArgs(["--preset", "cursor"]);
    const cursorOut = await runGenericRecall(
      Readable.from([JSON.stringify({ prompt: "請問架構是什麼？", workspace_roots: [workspaceDir] })]),
      cursorCfg,
      { env, homeDir, fetchImpl },
    );
    expect(cursorOut).toMatchObject({
      additionalContext: expect.stringContaining("通用測試記憶"),
    });
  });

  it("支援自訂欄位與離線安全降級", async () => {
    const cfg = parseGenericHookArgs([
      "--event-name",
      "CustomEvent",
      "--prompt-field",
      "input.text",
      "--cwd-field",
      "meta.dir",
      "--output-mode",
      "hookSpecificOutput",
    ]);
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error("offline"));
    const out = await runGenericRecall(
      Readable.from([JSON.stringify({ input: { text: "查詢" }, meta: { dir: workspaceDir } })]),
      cfg,
      { env: { MNEMOSHELF_RUNTIME_FILE: runtimeFile }, homeDir, fetchImpl },
    );
    expect(out).toBeNull();
  });
});
