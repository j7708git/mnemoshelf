/**
 * 設定、專案解析與 Mnemoshelf 連線解析。
 *
 * 連線優先序（與 `docs/agent-integration.md`、`@mnemoshelf/opencode-plugin` 一致）：
 * 1. 套件選項 `baseUrl`／`token`（使用者明確指定，不驗身分）
 * 2. 環境變數 `MNEMOSHELF_URL`／`MNEMOSHELF_TOKEN`（同上）
 * 3. `runtime.json`（先驗 loopback、pid、`/health` 的 `service === "mnemoshelf"`）
 *
 * runtime 檔位置「明確指定即不猜」：`runtimeFile`／`MNEMOSHELF_RUNTIME_FILE`／
 * `MNEMOSHELF_DATA_DIR` 有給時只試那一個，讀不到就是 `runtime-missing`。
 *
 * 這個模組只讀檔與打 `/health`；不寫 spool、不記 token、不把路徑寫進 log。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  Connection,
  LogFn,
  RuntimeDeps,
  RuntimeFileRecord,
} from "./types.js";
import { asRecord } from "./strip.js";

/** 召回搜尋的固定契約值（T1／T3 卡）：不從環境或設定覆寫。 */
export const RECALL_K = 4;
export const RECALL_MIN_SCORE = 0.65;
export const RECALL_TIMEOUT_MS = 800;

/** 注入區塊含標記的總長上限（code point）。 */
export const MAX_BLOCK_CHARS = 900;

/** `POST /memories/search` 的 query 上限（與 server `MAX_MEMORY_QUERY_CHARS` 一致）。 */
export const MAX_QUERY_CHARS = 2000;

/** 卡片門檻：使用者文字（剝除後）低於這個字元數就不寫。 */
export const MIN_USER_CHARS = 40;

/** 卡片各段固定上限（程式常數；不隨環境變動）。 */
export const MAX_CARD_USER_CHARS = 2000;
export const MAX_CARD_ASSISTANT_CHARS = 4000;

/** server 的單張記憶上限；用來做最後一道保險。 */
export const MAX_MEMORY_CHARS = 8000;

/** `sourceSession`／`sourceMessage` 的上限（server 超長直接 400，不截斷）。 */
export const MAX_SOURCE_REF_CHARS = 200;

/** 回合卡固定使用 `fact`（v1 契約）。 */
export const TURN_AGENT = "dsh/turn";

/** 寫入 `POST /memories` 的 timeout（毫秒）。 */
export const WRITE_TIMEOUT_MS = 5000;

/** spool 上限與補送間隔。 */
export const SPOOL_LIMIT = 200;
export const SPOOL_FLUSH_INTERVAL_MS = 5 * 60 * 1000;
export const SPOOL_FLUSH_BATCH = 20;

/** `GET /health` 的 timeout。 */
export const HEALTH_TIMEOUT_MS = 300;

/** 初次連線解析時，召回最多等多久（毫秒）。 */
export const CONNECTION_WAIT_MS = 50;

export interface Settings {
  project?: string;
  baseUrl?: string;
  token?: string;
  runtimeFile?: string;
  spoolDir?: string;
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** 解析外掛選項；只認已知鍵，非法值一律視同未提供。 */
export function readSettings(raw: unknown): Settings {
  const record = asRecord(raw) ?? {};
  const settings: Settings = {};
  const project = readNonEmptyString(record.project);
  if (project !== undefined) settings.project = project;
  const baseUrl = readNonEmptyString(record.baseUrl);
  if (baseUrl !== undefined) settings.baseUrl = baseUrl;
  const token = readNonEmptyString(record.token);
  if (token !== undefined) settings.token = token;
  const runtimeFile = readNonEmptyString(record.runtimeFile);
  if (runtimeFile !== undefined) settings.runtimeFile = runtimeFile;
  const spoolDir = readNonEmptyString(record.spoolDir);
  if (spoolDir !== undefined) settings.spoolDir = spoolDir;
  return settings;
}

/**
 * 專案名解析：選項 → `MNEMOSHELF_PROJECT` → cwd 的資料夾名。
 *
 * cwd 是家目錄或檔案系統根時不猜（dsh 從圖形介面啟動時 cwd 可能是家目錄）；
 * 解析不到就寫 `scope:"global"`、召回只查 global。
 */
export function resolveProject(input: {
  optionProject?: string | undefined;
  envProject?: string | undefined;
  cwd: string;
  home: string;
  platform?: NodeJS.Platform;
}): string | null {
  const explicit = readNonEmptyString(input.optionProject) ?? readNonEmptyString(input.envProject);
  if (explicit !== undefined) return explicit;
  const p = input.platform === "win32" ? path.win32 : path.posix;
  const cwd = p.resolve(input.cwd);
  const home = p.resolve(input.home);
  if (cwd === home) return null;
  if (cwd === p.parse(cwd).root) return null;
  const base = p.basename(cwd).trim();
  return base === "" ? null : base;
}

/** spool 目錄：選項 → `<DSH_HOME>/mnemoshelf-spool`（預設 `~/.dsh`）。 */
export function resolveSpoolDir(input: {
  optionSpoolDir?: string | undefined;
  env: NodeJS.ProcessEnv;
  home: string;
}): string {
  const explicit = readNonEmptyString(input.optionSpoolDir);
  if (explicit !== undefined) return path.resolve(explicit);
  const dshHome = readNonEmptyString(input.env.DSH_HOME) ?? path.join(input.home, ".dsh");
  return path.join(path.resolve(dshHome), "mnemoshelf-spool");
}

/** 去掉結尾斜線；不是 http(s) URL 就回 undefined。 */
export function normalizeBaseUrl(value: string | undefined): string | undefined {
  const trimmed = readNonEmptyString(value);
  if (trimmed === undefined) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
  return trimmed.replace(/\/+$/, "");
}

/**
 * 是不是單純的 loopback 基底網址（http(s)、主機 127.0.0.1／localhost、
 * 不含帳密／查詢／片段／路徑）。不是就拒絕，且不送任何請求。
 */
export function isLoopbackBaseUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  if (parsed.username !== "" || parsed.password !== "") return false;
  if (parsed.search !== "" || parsed.hash !== "") return false;
  if (parsed.pathname !== "" && parsed.pathname !== "/") return false;
  const host = parsed.hostname.toLowerCase();
  return host === "127.0.0.1" || host === "localhost";
}

interface RuntimeCandidatePlan {
  candidates: string[];
  pinned: boolean;
}

/** 平台預設的 runtime 候選路徑（桌面版 `data` 路徑與 CLI 資料目錄都留）。 */
function resolveRuntimeCandidatePlan(input: {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  home: string;
  runtimeFile?: string | undefined;
}): RuntimeCandidatePlan {
  const explicitOption = readNonEmptyString(input.runtimeFile);
  if (explicitOption !== undefined) return { candidates: [path.resolve(explicitOption)], pinned: true };

  const explicitFile = readNonEmptyString(input.env.MNEMOSHELF_RUNTIME_FILE);
  if (explicitFile !== undefined) return { candidates: [path.resolve(explicitFile)], pinned: true };

  const explicitDataDir = readNonEmptyString(input.env.MNEMOSHELF_DATA_DIR);
  if (explicitDataDir !== undefined) {
    return { candidates: [path.resolve(path.join(explicitDataDir, "runtime.json"))], pinned: true };
  }

  const platform = input.platform;
  const p = platform === "win32" ? path.win32 : path.posix;
  const home = input.home;
  const appData = readNonEmptyString(input.env.APPDATA) ?? p.join(home, "AppData", "Roaming");
  const dataRoot =
    platform === "win32"
      ? appData
      : platform === "darwin"
        ? p.join(home, "Library", "Application Support")
        : (readNonEmptyString(input.env.XDG_DATA_HOME) ?? p.join(home, ".local", "share"));

  const candidates: string[] = [];
  const add = (value: string): void => {
    const resolved = p.resolve(value);
    if (!candidates.includes(resolved)) candidates.push(resolved);
  };

  if (platform === "win32") {
    add(p.join(appData, "Mnemoshelf", "data", "runtime.json"));
    add(p.join(appData, "mnemoshelf", "runtime.json"));
  } else if (platform === "darwin") {
    add(p.join(home, "Library", "Application Support", "Mnemoshelf", "data", "runtime.json"));
    add(p.join(home, "Library", "Application Support", "mnemoshelf", "runtime.json"));
  } else {
    // 桌面版尊重 XDG_CONFIG_HOME；GUI 行程不一定繼承 shell rc，所以 XDG 與 ~ 版都留。
    const configRoot =
      readNonEmptyString(input.env.XDG_CONFIG_HOME) ?? p.join(home, ".config");
    add(p.join(configRoot, "Mnemoshelf", "data", "runtime.json"));
    add(p.join(home, ".config", "Mnemoshelf", "data", "runtime.json"));
    add(p.join(dataRoot, "mnemoshelf", "runtime.json"));
    add(p.join(home, ".local", "share", "mnemoshelf", "runtime.json"));
  }
  return { candidates, pinned: false };
}

export function runtimeCandidates(input: {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
  runtimeFile?: string;
}): string[] {
  return resolveRuntimeCandidatePlan({
    platform: input.platform ?? process.platform,
    env: input.env ?? process.env,
    home: input.home ?? os.homedir(),
    runtimeFile: input.runtimeFile,
  }).candidates;
}

/** 解析 runtime 檔；格式不符回 `null`（不用半份資料）。 */
export function parseRuntimeFile(text: string): RuntimeFileRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const record = asRecord(parsed);
  if (record === null) return null;
  if (record.schemaVersion !== 1) return null;
  if (typeof record.url !== "string" || record.url.trim() === "") return null;
  if (typeof record.token !== "string" || record.token.trim() === "") return null;
  if (typeof record.pid !== "number" || !Number.isInteger(record.pid) || record.pid <= 0) return null;
  if (typeof record.startedAt !== "string" || typeof record.appVersion !== "string") return null;
  return {
    schemaVersion: 1,
    url: record.url,
    token: record.token,
    pid: record.pid,
    startedAt: record.startedAt,
    appVersion: record.appVersion,
  };
}

export type HealthFailureReason = "timeout" | "unreachable" | "not-json" | "wrong-service" | "http-error";

export type HealthCheckResult =
  | { ok: true; appVersion?: string }
  | { ok: false; reason: HealthFailureReason };

/** 打 `GET /health`（不帶 Authorization）確認服務身分。 */
export async function checkHealth(input: {
  baseUrl: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<HealthCheckResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? HEALTH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(`${input.baseUrl}/health`, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal,
      redirect: "error",
    });
    if (!response.ok) return { ok: false, reason: "http-error" };
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return { ok: false, reason: "not-json" };
    }
    const record = asRecord(payload);
    if (record === null || record.service !== "mnemoshelf") {
      return { ok: false, reason: "wrong-service" };
    }
    return {
      ok: true,
      ...(typeof record.appVersion === "string" ? { appVersion: record.appVersion } : {}),
    };
  } catch {
    return { ok: false, reason: controller.signal.aborted ? "timeout" : "unreachable" };
  } finally {
    clearTimeout(timer);
  }
}

/** POSIX 確認 pid 還活著；Windows 沒有可靠的 signal 0，直接視為通過。 */
export function isProcessAlive(
  pid: number,
  platform: NodeJS.Platform = process.platform,
  killImpl: (pid: number, signal: 0) => void = (target, signal) => process.kill(target, signal),
): boolean {
  if (platform === "win32") return true;
  try {
    killImpl(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException | undefined)?.code === "EPERM";
  }
}

export type ConnectionFailureReason =
  | "no-config"
  | "runtime-missing"
  | "runtime-invalid"
  | "url-invalid"
  | "url-not-loopback"
  | "identity-mismatch"
  | "pid-dead"
  | "health-timeout"
  | "health-unreachable"
  | "health-identity-mismatch";

export interface ConnectionResolution {
  connection: Connection | null;
  reason: ConnectionFailureReason | null;
  /**
   * 是否值得把寫入放進 spool。
   *
   * 只有「已知服務位址與 token，但服務當下不可用」（pid 死亡、health 逾時／連不上）
   * 才是 true；runtime 檔不存在／格式不符／身分不符代表連線設定本身有問題，
   * 重試只會堆積垃圾，因此 false。
   */
  spoolable: boolean;
}

export interface ResolveConnectionInput {
  options: Settings;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
  fetchImpl?: typeof fetch;
  readFileImpl?: (file: string) => Promise<string>;
  killImpl?: (pid: number, signal: 0) => void;
  healthTimeoutMs?: number;
}

type RuntimeFileRead = { kind: "ok"; record: RuntimeFileRecord } | { kind: "missing" } | { kind: "invalid" };

async function readRuntimeFileResult(
  file: string,
  readFileImpl: (file: string) => Promise<string>,
): Promise<RuntimeFileRead> {
  let text: string;
  try {
    text = await readFileImpl(file);
  } catch {
    return { kind: "missing" };
  }
  const record = parseRuntimeFile(text);
  return record === null ? { kind: "invalid" } : { kind: "ok", record };
}

/**
 * 依優先序解析連線。只讀檔／打 `/health`，不寫任何東西、也不記 token。
 */
export async function resolveConnection(input: ResolveConnectionInput): Promise<ConnectionResolution> {
  const options = input.options;
  const env = input.env ?? process.env;
  const platform = input.platform ?? process.platform;
  const home = input.home ?? os.homedir();
  const readFileImpl = input.readFileImpl ?? ((file: string) => fs.readFile(file, "utf8"));
  const fetchImpl = input.fetchImpl ?? fetch;

  const optionUrl = normalizeBaseUrl(options.baseUrl);
  const optionToken = readNonEmptyString(options.token);
  const envUrl = normalizeBaseUrl(env.MNEMOSHELF_URL);
  const envToken = readNonEmptyString(env.MNEMOSHELF_TOKEN);

  let url = optionUrl ?? envUrl;
  let token = optionToken ?? envToken;
  const usedOptions = optionUrl !== undefined || optionToken !== undefined;
  const usedEnv = envUrl !== undefined || envToken !== undefined;

  const needRuntime = url === undefined || token === undefined;
  const plan = needRuntime
    ? resolveRuntimeCandidatePlan({ platform, env, home, runtimeFile: options.runtimeFile })
    : { candidates: [] as string[], pinned: false };

  let record: RuntimeFileRecord | null = null;
  let sawInvalid = false;
  if (needRuntime) {
    for (const candidate of plan.candidates) {
      const result = await readRuntimeFileResult(candidate, readFileImpl);
      if (result.kind === "ok") {
        record = result.record;
        break;
      }
      if (result.kind === "invalid") sawInvalid = true;
    }
  }

  let usedRuntime = false;
  let candidateUrlInvalid = false;
  if (url === undefined && record !== null) {
    const normalized = normalizeBaseUrl(record.url);
    if (normalized === undefined) candidateUrlInvalid = true;
    else {
      url = normalized;
      usedRuntime = true;
    }
  }
  if (token === undefined && record !== null) {
    token = record.token;
    usedRuntime = true;
  }

  if (url === undefined || token === undefined) {
    if (needRuntime) {
      const reason: ConnectionFailureReason = sawInvalid
        ? "runtime-invalid"
        : plan.pinned
          ? "runtime-missing"
          : "no-config";
      // 服務正常關閉時會刪掉 runtime.json。若這是平台預設位置、且資料目錄還在，
      // 代表這台機器本來就有 Mnemoshelf；寫入仍值得進 spool，等服務回來再補送。
      // 使用者明確指定的路徑不存在時不 spool（設定錯了，重試沒有意義）。
      let dataPresent = false;
      if (!plan.pinned) {
        for (const candidate of plan.candidates) {
          try {
            await fs.access(path.dirname(candidate));
            dataPresent = true;
            break;
          } catch {
            // 換下一個候選。
          }
        }
      }
      return { connection: null, reason, spoolable: !plan.pinned && dataPresent };
    }
    return { connection: null, reason: "no-config", spoolable: false };
  }

  if (usedRuntime) {
    if (record === null) return { connection: null, reason: "runtime-invalid", spoolable: false };
    if (!isLoopbackBaseUrl(url)) {
      return { connection: null, reason: "url-not-loopback", spoolable: false };
    }
    if (normalizeBaseUrl(record.url) !== url) {
      return { connection: null, reason: "identity-mismatch", spoolable: false };
    }
    if (!isProcessAlive(record.pid, platform, input.killImpl)) {
      // 服務行程已不在：寫入值得先進 spool，等服務回來（會重寫 runtime.json、換 token）
      // 再補送；spool 檔不含 token，補送時用當下的 runtime 檔。
      return { connection: null, reason: "pid-dead", spoolable: true };
    }
    const health = await checkHealth({
      baseUrl: url,
      ...(input.healthTimeoutMs === undefined ? {} : { timeoutMs: input.healthTimeoutMs }),
      fetchImpl,
    });
    if (!health.ok) {
      const reason: ConnectionFailureReason =
        health.reason === "timeout"
          ? "health-timeout"
          : health.reason === "unreachable"
            ? "health-unreachable"
            : "health-identity-mismatch";
      return {
        connection: null,
        reason,
        spoolable: reason === "health-timeout" || reason === "health-unreachable",
      };
    }
    return {
      connection: {
        baseUrl: url,
        token,
        source: usedOptions ? "options" : usedEnv ? "env" : "runtime",
        ...(health.appVersion === undefined ? {} : { appVersion: health.appVersion }),
      },
      reason: null,
      spoolable: true,
    };
  }

  return {
    connection: { baseUrl: url, token, source: usedOptions ? "options" : "env" },
    reason: null,
    spoolable: true,
  };
}

export function describeConnectionFailure(reason: ConnectionFailureReason | null): string {
  switch (reason) {
    case "no-config":
      return "找不到連線設定（可設 MNEMOSHELF_URL／MNEMOSHELF_TOKEN，或開啟 runtime.json）";
    case "runtime-missing":
      return "runtime 檔不存在或無法讀取";
    case "runtime-invalid":
      return "runtime 檔格式不符";
    case "url-invalid":
      return "runtime 檔的 url 不是有效的 http(s) 位址";
    case "url-not-loopback":
      return "runtime 檔的 url 不是 loopback 位址（不送 token）";
    case "identity-mismatch":
      return "身分比對失敗（runtime 檔的 url 與連線來源不一致）";
    case "pid-dead":
      return "runtime 檔的服務行程已不存在";
    case "health-timeout":
      return "GET /health 逾時";
    case "health-unreachable":
      return "GET /health 連線失敗";
    case "health-identity-mismatch":
      return "GET /health 回應不是 mnemoshelf（不送 token）";
    default:
      return "尚未檢查連線";
  }
}

export interface ConnectionManager {
  /** 尚未解析過才解析；已解析就直接回上次結果。 */
  ensure(): Promise<ConnectionResolution>;
  /** 強制重新解析（補送前用，服務可能已換埠／換 token）。 */
  refresh(): Promise<ConnectionResolution>;
  /** 取得可用連線；初次解析最多等 `waitMs`。 */
  get(waitMs?: number): Promise<Connection | null>;
  /** 請求失敗後丟掉快取，下一輪重新解析。 */
  invalidate(): void;
  lastResolution(): ConnectionResolution | null;
  /** 這次行程是否曾經成功連上（用來決定「設定消失後」還要不要 spool）。 */
  everConnected(): boolean;
}

function waitFor<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), ms);
    }),
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/**
 * 連線快取。解析失敗不重試風暴：呼叫端只在需要時 `ensure`／`refresh`，
 * `invalidate` 後才會再打一次 `/health`。
 */
export function createConnectionManager(input: {
  settings: Settings;
  deps: RuntimeDeps;
  log: LogFn;
}): ConnectionManager {
  const env = input.deps.env ?? process.env;
  const platform = input.deps.platform ?? process.platform;
  const home = input.deps.home ?? os.homedir();
  let cached: Connection | null = null;
  let last: ConnectionResolution | null = null;
  let inflight: Promise<ConnectionResolution> | null = null;
  let resolvedOnce = false;
  let connectedOnce = false;

  const run = (): Promise<ConnectionResolution> => {
    if (inflight !== null) return inflight;
    inflight = resolveConnection({
      options: input.settings,
      env,
      platform,
      home,
      ...(input.deps.fetchImpl === undefined ? {} : { fetchImpl: input.deps.fetchImpl }),
      ...(input.deps.readFileImpl === undefined ? {} : { readFileImpl: input.deps.readFileImpl }),
      ...(input.deps.killImpl === undefined ? {} : { killImpl: input.deps.killImpl }),
    })
      .catch((): ConnectionResolution => ({ connection: null, reason: "no-config", spoolable: false }))
      .then((resolution) => {
        last = resolution;
        cached = resolution.connection;
        resolvedOnce = true;
        if (resolution.connection !== null) connectedOnce = true;
        return resolution;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  };

  return {
    async ensure(): Promise<ConnectionResolution> {
      if (resolvedOnce && inflight === null && last !== null) return last;
      return await run();
    },
    async refresh(): Promise<ConnectionResolution> {
      resolvedOnce = false;
      return await run();
    },
    async get(waitMs = CONNECTION_WAIT_MS): Promise<Connection | null> {
      if (cached !== null) return cached;
      if (resolvedOnce) return null;
      const resolution = await waitFor(run(), waitMs);
      return resolution === null ? null : resolution.connection;
    },
    invalidate(): void {
      cached = null;
      resolvedOnce = false;
    },
    lastResolution(): ConnectionResolution | null {
      return last;
    },
    everConnected(): boolean {
      return connectedOnce;
    },
  };
}
