/**
 * `/health` 的 build marker（T0）：additive 欄位、啟動時解析一次、fallback 順序。
 *
 * 不依賴 repo 內真的存在 `dist/build-info.json`：測試以暫存目錄偽造
 * `http/app.js` 的上層 build-info，直接驗證 `readBuildCommit` 的優先順序。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { BUILD_COMMIT, readBuildCommit } from "../src/http/app.js";
import { api, startTestServer, type TestServer } from "./helpers.js";

let server: TestServer | undefined;
const tempDirs: string[] = [];

afterEach(async () => {
  await server?.close();
  server = undefined;
  while (tempDirs.length > 0) await fs.rm(tempDirs.pop()!, { recursive: true, force: true });
});

/** 建立假的 `dist/http/app.js` 位置；`contents` 為 undefined 時不放 build-info。 */
async function makeMetaUrl(contents: string | undefined): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mnemoshelf-build-info-"));
  tempDirs.push(dir);
  const httpDir = path.join(dir, "http");
  await fs.mkdir(httpDir);
  if (contents !== undefined) await fs.writeFile(path.join(dir, "build-info.json"), contents, "utf8");
  return pathToFileURL(path.join(httpDir, "app.js")).href;
}

describe("/health 的 build marker", () => {
  it("回傳 build，且與啟動時解析的 BUILD_COMMIT 一致", async () => {
    server = await startTestServer();
    const response = await api(server.instance, "GET", "/health", { token: null });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      status: "ok",
      service: "mnemoshelf",
      appVersion: expect.any(String),
      build: BUILD_COMMIT,
    });
    expect(typeof BUILD_COMMIT).toBe("string");
    expect(BUILD_COMMIT.length).toBeGreaterThan(0);
  });

  it("優先採用 build-info.json 的 commit", async () => {
    const metaUrl = await makeMetaUrl('{"commit":"abc123"}\n');
    expect(readBuildCommit(metaUrl, { MNEMOSHELF_BUILD_COMMIT: "deadbeef" })).toBe("abc123");
  });

  it("build-info.json 不存在時退回 MNEMOSHELF_BUILD_COMMIT", async () => {
    const metaUrl = await makeMetaUrl(undefined);
    expect(readBuildCommit(metaUrl, { MNEMOSHELF_BUILD_COMMIT: "deadbeef" })).toBe("deadbeef");
  });

  it("build-info.json 格式不符時退回 MNEMOSHELF_BUILD_COMMIT", async () => {
    const metaUrl = await makeMetaUrl("這不是 JSON\n");
    expect(readBuildCommit(metaUrl, { MNEMOSHELF_BUILD_COMMIT: "deadbeef" })).toBe("deadbeef");
  });

  it("兩者都沒有時回 unknown", async () => {
    const metaUrl = await makeMetaUrl(undefined);
    expect(readBuildCommit(metaUrl, {})).toBe("unknown");
  });
});
