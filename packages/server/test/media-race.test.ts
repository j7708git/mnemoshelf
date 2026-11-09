/**
 * 波次一 D5：Range 播放端點的路徑競態與 handle 身分綁定（紅→綠測試）。
 *
 * 背景（獨立審查 STD-1，P1）：`buildMediaResponse` 在 `resolveTarget` 之後才依**路徑**
 * 重新 `createReadStream`；在 stat 後把 root 內的父目錄換成指向 root 外的 junction／symlink，
 * 實際回 206 且 body 是 root 外內容。契約 D5 要求：
 * resolveTarget → `fs.open` 取 handle → `handle.stat()` → 大小檢查 → **重新解析 root 邊界
 * 並比對 handle 身分（dev／ino／size）** → 只用 `handle.createReadStream` 讀取；身分不可證明
 * （dev／ino 皆 0）時 fail closed；HEAD／416／0 byte／錯誤路徑都要關閉 handle。
 *
 * 測試注入方式：`media.ts` 與 core path-guard 都使用 `node:fs` 的 `promises` 物件，
 * 這裡直接替換該物件的 `open`／`lstat`／`stat` 方法（等價注入；測試後還原），在精確時點
 * 進行「目錄連結改指向 root 外」或「同大小內容替換」。全部資料都是 `os.tmpdir()` 下的合成 bytes。
 *
 * 為什麼 fixture 的 `source` 一開始就是目錄連結：Windows 上只要目錄內有已開啟的檔案 handle，
 * rename 該實體目錄會 EPERM（實測）；但移除／重建**連結本身**可以（reparse point 不持有
 * 目標檔案 handle）。這也讓「連結被改指向 root 外」的競態可以在 handle 開啟後重現。
 *
 * 驗收原則：任何情況都不得回 200／206 帶 root 外內容；可接受 403／404／409，或成功但只讀到
 * 已驗證的 root 內內容（INSIDE）。
 */
import { appendFileSync, promises as fs, truncateSync, type BigIntStats, type Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { PathOutsideRootError, type Root } from "@mnemoshelf/core";
import { FakeEmbedder } from "@mnemoshelf/core/testing";
import { buildMediaResponse, type StreamRouteResult } from "../src/index.js";
import { api, startTestServer, TEST_TOKEN, type TestServer } from "./helpers.js";

/** 合成內容：7 bytes（`bytes=0-6` 剛好整檔），root 內外刻意不同。 */
const INSIDE = "INSIDE0";
const OUTSIDE = "OUTSIDE";

/** 目錄連結型別：Windows 用 junction（不需管理員權限），POSIX 用 symlink。 */
const LINK_TYPE: "dir" | "junction" = process.platform === "win32" ? "junction" : "dir";

interface RaceFixture {
  parent: string;
  rootDir: string;
  /** root 內的實體目錄（真正存檔案的地方）。 */
  insideDir: string;
  /** root 內的連結（Windows junction／POSIX symlink）→ `insideDir`；競態時改指向 root 外。 */
  sourceDir: string;
  outsideDir: string;
  /** 經連結看到的合法檔案路徑（API 的相對路徑會走這條）。 */
  sourceFile: string;
  /** 連結解析後的真實檔案路徑（realpath；media.ts 開檔時看到的就是它）。 */
  insideFile: string;
  root: Root;
  /** 平台是否支援建立目錄連結（不支援時測試 skip 並註明）。 */
  linkSupported: boolean;
  swapped: boolean;
  swapToOutside(): Promise<void>;
  cleanup(): Promise<void>;
}

const fixtures: RaceFixture[] = [];
const restores: Array<() => void> = [];
let server: TestServer | undefined;

afterEach(async () => {
  while (restores.length > 0) restores.pop()!();
  await server?.close();
  server = undefined;
  while (fixtures.length > 0) await fixtures.pop()!.cleanup();
});

function normalizePath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" || process.platform === "darwin" ? resolved.toLowerCase() : resolved;
}

/** 目標是否就是 fixture 的合法檔案（可能是連結路徑或 realpath；大小寫依平台）。 */
function isInsideFile(target: unknown, fixture: RaceFixture): boolean {
  if (typeof target !== "string" && !Buffer.isBuffer(target) && !(target instanceof URL)) return false;
  const normalized = normalizePath(String(target));
  return normalized === normalizePath(fixture.insideFile) || normalized === normalizePath(fixture.sourceFile);
}

/** 目標是否是 fixture 的目錄連結（`root/source`）。 */
function isSourceLink(target: unknown, fixture: RaceFixture): boolean {
  if (typeof target !== "string" && !Buffer.isBuffer(target) && !(target instanceof URL)) return false;
  return normalizePath(String(target)) === normalizePath(fixture.sourceDir);
}

/**
 * 直接替換 `node:fs/promises` 物件上的方法（media.ts 與 core path-guard 共用同一個物件）。
 * 測試後一律還原；不做跨測試殘留。
 */
function patchFs(name: "open" | "stat" | "lstat", replacement: unknown): void {
  const holder = fs as unknown as Record<string, unknown>;
  const original = holder[name];
  holder[name] = replacement;
  restores.push(() => {
    holder[name] = original;
  });
}

async function makeFixture(options: { inside?: string; outside?: string } = {}): Promise<RaceFixture> {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "mnemoshelf-media-race-"));
  const rootDir = path.join(parent, "root");
  const insideDir = path.join(rootDir, "inside");
  const sourceDir = path.join(rootDir, "source");
  const outsideDir = path.join(parent, "outside");
  await fs.mkdir(insideDir, { recursive: true });
  await fs.mkdir(outsideDir);
  await fs.writeFile(path.join(insideDir, "clip.mp4"), options.inside ?? INSIDE);
  await fs.writeFile(path.join(insideDir, "empty.mp4"), "");
  await fs.writeFile(path.join(outsideDir, "clip.mp4"), options.outside ?? OUTSIDE);

  // 先探測平台是否支援目錄連結；不支援（例如無權限的 Windows）就讓測試 skip。
  let linkSupported = true;
  try {
    await fs.symlink(insideDir, sourceDir, LINK_TYPE);
  } catch {
    linkSupported = false;
    await fs.mkdir(sourceDir, { recursive: true });
  }

  const fixture: RaceFixture = {
    parent,
    rootDir,
    insideDir,
    sourceDir,
    outsideDir,
    sourceFile: path.join(sourceDir, "clip.mp4"),
    insideFile: path.join(insideDir, "clip.mp4"),
    root: {
      id: 1,
      path: await fs.realpath(rootDir),
      mode: "index",
      modalities: ["video"],
      include: [],
      exclude: [],
      respectGitignore: true,
      watch: false,
      createdAt: "2026-11-08T00:00:00.000Z",
    },
    linkSupported,
    swapped: false,
    async swapToOutside() {
      if (fixture.swapped) return;
      await fs.unlink(sourceDir);
      await fs.symlink(outsideDir, sourceDir, LINK_TYPE);
      fixture.swapped = true;
    },
    async cleanup() {
      // 連結（junction／symlink）先移除，避免遞迴刪除跟進目標；再刪整個暫存目錄。
      await fs.unlink(sourceDir).catch(() => undefined);
      await fs.rm(parent, { recursive: true, force: true });
    },
  };
  fixtures.push(fixture);
  return fixture;
}

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function request(
  fixture: RaceFixture,
  overrides: { relPath?: string; rangeHeader?: string; headOnly?: boolean; maxFileBytes?: number } = {},
) {
  return buildMediaResponse(
    fixture.root,
    {
      relPath: overrides.relPath ?? path.join("source", "clip.mp4"),
      // 明確傳 undefined 表示「沒有 Range header」；只有未提供時才用預設 0-6。
      rangeHeader: "rangeHeader" in overrides ? overrides.rangeHeader : "bytes=0-6",
      headOnly: overrides.headOnly ?? false,
    },
    { maxFileBytes: overrides.maxFileBytes ?? 512 * 1024 * 1024 },
  );
}

/**
 * 驗收斷言：允許具名拒絕（403 走 `PathOutsideRootError` 映射），或成功但只能讀到
 * root 內內容；**絕不得**是 OUTSIDE。
 */
async function expectNoOutside(promise: Promise<StreamRouteResult>, expectedBody = INSIDE): Promise<void> {
  let result: StreamRouteResult | undefined;
  try {
    result = await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(PathOutsideRootError);
    return;
  }
  expect(result.stream).not.toBeNull();
  expect([200, 206]).toContain(result.status);
  const body = (await readAll(result.stream!)).toString("utf8");
  expect(body).not.toBe(OUTSIDE);
  expect(body).toBe(expectedBody);
}

/** 取得 handle 的 stat；已關閉時應 reject（EBADF）。 */
async function expectHandleClosed(handle: FileHandle): Promise<void> {
  await expect(handle.stat()).rejects.toThrow();
}

/** 追蹤 media.ts 開的 handle（用於斷言正常／錯誤路徑都會關閉）。 */
function captureOpenedHandles(): FileHandle[] {
  const originalOpen = fs.open as unknown as (...args: unknown[]) => Promise<FileHandle>;
  const opened: FileHandle[] = [];
  patchFs("open", async (target: unknown, ...rest: unknown[]) => {
    const handle = await originalOpen.call(fs, target, ...rest);
    opened.push(handle);
    return handle;
  });
  return opened;
}

describe("D5：Range 播放端點路徑競態（handle 綁定）", () => {
  it("原始反例等價：驗證期間把父目錄連結改指向 root 外 → 不得回 root 外內容", async (ctx) => {
    const fixture = await makeFixture();
    if (!fixture.linkSupported) ctx.skip();
    const originalLstat = fs.lstat as unknown as (...args: unknown[]) => Promise<unknown>;
    let swapped = false;
    patchFs("lstat", async (target: unknown, ...rest: unknown[]) => {
      const stats = await originalLstat.call(fs, target, ...rest);
      // 在 root 守衛逐段解析到「父目錄連結」之後、真正開檔之前改指向（獨立審查的競態時點）。
      if (!swapped && isSourceLink(target, fixture)) {
        swapped = true;
        await fixture.swapToOutside();
      }
      return stats;
    });

    await expectNoOutside(request(fixture));
    expect(swapped).toBe(true);
  });

  it("流程中沒有「先 stat 路徑、再開檔」的窗口（原始反例的前提已消失）", async () => {
    const fixture = await makeFixture();
    const originalOpen = fs.open as unknown as (...args: unknown[]) => Promise<FileHandle>;
    const originalStat = fs.stat as unknown as (...args: unknown[]) => Promise<unknown>;
    const events: string[] = [];
    patchFs("open", async (target: unknown, ...rest: unknown[]) => {
      events.push("open");
      return originalOpen.call(fs, target, ...rest);
    });
    patchFs("stat", async (target: unknown, ...rest: unknown[]) => {
      events.push("stat");
      return originalStat.call(fs, target, ...rest);
    });

    const result = await request(fixture);
    expect((await readAll(result.stream!)).toString("utf8")).toBe(INSIDE);
    const firstOpen = events.indexOf("open");
    const firstStat = events.indexOf("stat");
    expect(firstOpen).toBeGreaterThanOrEqual(0);
    // 原始反例靠「路徑 stat 之後才開檔」插入替換；新流程開檔先於任何路徑 stat。
    expect(firstStat === -1 || firstStat > firstOpen).toBe(true);
  });

  it("開檔前換連結（注入 fs.open）→ 拒絕或只讀到 INSIDE", async (ctx) => {
    const fixture = await makeFixture();
    if (!fixture.linkSupported) ctx.skip();
    const originalOpen = fs.open as unknown as (...args: unknown[]) => Promise<FileHandle>;
    let swapped = false;
    patchFs("open", async (target: unknown, ...rest: unknown[]) => {
      if (!swapped && isInsideFile(target, fixture)) {
        swapped = true;
        await fixture.swapToOutside();
      }
      return originalOpen.call(fs, target, ...rest);
    });

    await expectNoOutside(request(fixture));
    expect(swapped).toBe(true);
  });

  it("開檔後才換連結（handle 已取得）→ 拒絕或只讀到 INSIDE", async (ctx) => {
    const fixture = await makeFixture();
    if (!fixture.linkSupported) ctx.skip();
    const originalOpen = fs.open as unknown as (...args: unknown[]) => Promise<FileHandle>;
    let swapped = false;
    patchFs("open", async (target: unknown, ...rest: unknown[]) => {
      const handle = await originalOpen.call(fs, target, ...rest);
      if (!swapped && isInsideFile(target, fixture)) {
        swapped = true;
        await fixture.swapToOutside();
      }
      return handle;
    });

    await expectNoOutside(request(fixture));
    expect(swapped).toBe(true);
  });

  it("開檔後同大小內容替換（inode 改變）→ 必須具名拒絕", async () => {
    const fixture = await makeFixture();
    const originalOpen = fs.open as unknown as (...args: unknown[]) => Promise<FileHandle>;
    let replaced = false;
    patchFs("open", async (target: unknown, ...rest: unknown[]) => {
      const handle = await originalOpen.call(fs, target, ...rest);
      if (!replaced && isInsideFile(target, fixture)) {
        replaced = true;
        // 同大小（7 bytes）不同內容、**不同 inode**。
        // Windows 上 rename 覆蓋已開啟的檔案會 EPERM（實測），因此用「移除後重建同路徑」
        // 製造等價的「路徑指向新 inode」情境；POSIX 亦可。
        await fs.unlink(fixture.insideFile);
        await fs.writeFile(fixture.insideFile, "INSIDE1");
      }
      return handle;
    });

    await expect(request(fixture)).rejects.toBeInstanceOf(PathOutsideRootError);
    expect(replaced).toBe(true);
  });

  it("開檔前同大小內容替換（inode 已變）：讀到的是當下 root 內內容，不是 root 外", async () => {
    const fixture = await makeFixture();
    await fs.unlink(fixture.insideFile);
    await fs.writeFile(fixture.insideFile, "INSIDE1");

    await expectNoOutside(request(fixture), "INSIDE1");
  });

  it("身分不可證明（dev／ino 皆 0）→ fail closed（不得只比路徑字串）", async () => {
    const fixture = await makeFixture();
    const originalOpen = fs.open as unknown as (...args: unknown[]) => Promise<FileHandle>;
    patchFs("open", async (target: unknown, ...rest: unknown[]) => {
      const real = await originalOpen.call(fs, target, ...rest);
      const realStat = real.stat as (options?: unknown) => Promise<Stats | BigIntStats>;
      return {
        stat: async (options?: unknown) => {
          const stats = await realStat.call(real, options);
          // 模擬檔案系統不提供 dev／ino：BigIntStats 的 0n。
          return Object.assign(Object.create(stats) as object, { dev: 0n, ino: 0n });
        },
        createReadStream: (options: unknown) => real.createReadStream(options as Parameters<typeof real.createReadStream>[0]),
        close: () => real.close(),
      } as unknown as FileHandle;
    });

    await expect(request(fixture)).rejects.toBeInstanceOf(PathOutsideRootError);
  });

  it("HEAD／416／0 byte／超過大小上限都關閉 handle", async () => {
    const fixture = await makeFixture();
    const opened = captureOpenedHandles();

    // HEAD：只回 header，handle 要關。
    const head = await request(fixture, { headOnly: true });
    expect(head.stream).toBeNull();
    expect(head.status).toBe(206);
    expect(opened).toHaveLength(1);
    await expectHandleClosed(opened[0]!);

    // 416：越界 Range，handle 要關。
    const unsatisfiable = await request(fixture, { rangeHeader: "bytes=999-" });
    expect(unsatisfiable.status).toBe(416);
    expect(unsatisfiable.stream).toBeNull();
    expect(opened).toHaveLength(2);
    await expectHandleClosed(opened[1]!);

    // 0 byte：沒有 body，handle 要關。
    const empty = await request(fixture, { relPath: path.join("source", "empty.mp4"), rangeHeader: undefined });
    expect(empty.status).toBe(200);
    expect(empty.headers["content-length"]).toBe("0");
    expect(opened).toHaveLength(3);
    await expectHandleClosed(opened[2]!);

    // 超過大小上限：413 前已開 handle，錯誤路徑也要關。
    await expect(request(fixture, { maxFileBytes: 1 })).rejects.toMatchObject({ name: "FileTooLargeError" });
    expect(opened).toHaveLength(4);
    await expectHandleClosed(opened[3]!);
  });

  it("正常播放：串流讀完後 handle 已關閉（fd 不洩漏）", async () => {
    const fixture = await makeFixture();
    const opened = captureOpenedHandles();

    const result = await request(fixture);
    expect(result.status).toBe(206);
    expect((await readAll(result.stream!)).toString("utf8")).toBe(INSIDE);
    expect(opened).toHaveLength(1);
    await expectHandleClosed(opened[0]!);
  });

  it("client 中止（destroy stream）→ handle 已關閉", async () => {
    const fixture = await makeFixture();
    const opened = captureOpenedHandles();

    const result = await request(fixture);
    expect(result.stream).not.toBeNull();
    const stream = result.stream!;
    const closed = new Promise<void>((resolve) => stream.once("close", () => resolve()));
    stream.destroy();
    await closed;
    expect(opened).toHaveLength(1);
    await expectHandleClosed(opened[0]!);
  });

  it("驗證後、開始讀取前截斷：回應不假裝完整（短 body），handle 關閉", async () => {
    const fixture = await makeFixture();
    const originalOpen = fs.open as unknown as (...args: unknown[]) => Promise<FileHandle>;
    let truncated = false;
    let handle: FileHandle | undefined;
    patchFs("open", async (target: unknown, ...rest: unknown[]) => {
      const real = await originalOpen.call(fs, target, ...rest);
      handle = real;
      // 代理 handle：身分驗證完成後才真正建立串流；建立前同步截斷（模擬驗證後、讀取前變更）。
      return {
        stat: (options?: unknown) => real.stat(options as Parameters<typeof real.stat>[0]),
        createReadStream: (options: unknown) => {
          if (!truncated) {
            truncated = true;
            truncateSync(fixture.insideFile, 0);
          }
          return real.createReadStream(options as Parameters<typeof real.createReadStream>[0]);
        },
        close: () => real.close(),
      } as unknown as FileHandle;
    });

    const result = await request(fixture);
    expect([200, 206]).toContain(result.status);
    const body = await readAll(result.stream!);
    // 已宣告 7 bytes，但檔案被截斷：client 只能拿到少於宣告的內容，不得假裝完整。
    expect(body.length).toBeLessThan(7);
    expect(truncated).toBe(true);
    expect(handle).toBeDefined();
    await expectHandleClosed(handle!);
  });

  it("驗證後、開始讀取前增長：以驗證時的大小為準，不多送（也不越界）", async () => {
    const fixture = await makeFixture();
    const originalOpen = fs.open as unknown as (...args: unknown[]) => Promise<FileHandle>;
    let grown = false;
    patchFs("open", async (target: unknown, ...rest: unknown[]) => {
      const real = await originalOpen.call(fs, target, ...rest);
      return {
        stat: (options?: unknown) => real.stat(options as Parameters<typeof real.stat>[0]),
        createReadStream: (options: unknown) => {
          if (!grown) {
            grown = true;
            appendFileSync(fixture.insideFile, "EXTRA");
          }
          return real.createReadStream(options as Parameters<typeof real.createReadStream>[0]);
        },
        close: () => real.close(),
      } as unknown as FileHandle;
    });

    const result = await request(fixture);
    expect(result.status).toBe(206);
    expect(result.headers["content-length"]).toBe("7");
    expect((await readAll(result.stream!)).toString("utf8")).toBe(INSIDE);
    expect(grown).toBe(true);
  });

  it("HTTP 端到端：request 期間父目錄連結被改指向 root 外 → 具名拒絕、不得回 OUTSIDE", async (ctx) => {
    const fixture = await makeFixture();
    if (!fixture.linkSupported) ctx.skip();
    server = await startTestServer({ embedder: new FakeEmbedder({ video: true }) });
    const created = await api(server.instance, "POST", "/roots", {
      body: { path: fixture.rootDir, modalities: ["video"] },
    });
    expect(created.status).toBe(201);
    const rootId = (created.body as { id: number }).id;

    const originalLstat = fs.lstat as unknown as (...args: unknown[]) => Promise<unknown>;
    let swapped = false;
    patchFs("lstat", async (target: unknown, ...rest: unknown[]) => {
      const stats = await originalLstat.call(fs, target, ...rest);
      if (!swapped && isSourceLink(target, fixture)) {
        swapped = true;
        await fixture.swapToOutside();
      }
      return stats;
    });

    const response = await fetch(
      `${server.instance.url}/roots/${rootId}/media?path=${encodeURIComponent("source/clip.mp4")}`,
      { headers: { authorization: `Bearer ${TEST_TOKEN}`, range: "bytes=0-6" } },
    );
    expect(swapped).toBe(true);
    const body = Buffer.from(await response.arrayBuffer()).toString("utf8");
    expect(body).not.toBe(OUTSIDE);
    expect(body).not.toContain(OUTSIDE);
    expect([403, 404, 409]).toContain(response.status);
  });
});
