import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_SETTINGS,
  checkHealth,
  describeConnectionFailure,
  isProcessAlive,
  normalizeBaseUrl,
  parseRuntimeFile,
  readSettings,
  resolveConnection,
  runtimeCandidates,
  type ConnectionFailureReason,
} from "../src/config.js";
import type { RuntimeFileRecord } from "../src/types.js";

const tempDirs: string[] = [];

async function makeRuntimeFile(record: Partial<RuntimeFileRecord> = {}): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mnemoshelf-plugin-"));
  tempDirs.push(dir);
  const file = path.join(dir, "runtime.json");
  const payload: RuntimeFileRecord = {
    schemaVersion: 1,
    url: "http://127.0.0.1:43117",
    token: "runtime-token",
    pid: 4321,
    startedAt: "2026-10-21T00:00:00.000Z",
    appVersion: "9.9.9",
    ...record,
  };
  await fs.writeFile(file, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
  return file;
}

function healthResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("readSettings", () => {
  it("預設值", () => {
    expect(readSettings(undefined)).toEqual(DEFAULT_SETTINGS);
  });

  it("非法值回退並夾在範圍內", () => {
    const settings = readSettings({
      trigger: "sometimes",
      kMax: 999,
      maxItems: 0,
      minScore: 5,
      timeoutMs: 10,
      softChars: 5000,
      hardChars: 10,
      dedupeTTL: 99,
    });
    expect(settings.trigger).toBe("first-turn+explicit");
    expect(settings.kMax).toBe(20);
    expect(settings.maxItems).toBe(1);
    expect(settings.minScore).toBe(1);
    expect(settings.timeoutMs).toBe(100);
    expect(settings.softChars).toBe(2000);
    expect(settings.hardChars).toBeGreaterThanOrEqual(settings.softChars);
    expect(settings.dedupeTTL).toBe(10);
  });

  it("接受 every-turn 與字串數字", () => {
    const settings = readSettings({ trigger: "every-turn", kMax: "6", minScore: "0.55" });
    expect(settings.trigger).toBe("every-turn");
    expect(settings.kMax).toBe(6);
    expect(settings.minScore).toBe(0.55);
  });
});

describe("runtimeCandidates", () => {
  it("Linux：桌面版多一層 data，CLI 在 XDG 資料目錄", () => {
    const home = path.join(path.sep, "work", "userdata");
    const candidates = runtimeCandidates({
      platform: "linux",
      env: { XDG_DATA_HOME: path.join(home, "xdg") },
      home,
    });
    expect(candidates).toContain(path.join(home, ".config", "Mnemoshelf", "data", "runtime.json"));
    expect(candidates).toContain(path.join(home, "xdg", "mnemoshelf", "runtime.json"));
  });

  it("Linux 未設 XDG 時用 ~/.local/share", () => {
    const home = path.join(path.sep, "work", "userdata");
    const candidates = runtimeCandidates({ platform: "linux", env: {}, home });
    expect(candidates).toContain(path.join(home, ".local", "share", "mnemoshelf", "runtime.json"));
  });

  it("macOS：桌面版與 CLI 路徑不同", () => {
    const home = path.join(path.sep, "work", "userdata");
    const candidates = runtimeCandidates({ platform: "darwin", env: {}, home });
    expect(candidates).toContain(
      path.join(home, "Library", "Application Support", "Mnemoshelf", "data", "runtime.json"),
    );
    expect(candidates).toContain(
      path.join(home, "Library", "Application Support", "mnemoshelf", "runtime.json"),
    );
  });

  it("Windows：用 APPDATA", () => {
    const home = "C:\\work\\userdata";
    const appData = "C:\\work\\userdata\\AppData\\Roaming";
    const candidates = runtimeCandidates({ platform: "win32", env: { APPDATA: appData }, home });
    expect(candidates).toContain(path.win32.join(appData, "Mnemoshelf", "data", "runtime.json"));
    expect(candidates).toContain(path.win32.join(appData, "mnemoshelf", "runtime.json"));
  });

  it("明確路徑排最前且去重", () => {
    const home = path.join(path.sep, "work", "userdata");
    const custom = path.join(home, "custom.json");
    const candidates = runtimeCandidates({
      platform: "linux",
      env: { MNEMOSHELF_RUNTIME_FILE: custom },
      home,
      runtimeFile: custom,
    });
    expect(candidates[0]).toBe(custom);
    expect(candidates.filter((item) => item === custom)).toHaveLength(1);
  });
});

describe("parseRuntimeFile", () => {
  it("接受合法內容並保留欄位", () => {
    const record = parseRuntimeFile(
      JSON.stringify({ schemaVersion: 1, url: "http://127.0.0.1:1", token: "t", pid: 9 }),
    );
    expect(record?.pid).toBe(9);
  });

  it("拒絕格式不符", () => {
    expect(parseRuntimeFile("not json")).toBeNull();
    expect(parseRuntimeFile(JSON.stringify({ schemaVersion: 2, url: "u", token: "t", pid: 1 }))).toBeNull();
    expect(
      parseRuntimeFile(JSON.stringify({ schemaVersion: 1, url: "u", token: "", pid: 1 })),
    ).toBeNull();
    expect(
      parseRuntimeFile(JSON.stringify({ schemaVersion: 1, url: "u", token: "t", pid: 1.5 })),
    ).toBeNull();
  });
});

describe("resolveConnection", () => {
  it("options 優先於 env 與 runtime", async () => {
    const runtimeFile = await makeRuntimeFile();
    const resolution = await resolveConnection({
      options: { baseUrl: "http://127.0.0.1:1", token: "option-token" },
      env: {
        MNEMOSHELF_URL: "http://127.0.0.1:2",
        MNEMOSHELF_TOKEN: "env-token",
        MNEMOSHELF_RUNTIME_FILE: runtimeFile,
      },
      platform: "linux",
      fetchImpl: async () => {
        throw new Error("options 來源不該打 /health");
      },
    });
    expect(resolution.connection?.source).toBe("options");
    expect(resolution.connection?.baseUrl).toBe("http://127.0.0.1:1");
  });

  it("env 優先於 runtime，且不打 /health", async () => {
    const runtimeFile = await makeRuntimeFile();
    let called = 0;
    const resolution = await resolveConnection({
      options: {},
      env: {
        MNEMOSHELF_URL: "http://127.0.0.1:2",
        MNEMOSHELF_TOKEN: "env-token",
        MNEMOSHELF_RUNTIME_FILE: runtimeFile,
      },
      platform: "linux",
      fetchImpl: async () => {
        called += 1;
        return healthResponse({ service: "mnemoshelf" });
      },
    });
    expect(resolution.connection?.source).toBe("env");
    expect(called).toBe(0);
  });

  it("runtime 檔要通過 health 與 pid 才可用", async () => {
    const runtimeFile = await makeRuntimeFile();
    const resolution = await resolveConnection({
      options: {},
      env: { MNEMOSHELF_RUNTIME_FILE: runtimeFile },
      platform: "linux",
      fetchImpl: async (url) => {
        expect(String(url)).toBe("http://127.0.0.1:43117/health");
        return healthResponse({ status: "ok", service: "mnemoshelf", appVersion: "0.3.0" });
      },
      killImpl: () => undefined,
    });
    expect(resolution.connection).toMatchObject({
      source: "runtime",
      baseUrl: "http://127.0.0.1:43117",
      appVersion: "0.3.0",
    });
  });

  it("service 不是 mnemoshelf 時視同未連線（確定性身分失敗）", async () => {
    const runtimeFile = await makeRuntimeFile();
    const resolution = await resolveConnection({
      options: {},
      env: { MNEMOSHELF_RUNTIME_FILE: runtimeFile },
      platform: "linux",
      fetchImpl: async () => healthResponse({ service: "something-else" }),
      killImpl: () => undefined,
    });
    expect(resolution.connection).toBeNull();
    expect(resolution.reason).toBe("health-identity-mismatch");
  });

  it("health 回應不是 JSON／非 2xx 也是確定性身分失敗", async () => {
    const runtimeFile = await makeRuntimeFile();
    const resolveWith = (fetchImpl: typeof fetch) =>
      resolveConnection({
        options: {},
        env: { MNEMOSHELF_RUNTIME_FILE: runtimeFile },
        platform: "linux",
        fetchImpl,
        killImpl: () => undefined,
      });

    const notJson = await resolveWith(
      async () => new Response("<html>ok</html>", { status: 200, headers: { "content-type": "text/html" } }),
    );
    expect(notJson.connection).toBeNull();
    expect(notJson.reason).toBe("health-identity-mismatch");

    const httpError = await resolveWith(async () => healthResponse({ error: "boom" }, 500));
    expect(httpError.connection).toBeNull();
    expect(httpError.reason).toBe("health-identity-mismatch");
  });

  it("pid 死亡時不送 token、也不打 health", async () => {
    const runtimeFile = await makeRuntimeFile();
    let called = 0;
    const resolution = await resolveConnection({
      options: {},
      env: { MNEMOSHELF_RUNTIME_FILE: runtimeFile },
      platform: "linux",
      fetchImpl: async () => {
        called += 1;
        return healthResponse({ service: "mnemoshelf" });
      },
      killImpl: () => {
        throw Object.assign(new Error("gone"), { code: "ESRCH" });
      },
    });
    expect(resolution.reason).toBe("pid-dead");
    expect(called).toBe(0);
  });

  it("Windows 略過 pid 檢查", async () => {
    const runtimeFile = await makeRuntimeFile();
    const resolution = await resolveConnection({
      options: {},
      env: { MNEMOSHELF_RUNTIME_FILE: runtimeFile },
      platform: "win32",
      fetchImpl: async () => healthResponse({ service: "mnemoshelf" }),
      killImpl: () => {
        throw Object.assign(new Error("gone"), { code: "ESRCH" });
      },
    });
    expect(resolution.connection?.source).toBe("runtime");
  });

  it("options URL 與 runtime token 不同源時拒絕", async () => {
    const runtimeFile = await makeRuntimeFile();
    const resolution = await resolveConnection({
      options: { baseUrl: "http://127.0.0.1:9999" },
      env: { MNEMOSHELF_RUNTIME_FILE: runtimeFile },
      platform: "linux",
      fetchImpl: async () => healthResponse({ service: "mnemoshelf" }),
      killImpl: () => undefined,
    });
    expect(resolution.reason).toBe("identity-mismatch");
  });

  it("檔案不存在且沒有任何設定時回 no-config", async () => {
    const home = path.join(os.tmpdir(), "mnemoshelf-plugin-nohome");
    const resolution = await resolveConnection({
      options: {},
      env: {},
      platform: "linux",
      home,
      readFileImpl: async () => {
        throw new Error("ENOENT");
      },
    });
    expect(resolution.connection).toBeNull();
    expect(resolution.reason).toBe("no-config");
  });

  it("明確指定的檔案讀不到時回 runtime-missing", async () => {
    const resolution = await resolveConnection({
      options: {},
      env: { MNEMOSHELF_RUNTIME_FILE: path.join(os.tmpdir(), "missing-runtime.json") },
      platform: "linux",
      readFileImpl: async () => {
        throw new Error("ENOENT");
      },
    });
    expect(resolution.reason).toBe("runtime-missing");
  });

  it("health 逾時會回 health-timeout", async () => {
    const runtimeFile = await makeRuntimeFile();
    const resolution = await resolveConnection({
      options: {},
      env: { MNEMOSHELF_RUNTIME_FILE: runtimeFile },
      platform: "linux",
      healthTimeoutMs: 20,
      fetchImpl: (url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          );
        }),
      killImpl: () => undefined,
    });
    expect(resolution.reason).toBe("health-timeout");
  });
});

describe("checkHealth", () => {
  it("回傳 appVersion", async () => {
    const result = await checkHealth({
      baseUrl: "http://127.0.0.1:1",
      fetchImpl: async () => healthResponse({ service: "mnemoshelf", appVersion: "1.2.3" }),
    });
    expect(result).toEqual({ ok: true, info: { service: "mnemoshelf", appVersion: "1.2.3" } });
  });

  it("非 2xx 回 http-error（不是暫時連不上）", async () => {
    const result = await checkHealth({
      baseUrl: "http://127.0.0.1:1",
      fetchImpl: async () => healthResponse({ error: "boom" }, 503),
    });
    expect(result).toEqual({ ok: false, reason: "http-error" });
  });

  it("非 JSON 回 not-json", async () => {
    const result = await checkHealth({
      baseUrl: "http://127.0.0.1:1",
      fetchImpl: async () => new Response("<html>ok</html>", { status: 200 }),
    });
    expect(result).toEqual({ ok: false, reason: "not-json" });
  });
});

describe("describeConnectionFailure", () => {
  it("九種原因各有明確說明，且都不說「已連線」", () => {
    const reasons: ConnectionFailureReason[] = [
      "no-config",
      "runtime-missing",
      "runtime-invalid",
      "url-invalid",
      "identity-mismatch",
      "pid-dead",
      "health-timeout",
      "health-unreachable",
      "health-identity-mismatch",
    ];
    const messages = reasons.map((reason) => describeConnectionFailure(reason));
    expect(new Set(messages).size).toBe(reasons.length);
    for (const message of messages) {
      expect(message).not.toBe("");
      expect(message).not.toContain("已連線");
    }
    expect(describeConnectionFailure("runtime-missing")).toContain("runtime 檔");
    expect(describeConnectionFailure("pid-dead")).toContain("pid");
    // 身分失敗必須明講「不送 token」（全權 token 不能給別的程式）。
    expect(describeConnectionFailure("health-identity-mismatch")).toContain("不送 token");
  });

  it("null（還沒有解析結果）回「尚未檢查連線」，不是「已連線」", () => {
    const message = describeConnectionFailure(null);
    expect(message).toContain("尚未檢查連線");
    expect(message).not.toContain("已連線");
  });
});

describe("normalizeBaseUrl", () => {
  it("接受 http／https，去掉結尾斜線", () => {
    expect(normalizeBaseUrl("http://127.0.0.1:43117")).toBe("http://127.0.0.1:43117");
    expect(normalizeBaseUrl("http://127.0.0.1:43117/")).toBe("http://127.0.0.1:43117");
    expect(normalizeBaseUrl("https://example.com/prefix///")).toBe("https://example.com/prefix");
    expect(normalizeBaseUrl("  http://127.0.0.1:1  ")).toBe("http://127.0.0.1:1");
  });

  it("拒絕非 http(s)、空字串與無效 URL", () => {
    expect(normalizeBaseUrl("ftp://example.com")).toBeUndefined();
    expect(normalizeBaseUrl("file:///tmp/x")).toBeUndefined();
    expect(normalizeBaseUrl("")).toBeUndefined();
    expect(normalizeBaseUrl("   ")).toBeUndefined();
    expect(normalizeBaseUrl(undefined)).toBeUndefined();
    expect(normalizeBaseUrl("not a url")).toBeUndefined();
    expect(normalizeBaseUrl("127.0.0.1:43117")).toBeUndefined();
  });
});

describe("isProcessAlive", () => {
  it("目前行程的 pid 視為存活", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it("ESRCH 視為不存在；EPERM 視為存活（不是自己的行程但仍活著）", () => {
    const esrch = (): never => {
      throw Object.assign(new Error("gone"), { code: "ESRCH" });
    };
    const eperm = (): never => {
      throw Object.assign(new Error("not permitted"), { code: "EPERM" });
    };
    expect(isProcessAlive(1234, "linux", esrch)).toBe(false);
    expect(isProcessAlive(1234, "linux", eperm)).toBe(true);
  });

  it("Windows 沒有可靠的 signal 0，直接視為存活", () => {
    expect(
      isProcessAlive(1234, "win32", () => {
        throw Object.assign(new Error("gone"), { code: "ESRCH" });
      }),
    ).toBe(true);
  });
});
