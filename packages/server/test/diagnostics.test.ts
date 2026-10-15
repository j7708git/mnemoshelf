/**
 * `GET /diagnostics`（除錯資訊匯出）的整合測試，以及家目錄遮罩函式的單元測試。
 *
 * 覆蓋任務卡驗收 2（家目錄遮罩、缺統計標記、401）與驗收 4（隱私自檢）。
 * 一律使用 `os.tmpdir()` 下的合成資料；家目錄用假目錄，不讀取任何使用者檔案。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  api,
  errorName,
  makeTempDir,
  removeTempDir,
  SlowEmbedder,
  startTestServer,
  TEST_TOKEN,
  type TestServer,
} from "./helpers.js";
import { maskHomePath, type DiagnosticsResponse } from "../src/index.js";

let server: TestServer | undefined;
/** 追蹤要刪除的頂層暫存目錄（含其子目錄）。 */
const tempDirs: string[] = [];

afterEach(async () => {
  await server?.close();
  server = undefined;
  while (tempDirs.length > 0) await removeTempDir(tempDirs.pop()!);
});

/** 建立 realpath 後的暫存目錄（家目錄前綴比對需要一致的真實路徑）。 */
async function tempDir(prefix: string): Promise<string> {
  const dir = await fs.realpath(await makeTempDir(prefix));
  tempDirs.push(dir);
  return dir;
}

/** 在假家目錄下建立一個含文字檔的 root 目錄。 */
async function makeRootIn(home: string, name: string): Promise<string> {
  const dir = path.join(home, name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "notes.md"), "# 診斷測試\n\nalpha beta gamma\n", "utf8");
  return dir;
}

describe("maskHomePath", () => {
  it("POSIX：家目錄本身與其子路徑遮成 ~", () => {
    expect(maskHomePath("/home/example", "/home/example")).toBe("~");
    expect(maskHomePath("/home/example/docs", "/home/example")).toBe("~/docs");
  });

  it("不誤遮同前綴的兄弟目錄", () => {
    const home = "/home/example";
    const sibling = `${home}2/docs`;
    expect(maskHomePath(sibling, home)).toBe(sibling);
  });

  it("Windows 風格字串（在 POSIX 上）也能遮罩", () => {
    expect(maskHomePath("C:\\Users\\example", "C:\\Users\\example")).toBe("~");
    expect(maskHomePath("C:\\Users\\example\\docs", "C:\\Users\\example")).toBe("~/docs");
  });

  it("Windows 磁碟路徑不分大小寫", () => {
    expect(maskHomePath("c:\\users\\EXAMPLE\\docs", "C:\\Users\\example")).toBe("~/docs");
  });

  it("家目錄為空字串時原樣回傳（不亂遮）", () => {
    expect(maskHomePath("/anything/here", "")).toBe("/anything/here");
  });

  it("沒命中時原樣回傳（不順手改分隔符）", () => {
    expect(maskHomePath("D:\\projects\\demo", "C:\\Users\\example")).toBe("D:\\projects\\demo");
    expect(maskHomePath("/var/log", "/home/example")).toBe("/var/log");
  });
});

describe("GET /diagnostics", () => {
  it("無 token → 401", async () => {
    server = await startTestServer();
    const response = await api(server.instance, "GET", "/diagnostics", { token: null });
    expect(response.status).toBe(401);
    expect(errorName(response.body)).toBe("UnauthorizedError");
  });

  it("非 GET → 405；未知子路徑 → 404", async () => {
    server = await startTestServer();
    expect((await api(server.instance, "POST", "/diagnostics")).status).toBe(405);
    expect((await api(server.instance, "GET", "/diagnostics/extra")).status).toBe(404);
  });

  it("回傳必填欄位（版本／平台／embedder／roots／indexing）", async () => {
    server = await startTestServer();
    const response = await api(server.instance, "GET", "/diagnostics");
    expect(response.status).toBe(200);

    const body = response.body as DiagnosticsResponse;
    expect(typeof body.generatedAt).toBe("string");
    expect(Number.isNaN(Date.parse(body.generatedAt))).toBe(false);
    expect(body.app.name).toBe("mnemoshelf");
    expect(body.app.version).not.toBe("");
    expect(body.app.node).toBe(process.version);
    expect(body.app.platform).toBe(os.platform());
    expect(body.app.arch).toBe(os.arch());
    expect(typeof body.embedder.id).toBe("string");
    expect(body.embedder.id).not.toBe("");
    expect(body.embedder.dim).toBeGreaterThan(0);
    expect(body.embedder.capabilities.text).toBe(true);
    expect(body.embedder.capabilities.image).toBe(true);
    expect(Array.isArray(body.roots)).toBe(true);
    expect(Array.isArray(body.indexing)).toBe(true);
  });

  it("家目錄前綴遮成 ~，輸出不含原始家目錄字串", async () => {
    const fakeHome = await tempDir("mnemoshelf-home-");
    const rootDir = await makeRootIn(fakeHome, "projects");
    server = await startTestServer({ homeDir: fakeHome });

    const created = await api(server.instance, "POST", "/roots", { body: { path: rootDir } });
    expect(created.status).toBe(201);

    const response = await api(server.instance, "GET", "/diagnostics");
    expect(response.status).toBe(200);
    const body = response.body as DiagnosticsResponse;
    expect(body.roots).toHaveLength(1);
    expect(body.roots[0]!.path).toBe("~/projects");
    // 原始家目錄字串不得出現在輸出的任何一處。
    expect(JSON.stringify(body)).not.toContain(fakeHome);
  });

  it("從未 preview／索引的 root：stats 為 null、statsUnavailable: true，整體仍 200", async () => {
    const fakeHome = await tempDir("mnemoshelf-home-");
    const rootDir = await makeRootIn(fakeHome, "fresh");
    server = await startTestServer({ homeDir: fakeHome });
    await api(server.instance, "POST", "/roots", { body: { path: rootDir } });

    const response = await api(server.instance, "GET", "/diagnostics");
    expect(response.status).toBe(200);
    const body = response.body as DiagnosticsResponse;
    expect(body.roots[0]!.stats).toBeNull();
    expect(body.roots[0]!.statsSource).toBeNull();
    expect(body.roots[0]!.statsUnavailable).toBe(true);
    expect(body.roots[0]!.lastIndex).toBeNull();
  });

  it("preview 後：統計以 preview 帶入（含 totalBytes／byKind／estimatedChunks）", async () => {
    const fakeHome = await tempDir("mnemoshelf-home-");
    const rootDir = await makeRootIn(fakeHome, "previewed");
    server = await startTestServer({ homeDir: fakeHome });
    const created = await api(server.instance, "POST", "/roots", { body: { path: rootDir } });
    const rootId = (created.body as { id: number }).id;

    expect((await api(server.instance, "POST", `/roots/${rootId}/preview`)).status).toBe(200);

    const body = (await api(server.instance, "GET", "/diagnostics")).body as DiagnosticsResponse;
    expect(body.roots[0]!.statsSource).toBe("preview");
    expect(body.roots[0]!.statsUnavailable).toBe(false);
    expect(body.roots[0]!.stats!.totalFiles).toBeGreaterThan(0);
    expect(body.roots[0]!.stats!.totalBytes).toBeGreaterThan(0);
    expect(body.roots[0]!.stats!.byKind).not.toBeNull();
    expect(body.roots[0]!.stats!.estimatedChunks).toBeGreaterThanOrEqual(0);
  });

  it("只索引、未 preview：統計以索引結果帶入，缺欄位明確為 null", async () => {
    const fakeHome = await tempDir("mnemoshelf-home-");
    const rootDir = await makeRootIn(fakeHome, "indexed");
    server = await startTestServer({ homeDir: fakeHome });
    const created = await api(server.instance, "POST", "/roots", { body: { path: rootDir } });
    const rootId = (created.body as { id: number }).id;

    expect((await api(server.instance, "POST", `/roots/${rootId}/index`)).status).toBe(200);

    const body = (await api(server.instance, "GET", "/diagnostics")).body as DiagnosticsResponse;
    const root = body.roots[0]!;
    expect(root.statsSource).toBe("index");
    expect(root.statsUnavailable).toBe(false);
    expect(root.stats!.totalFiles).toBeGreaterThan(0);
    // 索引結果不含這些欄位：明確 null，不造數字。
    expect(root.stats!.totalBytes).toBeNull();
    expect(root.stats!.byKind).toBeNull();
    expect(root.stats!.estimatedChunks).toBeNull();
    expect(root.lastIndex!.state).toBe("completed");
    expect(root.lastIndex!.processed).toBeGreaterThan(0);
    expect(root.lastIndex!.failedByReason).toEqual({});
  });

  it("輸出不含 token／Authorization／子檔案清單（隱私自檢）", async () => {
    const fakeHome = await tempDir("mnemoshelf-home-");
    const rootDir = await makeRootIn(fakeHome, "private");
    server = await startTestServer({ homeDir: fakeHome });
    const created = await api(server.instance, "POST", "/roots", { body: { path: rootDir } });
    const rootId = (created.body as { id: number }).id;
    await api(server.instance, "POST", `/roots/${rootId}/index`);

    const body = (await api(server.instance, "GET", "/diagnostics")).body as DiagnosticsResponse;
    const text = JSON.stringify(body);
    expect(text).not.toContain(TEST_TOKEN);
    expect(text.toLowerCase()).not.toContain("authorization");
    expect(text.toLowerCase()).not.toContain("bearer");
    // 只有計數與短標籤，沒有子檔案清單。
    expect(text).not.toContain("notes.md");
    expect(text).not.toContain("relPath");
  });

  it("進行中的索引出現在 indexing，結束後清空", async () => {
    const fakeHome = await tempDir("mnemoshelf-home-");
    const rootDir = await makeRootIn(fakeHome, "running");
    server = await startTestServer({ homeDir: fakeHome, embedder: new SlowEmbedder(150) });
    const created = await api(server.instance, "POST", "/roots", { body: { path: rootDir } });
    const rootId = (created.body as { id: number }).id;

    const indexing = api(server.instance, "POST", `/roots/${rootId}/index`);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const during = (await api(server.instance, "GET", "/diagnostics")).body as DiagnosticsResponse;
    expect(during.indexing.map((item) => item.rootId)).toContain(rootId);

    await indexing;
    const after = (await api(server.instance, "GET", "/diagnostics")).body as DiagnosticsResponse;
    expect(after.indexing).toEqual([]);
  });
});
