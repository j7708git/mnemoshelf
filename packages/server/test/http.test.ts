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
import type { Memory } from "@mnemoshelf/core";
import { FAKE_EMBEDDER_MAX_INPUT_CHARS } from "@mnemoshelf/core/testing";
import {
  api,
  errorName,
  FailingEmbedder,
  makeFixtureRoot,
  makeTempDir,
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
    // additive 欄位（agent 發現用）：service 供外掛確認身分，appVersion 供版本比對。
    expect(response.body).toMatchObject({ status: "ok", service: "mnemoshelf" });
    expect((response.body as { appVersion?: unknown }).appVersion).toBeTypeOf("string");
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

  it("未知 API 路徑 → 404；方法不支援 → 405", async () => {
    server = await startTestServer();
    // 非 API 路徑可能由 Web UI 的 SPA fallback 服務（見 static.test.ts）；
    // 這裡驗證的是 API 命名空間內的未知路徑仍是 JSON 404。
    const notFound = await api(server.instance, "GET", "/roots/1/nope");
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

    // 命中帶來源（不帶 mode 的預設已於 M2 改為 vector，見 docs/storage-ports.md）
    const defaultSearch = await api(server.instance, "POST", "/search", { body: { query: NOTE_TOKEN } });
    expect((defaultSearch.body as { mode: string }).mode).toBe("vector");
    const hits = (defaultSearch.body as { hits: { type: string; rootId?: number; relPath?: string; seq?: number; kind?: string }[] }).hits;
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

  it("root 內的 `.gitignore` 是目錄 → preview 仍回 200（不 500）", async () => {
    server = await startTestServer();
    const dir = await fixture();
    // 同名項目是目錄而非檔案：loadGitignore 讀取時會拿到 EISDIR。
    await fs.mkdir(path.join(dir, ".gitignore"));

    const created = await api(server.instance, "POST", "/roots", {
      body: { path: dir, modalities: ["text", "code", "image"] },
    });
    expect(created.status).toBe(201);
    const root = created.body as { id: number };

    const preview = await api(server.instance, "POST", `/roots/${root.id}/preview`);
    expect(preview.status).toBe(200);
    const stats = preview.body as RootPreview;
    // 沒有可讀的 .gitignore → 空規則集，三個 fixture 檔案仍全部納入。
    expect(stats.totalFiles).toBe(3);
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

  it("超長查詢（超過模型的單筆輸入上限）→ 400，不是 500", async () => {
    // `/search` 對 `query` 沒有長度上限：一份遠超模型單筆上限的查詢會讓 `embedQuery` 拋出
    // 輸入類失敗（穩定錯誤碼 `input-too-long`）。那是**使用者可修正的輸入問題**，必須映射成
    // 400 並帶可辨識的錯誤名，不能落到最後的 500「伺服器內部錯誤」。
    // FakeEmbedder 以字元數近似同一條上限（見 core 的 FAKE_EMBEDDER_MAX_INPUT_CHARS）。
    server = await startTestServer();
    const huge = "字".repeat(FAKE_EMBEDDER_MAX_INPUT_CHARS + 1);

    const response = await api(server.instance, "POST", "/search", { body: { query: huge } });

    expect(response.status).toBe(400);
    expect(errorName(response.body)).toBe("InputTooLongError");
    expect((response.body as { error: { message: string } }).error.message).toContain("縮短");
  });
});

describe("REST：PATCH /roots/:id（更新 modalities）", () => {
  it("加入時未帶 modalities → 預設只有 text／code；圖片以 modality-off 跳過（與 v0.1.2 相同）", async () => {
    server = await startTestServer();
    const dir = await fixture();

    const created = await api(server.instance, "POST", "/roots", { body: { path: dir } });
    expect(created.status).toBe(201);
    const root = created.body as { id: number; modalities: string[] };
    expect(root.modalities).toEqual(["text", "code"]);

    const preview = await api(server.instance, "POST", `/roots/${root.id}/preview`);
    expect((preview.body as RootPreview).skipped).toContainEqual({ relPath: "pic.png", reason: "modality-off" });
    expect((preview.body as RootPreview).byKind.image.count).toBe(0);

    const indexed = await api(server.instance, "POST", `/roots/${root.id}/index`);
    expect(indexed.status).toBe(200);
    const result = indexed.body as IndexRootResponse;
    // 掃描階段就跳過的檔案不會進 `skippedFiles`（那是索引階段的守衛／內容判定），
    // 而是根本不納入本輪：total 只算 2 個檔案，圖片不在其中。
    expect(result.total).toBe(2);
    expect(result.skippedFiles).toEqual([]);
    expect(result.failedFiles).toEqual([]);
    expect(result.processed).toBe(2);
  });

  it("PATCH 開圖片：200、回傳更新後的 root、GET 與 preview 都反映，且不自動觸發重索引", async () => {
    server = await startTestServer();
    const dir = await fixture();
    const created = await api(server.instance, "POST", "/roots", { body: { path: dir } });
    const root = created.body as { id: number };

    const patched = await api(server.instance, "PATCH", `/roots/${root.id}`, {
      body: { modalities: ["text", "code", "image"] },
    });
    expect(patched.status).toBe(200);
    const updated = patched.body as { id: number; modalities: string[]; path: string; mode: string };
    expect(updated.id).toBe(root.id);
    expect(updated.modalities).toEqual(["text", "code", "image"]);
    expect(updated.mode).toBe("index");

    const got = await api(server.instance, "GET", `/roots/${root.id}`);
    expect((got.body as { modalities: string[] }).modalities).toEqual(["text", "code", "image"]);

    // preview 立刻反映新模態：圖片不再被 modality-off 跳過。
    const preview = await api(server.instance, "POST", `/roots/${root.id}/preview`);
    const stats = preview.body as RootPreview;
    expect(stats.byKind.image.count).toBe(1);
    expect(stats.skipped.some((entry) => entry.relPath === "pic.png")).toBe(false);

    // **不自動觸發重新索引**：狀態仍停在 idle。
    const status = await api(server.instance, "GET", `/roots/${root.id}/index/status`);
    expect((status.body as { state: string }).state).toBe("idle");

    // 關掉圖片（空陣列＝全關）也合法。
    const cleared = await api(server.instance, "PATCH", `/roots/${root.id}`, { body: { modalities: [] } });
    expect(cleared.status).toBe(200);
    expect((cleared.body as { modalities: string[] }).modalities).toEqual([]);
  });

  it("PATCH 改模態後，重新索引才會把圖片納入（不自動觸發）", async () => {
    server = await startTestServer();
    const dir = await fixture();
    const created = await api(server.instance, "POST", "/roots", { body: { path: dir } });
    const root = created.body as { id: number };

    // 尚未開圖片：索引後圖片沒有 chunk。
    const before = await api(server.instance, "POST", `/roots/${root.id}/index`);
    expect((before.body as IndexRootResponse).processed).toBe(2);

    // 開圖片 → 重新索引：pic.png 被處理。
    const patched = await api(server.instance, "PATCH", `/roots/${root.id}`, {
      body: { modalities: ["text", "code", "image"] },
    });
    expect(patched.status).toBe(200);

    const after = await api(server.instance, "POST", `/roots/${root.id}/index`);
    expect(after.status).toBe(200);
    const result = after.body as IndexRootResponse;
    expect(result.processed).toBe(1); // 只有圖片是新處理的
    expect(result.skippedUnchanged).toBe(2);
    expect(result.failedFiles).toEqual([]);
  });

  it("請求內容不合法 → 400 ValidationError", async () => {
    server = await startTestServer();
    const dir = await fixture();
    const created = await api(server.instance, "POST", "/roots", { body: { path: dir } });
    const root = created.body as { id: number };

    const cases: unknown[] = [
      {}, // 缺 modalities（本端點只改這個欄位）
      { modalities: "image" },
      { modalities: ["nope"] },
      { modalities: [1] },
      { modalities: { image: true } },
      { modalities: null },
    ];
    for (const body of cases) {
      const response = await api(server.instance, "PATCH", `/roots/${root.id}`, { body });
      expect(response.status).toBe(400);
      expect(errorName(response.body)).toBe("ValidationError");
    }

    // 失敗的請求不得改動資料。
    const got = await api(server.instance, "GET", `/roots/${root.id}`);
    expect((got.body as { modalities: string[] }).modalities).toEqual(["text", "code"]);
  });

  it("未知 root → 404；方法不支援 → 405（Allow 帶 PATCH）", async () => {
    server = await startTestServer();
    const unknown = await api(server.instance, "PATCH", "/roots/987654", { body: { modalities: ["image"] } });
    expect(unknown.status).toBe(404);
    expect(errorName(unknown.body)).toBe("NotFoundError");

    const badId = await api(server.instance, "PATCH", "/roots/not-a-number", { body: { modalities: ["image"] } });
    expect(badId.status).toBe(404);

    const dir = await fixture();
    const created = await api(server.instance, "POST", "/roots", { body: { path: dir } });
    const root = created.body as { id: number };
    const notAllowed = await api(server.instance, "PUT", `/roots/${root.id}`);
    expect(notAllowed.status).toBe(405);
    expect(notAllowed.headers.get("allow")).toBe("GET, PATCH, DELETE");
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

    // 記憶只進關鍵字那一路，因此這裡明確帶 mode（M2 起不帶 mode 的預設是 vector）。
    const found = await api(server.instance, "POST", "/search", { body: { query: "mnemoshelf", mode: "keyword" } });
    const hits = (found.body as { hits: { type: string; id?: number; agent?: string; kind?: string; scope?: string }[] }).hits;
    const memoryHit = hits.find((hit) => hit.type === "memory");
    expect(memoryHit).toBeDefined();
    expect(memoryHit!.id).toBe(memory.id);
    expect(memoryHit!.agent).toBe("test-agent");
    expect(memoryHit!.scope).toBe("project");

    const forgotten = await api(server.instance, "DELETE", `/memories/${memory.id}`);
    expect(forgotten.status).toBe(200);
    expect(forgotten.body).toEqual({ id: memory.id, deleted: true });

    const afterForget = await api(server.instance, "POST", "/search", { body: { query: "mnemoshelf", mode: "keyword" } });
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

  it("新增的記憶 pinned=false，且 pinned 欄位出現在 POST 與 GET /memories 的回應", async () => {
    server = await startTestServer();
    const created = await api(server.instance, "POST", "/memories", {
      body: { content: "釘選欄位測試", agent: "agent-pin" },
    });
    expect(created.status).toBe(201);
    expect((created.body as { pinned: boolean }).pinned).toBe(false);

    const listed = await api(server.instance, "GET", "/memories");
    const memories = (listed.body as ListMemoriesResponse).memories;
    expect(memories).toHaveLength(1);
    expect(memories[0]?.pinned).toBe(false);
  });

  it("POST /memories/:id/pin 釘選與取消（冪等），回應帶更新後的記憶", async () => {
    server = await startTestServer();
    const memory = (await api(server.instance, "POST", "/memories", {
      body: { content: "要被釘選的記憶", agent: "agent-pin" },
    })).body as { id: number };

    // 只送空主體＝釘選（pinned 預設 true）。
    const pinned = await api(server.instance, "POST", `/memories/${memory.id}/pin`, { body: {} });
    expect(pinned.status).toBe(200);
    expect((pinned.body as { id: number; pinned: boolean }).id).toBe(memory.id);
    expect((pinned.body as { pinned: boolean }).pinned).toBe(true);

    // 冪等：再釘一次結果相同。
    const pinnedAgain = await api(server.instance, "POST", `/memories/${memory.id}/pin`, { body: { pinned: true } });
    expect(pinnedAgain.status).toBe(200);
    expect((pinnedAgain.body as { pinned: boolean }).pinned).toBe(true);

    // 列表也反映 pinned。
    const listed = await api(server.instance, "GET", "/memories");
    expect((listed.body as ListMemoriesResponse).memories[0]?.pinned).toBe(true);

    // 取消釘選。
    const unpinned = await api(server.instance, "POST", `/memories/${memory.id}/pin`, { body: { pinned: false } });
    expect(unpinned.status).toBe(200);
    expect((unpinned.body as { pinned: boolean }).pinned).toBe(false);
    expect((await api(server.instance, "GET", "/memories")).body).toMatchObject({
      memories: [{ id: memory.id, pinned: false }],
    });
  });

  it("POST /memories/:id/pin 未知 id → 404；無 token → 401；pinned 非布林 → 400", async () => {
    server = await startTestServer();

    const unknown = await api(server.instance, "POST", "/memories/987654/pin", { body: { pinned: true } });
    expect(unknown.status).toBe(404);
    expect(errorName(unknown.body)).toBe("NotFoundError");

    const noToken = await api(server.instance, "POST", "/memories/1/pin", { body: {}, token: null });
    expect(noToken.status).toBe(401);
    expect(errorName(noToken.body)).toBe("UnauthorizedError");

    const memory = (await api(server.instance, "POST", "/memories", {
      body: { content: "驗證 pinned 型別", agent: "agent-pin" },
    })).body as { id: number };
    const badType = await api(server.instance, "POST", `/memories/${memory.id}/pin`, { body: { pinned: "yes" } });
    expect(badType.status).toBe(400);
    expect(errorName(badType.body)).toBe("ValidationError");
  });

  it("POST /memories 帶 supersedes：新版本建立、舊版本不再列出、關係可回溯", async () => {
    server = await startTestServer();
    const original = (await api(server.instance, "POST", "/memories", {
      body: { content: "舊版本：用四個空白縮排", agent: "editor-agent", kind: "preference", scope: "global" },
    })).body as { id: number };

    const updated = await api(server.instance, "POST", "/memories", {
      body: {
        content: "新版本：用兩個空白縮排",
        agent: "editor-agent",
        kind: "preference",
        scope: "global",
        supersedes: original.id,
      },
    });
    expect(updated.status).toBe(201);
    const replacement = updated.body as { id: number; supersedes: number | null; pinned: boolean };
    expect(replacement.supersedes).toBe(original.id);
    expect(replacement.pinned).toBe(false);

    const listed = (await api(server.instance, "GET", "/memories")).body as ListMemoriesResponse;
    expect(listed.memories.map((memory) => memory.id)).toEqual([replacement.id]);
    expect(listed.memories.map((memory) => memory.id)).not.toContain(original.id);

    // supersedes 非正整數 → 400
    const bad = await api(server.instance, "POST", "/memories", {
      body: { content: "x", agent: "editor-agent", supersedes: 0 },
    });
    expect(bad.status).toBe(400);
    expect(errorName(bad.body)).toBe("ValidationError");
  });

  it("POST /memories 帶 supersedes 時新版本繼承被取代者的 pinned", async () => {
    server = await startTestServer();

    // 已釘選的舊版本 → 新版本也釘選。
    const pinnedOriginal = (await api(server.instance, "POST", "/memories", {
      body: { content: "已釘選的舊版本", agent: "editor-agent", kind: "preference" },
    })).body as { id: number; pinned: boolean };
    expect(pinnedOriginal.pinned).toBe(false);
    await api(server.instance, "POST", `/memories/${pinnedOriginal.id}/pin`, { body: { pinned: true } });

    const pinnedReplacement = (await api(server.instance, "POST", "/memories", {
      body: { content: "取代已釘選版本", agent: "editor-agent", kind: "preference", supersedes: pinnedOriginal.id },
    })).body as { id: number; supersedes: number | null; pinned: boolean };
    expect(pinnedReplacement.supersedes).toBe(pinnedOriginal.id);
    expect(pinnedReplacement.pinned).toBe(true);

    // 未釘選的舊版本 → 新版本維持未釘選（契約：新記憶預設 false）。
    const plainOriginal = (await api(server.instance, "POST", "/memories", {
      body: { content: "未釘選的舊版本", agent: "editor-agent" },
    })).body as { id: number };
    const plainReplacement = (await api(server.instance, "POST", "/memories", {
      body: { content: "取代未釘選版本", agent: "editor-agent", supersedes: plainOriginal.id },
    })).body as { pinned: boolean };
    expect(plainReplacement.pinned).toBe(false);

    // 列表反映：只有新版本在列，且 pinned 正確。
    const listed = (await api(server.instance, "GET", "/memories")).body as ListMemoriesResponse;
    const byId = new Map(listed.memories.map((memory) => [memory.id, memory]));
    expect(byId.get(pinnedReplacement.id)?.pinned).toBe(true);
    expect(byId.has(pinnedOriginal.id)).toBe(false);
  });
});

describe("REST：PATCH /memories/:id（共享開關）", () => {
  /** 建立一筆測試記憶並回傳完整 `Memory`。 */
  async function createMemory(body: Record<string, unknown> = {}): Promise<Memory> {
    const created = await api(server!.instance, "POST", "/memories", {
      body: { content: "共享開關的測試記憶", agent: "agent-share", kind: "decision", ...body },
    });
    expect(created.status).toBe(201);
    return created.body as Memory;
  }

  it("project → global：200、project 清為 null、不可變欄位原樣保留，GET 也反映", async () => {
    server = await startTestServer();
    const memory = await createMemory({ scope: "project", project: "mnemoshelf" });
    expect(memory.project).toBe("mnemoshelf");

    const patched = await api(server.instance, "PATCH", `/memories/${memory.id}`, { body: { scope: "global" } });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({
      id: memory.id,
      content: memory.content,
      kind: memory.kind,
      agent: memory.agent,
      supersedes: memory.supersedes,
      pinned: memory.pinned,
      createdAt: memory.createdAt,
      deletedAt: null,
      scope: "global",
      project: null,
    });

    const listed = (await api(server.instance, "GET", "/memories")).body as ListMemoriesResponse;
    expect(listed.memories.find((item) => item.id === memory.id)).toMatchObject({ scope: "global", project: null });
  });

  it("global → project：200、專案名稱 trim 後儲存，重複套用冪等，可用 project 過濾找到", async () => {
    server = await startTestServer();
    const memory = await createMemory({ scope: "global" });

    const patched = await api(server.instance, "PATCH", `/memories/${memory.id}`, {
      body: { scope: "project", project: "  proj-share  " },
    });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({ scope: "project", project: "proj-share" });

    // 冪等：同一個 patch 再套一次，回應完全相同。
    const again = await api(server.instance, "PATCH", `/memories/${memory.id}`, {
      body: { scope: "project", project: "proj-share" },
    });
    expect(again.status).toBe(200);
    expect(again.body).toEqual(patched.body);

    const filtered = (await api(server.instance, "GET", "/memories?project=proj-share")).body as ListMemoriesResponse;
    expect(filtered.memories.map((item) => item.id)).toEqual([memory.id]);
  });

  it("project → agent：200、scope=agent、project 清為 null，原寫入者不變", async () => {
    server = await startTestServer();
    const memory = await createMemory({ scope: "project", project: "proj-agent" });
    expect(memory.agent).toBe("agent-share");

    const patched = await api(server.instance, "PATCH", `/memories/${memory.id}`, { body: { scope: "agent" } });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({
      id: memory.id,
      content: memory.content,
      kind: memory.kind,
      agent: memory.agent,
      scope: "agent",
      project: null,
    });

    // 寫入者是不可變欄位：呼叫端不能經此端點指定新寫入者，原值必須保留。
    expect((patched.body as Memory).agent).toBe("agent-share");

    const listed = (await api(server.instance, "GET", "/memories")).body as ListMemoriesResponse;
    expect(listed.memories.find((item) => item.id === memory.id)).toMatchObject({
      scope: "agent",
      project: null,
      agent: memory.agent,
    });
  });

  it("只帶 project（現值 scope 是 project）→ 更新專案名稱；只帶非 null project 而現值不是 project → 400", async () => {
    server = await startTestServer();
    const projectMemory = await createMemory({ scope: "project", project: "proj-old" });
    const renamed = await api(server.instance, "PATCH", `/memories/${projectMemory.id}`, {
      body: { project: "proj-new" },
    });
    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({ scope: "project", project: "proj-new" });

    const globalMemory = await createMemory({ scope: "global" });
    const invalid = await api(server.instance, "PATCH", `/memories/${globalMemory.id}`, {
      body: { project: "proj-new" },
    });
    expect(invalid.status).toBe(400);
    expect(errorName(invalid.body)).toBe("ValidationError");
    // 不合法請求不得留下任何變更。
    const after = (await api(server.instance, "GET", "/memories")).body as ListMemoriesResponse;
    expect(after.memories.find((item) => item.id === globalMemory.id)).toMatchObject({
      scope: "global",
      project: null,
    });
  });

  it("400：主體不合法（空、未知欄位、scope 非法、project 型別、scope=project 缺／空專案、scope!=project 帶專案）", async () => {
    server = await startTestServer();
    const memory = await createMemory({ scope: "project", project: "proj-keep" });

    const badBodies: Record<string, unknown>[] = [
      {},
      { content: "不能改內容" },
      { kind: "decision" },
      { pinned: true },
      { agent: "attacker" },
      // 有效欄位＋未知欄位並存：未知欄位必須被拒絕，不能因為有其他合法欄位就靜默忽略。
      { scope: "global", content: "不能改內容" },
      { scope: "project", project: "proj-keep", pinned: true },
      { scope: "nope" },
      { project: 42 },
      { scope: "project" },
      { scope: "project", project: null },
      { scope: "project", project: "" },
      { scope: "project", project: "   " },
      { scope: "global", project: "proj-keep" },
      { scope: "agent", project: "proj-keep" },
    ];
    for (const body of badBodies) {
      const response = await api(server.instance, "PATCH", `/memories/${memory.id}`, { body });
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(errorName(response.body)).toBe("ValidationError");
    }

    // 全部被拒之後，記憶維持原樣。
    const listed = (await api(server.instance, "GET", "/memories")).body as ListMemoriesResponse;
    expect(listed.memories.find((item) => item.id === memory.id)).toMatchObject({
      content: "共享開關的測試記憶",
      kind: "decision",
      agent: "agent-share",
      scope: "project",
      project: "proj-keep",
    });
  });

  it("404：未知 id、已軟刪除的 id；401：無 token", async () => {
    server = await startTestServer();
    const unknown = await api(server.instance, "PATCH", "/memories/987654", { body: { scope: "global" } });
    expect(unknown.status).toBe(404);
    expect(errorName(unknown.body)).toBe("NotFoundError");

    const memory = await createMemory({ scope: "project", project: "proj-soft" });
    expect((await api(server.instance, "DELETE", `/memories/${memory.id}`)).status).toBe(200);
    const deleted = await api(server.instance, "PATCH", `/memories/${memory.id}`, { body: { scope: "global" } });
    expect(deleted.status).toBe(404);
    expect(errorName(deleted.body)).toBe("NotFoundError");

    const noToken = await api(server.instance, "PATCH", `/memories/${memory.id}`, {
      body: { scope: "global" },
      token: null,
    });
    expect(noToken.status).toBe(401);
    expect(errorName(noToken.body)).toBe("UnauthorizedError");
  });

  it("405：不支援的方法，Allow 帶 DELETE 與 PATCH", async () => {
    server = await startTestServer();
    const memory = await createMemory();
    const response = await api(server.instance, "PUT", `/memories/${memory.id}`, { body: { scope: "global" } });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("DELETE, PATCH");
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

describe("REST：索引取消與壞檔", () => {
  it("取消進行中的索引 → 200，狀態為 cancelled，之後可再索引完成", async () => {
    server = await startTestServer({ embedder: new SlowEmbedder(100) });
    const dir = await fixture();
    const created = await api(server.instance, "POST", "/roots", {
      body: { path: dir, modalities: ["text", "code", "image"] },
    });
    const root = created.body as { id: number };

    const started = api(server.instance, "POST", `/roots/${root.id}/index`);
    // 等索引真的開始（狀態 running）再取消，避免與請求處理競態。
    let running = false;
    for (let attempt = 0; attempt < 100 && !running; attempt += 1) {
      const current = await api(server.instance, "GET", `/roots/${root.id}/index/status`);
      running = (current.body as { state: string }).state === "running";
      if (!running) await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(running).toBe(true);

    const cancelled = await api(server.instance, "POST", `/roots/${root.id}/index/cancel`);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toMatchObject({ rootId: root.id, cancelled: true });

    // 被取消的那一輪以 200＋cancelled 結束（不是 500，也不是失敗）。
    const finished = await started;
    expect(finished.status).toBe(200);
    expect(finished.body).toMatchObject({ rootId: root.id, cancelled: true });

    const status = await api(server.instance, "GET", `/roots/${root.id}/index/status`);
    const body = status.body as { state: string; error: unknown; runSeq: number | null };
    expect(body.state).toBe("cancelled");
    expect(body.error).toBeNull();
    // 被取消的那輪序號為 1（第一次 begin）。
    expect(body.runSeq).toBe(1);

    // 取消後可再索引，且能跑完（已完成的檔案維持一致，未完成的下一輪重做）。
    const again = await api(server.instance, "POST", `/roots/${root.id}/index`);
    expect(again.status).toBe(200);
    const result = again.body as IndexRootResponse;
    expect(result.processed + result.skippedUnchanged).toBe(result.total);
    // 第二次 begin：runSeq 遞增到 2（client 靠它分辨本輪終態）。
    expect((await api(server.instance, "GET", `/roots/${root.id}/index/status`)).body).toMatchObject({
      state: "completed",
      runSeq: 2,
    });
  });

  it("沒有進行中的索引時取消 → 404；未知 root → 404；方法不支援 → 405", async () => {
    server = await startTestServer();
    const dir = await fixture();
    const created = await api(server.instance, "POST", "/roots", { body: { path: dir } });
    const root = created.body as { id: number };

    const idle = await api(server.instance, "POST", `/roots/${root.id}/index/cancel`);
    expect(idle.status).toBe(404);
    expect(errorName(idle.body)).toBe("NotFoundError");

    // 從未索引過：狀態為 idle 且 runSeq 為 null。
    expect((await api(server.instance, "GET", `/roots/${root.id}/index/status`)).body).toMatchObject({
      state: "idle",
      runSeq: null,
    });

    const unknown = await api(server.instance, "POST", "/roots/987654/index/cancel");
    expect(unknown.status).toBe(404);
    expect(errorName(unknown.body)).toBe("NotFoundError");

    const wrongMethod = await api(server.instance, "GET", `/roots/${root.id}/index/cancel`);
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("allow")).toBe("POST");
  });

  it("壞檔不讓整輪索引失敗：failedFiles 有紀錄、好檔仍可搜尋、狀態為 completed", async () => {
    server = await startTestServer({ embedder: new FailingEmbedder("BADTOKEN") });
    const dir = await makeTempDir();
    fixtureDirs.push(dir);
    await fs.writeFile(path.join(dir, "bad.md"), "# 標題\n\nBADTOKEN 的內容\n", "utf8");
    await fs.writeFile(path.join(dir, "good.md"), `# 標題\n\n${NOTE_TOKEN} 的內容\n`, "utf8");

    const created = await api(server.instance, "POST", "/roots", { body: { path: dir } });
    const root = created.body as { id: number };

    const indexed = await api(server.instance, "POST", `/roots/${root.id}/index`);
    expect(indexed.status).toBe(200);
    const result = indexed.body as IndexRootResponse;
    expect(result.processed).toBe(1);
    expect(result.failedFiles).toEqual([{ relPath: "bad.md", reason: "EMODELFAIL" }]);
    // 失敗原因不含任何路徑（原始錯誤訊息被丟棄）。
    expect(JSON.stringify(result.failedFiles)).not.toContain(dir);

    // 好檔照常寫入索引並可搜尋。
    const found = await api(server.instance, "POST", "/search", { body: { query: NOTE_TOKEN } });
    expect((found.body as { hits: unknown[] }).hits.length).toBeGreaterThan(0);

    const status = await api(server.instance, "GET", `/roots/${root.id}/index/status`);
    expect(status.body).toMatchObject({ state: "completed" });
    const progress = (status.body as { progress: { failed: number; processedChunks: number; estimatedChunks: number } })
      .progress;
    expect(progress.failed).toBe(1);
    expect(progress.processedChunks).toBeGreaterThan(0);
    expect(progress.estimatedChunks).toBeGreaterThanOrEqual(progress.processedChunks);
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
