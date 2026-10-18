/**
 * 卡 C0（記憶安全與誠實性）的伺服器整合測試：
 *
 * - 寫入前遮罩（`POST /memories`）與讀取再遮（`GET /memories`、召回、`/search` 記憶命中）。
 * - 信任標記（列表 `untrusted`、召回命中 `untrusted`）。
 * - 輸入長度上限（query 2,000／agent・project 200）。
 * - 啟動回填 opt-out（`MNEMOSHELF_MEMORY_BACKFILL`）。
 * - POSIX 資料目錄／DB 權限（best-effort）。
 *
 * **測試樣本安全**：所有憑證樣本都用 `fake(...)` 片段拼接，原始碼不會出現可被 secret scanner
 * 判真的連續字面憑證；樣本也是明顯假的。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  openDatabase,
  SqliteMetadataStore,
  type DocumentInput,
  type Embedder,
  type EmbedderInfo,
  type ImageInput,
  type ProbeResult,
} from "@mnemoshelf/core";
import {
  api,
  makeTempDir,
  removeTempDir,
  startTestServer,
  TEST_TOKEN,
  type TestServer,
} from "./helpers.js";
import {
  createServer,
  loadServerConfig,
  type DiagnosticsResponse,
  type ListMemoriesResponse,
  type MemoryRecallResponseBody,
  type MnemoshelfServer,
} from "../src/index.js";

/** 以片段拼接組出樣本（避免原始碼出現連續憑證樣式）。 */
function fake(...parts: string[]): string {
  return parts.join("");
}

const SECRETS = {
  openAiStyle: fake("s", "k-", "TESTPROJ", "_", "0123456789abcdefghij"),
  awsStyle: fake("AK", "IA", "ABCDEFGHIJKLMNOP"),
  assignment: fake("password", ' = "', "correcthorsebattery", '"'),
  connection: fake("post", "gres://", "demo", ":", "s3cretpass", "@", "db.example.test/app"),
  pem: [
    ["-----BEGIN", "RSA", "PRIVATE KEY-----"].join(" "),
    "MIIEfakefakefakefakefakefake",
    ["-----END", "RSA", "PRIVATE KEY-----"].join(" "),
  ].join("\n"),
};

const OLD_REDACTED = "[REDACTED:token]";

/** 記錄文件嵌入次數的 embedder（2 維；只驗流程，無語意）。 */
class CountingEmbedder implements Embedder {
  readonly info: EmbedderInfo = {
    id: "counting-embedder@test",
    dim: 2,
    capabilities: { text: true, image: true, audio: false, video: false },
  };
  embedDocumentCalls = 0;

  async embedQuery(): Promise<Float32Array> {
    return new Float32Array([1, 0]);
  }

  async embedDocument(): Promise<Float32Array> {
    this.embedDocumentCalls += 1;
    return new Float32Array([1, 0]);
  }

  async embedDocuments(inputs: readonly DocumentInput[]): Promise<Float32Array[]> {
    const vectors: Float32Array[] = [];
    for (const _input of inputs) vectors.push(await this.embedDocument());
    return vectors;
  }

  async embedImage(_image: ImageInput): Promise<Float32Array> {
    return new Float32Array([1, 0]);
  }

  async probe(): Promise<ProbeResult> {
    return { ok: true };
  }

  async dispose(): Promise<void> {
    // 無資源。
  }
}

let server: TestServer | undefined;
const extraServers: MnemoshelfServer[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  while (extraServers.length > 0) await extraServers.pop()!.close();
  for (const dir of tempDirs.splice(0)) {
    try {
      await removeTempDir(dir);
    } catch {
      // 測試清理失敗不影響其他測試。
    }
  }
  await server?.close();
  server = undefined;
});

/** 新增記憶（走 REST）。 */
async function createMemory(instance: TestServer["instance"], body: Record<string, unknown>): Promise<{ id: number }> {
  const response = await api(instance, "POST", "/memories", { body: { agent: "agent-safety", ...body } });
  expect(response.status).toBe(201);
  return response.body as { id: number };
}

/** 等 diagnostics 的 ready 筆數。 */
async function waitForReady(instance: TestServer["instance"] | MnemoshelfServer, count: number): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const response = await api(instance, "GET", "/diagnostics");
    const memories = (response.body as DiagnosticsResponse).memories;
    if (memories.ready >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`等待 ${count} 筆記憶就緒逾時`);
}

describe("記憶遮罩：寫入前 + 讀取再遮", () => {
  it("POST /memories 寫入前遮罩，回應帶 redacted／redactedCount，GET 也只回遮罩後內容", async () => {
    server = await startTestServer();
    const instance = server.instance;
    const content = `設定：${SECRETS.assignment}\n金鑰：${SECRETS.openAiStyle}\nDB=${SECRETS.connection}`;

    const created = await api(instance, "POST", "/memories", { body: { content, agent: "agent-safety" } });
    expect(created.status).toBe(201);
    const body = created.body as { content: string; redacted: boolean; redactedCount: number };
    expect(body.redacted).toBe(true);
    expect(body.redactedCount).toBeGreaterThanOrEqual(3);
    expect(body.content).toContain("[REDACTED:assignment]");
    expect(body.content).toContain("[REDACTED:token]");
    expect(body.content).toContain("[REDACTED:connection-string]");
    for (const raw of ["correcthorsebattery", "0123456789abcdefghij", "s3cretpass"]) {
      expect(body.content).not.toContain(raw);
    }

    // 實際存進 DB 的也是遮罩後內容（不是只在回應遮）。
    const stored = await instance.store.getMemory((created.body as { id: number }).id);
    expect(stored?.content).toContain("[REDACTED:token]");
    expect(stored?.content).not.toContain("0123456789abcdefghij");

    const listed = (await api(instance, "GET", "/memories")).body as ListMemoriesResponse;
    expect(listed.memories[0]?.content).toContain("[REDACTED:token]");
    expect(listed.memories[0]?.content).not.toContain("0123456789abcdefghij");
    expect(listed.untrusted).toBe(true);
  });

  it("supersedes 的新版本內容同樣在寫入前遮罩", async () => {
    server = await startTestServer();
    const instance = server.instance;
    const first = await createMemory(instance, { content: "舊版本內容" });
    const second = await createMemory(instance, {
      content: `新版本：${SECRETS.pem}`,
      supersedes: first.id,
    });
    const stored = await instance.store.getMemory(second.id);
    expect(stored?.content).toContain("[REDACTED:private-key]");
    expect(stored?.content).not.toContain("MIIEfakefakefakefake");
  });

  it("既有未遮罩資料：GET／召回／`/search` 記憶命中／PATCH 回應都會再遮一次", async () => {
    server = await startTestServer();
    const instance = server.instance;
    // 繞過 REST 直接寫入，模擬舊版未遮罩資料。
    const legacy = await instance.store.addMemory({
      content: `legacy 機密 ${SECRETS.openAiStyle} 與 ${SECRETS.awsStyle}`,
      kind: "fact",
      scope: "global",
      project: null,
      agent: "legacy-agent",
      supersedes: null,
    });

    const listed = (await api(instance, "GET", "/memories")).body as ListMemoriesResponse;
    const listedLegacy = listed.memories.find((memory) => memory.id === legacy.id);
    expect(listedLegacy?.content).toContain("[REDACTED:token]");
    expect(listedLegacy?.content).not.toContain("0123456789abcdefghij");
    expect(listedLegacy?.content).not.toContain("ABCDEFGHIJKLMNOP");

    // 召回（語意不可用 → 關鍵字；不影響遮罩驗證）。
    const recall = await api(instance, "POST", "/memories/search", { body: { query: "legacy", scope: "global" } });
    expect(recall.status).toBe(200);
    const recallBody = recall.body as MemoryRecallResponseBody;
    const recalled = recallBody.hits.find((hit) => hit.id === legacy.id);
    expect(recalled).toBeDefined();
    expect(recalled?.content).toContain("[REDACTED:token]");
    expect(recalled?.content).not.toContain("0123456789abcdefghij");
    expect(recalled?.untrusted).toBe(true);

    // `/search` 的記憶命中（keyword 路徑）。
    const search = await api(instance, "POST", "/search", { body: { query: "legacy", mode: "keyword" } });
    const hits = (search.body as { hits: { type: string; id?: number; text?: string }[] }).hits;
    const memoryHit = hits.find((hit) => hit.type === "memory" && hit.id === legacy.id);
    expect(memoryHit).toBeDefined();
    expect(memoryHit?.text).toContain("[REDACTED:token]");
    expect(memoryHit?.text).not.toContain("0123456789abcdefghij");

    // PATCH 回應（讀取路徑）也不洩漏原文。
    const patched = await api(instance, "PATCH", `/memories/${legacy.id}`, { body: { scope: "global" } });
    expect(patched.status).toBe(200);
    expect((patched.body as { content: string }).content).toContain("[REDACTED:token]");
    expect((patched.body as { content: string }).content).not.toContain("0123456789abcdefghij");
  });

  it("已遮罩內容再讀一次不會二次變化（idempotent）", async () => {
    server = await startTestServer();
    const instance = server.instance;
    const legacy = await instance.store.addMemory({
      content: `legacy ${OLD_REDACTED} 與一般文字`,
      kind: "fact",
      scope: "global",
      project: null,
      agent: "legacy-agent",
      supersedes: null,
    });
    const listed = (await api(instance, "GET", "/memories")).body as ListMemoriesResponse;
    expect(listed.memories.find((memory) => memory.id === legacy.id)?.content).toBe(
      `legacy ${OLD_REDACTED} 與一般文字`,
    );
  });

  it("F2：常見複合名稱／JSON 風格／小寫 bearer／空帳號連線字串在寫入時遮罩", async () => {
    server = await startTestServer();
    const sample = fake("abc123", "def456", "ghi789");
    const content = [
      `${"client_secret"} = "${sample}"`,
      fake('{"token":"', sample, '"}'),
      `authorization: ${"bearer"} ${"abcdefghijklmnopqrstuvwxyz012345"}`,
      fake("post", "gres://", ":", "s3cretpass", "@", "db.example.test/app"),
    ].join("\n");
    const created = await api(server.instance, "POST", "/memories", { body: { content, agent: "agent-safety" } });
    const body = created.body as { content: string; redacted: boolean; redactedCount: number };
    expect(body.redacted).toBe(true);
    expect(body.redactedCount).toBeGreaterThanOrEqual(4);
    expect(body.content).toContain("[REDACTED:assignment]");
    expect(body.content).toContain("[REDACTED:bearer]");
    expect(body.content).toContain("[REDACTED:connection-string]");
    expect(body.content).not.toContain(sample);
    expect(body.content).not.toContain("s3cretpass");
  });

  it("正常文字（commit SHA、UUID、一般程式碼）不被寫入遮罩", async () => {
    server = await startTestServer();
    const content = "修正 abcdef1234567890abcdef1234567890abcdef12；id=550e8400-e29b-41d4-a716-446655440000";
    const created = await api(server.instance, "POST", "/memories", { body: { content, agent: "agent-safety" } });
    const body = created.body as { content: string; redacted: boolean; redactedCount: number };
    expect(body.redacted).toBe(false);
    expect(body.redactedCount).toBe(0);
    expect(body.content).toBe(content);
  });

  it("F1 regression：sk-learn-*、dotted 識別字、一般 URL／版本／路徑不被寫入遮罩", async () => {
    server = await startTestServer();
    const content = [
      "NORMAL 安裝 sk-learn-basics 與 sk-learn-clustering 套件",
      "application.services.authentication",
      "my_package.some_module.function_name",
      "https://example.test:8443/api/v1/resource",
      "version v1.2.3（packages/server/src/index.ts）",
    ].join("；");
    const created = await api(server.instance, "POST", "/memories", { body: { content, agent: "agent-safety" } });
    const body = created.body as { content: string; redacted: boolean; redactedCount: number };
    expect(body.redacted).toBe(false);
    expect(body.redactedCount).toBe(0);
    expect(body.content).toBe(content);
  });
});

describe("metadata 遮罩與拒絕（F3）／GET 查詢上限（O1）", () => {
  it("F3：POST／PATCH 的 agent／project 含 token-like 機密 → 400", async () => {
    server = await startTestServer();
    const instance = server.instance;
    const sample = SECRETS.openAiStyle;

    expect((await api(instance, "POST", "/memories", { body: { content: "x", agent: `agent-${sample}` } })).status).toBe(400);
    expect(
      (
        await api(instance, "POST", "/memories", {
          body: { content: "x", agent: "agent-safety", scope: "project", project: `proj-${sample}` },
        })
      ).status,
    ).toBe(400);

    const memory = await createMemory(instance, { content: "PATCH metadata 檢查", scope: "global" });
    const patched = await api(instance, "PATCH", `/memories/${memory.id}`, {
      body: { scope: "project", project: `proj-${sample}` },
    });
    expect(patched.status).toBe(400);
    expect((patched.body as { error: { name: string } }).error.name).toBe("ValidationError");
  });

  it("F3：legacy 的 agent／project 在讀取路徑也遮罩（GET／召回／PATCH／pin；idempotent）", async () => {
    server = await startTestServer();
    const instance = server.instance;
    const sample = SECRETS.openAiStyle;
    const legacy = await instance.store.addMemory({
      content: "legacy metadata 內容",
      kind: "fact",
      scope: "project",
      project: `proj-${sample}`,
      agent: `agent-${sample}`,
      supersedes: null,
    });

    const expectMasked = (memory: { agent: string; project: string | null }): void => {
      expect(memory.agent).toContain("[REDACTED:token]");
      expect(memory.agent).not.toContain(sample);
      expect(memory.project).toContain("[REDACTED:token]");
      expect(memory.project).not.toContain(sample);
    };

    const listed = (await api(instance, "GET", "/memories")).body as ListMemoriesResponse;
    const listedLegacy = listed.memories.find((memory) => memory.id === legacy.id);
    expect(listedLegacy).toBeDefined();
    expectMasked(listedLegacy!);

    // 第二次 GET：idempotent（不再二次變化）。
    const listedAgain = (await api(instance, "GET", "/memories")).body as ListMemoriesResponse;
    expect(listedAgain.memories.find((memory) => memory.id === legacy.id)?.agent).toBe(listedLegacy!.agent);

    const recall = await api(instance, "POST", "/memories/search", { body: { query: "legacy", scope: "global" } });
    // 召回 bucket 為 global，legacy 是 project scope → 用 project 過濾查詢以確保命中。
    expect(recall.status).toBe(200);
    const recallProject = await api(instance, "POST", "/memories/search", {
      body: { query: "legacy", project: `proj-${sample}` },
    });
    expect(recallProject.status).toBe(200);
    const hits = (recallProject.body as MemoryRecallResponseBody).hits;
    const recalled = hits.find((hit) => hit.id === legacy.id);
    expect(recalled).toBeDefined();
    expectMasked(recalled!);

    // PATCH 成 global 會把 project 清為 null；agent 仍要遮罩。
    const patched = await api(instance, "PATCH", `/memories/${legacy.id}`, { body: { scope: "global" } });
    expect(patched.status).toBe(200);
    const patchedBody = patched.body as { agent: string; project: string | null };
    expect(patchedBody.agent).toContain("[REDACTED:token]");
    expect(patchedBody.agent).not.toContain(sample);
    expect(patchedBody.project).toBeNull();

    const pinned = await api(instance, "POST", `/memories/${legacy.id}/pin`, { body: { pinned: true } });
    expect(pinned.status).toBe(200);
    const pinnedBody = pinned.body as { agent: string; project: string | null };
    expect(pinnedBody.agent).toContain("[REDACTED:token]");
    expect(pinnedBody.agent).not.toContain(sample);
    expect(pinnedBody.project).toBeNull();
  });

  it("O1：GET /memories 的 agent／project 查詢參數上限 200（超過 400）", async () => {
    server = await startTestServer();
    const instance = server.instance;
    const tooLong = "a".repeat(201);
    const okLong = "a".repeat(200);

    expect((await api(instance, "GET", `/memories?agent=${tooLong}`)).status).toBe(400);
    expect((await api(instance, "GET", `/memories?project=${tooLong}`)).status).toBe(400);
    expect((await api(instance, "GET", `/memories?agent=${okLong}`)).status).toBe(200);
    expect((await api(instance, "GET", `/memories?project=${okLong}`)).status).toBe(200);
  });
});

describe("信任標記", () => {
  it("GET /memories 頂層 untrusted=true；召回每筆命中 untrusted=true", async () => {
    server = await startTestServer();
    const instance = server.instance;
    await createMemory(instance, { content: "信任標記測試內容" });

    const listed = (await api(instance, "GET", "/memories")).body as ListMemoriesResponse;
    expect(listed.untrusted).toBe(true);

    const recall = await api(instance, "POST", "/memories/search", { body: { query: "信任標記", scope: "global" } });
    const body = recall.body as MemoryRecallResponseBody;
    expect(body.hits.length).toBeGreaterThan(0);
    for (const hit of body.hits) expect(hit.untrusted).toBe(true);
  });
});

describe("輸入長度上限", () => {
  it("POST /memories：agent／project 上限 200，超過 400", async () => {
    server = await startTestServer();
    const instance = server.instance;
    const tooLong = "a".repeat(201);
    const okLong = "a".repeat(200);

    expect((await api(instance, "POST", "/memories", { body: { content: "x", agent: tooLong } })).status).toBe(400);
    expect(
      (await api(instance, "POST", "/memories", { body: { content: "x", agent: "t", scope: "project", project: tooLong } }))
        .status,
    ).toBe(400);
    const ok = await api(instance, "POST", "/memories", {
      body: { content: "x", agent: okLong, scope: "project", project: okLong },
    });
    expect(ok.status).toBe(201);
  });

  it("PATCH /memories/:id：project 上限 200，超過 400", async () => {
    server = await startTestServer();
    const instance = server.instance;
    const memory = await createMemory(instance, { content: "PATCH 上限測試", scope: "global" });
    const tooLong = "p".repeat(201);
    const response = await api(instance, "PATCH", `/memories/${memory.id}`, {
      body: { scope: "project", project: tooLong },
    });
    expect(response.status).toBe(400);
    expect((response.body as { error: { name: string } }).error.name).toBe("ValidationError");
  });

  it("POST /memories/search：query 上限 2,000、agent／project 上限 200，超過 400", async () => {
    server = await startTestServer();
    const instance = server.instance;
    const tooLong = "q".repeat(201);

    expect((await api(instance, "POST", "/memories/search", { body: { query: "x", scope: "global", agent: tooLong } })).status).toBe(400);
    expect((await api(instance, "POST", "/memories/search", { body: { query: "x", project: tooLong } })).status).toBe(400);
    expect((await api(instance, "POST", "/memories/search", { body: { query: "q".repeat(2001), scope: "global" } })).status).toBe(400);

    // 邊界值可通過（2000 字查詢；資料為空 → 200 空結果）。
    const boundary = await api(instance, "POST", "/memories/search", { body: { query: "q".repeat(2000), scope: "global" } });
    expect(boundary.status).toBe(200);
  });
});

describe("啟動回填 opt-out（MNEMOSHELF_MEMORY_BACKFILL）", () => {
  it("設定解析：預設 on、on／off 合法、其他值啟動失敗", () => {
    const base = { MNEMOSHELF_TOKEN: "synthetic-token" };
    expect(loadServerConfig(base).memoryBackfill).toBe(true);
    expect(loadServerConfig({ ...base, MNEMOSHELF_MEMORY_BACKFILL: "on" }).memoryBackfill).toBe(true);
    expect(loadServerConfig({ ...base, MNEMOSHELF_MEMORY_BACKFILL: " OFF " }).memoryBackfill).toBe(false);
    expect(() => loadServerConfig({ ...base, MNEMOSHELF_MEMORY_BACKFILL: "maybe" })).toThrow(/MNEMOSHELF_MEMORY_BACKFILL/);
  });

  it("off：啟動不呼叫 embedder，但新寫入仍會嵌入", async () => {
    const dataDir = await makeTempDir("mnemoshelf-backfill-off-");
    tempDirs.push(dataDir);

    // 預先放一筆 pending 記憶（模擬既有資料）。
    const db = openDatabase(path.join(dataDir, "mnemoshelf.db"));
    const store = new SqliteMetadataStore(db);
    await store.migrate();
    await store.addMemory({
      content: "既有 pending 記憶",
      kind: "fact",
      scope: "global",
      project: null,
      agent: "legacy",
      supersedes: null,
    });
    db.close();

    const embedder = new CountingEmbedder();
    const instance = await createServer({
      env: { MNEMOSHELF_MEMORY_BACKFILL: "off" },
      token: TEST_TOKEN,
      dataDir,
      port: 0,
      embedder,
      memoryEmbedding: { retryDelayMs: 0 },
    });
    extraServers.push(instance);
    try {
      // 給 worker 一點時間：若誤跑啟動回填，會在這裡看到 embedDocument 被呼叫。
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(embedder.embedDocumentCalls).toBe(0);

      const before = (await api(instance, "GET", "/diagnostics")).body as DiagnosticsResponse;
      expect(before.memories.pending).toBeGreaterThanOrEqual(1);

      // 新寫入仍會 enqueue → 嵌入。
      const created = await api(instance, "POST", "/memories", { body: { content: "新的記憶", agent: "agent-safety" } });
      expect(created.status).toBe(201);
      await waitForReady(instance, 1);
      expect(embedder.embedDocumentCalls).toBe(1);
      const after = (await api(instance, "GET", "/diagnostics")).body as DiagnosticsResponse;
      expect(after.memories.ready).toBe(1);
      expect(after.memories.pending).toBeGreaterThanOrEqual(1);
    } finally {
      const index = extraServers.indexOf(instance);
      if (index >= 0) extraServers.splice(index, 1);
      await instance.close();
    }
  });
});

describe("資料目錄權限（POSIX；best-effort）", () => {
  it.skipIf(process.platform === "win32")("資料目錄 700、DB 檔 600", async () => {
    const dataDir = await makeTempDir("mnemoshelf-permissions-");
    tempDirs.push(dataDir);
    // 先刻意放寬，證明 createServer 會收緊。
    await fs.chmod(dataDir, 0o777);

    const instance = await createServer({
      env: {},
      token: TEST_TOKEN,
      dataDir,
      port: 0,
      embedder: new CountingEmbedder(),
    });
    extraServers.push(instance);
    try {
      const dirStat = await fs.stat(dataDir);
      expect(dirStat.mode & 0o777).toBe(0o700);
      const dbStat = await fs.stat(path.join(dataDir, "mnemoshelf.db"));
      expect(dbStat.mode & 0o777).toBe(0o600);
    } finally {
      const index = extraServers.indexOf(instance);
      if (index >= 0) extraServers.splice(index, 1);
      await instance.close();
    }
  });
});
