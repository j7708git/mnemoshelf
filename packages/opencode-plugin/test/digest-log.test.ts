/**
 * digest 診斷紀錄：路徑、欄位、權限、輪替。
 *
 * 這裡直接測 `digest-log.ts`（真正的檔案 I/O），不經過 digest runtime；
 * runtime 的整合測試在 `digest-runtime.test.ts`。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  DIGEST_LOG_DIR_MODE,
  DIGEST_LOG_FILE_MODE,
  DIGEST_LOG_MAX_BYTES,
  DIGEST_LOG_MAX_REASON_CHARS,
  appendDigestLog,
  digestLogPath,
  digestSessionHash,
  formatDigestLogLine,
  type DigestLogEntry,
} from "../src/digest-log.js";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mnemoshelf-digest-log-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function entry(overrides: Partial<DigestLogEntry> = {}): DigestLogEntry {
  return {
    at: "2026-10-22T10:00:00.000Z",
    session: "deadbeef",
    state: "ok",
    model: "cheap/test-model",
    latencyMs: 1234,
    items: 2,
    written: 1,
    ...overrides,
  };
}

describe("digestLogPath", () => {
  it("預設在 XDG_STATE_HOME 之下", () => {
    const stateHome = path.join(path.sep, "work", "state");
    expect(
      digestLogPath({ platform: "linux", env: { XDG_STATE_HOME: stateHome }, home: path.join(path.sep, "work", "home") }),
    ).toBe(path.join(stateHome, "mnemoshelf-plugin", "digest.log"));
  });

  it("沒有 XDG_STATE_HOME 時用 ~/.local/state", () => {
    const home = path.join(path.sep, "work", "home");
    expect(digestLogPath({ platform: "linux", env: {}, home })).toBe(
      path.join(home, ".local", "state", "mnemoshelf-plugin", "digest.log"),
    );
  });

  it("XDG_STATE_HOME 是相對路徑時忽略（XDG 要求絕對路徑）", () => {
    const home = path.join(path.sep, "work", "home");
    expect(digestLogPath({ platform: "linux", env: { XDG_STATE_HOME: "relative/state" }, home })).toBe(
      path.join(home, ".local", "state", "mnemoshelf-plugin", "digest.log"),
    );
  });

  it("Windows 用 win32 分隔符，規則相同", () => {
    expect(digestLogPath({ platform: "win32", env: {}, home: "C:\\work\\home" })).toBe(
      "C:\\work\\home\\.local\\state\\mnemoshelf-plugin\\digest.log",
    );
  });
});

describe("digestSessionHash", () => {
  it("固定 8 碼 hex、穩定、不同 session 不同", () => {
    const first = digestSessionHash("session-abc");
    expect(first).toMatch(/^[0-9a-f]{8}$/);
    expect(digestSessionHash("session-abc")).toBe(first);
    expect(digestSessionHash("session-abd")).not.toBe(first);
    expect(first).not.toContain("session");
  });
});

describe("formatDigestLogLine", () => {
  it("輸出單行 JSON，欄位固定（ok 沒有 reason）", () => {
    const line = formatDigestLogLine(entry());
    expect(line).not.toContain("\n");
    expect(JSON.parse(line)).toEqual({
      at: "2026-10-22T10:00:00.000Z",
      session: "deadbeef",
      state: "ok",
      model: "cheap/test-model",
      latencyMs: 1234,
      items: 2,
      written: 1,
    });
  });

  it("新欄位（duplicates／failed／cards）只在有值時輸出；卡片只有 role／state／status", () => {
    const line = formatDigestLogLine(
      entry({
        state: "ok",
        written: 1,
        duplicates: 1,
        failed: 1,
        cards: [
          { role: "turn", state: "ok" },
          { role: "item", state: "duplicate" },
          { role: "item", state: "failed", status: 500 },
        ],
      }),
    );
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      state: "ok",
      written: 1,
      duplicates: 1,
      failed: 1,
      cards: [
        { role: "turn", state: "ok" },
        { role: "item", state: "duplicate" },
        { role: "item", state: "failed", status: 500 },
      ],
    });
    // 卡片不得帶內容：只有 role／state／status 三個鍵。
    for (const card of parsed.cards as Record<string, unknown>[]) {
      expect(Object.keys(card).sort()).toEqual(
        Object.keys(card).includes("status") ? ["role", "state", "status"] : ["role", "state"],
      );
    }
  });

  it("舊格式（沒有新欄位）仍輸出原本的固定欄位", () => {
    const parsed = JSON.parse(formatDigestLogLine(entry())) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual([
      "at",
      "session",
      "state",
      "model",
      "latencyMs",
      "items",
      "written",
    ]);
  });

  it("失敗的 reason 壓成單行並截到 200 字元", () => {
    const line = formatDigestLogLine(
      entry({
        state: "failed",
        reason: `Generate.Error: ${"x".repeat(500)}\n第二行`,
        items: 0,
        written: 0,
      }),
    );
    const parsed = JSON.parse(line) as { reason: string };
    expect(parsed.reason.startsWith("Generate.Error: xxx")).toBe(true);
    expect(parsed.reason).not.toContain("\n");
    expect([...parsed.reason].length).toBe(DIGEST_LOG_MAX_REASON_CHARS);
  });
});

describe("appendDigestLog", () => {
  it("建立目錄與檔案，權限 0700／0600（POSIX），每筆一行", async () => {
    const dir = await tempDir();
    const file = path.join(dir, "nested", "digest.log");
    await appendDigestLog(file, formatDigestLogLine(entry({ state: "skipped", reason: "already", items: 0, written: 0 })));
    await appendDigestLog(file, formatDigestLogLine(entry()));

    const lines = (await fs.readFile(file, "utf8")).split("\n").filter((line) => line !== "");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toMatchObject({ state: "skipped", reason: "already", items: 0, written: 0 });
    expect(JSON.parse(lines[1])).toMatchObject({ state: "ok", items: 2, written: 1 });

    if (process.platform !== "win32") {
      const dirStat = await fs.stat(path.dirname(file));
      const fileStat = await fs.stat(file);
      expect(dirStat.mode & 0o777).toBe(DIGEST_LOG_DIR_MODE);
      expect(fileStat.mode & 0o777).toBe(DIGEST_LOG_FILE_MODE);
    }
  });

  it("超過上限時輪替成 .1，只留一份", async () => {
    const dir = await tempDir();
    const file = path.join(dir, "digest.log");
    // 每行約 130 bytes；上限 300 bytes → 第三行寫入前輪替。
    const line = formatDigestLogLine(entry());
    await appendDigestLog(file, line, { maxBytes: 300 });
    await appendDigestLog(file, line, { maxBytes: 300 });
    expect((await fs.readFile(file, "utf8")).trim().split("\n")).toHaveLength(2);
    await appendDigestLog(file, line, { maxBytes: 300 });

    const rotated = `${file}.1`;
    expect((await fs.stat(rotated)).isFile()).toBe(true);
    // 主檔只剩最新一行；.1 保留輪替前的內容。
    expect((await fs.readFile(file, "utf8")).trim().split("\n")).toHaveLength(1);
    expect((await fs.readFile(rotated, "utf8")).trim().split("\n")).toHaveLength(2);

    // 再輪替一次：`.1` 被覆蓋，不會出現 `.2`。
    for (let round = 0; round < 5; round += 1) {
      await appendDigestLog(file, line, { maxBytes: 300 });
    }
    await expect(fs.stat(`${file}.2`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("預設上限真的是 1 MiB：連續寫入超過就輪替", async () => {
    const dir = await tempDir();
    const file = path.join(dir, "digest.log");
    const line = JSON.stringify({ at: "2026-10-22T10:00:00.000Z", pad: "x".repeat(64 * 1024) });
    expect(Buffer.byteLength(`${line}\n`)).toBeGreaterThan(64 * 1024);

    let lines = 0;
    while (lines < 17) {
      await appendDigestLog(file, line);
      lines += 1;
    }

    expect(DIGEST_LOG_MAX_BYTES).toBe(1024 * 1024);
    expect((await fs.stat(`${file}.1`)).size).toBeLessThanOrEqual(DIGEST_LOG_MAX_BYTES);
    expect((await fs.stat(file)).size).toBeLessThanOrEqual(DIGEST_LOG_MAX_BYTES);
  });
});
