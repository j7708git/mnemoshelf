/**
 * 唯讀資料夾瀏覽端點（`GET /fs/browse`、`GET /fs/policy`）與可設定存取策略測試。
 *
 * 全部使用 `os.tmpdir()` 下的合成目錄，結束後刪除；不讀取任何使用者檔案。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  browseDirectories,
  isLoopbackBindHost,
  loadServerConfig,
  summarizeAccessPolicy,
  type BrowseDirectoriesResponse,
} from "../src/index.js";
import { api, errorName, makeTempDir, removeTempDir, startTestServer, type TestServer } from "./helpers.js";

let server: TestServer | undefined;
const tempDirs: string[] = [];

afterEach(async () => {
  await server?.close();
  server = undefined;
  while (tempDirs.length > 0) await removeTempDir(tempDirs.pop()!);
});

async function makeBrowseSandbox(): Promise<{
  outerDir: string;
  homeDir: string;
  docsDir: string;
  subDir: string;
  sshDir: string;
  outsideDir: string;
}> {
  const outerDir = await makeTempDir("mnemoshelf-browse-");
  tempDirs.push(outerDir);

  const homeDir = path.join(outerDir, "home");
  const docsDir = path.join(homeDir, "Documents");
  const subDir = path.join(docsDir, "notes");
  const sshDir = path.join(homeDir, ".ssh");
  const gitDir = path.join(homeDir, ".git");
  const outsideDir = path.join(outerDir, "outside-secret");

  await fs.mkdir(subDir, { recursive: true });
  await fs.mkdir(sshDir, { recursive: true });
  await fs.mkdir(gitDir, { recursive: true });
  await fs.mkdir(outsideDir, { recursive: true });
  await fs.writeFile(path.join(homeDir, "readme.txt"), "不應被列出或讀取的檔案內容\n", "utf8");
  await fs.writeFile(path.join(docsDir, "paper.md"), "# 檔案\n", "utf8");
  return { outerDir, homeDir, docsDir, subDir, sshDir, outsideDir };
}

describe("config：存取與瀏覽策略環境變數", () => {
  it("預設值為最嚴格安全設定（127.0.0.1、需 token、home 範圍、啟用黑名單）", () => {
    const cfg = loadServerConfig({ MNEMOSHELF_TOKEN: "t" });
    expect(cfg.host).toBe("127.0.0.1");
    expect(cfg.allowAnonymous).toBe(false);
    expect(cfg.browseScope).toBe("home");
    expect(cfg.browseRoots).toEqual([]);
    expect(cfg.browseRespectBlacklist).toBe(true);
    expect(
      summarizeAccessPolicy({
        host: cfg.host,
        allowAnonymous: cfg.allowAnonymous,
        browseScope: cfg.browseScope,
        browseRespectBlacklist: cfg.browseRespectBlacklist,
      }).relaxed,
    ).toBe(false);
  });

  it("未設 MNEMOSHELF_TOKEN 且未開匿名存取 → 拒絕啟動", () => {
    expect(() => loadServerConfig({})).toThrowError(/MNEMOSHELF_TOKEN/);
  });

  it("MNEMOSHELF_ALLOW_ANONYMOUS=on 可免 token 啟動，且策略標記為放寬", () => {
    const cfg = loadServerConfig({ MNEMOSHELF_ALLOW_ANONYMOUS: "on" });
    expect(cfg.allowAnonymous).toBe(true);
    expect(cfg.token).toBe("");
    expect(
      summarizeAccessPolicy({
        host: cfg.host,
        allowAnonymous: cfg.allowAnonymous,
        browseScope: cfg.browseScope,
        browseRespectBlacklist: cfg.browseRespectBlacklist,
      }),
    ).toMatchObject({ allowAnonymous: true, relaxed: true });
  });

  it("custom 範圍必須提供 MNEMOSHELF_BROWSE_ROOTS；unrestricted／host／黑名單皆可覆寫", () => {
    expect(() => loadServerConfig({ MNEMOSHELF_TOKEN: "t", MNEMOSHELF_BROWSE_SCOPE: "custom" })).toThrowError(
      /MNEMOSHELF_BROWSE_ROOTS/,
    );

    const joined = [path.join("alpha"), path.join("beta")].join(path.delimiter);
    const customCfg = loadServerConfig({
      MNEMOSHELF_TOKEN: "t",
      MNEMOSHELF_BROWSE_SCOPE: "custom",
      MNEMOSHELF_BROWSE_ROOTS: joined,
      MNEMOSHELF_HOST: "0.0.0.0",
      MNEMOSHELF_BROWSE_RESPECT_BLACKLIST: "off",
    });
    expect(customCfg.host).toBe("0.0.0.0");
    expect(isLoopbackBindHost(customCfg.host)).toBe(false);
    expect(customCfg.browseScope).toBe("custom");
    expect(customCfg.browseRoots).toEqual([path.resolve("alpha"), path.resolve("beta")]);
    expect(customCfg.browseRespectBlacklist).toBe(false);
  });

  it("非法環境變數值一律拒絕啟動", () => {
    expect(() => loadServerConfig({ MNEMOSHELF_TOKEN: "t", MNEMOSHELF_ALLOW_ANONYMOUS: "maybe" })).toThrowError(
      /MNEMOSHELF_ALLOW_ANONYMOUS/,
    );
    expect(() => loadServerConfig({ MNEMOSHELF_TOKEN: "t", MNEMOSHELF_BROWSE_SCOPE: "all" })).toThrowError(
      /MNEMOSHELF_BROWSE_SCOPE/,
    );
    expect(() => loadServerConfig({ MNEMOSHELF_TOKEN: "t", MNEMOSHELF_HOST: "bad host" })).toThrowError(
      /MNEMOSHELF_HOST/,
    );
  });
});

describe("REST GET /fs/browse：預設嚴格守衛", () => {
  it("無 token 或錯誤 token → 401", async () => {
    const sandbox = await makeBrowseSandbox();
    server = await startTestServer({ homeDir: sandbox.homeDir });

    const missing = await api(server.instance, "GET", "/fs/browse", { token: null });
    expect(missing.status).toBe(401);
    expect(errorName(missing.body)).toBe("UnauthorizedError");

    const wrong = await api(server.instance, "GET", "/fs/browse", { token: "wrong-token" });
    expect(wrong.status).toBe(401);

    const policyMissing = await api(server.instance, "GET", "/fs/policy", { token: null });
    expect(policyMissing.status).toBe(401);
  });

  it("只列子資料夾名稱（不含檔案），略過黑名單與 .git，並回傳快速位置", async () => {
    const sandbox = await makeBrowseSandbox();
    server = await startTestServer({ homeDir: sandbox.homeDir });

    const res = await api(server.instance, "GET", "/fs/browse");
    expect(res.status).toBe(200);
    const body = res.body as BrowseDirectoriesResponse;

    expect(body.currentPath).toBe(await fs.realpath(sandbox.homeDir));
    expect(body.parentPath).toBeNull();
    expect(body.directories.map((d) => d.name)).toEqual(["Documents"]);
    expect(body.quickLocations.map((q) => q.label)).toEqual(["家目錄", "文件"]);
    expect(body.policy).toMatchObject({
      host: "127.0.0.1",
      nonLoopbackBind: false,
      allowAnonymous: false,
      browseScope: "home",
      respectBlacklist: true,
      relaxed: false,
    });
  });

  it("可進入子資料夾並返回上一層；不允許的 HTTP 方法回 405", async () => {
    const sandbox = await makeBrowseSandbox();
    server = await startTestServer({ homeDir: sandbox.homeDir });

    const res = await api(
      server.instance,
      "GET",
      `/fs/browse?path=${encodeURIComponent(sandbox.docsDir)}`,
    );
    expect(res.status).toBe(200);
    const body = res.body as BrowseDirectoriesResponse;
    expect(body.parentPath).toBe(await fs.realpath(sandbox.homeDir));
    expect(body.directories.map((d) => d.name)).toEqual(["notes"]);
    expect(body.breadcrumbs.map((b) => b.label)).toEqual(["home", "Documents"]);

    const postRes = await api(server.instance, "POST", "/fs/browse", { body: {} });
    expect(postRes.status).toBe(405);
  });

  it("越界路徑、黑名單目錄與 symlink 逃脫一律回 403", async () => {
    const sandbox = await makeBrowseSandbox();
    const escapeLink = path.join(sandbox.homeDir, "escape-link");
    await fs.symlink(sandbox.outsideDir, escapeLink, "dir");

    server = await startTestServer({ homeDir: sandbox.homeDir });

    // 清單內不得出現逃脫的 symlink
    const rootRes = await api(server.instance, "GET", "/fs/browse");
    expect(rootRes.status).toBe(200);
    expect((rootRes.body as BrowseDirectoriesResponse).directories.map((d) => d.name)).toEqual(["Documents"]);

    // 直接請求家目錄外路徑 → 403
    const outside = await api(
      server.instance,
      "GET",
      `/fs/browse?path=${encodeURIComponent(sandbox.outsideDir)}`,
    );
    expect(outside.status).toBe(403);
    expect(errorName(outside.body)).toBe("PathOutsideRootError");

    // 請求不存在的家目錄外路徑 → 403（不洩漏 404 存在性）
    const probeOutside = await api(
      server.instance,
      "GET",
      `/fs/browse?path=${encodeURIComponent(path.join(sandbox.outsideDir, "nonexistent"))}`,
    );
    expect(probeOutside.status).toBe(403);

    // 請求黑名單（.ssh）→ 403
    const blocked = await api(
      server.instance,
      "GET",
      `/fs/browse?path=${encodeURIComponent(sandbox.sshDir)}`,
    );
    expect(blocked.status).toBe(403);
    expect(errorName(blocked.body)).toBe("PathBlockedError");

    // 透過 symlink 逃脫 → 403
    const viaLink = await api(
      server.instance,
      "GET",
      `/fs/browse?path=${encodeURIComponent(escapeLink)}`,
    );
    expect(viaLink.status).toBe(403);
    expect(errorName(viaLink.body)).toBe("PathOutsideRootError");
  });

  it("非目錄、相對路徑、NUL 位元組回 400；範圍內不存在目錄回 404", async () => {
    const sandbox = await makeBrowseSandbox();
    server = await startTestServer({ homeDir: sandbox.homeDir });

    const fileTarget = await api(
      server.instance,
      "GET",
      `/fs/browse?path=${encodeURIComponent(path.join(sandbox.homeDir, "readme.txt"))}`,
    );
    expect(fileTarget.status).toBe(400);

    const relTarget = await api(server.instance, "GET", "/fs/browse?path=Documents");
    expect(relTarget.status).toBe(400);

    const nulTarget = await api(
      server.instance,
      "GET",
      `/fs/browse?path=${encodeURIComponent(`${sandbox.homeDir}\0bad`)}`,
    );
    expect(nulTarget.status).toBe(400);

    const missing = await api(
      server.instance,
      "GET",
      `/fs/browse?path=${encodeURIComponent(path.join(sandbox.homeDir, "missing-dir"))}`,
    );
    expect(missing.status).toBe(404);
  });
});

describe("REST：可設定覆寫策略（風險明確標示）", () => {
  it("allowAnonymous=true 時 /health 回傳 authRequired:false 且免 token 可瀏覽", async () => {
    const sandbox = await makeBrowseSandbox();
    server = await startTestServer({
      homeDir: sandbox.homeDir,
      allowAnonymous: true,
    });

    const health = await api(server.instance, "GET", "/health", { token: null });
    expect(health.status).toBe(200);
    expect(health.body).toMatchObject({
      authRequired: false,
      accessPolicy: { allowAnonymous: true, relaxed: true },
    });

    const browse = await api(server.instance, "GET", "/fs/browse", { token: null });
    expect(browse.status).toBe(200);
    expect((browse.body as BrowseDirectoriesResponse).policy.relaxed).toBe(true);
  });

  it("custom／unrestricted 範圍與關閉黑名單覆寫生效且標示 relaxed:true", async () => {
    const sandbox = await makeBrowseSandbox();
    const customOnly = await browseDirectories(sandbox.outsideDir, {
      homeDir: sandbox.homeDir,
      host: "127.0.0.1",
      allowAnonymous: false,
      browseScope: "custom",
      browseRoots: [sandbox.outsideDir],
      browseRespectBlacklist: true,
    });
    expect(customOnly.currentPath).toBe(await fs.realpath(sandbox.outsideDir));
    expect(customOnly.policy.relaxed).toBe(true);
    await expect(
      browseDirectories(sandbox.homeDir, {
        homeDir: sandbox.homeDir,
        host: "127.0.0.1",
        allowAnonymous: false,
        browseScope: "custom",
        browseRoots: [sandbox.outsideDir],
        browseRespectBlacklist: true,
      }),
    ).rejects.toMatchObject({ name: "PathOutsideRootError" });

    const unrestrictedNoBlacklist = await browseDirectories(sandbox.sshDir, {
      homeDir: sandbox.homeDir,
      host: "127.0.0.1",
      allowAnonymous: false,
      browseScope: "unrestricted",
      browseRoots: [],
      browseRespectBlacklist: false,
    });
    expect(unrestrictedNoBlacklist.currentPath).toBe(await fs.realpath(sandbox.sshDir));
    expect(unrestrictedNoBlacklist.policy).toMatchObject({
      browseScope: "unrestricted",
      respectBlacklist: false,
      relaxed: true,
    });
  });
});
