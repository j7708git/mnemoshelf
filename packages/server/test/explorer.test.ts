/**
 * 檔案總管端點整合測試（M3 `mnemoshelf-web-ui-explorer`）：
 * 目錄子項、文字預覽（截斷）、圖片位元組、縮圖（sharp）、索引进度輪詢。
 *
 * 全部使用 `os.tmpdir()` 下的合成資料，結束後刪除；不讀取任何使用者檔案。
 * 縮圖測試用 `sharp` 產生真實 PNG（不是硬寫魔術位元組）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import sharp from "sharp";
import { type Embedder, type EmbedderInfo, type ImageInput, type ProbeResult } from "@mnemoshelf/core";
import { FakeEmbedder } from "@mnemoshelf/core/testing";
import { SlowEmbedder, api, errorName, makeTempDir, removeTempDir, startTestServer, TEST_TOKEN, type TestServer } from "./helpers.js";
import {
  MAX_TEXT_PREVIEW_BYTES,
  THUMBNAIL_MAX_WIDTH,
  type DirEntry,
  type IndexRootResponse,
  type IndexStatus,
  type ListEntriesResponse,
  type TextPreview,
} from "../src/index.js";

let server: TestServer | undefined;
const tempDirs: string[] = [];

afterEach(async () => {
  await server?.close();
  server = undefined;
  while (tempDirs.length > 0) await removeTempDir(tempDirs.pop()!);
});

/** 建立含子目錄、文字、程式碼、圖片、黑名單檔與二進位檔的合成 root。 */
async function makeExplorerFixture(): Promise<string> {
  const dir = await makeTempDir("mnemoshelf-explorer-");
  tempDirs.push(dir);

  await fs.mkdir(path.join(dir, "sub"));
  await fs.mkdir(path.join(dir, "code"));
  await fs.mkdir(path.join(dir, ".ssh")); // 黑名單目錄
  await fs.writeFile(path.join(dir, "notes.md"), "# 筆記\n\n給文字預覽用的內容。\n", "utf8");
  await fs.writeFile(path.join(dir, "sub", "inner.txt"), "子目錄裡的文字檔。\n", "utf8");
  await fs.writeFile(path.join(dir, "code", "app.ts"), "export const answer = 42;\n", "utf8");
  await fs.writeFile(path.join(dir, ".env"), "MNEMO_FIXTURE_CONTENT=FIXTURE-BLOCKLIST-CONTENT\n", "utf8"); // 黑名單檔（合成內容）
  await fs.writeFile(path.join(dir, "archive.zip"), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00])); // 二進位
  // 真實 PNG（由 sharp 產生，非手寫魔術位元組）。
  const png = await sharp({ create: { width: 640, height: 480, channels: 3, background: { r: 20, g: 120, b: 200 } } })
    .png()
    .toBuffer();
  await fs.writeFile(path.join(dir, "wide.png"), png);
  return dir;
}

/** 取得原始位元組回應（用於圖片與縮圖端點；`api()` 會嘗試 JSON 解析）。 */
async function fetchBytes(
  instance: { url: string },
  target: string,
): Promise<{ status: number; contentType: string | null; bytes: Buffer }> {
  const response = await fetch(`${instance.url}${target}`, { headers: { authorization: `Bearer ${TEST_TOKEN}` } });
  return { status: response.status, contentType: response.headers.get("content-type"), bytes: Buffer.from(await response.arrayBuffer()) };
}

async function addRoot(dir: string): Promise<number> {
  const created = await api(server!.instance, "POST", "/roots", { body: { path: dir, modalities: ["text", "code", "image"] } });
  expect(created.status).toBe(201);
  return (created.body as { id: number }).id;
}

/** 失敗的 embedder：`embedDocuments` 一律拋錯（驗證進度輪詢的「失敗」狀態）。 */
class FailingEmbedder implements Embedder {
  private readonly inner = new FakeEmbedder();
  get info(): EmbedderInfo {
    return this.inner.info;
  }
  async embedQuery(text: string): Promise<Float32Array> {
    return this.inner.embedQuery(text);
  }
  async embedDocument(): Promise<Float32Array> {
    const error = new Error("合成測試：嵌入失敗");
    error.name = "SyntheticEmbedError";
    throw error;
  }
  async embedDocuments(): Promise<Float32Array[]> {
    const error = new Error("合成測試：嵌入失敗");
    error.name = "SyntheticEmbedError";
    throw error;
  }
  async embedImage(image: ImageInput): Promise<Float32Array> {
    return this.inner.embedImage(image);
  }
  async probe(): Promise<ProbeResult> {
    return this.inner.probe();
  }
  async dispose(): Promise<void> {
    return this.inner.dispose();
  }
}

describe("GET /roots/:id/entries：目錄子項", () => {
  it("列出目錄與檔案（目錄在前、含大小與型別），並略過黑名單項目", async () => {
    server = await startTestServer();
    const dir = await makeExplorerFixture();
    const rootId = await addRoot(dir);

    const response = await api(server.instance, "GET", `/roots/${rootId}/entries?path=`);
    expect(response.status).toBe(200);
    const body = response.body as ListEntriesResponse;
    expect(body.path).toBe("");
    const names = body.entries.map((entry) => entry.name);

    // 黑名單（`.env` 檔與 `.ssh` 目錄）不得出現在清單中。
    expect(names).not.toContain(".env");
    expect(names).not.toContain(".ssh");
    // 目錄排在檔案前面。
    const dirs = body.entries.filter((entry) => entry.kind === "dir").map((entry) => entry.name);
    expect(dirs).toEqual(["code", "sub"]);

    const png = body.entries.find((entry) => entry.name === "wide.png")!;
    expect(png.kind).toBe("image");
    expect(png.mimeType).toBe("image/png");
    expect(png.size).toBeGreaterThan(0);
    expect(png.path).toBe("wide.png");

    const zip = body.entries.find((entry) => entry.name === "archive.zip")!;
    expect(zip.kind).toBe("binary");

    const sub = body.entries.find((entry) => entry.name === "sub")!;
    expect(sub.size).toBeNull();

    // 子目錄 lazy 載入
    const inner = await api(server.instance, "GET", `/roots/${rootId}/entries?path=sub`);
    const innerBody = inner.body as ListEntriesResponse;
    expect(innerBody.entries.map((entry) => entry.path)).toEqual(["sub/inner.txt"]);
    expect(innerBody.entries[0]!.kind).toBe("text");
  });

  it("path 缺漏或絕對路徑 → 400；逃出 root（`..`）→ 403；不是目錄 → 400", async () => {
    server = await startTestServer();
    const dir = await makeExplorerFixture();
    const rootId = await addRoot(dir);

    const missing = await api(server.instance, "GET", `/roots/${rootId}/entries`);
    expect(missing.status).toBe(400);
    expect(errorName(missing.body)).toBe("ValidationError");

    const absolute = await api(server.instance, "GET", `/roots/${rootId}/entries?path=${encodeURIComponent("/etc")}`);
    expect(absolute.status).toBe(400);
    expect(errorName(absolute.body)).toBe("ValidationError");

    const escape = await api(server.instance, "GET", `/roots/${rootId}/entries?path=${encodeURIComponent("../../etc")}`);
    expect(escape.status).toBe(403);
    expect(errorName(escape.body)).toBe("PathOutsideRootError");

    const notDir = await api(server.instance, "GET", `/roots/${rootId}/entries?path=notes.md`);
    expect(notDir.status).toBe(400);
    expect(errorName(notDir.body)).toBe("ValidationError");
  });

  it("黑名單目錄本身 → 403 PathBlockedError", async () => {
    server = await startTestServer();
    const dir = await makeExplorerFixture();
    const rootId = await addRoot(dir);

    const response = await api(server.instance, "GET", `/roots/${rootId}/entries?path=${encodeURIComponent(".ssh")}`);
    expect(response.status).toBe(403);
    expect(errorName(response.body)).toBe("PathBlockedError");
    // 訊息不得洩漏本機絕對路徑。
    expect(JSON.stringify(response.body)).not.toContain(dir);
  });

  it("未知 root → 404", async () => {
    server = await startTestServer();
    const response = await api(server.instance, "GET", "/roots/987654/entries?path=");
    expect(response.status).toBe(404);
    expect(errorName(response.body)).toBe("NotFoundError");
  });
});

describe("GET /roots/:id/file：文字預覽與圖片位元組", () => {
  it("小文字檔完整回傳（truncated=false）", async () => {
    server = await startTestServer();
    const dir = await makeExplorerFixture();
    const rootId = await addRoot(dir);

    const response = await api(server.instance, "GET", `/roots/${rootId}/file?path=notes.md`);
    expect(response.status).toBe(200);
    const body = response.body as TextPreview;
    expect(body.kind).toBe("text");
    expect(body.truncated).toBe(false);
    expect(body.path).toBe("notes.md");
    expect(body.content).toContain("給文字預覽用的內容");
    expect(body.size).toBe(Buffer.byteLength(body.content, "utf8"));
  });

  it("超過上限的文字檔截斷並標明（truncated=true）", async () => {
    server = await startTestServer();
    const dir = await makeExplorerFixture();
    const rootId = await addRoot(dir);

    const bigPath = path.join(dir, "big.txt");
    await fs.writeFile(bigPath, "A".repeat(MAX_TEXT_PREVIEW_BYTES + 4096), "utf8");

    const response = await api(server.instance, "GET", `/roots/${rootId}/file?path=big.txt`);
    expect(response.status).toBe(200);
    const body = response.body as TextPreview;
    expect(body.truncated).toBe(true);
    expect(body.size).toBe(MAX_TEXT_PREVIEW_BYTES + 4096);
    // 回傳內容不超過上限，且長度符合上限（ASCII 一字一位元組）。
    expect(Buffer.byteLength(body.content, "utf8")).toBe(MAX_TEXT_PREVIEW_BYTES);
    expect(body.content).toBe("A".repeat(MAX_TEXT_PREVIEW_BYTES));
  });

  it("圖片 → 原始位元組＋正確 Content-Type", async () => {
    server = await startTestServer();
    const dir = await makeExplorerFixture();
    const rootId = await addRoot(dir);

    const response = await fetchBytes(server.instance, `/roots/${rootId}/file?path=wide.png`);
    expect(response.status).toBe(200);
    expect(response.contentType).toBe("image/png");
    expect(response.bytes.byteLength).toBeGreaterThan(0);
    // 是原圖（未被縮放）：寬度維持 640。
    const metadata = await sharp(response.bytes).metadata();
    expect(metadata.width).toBe(640);
  });

  it("二進位檔 → 415 UnsupportedFileTypeError（不回傳亂碼）", async () => {
    server = await startTestServer();
    const dir = await makeExplorerFixture();
    const rootId = await addRoot(dir);

    const response = await api(server.instance, "GET", `/roots/${rootId}/file?path=archive.zip`);
    expect(response.status).toBe(415);
    expect(errorName(response.body)).toBe("UnsupportedFileTypeError");
    expect(JSON.stringify(response.body)).not.toContain("PK");
  });

  it("黑名單檔（.env）→ 403 且不洩漏內容", async () => {
    server = await startTestServer();
    const dir = await makeExplorerFixture();
    const rootId = await addRoot(dir);

    const response = await api(server.instance, "GET", `/roots/${rootId}/file?path=${encodeURIComponent(".env")}`);
    expect(response.status).toBe(403);
    expect(errorName(response.body)).toBe("PathBlockedError");
    // 測試意圖不變：`.env` 的內容一律不得出現在回應中（改用不含憑證字樣樣式的合成值）。
    expect(JSON.stringify(response.body)).not.toContain("MNEMO_FIXTURE_CONTENT");
    expect(JSON.stringify(response.body)).not.toContain("FIXTURE-BLOCKLIST-CONTENT");
  });

  it("path 逃出 root（`..` 與絕對路徑）→ 拒絕，無內容", async () => {
    server = await startTestServer();
    const dir = await makeExplorerFixture();
    const rootId = await addRoot(dir);

    const escape = await api(server.instance, "GET", `/roots/${rootId}/file?path=${encodeURIComponent("../../etc/passwd")}`);
    expect(escape.status).toBe(403);
    expect(errorName(escape.body)).toBe("PathOutsideRootError");
    expect(JSON.stringify(escape.body)).not.toContain("root:");

    const absolute = await api(server.instance, "GET", `/roots/${rootId}/file?path=${encodeURIComponent("/etc/passwd")}`);
    expect(absolute.status).toBe(400);
    expect(errorName(absolute.body)).toBe("ValidationError");

    const missing = await api(server.instance, "GET", `/roots/${rootId}/file`);
    expect(missing.status).toBe(400);
    expect(errorName(missing.body)).toBe("ValidationError");
  });

  it("不存在的檔案 → 404", async () => {
    server = await startTestServer();
    const dir = await makeExplorerFixture();
    const rootId = await addRoot(dir);

    const response = await api(server.instance, "GET", `/roots/${rootId}/file?path=nope.txt`);
    expect(response.status).toBe(404);
    expect(errorName(response.body)).toBe("NotFoundError");
  });
});

describe("path 含 NUL 位元組", () => {
  it("`a%00b` → 400 ValidationError（entries 與 file 皆然，不是 500）", async () => {
    server = await startTestServer();
    const dir = await makeExplorerFixture();
    const rootId = await addRoot(dir);

    const entries = await api(server.instance, "GET", `/roots/${rootId}/entries?path=a%00b`);
    expect(entries.status).toBe(400);
    expect(errorName(entries.body)).toBe("ValidationError");

    const file = await api(server.instance, "GET", `/roots/${rootId}/file?path=a%00b`);
    expect(file.status).toBe(400);
    expect(errorName(file.body)).toBe("ValidationError");

    // 服務仍存活。
    expect((await api(server.instance, "GET", "/health", { token: null })).status).toBe(200);
  });
});

describe("GET /roots/:id/thumb：縮圖", () => {
  it("成功產生縮圖（PNG，寬度不超過上限）", async () => {
    server = await startTestServer();
    const dir = await makeExplorerFixture();
    const rootId = await addRoot(dir);

    const response = await fetchBytes(server.instance, `/roots/${rootId}/thumb?path=wide.png`);
    expect(response.status).toBe(200);
    expect(response.contentType).toBe("image/png");
    const metadata = await sharp(response.bytes).metadata();
    expect(metadata.format).toBe("png");
    expect(metadata.width).toBe(THUMBNAIL_MAX_WIDTH);

    // 第二次請求命中快取（內容一致）。
    const again = await fetchBytes(server.instance, `/roots/${rootId}/thumb?path=wide.png`);
    expect(again.bytes.equals(response.bytes)).toBe(true);
  });

  it("非圖片檔 → 415 UnsupportedFileTypeError", async () => {
    server = await startTestServer();
    const dir = await makeExplorerFixture();
    const rootId = await addRoot(dir);

    const response = await api(server.instance, "GET", `/roots/${rootId}/thumb?path=notes.md`);
    expect(response.status).toBe(415);
    expect(errorName(response.body)).toBe("UnsupportedFileTypeError");
  });

  it("黑名單檔 → 403", async () => {
    server = await startTestServer();
    const dir = await makeExplorerFixture();
    const rootId = await addRoot(dir);

    const response = await api(server.instance, "GET", `/roots/${rootId}/thumb?path=${encodeURIComponent(".env")}`);
    expect(response.status).toBe(403);
    expect(errorName(response.body)).toBe("PathBlockedError");
  });
});

describe("GET /roots/:id/index/status：進度輪詢", () => {
  it("索引前 → idle（無進行中工作）", async () => {
    server = await startTestServer();
    const dir = await makeExplorerFixture();
    const rootId = await addRoot(dir);

    const response = await api(server.instance, "GET", `/roots/${rootId}/index/status`);
    expect(response.status).toBe(200);
    const status = response.body as IndexStatus;
    expect(status.state).toBe("idle");
    expect(status.progress).toBeNull();
    expect(status.error).toBeNull();
    expect(status.result).toBeNull();
  });

  it("索引中 → running（含進度）；完成 → completed（含結果）", async () => {
    server = await startTestServer({ embedder: new SlowEmbedder(40) });
    const dir = await makeExplorerFixture();
    const rootId = await addRoot(dir);

    // 不 await：POST /index 會等整個索引跑完才回應，這裡先讓它跑，再輪詢狀態。
    const running = api(server.instance, "POST", `/roots/${rootId}/index`);

    let sawRunning = false;
    try {
      for (let attempt = 0; attempt < 400; attempt += 1) {
        const status = (await api(server.instance, "GET", `/roots/${rootId}/index/status`)).body as IndexStatus;
        // `begin()` 後到第一個檔案處理完之間，progress 仍為 null（掃描階段）——要等到有進度。
        if (status.state === "running" && status.progress !== null) {
          sawRunning = true;
          expect(status.progress.total).toBeGreaterThan(0);
          expect(status.startedAt).not.toBeNull();
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(sawRunning).toBe(true);
    } finally {
      // 即使上面的斷言失敗，也要把在途請求收乾淨（避免未處理的 rejection）。
      await running.catch(() => undefined);
    }

    const indexed = await running;
    expect(indexed.status).toBe(200);
    const result = indexed.body as IndexRootResponse;

    const completed = (await api(server.instance, "GET", `/roots/${rootId}/index/status`)).body as IndexStatus;
    expect(completed.state).toBe("completed");
    expect(completed.error).toBeNull();
    expect(completed.result).not.toBeNull();
    expect(completed.result!.total).toBe(result.total);
    expect(completed.durationMs).not.toBeNull();
    expect(completed.finishedAt).not.toBeNull();
  });

  it("嵌入失敗不再是整輪失敗：逐檔記入 failedFiles、整輪仍完成", async () => {
    server = await startTestServer({ embedder: new FailingEmbedder() });
    const dir = await makeExplorerFixture();
    const rootId = await addRoot(dir);

    const response = await api(server.instance, "POST", `/roots/${rootId}/index`);
    expect(response.status).toBe(200);

    const result = response.body as IndexRootResponse;
    // 文字檔全部失敗，但整輪沒有失敗（圖片仍走 embedImage 成功）。
    expect(result.failedFiles.length).toBeGreaterThan(0);
    expect(result.processed).toBeGreaterThan(0);
    // 對帳：失敗檔也算「處理完」，四類相加等於 total。
    expect(
      result.processed + result.skippedUnchanged + result.skippedFiles.length + result.failedFiles.length,
    ).toBe(result.total);
    // 失敗原因只留短標籤（原始錯誤訊息被丟棄）。
    for (const file of result.failedFiles) {
      expect(file.reason).toBe("SyntheticEmbedError");
    }

    const status = (await api(server.instance, "GET", `/roots/${rootId}/index/status`)).body as IndexStatus;
    expect(status.state).toBe("completed");
    expect(status.error).toBeNull();
    expect(status.result).not.toBeNull();
    expect(status.result!.failedFiles.length).toBe(result.failedFiles.length);
  });

  it("未知 root → 404", async () => {
    server = await startTestServer();
    const response = await api(server.instance, "GET", "/roots/987654/index/status");
    expect(response.status).toBe(404);
    expect(errorName(response.body)).toBe("NotFoundError");
  });

  it("移除 root 後清除其狀態", async () => {
    server = await startTestServer();
    const dir = await makeExplorerFixture();
    const rootId = await addRoot(dir);
    await api(server.instance, "POST", `/roots/${rootId}/index`);
    expect(((await api(server.instance, "GET", `/roots/${rootId}/index/status`)).body as IndexStatus).state).toBe("completed");

    const removed = await api(server.instance, "DELETE", `/roots/${rootId}`);
    expect(removed.status).toBe(200);
    // root 已不存在 → 404（狀態紀錄也已清除）。
    expect((await api(server.instance, "GET", `/roots/${rootId}/index/status`)).status).toBe(404);
  });
});

describe("新端點的授權與方法限制", () => {
  it("無 token → 401", async () => {
    server = await startTestServer();
    const dir = await makeExplorerFixture();
    const rootId = await addRoot(dir);

    for (const target of [`/roots/${rootId}/entries?path=`, `/roots/${rootId}/file?path=notes.md`, `/roots/${rootId}/thumb?path=wide.png`, `/roots/${rootId}/index/status`]) {
      const response = await api(server.instance, "GET", target, { token: null });
      expect(response.status).toBe(401);
      expect(errorName(response.body)).toBe("UnauthorizedError");
    }
  });

  it("方法不支援 → 405", async () => {
    server = await startTestServer();
    const dir = await makeExplorerFixture();
    const rootId = await addRoot(dir);

    const response = await api(server.instance, "POST", `/roots/${rootId}/entries?path=`);
    expect(response.status).toBe(405);
    expect(errorName(response.body)).toBe("MethodNotAllowedError");
  });

  it("未使用的路徑變體 → 404", async () => {
    server = await startTestServer();
    const dir = await makeExplorerFixture();
    const rootId = await addRoot(dir);

    const response = await api(server.instance, "GET", `/roots/${rootId}/index/nope`);
    expect(response.status).toBe(404);
    expect(errorName(response.body)).toBe("NotFoundError");
  });
});
