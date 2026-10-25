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
  describeMcpConnectionFailure,
  isProcessAlive,
  McpConnectionError,
  resolveMcpConnection,
  runStdio,
  runtimeCandidates,
  type McpConnectionFailureReason,
} from "../src/index.js";
import { MCP_CONNECTION_FAILURE_MESSAGES } from "../src/mcp/runtime-connection.js";
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

/** 假的讀檔：只認得指定路徑，其餘一律當不存在；另外記錄每次嘗試的路徑。 */
function trackingReader(files: Record<string, string>): {
  readFileImpl: (file: string) => Promise<string>;
  reads: string[];
} {
  const reads: string[] = [];
  const readFileImpl = async (file: string): Promise<string> => {
    reads.push(file);
    const content = files[file];
    if (content === undefined) {
      const error = new Error("ENOENT") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    }
    return content;
  };
  return { readFileImpl, reads };
}

/** 健康的 `/health` 回應。 */
const HEALTHY = { status: "ok", service: "mnemoshelf", appVersion: "0.4.0" };

/** 假的 fetch：一律回健康的 `/health`，並記錄呼叫次數。 */
function countingFetch(counter: { calls: number }): typeof fetch {
  return (async () => {
    counter.calls += 1;
    return new Response(JSON.stringify(HEALTHY), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

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

  it("Linux 桌面版尊重 XDG_CONFIG_HOME，且同時保留 ~/.config；CLI 同理（XDG 在前）", () => {
    const candidates = runtimeCandidates({
      platform: "linux",
      env: { XDG_CONFIG_HOME: "/cfg", XDG_DATA_HOME: "/data" },
      home: HOME,
    });
    expect(candidates).toEqual([
      "/cfg/Mnemoshelf/data/runtime.json",
      // GUI 行程不一定繼承 shell rc 的 XDG 設定 → `~/.config` 也要留著，順序在 XDG 之後。
      `${HOME}/.config/Mnemoshelf/data/runtime.json`,
      "/data/mnemoshelf/runtime.json",
      `${HOME}/.local/share/mnemoshelf/runtime.json`,
    ]);
    expect(new Set(candidates).size).toBe(candidates.length);
  });

  it("Linux 未設 XDG 時候選去重後只剩桌面與 CLI 各一個", () => {
    const candidates = runtimeCandidates({ platform: "linux", env: {}, home: HOME });
    expect(candidates).toEqual([
      `${HOME}/.config/Mnemoshelf/data/runtime.json`,
      `${HOME}/.local/share/mnemoshelf/runtime.json`,
    ]);
  });

  it("明確指定 runtime 檔時只剩那一個路徑（不再接平台預設路徑）", () => {
    const candidates = runtimeCandidates({
      platform: "linux",
      env: { MNEMOSHELF_RUNTIME_FILE: "/explicit/runtime.json" },
      home: HOME,
    });
    expect(candidates).toEqual(["/explicit/runtime.json"]);
  });

  it("只指定資料目錄時只剩該目錄下的 runtime.json", () => {
    const candidates = runtimeCandidates({
      platform: "linux",
      env: { MNEMOSHELF_DATA_DIR: "/data-dir" },
      home: HOME,
    });
    expect(candidates).toEqual(["/data-dir/runtime.json"]);
  });

  it("檔案位置優先於資料目錄（兩者都給時只用檔案位置）", () => {
    const candidates = runtimeCandidates({
      platform: "linux",
      env: { MNEMOSHELF_RUNTIME_FILE: "/explicit/runtime.json", MNEMOSHELF_DATA_DIR: "/data-dir" },
      home: HOME,
    });
    expect(candidates).toEqual(["/explicit/runtime.json"]);
  });

  it("兩者都沒設時仍走平台預設候選（不被新規則清空）", () => {
    const candidates = runtimeCandidates({ platform: "linux", env: {}, home: HOME });
    expect(candidates).toContain(`${HOME}/.config/Mnemoshelf/data/runtime.json`);
    expect(candidates).toContain(`${HOME}/.local/share/mnemoshelf/runtime.json`);
    expect(candidates.length).toBeGreaterThanOrEqual(2);
  });

  it("明確指定時仍是去重後的單一候選", () => {
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

  it("JSON null 視為身分不符（不是拋 TypeError 被誤判成連不上）", async () => {
    const result = await checkServiceHealth({
      baseUrl: "http://127.0.0.1:1234",
      fetchImpl: fakeFetch(200, "null"),
    });
    expect(result).toEqual({ ok: false, reason: "wrong-service" });
  });

  it("回應是陣列或字串時也視為身分不符", async () => {
    for (const body of ["[]", '"mnemoshelf"', "42"]) {
      const result = await checkServiceHealth({
        baseUrl: "http://127.0.0.1:1234",
        fetchImpl: fakeFetch(200, body),
      });
      expect(result).toEqual({ ok: false, reason: "wrong-service" });
    }
  });

  it("超過期限沒有回應時回 timeout", async () => {
    const result = await checkServiceHealth({
      baseUrl: "http://127.0.0.1:1234",
      timeoutMs: 5,
      fetchImpl: ((_input: string | URL | Request, init?: RequestInit) => {
        // 模擬「有發出請求但一直不回應」：等到 signal abort 才拒絕。
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        });
      }) as unknown as typeof fetch,
    });
    expect(result).toEqual({ ok: false, reason: "timeout" });
  });

  it("健康檢查的請求帶 redirect: \"error\"（不讓 /health 被導到別處）", async () => {
    const seen: { redirect?: string; url?: string } = {};
    await checkServiceHealth({
      baseUrl: "http://127.0.0.1:1234",
      fetchImpl: ((input: string | URL | Request, init?: RequestInit) => {
        seen.url = String(input);
        seen.redirect = init?.redirect;
        return Promise.resolve(
          new Response(JSON.stringify(HEALTHY), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      }) as unknown as typeof fetch,
    });
    expect(seen.url).toBe("http://127.0.0.1:1234/health");
    expect(seen.redirect).toBe("error");
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

  it("明確指定的檔案不存在時只讀那一個路徑，不退回平台預設路徑、也不送請求", async () => {
    const explicit = "/explicit/runtime.json";
    const desktopDefault = `${HOME}/.config/Mnemoshelf/data/runtime.json`;
    // 平台預設位置「有」一份可用檔案：舊行為會默默改用它，新行為不得如此。
    const { readFileImpl, reads } = trackingReader({ [desktopDefault]: runtimeJson() });
    const counter = { calls: 0 };

    await expect(
      resolveMcpConnection({
        env: { MNEMOSHELF_RUNTIME_FILE: explicit },
        platform: "linux",
        home: HOME,
        readFileImpl,
        fetchImpl: countingFetch(counter),
        killImpl: () => undefined,
      }),
    ).rejects.toMatchObject({ name: "McpConnectionError", reason: "runtime-missing" });

    expect(reads).toEqual([explicit]);
    expect(counter.calls).toBe(0);
  });

  it("明確指定的檔案存在時直接使用它（來源 runtime）", async () => {
    const explicit = "/explicit/runtime.json";
    const connection = await resolveMcpConnection({
      env: { MNEMOSHELF_RUNTIME_FILE: explicit },
      platform: "linux",
      home: HOME,
      readFileImpl: readerFor({ [explicit]: runtimeJson({ url: "http://127.0.0.1:54321" }) }),
      fetchImpl: fakeFetch(200, HEALTHY),
      killImpl: () => undefined,
    });
    expect(connection.source).toBe("runtime");
    expect(connection.config.url).toBe("http://127.0.0.1:54321");
    expect(connection.config.token).toBe(TOKEN);
  });

  it("明確指定的檔案內容不合法時回 runtime-invalid，且不退回平台預設路徑", async () => {
    const explicit = "/explicit/runtime.json";
    const desktopDefault = `${HOME}/.config/Mnemoshelf/data/runtime.json`;
    const { readFileImpl, reads } = trackingReader({
      [explicit]: JSON.stringify({ schemaVersion: 1, url: "http://127.0.0.1:53459" }),
      [desktopDefault]: runtimeJson(),
    });
    const counter = { calls: 0 };

    await expect(
      resolveMcpConnection({
        env: { MNEMOSHELF_RUNTIME_FILE: explicit },
        platform: "linux",
        home: HOME,
        readFileImpl,
        fetchImpl: countingFetch(counter),
        killImpl: () => undefined,
      }),
    ).rejects.toMatchObject({ name: "McpConnectionError", reason: "runtime-invalid" });

    expect(reads).toEqual([explicit]);
    expect(counter.calls).toBe(0);
  });

  it("只設 MNEMOSHELF_DATA_DIR 時使用該目錄下的 runtime.json", async () => {
    const connection = await resolveMcpConnection({
      env: { MNEMOSHELF_DATA_DIR: "/data-dir" },
      platform: "linux",
      home: HOME,
      readFileImpl: readerFor({ "/data-dir/runtime.json": runtimeJson() }),
      fetchImpl: fakeFetch(200, HEALTHY),
      killImpl: () => undefined,
    });
    expect(connection.source).toBe("runtime");
    expect(connection.config.url).toBe("http://127.0.0.1:53459");
  });

  it("只設 MNEMOSHELF_DATA_DIR 而該目錄沒有檔案時回 runtime-missing，且不試平台預設路徑", async () => {
    const desktopDefault = `${HOME}/.config/Mnemoshelf/data/runtime.json`;
    const { readFileImpl, reads } = trackingReader({ [desktopDefault]: runtimeJson() });
    const counter = { calls: 0 };

    await expect(
      resolveMcpConnection({
        env: { MNEMOSHELF_DATA_DIR: "/data-dir" },
        platform: "linux",
        home: HOME,
        readFileImpl,
        fetchImpl: countingFetch(counter),
        killImpl: () => undefined,
      }),
    ).rejects.toMatchObject({ name: "McpConnectionError", reason: "runtime-missing" });

    expect(reads).toEqual(["/data-dir/runtime.json"]);
    expect(counter.calls).toBe(0);
  });

  it("完全沒有指定時仍會找到平台預設位置的檔案（既有行為不回歸）", async () => {
    const desktopDefault = `${HOME}/.config/Mnemoshelf/data/runtime.json`;
    const connection = await resolveMcpConnection({
      env: {},
      platform: "linux",
      home: HOME,
      readFileImpl: readerFor({ [desktopDefault]: runtimeJson() }),
      fetchImpl: fakeFetch(200, HEALTHY),
      killImpl: () => undefined,
    });
    expect(connection.source).toBe("runtime");
    expect(connection.config.url).toBe("http://127.0.0.1:53459");
  });

  it("XDG_CONFIG_HOME 只設在 shell rc、桌面版卻寫在 ~/.config 時仍然連得上", async () => {
    const homeDesktop = `${HOME}/.config/Mnemoshelf/data/runtime.json`;
    const { readFileImpl, reads } = trackingReader({ [homeDesktop]: runtimeJson() });
    const connection = await resolveMcpConnection({
      env: { XDG_CONFIG_HOME: "/cfg" },
      platform: "linux",
      home: HOME,
      readFileImpl,
      fetchImpl: fakeFetch(200, HEALTHY),
      killImpl: () => undefined,
    });
    expect(connection.source).toBe("runtime");
    // 先試 XDG 位置（不存在），再試 ~/.config（找到）。
    expect(reads).toEqual(["/cfg/Mnemoshelf/data/runtime.json", homeDesktop]);
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

  it("缺 appVersion 也是 runtime-invalid，訊息列舉全部必要欄位", async () => {
    const file = `${HOME}/.config/Mnemoshelf/data/runtime.json`;
    const { appVersion: _omitted, ...withoutVersion } = JSON.parse(runtimeJson()) as Record<string, unknown>;
    const error = await resolveMcpConnection({
      env: {},
      platform: "linux",
      home: HOME,
      readFileImpl: readerFor({ [file]: JSON.stringify(withoutVersion) }),
      fetchImpl: fakeFetch(200, HEALTHY),
      killImpl: () => undefined,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(McpConnectionError);
    expect((error as McpConnectionError).reason).toBe("runtime-invalid");
    const message = String((error as Error).message);
    for (const field of ["schemaVersion", "url", "token", "pid", "startedAt", "appVersion"]) {
      expect(message).toContain(field);
    }
    expect(message).not.toContain(TOKEN);
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

describe("resolveMcpConnection：只接受 loopback 網址（B1）", () => {
  const file = `${HOME}/.config/Mnemoshelf/data/runtime.json`;

  /** 解析連線；回傳錯誤（成功時丟測試失敗）。 */
  async function resolveWith(url: string, seen: { requests: string[] }): Promise<unknown> {
    return resolveMcpConnection({
      env: {},
      platform: "linux",
      home: HOME,
      readFileImpl: readerFor({ [file]: runtimeJson({ url }) }),
      fetchImpl: (async (input: string | URL | Request) => {
        seen.requests.push(String(input));
        return new Response(JSON.stringify(HEALTHY), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch,
      killImpl: () => undefined,
    }).catch((caught: unknown) => caught);
  }

  it("127.0.0.1 與 localhost（大小寫不拘）可通過", async () => {
    for (const url of ["http://127.0.0.1:53459", "http://localhost:53459", "http://LOCALHOST:53459"]) {
      const seen = { requests: [] as string[] };
      const connection = await resolveWith(url, seen);
      expect(connection).not.toBeInstanceOf(McpConnectionError);
      expect((connection as { source: string }).source).toBe("runtime");
      // 通過的網址才會打 /health。
      expect(seen.requests).toHaveLength(1);
      expect(seen.requests[0]).toBe(`${url}/health`);
    }
  });

  it("尾端斜線會先正規化，仍可通過", async () => {
    const seen = { requests: [] as string[] };
    const connection = await resolveWith("http://127.0.0.1:53459///", seen);
    expect(connection).not.toBeInstanceOf(McpConnectionError);
    expect((connection as { config: { url: string } }).config.url).toBe("http://127.0.0.1:53459");
    expect(seen.requests).toEqual(["http://127.0.0.1:53459/health"]);
  });

  it("數字形式的 IPv4 被 URL 正規化成 127.0.0.1 後可通過", async () => {
    for (const host of ["2130706433", "0x7f000001", "0177.0.0.1", "127.1"]) {
      const seen = { requests: [] as string[] };
      const connection = await resolveWith(`http://${host}:53459`, seen);
      expect(connection).not.toBeInstanceOf(McpConnectionError);
      expect((connection as { config: { url: string } }).config.url).toBe(`http://${host}:53459`);
      expect(seen.requests).toHaveLength(1);
    }
  });

  it("非 loopback 網址回 url-not-loopback，且一個請求都不送", async () => {
    for (const url of ["http://192.168.1.9:53459", "http://example.test:53459", "http://0.0.0.0:53459"]) {
      const seen = { requests: [] as string[] };
      const error = await resolveWith(url, seen);
      expect(error).toBeInstanceOf(McpConnectionError);
      expect((error as McpConnectionError).reason).toBe("url-not-loopback");
      // 連不帶 token 的 /health 都不送：不能把任何請求帶離本機。
      expect(seen.requests).toHaveLength(0);
      // 錯誤訊息不得含 token。
      expect(String((error as Error).message)).not.toContain(TOKEN);
    }
  });

  it("看起來像 loopback 但不在契約內的主機一律拒絕", async () => {
    // `[::1]`：服務只綁 127.0.0.1；`localhost.` 是 FQDN 形式，與字面契約不同；
    // `127.0.0.1.evil.test` 是另一個主機（不能被前綴比對騙過）。
    for (const url of ["http://[::1]:53459", "http://localhost.:53459", "http://127.0.0.1.evil.test:53459"]) {
      const seen = { requests: [] as string[] };
      const error = await resolveWith(url, seen);
      expect((error as McpConnectionError).reason).toBe("url-not-loopback");
      expect(seen.requests).toHaveLength(0);
    }
  });

  it("含帳密、查詢字串或片段的網址不是單純的基底網址，一律拒絕", async () => {
    for (const url of [
      "http://user@127.0.0.1:53459",
      "http://127.0.0.1:53459/?a=1",
      "http://127.0.0.1:53459/#frag",
    ]) {
      const seen = { requests: [] as string[] };
      const error = await resolveWith(url, seen);
      expect((error as McpConnectionError).reason).toBe("url-not-loopback");
      expect(seen.requests).toHaveLength(0);
    }
  });

  it("file:// 即使主機是 127.0.0.1 也不是 http(s) loopback，拒絕且不送請求", async () => {
    const seen = { requests: [] as string[] };
    const error = await resolveWith("file://127.0.0.1/tmp/runtime.json", seen);
    expect((error as McpConnectionError).reason).toBe("url-not-loopback");
    expect(seen.requests).toHaveLength(0);
  });

  it("無法解析成網址時同樣拒絕，且不送任何請求", async () => {
    const seen = { requests: [] as string[] };
    const error = await resolveWith("not-a-url", seen);
    expect((error as McpConnectionError).reason).toBe("url-not-loopback");
    expect(seen.requests).toHaveLength(0);
  });
});

describe("describeMcpConnectionFailure", () => {
  /**
   * 所有失敗代碼直接取自 `MCP_CONNECTION_FAILURE_MESSAGES` 的 key。
   *
   * 原始碼用 `Record<McpConnectionFailureReason, string>` 宣告文案表：新增失敗代碼時
   * 少寫一句文案就編譯不過；這裡再遍歷同一份表，避免測試清單與程式碼各自漂移。
   */
  const ALL_REASONS = Object.keys(MCP_CONNECTION_FAILURE_MESSAGES) as McpConnectionFailureReason[];

  // 編譯期窮盡檢查：union 若有代碼不在文案表的 key 裡，`MissingReason` 就不是 `never`，
  // 這一行會編譯失敗（比執行期的字串比對更早擋下）。
  type MissingReason = Exclude<McpConnectionFailureReason, keyof typeof MCP_CONNECTION_FAILURE_MESSAGES>;
  const assertEveryReasonHasMessage: MissingReason extends never ? true : never = true;
  void assertEveryReasonHasMessage;

  it("文案表包含目前所有失敗代碼（新增代碼會由 typecheck 擋下）", () => {
    // 若 union 新增代碼而文案表沒補，`Record<...>` 會先讓 typecheck 失敗；
    // 這裡再確認測試真的拿到每個代碼。
    expect(ALL_REASONS).toContain("no-config");
    expect(ALL_REASONS).toContain("health-identity-mismatch");
    expect(new Set(ALL_REASONS).size).toBe(ALL_REASONS.length);
  });

  it("每個失敗代碼都有專屬文案（不是通用的 fallback）", () => {
    const messages = ALL_REASONS.map((reason) => describeMcpConnectionFailure(reason));
    for (const message of messages) {
      expect(message.length).toBeGreaterThan(0);
      expect(message).not.toBe("無法解析 MCP 連線設定");
    }
    // 每個代碼的文案都不同：使用者／文件可以據此對照。
    expect(new Set(messages).size).toBe(ALL_REASONS.length);
  });

  it("文案不含 token，也不含本機家目錄路徑", () => {
    for (const reason of ALL_REASONS) {
      const message = describeMcpConnectionFailure(reason);
      expect(message).not.toContain(TOKEN);
      expect(message).not.toContain(HOME);
    }
  });
});

describe("checkServiceHealth：分類（真的呼叫函式，不靠型別宣告）", () => {
  it("JSON null、非 JSON 與逾時各自分類，且都不會被當成 ok", async () => {
    const nullResult = await checkServiceHealth({
      baseUrl: "http://127.0.0.1:1234",
      fetchImpl: fakeFetch(200, "null"),
    });
    expect(nullResult).toEqual({ ok: false, reason: "wrong-service" });

    const notJson = await checkServiceHealth({
      baseUrl: "http://127.0.0.1:1234",
      fetchImpl: fakeFetch(200, "<html>not json</html>"),
    });
    expect(notJson).toEqual({ ok: false, reason: "not-json" });

    const timeout = await checkServiceHealth({
      baseUrl: "http://127.0.0.1:1234",
      timeoutMs: 5,
      fetchImpl: ((_input: string | URL | Request, init?: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        });
      }) as unknown as typeof fetch,
    });
    expect(timeout).toEqual({ ok: false, reason: "timeout" });
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
