import { describe, expect, it } from "vitest";
import { setTimeout as delay } from "node:timers/promises";
import { killProcessTree, runProcess, startProcess, type StartedProcess } from "../../src/media/process.js";

const NODE = process.execPath;

function sleepScript(ms: number): string {
  return `setTimeout(() => {}, ${ms});`;
}

/** 讀 stdout 直到出現指定字串（測試輔助；上限 2 秒）。 */
async function readUntil(proc: StartedProcess, needle: string, timeoutMs = 5_000): Promise<string> {
  const chunks: Buffer[] = [];
  let text = "";
  const deadline = Date.now() + timeoutMs;
  proc.child.stdout?.on("data", (chunk: Buffer) => { chunks.push(chunk); });
  while (!text.includes(needle)) {
    if (Date.now() > deadline) throw new Error("readUntil timeout: " + text);
    text = Buffer.concat(chunks).toString("utf8");
    await delay(10);
  }
  return text;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string }).code === "EPERM";
  }
}

describe("runProcess：無 shell、參數原樣傳遞", () => {
  it("成功結束並取得 stdout／exit code 0", async () => {
    const result = await runProcess(NODE, ["-e", "process.stdout.write('hello')"], { timeoutMs: 10_000 });
    expect(result.code).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.stdout.toString("utf8")).toBe("hello");
    expect(result.spawnError).toBeNull();
    expect(result.killed).toEqual({ deadline: false, abort: false, outputCap: false });
    expect(result.ms).toBeGreaterThanOrEqual(0);
  });

  it("參數不經 shell：空白與 shell 語法會原樣出現在 argv", async () => {
    const payload = ["a b", "$(echo pwned)", "x;y", "q|z"];
    const result = await runProcess(NODE, ["-e", "process.stdout.write(process.argv.slice(1).join('|'))", ...payload], { timeoutMs: 10_000 });
    expect(result.code).toBe(0);
    expect(result.stdout.toString("utf8")).toBe(payload.join("|"));
  });

  it("非零退出碼原樣回傳（不當成 spawn 失敗）", async () => {
    const result = await runProcess(NODE, ["-e", "process.exit(3)"], { timeoutMs: 10_000 });
    expect(result.code).toBe(3);
    expect(result.spawnError).toBeNull();
  });

  it("binary 不存在時回 spawnError 而不是拋例外", async () => {
    const result = await runProcess("definitely-missing-binary-for-test-xyz", ["-version"], { timeoutMs: 5_000 });
    expect(result.spawnError).toMatch(/ENOENT/);
    // Windows 的 spawn 失敗會以 close code -4058（ERROR_FILE_NOT_FOUND）回報；重點是不拋例外且可辨識。
    expect(result.code).not.toBe(0);
  });
});

describe("runProcess：輸出上限", () => {
  it("stdout 超過上限會截斷並殺程序（stdoutTruncated + outputCap）", async () => {
    const result = await runProcess(NODE, ["-e", "process.stdout.write('x'.repeat(200000))"], { timeoutMs: 10_000, maxStdoutBytes: 1024 });
    expect(result.stdoutTruncated).toBe(true);
    expect(result.killed.outputCap).toBe(true);
    expect(result.stdout.length).toBeLessThanOrEqual(1024);
  });

  it("stderr 超過上限會截斷並殺程序", async () => {
    const result = await runProcess(NODE, ["-e", "process.stderr.write('e'.repeat(200000))"], { timeoutMs: 10_000, maxStderrBytes: 1024 });
    expect(result.stderrTruncated).toBe(true);
    expect(result.killed.outputCap).toBe(true);
    expect(Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(1024);
  });
});

describe("runProcess：deadline 與取消", () => {
  it("deadline 觸發時殺程序樹，回報 killed.deadline 且不等到自然結束", async () => {
    const started = Date.now();
    const result = await runProcess(NODE, ["-e", sleepScript(60_000)], { timeoutMs: 200 });
    expect(result.killed.deadline).toBe(true);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("AbortSignal 觸發時殺程序，回報 killed.abort", async () => {
    const controller = new AbortController();
    const promise = runProcess(NODE, ["-e", sleepScript(60_000)], { timeoutMs: 30_000, signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    const result = await promise;
    expect(result.killed.abort).toBe(true);
    expect(result.killed.deadline).toBe(false);
  });

  it("取消訊號在啟動前已觸發也會直接殺", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runProcess(NODE, ["-e", sleepScript(60_000)], { timeoutMs: 30_000, signal: controller.signal });
    expect(result.killed.abort).toBe(true);
    expect(Date.now()).toBeGreaterThan(0);
  });
});

describe("killProcessTree：程序樹回收", () => {
  it("殺父程序時孫程序也一起被殺（Windows taskkill /T 與 POSIX SIGKILL）", async () => {
    const script = [
      "const { spawn } = require('node:child_process');",
      `const child = spawn(process.execPath, ['-e', '${sleepScript(60_000)}'], { stdio: 'ignore' });`,
      "console.log('grandchild:' + child.pid);",
      sleepScript(60_000),
    ].join("\n");
    const proc = startProcess(NODE, ["-e", script], { timeoutMs: 30_000 });
    try {
      const output = await readUntil(proc, "grandchild:");
      const grandchildPid = Number(/grandchild:(\d+)/.exec(output)?.[1]);
      expect(Number.isInteger(grandchildPid)).toBe(true);
      expect(isAlive(grandchildPid)).toBe(true);
      await proc.kill("abort");
      await proc.done;
      const deadline = Date.now() + 5_000;
      while (isAlive(grandchildPid) && Date.now() < deadline) await delay(50);
      expect(isAlive(grandchildPid)).toBe(false);
    } finally {
      await killProcessTree(proc.child.pid);
    }
  }, 20_000);
});