/**
 * REST 整合測試：暫存資料目錄＋FakeEmbedder＋port 0。
 *
 * 覆蓋任務卡驗收 1（完整流程）與驗收 2（錯誤語意）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RootNotIndexableError } from "@mnemoshelf/core";
import {
  api,
  errorName,
  makeFixtureRoot,
  NOTE_TOKEN,
  rawHttpRequest,
  removeTempDir,
  SlowEmbedder,
  startTestServer,
  TEST_TOKEN,
  type TestServer,
} from "./helpers.js";
import { MAX_REQUEST_URL_LENGTH, type IndexRootResponse, type ListMemoriesResponse } from "../src/index.js";
import type { RootPreview } from "@mnemoshelf/core";

let server: TestServer | undefined;
const fixtureDirs: string[] = [];

afterEach(async () => {
  await server?.close();
  server = undefined;
  while (fixtureDirs.length > 0) await removeTempDir(fixtureDirs.pop()!);
});

async function fixture(): Promise<string> {
  const dir = await makeFixtureRoot();
  fixtureDirs.push(dir);
  return dir;
}

describe("REST：health 與授權", () => {
  it("GET /health 免 token", async () => {
    server = await startTestServer();
    const response = await api(server.instance, "GET", "/health", { token: null });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok" });
  });

  it("無 token 的寫入與讀取 → 401（含錯誤格式）", async () => {
    server = await startTestServer();
    const dir = await fixture();

    for (const call of [
      api(server.instance, "POST", "/roots", { body: { path: dir }, token: null }),
      api(server.instance, "GET", "/roots", { token: null }),
      api(server.instance, "POST", "/search", { body: { query: NOTE_TOKEN }, token: null }),
      api(server.instance, "POST", "/memories", { body: { content: "x", agent: "t" }, token: null }),
    ]) {
      const response = await call;
      expect(response.status).toBe(401);
      expect(errorName(response.body)).toBe("UnauthorizedError");
    }
  });

  it("token 錯誤 → 401，且訊息不回傳收到的 token", async () => {
    server = await startTestServer();
    const response = await api(server.instance, "GET", "/roots", { token: "wrong-token" });
    expect(response.status).toBe(401);
    expect(JSON.stringify(response.body)).not.toContain("wrong-token");
    expect(JSON.stringify(response.body)).not.toContain(TEST_TOKEN);
  });

  it("未知路徑 → 404；方法不支援 → 405", async () => {
    server = await startTestServer();
    const notFound = await api(server.instance, "GET", "/nope");
    expect(notFound.status).toBe(404);
    expect(errorName(notFound.body)).toBe("NotFoundError");

    const notAllowed = await api(server.instance, "PUT", "/roots");
    expect(notAllowed.status).toBe(405);
    expect(notAllowed.headers.get("allow")).toBe("GET, POST");
  });
});

describe("REST：roots 生命週期", () => {
  it("加入 → 列出 → 取得 → preview（無寫入）→ index → 增量 → 搜尋 → 刪除", async () => {
    server = await startTestServer();
    const dir = await fixture();

    // 加入
    const created = await api(server.instance, "POST", "/roots", {
      body: { path: dir, modalities: ["text", "code", "image"] },
    });
    expect(created.status).toBe(201);
    const root = created.body as { id: number; path: string; mode: string; modalities: string[] };
    expect(root.path).toBe(await fs.realpath(dir));
    expect(root.mode).toBe("index");
    expect(root.modalities).toEqual(["text", "code", "image"]);

    // 列出／取得
    const listed = await api(server.instance, "GET", "/roots");
    expect((listed.body as { roots: unknown[] }).roots).toHaveLength(1);
    const got = await api(server.instance, "GET", `/roots/${root.id}`);
    expect(got.status).toBe(200);
    expect((got.body as { id: number }).id).toBe(root.id);

    // preview：統計正確且不寫入（索引前搜不到任何東西）
    const before = (await fs.readdir(dir)).sort();
    const preview = await api(server.instance, "POST", `/roots/${root.id}/preview`);
    expect(preview.status).toBe(200);
    const stats = preview.body as RootPreview;
    expect(stats.totalFiles).toBe(3);
    expect(stats.byKind.text.count).toBe(1);
    expect(stats.byKind.code.count).toBe(1);
    expect(stats.byKind.image.count).toBe(1);
    expect(stats.byKind.image.bytes).toBeGreaterThan(0);
    expect((await fs.readdir(dir)).sort()).toEqual(before);

    const beforeIndex = await api(server.instance, "POST", "/search", { body: { query: NOTE_TOKEN } });
    expect((beforeIndex.body as { hits: unknown[] }).hits).toHaveLength(0);

    // index
    const indexed = await api(server.instance, "POST", `/roots/${root.id}/index`);
    expect(indexed.status).toBe(200);
    const result = indexed.body as IndexRootResponse;
    expect(result.total).toBe(3);
    expect(result.processed).toBe(3);
    expect(result.skippedUnchanged).toBe(0);
    expect(result.skippedFiles).toEqual([]);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);

    // 再跑一次：內容未變 → 全部跳過（增量）
    const again = await api(server.instance, "POST", `/roots/${root.id}/index`);
    const second = again.body as IndexRootResponse;
    expect(second.total).toBe(3);
    expect(second.processed).toBe(0);
    expect(second.skippedUnchanged).toBe(3);

    // 三種模式都有結果；hybrid 的 rank 從 1 連續
    for (const mode of ["keyword", "vector", "hybrid"] as const) {
      const response = await api(server.instance, "POST", "/search", { body: { query: NOTE_TOKEN, mode } });
      expect(response.status).toBe(200);
      const body = response.body as { mode: string; hits: { rank: number; type: string }[] };
      expect(body.mode).toBe(mode);
      expect(body.hits.length).toBeGreaterThan(0);
      expect(body.hits.map((hit) => hit.rank)).toEqual(body.hits.map((_hit, index) => index + 1));
    }

    // 命中帶來源
    const hybrid = await api(server.instance, "POST", "/search", { body: { query: NOTE_TOKEN } });
    const hits = (hybrid.body as { hits: { type: string; rootId?: number; relPath?: string; seq?: number; kind?: string }[] }).hits;
    const chunkHit = hits.find((hit) => hit.type === "chunk");
    expect(chunkHit).toBeDefined();
    expect(chunkHit!.rootId).toBe(root.id);
    expect(typeof chunkHit!.relPath).toBe("string");
    expect(typeof chunkHit!.seq).toBe("number");
    expect(["text", "code", "image"]).toContain(chunkHit!.kind);

    // 刪除（含資料）→ 搜不到
    const removed = await api(server.instance, "DELETE", `/roots/${root.id}?deleteData=1`);
    expect(removed.status).toBe(200);
    expect(removed.body).toMatchObject({ rootId: root.id, deletedData: true });
    expect((removed.body as { removedChunks: number }).removedChunks).toBeGreaterThan(0);

    const afterRemove = await api(server.instance, "POST", "/search", { body: { query: NOTE_TOKEN } });
    expect((afterRemove.body as { hits: unknown[] }).hits).toHaveLength(0);
    expect((await api(server.instance, "GET", "/roots")).body).toEqual({ roots: [] });
  });

  it("browse 模式的 root 不可索引 → 400 RootNotIndexableError", async () => {
    server = await startTestServer();
    const dir = await fixture();
    const created = await api(server.instance, "POST", "/roots", { body: { path: dir, mode: "browse" } });
    const root = created.body as { id: number };
    const response = await api(server.instance, "POST", `/roots/${root.id}/index`);
    expect(response.status).toBe(400);
    expect(errorName(response.body)).toBe(new RootNotIndexableError(0, "browse").name);
  });
});

describe("REST：錯誤語意", () => {
  it("家目錄本身與檔案系統根 → 422 RootTooBroadError", async () => {
    server = await startTestServer();
    for (const tooBroad of [os.homedir(), path.parse(os.tmpdir()).root]) {
      const response = await api(server.instance, "POST", "/roots", { body: { path: tooBroad } });
      expect(response.status).toBe(422);
      expect(errorName(response.body)).toBe("RootTooBroadError");
    }
  });

  it("黑名單路徑 → 403 PathBlockedError（訊息不含絕對路徑）", async () => {
    server = await startTestServer();
    const dir = await fixture();
    const blocked = path.join(dir, ".ssh");
    await fs.mkdir(blocked);

    const response = await api(server.instance, "POST", "/roots", { body: { path: blocked } });
    expect(response.status).toBe(403);
    expect(errorName(response.body)).toBe("PathBlockedError");
    expect(JSON.stringify(response.body)).not.toContain(dir);
  });

  it("重複加入同一 root → 409 DuplicateRootError（訊息不含絕對路徑）", async () => {
    server = await startTestServer();
    const dir = await fixture();
    await api(server.instance, "POST", "/roots", { body: { path: dir } });
    const again = await api(server.instance, "POST", "/roots", { body: { path: dir } });
    expect(again.status).toBe(409);
    expect(errorName(again.body)).toBe("DuplicateRootError");
    expect(JSON.stringify(again.body)).not.toContain(dir);
  });

  it("索引進行中再呼叫 → 409 IndexInProgressError", async () => {
    server = await startTestServer({ embedder: new SlowEmbedder(50) });
    const dir = await fixture();
    const created = await api(server.instance, "POST", "/roots", {
      body: { path: dir, modalities: ["text", "code", "image"] },
    });
    const root = created.body as { id: number };

    const [first, second] = await Promise.all([
      api(server.instance, "POST", `/roots/${root.id}/index`),
      api(server.instance, "POST", `/roots/${root.id}/index`),
    ]);
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 409]);
    const conflict = first.status === 409 ? first : second;
    expect(errorName(conflict.body)).toBe("IndexInProgressError");

    // 索引結束後可以再跑
    const after = await api(server.instance, "POST", `/roots/${root.id}/index`);
    expect(after.status).toBe(200);
  });

  it("未知 root → 404", async () => {
    server = await startTestServer();
    for (const call of [
      api(server.instance, "GET", "/roots/987654"),
      api(server.instance, "POST", "/roots/987654/preview"),
      api(server.instance, "POST", "/roots/987654/index"),
      api(server.instance, "DELETE", "/roots/987654?deleteData=1"),
      api(server.instance, "GET", "/roots/not-a-number"),
    ]) {
      const response = await call;
      expect(response.status).toBe(404);
      expect(errorName(response.body)).toBe("NotFoundError");
    }
  });

  it("請求內容不合法 → 400 ValidationError", async () => {
    server = await startTestServer();
    const cases: { body: unknown }[] = [
      { body: {} },
      { body: { path: "" } },
      { body: { path: path.join(os.tmpdir(), "mnemoshelf-does-not-exist-xyz") } },
      { body: { path: os.tmpdir(), mode: "wat" } },
      { body: { path: os.tmpdir(), modalities: ["nope"] } },
      { body: { path: os.tmpdir(), respectGitignore: "yes" } },
    ];
    for (const testCase of cases) {
      const response = await api(server.instance, "POST", "/roots", testCase);
      expect(response.status).toBe(400);
      expect(errorName(response.body)).toBe("ValidationError");
    }

    const badSearch = await api(server.instance, "POST", "/search", { body: { query: "" } });
    expect(badSearch.status).toBe(400);
    const badRootIds = await api(server.instance, "POST", "/search", { body: { query: "x", rootIds: [] } });
    expect(badRootIds.status).toBe(400);
  });
});

describe("REST：記憶", () => {
  it("寫入記憶 → 關鍵字搜尋找得到（帶 agent 來源）→ 軟刪除後搜不到", async () => {
    server = await startTestServer();
    const content = "測試記憶：mnemoshelf 的 REST 以 token 保護";

    const created = await api(server.instance, "POST", "/memories", {
      body: { content, agent: "test-agent", kind: "decision", scope: "project", project: "mnemoshelf" },
    });
    expect(created.status).toBe(201);
    const memory = created.body as { id: number; agent: string; kind: string; scope: string; project: string; deletedAt: string | null };
    expect(memory.agent).toBe("test-agent");
    expect(memory.kind).toBe("decision");
    expect(memory.scope).toBe("project");
    expect(memory.project).toBe("mnemoshelf");
    expect(memory.deletedAt).toBeNull();

    const found = await api(server.instance, "POST", "/search", { body: { query: "mnemoshelf" } });
    const hits = (found.body as { hits: { type: string; id?: number; agent?: string; kind?: string; scope?: string }[] }).hits;
    const memoryHit = hits.find((hit) => hit.type === "memory");
    expect(memoryHit).toBeDefined();
    expect(memoryHit!.id).toBe(memory.id);
    expect(memoryHit!.agent).toBe("test-agent");
    expect(memoryHit!.scope).toBe("project");

    const forgotten = await api(server.instance, "DELETE", `/memories/${memory.id}`);
    expect(forgotten.status).toBe(200);
    expect(forgotten.body).toEqual({ id: memory.id, deleted: true });

    const afterForget = await api(server.instance, "POST", "/search", { body: { query: "mnemoshelf" } });
    const remaining = (afterForget.body as { hits: { type: string }[] }).hits.filter((hit) => hit.type === "memory");
    expect(remaining).toHaveLength(0);

    // 未知記憶 → 404
    const unknown = await api(server.instance, "DELETE", "/memories/987654");
    expect(unknown.status).toBe(404);
  });

  it("agent 必填；缺少內容或 agent → 400 ValidationError", async () => {
    server = await startTestServer();
    const missingAgent = await api(server.instance, "POST", "/memories", { body: { content: "x" } });
    expect(missingAgent.status).toBe(400);
    expect(errorName(missingAgent.body)).toBe("ValidationError");

    const missingContent = await api(server.instance, "POST", "/memories", { body: { agent: "t" } });
    expect(missingContent.status).toBe(400);
    expect(errorName(missingContent.body)).toBe("ValidationError");
  });

  it("GET /memories 列出未刪除的記憶（新的在前），支援 filter 與 limit", async () => {
    server = await startTestServer();
    const instance = server.instance;

    const m1 = (await api(server.instance, "POST", "/memories", {
      body: { content: "第一筆：全域事實", agent: "agent-1", kind: "fact", scope: "global" },
    })).body as { id: number };
    const m2 = (await api(server.instance, "POST", "/memories", {
      body: { content: "第二筆：專案決策", agent: "agent-1", kind: "decision", scope: "project", project: "proj-1" },
    })).body as { id: number };
    const m3 = (await api(server.instance, "POST", "/memories", {
      body: { content: "第三筆：踩坑", agent: "agent-2", kind: "pitfall", scope: "project", project: "proj-2" },
    })).body as { id: number };

    // 全部列出，createdAt 由新到舊
    const all = await api(server.instance, "GET", "/memories");
    expect(all.status).toBe(200);
    const memories = (all.body as ListMemoriesResponse).memories;
    expect(memories.map((memory) => memory.id)).toEqual([m3.id, m2.id, m1.id]);
    const times = memories.map((memory) => Date.parse(memory.createdAt));
    for (let index = 1; index < times.length; index += 1) {
      expect(times[index - 1]!).toBeGreaterThanOrEqual(times[index]!);
    }
    // 來源欄位（寫入的 agent）與內容都在
    expect(memories[0]).toMatchObject({ agent: "agent-2", kind: "pitfall", scope: "project", project: "proj-2" });

    const ids = async (query: string): Promise<number[]> => {
      const response = await api(instance, "GET", `/memories${query}`);
      expect(response.status).toBe(200);
      return (response.body as ListMemoriesResponse).memories.map((memory) => memory.id);
    };

    expect(await ids("?kind=fact")).toEqual([m1.id]);
    expect(await ids("?scope=project")).toEqual([m3.id, m2.id]);
    expect(await ids("?project=proj-1")).toEqual([m2.id]);
    expect(await ids("?agent=agent-1")).toEqual([m2.id, m1.id]);
    expect(await ids("?agent=agent-2&kind=pitfall")).toEqual([m3.id]);
    expect(await ids("?agent=agent-2&kind=fact")).toEqual([]);
    expect(await ids("?limit=2")).toEqual([m3.id, m2.id]);
    // 空的查詢參數＝不過濾
    expect(await ids("?kind=&agent=")).toEqual([m3.id, m2.id, m1.id]);
    // 未指定 limit → 預設值（3 筆全部）
    expect(await ids("")).toHaveLength(3);

    // 軟刪除後不再列出
    await api(server.instance, "DELETE", `/memories/${m2.id}`);
    expect(await ids("")).toEqual([m3.id, m1.id]);
  });

  it("GET /memories 的參數不合法 → 400；無 token → 401", async () => {
    server = await startTestServer();
    for (const query of ["?kind=nope", "?scope=nope", "?limit=0", "?limit=-1", "?limit=abc", "?limit=1.5"]) {
      const response = await api(server.instance, "GET", `/memories${query}`);
      expect(response.status).toBe(400);
      expect(errorName(response.body)).toBe("ValidationError");
    }

    const noToken = await api(server.instance, "GET", "/memories", { token: null });
    expect(noToken.status).toBe(401);
    expect(errorName(noToken.body)).toBe("UnauthorizedError");
  });
});

describe("REST：畸形 request-target 不會打掛服務", () => {
  it("`//[` → 400 InvalidRequestUrlError，服務仍存活", async () => {
    server = await startTestServer();

    const response = await rawHttpRequest(server.instance.port, "//[");
    expect(response.status).toBe(400);
    expect(response.body).toContain("InvalidRequestUrlError");
    // 訊息不含原始 URL 的不可信內容
    expect(response.body).not.toContain("//[");

    // 服務仍存活：後續正常請求照常
    expect((await api(server.instance, "GET", "/health", { token: null })).status).toBe(200);
    expect((await api(server.instance, "GET", "/roots")).status).toBe(200);
  });

  it("`/%`（壞掉的百分比編碼）→ 400，服務仍存活", async () => {
    server = await startTestServer();

    const response = await rawHttpRequest(server.instance.port, "/%");
    expect(response.status).toBe(400);
    expect(response.body).toContain("InvalidRequestUrlError");

    expect((await api(server.instance, "GET", "/health", { token: null })).status).toBe(200);
  });

  it("超長路徑 → 414，服務仍存活；邊界值仍可路由", async () => {
    server = await startTestServer();

    const tooLong = `/${"a".repeat(10 * 1024)}`;
    const response = await rawHttpRequest(server.instance.port, tooLong);
    expect(response.status).toBe(414);
    expect(response.body).toContain("RequestUriTooLongError");

    // 剛好在限制內：不是 414，而是一般的未知路徑 404（帶 token 才看得到 404）
    const atLimit = `/${"a".repeat(MAX_REQUEST_URL_LENGTH - 1)}`;
    const routed = await rawHttpRequest(server.instance.port, atLimit, {
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(routed.status).toBe(404);
    // 超過一個 byte：414
    const overLimit = `/${"a".repeat(MAX_REQUEST_URL_LENGTH)}`;
    expect((await rawHttpRequest(server.instance.port, overLimit)).status).toBe(414);

    expect((await api(server.instance, "GET", "/health", { token: null })).status).toBe(200);
  });

  it("畸形請求不影響後續正常請求（含寫入與搜尋）", async () => {
    server = await startTestServer();

    for (const target of ["//[", "/%", `/${"b".repeat(9000)}`]) {
      const response = await rawHttpRequest(server.instance.port, target);
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
    }

    // 完整流程照常：加 root → index → search
    const dir = await fixture();
    const created = await api(server.instance, "POST", "/roots", {
      body: { path: dir, modalities: ["text", "code", "image"] },
    });
    expect(created.status).toBe(201);
    const root = created.body as { id: number };
    expect((await api(server.instance, "POST", `/roots/${root.id}/index`)).status).toBe(200);

    const found = await api(server.instance, "POST", "/search", { body: { query: NOTE_TOKEN } });
    expect(found.status).toBe(200);
    expect((found.body as { hits: unknown[] }).hits.length).toBeGreaterThan(0);
  });
});

describe("REST：隱私", () => {
  it("錯誤回應不含本機絕對路徑（暫存目錄）", async () => {
    server = await startTestServer();
    const dir = await fixture();
    await fs.mkdir(path.join(dir, ".gnupg"));
    const blocked = await api(server.instance, "POST", "/roots", { body: { path: path.join(dir, ".gnupg") } });
    const broad = await api(server.instance, "POST", "/roots", { body: { path: os.homedir() } });
    for (const response of [blocked, broad]) {
      expect(JSON.stringify(response.body)).not.toContain(dir);
      expect(JSON.stringify(response.body)).not.toContain(os.homedir());
    }
  });
});
