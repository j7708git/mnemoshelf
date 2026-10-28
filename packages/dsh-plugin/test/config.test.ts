import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isLoopbackBaseUrl,
  parseRuntimeFile,
  resolveConnection,
  resolveProject,
  resolveSpoolDir,
  runtimeCandidates,
} from "../src/config.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const RUNTIME = {
  schemaVersion: 1,
  url: "http://127.0.0.1:45678",
  token: "test-token",
  pid: 4321,
  startedAt: "2026-10-28T00:00:00.000Z",
  appVersion: "0.4.1",
};

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "mnemoshelf-dsh-config-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeRuntime(content: unknown = RUNTIME): Promise<string> {
  const file = path.join(dir, "runtime.json");
  await writeFile(file, JSON.stringify(content), "utf8");
  return file;
}

describe("runtimeCandidates", () => {
  it("明確指定 MNEMOSHELF_RUNTIME_FILE 時只有那一個候選", () => {
    const file = path.join(dir, "custom.json");
    expect(
      runtimeCandidates({
        platform: "linux",
        home: path.join(dir, "home"),
        env: { MNEMOSHELF_RUNTIME_FILE: file },
      }),
    ).toEqual([path.resolve(file)]);
  });

  it("MNEMOSHELF_DATA_DIR 指向同目錄的 runtime.json", () => {
    expect(
      runtimeCandidates({
        platform: "linux",
        home: path.join(dir, "home"),
        env: { MNEMOSHELF_DATA_DIR: path.join(dir, "data") },
      }),
    ).toEqual([path.resolve(path.join(dir, "data", "runtime.json"))]);
  });

  it("Linux 預設同時包含桌面版與 CLI 位置", () => {
    const home = path.join(dir, "home");
    const candidates = runtimeCandidates({ platform: "linux", home, env: {} });
    expect(candidates).toContain(path.resolve(path.join(home, ".config", "Mnemoshelf", "data", "runtime.json")));
    expect(candidates).toContain(path.resolve(path.join(home, ".local", "share", "mnemoshelf", "runtime.json")));
  });
});

describe("parseRuntimeFile", () => {
  it("合法檔案", () => {
    expect(parseRuntimeFile(JSON.stringify(RUNTIME))).toEqual(RUNTIME);
  });

  it("格式不符一律 null", () => {
    expect(parseRuntimeFile("not json")).toBeNull();
    expect(parseRuntimeFile(JSON.stringify({ ...RUNTIME, schemaVersion: 2 }))).toBeNull();
    expect(parseRuntimeFile(JSON.stringify({ ...RUNTIME, pid: 0 }))).toBeNull();
    expect(parseRuntimeFile(JSON.stringify({ ...RUNTIME, appVersion: undefined }))).toBeNull();
    expect(parseRuntimeFile(JSON.stringify({ ...RUNTIME, token: "  " }))).toBeNull();
  });
});

describe("isLoopbackBaseUrl", () => {
  it("只接受單純的 loopback 基底網址", () => {
    expect(isLoopbackBaseUrl("http://127.0.0.1:1234")).toBe(true);
    expect(isLoopbackBaseUrl("http://localhost:1234")).toBe(true);
    expect(isLoopbackBaseUrl("https://LOCALHOST:1234")).toBe(true);
    expect(isLoopbackBaseUrl("http://0.0.0.0:1234")).toBe(false);
    expect(isLoopbackBaseUrl("http://127.0.0.1:1234/api")).toBe(false);
    expect(isLoopbackBaseUrl("http://user:pass@127.0.0.1:1234")).toBe(false);
    expect(isLoopbackBaseUrl("http://127.0.0.1:1234?x=1")).toBe(false);
  });
});

describe("resolveConnection", () => {
  it("選項完整時直接使用，不打 /health", async () => {
    let called = 0;
    const resolution = await resolveConnection({
      options: { baseUrl: "http://127.0.0.1:1", token: "t" },
      env: {},
      platform: "linux",
      home: dir,
      fetchImpl: (async () => {
        called += 1;
        return jsonResponse({ service: "mnemoshelf" });
      }) as typeof fetch,
    });
    expect(called).toBe(0);
    expect(resolution.connection).toMatchObject({ source: "options", token: "t" });
    expect(resolution.spoolable).toBe(true);
  });

  it("runtime 檔通過 health 後才使用", async () => {
    const file = await writeRuntime();
    const resolution = await resolveConnection({
      options: {},
      env: { MNEMOSHELF_RUNTIME_FILE: file },
      platform: "linux",
      home: dir,
      killImpl: () => {},
      fetchImpl: (async (url: string | URL | Request) => {
        expect(String(url)).toBe("http://127.0.0.1:45678/health");
        return jsonResponse({ service: "mnemoshelf", appVersion: "0.4.1" });
      }) as typeof fetch,
    });
    expect(resolution.reason).toBeNull();
    expect(resolution.connection).toMatchObject({
      source: "runtime",
      baseUrl: "http://127.0.0.1:45678",
      appVersion: "0.4.1",
    });
  });

  it("health 回應不是 mnemoshelf → 不送 token、不 spool", async () => {
    const file = await writeRuntime();
    const resolution = await resolveConnection({
      options: {},
      env: { MNEMOSHELF_RUNTIME_FILE: file },
      platform: "linux",
      home: dir,
      killImpl: () => {},
      fetchImpl: (async () => jsonResponse({ service: "other" })) as typeof fetch,
    });
    expect(resolution).toMatchObject({
      connection: null,
      reason: "health-identity-mismatch",
      spoolable: false,
    });
  });

  it("pid 已死 → 可 spool，等服務回來再補送", async () => {
    const file = await writeRuntime();
    const resolution = await resolveConnection({
      options: {},
      env: { MNEMOSHELF_RUNTIME_FILE: file },
      platform: "linux",
      home: dir,
      killImpl: () => {
        throw Object.assign(new Error("gone"), { code: "ESRCH" });
      },
      fetchImpl: (async () => {
        throw new Error("should not call");
      }) as typeof fetch,
    });
    expect(resolution).toMatchObject({ connection: null, reason: "pid-dead", spoolable: true });
  });

  it("明確指定 runtime 檔但讀不到 → runtime-missing，不退回預設路徑", async () => {
    const resolution = await resolveConnection({
      options: {},
      env: { MNEMOSHELF_RUNTIME_FILE: path.join(dir, "missing.json") },
      platform: "linux",
      home: dir,
      fetchImpl: (async () => jsonResponse({ service: "mnemoshelf" })) as typeof fetch,
    });
    expect(resolution).toMatchObject({
      connection: null,
      reason: "runtime-missing",
      spoolable: false,
    });
  });

  it("平台預設位置找不到 runtime，但資料目錄還在 → 仍可 spool", async () => {
    const home = path.join(dir, "home");
    await mkdir(path.join(home, ".config", "Mnemoshelf", "data"), { recursive: true });
    const resolution = await resolveConnection({
      options: {},
      env: {},
      platform: "linux",
      home,
      fetchImpl: (async () => {
        throw new Error("should not call");
      }) as typeof fetch,
    });
    expect(resolution).toMatchObject({ connection: null, spoolable: true });
  });
});

describe("resolveProject 與 resolveSpoolDir", () => {
  it("選項 → 環境變數 → cwd 資料夾名", () => {
    const home = path.join(dir, "home");
    expect(
      resolveProject({
        optionProject: "opt",
        envProject: "env",
        cwd: path.join(home, "repo"),
        home,
        platform: "linux",
      }),
    ).toBe("opt");
    expect(
      resolveProject({
        envProject: "env",
        cwd: path.join(home, "repo"),
        home,
        platform: "linux",
      }),
    ).toBe("env");
    expect(
      resolveProject({ cwd: path.join(home, "repo"), home, platform: "linux" }),
    ).toBe("repo");
  });

  it("cwd 是家目錄或根目錄時不猜專案", () => {
    const home = path.join(dir, "home");
    expect(resolveProject({ cwd: home, home, platform: "linux" })).toBeNull();
    expect(resolveProject({ cwd: "/", home, platform: "linux" })).toBeNull();
  });

  it("spool 目錄預設在 DSH_HOME 下", () => {
    expect(
      resolveSpoolDir({ env: { DSH_HOME: path.join(dir, "dsh") }, home: dir }),
    ).toBe(path.join(path.resolve(dir, "dsh"), "mnemoshelf-spool"));
    expect(resolveSpoolDir({ env: {}, home: dir })).toBe(
      path.join(path.resolve(dir), ".dsh", "mnemoshelf-spool"),
    );
  });
});
