/**
 * MCP 入口的連線解析測試（runtime.json 自動探索 + 服務身分驗證）。
 *
 * 這裡驗的是「連線從哪來、憑證能不能被信任」：
 * - 環境變數兩個都有 → 直接用，不碰檔案。
 * - 否則讀 agent 連線資訊檔 → 必須先過 pid 存活與 `/health` 身分檢查。
 * - 任何身分不符 → 拒絕（不送 token），且錯誤帶穩定的 `reason`。
 *
 * 測試全程用合成資料與假的家目錄／平台，不碰使用者的真實路徑。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  checkServiceHealth,
  isProcessAlive,
  McpConnectionError,
  resolveMcpConnection,
  runStdio,
  runtimeCandidates,
  type HealthCheckResult,
} from "../src/index.js";
import { makeTempDir, removeTempDir, startTestServer, TEST_TOKEN } from "./helpers.js";

const HOME = "/home/synthetic-user";
const TOKEN = "synthetic-token-value";

/** 造一份合法的 runtime.json 內容。 */
function runtimeJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    url: "http://127.0.0.1:53459",
    token: TOKEN,
    pid: 4242,
    startedAt: "2026-01-01T00:00:00.000Z",
    appVersion: "0.4.0",
    ...overrides,
  });
}

/** 假的讀檔：只認得指定路徑，其餘一律當不存在。 */
function readerFor(files: Record<string, string>): (file: string) => Promise<string> {
  return async (file: string) => {
    const content = files[file];
    if (content === undefined) {
      const error = new Error("ENOENT") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    }
    return content;
  };
}

/** 假的 fetch：回傳指定狀態與內容，並記錄有沒有帶 Authorization。 */
function fakeFetch(
  status: number,
  body: unknown,
  seen: { authorization?: string } = {},
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = init?.headers as Record<string, string> | undefined;
    const authorization = headers?.Authorization ?? headers?.authorization;
    if (authorization !== undefined) seen.authorization = authorization;
    const text = typeof body === "string" ? body : JSON.stringify(body);
    return new Response(text, {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

/** 健康的 `/health` 回應。 */
const HEALTHY = { status: "ok", service: "mnemoshelf", appVersion: "0.4.0" };

describe("runtimeCandidates", () => {
  it("macOS 同時給桌面版與 CLI 的路徑（大小寫不同，刻意不合併）", () => {
    const candidates = runtimeCandidates({ platform: "darwin", env: {}, home: HOME });
    expect(candidates).toContain(`${HOME}/Library/Application Support/Mnemoshelf/data/runtime.json`);
    expect(candidates).toContain(`${HOME}/Library/Application Support/mnemoshelf/runtime.json`);
  });

  it("Windows 走 APPDATA，沒有 APPDATA 時退回家目錄", () => {
    const homeWin = "C:\\Users\\synthetic-user";
    const withAppData = runtimeCandidates({
      platform: "win32",
      env: { APPDATA: "C:\\Users\\synthetic\\AppData\\Roaming" },
      home: homeWin,
    });
    expect(withAppData[0]).toBe("C:\\Users\\synthetic\\AppData\\Roaming\\Mnemoshelf\\data\\runtime.json");
    const withoutAppData = runtimeCandidates({ platform: "win32", env: {}, home: homeWin });
    expect(withoutAppData[0]).toBe("C:\\Users\\synthetic-user\\AppData\\Roaming\\Mnemoshelf\\data\\runtime.json");
  });

  it("Linux 桌面版尊重 XDG_CONFIG_HOME，CLI 走 XDG_DATA_HOME", () => {
    const candidates = runtimeCandidates({
      platform: "linux",
      env: { XDG_CONFIG_HOME: "/cfg", XDG_DATA_HOME: "/data" },
      home: HOME,
    });
    expect(candidates).toContain("/cfg/Mnemoshelf/data/runtime.json");
    expect(candidates).toContain("/data/mnemoshelf/runtime.json");
  });

  it("明確指定的 runtime 檔路徑排在最前面", () => {
    const candidates = runtimeCandidates({
      platform: "linux",
      env: { MNEMOSHELF_RUNTIME_FILE: "/explicit/runtime.json" },
      home: HOME,
    });
    expect(candidates[0]).toBe("/explicit/runtime.json");
  });

  it("明確指定的資料目錄會推出 runtime.json", () => {
    const candidates = runtimeCandidates({
      platform: "linux",
      env: { MNEMOSHELF_DATA_DIR: "/data-dir" },
      home: HOME,
    });
    expect(candidates).toContain("/data-dir/runtime.json");
  });

  it("重複的路徑只留一次", () => {
    const candidates = runtimeCandidates({
      platform: "linux",
      env: { MNEMOSHELF_RUNTIME_FILE: "/explicit/runtime.json" },
      home: HOME,
    });
    expect(new Set(candidates).size).toBe(candidates.length);
  });
});

describe("checkServiceHealth", () => {
  it("服務名稱相符時回 ok 並帶出版本", async () => {
    const result = await checkServiceHealth({
      baseUrl: "http://127.0.0.1:1234",
      fetchImpl: fakeFetch(200, HEALTHY),
    });
    expect(result).toEqual({ ok: true, appVersion: "0.4.0" });
  });

  it("服務名稱不符時判定為身分不符", async () => {
    const result = await checkServiceHealth({
      baseUrl: "http://127.0.0.1:1234",
      fetchImpl: fakeFetch(200, { status: "ok", service: "other-app" }),
    });
    expect(result).toEqual({ ok: false, reason: "wrong-service" });
  });

  it("非 2xx 是身分不符而不是暫時連不上", async () => {
    const result = await checkServiceHealth({
      baseUrl: "http://127.0.0.1:1234",
      fetchImpl: fakeFetch(500, HEALTHY),
    });
    expect(result).toEqual({ ok: false, reason: "http-error" });
  });

  it("回應不是 JSON 時判定為身分不符", async () => {
    const result = await checkServiceHealth({
      baseUrl: "http://127.0.0.1:1234",
      fetchImpl: fakeFetch(200, "<html>not json</html>"),
    });
    expect(result).toEqual({ ok: false, reason: "not-json" });
  });

  it("連不上時回 unreachable", async () => {
    const result = await checkServiceHealth({
      baseUrl: "http://127.0.0.1:1234",
      fetchImpl: (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
    });
    expect(result).toEqual({ ok: false, reason: "unreachable" });
  });

  it("身分檢查不帶 Authorization（不能先送 token）", async () => {
    const seen: { authorization?: string } = {};
    await checkServiceHealth({
      baseUrl: "http://127.0.0.1:1234",
      fetchImpl: fakeFetch(200, HEALTHY, seen),
    });
    expect(seen.authorization).toBeUndefined();
  });
});

describe("isProcessAlive", () => {
  it("Windows 沒有可靠的 signal 0，直接視為活著", () => {
    expect(isProcessAlive(123, "win32", () => undefined)).toBe(true);
  });

  it("POSIX 上 signal 0 成功即活著", () => {
    expect(isProcessAlive(123, "linux", () => undefined)).toBe(true);
  });

  it("EPERM 代表行程存在但屬於別的使用者，仍視為活著", () => {
    expect(
      isProcessAlive(123, "linux", () => {
        const error = new Error("EPERM") as NodeJS.ErrnoException;
        error.code = "EPERM";
        throw error;
      }),
    ).toBe(true);
  });

  it("其他錯誤代表行程已結束", () => {
    expect(
      isProcessAlive(123, "linux", () => {
        const error = new Error("ESRCH") as NodeJS.ErrnoException;
        error.code = "ESRCH";
        throw error;
      }),
    ).toBe(false);
  });
});

describe("resolveMcpConnection", () => {
  it("環境變數齊全時直接使用，完全不讀檔", async () => {
    const readFileImpl = readerFor({});
    const connection = await resolveMcpConnection({
      env: { MNEMOSHELF_URL: "http://127.0.0.1:1234", MNEMOSHELF_TOKEN: TOKEN },
      platform: "linux",
      home: HOME,
      readFileImpl,
    });
    expect(connection.source).toBe("env");
    expect(connection.config.url).toBe("http://127.0.0.1:1234");
    expect(connection.config.token).toBe(TOKEN);
  });

  it("環境變數缺 token 時改讀連線資訊檔，並驗過服務身分", async () => {
    const file = `${HOME}/.config/Mnemoshelf/data/runtime.json`;
    const connection = await resolveMcpConnection({
      env: {},
      platform: "linux",
      home: HOME,
      readFileImpl: readerFor({ [file]: runtimeJson() }),
      fetchImpl: fakeFetch(200, HEALTHY),
      killImpl: () => undefined,
    });
    expect(connection.source).toBe("runtime");
    expect(connection.config.url).toBe("http://127.0.0.1:53459");
    expect(connection.config.token).toBe(TOKEN);
  });

  it("連線資訊檔可帶出預設專案", async () => {
    const file = `${HOME}/.config/Mnemoshelf/data/runtime.json`;
    const connection = await resolveMcpConnection({
      env: { MNEMOSHELF_PROJECT: "my-project" },
      platform: "linux",
      home: HOME,
      readFileImpl: readerFor({ [file]: runtimeJson() }),
      fetchImpl: fakeFetch(200, HEALTHY),
      killImpl: () => undefined,
    });
    expect(connection.config.project).toBe("my-project");
  });

  it("找不到任何連線來源時回 no-config，並指出缺哪個環境變數", async () => {
    await expect(
      resolveMcpConnection({
        env: {},
        platform: "linux",
        home: HOME,
        readFileImpl: readerFor({}),
        fetchImpl: fakeFetch(200, HEALTHY),
      }),
    ).rejects.toMatchObject({ name: "McpConnectionError", reason: "no-config" });
  });

  it("明確指定 runtime 檔但檔案不存在時回 runtime-missing", async () => {
    await expect(
      resolveMcpConnection({
        env: { MNEMOSHELF_RUNTIME_FILE: "/explicit/runtime.json" },
        platform: "linux",
        home: HOME,
        readFileImpl: readerFor({}),
        fetchImpl: fakeFetch(200, HEALTHY),
      }),
    ).rejects.toMatchObject({ name: "McpConnectionError", reason: "runtime-missing" });
  });

  it("連線資訊檔格式不符時回 runtime-invalid", async () => {
    const file = `${HOME}/.config/Mnemoshelf/data/runtime.json`;
    await expect(
      resolveMcpConnection({
        env: {},
        platform: "linux",
        home: HOME,
        readFileImpl: readerFor({ [file]: JSON.stringify({ schemaVersion: 1, url: "http://x" }) }),
        fetchImpl: fakeFetch(200, HEALTHY),
        killImpl: () => undefined,
      }),
    ).rejects.toMatchObject({ name: "McpConnectionError", reason: "runtime-invalid" });
  });

  it("環境變數的網址與連線資訊檔不一致時拒絕使用（token 歸屬不明）", async () => {
    const file = `${HOME}/.config/Mnemoshelf/data/runtime.json`;
    await expect(
      resolveMcpConnection({
        env: { MNEMOSHELF_URL: "http://127.0.0.1:9999" },
        platform: "linux",
        home: HOME,
        readFileImpl: readerFor({ [file]: runtimeJson() }),
        fetchImpl: fakeFetch(200, HEALTHY),
        killImpl: () => undefined,
      }),
    ).rejects.toMatchObject({ name: "McpConnectionError", reason: "identity-mismatch" });
  });

  it("連線資訊檔所指的行程已結束時回 pid-dead，且不送任何請求", async () => {
    const file = `${HOME}/.config/Mnemoshelf/data/runtime.json`;
    let fetched = false;
    await expect(
      resolveMcpConnection({
        env: {},
        platform: "linux",
        home: HOME,
        readFileImpl: readerFor({ [file]: runtimeJson() }),
        fetchImpl: (async () => {
          fetched = true;
          return new Response("{}");
        }) as unknown as typeof fetch,
        killImpl: () => {
          const error = new Error("ESRCH") as NodeJS.ErrnoException;
          error.code = "ESRCH";
          throw error;
        },
      }),
    ).rejects.toMatchObject({ name: "McpConnectionError", reason: "pid-dead" });
    expect(fetched).toBe(false);
  });

  it("位址上的服務不是 mnemoshelf 時回 health-identity-mismatch", async () => {
    const file = `${HOME}/.config/Mnemoshelf/data/runtime.json`;
    const seen: { authorization?: string } = {};
    await expect(
      resolveMcpConnection({
        env: {},
        platform: "linux",
        home: HOME,
        readFileImpl: readerFor({ [file]: runtimeJson() }),
        fetchImpl: fakeFetch(200, { status: "ok", service: "not-mnemoshelf" }, seen),
        killImpl: () => undefined,
      }),
    ).rejects.toMatchObject({ name: "McpConnectionError", reason: "health-identity-mismatch" });
    // 身分不符時不能把 token 送出去。
    expect(seen.authorization).toBeUndefined();
  });

  it("服務連不上時回 health-unreachable", async () => {
    const file = `${HOME}/.config/Mnemoshelf/data/runtime.json`;
    await expect(
      resolveMcpConnection({
        env: {},
        platform: "linux",
        home: HOME,
        readFileImpl: readerFor({ [file]: runtimeJson() }),
        fetchImpl: (async () => {
          throw new Error("ECONNREFUSED");
        }) as unknown as typeof fetch,
        killImpl: () => undefined,
      }),
    ).rejects.toMatchObject({ name: "McpConnectionError", reason: "health-unreachable" });
  });

  it("錯誤訊息不含 token 內容", async () => {
    const file = `${HOME}/.config/Mnemoshelf/data/runtime.json`;
    const error = await resolveMcpConnection({
      env: {},
      platform: "linux",
      home: HOME,
      readFileImpl: readerFor({ [file]: runtimeJson() }),
      fetchImpl: fakeFetch(200, { service: "other" }),
      killImpl: () => undefined,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(McpConnectionError);
    expect(String((error as Error).message)).not.toContain(TOKEN);
  });
});

describe("HealthCheckResult", () => {
  it("型別可用於分支判斷（編譯期檢查）", () => {
    const result: HealthCheckResult = { ok: true, appVersion: null };
    expect(result.ok).toBe(true);
  });
});

describe("MCP 入口透過連線資訊檔啟動（端到端）", () => {
  it("不給 MNEMOSHELF_URL／TOKEN，只給連線資訊檔 → 真的連上並可寫入記憶", async () => {
    const rest = await startTestServer();
    const dir = await makeTempDir("mnemoshelf-runtime-");
    const runtimeFile = path.join(dir, "runtime.json");
    await fs.writeFile(
      runtimeFile,
      JSON.stringify({
        schemaVersion: 1,
        url: rest.instance.url,
        token: TEST_TOKEN,
        pid: process.pid,
        startedAt: new Date().toISOString(),
        appVersion: "0.4.0",
      }),
      "utf8",
    );

    const clientToServer = new PassThrough();
    const serverToClient = new PassThrough();
    const started = await runStdio({
      // 只有連線資訊檔位置，沒有網址與 token。
      env: { MNEMOSHELF_RUNTIME_FILE: runtimeFile },
      stdin: clientToServer,
      stdout: serverToClient,
    });

    const client = new Client({ name: "runtime-file-client", version: "0.0.0" });
    await client.connect(new StdioServerTransport(serverToClient, clientToServer));

    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
        "forget",
        "list_roots",
        "recall",
        "remember",
        "search",
        "search_memories",
      ]);

      const written = await client.callTool({
        name: "remember",
        arguments: { content: "[串接測試] 由連線資訊檔啟動的 MCP 入口寫入的記憶" },
      });
      const text = (written.content as { type?: string; text?: string }[])[0]?.text ?? "";
      expect(text).toContain("串接測試");

      // 連線來自連線資訊檔，不是環境變數。
      expect(started.config.url).toBe(rest.instance.url);
    } finally {
      await client.close();
      await started.server.close();
      await rest.close();
      await removeTempDir(dir);
    }
  });
});
