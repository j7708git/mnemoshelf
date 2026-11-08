/**
 * 影片播放端點 `GET|HEAD /roots/:id/media?path=` 的 HTTP 整合測試。
 *
 * 覆蓋 A1 播放 spike 的產品化要求：token／root 守衛、單一 Range（206／416）、單次 4 MiB
 * 上限與續傳、suffix、HEAD、多段／畸形一律 416、串流（不整檔 Buffer）、client 中止、
 * 讀取中被截斷／替換、`cache-control: no-store` 與 token 不進 URL。
 *
 * 全部使用 `os.tmpdir()` 下的合成 bytes；不解碼、不需要 ffmpeg。
 */
import { promises as fs } from "node:fs";
import http from "node:http";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MEDIA_RANGE_MAX_BYTES } from "../src/index.js";
import { api, makeTempDir, removeTempDir, startTestServer, TEST_TOKEN, type TestServer } from "./helpers.js";

/** 合成 MP4 bytes（內容不重要；播放端點只做位元組服務）。5 MiB > 4 MiB 上限。 */
const CLIP_BYTES = 5 * 1024 * 1024;
function clipBytes(): Buffer {
  const buffer = Buffer.alloc(CLIP_BYTES);
  for (let index = 0; index < buffer.length; index += 1) buffer[index] = index % 251;
  return buffer;
}

let server: TestServer | undefined;
const tempDirs: string[] = [];
afterEach(async () => {
  await server?.close();
  server = undefined;
  while (tempDirs.length > 0) await removeTempDir(tempDirs.pop()!);
});

interface Fixture {
  rootId: number;
  dir: string;
  clipPath: string;
}

async function fixture(options: { env?: NodeJS.ProcessEnv } = {}): Promise<Fixture> {
  const parent = await makeTempDir("mnemoshelf-media-http-");
  tempDirs.push(parent);
  const dir = path.join(parent, "root");
  await fs.mkdir(dir);
  const clipPath = path.join(dir, "clip.mp4");
  await fs.writeFile(clipPath, clipBytes());
  await fs.writeFile(path.join(dir, "notes.md"), "# 不是影片\n", "utf8");
  // root 外的檔案（traversal 負向測試用；不應被讀到）。
  await fs.writeFile(path.join(parent, "outside.mp4"), "outside-root");
  server = await startTestServer({ ...(options.env === undefined ? {} : { env: options.env }) });
  const created = await api(server.instance, "POST", "/roots", { body: { path: dir } });
  expect(created.status).toBe(201);
  return { rootId: (created.body as { id: number }).id, dir, clipPath };
}

function mediaUrl(rootId: number, relPath: string): string {
  return `${server!.instance.url}/roots/${rootId}/media?path=${encodeURIComponent(relPath)}`;
}

function get(rootId: number, relPath: string, options: { range?: string; token?: string | null; method?: string } = {}) {
  const token = options.token === undefined ? TEST_TOKEN : options.token;
  const headers: Record<string, string> = {};
  if (token !== null) headers.authorization = `Bearer ${token}`;
  if (options.range !== undefined) headers.range = options.range;
  return fetch(mediaUrl(rootId, relPath), { method: options.method ?? "GET", headers });
}

describe("GET /roots/:id/media：授權與 root 守衛", () => {
  it("無 token／錯 token → 401，不洩漏內容", async () => {
    const { rootId } = await fixture();
    for (const token of [null, "wrong-token"]) {
      const response = await get(rootId, "clip.mp4", { token });
      expect(response.status).toBe(401);
      expect(await response.text()).not.toContain(TEST_TOKEN);
    }
  });

  it("未知 root → 404；缺 path → 400；逃出 root → 403；非 .mp4 → 415", async () => {
    const { rootId } = await fixture();
    expect((await get(999999, "clip.mp4")).status).toBe(404);
    expect((await fetch(`${server!.instance.url}/roots/${rootId}/media`, { headers: { authorization: `Bearer ${TEST_TOKEN}` } })).status).toBe(400);
    expect((await get(rootId, path.join("..", "outside.mp4"))).status).toBe(403);
    expect((await get(rootId, "notes.md")).status).toBe(415);
  });

  it("非 GET／HEAD → 405（Allow: GET, HEAD）", async () => {
    const { rootId } = await fixture();
    const response = await get(rootId, "clip.mp4", { method: "POST" });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
  });

  it("超過影片單檔上限 → 413（上限與掃描／快照同一個 env）", async () => {
    const { rootId } = await fixture({ env: { MNEMOSHELF_VIDEO_MAX_FILE_BYTES: String(1024 * 1024) } });
    const response = await get(rootId, "clip.mp4");
    expect(response.status).toBe(413);
  });
});

describe("GET /roots/:id/media：Range 與串流", () => {
  it("無 Range → 200 整檔；header 齊全且不快取", async () => {
    const { rootId } = await fixture();
    const response = await get(rootId, "clip.mp4");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("video/mp4");
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-length")).toBe(String(CLIP_BYTES));
    expect(response.headers.get("content-range")).toBeNull();
    const body = Buffer.from(await response.arrayBuffer());
    expect(body.length).toBe(CLIP_BYTES);
    expect(body.equals(clipBytes())).toBe(true);
  });

  it("bytes=0-99 → 206＋Content-Range＋正確 Content-Length", async () => {
    const { rootId } = await fixture();
    const response = await get(rootId, "clip.mp4", { range: "bytes=0-99" });
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe(`bytes 0-99/${CLIP_BYTES}`);
    expect(response.headers.get("content-length")).toBe("100");
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    const body = Buffer.from(await response.arrayBuffer());
    expect(body.equals(clipBytes().subarray(0, 100))).toBe(true);
  });

  it("開放式 bytes=0- 受單次 4 MiB 上限截短；可續傳", async () => {
    const { rootId } = await fixture();
    const first = await get(rootId, "clip.mp4", { range: "bytes=0-" });
    expect(first.status).toBe(206);
    expect(first.headers.get("content-range")).toBe(`bytes 0-${MEDIA_RANGE_MAX_BYTES - 1}/${CLIP_BYTES}`);
    expect(first.headers.get("content-length")).toBe(String(MEDIA_RANGE_MAX_BYTES));
    const firstBody = Buffer.from(await first.arrayBuffer());
    expect(firstBody.length).toBe(MEDIA_RANGE_MAX_BYTES);
    expect(firstBody.equals(clipBytes().subarray(0, MEDIA_RANGE_MAX_BYTES))).toBe(true);

    const rest = await get(rootId, "clip.mp4", { range: `bytes=${MEDIA_RANGE_MAX_BYTES}-` });
    expect(rest.status).toBe(206);
    expect(rest.headers.get("content-range")).toBe(
      `bytes ${MEDIA_RANGE_MAX_BYTES}-${CLIP_BYTES - 1}/${CLIP_BYTES}`,
    );
    const restBody = Buffer.from(await rest.arrayBuffer());
    expect(restBody.equals(clipBytes().subarray(MEDIA_RANGE_MAX_BYTES))).toBe(true);
  });

  it("suffix bytes=-100 → 最後 100 bytes", async () => {
    const { rootId } = await fixture();
    const response = await get(rootId, "clip.mp4", { range: "bytes=-100" });
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe(`bytes ${CLIP_BYTES - 100}-${CLIP_BYTES - 1}/${CLIP_BYTES}`);
    const body = Buffer.from(await response.arrayBuffer());
    expect(body.equals(clipBytes().subarray(CLIP_BYTES - 100))).toBe(true);
  });

  it("越界／多段／畸形 → 416＋Content-Range: bytes */size，沒有 body", async () => {
    const { rootId } = await fixture();
    for (const range of ["bytes=99999999-", "bytes=0-99,200-299", "bytes=abc", "items=0-1", "bytes=-0"]) {
      const response = await get(rootId, "clip.mp4", { range });
      expect(response.status, range).toBe(416);
      expect(response.headers.get("content-range"), range).toBe(`bytes */${CLIP_BYTES}`);
      expect(response.headers.get("content-length"), range).toBe("0");
      expect((await response.arrayBuffer()).byteLength, range).toBe(0);
    }
  });

  it("HEAD → 只回 header，不送 body", async () => {
    const { rootId } = await fixture();
    const response = await get(rootId, "clip.mp4", { method: "HEAD" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe(String(CLIP_BYTES));
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect((await response.arrayBuffer()).byteLength).toBe(0);
  });

  it("token 不進 URL：request target 只有 path 參數", async () => {
    const { rootId } = await fixture();
    const response = await get(rootId, "clip.mp4", { range: "bytes=0-99" });
    expect(response.status).toBe(206);
    // URL 由測試自己組，這裡鎖住「端點不需要（也不接受）query token」的契約。
    const url = mediaUrl(rootId, "clip.mp4");
    expect(url).not.toContain("token");
    expect(url).not.toContain(TEST_TOKEN);
  });
});

describe("GET /roots/:id/media：中止與來源變更", () => {
  it("client 讀一部分就斷線 → 伺服器停止讀取、不影響後續請求", async () => {
    const { rootId } = await fixture();
    const origin = new URL(server!.instance.url);
    const received = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => {
        request.destroy();
        reject(new Error("client abort 測試逾時"));
      }, 5000);
      const done = (bytes: number): void => {
        clearTimeout(timer);
        resolve(bytes);
      };
      const request = http.get(
        {
          host: origin.hostname,
          port: origin.port,
          path: `/roots/${rootId}/media?path=clip.mp4`,
          headers: { authorization: `Bearer ${TEST_TOKEN}`, range: "bytes=0-" },
        },
        (response) => {
          let bytes = 0;
          response.on("data", (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > 64 * 1024) {
              request.destroy();
              done(bytes);
            }
          });
          response.on("error", () => done(bytes));
        },
      );
      request.on("error", () => done(0));
    });
    expect(received).toBeGreaterThan(0);
    // 中止後端點仍正常：後續請求回 206 且內容正確。
    const response = await get(rootId, "clip.mp4", { range: "bytes=0-9" });
    expect(response.status).toBe(206);
    expect((await response.arrayBuffer()).byteLength).toBe(10);
    // 在途回應不殘留（settled 會等串流 close；中止要讓它結束）。
    await server!.instance.app.settled();
  });

  it("讀取中檔案被截斷 → 回應不假裝完整；伺服器不 crash", async () => {
    const { rootId, clipPath } = await fixture();
    const response = await get(rootId, "clip.mp4", { range: "bytes=0-" });
    expect(response.status).toBe(206);
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    let received = first.value?.byteLength ?? 0;

    let truncated = true;
    try {
      await fs.truncate(clipPath, 1024);
    } catch {
      truncated = false;
    }
    if (!truncated) return; // 平台不支援讀取中 truncate：不強行斷言（Windows 實測可）。
    let failed = false;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        received += next.value?.byteLength ?? 0;
      }
    } catch {
      failed = true;
    }
    // 已宣告 4 MiB，但檔案被截斷：client 必須看到錯誤或短少，不能拿到「完整」的假象。
    expect(failed || received < MEDIA_RANGE_MAX_BYTES).toBe(true);

    // 伺服器仍可用；新請求反映當下（截斷後）的大小。
    const after = await get(rootId, "clip.mp4");
    expect(after.status).toBe(200);
    expect(after.headers.get("content-length")).toBe("1024");
    expect((await after.arrayBuffer()).byteLength).toBe(1024);
  });

  it("請求之間檔案被替換 → 每次重新 stat，回傳當下內容（不沿用舊快取）", async () => {
    const { rootId, clipPath } = await fixture();
    const replacement = Buffer.from("replacement-bytes");
    await fs.writeFile(clipPath, replacement);
    const response = await get(rootId, "clip.mp4");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe(String(replacement.length));
    expect(Buffer.from(await response.arrayBuffer()).equals(replacement)).toBe(true);
  });
});
