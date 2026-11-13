/**
 * M7.5／1B：root 的「允許 Agent 搜尋」開關與通用單檔上限（持久化與 REST 行為）。
 *
 * 覆蓋：
 * - `POST /roots`／`PATCH /roots/:id` 接受 `allowAgentSearch` 與 `maxFileBytes`；
 *   至少一項、非法值 400 且不動資料、未知 root 404、成功 200、不觸發重新索引；
 * - `POST /search` 的 `agentOnly`：false 搜全部、true 只搜勾選的 roots、與 rootIds 取交集、
 *   不影響 memories 召回；
 * - **重啟回歸**：設定 `maxFileBytes` 後關掉服務、用同一份資料目錄重開，值仍在
 *   （不再回退 10 MiB）。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Root, RootPreview } from "@mnemoshelf/core";
import type { DiagnosticsResponse, UnifiedSearchResult } from "../src/index.js";
import { api, makeTempDir, removeTempDir, startTestServer, type TestServer } from "./helpers.js";

let server: TestServer | undefined;
const tempDirs: string[] = [];
afterEach(async () => {
  await server?.close();
  server = undefined;
  while (tempDirs.length > 0) await removeTempDir(tempDirs.pop()!);
});

async function makeDir(prefix: string, files: Record<string, string>): Promise<string> {
  const dir = await makeTempDir(prefix);
  tempDirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    await fs.writeFile(path.join(dir, name), content, "utf8");
  }
  return dir;
}

async function createRoot(body: Record<string, unknown>): Promise<Root> {
  const created = await api(server!.instance, "POST", "/roots", {
    body: { path: await makeDir("mnemoshelf-agent-share-root-", { "notes.md": "範圍搜尋測試" }), modalities: ["text"], ...body },
  });
  expect(created.status).toBe(201);
  return created.body as Root;
}

async function getRoot(id: number): Promise<Root> {
  const response = await api(server!.instance, "GET", `/roots/${id}`);
  expect(response.status).toBe(200);
  return response.body as Root;
}

async function search(body: Record<string, unknown>): Promise<UnifiedSearchResult> {
  const response = await api(server!.instance, "POST", "/search", { body: { query: "範圍搜尋測試", mode: "keyword", ...body } });
  expect(response.status).toBe(200);
  return response.body as UnifiedSearchResult;
}

describe("POST／PATCH：allowAgentSearch 與 maxFileBytes", () => {
  it("建立時可帶兩欄位；GET／PATCH 反映新值；只改一項不動其他欄位", async () => {
    server = await startTestServer();
    const root = await createRoot({ allowAgentSearch: true, maxFileBytes: 1024, modalities: ["text", "code"] });
    expect(root.allowAgentSearch).toBe(true);
    expect(root.maxFileBytes).toBe(1024);
    expect((await getRoot(root.id)).allowAgentSearch).toBe(true);
    expect((await getRoot(root.id)).maxFileBytes).toBe(1024);

    // 只改分享開關：modalities 與上限不變。
    const shared = await api(server.instance, "PATCH", `/roots/${root.id}`, { body: { allowAgentSearch: false } });
    expect(shared.status).toBe(200);
    const afterToggle = shared.body as Root;
    expect(afterToggle.allowAgentSearch).toBe(false);
    expect(afterToggle.modalities).toEqual(["text", "code"]);
    expect(afterToggle.maxFileBytes).toBe(1024);

    // 只改通用上限：分享開關與 modalities 不變。
    const limited = await api(server.instance, "PATCH", `/roots/${root.id}`, { body: { maxFileBytes: 2048 } });
    expect(limited.status).toBe(200);
    const afterLimit = limited.body as Root;
    expect(afterLimit.maxFileBytes).toBe(2048);
    expect(afterLimit.allowAgentSearch).toBe(false);
    expect(afterLimit.modalities).toEqual(["text", "code"]);

    // null＝清除通用上限（欄位消失），分享開關維持。
    const cleared = await api(server.instance, "PATCH", `/roots/${root.id}`, { body: { maxFileBytes: null } });
    expect(cleared.status).toBe(200);
    expect(cleared.body as Root).not.toHaveProperty("maxFileBytes");
    expect((cleared.body as Root).allowAgentSearch).toBe(false);
    expect(await getRoot(root.id)).not.toHaveProperty("maxFileBytes");
  });

  it("非法值 → 400 且不改資料；空 patch → 400；未知 root → 404", async () => {
    server = await startTestServer();
    const root = await createRoot({ allowAgentSearch: true, maxFileBytes: 4096 });

    const invalid: unknown[] = [0, -1, 1.5, 16 * 1024 ** 3 + 1, "1024", {}];
    for (const value of invalid) {
      const patched = await api(server.instance, "PATCH", `/roots/${root.id}`, { body: { maxFileBytes: value } });
      expect(patched.status, String(value)).toBe(400);
      expect((patched.body as { error: { name: string } }).error.name).toBe("ValidationError");
    }
    for (const value of ["true", 1, null]) {
      const patched = await api(server.instance, "PATCH", `/roots/${root.id}`, { body: { allowAgentSearch: value } });
      expect(patched.status, String(value)).toBe(400);
    }

    // 失敗的更新不得改動資料。
    const after = await getRoot(root.id);
    expect(after.allowAgentSearch).toBe(true);
    expect(after.maxFileBytes).toBe(4096);

    const empty = await api(server.instance, "PATCH", `/roots/${root.id}`, { body: {} });
    expect(empty.status).toBe(400);
    expect((empty.body as { error: { message: string } }).error.message).toContain("allowAgentSearch");

    const missing = await api(server.instance, "PATCH", "/roots/987654", { body: { allowAgentSearch: true } });
    expect(missing.status).toBe(404);

    // POST 的非法值同樣 400（含通用上限走共用驗證入口）。
    for (const value of [0, -1, 1.5, 16 * 1024 ** 3 + 1, "1024", {}]) {
      const created = await api(server.instance, "POST", "/roots", {
        body: { path: await makeDir("mnemoshelf-agent-invalid-", {}), modalities: ["text"], maxFileBytes: value },
      });
      expect(created.status, String(value)).toBe(400);
    }
    for (const value of ["true", 1, null]) {
      const created = await api(server.instance, "POST", "/roots", {
        body: { path: await makeDir("mnemoshelf-agent-invalid-", {}), modalities: ["text"], allowAgentSearch: value },
      });
      expect(created.status, String(value)).toBe(400);
    }
  });

  it("PATCH 不觸發重新索引（diagnostics 的 lastIndex 仍為 null）", async () => {
    server = await startTestServer();
    const root = await createRoot({ allowAgentSearch: false });
    const patched = await api(server.instance, "PATCH", `/roots/${root.id}`, {
      body: { allowAgentSearch: true, maxFileBytes: 1024 },
    });
    expect(patched.status).toBe(200);

    const diagnostics = (await api(server.instance, "GET", "/diagnostics")).body as DiagnosticsResponse;
    expect(diagnostics.roots.find((entry) => entry.id === root.id)?.lastIndex).toBeNull();
  });
});

describe("POST /search：agentOnly", () => {
  async function makeSharedAndHidden(): Promise<{ sharedId: number; hiddenId: number }> {
    const sharedDir = await makeDir("mnemoshelf-agent-shared-", { "shared.md": "範圍搜尋測試 分享" });
    const hiddenDir = await makeDir("mnemoshelf-agent-hidden-", { "hidden.md": "範圍搜尋測試 未分享" });
    const shared = await api(server!.instance, "POST", "/roots", {
      body: { path: sharedDir, modalities: ["text"], allowAgentSearch: true },
    });
    const hidden = await api(server!.instance, "POST", "/roots", {
      body: { path: hiddenDir, modalities: ["text"] },
    });
    const sharedId = (shared.body as { id: number }).id;
    const hiddenId = (hidden.body as { id: number }).id;
    expect((await api(server!.instance, "POST", `/roots/${sharedId}/index`)).status).toBe(200);
    expect((await api(server!.instance, "POST", `/roots/${hiddenId}/index`)).status).toBe(200);
    return { sharedId, hiddenId };
  }

  function chunkRootIds(result: UnifiedSearchResult): Set<number> {
    return new Set(result.hits.filter((hit) => hit.type === "chunk").map((hit) => hit.rootId));
  }

  it("預設（false）搜全部；true 只搜勾選的 roots", async () => {
    server = await startTestServer();
    const { sharedId, hiddenId } = await makeSharedAndHidden();

    expect(chunkRootIds(await search({ agentOnly: false }))).toEqual(new Set([sharedId, hiddenId]));
    expect(chunkRootIds(await search({}))).toEqual(new Set([sharedId, hiddenId]));
    expect(chunkRootIds(await search({ agentOnly: true }))).toEqual(new Set([sharedId]));
  });

  it("與 rootIds 同時給＝取交集（agentOnly 是更嚴格的一層）", async () => {
    server = await startTestServer();
    const { sharedId, hiddenId } = await makeSharedAndHidden();

    expect(chunkRootIds(await search({ agentOnly: true, rootIds: [sharedId, hiddenId] }))).toEqual(new Set([sharedId]));
    expect(chunkRootIds(await search({ agentOnly: true, rootIds: [hiddenId] }))).toEqual(new Set());
    expect(chunkRootIds(await search({ agentOnly: false, rootIds: [hiddenId] }))).toEqual(new Set([hiddenId]));
  });

  it("只過濾 roots／chunks，不影響 memories 召回", async () => {
    server = await startTestServer();
    const { sharedId } = await makeSharedAndHidden();
    const remembered = await api(server.instance, "POST", "/memories", {
      body: { content: "範圍搜尋測試 這是記憶", kind: "fact", scope: "global", agent: "agent-share-test" },
    });
    expect(remembered.status).toBe(201);
    const memoryId = (remembered.body as { id: number }).id;

    // 有勾選分享：chunk 只來自分享 root，記憶仍在。
    const shared = await search({ agentOnly: true });
    expect(shared.hits.some((hit) => hit.type === "memory" && hit.id === memoryId)).toBe(true);
    expect(chunkRootIds(shared)).toEqual(new Set([sharedId]));

    // 沒有任何分享（把唯一分享的 root 關掉）：chunk 全空，但記憶仍回。
    const roots = (await api(server.instance, "GET", "/roots")).body as { roots: Root[] };
    const sharedRoot = roots.roots.find((root) => root.allowAgentSearch)!;
    expect((await api(server.instance, "PATCH", `/roots/${sharedRoot.id}`, { body: { allowAgentSearch: false } })).status).toBe(200);

    const noShare = await search({ agentOnly: true });
    expect(noShare.hits.filter((hit) => hit.type === "chunk")).toEqual([]);
    expect(noShare.hits.some((hit) => hit.type === "memory" && hit.id === memoryId)).toBe(true);

    // 明確指定 rootIds 時，維持既有規則：記憶不納入。
    const withRootIds = await search({ agentOnly: true, rootIds: [sharedRoot.id] });
    expect(withRootIds.hits.some((hit) => hit.type === "memory")).toBe(false);
  });

  it("agentOnly 非布林 → 400", async () => {
    server = await startTestServer();
    for (const value of ["true", 1, null]) {
      const response = await api(server.instance, "POST", "/search", { body: { query: "x", agentOnly: value } });
      expect(response.status, String(value)).toBe(400);
      expect((response.body as { error: { name: string } }).error.name).toBe("ValidationError");
    }
  });
});

describe("重啟回歸：maxFileBytes 持久化（不再回退 10 MiB）", () => {
  it("同一份資料目錄重開服務後，設定值仍在且 preview／index 仍套用", async () => {
    const dataDir = await makeTempDir("mnemoshelf-max-file-restart-");
    tempDirs.push(dataDir);

    server = await startTestServer({ dataDir });
    const dir = await makeDir("mnemoshelf-max-file-root-", {
      "small.txt": "小檔",
      // 2000 bytes：遠小於預設 10 MiB，但大於這個 root 的 1024 bytes 設定。
      "big.txt": "大".repeat(1000),
    });
    const created = await api(server.instance, "POST", "/roots", {
      body: { path: dir, modalities: ["text"], maxFileBytes: 1024 },
    });
    expect(created.status).toBe(201);
    const rootId = (created.body as Root).id;
    expect((created.body as Root).maxFileBytes).toBe(1024);

    const beforePreview = (await api(server.instance, "POST", `/roots/${rootId}/preview`)).body as RootPreview;
    expect(beforePreview.skipped.some((entry) => entry.relPath === "big.txt" && entry.reason === "too-large")).toBe(true);
    expect(beforePreview.totalFiles).toBe(1);
    await server.close();
    server = undefined;

    // 同一份 SQLite 資料目錄重開：值必須從資料庫讀回（不是行程內 Map）。
    server = await startTestServer({ dataDir });
    const reread = await getRoot(rootId);
    expect(reread.maxFileBytes).toBe(1024);
    const afterPreview = (await api(server.instance, "POST", `/roots/${rootId}/preview`)).body as RootPreview;
    expect(afterPreview.skipped.some((entry) => entry.relPath === "big.txt" && entry.reason === "too-large")).toBe(true);
    expect(afterPreview.totalFiles).toBe(1);

    // 若值回退成 10 MiB，big.txt（2000 bytes）會被納入；index 的實際結果也要維持只處理 1 檔。
    const indexed = await api(server.instance, "POST", `/roots/${rootId}/index`);
    expect(indexed.status).toBe(200);
    expect((indexed.body as { processed: number }).processed).toBe(1);
  });
});
