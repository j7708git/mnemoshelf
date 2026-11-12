/** 純合成位元組驗證實際 HTTP 授權／版本／Range；不啟動 decoder 或模型。 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, makeTempDir, removeTempDir, startTestServer, TEST_TOKEN, type TestServer } from "./helpers.js";

let server: TestServer | undefined;
let parent: string | undefined;
afterEach(async () => { await server?.close(); if (parent !== undefined) await removeTempDir(parent); server = undefined; parent = undefined; });

async function fixture() {
  parent = await makeTempDir("mnemoshelf-media-session-");
  const dir = path.join(parent, "root");
  await fs.mkdir(dir);
  const bytes = Buffer.from("synthetic-video-original-content");
  const file = path.join(dir, "clip.mp4");
  await fs.writeFile(file, bytes);
  server = await startTestServer();
  const result = await api(server.instance, "POST", "/roots", { body: { path: dir } });
  const rootId = (result.body as { id: number }).id;
  const chunks = await server.instance.store.replaceChunks(rootId, "clip.mp4", [{
    seq: 0, kind: "video", text: null, contentHash: createHash("sha256").update(bytes).digest("hex"),
    media: { track: "video", container: "mp4", startSeconds: 0, endSeconds: 4, frameTimesSeconds: [2], preprocessVersion: "fixture-v1", embedderId: "fixture", embeddingDim: 8 },
  }]);
  const headers = { authorization: `Bearer ${TEST_TOKEN}`, "sec-fetch-site": "same-origin", origin: server.instance.url, "content-type": "application/json" };
  const grant = (body: unknown = { path: "clip.mp4", chunkId: chunks[0]!.id }, extra = {}) => fetch(`${server!.instance.url}/roots/${rootId}/media-sessions`, { method: "POST", headers: { ...headers, ...extra }, body: JSON.stringify(body) });
  return { rootId, file, bytes, chunks, headers, grant };
}

describe("同源授權播放 HTTP", () => {
  it("受控時鐘越過 TTL 後實際 GET/HEAD 回 401，原 Bearer 仍可使用及重新授權", async () => {
    const { grant, rootId, bytes } = await fixture();
    // 各自建立 session，讓 GET 與 HEAD 都獨立走到到期判斷，而非讀到另一請求已撤銷的 id。
    const sessions: { url: string; expiresAt: string; cookie: string }[] = [];
    for (const method of ["GET", "HEAD"]) {
      const response = await grant();
      expect(response.status).toBe(201);
      const body = await response.json() as { url: string; expiresAt: string };
      const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
      sessions.push({ ...body, cookie });
      const before = await fetch(`${server!.instance.url}${body.url}`, {
        method, headers: { cookie, "sec-fetch-site": "same-origin", range: "bytes=0-3" },
      });
      expect(before.status).toBe(206);
      expect(await before.text()).toBe(method === "GET" ? bytes.subarray(0, 4).toString() : "");
    }
    // 只控制 Date.now，不換 socket／stream timers，也不修改產品 15 分鐘 TTL。
    // 這是受控時鐘的 HTTP 證據，不是實際等待 15 分鐘。
    const clock = vi.spyOn(Date, "now").mockReturnValue(Math.max(...sessions.map((session) => Date.parse(session.expiresAt))) + 1);
    try {
      for (const [index, method] of ["GET", "HEAD"].entries()) {
        const session = sessions[index]!;
        const expired = await fetch(`${server!.instance.url}${session.url}`, {
          method, headers: { cookie: session.cookie, "sec-fetch-site": "same-origin", authorization: `Bearer ${TEST_TOKEN}` },
        });
        expect(expired.status).toBe(401);
        await expired.arrayBuffer();
      }
      expect((await api(server!.instance, "GET", `/roots/${rootId}`)).status).toBe(200);
      const fresh = await grant();
      expect(fresh.status).toBe(201);
      const body = await fresh.json() as { url: string; expiresAt: string };
      expect(Date.parse(body.expiresAt)).toBeGreaterThan(Date.now());
      const available = await fetch(`${server!.instance.url}${body.url}`, {
        method: "HEAD", headers: { cookie: fresh.headers.get("set-cookie")!.split(";")[0]!, "sec-fetch-site": "same-origin" },
      });
      expect(available.status).toBe(200);
    } finally { clock.mockRestore(); }
  });

  it("root 設定變動與刪除撤銷授權，新授權套用最新大小上限", async () => {
    const { grant, rootId } = await fixture();
    const response = await grant();
    const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
    const { url } = await response.json() as { url: string };
    expect((await api(server!.instance, "PATCH", `/roots/${rootId}`, { body: { videoMaxFileBytes: 1 } })).status).toBe(200);
    expect((await fetch(`${server!.instance.url}${url}`, { headers: { cookie, "sec-fetch-site": "same-origin" } })).status).toBe(401);
    expect((await grant()).status).toBe(413);
    await api(server!.instance, "PATCH", `/roots/${rootId}`, { body: { videoMaxFileBytes: null, modalities: ["text"] } });
    const fresh = await grant();
    expect(fresh.status).toBe(201);
    const freshCookie = fresh.headers.get("set-cookie")!.split(";")[0]!;
    const freshBody = await fresh.json() as { url: string };
    expect((await api(server!.instance, "DELETE", `/roots/${rootId}`)).status).toBe(200);
    expect((await fetch(`${server!.instance.url}${freshBody.url}`, { headers: { cookie: freshCookie, "sec-fetch-site": "same-origin" } })).status).toBe(401);
  });
  it("非播放欄位的 PATCH 不撤銷授權，影片上限變動才撤銷", async () => {
    const { grant, rootId } = await fixture();
    const response = await grant();
    const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
    const { url } = await response.json() as { url: string };
    // allowAgentSearch 只影響 agent 搜尋範圍，不影響播放：舊 cookie 仍可用。
    expect((await api(server!.instance, "PATCH", `/roots/${rootId}`, { body: { allowAgentSearch: true } })).status).toBe(200);
    expect((await fetch(`${server!.instance.url}${url}`, { method: "HEAD", headers: { cookie, "sec-fetch-site": "same-origin" } })).status).toBe(200);
    // 影片上限會影響播放：舊授權撤銷。
    expect((await api(server!.instance, "PATCH", `/roots/${rootId}`, { body: { videoMaxFileBytes: 1 } })).status).toBe(200);
    expect((await fetch(`${server!.instance.url}${url}`, { method: "HEAD", headers: { cookie, "sec-fetch-site": "same-origin" } })).status).toBe(401);
  });
  it("Bearer 換短效 cookie；Range/HEAD/416，locator/其他API不繼承授權，撤銷失效", async () => {
    const { grant, rootId, headers, bytes } = await fixture();
    expect((await grant(undefined, { authorization: "" })).status).toBe(401);
    expect((await grant(undefined, { "sec-fetch-site": "same-site" })).status).toBe(403);
    const response = await grant();
    expect(response.status).toBe(201);
    const cookieHeader = response.headers.get("set-cookie")!;
    expect(cookieHeader).toContain("HttpOnly; SameSite=Strict; Path=/roots/");
    const cookie = cookieHeader.split(";")[0]!;
    const { url } = await response.json() as { url: string };
    expect(url).not.toContain(TEST_TOKEN);
    expect(url).not.toContain(cookie.split("=")[1]!);
    const request = (extra: Record<string, string> = {}, method = "GET") => fetch(`${server!.instance.url}${url}`, { method, headers: { cookie, "sec-fetch-site": "same-origin", range: "bytes=2-5", ...extra } });
    const partial = await request();
    expect(partial.status).toBe(206);
    expect(partial.headers.get("content-range")).toBe(`bytes 2-5/${bytes.length}`);
    expect(await partial.text()).toBe(bytes.subarray(2, 6).toString());
    expect((await request({}, "HEAD")).status).toBe(206);
    expect((await request({ range: "bytes=999-" })).status).toBe(416);
    expect((await request({ cookie: "" })).status).toBe(401);
    expect((await request({ "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await fetch(`${server!.instance.url}/roots/${rootId}`, { headers: { cookie } })).status).toBe(401);
    expect((await fetch(`${server!.instance.url}${url}`, { method: "DELETE", headers })).status).toBe(200);
    expect((await request()).status).toBe(401);
  });

  it("同大小/mtime 原地替換拒絕建立舊命中授權，已建 session 的續傳也拒絕", async () => {
    const { grant, file, bytes } = await fixture();
    const response = await grant();
    const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
    const { url } = await response.json() as { url: string };
    const before = await fs.stat(file);
    await fs.writeFile(file, Buffer.alloc(bytes.length, 90));
    await fs.utimes(file, before.atime, before.mtime);
    expect((await grant()).status).toBe(409);
    const stale = await fetch(`${server!.instance.url}${url}`, { headers: { cookie, "sec-fetch-site": "same-origin", range: "bytes=0-3" } });
    expect(stale.status).toBe(409);
    expect(await stale.text()).not.toContain("ZZZZ");
  });

  it("chunk 必須屬指定來源；重建不重用舊 chunkId，舊命中無法改套新內容", async () => {
    const { grant, rootId, chunks, file } = await fixture();
    await fs.copyFile(file, path.join(path.dirname(file), "other.mp4"));
    expect((await grant({ path: "other.mp4", chunkId: chunks[0]!.id })).status).toBe(409);
    const otherRoot = await api(server!.instance, "POST", "/roots", { body: { path: parent } });
    const foreign = await server!.instance.store.replaceChunks((otherRoot.body as { id: number }).id, "clip.mp4", [{ ...chunks[0]!, seq: 0 }]);
    expect((await grant({ path: "clip.mp4", chunkId: foreign[0]!.id })).status).toBe(409);
    const replaced = await server!.instance.store.replaceChunks(rootId, "clip.mp4", [{ ...chunks[0]!, seq: 0 }]);
    expect(replaced[0]!.id).not.toBe(chunks[0]!.id);
    expect((await grant()).status).toBe(409);
    expect((await grant({ path: "clip.mp4", chunkId: replaced[0]!.id })).status).toBe(201);
  });
});
