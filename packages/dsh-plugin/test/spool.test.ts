import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSourceSpool } from "../src/spool.js";
import type { SourceWriteRequest } from "../src/raw-memory.js";

const connection = { baseUrl: "http://127.0.0.1:43117", token: "fixture-auth" };
let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "mnemoshelf-dsh-raw-spool-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function payload(turn: number, content = "fixture"): SourceWriteRequest {
  return {
    scope: "global", agent: "dsh/turn", sourceSession: "s", sourceTurn: String(turn),
    messages: [{ role: "user", sourceMessage: "u", content, occurredAt: null }],
  };
}

function success(source: SourceWriteRequest, duplicate = false): Response {
  return Response.json({
    source: {
      ...source, messages: undefined, messageCount: source.messages.length, id: 1,
      createdAt: "2026-01-01T00:00:00.000Z", chunkVersion: "raw-v1",
    },
    saved: true, duplicate, policyVersion: 1, memoryIds: [1], redacted: false, redactedCount: 0,
  }, { status: duplicate ? 200 : 201 });
}

describe("原文 spool", () => {
  it("離線遮完整訊息，重送相同事件不覆蓋；合法 duplicate 才刪除", async () => {
    const logs: unknown[] = [];
    const first = createSourceSpool({ dir, log: (event, fields) => logs.push([event, fields]) });
    const secret = "m".repeat(28);
    const visible = "前面".repeat(650) + "Bearer " + secret + " 中尾🚦\r\n";
    await first.add(payload(1, visible), async () => null);
    await first.add(payload(1, "重新收到的改稿"), async () => null);
    const names = await fs.readdir(dir);
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^raw-[0-9a-f]{64}\.json$/);
    const file = path.join(dir, names[0]!);
    const saved = JSON.parse(await fs.readFile(file, "utf8"));
    const expected = payload(1, visible.replace(secret, "[REDACTED:bearer]"));
    expect(saved).toEqual({ schemaVersion: 2, payload: expected });
    expect(JSON.stringify(saved)).not.toContain(connection.token);
    if (process.platform !== "win32") {
      expect((await fs.stat(dir)).mode & 0o777).toBe(0o700);
      expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    }
    const posts: unknown[] = [];
    const second = createSourceSpool({
      dir, log: () => undefined,
      fetchImpl: async (url, init) => {
        if (String(url).endsWith("/memory-policy")) return Response.json({ maskSecrets: false, version: 2 });
        const body = JSON.parse(String(init?.body));
        posts.push(body);
        return success(body, true);
      },
    });
    await second.flush(async () => connection);
    expect(posts).toEqual([expected]);
    expect(await fs.readdir(dir)).toEqual([]);
    expect(JSON.stringify(logs)).not.toContain(secret);
  });

  it("政策明確關閉時保持原文；舊 schema 保留而不誤送，413 不阻擋其他事件", async () => {
    const logs: string[] = [];
    const legacyFile = path.join(dir, "old.json");
    const legacy = JSON.stringify({ schemaVersion: 1, payload: { content: "舊卡片" } });
    await fs.writeFile(legacyFile, legacy);
    let accept = false;
    const posts: SourceWriteRequest[] = [];
    const spool = createSourceSpool({
      dir, log: (_event, fields) => { if (typeof fields?.reason === "string") logs.push(fields.reason); },
      fetchImpl: async (url, init) => {
        if (String(url).endsWith("/memory-policy")) return Response.json({ maskSecrets: accept, version: accept ? 2 : 1 });
        const body = JSON.parse(String(init?.body)) as SourceWriteRequest;
        posts.push(body);
        if (!accept) return Response.json({}, { status: 503 });
        if (body.sourceTurn === "1") return Response.json({}, { status: 413 });
        return success(body);
      },
    });
    const plain = payload(1, "Bearer " + "k".repeat(24));
    await spool.add(plain, async () => connection);
    await spool.add(payload(2), async () => connection);
    expect(await fs.readdir(dir)).toHaveLength(3);
    accept = true;
    await spool.flush(async () => connection);
    expect(posts.filter((body) => body.sourceTurn === "1")).toEqual([plain, plain]);
    expect(posts.filter((body) => body.sourceTurn === "2")).toHaveLength(2);
    expect(await fs.readFile(legacyFile, "utf8")).toBe(legacy);
    expect(await fs.readdir(dir)).toHaveLength(2);
    expect(logs).toContain("legacy-spool-needs-migration");
    expect(logs).toContain("source-too-large");
  });

  it("超過舊上限仍保留所有事件", async () => {
    const spool = createSourceSpool({ dir, log: () => undefined });
    await Promise.all(Array.from({ length: 205 }, (_, index) => spool.add(payload(index), async () => null)));
    expect(await fs.readdir(dir)).toHaveLength(205);
  }, 15000);
});
