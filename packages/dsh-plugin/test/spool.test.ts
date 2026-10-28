import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { flushSpool, postMemory, spoolHash, writeSpool } from "../src/spool.js";
import type { Connection, LogFn, MemoryWritePayload } from "../src/types.js";

const CONNECTION: Connection = {
  baseUrl: "http://127.0.0.1:12345",
  token: "test-token",
  source: "env",
};

const log: LogFn = () => {
  // 測試不輸出 log。
};

function payload(index: number, content?: string): MemoryWritePayload {
  return {
    content: content ?? `第 ${index} 筆合成記憶內容，用來驗證 spool 行為。`,
    kind: "fact",
    scope: "project",
    project: "mnemoshelf",
    agent: "dsh/turn",
    sourceSession: "session-test",
    sourceMessage: String(index),
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "mnemoshelf-spool-test-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("writeSpool", () => {
  it("原子寫入：檔名含時間與雜湊、0600、目錄 0700、不含 token", async () => {
    const name = await writeSpool({
      dir,
      payload: payload(1),
      now: new Date("2026-10-28T10:00:00.000Z"),
      log,
    });
    expect(name).toMatch(/^\d+-[0-9a-f]{12}\.json$/);
    const files = await readdir(dir);
    expect(files).toEqual([name]);

    const fileStat = await stat(path.join(dir, name as string));
    expect(fileStat.mode & 0o777).toBe(0o600);
    const dirStat = await stat(dir);
    expect(dirStat.mode & 0o777).toBe(0o700);

    const text = await readFile(path.join(dir, name as string), "utf8");
    const record = JSON.parse(text);
    expect(Object.keys(record).sort()).toEqual(["createdAt", "payload", "schemaVersion"]);
    expect(text).not.toContain("test-token");
    expect(text).not.toContain("127.0.0.1");
    expect(record.payload.agent).toBe("dsh/turn");
  });

  it("同內容只留一份（用雜湊去重）", async () => {
    const first = await writeSpool({ dir, payload: payload(1), log });
    const second = await writeSpool({ dir, payload: payload(1), log });
    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(await readdir(dir)).toHaveLength(1);
  });

  it("上限 200 筆，超過丟最舊", async () => {
    const base = new Date("2026-10-01T00:00:00.000Z").getTime();
    for (let index = 0; index < 202; index += 1) {
      await writeSpool({
        dir,
        payload: payload(index),
        now: new Date(base + index),
        log,
      });
    }
    const files = await readdir(dir);
    expect(files).toHaveLength(200);
    const names = files.map((name) => path.basename(name));
    expect(names.some((name) => name.endsWith(`-${spoolHash(payload(0))}.json`))).toBe(false);
    expect(names.some((name) => name.endsWith(`-${spoolHash(payload(1))}.json`))).toBe(false);
    expect(names.some((name) => name.endsWith(`-${spoolHash(payload(201))}.json`))).toBe(true);
  });
});

describe("flushSpool", () => {
  async function spoolOne(index = 1): Promise<string> {
    const name = await writeSpool({ dir, payload: payload(index), log });
    return name as string;
  }

  it("201 成功後刪除", async () => {
    const name = await spoolOne();
    const fetchImpl = (async () => jsonResponse({ id: 7, duplicate: false }, 201)) as typeof fetch;
    const result = await flushSpool({ dir, connection: CONNECTION, log, fetchImpl });
    expect(result).toMatchObject({ sent: 1, failed: 0, deferred: 0, remaining: 0 });
    expect(await readdir(dir)).not.toContain(name);
  });

  it("200 duplicate 視為成功並刪除", async () => {
    const name = await spoolOne();
    const fetchImpl = (async () => jsonResponse({ id: 7, duplicate: true }, 200)) as typeof fetch;
    const result = await flushSpool({ dir, connection: CONNECTION, log, fetchImpl });
    expect(result).toMatchObject({ duplicate: 1, remaining: 0 });
    expect(await readdir(dir)).not.toContain(name);
  });

  it("4xx（非 429）移到 failed/，不無限重試", async () => {
    const name = await spoolOne();
    const fetchImpl = (async () => jsonResponse({}, 400)) as typeof fetch;
    const result = await flushSpool({ dir, connection: CONNECTION, log, fetchImpl });
    expect(result).toMatchObject({ failed: 1, remaining: 0 });
    expect(await readdir(dir)).not.toContain(name);
    expect(await readdir(path.join(dir, "failed"))).toContain(name);
  });

  it("429 與 5xx 保留，留給下一輪", async () => {
    const name = await spoolOne();
    for (const status of [429, 503]) {
      const fetchImpl = (async () => jsonResponse({}, status)) as typeof fetch;
      const result = await flushSpool({ dir, connection: CONNECTION, log, fetchImpl });
      expect(result).toMatchObject({ deferred: 1, remaining: 1 });
      expect(await readdir(dir)).toContain(name);
    }
  });

  it("連線失敗保留；沒有連線時全部 deferred", async () => {
    await spoolOne(1);
    await spoolOne(2);
    const offline = await flushSpool({ dir, connection: null, log });
    expect(offline).toMatchObject({ deferred: 2, remaining: 2 });

    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    const failed = await flushSpool({ dir, connection: CONNECTION, log, fetchImpl });
    expect(failed).toMatchObject({ deferred: 1, remaining: 2 });
  });

  it("損壞的 spool 檔移到 failed/", async () => {
    await writeSpool({ dir, payload: payload(1), log });
    const name = "1-badbadbadbad.json";
    await writeFile(path.join(dir, name), "{not json", "utf8");

    const result = await flushSpool({ dir, connection: CONNECTION, log });
    expect(result.failed).toBeGreaterThanOrEqual(1);
    expect(await readdir(path.join(dir, "failed"))).toContain(name);
  });
});

describe("postMemory", () => {
  it("200／201 成功，其餘視為失敗", async () => {
    const ok = await postMemory({
      connection: CONNECTION,
      payload: payload(1),
      fetchImpl: (async () => jsonResponse({ duplicate: true }, 200)) as typeof fetch,
    });
    expect(ok).toEqual({ ok: true, status: 200, duplicate: true });

    const bad = await postMemory({
      connection: CONNECTION,
      payload: payload(1),
      fetchImpl: (async () => jsonResponse({}, 422)) as typeof fetch,
    });
    expect(bad).toEqual({ ok: false, status: 422, reason: "http" });
  });
});
