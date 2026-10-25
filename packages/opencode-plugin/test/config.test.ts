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
  parseDigestModel,
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

/** 合法 runtime 檔內容（給注入 `readFileImpl` 的案例用）。 */
function runtimeRecord(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    url: "http://127.0.0.1:43117",
    token: "runtime-token",
    pid: 4321,
    startedAt: "2026-10-21T00:00:00.000Z",
    appVersion: "9.9.9",
    ...overrides,
  });
}

/** 記錄讀過哪些路徑的 `readFileImpl`；`content` 可依路徑給不同內容。 */
function recordingReader(
  content: (file: string) => string | null,
): { reads: string[]; readFileImpl: (file: string) => Promise<string> } {
  const reads: string[] = [];
  return {
    reads,
    readFileImpl: async (file) => {
      reads.push(file);
      const text = content(file);
      if (text === null) throw new Error("ENOENT");
      return text;
    },
  };
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

  it("timeoutMs 上限放寬到 2000（1000 生效、3000 夾到 2000）", () => {
    expect(readSettings({ timeoutMs: 1000 }).timeoutMs).toBe(1000);
    expect(readSettings({ timeoutMs: 2000 }).timeoutMs).toBe(2000);
    expect(readSettings({ timeoutMs: 3000 }).timeoutMs).toBe(2000);
    expect(readSettings({ timeoutMs: 1 }).timeoutMs).toBe(100);
    // 沒設定時行為不變。
    expect(readSettings({}).timeoutMs).toBe(DEFAULT_SETTINGS.timeoutMs);
    expect(DEFAULT_SETTINGS.timeoutMs).toBe(150);
  });

  it("digestTimeoutMs 預設 45000、可設 30000、夾在 3000–120000", () => {
    expect(readSettings({}).digestTimeoutMs).toBe(45000);
    expect(readSettings({ digestTimeoutMs: 30000 }).digestTimeoutMs).toBe(30000);
    expect(readSettings({ digestTimeoutMs: 119999 }).digestTimeoutMs).toBe(119999);
    expect(readSettings({ digestTimeoutMs: 2999 }).digestTimeoutMs).toBe(3000);
    expect(readSettings({ digestTimeoutMs: 120001 }).digestTimeoutMs).toBe(120000);
    expect(readSettings({ digestTimeoutMs: "2500" }).digestTimeoutMs).toBe(3000);
  });

  it("recentTurns 預設 3、夾在 0–5（0＝關閉）", () => {
    expect(readSettings({}).recentTurns).toBe(3);
    expect(readSettings({ recentTurns: 0 }).recentTurns).toBe(0);
    expect(readSettings({ recentTurns: 5 }).recentTurns).toBe(5);
    expect(readSettings({ recentTurns: -1 }).recentTurns).toBe(0);
    expect(readSettings({ recentTurns: 9 }).recentTurns).toBe(5);
    const warnings: { key: string; reason: string }[] = [];
    readSettings({ recentTurns: 9 }, (warning) => warnings.push(warning));
    expect(warnings).toEqual([{ key: "recentTurns", reason: "out-of-range" }]);
    const invalid: { key: string; reason: string }[] = [];
    readSettings({ recentTurns: "很多" }, (warning) => invalid.push(warning));
    expect(invalid).toEqual([{ key: "recentTurns", reason: "invalid" }]);
  });

  it("digestTimeoutMs 超範圍會回報 out-of-range、非法型別回報 invalid", () => {
    const outOfRange: { key: string; reason: string }[] = [];
    readSettings({ digestTimeoutMs: 1000 }, (warning) => outOfRange.push(warning));
    expect(outOfRange).toEqual([{ key: "digestTimeoutMs", reason: "out-of-range" }]);

    const invalid: { key: string; reason: string }[] = [];
    readSettings({ digestTimeoutMs: "很久" }, (warning) => invalid.push(warning));
    expect(invalid).toEqual([{ key: "digestTimeoutMs", reason: "invalid" }]);
  });

  it("digest 預設關閉、沒有模型", () => {
    const settings = readSettings(undefined);
    expect(settings.digestEnabled).toBe(false);
    expect(settings.digestModel).toBeNull();
    expect(settings.digestOnInterrupted).toBe(false);
  });

  it("digest 設定值合法時不回報 warning", () => {
    const warnings: { key: string; reason: string }[] = [];
    const settings = readSettings(
      {
        digestEnabled: true,
        digestModel: "cheap/test-model",
        digestOnInterrupted: true,
      },
      (warning) => warnings.push(warning),
    );
    expect(settings.digestEnabled).toBe(true);
    expect(settings.digestModel).toBe("cheap/test-model");
    expect(settings.digestOnInterrupted).toBe(true);
    expect(warnings).toEqual([]);
  });

  it("digest 非法型別回退預設並記 warning（不含值）", () => {
    const warnings: { key: string; reason: string }[] = [];
    const settings = readSettings(
      {
        digestEnabled: "yes",
        digestModel: "沒有斜線的模型",
        digestOnInterrupted: 1,
      },
      (warning) => warnings.push(warning),
    );
    expect(settings.digestEnabled).toBe(false);
    expect(settings.digestModel).toBeNull();
    expect(settings.digestOnInterrupted).toBe(false);
    expect(warnings.map((warning) => warning.key).sort()).toEqual([
      "digestEnabled",
      "digestModel",
      "digestOnInterrupted",
    ]);
    expect(warnings.every((warning) => warning.reason === "invalid")).toBe(true);
  });
  it("已移除的張數上限鍵：留著不生效，但每個鍵各記一筆 removed 警告（不帶值）", () => {
    const warnings: { key: string; reason: string }[] = [];
    const settings = readSettings(
      {
        digestMaxPerTurn: 5,
        digestMaxPerSession: 20,
        digestMaxPerDay: 100,
      },
      (warning) => warnings.push(warning),
    );
    expect(warnings).toEqual([
      { key: "digestMaxPerTurn", reason: "removed" },
      { key: "digestMaxPerSession", reason: "removed" },
      { key: "digestMaxPerDay", reason: "removed" },
    ]);
    // 警告不含使用者填的值；這些鍵也不再出現在解析結果裡。
    expect(JSON.stringify(warnings)).not.toContain("100");
    expect(settings).toEqual(DEFAULT_SETTINGS);
  });

  it("沒有舊鍵時不發 removed 警告", () => {
    const warnings: { key: string; reason: string }[] = [];
    readSettings({ digestEnabled: true, digestModel: "cheap/test-model" }, (warning) =>
      warnings.push(warning),
    );
    expect(warnings.some((warning) => warning.reason === "removed")).toBe(false);
  });
});

describe("parseDigestModel", () => {
  it("只在第一個斜線切分", () => {
    expect(parseDigestModel("cheap/test-model")).toEqual({ providerID: "cheap", id: "test-model" });
    expect(parseDigestModel("openrouter/anthropic/claude-x")).toEqual({
      providerID: "openrouter",
      id: "anthropic/claude-x",
    });
    expect(parseDigestModel("  provider/model  ")).toEqual({ providerID: "provider", id: "model" });
  });

  it("格式不符一律 null", () => {
    expect(parseDigestModel(undefined)).toBeNull();
    expect(parseDigestModel(null)).toBeNull();
    expect(parseDigestModel("")).toBeNull();
    expect(parseDigestModel("no-slash")).toBeNull();
    expect(parseDigestModel("/model")).toBeNull();
    expect(parseDigestModel("provider/")).toBeNull();
    expect(parseDigestModel("pro vider/model")).toBeNull();
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

  it("明確路徑（option runtimeFile）釘住：只有那一個，不接平台預設", () => {
    const home = path.join(path.sep, "work", "userdata");
    const custom = path.join(home, "custom.json");
    const candidates = runtimeCandidates({
      platform: "linux",
      env: { MNEMOSHELF_RUNTIME_FILE: path.join(home, "env.json") },
      home,
      runtimeFile: custom,
    });
    expect(candidates).toEqual([path.resolve(custom)]);
  });

  it("MNEMOSHELF_RUNTIME_FILE 釘住：只有那一個", () => {
    const home = path.join(path.sep, "work", "userdata");
    const custom = path.join(home, "env.json");
    const candidates = runtimeCandidates({
      platform: "linux",
      env: { MNEMOSHELF_RUNTIME_FILE: custom },
      home,
    });
    expect(candidates).toEqual([path.resolve(custom)]);
  });

  it("MNEMOSHELF_DATA_DIR 釘住：只有 <DATA_DIR>/runtime.json", () => {
    const home = path.join(path.sep, "work", "userdata");
    const dataDir = path.join(home, "data");
    const candidates = runtimeCandidates({
      platform: "linux",
      env: { MNEMOSHELF_DATA_DIR: dataDir },
      home,
    });
    expect(candidates).toEqual([path.resolve(path.join(dataDir, "runtime.json"))]);
  });

  it("Linux 設了 XDG_CONFIG_HOME 時桌面候選同時保留 XDG 與 ~/.config（XDG 在前）", () => {
    const home = path.join(path.sep, "work", "userdata");
    const configHome = path.join(path.sep, "work", "config");
    const dataHome = path.join(path.sep, "work", "data");
    const candidates = runtimeCandidates({
      platform: "linux",
      env: { XDG_CONFIG_HOME: configHome, XDG_DATA_HOME: dataHome },
      home,
    });
    const xdgDesktop = path.join(configHome, "Mnemoshelf", "data", "runtime.json");
    const homeDesktop = path.join(home, ".config", "Mnemoshelf", "data", "runtime.json");
    expect(candidates[0]).toBe(xdgDesktop);
    // GUI 行程不一定繼承 shell rc 的 XDG 設定 → `~/.config` 也要留著，順序在 XDG 之後。
    expect(candidates[1]).toBe(homeDesktop);
    // CLI 同理：XDG_DATA_HOME 與 ~/.local/share 兩處都試。
    expect(candidates).toContain(path.join(dataHome, "mnemoshelf", "runtime.json"));
    expect(candidates).toContain(path.join(home, ".local", "share", "mnemoshelf", "runtime.json"));
    expect(new Set(candidates).size).toBe(candidates.length);
  });

  it("Linux 未設 XDG 時桌面候選去重後只剩一個（~/.config），CLI 也只剩一個", () => {
    const home = path.join(path.sep, "work", "userdata");
    const candidates = runtimeCandidates({ platform: "linux", env: {}, home });
    expect(candidates).toEqual([
      path.join(home, ".config", "Mnemoshelf", "data", "runtime.json"),
      path.join(home, ".local", "share", "mnemoshelf", "runtime.json"),
    ]);
  });
});

describe("parseRuntimeFile", () => {
  const valid = {
    schemaVersion: 1,
    url: "http://127.0.0.1:1",
    token: "t",
    pid: 9,
    startedAt: "2026-10-21T00:00:00.000Z",
    appVersion: "0.4.0",
  };

  it("接受合法內容並保留欄位", () => {
    const record = parseRuntimeFile(JSON.stringify(valid));
    expect(record?.pid).toBe(9);
    expect(record?.startedAt).toBe(valid.startedAt);
    expect(record?.appVersion).toBe(valid.appVersion);
  });

  it("拒絕格式不符", () => {
    expect(parseRuntimeFile("not json")).toBeNull();
    expect(parseRuntimeFile(JSON.stringify({ ...valid, schemaVersion: 2 }))).toBeNull();
    expect(parseRuntimeFile(JSON.stringify({ ...valid, url: "" }))).toBeNull();
    expect(parseRuntimeFile(JSON.stringify({ ...valid, token: "  " }))).toBeNull();
    expect(parseRuntimeFile(JSON.stringify({ ...valid, pid: 1.5 }))).toBeNull();
    expect(parseRuntimeFile(JSON.stringify({ ...valid, pid: 0 }))).toBeNull();
  });

  it("缺 startedAt 或 appVersion，或型別不是字串，一律不合法", () => {
    const { startedAt: _startedAt, ...withoutStartedAt } = valid;
    const { appVersion: _appVersion, ...withoutAppVersion } = valid;
    expect(parseRuntimeFile(JSON.stringify(withoutStartedAt))).toBeNull();
    expect(parseRuntimeFile(JSON.stringify(withoutAppVersion))).toBeNull();
    expect(parseRuntimeFile(JSON.stringify({ ...valid, startedAt: 123 }))).toBeNull();
    expect(parseRuntimeFile(JSON.stringify({ ...valid, appVersion: null }))).toBeNull();
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

  it("health 回 JSON null／陣列／字串／數字也是確定性身分失敗（不是暫時連不上）", async () => {
    const runtimeFile = await makeRuntimeFile();
    for (const body of ["null", "[]", '"mnemoshelf"', "42"]) {
      const resolution = await resolveConnection({
        options: {},
        env: { MNEMOSHELF_RUNTIME_FILE: runtimeFile },
        platform: "linux",
        fetchImpl: async () =>
          new Response(body, { status: 200, headers: { "content-type": "application/json" } }),
        killImpl: () => undefined,
      });
      expect(resolution.connection).toBeNull();
      expect(resolution.reason).toBe("health-identity-mismatch");
    }
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

  it("檔案不存在且沒有任何設定時回 no-config，並依平台預設順序各試一次", async () => {
    const home = path.join(os.tmpdir(), "mnemoshelf-plugin-nohome");
    const reader = recordingReader(() => null);
    const resolution = await resolveConnection({
      options: {},
      env: {},
      platform: "linux",
      home,
      readFileImpl: reader.readFileImpl,
    });
    expect(resolution.connection).toBeNull();
    expect(resolution.reason).toBe("no-config");
    // 未明確指定 → 仍走平台預設候選（桌面版資料路徑、CLI 資料目錄）。
    expect(reader.reads).toEqual(resolution.candidates);
    expect(reader.reads).toHaveLength(2);
  });

  it("未指定時平台預設仍會依序嘗試：第一個讀不到就換下一個", async () => {
    const home = path.join(os.tmpdir(), "mnemoshelf-plugin-default-home");
    const desktop = path.resolve(path.join(home, ".config", "Mnemoshelf", "data", "runtime.json"));
    const cli = path.resolve(path.join(home, ".local", "share", "mnemoshelf", "runtime.json"));
    const reader = recordingReader((file) => (file === desktop ? null : runtimeRecord()));
    const resolution = await resolveConnection({
      options: {},
      env: {},
      platform: "linux",
      home,
      readFileImpl: reader.readFileImpl,
      fetchImpl: async () => healthResponse({ service: "mnemoshelf" }),
      killImpl: () => undefined,
    });
    expect(reader.reads).toEqual([desktop, cli]);
    expect(resolution.connection?.source).toBe("runtime");
  });

  it("平台預設的檔案內容不合法時回 runtime-invalid", async () => {
    const home = path.join(os.tmpdir(), "mnemoshelf-plugin-invalid-home");
    const reader = recordingReader(() => "not json");
    const resolution = await resolveConnection({
      options: {},
      env: {},
      platform: "linux",
      home,
      readFileImpl: reader.readFileImpl,
    });
    expect(resolution.connection).toBeNull();
    expect(resolution.reason).toBe("runtime-invalid");
    // 兩個平台預設候選都讀過（都無效）才下結論。
    expect(reader.reads).toEqual(resolution.candidates);
  });

  it("option runtimeFile 釘住：只讀那一個，讀不到回 runtime-missing", async () => {
    const pinned = path.join(os.tmpdir(), "mnemoshelf-plugin-option-pinned", "runtime.json");
    const reader = recordingReader(() => null);
    const resolution = await resolveConnection({
      options: { runtimeFile: pinned },
      env: {},
      platform: "linux",
      home: path.join(os.tmpdir(), "mnemoshelf-plugin-unused-home"),
      readFileImpl: reader.readFileImpl,
    });
    expect(resolution.connection).toBeNull();
    expect(resolution.reason).toBe("runtime-missing");
    expect(reader.reads).toEqual([path.resolve(pinned)]);
    expect(resolution.candidates).toEqual([path.resolve(pinned)]);
  });

  it("MNEMOSHELF_RUNTIME_FILE 釘住：只讀那一個，讀不到回 runtime-missing", async () => {
    const pinned = path.join(os.tmpdir(), "mnemoshelf-plugin-env-pinned", "runtime.json");
    const reader = recordingReader(() => null);
    const resolution = await resolveConnection({
      options: {},
      env: { MNEMOSHELF_RUNTIME_FILE: pinned },
      platform: "linux",
      home: path.join(os.tmpdir(), "mnemoshelf-plugin-unused-home"),
      readFileImpl: reader.readFileImpl,
    });
    expect(resolution.reason).toBe("runtime-missing");
    expect(reader.reads).toEqual([path.resolve(pinned)]);
    expect(resolution.candidates).toEqual([path.resolve(pinned)]);
  });

  it("MNEMOSHELF_DATA_DIR 釘住：只讀 <DATA_DIR>/runtime.json，讀不到回 runtime-missing", async () => {
    const dataDir = path.join(os.tmpdir(), "mnemoshelf-plugin-data-dir");
    const pinned = path.resolve(path.join(dataDir, "runtime.json"));
    const reader = recordingReader(() => null);
    const resolution = await resolveConnection({
      options: {},
      env: { MNEMOSHELF_DATA_DIR: dataDir },
      platform: "linux",
      home: path.join(os.tmpdir(), "mnemoshelf-plugin-unused-home"),
      readFileImpl: reader.readFileImpl,
    });
    expect(resolution.reason).toBe("runtime-missing");
    expect(reader.reads).toEqual([pinned]);
    expect(resolution.candidates).toEqual([pinned]);
  });

  it("MNEMOSHELF_DATA_DIR 有合法 runtime 檔時真的連上（來源 runtime）", async () => {
    const dataDir = path.join(os.tmpdir(), "mnemoshelf-plugin-data-dir-ok");
    const pinned = path.resolve(path.join(dataDir, "runtime.json"));
    const reader = recordingReader((file) => (file === pinned ? runtimeRecord() : null));
    const resolution = await resolveConnection({
      options: {},
      env: { MNEMOSHELF_DATA_DIR: dataDir },
      platform: "linux",
      home: path.join(os.tmpdir(), "mnemoshelf-plugin-unused-home"),
      readFileImpl: reader.readFileImpl,
      fetchImpl: async () => healthResponse({ service: "mnemoshelf" }),
      killImpl: () => undefined,
    });
    expect(resolution.reason).toBeNull();
    expect(resolution.connection?.source).toBe("runtime");
    expect(resolution.connection?.baseUrl).toBe("http://127.0.0.1:43117");
    expect(reader.reads).toEqual([pinned]);
  });

  it("MNEMOSHELF_RUNTIME_FILE 與 MNEMOSHELF_DATA_DIR 同時設定時只讀前者", async () => {
    const pinned = path.join(os.tmpdir(), "mnemoshelf-plugin-both-pinned", "runtime.json");
    const dataDir = path.join(os.tmpdir(), "mnemoshelf-plugin-both-data-dir");
    const reader = recordingReader(() => null);
    const resolution = await resolveConnection({
      options: {},
      env: { MNEMOSHELF_RUNTIME_FILE: pinned, MNEMOSHELF_DATA_DIR: dataDir },
      platform: "linux",
      home: path.join(os.tmpdir(), "mnemoshelf-plugin-unused-home"),
      readFileImpl: reader.readFileImpl,
    });
    expect(resolution.reason).toBe("runtime-missing");
    expect(reader.reads).toEqual([path.resolve(pinned)]);
    expect(resolution.candidates).toEqual([path.resolve(pinned)]);
  });

  it("釘住的檔案內容不合法時回 runtime-invalid，且不退回平台預設（即使預設有可用檔）", async () => {
    const pinned = path.join(os.tmpdir(), "mnemoshelf-plugin-invalid-pinned", "runtime.json");
    const reader = recordingReader((file) =>
      file === path.resolve(pinned) ? JSON.stringify({ schemaVersion: 1 }) : runtimeRecord(),
    );
    const resolution = await resolveConnection({
      options: {},
      env: { MNEMOSHELF_RUNTIME_FILE: pinned },
      platform: "linux",
      home: path.join(os.tmpdir(), "mnemoshelf-plugin-unused-home"),
      readFileImpl: reader.readFileImpl,
    });
    expect(resolution.connection).toBeNull();
    expect(resolution.reason).toBe("runtime-invalid");
    expect(reader.reads).toEqual([path.resolve(pinned)]);
  });

  it("Linux 平台預設在設定 XDG_CONFIG_HOME 時讀該目錄下的桌面 runtime 檔", async () => {
    const home = path.join(os.tmpdir(), "mnemoshelf-plugin-xdg-home");
    const configHome = path.join(os.tmpdir(), "mnemoshelf-plugin-xdg-config");
    const expected = path.resolve(path.join(configHome, "Mnemoshelf", "data", "runtime.json"));
    const reader = recordingReader(() => runtimeRecord());
    const resolution = await resolveConnection({
      options: {},
      env: { XDG_CONFIG_HOME: configHome },
      platform: "linux",
      home,
      readFileImpl: reader.readFileImpl,
      fetchImpl: async () => healthResponse({ service: "mnemoshelf", appVersion: "0.4.0" }),
      killImpl: () => undefined,
    });
    expect(reader.reads[0]).toBe(expected);
    expect(resolution.connection?.source).toBe("runtime");
  });

  it("XDG_CONFIG_HOME 只設在 shell rc、桌面版卻寫在 ~/.config 時仍然連得上", async () => {
    const home = path.join(os.tmpdir(), "mnemoshelf-plugin-rc-home");
    const configHome = path.join(os.tmpdir(), "mnemoshelf-plugin-rc-config");
    const homeDesktop = path.resolve(path.join(home, ".config", "Mnemoshelf", "data", "runtime.json"));
    // 桌面版從圖形工作階段啟動，看不到 shell rc 的 XDG_CONFIG_HOME → 檔案寫在 ~/.config。
    const reader = recordingReader((file) => (file === homeDesktop ? runtimeRecord() : null));
    const resolution = await resolveConnection({
      options: {},
      env: { XDG_CONFIG_HOME: configHome },
      platform: "linux",
      home,
      readFileImpl: reader.readFileImpl,
      fetchImpl: async () => healthResponse({ service: "mnemoshelf" }),
      killImpl: () => undefined,
    });
    expect(reader.reads[0]).toBe(
      path.resolve(path.join(configHome, "Mnemoshelf", "data", "runtime.json")),
    );
    expect(reader.reads[1]).toBe(homeDesktop);
    expect(resolution.connection?.source).toBe("runtime");
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

  it("JSON null／陣列／字串／數字回 wrong-service（不是暫時連不上）", async () => {
    for (const body of ["null", "[]", '"mnemoshelf"', "42", "true"]) {
      const result = await checkHealth({
        baseUrl: "http://127.0.0.1:1",
        fetchImpl: async () =>
          new Response(body, { status: 200, headers: { "content-type": "application/json" } }),
      });
      expect(result).toEqual({ ok: false, reason: "wrong-service" });
    }
  });

  it("service 不是字串或不是 mnemoshelf 時回 wrong-service", async () => {
    for (const body of [{}, { service: 123 }, { service: "other" }]) {
      const result = await checkHealth({
        baseUrl: "http://127.0.0.1:1",
        fetchImpl: async () => healthResponse(body),
      });
      expect(result).toEqual({ ok: false, reason: "wrong-service" });
    }
  });

  it("逾時回 timeout", async () => {
    const result = await checkHealth({
      baseUrl: "http://127.0.0.1:1",
      timeoutMs: 5,
      fetchImpl: (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          );
        }),
    });
    expect(result).toEqual({ ok: false, reason: "timeout" });
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
