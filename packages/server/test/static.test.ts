/**
 * 靜態檔服務、SPA fallback 與 Host header 驗證（M3 Web UI 骨架）。
 *
 * 用合成的 dist 目錄（`index.html` ＋ 一個 asset），不依賴真的 build 產物；
 * 另驗證「dist 不存在時 API 仍正常」。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  api,
  errorName,
  makeTempDir,
  rawHttpRequest,
  removeTempDir,
  startTestServer,
  TEST_TOKEN,
  type TestServer,
} from "./helpers.js";

let server: TestServer | undefined;
const tempDirs: string[] = [];

afterEach(async () => {
  await server?.close();
  server = undefined;
  while (tempDirs.length > 0) await removeTempDir(tempDirs.pop()!);
});

const INDEX_HTML = "<!doctype html><html><body><div id=\"root\">MNEMOSHELF-UI</div></body></html>\n";
const APP_JS = "console.log(\"mnemoshelf-ui\");\n";

/** 建立合成的 UI build 產物目錄（`index.html` ＋ `assets/app.js`）。 */
async function makeWebDist(): Promise<string> {
  const dir = await makeTempDir("mnemoshelf-webdist-");
  tempDirs.push(dir);
  await fs.mkdir(path.join(dir, "assets"));
  await fs.writeFile(path.join(dir, "index.html"), INDEX_HTML, "utf8");
  await fs.writeFile(path.join(dir, "assets", "app.js"), APP_JS, "utf8");
  return dir;
}

/** 以原生 HTTP 請求取得完整回應（可指定 Host 與 Accept）。 */
async function get(
  instance: { port: number },
  target: string,
  options: { host?: string; accept?: string; token?: string | null } = {},
): Promise<{ status: number; head: string; body: string }> {
  const headers: Record<string, string> = {};
  if (options.accept !== undefined) headers.accept = options.accept;
  if (options.token !== null && options.token !== undefined) headers.authorization = `Bearer ${options.token}`;
  const response = await rawHttpRequest(instance.port, target, {
    ...(options.host === undefined ? {} : { host: options.host }),
    headers,
  });
  const [head = "", ...rest] = response.body.split("\r\n\r\n");
  return { status: response.status, head, body: rest.join("\r\n\r\n") };
}

describe("Host header 驗證", () => {
  it("本機 Host（127.0.0.1／localhost／[::1]，可帶埠）→ 200", async () => {
    server = await startTestServer();
    for (const host of ["127.0.0.1", "127.0.0.1:8787", "localhost", "localhost:5173", "[::1]", "[::1]:9000"]) {
      const response = await get(server.instance, "/health", { host });
      expect(response.status, `Host: ${host}`).toBe(200);
    }
  });

  it("非本機 Host → 403 InvalidHostError（含偽裝成本機名稱的字串）", async () => {
    server = await startTestServer();
    for (const host of ["evil.example", "evil.example:8787", "127.0.0.1.evil.example", "localhost.evil.example", "example.com:80", "[::2]"]) {
      const response = await get(server.instance, "/health", { host });
      expect(response.status, `Host: ${host}`).toBe(403);
      expect(response.body, `Host: ${host}`).toContain("InvalidHostError");
      expect(response.body, `Host: ${host}`).not.toContain(host);
    }
  });

  it("`*.localhost`（RFC 6761）→ 200；只是含 localhost 字串的外部名稱仍 403", async () => {
    server = await startTestServer();
    for (const host of [
      "openchamber-preview.localhost:57958",
      "foo.localhost",
      "OPENCHAMBER-PREVIEW.LOCALHOST:57958",
    ]) {
      const response = await get(server.instance, "/health", { host });
      expect(response.status, `Host: ${host}`).toBe(200);
    }
    // 邊界：`.localhost` 本身（沒有標籤）與含 localhost 但不是該後綴的名稱一律 403。
    for (const host of [".localhost", "notlocalhost", "evil.localhost.evil.example"]) {
      const response = await get(server.instance, "/health", { host });
      expect(response.status, `Host: ${host}`).toBe(403);
    }
  });

  it("Host 驗證在 API 與靜態路徑之前（不因路徑不同而放行）", async () => {
    server = await startTestServer();
    const api403 = await get(server.instance, "/roots", { host: "evil.example", token: TEST_TOKEN });
    expect(api403.status).toBe(403);
    const static403 = await get(server.instance, "/", { host: "evil.example", accept: "text/html" });
    expect(static403.status).toBe(403);
  });
});

describe("靜態檔服務與 SPA fallback", () => {
  it("GET / → index.html；GET /foo（Accept html）→ 同一份 HTML", async () => {
    const dist = await makeWebDist();
    server = await startTestServer({ webDir: dist });

    const root = await get(server.instance, "/", { accept: "text/html,application/xhtml+xml" });
    expect(root.status).toBe(200);
    expect(root.head.toLowerCase()).toContain("text/html");
    expect(root.body).toContain("MNEMOSHELF-UI");

    const fallback = await get(server.instance, "/foo", { accept: "text/html" });
    expect(fallback.status).toBe(200);
    expect(fallback.body).toContain("MNEMOSHELF-UI");
    // 與 `/` 回同一份 HTML
    expect(fallback.body).toBe(root.body);
  });

  it("curl 預設的 Accept: */* 也算接受 HTML（SPA fallback 生效）", async () => {
    const dist = await makeWebDist();
    server = await startTestServer({ webDir: dist });
    const response = await get(server.instance, "/foo", { accept: "*/*" });
    expect(response.status).toBe(200);
    expect(response.body).toContain("MNEMOSHELF-UI");
  });

  it("靜態檔與 SPA fallback 免 token；asset 直接服務並帶 CSP", async () => {
    const dist = await makeWebDist();
    server = await startTestServer({ webDir: dist });

    const asset = await get(server.instance, "/assets/app.js", { accept: "*/*", token: null });
    expect(asset.status).toBe(200);
    expect(asset.body).toContain("mnemoshelf-ui");
    expect(asset.head.toLowerCase()).toContain("content-security-policy");

    const html = await get(server.instance, "/", { accept: "text/html", token: null });
    expect(html.status).toBe(200);
    expect(html.head.toLowerCase()).toContain("content-security-policy");
  });

  it("不存在的 asset（像檔案的路徑）→ 404 JSON，不做 fallback", async () => {
    const dist = await makeWebDist();
    server = await startTestServer({ webDir: dist });
    const response = await get(server.instance, "/assets/missing.js", { accept: "*/*" });
    expect(response.status).toBe(404);
    expect(errorName(JSON.parse(response.body))).toBe("NotFoundError");
  });

  it("不接受 HTML 的用戶端（Accept: application/json）→ 非 API 路徑回 404 JSON", async () => {
    const dist = await makeWebDist();
    server = await startTestServer({ webDir: dist });
    const response = await get(server.instance, "/foo", { accept: "application/json" });
    expect(response.status).toBe(404);
    expect(response.body).toContain("NotFoundError");
    expect(response.body).not.toContain("MNEMOSHELF-UI");
  });

  it("API 命名空間內的未知路徑即使帶 Accept: text/html 也回 JSON 404", async () => {
    const dist = await makeWebDist();
    server = await startTestServer({ webDir: dist });
    const response = await get(server.instance, "/roots/1/nope", { accept: "text/html", token: TEST_TOKEN });
    expect(response.status).toBe(404);
    expect(response.body).toContain("NotFoundError");
    expect(response.body).not.toContain("MNEMOSHELF-UI");
  });

  it("非 GET／HEAD 的非 API 路徑 → 405", async () => {
    const dist = await makeWebDist();
    server = await startTestServer({ webDir: dist });
    const response = await rawHttpRequest(server.instance.port, "/foo", {
      method: "POST",
      headers: { accept: "text/html" },
    });
    expect(response.status).toBe(405);
  });

  it("路徑不得超出 dist 目錄（`..` 被正規化後找不到檔案）", async () => {
    const dist = await makeWebDist();
    server = await startTestServer({ webDir: dist });
    // dist 目錄外放一個檔案，確保穿越真的會命中它才有意義
    const outside = path.join(path.dirname(dist), `mnemoshelf-outside-${path.basename(dist)}.txt`);
    await fs.writeFile(outside, "SECRET-OUTSIDE-DIST", "utf8");
    tempDirs.push(outside);

    const traversal = await get(server.instance, `/../${path.basename(outside)}`, { accept: "*/*" });
    expect(traversal.status).toBe(404);
    expect(traversal.body).not.toContain("SECRET-OUTSIDE-DIST");
  });

  it("dist 不存在時：靜態路徑 404 JSON，API 仍正常（不 crash）", async () => {
    const missing = path.join(os.tmpdir(), `mnemoshelf-no-dist-${Date.now()}`);
    server = await startTestServer({ webDir: missing });

    const html = await get(server.instance, "/", { accept: "text/html" });
    expect(html.status).toBe(404);
    expect(html.body).toContain("NotFoundError");

    // API 照常
    expect((await api(server.instance, "GET", "/health", { token: null })).status).toBe(200);
    expect((await api(server.instance, "GET", "/roots")).status).toBe(200);
    expect((await api(server.instance, "POST", "/search", { body: { query: "x" } })).status).toBe(200);
  });
});

describe("認證邊界（靜態與 API）", () => {
  it("無 token 呼叫 API → 401；靜態檔不需要 token", async () => {
    const dist = await makeWebDist();
    server = await startTestServer({ webDir: dist });

    const unauthorized = await api(server.instance, "GET", "/roots", { token: null });
    expect(unauthorized.status).toBe(401);
    expect(errorName(unauthorized.body)).toBe("UnauthorizedError");

    const staticOk = await get(server.instance, "/", { accept: "text/html", token: null });
    expect(staticOk.status).toBe(200);
  });
});
