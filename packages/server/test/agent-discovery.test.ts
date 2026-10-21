/**
 * Agent 連線資訊檔（`runtime.json`）：生命週期、權限、health 身分欄位與「不留 token」。
 *
 * 全部使用 `os.tmpdir()` 的合成資料；token 是測試用的合成值（`TEST_TOKEN`）。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { FakeEmbedder } from "@mnemoshelf/core/testing";
import {
  AGENT_RUNTIME_SCHEMA_VERSION,
  APP_VERSION,
  createServer,
  loadServerConfig,
  readRuntimeFile,
  removeRuntimeFile,
  removeRuntimeFileIfOwned,
  SERVICE_NAME,
  writeRuntimeFile,
  type AgentRuntimeFile,
  type MnemoshelfServer,
} from "../src/index.js";
import { makeTempDir, removeTempDir, TEST_TOKEN } from "./helpers.js";

async function readJson(file: string): Promise<AgentRuntimeFile> {
  return JSON.parse(await fs.readFile(file, "utf8")) as AgentRuntimeFile;
}

async function exists(file: string): Promise<boolean> {
  return fs
    .stat(file)
    .then(() => true)
    .catch(() => false);
}

/** 啟動一個 discovery 測試用的 server（FakeEmbedder、隨機埠、暫存資料目錄）。 */
async function start(
  env: NodeJS.ProcessEnv,
  options: { dataDir: string; afterStart?: () => Promise<void> | void },
): Promise<MnemoshelfServer> {
  return createServer({
    env,
    token: TEST_TOKEN,
    dataDir: options.dataDir,
    port: 0,
    embedder: new FakeEmbedder(),
    ...(options.afterStart === undefined ? {} : { afterStart: options.afterStart }),
  });
}

/** 遞迴列出目錄下的檔案（測試檢查「token 只出現在 runtime.json」）。 */
async function listFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(target)));
    else if (entry.isFile()) files.push(target);
  }
  return files;
}

describe("MNEMOSHELF_AGENT_DISCOVERY（server 端連線資訊檔）", () => {
  it("on：寫出 0600、欄位齊全，且檔案內的 url＋token 可通過鑑權；health 帶服務身分", async () => {
    const dataDir = await makeTempDir("mnemoshelf-discovery-");
    const runtimeFile = path.join(dataDir, "runtime.json");
    let instance: MnemoshelfServer | null = null;
    try {
      instance = await start({ MNEMOSHELF_AGENT_DISCOVERY: "on" }, { dataDir });
      expect(await exists(runtimeFile)).toBe(true);

      if (process.platform !== "win32") {
        const mode = (await fs.stat(runtimeFile)).mode & 0o777;
        expect(mode).toBe(0o600);
      }

      const record = await readJson(runtimeFile);
      expect(record.schemaVersion).toBe(AGENT_RUNTIME_SCHEMA_VERSION);
      expect(record.url).toBe(instance.url);
      expect(record.token).toBe(TEST_TOKEN);
      expect(record.pid).toBe(process.pid);
      expect(record.appVersion).toBe(APP_VERSION);
      expect(Number.isNaN(Date.parse(record.startedAt))).toBe(false);
      expect(Object.keys(record).sort()).toEqual(
        ["appVersion", "pid", "schemaVersion", "startedAt", "token", "url"].sort(),
      );

      // 需要鑑權的端點：檔案內的 url＋token → 200；錯 token → 401。
      const authorized = await fetch(`${record.url}/diagnostics`, {
        headers: { authorization: `Bearer ${record.token}` },
      });
      expect(authorized.status).toBe(200);
      const list = await fetch(`${record.url}/memories?limit=1`, {
        headers: { authorization: `Bearer ${record.token}` },
      });
      expect(list.status).toBe(200);
      const rejected = await fetch(`${record.url}/diagnostics`, {
        headers: { authorization: "Bearer wrong-token" },
      });
      expect(rejected.status).toBe(401);

      // /health 免 token，但必須帶服務身分（plugin 用來避免送 token 給同埠的其他程式）。
      const health = await fetch(`${record.url}/health`);
      expect(health.status).toBe(200);
      expect(await health.json()).toMatchObject({ status: "ok", service: SERVICE_NAME, appVersion: APP_VERSION });

      // close() 刪除自己的檔。
      await instance.close();
      instance = null;
      expect(await exists(runtimeFile)).toBe(false);
    } finally {
      if (instance !== null) await instance.close();
      await removeTempDir(dataDir);
    }
  });

  it("off（或未設定）不產生檔案", async () => {
    const dataDir = await makeTempDir("mnemoshelf-discovery-");
    let instance: MnemoshelfServer | null = null;
    try {
      instance = await start({}, { dataDir });
      expect(await exists(path.join(dataDir, "runtime.json"))).toBe(false);
    } finally {
      if (instance !== null) await instance.close();
      await removeTempDir(dataDir);
    }
  });

  it("off 啟動會清除上次殘留的 runtime.json 與 .tmp", async () => {
    const dataDir = await makeTempDir("mnemoshelf-discovery-");
    const runtimeFile = path.join(dataDir, "runtime.json");
    await fs.writeFile(runtimeFile, '{"schemaVersion":1,"token":"stale"}\n', { mode: 0o600 });
    await fs.writeFile(`${runtimeFile}.tmp`, '{"token":"stale"}\n', { mode: 0o600 });
    let instance: MnemoshelfServer | null = null;
    try {
      instance = await start({ MNEMOSHELF_AGENT_DISCOVERY: "off" }, { dataDir });
      expect(await exists(runtimeFile)).toBe(false);
      expect(await exists(`${runtimeFile}.tmp`)).toBe(false);
    } finally {
      if (instance !== null) await instance.close();
      await removeTempDir(dataDir);
    }
  });

  it("close() 只刪除 pid 是自己的檔（別人的檔保留）", async () => {
    const dataDir = await makeTempDir("mnemoshelf-discovery-");
    const runtimeFile = path.join(dataDir, "runtime.json");
    let instance: MnemoshelfServer | null = null;
    try {
      instance = await start({ MNEMOSHELF_AGENT_DISCOVERY: "on" }, { dataDir });
      const foreign: AgentRuntimeFile = {
        schemaVersion: AGENT_RUNTIME_SCHEMA_VERSION,
        url: "http://127.0.0.1:1",
        token: "another-process-token",
        pid: process.pid + 1,
        startedAt: new Date().toISOString(),
        appVersion: "0.0.0",
      };
      await fs.writeFile(runtimeFile, `${JSON.stringify(foreign)}\n`, { mode: 0o600 });

      await instance.close();
      instance = null;
      expect(await exists(runtimeFile)).toBe(true);
      expect((await readJson(runtimeFile)).token).toBe("another-process-token");
    } finally {
      if (instance !== null) await instance.close();
      await removeTempDir(dataDir);
    }
  });

  it("listen 成功後、createServer 回傳前失敗：不留 runtime.json／.tmp，資源已收掉", async () => {
    const dataDir = await makeTempDir("mnemoshelf-discovery-");
    const runtimeFile = path.join(dataDir, "runtime.json");
    let retried: MnemoshelfServer | null = null;
    try {
      await expect(
        start({ MNEMOSHELF_AGENT_DISCOVERY: "on" }, {
          dataDir,
          afterStart: () => {
            throw new Error("模擬啟動後段失敗");
          },
        }),
      ).rejects.toThrow("模擬啟動後段失敗");

      expect(await exists(runtimeFile)).toBe(false);
      expect(await exists(`${runtimeFile}.tmp`)).toBe(false);

      // 同一個資料目錄可以再開一次（DB 已關、沒有殘留的鎖）。
      retried = await start({}, { dataDir });
      expect(retried.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    } finally {
      if (retried !== null) await retried.close();
      await removeTempDir(dataDir);
    }
  });

  it("afterStart 失敗的回滾與 close() 對稱：先 drain 收尾，再 dispose embedder", async () => {
    const dataDir = await makeTempDir("mnemoshelf-discovery-");
    const runtimeFile = path.join(dataDir, "runtime.json");
    // 記錄 drain／dispose 的呼叫：回滾必須走「等在途工作收尾後才 dispose／關 DB」的路徑，
    // 否則在途索引可能寫到已關閉的資料庫。
    class DrainingFakeEmbedder extends FakeEmbedder {
      drains = 0;
      disposals = 0;
      async drain(): Promise<void> {
        this.drains += 1;
      }
      override async dispose(): Promise<void> {
        this.disposals += 1;
      }
    }
    const embedder = new DrainingFakeEmbedder();
    try {
      await expect(
        createServer({
          env: { MNEMOSHELF_AGENT_DISCOVERY: "on" },
          token: TEST_TOKEN,
          dataDir,
          port: 0,
          embedder,
          afterStart: () => {
            throw new Error("模擬啟動後段失敗");
          },
        }),
      ).rejects.toThrow("模擬啟動後段失敗");

      expect(embedder.drains).toBe(1);
      expect(embedder.disposals).toBe(1);
      expect(await exists(runtimeFile)).toBe(false);
    } finally {
      await removeTempDir(dataDir);
    }
  });

  it("寫檔失敗（路徑被目錄佔用）不阻止啟動，也不留下 token", async () => {
    const dataDir = await makeTempDir("mnemoshelf-discovery-");
    const runtimeFile = path.join(dataDir, "runtime.json");
    // 讓 rename 目標是同名的目錄 → 寫檔失敗；discovery 只記 warning，服務照常。
    await fs.mkdir(runtimeFile);
    const messages: string[] = [];
    const errorSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      messages.push(args.map((arg) => String(arg)).join(" "));
    });
    let instance: MnemoshelfServer | null = null;
    try {
      instance = await start({ MNEMOSHELF_AGENT_DISCOVERY: "on" }, { dataDir });
      expect((await fetch(`${instance.url}/health`)).status).toBe(200);
      expect(messages.some((message) => message.includes("無法寫出 agent 連線資訊檔"))).toBe(true);
      expect(messages.join("\n")).not.toContain(TEST_TOKEN);
      expect((await fs.stat(runtimeFile)).isDirectory()).toBe(true);
    } finally {
      errorSpy.mockRestore();
      if (instance !== null) await instance.close();
      await removeTempDir(dataDir);
    }
  });

  it("token 只出現在 runtime.json：log 與診斷匯出都不含 token", async () => {
    const dataDir = await makeTempDir("mnemoshelf-discovery-");
    const runtimeFile = path.join(dataDir, "runtime.json");
    const logs: string[] = [];
    const errorSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(" "));
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(" "));
    });
    let instance: MnemoshelfServer | null = null;
    try {
      instance = await start({ MNEMOSHELF_AGENT_DISCOVERY: "on" }, { dataDir });
      const diagnostics = await fetch(`${instance.url}/diagnostics`, {
        headers: { authorization: `Bearer ${TEST_TOKEN}` },
      });
      expect(diagnostics.status).toBe(200);
      const text = await diagnostics.text();
      expect(text).not.toContain(TEST_TOKEN);

      await instance.close();
      instance = null;

      expect(logs.join("\n")).not.toContain(TEST_TOKEN);
      // 資料目錄裡除了 runtime.json（關閉後已刪）之外，任何檔案都不應含 token。
      for (const file of await listFiles(dataDir)) {
        expect(path.basename(file)).not.toBe("runtime.json");
        const content = await fs.readFile(file);
        expect(content.includes(Buffer.from(TEST_TOKEN, "utf8"))).toBe(false);
      }
    } finally {
      errorSpy.mockRestore();
      logSpy.mockRestore();
      if (instance !== null) await instance.close();
      await removeTempDir(dataDir);
    }
  });
});

describe("runtime.json 公用函式（直接呼叫，不經 createServer）", () => {
  it("readRuntimeFile：不存在、壞 JSON、schema 不符都回 null", async () => {
    const dir = await makeTempDir("mnemoshelf-runtime-file-");
    const file = path.join(dir, "runtime.json");
    try {
      expect(await readRuntimeFile(file)).toBeNull();

      await fs.writeFile(file, "not-json", "utf8");
      expect(await readRuntimeFile(file)).toBeNull();

      await fs.writeFile(file, JSON.stringify({ schemaVersion: 2, url: "u", token: "t", pid: 1 }), "utf8");
      expect(await readRuntimeFile(file)).toBeNull();

      await fs.writeFile(
        file,
        JSON.stringify({ schemaVersion: 1, url: "u", token: "t", pid: 1.5, startedAt: "s", appVersion: "v" }),
        "utf8",
      );
      expect(await readRuntimeFile(file)).toBeNull();
    } finally {
      await removeTempDir(dir);
    }
  });

  it("readRuntimeFile：合法內容回完整欄位", async () => {
    const dir = await makeTempDir("mnemoshelf-runtime-file-");
    const file = path.join(dir, "runtime.json");
    try {
      const written = await writeRuntimeFile(file, {
        url: "http://127.0.0.1:1",
        token: "synthetic-token",
        pid: 4321,
        startedAt: "2026-10-21T00:00:00.000Z",
        appVersion: "0.3.0",
      });
      expect(await readRuntimeFile(file)).toEqual(written);
    } finally {
      await removeTempDir(dir);
    }
  });

  it("writeRuntimeFile：內容正確、POSIX 權限 0600、沒有殘留 .tmp", async () => {
    const dir = await makeTempDir("mnemoshelf-runtime-file-");
    const file = path.join(dir, "runtime.json");
    try {
      const written = await writeRuntimeFile(file, {
        url: "http://127.0.0.1:2",
        token: "synthetic-token",
        pid: 99,
        startedAt: "2026-10-21T00:00:00.000Z",
        appVersion: "9.9.9",
      });
      expect(written).toEqual({
        schemaVersion: AGENT_RUNTIME_SCHEMA_VERSION,
        url: "http://127.0.0.1:2",
        token: "synthetic-token",
        pid: 99,
        startedAt: "2026-10-21T00:00:00.000Z",
        appVersion: "9.9.9",
      });
      expect(await readJson(file)).toEqual(written);
      if (process.platform !== "win32") {
        expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
      }
      expect(await exists(`${file}.tmp`)).toBe(false);
    } finally {
      await removeTempDir(dir);
    }
  });

  it("writeRuntimeFile：rename 失敗（路徑被目錄佔用）時清掉 .tmp 並拋錯", async () => {
    const dir = await makeTempDir("mnemoshelf-runtime-file-");
    const file = path.join(dir, "runtime.json");
    try {
      // 目標是同名的目錄：寫 .tmp 會成功，rename 會失敗。
      await fs.mkdir(file);
      await expect(
        writeRuntimeFile(file, {
          url: "http://127.0.0.1:3",
          token: "synthetic-token",
          appVersion: "0.3.0",
        }),
      ).rejects.toThrow();
      expect(await exists(`${file}.tmp`)).toBe(false);
      expect((await fs.stat(file)).isDirectory()).toBe(true);
    } finally {
      await removeTempDir(dir);
    }
  });

  it("removeRuntimeFile：不存在是 no-op，存在時連 .tmp 一起刪", async () => {
    const dir = await makeTempDir("mnemoshelf-runtime-file-");
    const file = path.join(dir, "runtime.json");
    try {
      await expect(removeRuntimeFile(file)).resolves.toBeUndefined();

      await fs.writeFile(file, "{}\n", "utf8");
      await fs.writeFile(`${file}.tmp`, "{}\n", "utf8");
      await removeRuntimeFile(file);
      expect(await exists(file)).toBe(false);
      expect(await exists(`${file}.tmp`)).toBe(false);
    } finally {
      await removeTempDir(dir);
    }
  });

  it("removeRuntimeFileIfOwned：pid 不是自己→保留；是自己的→刪除", async () => {
    const dir = await makeTempDir("mnemoshelf-runtime-file-");
    const file = path.join(dir, "runtime.json");
    const logs: string[] = [];
    try {
      await writeRuntimeFile(file, {
        url: "http://127.0.0.1:4",
        token: "synthetic-token",
        pid: 4321,
        appVersion: "0.3.0",
      });
      expect(await removeRuntimeFileIfOwned(file, 4322, (line) => logs.push(line))).toBe(false);
      expect(await exists(file)).toBe(true);

      expect(await removeRuntimeFileIfOwned(file, 4321, (line) => logs.push(line))).toBe(true);
      expect(await exists(file)).toBe(false);
      // 不存在時也是 no-op（不拋錯、不記警告）。
      expect(await removeRuntimeFileIfOwned(file, 4321, (line) => logs.push(line))).toBe(false);
      expect(logs).toEqual([]);
    } finally {
      await removeTempDir(dir);
    }
  });
});

describe("loadServerConfig：agent discovery 設定", () => {
  it("預設 off、runtime 檔在 dataDir 下；大小寫不拘且可覆寫路徑", () => {
    const base = { MNEMOSHELF_TOKEN: "x", MNEMOSHELF_DATA_DIR: path.join("tmp", "example-data") };
    const defaults = loadServerConfig(base);
    expect(defaults.agentDiscovery).toBe(false);
    expect(defaults.runtimeFile).toBe(path.join(path.resolve("tmp", "example-data"), "runtime.json"));

    expect(loadServerConfig({ ...base, MNEMOSHELF_AGENT_DISCOVERY: " ON " }).agentDiscovery).toBe(true);
    expect(loadServerConfig({ ...base, MNEMOSHELF_AGENT_DISCOVERY: "off" }).agentDiscovery).toBe(false);
    const custom = path.join("tmp", "example-runtime.json");
    expect(loadServerConfig({ ...base, MNEMOSHELF_RUNTIME_FILE: custom }).runtimeFile).toBe(path.resolve(custom));
  });

  it("非法值直接拒絕啟動", () => {
    expect(() =>
      loadServerConfig({ MNEMOSHELF_TOKEN: "x", MNEMOSHELF_AGENT_DISCOVERY: "yes" }),
    ).toThrow(/MNEMOSHELF_AGENT_DISCOVERY/);
  });
});
