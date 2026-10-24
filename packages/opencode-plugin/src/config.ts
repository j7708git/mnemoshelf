/**
 * 設定與連線來源解析。
 *
 * 連線優先序（欄位各自取第一個有值者）：
 * 1. plugin options `baseUrl`／`token`
 * 2. 環境變數 `MNEMOSHELF_URL`／`MNEMOSHELF_TOKEN`
 * 3. runtime 檔（`<dataDir>/runtime.json`，含 url／token／pid）
 *
 * 只要 url 或 token **有任何一個**來自 runtime 檔，就必須先通過身分驗證：
 * `GET <url>/health` 回 `service === "mnemoshelf"`，且（POSIX）`pid` 還活著。
 * 這是為了避免「過期的檔＋被重用的埠」把全權 token 送給無關的本機程式。
 * 驗證失敗一律視同未連線：不送 Authorization、不注入。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  Connection,
  ConnectionSource,
  HealthInfo,
  LogFn,
  RuntimeFileRecord,
  Settings,
} from "./types.js";

/** digest 模型呼叫／模型清單檢查的 timeout：預設值（毫秒）。 */
export const DEFAULT_DIGEST_TIMEOUT_MS = 45000;

/** `digestTimeoutMs` 的合法範圍（毫秒）。 */
export const DIGEST_TIMEOUT_MIN_MS = 3000;
export const DIGEST_TIMEOUT_MAX_MS = 120000;

/** `recentTurns` 的預設值與範圍（0＝關閉回合紀錄召回）。 */
export const DEFAULT_RECENT_TURNS = 3;
export const RECENT_TURNS_MAX = 5;

/** 預設值（與 `docs/opencode-plugin.md` 的參數表一致）。 */
export const DEFAULT_SETTINGS: Readonly<Settings> = {
  trigger: "first-turn+explicit",
  kMax: 8,
  maxItems: 4,
  minScore: 0.65,
  timeoutMs: 150,
  maxFactChars: 180,
  maxOtherChars: 220,
  softChars: 900,
  hardChars: 1200,
  dedupeTTL: 8,
  recentTurns: DEFAULT_RECENT_TURNS,
  digestEnabled: false,
  digestModel: null,
  digestOnInterrupted: false,
  digestTimeoutMs: DEFAULT_DIGEST_TIMEOUT_MS,
};

/** 驗證 runtime 檔時 `GET /health` 的 timeout。 */
export const HEALTH_TIMEOUT_MS = 300;

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function readFiniteNumber(value: unknown): number | undefined {
  const num = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(num) ? num : undefined;
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const num = readFiniteNumber(value);
  if (num === undefined) return fallback;
  return Math.min(max, Math.max(min, num));
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  return Math.floor(clampNumber(value, fallback, min, max));
}

/** 設定值被回退／夾住的原因（只帶鍵名，不帶值——避免把使用者填錯的敏感字串寫進 log）。 */
export interface SettingsWarning {
  key: string;
  /**
   * - `invalid`：型別不符，回退預設。
   * - `out-of-range`：超出範圍，夾在範圍內。
   * - `removed`：這個鍵已從產品移除；留著不會生效（不驗證值、不記值）。
   */
  reason: "invalid" | "out-of-range" | "removed";
}

/** 已移除的設定鍵：只警告、不生效（不驗證值，也不帶值進 log）。 */
const REMOVED_SETTINGS_KEYS = [
  "digestMaxPerTurn",
  "digestMaxPerSession",
  "digestMaxPerDay",
] as const;

export type SettingsWarnFn = (warning: SettingsWarning) => void;

/** 解析 `digestModel`（`<providerID>/<modelID>`）；格式不符回 `null`（呼叫端跳過 digest）。 */
export function parseDigestModel(
  value: string | null | undefined,
): { providerID: string; id: string } | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  // 只在**第一個** `/` 切：model id 本身可能含 `/`（例如某些 provider 的 `vendor/model`）。
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) return null;
  const providerID = trimmed.slice(0, slash).trim();
  const id = trimmed.slice(slash + 1).trim();
  if (providerID === "" || id === "" || /\s/.test(providerID)) return null;
  return { providerID, id };
}

function readDigestBoolean(
  value: unknown,
  fallback: boolean,
  key: string,
  warn: SettingsWarnFn | undefined,
): boolean {
  if (value === undefined) return fallback;
  if (typeof value === "boolean") return value;
  warn?.({ key, reason: "invalid" });
  return fallback;
}

function readDigestInt(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
  key: string,
  warn: SettingsWarnFn | undefined,
): number {
  if (value === undefined) return fallback;
  const num = readFiniteNumber(value);
  if (num === undefined) {
    warn?.({ key, reason: "invalid" });
    return fallback;
  }
  if (num < min || num > max) warn?.({ key, reason: "out-of-range" });
  return Math.min(max, Math.max(min, Math.floor(num)));
}

/**
 * 解析 plugin options；非法值回退預設並夾在可用範圍。
 *
 * `warn` 只收到鍵名與原因（不含值）：digest 相關鍵若填錯，呼叫端會記一行 warning。
 */
export function readSettings(options: unknown, warn?: SettingsWarnFn): Settings {
  const raw = (options ?? {}) as Record<string, unknown>;
  const trigger = raw.trigger === "every-turn" ? "every-turn" : "first-turn+explicit";
  const softChars = clampInt(raw.softChars, DEFAULT_SETTINGS.softChars, 200, 2000);
  const hardChars = clampInt(raw.hardChars, DEFAULT_SETTINGS.hardChars, softChars, 4000);
  let digestModel: string | null = null;
  if (raw.digestModel !== undefined && raw.digestModel !== null) {
    const normalized = readNonEmptyString(raw.digestModel);
    if (normalized === undefined || parseDigestModel(normalized) === null) {
      warn?.({ key: "digestModel", reason: "invalid" });
    } else {
      digestModel = normalized;
    }
  }
  // 已移除的張數上限鍵：設定檔若還留著，留一筆警告讓使用者知道它不會生效。
  for (const key of REMOVED_SETTINGS_KEYS) {
    if (raw[key] !== undefined) warn?.({ key, reason: "removed" });
  }
  return {
    ...(readNonEmptyString(raw.baseUrl) === undefined ? {} : { baseUrl: readNonEmptyString(raw.baseUrl) }),
    ...(readNonEmptyString(raw.token) === undefined ? {} : { token: readNonEmptyString(raw.token) }),
    ...(readNonEmptyString(raw.runtimeFile) === undefined
      ? {}
      : { runtimeFile: readNonEmptyString(raw.runtimeFile) }),
    ...(readNonEmptyString(raw.project) === undefined ? {} : { project: readNonEmptyString(raw.project) }),
    trigger,
    kMax: clampInt(raw.kMax, DEFAULT_SETTINGS.kMax, 1, 20),
    maxItems: clampInt(raw.maxItems, DEFAULT_SETTINGS.maxItems, 1, 8),
    minScore: clampNumber(raw.minScore, DEFAULT_SETTINGS.minScore, 0, 1),
    timeoutMs: clampInt(raw.timeoutMs, DEFAULT_SETTINGS.timeoutMs, 100, 2000),
    maxFactChars: clampInt(raw.maxFactChars, DEFAULT_SETTINGS.maxFactChars, 40, 1000),
    maxOtherChars: clampInt(raw.maxOtherChars, DEFAULT_SETTINGS.maxOtherChars, 40, 1000),
    softChars,
    hardChars,
    dedupeTTL: clampInt(raw.dedupeTTL, DEFAULT_SETTINGS.dedupeTTL, 8, 10),
    recentTurns: readDigestInt(
      raw.recentTurns,
      DEFAULT_SETTINGS.recentTurns,
      0,
      RECENT_TURNS_MAX,
      "recentTurns",
      warn,
    ),
    digestEnabled: readDigestBoolean(raw.digestEnabled, DEFAULT_SETTINGS.digestEnabled, "digestEnabled", warn),
    digestModel,
    digestOnInterrupted: readDigestBoolean(
      raw.digestOnInterrupted,
      DEFAULT_SETTINGS.digestOnInterrupted,
      "digestOnInterrupted",
      warn,
    ),
    digestTimeoutMs: readDigestInt(
      raw.digestTimeoutMs,
      DEFAULT_SETTINGS.digestTimeoutMs,
      DIGEST_TIMEOUT_MIN_MS,
      DIGEST_TIMEOUT_MAX_MS,
      "digestTimeoutMs",
      warn,
    ),
  };
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

/** OS 使用者資料目錄（與 server `config.ts` 的規則一致）。 */
function osUserDataDir(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string): string {
  const p = platform === "win32" ? path.win32 : path.posix;
  if (platform === "win32") {
    const appData = readNonEmptyString(env.APPDATA);
    return appData ?? p.join(home, "AppData", "Roaming");
  }
  if (platform === "darwin") return p.join(home, "Library", "Application Support");
  const xdg = readNonEmptyString(env.XDG_DATA_HOME);
  return xdg ?? p.join(home, ".local", "share");
}

/**
 * 依序回傳可能存在的 runtime 檔路徑（去重、保留順序）。
 *
 * 桌面版多一層 `data`：`<userData>/data/runtime.json`；CLI 是 `<OS 資料目錄>/mnemoshelf/runtime.json`。
 * 兩者刻意不同，不要合併成同一個路徑。
 */
export function runtimeCandidates(input: {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
  runtimeFile?: string;
}): string[] {
  const platform = input.platform ?? process.platform;
  const env = input.env ?? process.env;
  const home = input.home ?? os.homedir();
  // 依目標平台選路徑規則：正式流程的 platform 就是 process.platform；測試可注入。
  const p = platform === "win32" ? path.win32 : path.posix;
  const appData = readNonEmptyString(env.APPDATA) ?? p.join(home, "AppData", "Roaming");
  const dataRoot = osUserDataDir(platform, env, home);

  const candidates: string[] = [];
  const addPlatform = (value: string | undefined): void => {
    const trimmed = readNonEmptyString(value);
    if (trimmed === undefined) return;
    const resolved = p.resolve(trimmed);
    if (!candidates.includes(resolved)) candidates.push(resolved);
  };
  // 使用者明確給的路徑是「目前這台機器」的路徑，用原生規則解析（不要套用模擬平台）。
  const addNative = (value: string | undefined): void => {
    const trimmed = readNonEmptyString(value);
    if (trimmed === undefined) return;
    const resolved = path.resolve(trimmed);
    if (!candidates.includes(resolved)) candidates.push(resolved);
  };

  addNative(input.runtimeFile);
  addNative(env.MNEMOSHELF_RUNTIME_FILE);
  // server 的資料目錄若被明確覆寫，runtime 檔就在同一個目錄（CLI／headless 常見）。
  const explicitDataDir = readNonEmptyString(env.MNEMOSHELF_DATA_DIR);
  if (explicitDataDir !== undefined) addNative(path.join(explicitDataDir, "runtime.json"));

  if (platform === "win32") {
    addPlatform(p.join(appData, "Mnemoshelf", "data", "runtime.json"));
    addPlatform(p.join(appData, "mnemoshelf", "runtime.json"));
  } else if (platform === "darwin") {
    addPlatform(p.join(home, "Library", "Application Support", "Mnemoshelf", "data", "runtime.json"));
    addPlatform(p.join(home, "Library", "Application Support", "mnemoshelf", "runtime.json"));
  } else {
    addPlatform(p.join(home, ".config", "Mnemoshelf", "data", "runtime.json"));
    addPlatform(p.join(dataRoot, "mnemoshelf", "runtime.json"));
  }
  return candidates;
}

/** 解析 runtime 檔文字；格式不符回 `null`（不猜、不用半份資料）。 */
export function parseRuntimeFile(text: string): RuntimeFileRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (record.schemaVersion !== 1) return null;
  if (typeof record.url !== "string" || typeof record.token !== "string") return null;
  if (record.url.trim() === "" || record.token.trim() === "") return null;
  if (typeof record.pid !== "number" || !Number.isInteger(record.pid) || record.pid <= 0) return null;
  return {
    schemaVersion: 1,
    url: record.url,
    token: record.token,
    pid: record.pid,
    ...(typeof record.startedAt === "string" ? { startedAt: record.startedAt } : {}),
    ...(typeof record.appVersion === "string" ? { appVersion: record.appVersion } : {}),
  };
}

/** 讀 runtime 檔並解析；任何錯誤都回 `null`。 */
export async function readRuntimeFile(
  file: string,
  readFileImpl: (file: string) => Promise<string> = (target) => fs.readFile(target, "utf8"),
): Promise<RuntimeFileRecord | null> {
  try {
    return parseRuntimeFile(await readFileImpl(file));
  } catch {
    return null;
  }
}

export type HealthCheckResult =
  | { ok: true; info: HealthInfo }
  | { ok: false; reason: "timeout" | "unreachable" | "not-json" | "wrong-service" | "http-error" };

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
    });
    // 非 2xx 是「這個位址有回應，但不是我們要的服務」→ 身分不明，不是暫時連不上。
    if (!response.ok) return { ok: false, reason: "http-error" };
    let info: HealthInfo;
    try {
      info = (await response.json()) as HealthInfo;
    } catch {
      return { ok: false, reason: "not-json" };
    }
    if (info.service !== "mnemoshelf") return { ok: false, reason: "wrong-service" };
    return { ok: true, info };
  } catch {
    return { ok: false, reason: controller.signal.aborted ? "timeout" : "unreachable" };
  } finally {
    clearTimeout(timer);
  }
}

/** POSIX 上確認 pid 還活著；Windows 沒有可靠的 signal 0，直接視為通過（文件有註明）。 */
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
    // EPERM＝行程存在但屬於別的使用者（本服務是同一使用者，仍視為活著）。
    return (error as NodeJS.ErrnoException | undefined)?.code === "EPERM";
  }
}

/** 連線解析失敗的原因（給 `/memory` 顯示；不含檔案內容）。 */
export type ConnectionFailureReason =
  | "no-config"
  | "runtime-missing"
  | "runtime-invalid"
  | "url-invalid"
  | "identity-mismatch"
  | "pid-dead"
  | "health-timeout"
  | "health-unreachable"
  /**
   * `/health` 有回應但**不是 mnemoshelf**（service 不符、不是 JSON、非 2xx）。
   *
   * 這是確定性失敗：位址上跑的是別的程式，舊連線（含全權 token）不能再送過去。
   */
  | "health-identity-mismatch";

export interface ConnectionResolution {
  connection: Connection | null;
  reason: ConnectionFailureReason | null;
  /** 嘗試過的 runtime 檔路徑（只給診斷顯示；不含內容）。 */
  candidates: string[];
  /** 是否曾嘗試讀 runtime 檔。 */
  triedRuntime: boolean;
}

export interface ResolveConnectionInput {
  options: Record<string, unknown>;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
  fetchImpl?: typeof fetch;
  readFileImpl?: (file: string) => Promise<string>;
  killImpl?: (pid: number, signal: 0) => void;
  healthTimeoutMs?: number;
}

function failure(
  reason: ConnectionFailureReason,
  candidates: string[],
  triedRuntime: boolean,
): ConnectionResolution {
  return { connection: null, reason, candidates, triedRuntime };
}

/**
 * 依優先序解析連線；runtime 檔的憑證一律先驗身分。
 *
 * 這個函式只讀檔／打 `/health`，不寫任何東西、也不記 token。
 */
export async function resolveConnection(input: ResolveConnectionInput): Promise<ConnectionResolution> {
  const options = input.options ?? {};
  const env = input.env ?? process.env;
  const platform = input.platform ?? process.platform;
  const home = input.home ?? os.homedir();
  const readFileImpl = input.readFileImpl ?? ((file: string) => fs.readFile(file, "utf8"));
  const fetchImpl = input.fetchImpl ?? fetch;

  const optionUrl = normalizeBaseUrl(readNonEmptyString(options.baseUrl));
  const optionToken = readNonEmptyString(options.token);
  const envUrl = normalizeBaseUrl(readNonEmptyString(env.MNEMOSHELF_URL));
  const envToken = readNonEmptyString(env.MNEMOSHELF_TOKEN);

  let url = optionUrl ?? envUrl;
  let token = optionToken ?? envToken;
  const usedOptions = optionUrl !== undefined || optionToken !== undefined;
  const usedEnv = envUrl !== undefined || envToken !== undefined;

  const needRuntime = url === undefined || token === undefined;
  const candidates = needRuntime
    ? runtimeCandidates({ platform, env, home, ...(readNonEmptyString(options.runtimeFile) === undefined
        ? {}
        : { runtimeFile: readNonEmptyString(options.runtimeFile) as string }) })
    : [];
  let record: RuntimeFileRecord | null = null;
  if (needRuntime) {
    for (const candidate of candidates) {
      const found = await readRuntimeFile(candidate, readFileImpl);
      if (found !== null) {
        record = found;
        break;
      }
    }
  }

  const explicitRuntime =
    readNonEmptyString(options.runtimeFile) !== undefined ||
    readNonEmptyString(env.MNEMOSHELF_RUNTIME_FILE) !== undefined;
  let usedRuntime = false;
  let candidateUrlInvalid = false;
  if (url === undefined && record !== null) {
    const normalized = normalizeBaseUrl(record.url);
    if (normalized === undefined) {
      candidateUrlInvalid = true;
    } else {
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
      if (record === null) {
        return failure(explicitRuntime ? "runtime-missing" : "no-config", candidates, true);
      }
      if (candidateUrlInvalid) return failure("url-invalid", candidates, true);
    }
    return failure("no-config", candidates, needRuntime);
  }

  // 有 runtime 憑證：比對 health 與 pid。options／env 的 URL 若與 runtime 檔不同，
  // 代表 token 的歸屬不明，寧可不用。
  if (usedRuntime) {
    if (record === null) return failure("runtime-invalid", candidates, true);
    if (normalizeBaseUrl(record.url) !== url) return failure("identity-mismatch", candidates, true);
    if (!isProcessAlive(record.pid, platform, input.killImpl)) return failure("pid-dead", candidates, true);
    const health = await checkHealth({
      baseUrl: url,
      ...(input.healthTimeoutMs === undefined ? {} : { timeoutMs: input.healthTimeoutMs }),
      fetchImpl,
    });
    if (!health.ok) {
      // timeout／unreachable 是暫時性（服務可能只是忙線／重啟中）；其餘代表 `/health`
      // 有回應但不是 mnemoshelf → 確定性身分失敗，呼叫端必須清掉舊連線、不送 token。
      const reason: ConnectionFailureReason =
        health.reason === "timeout"
          ? "health-timeout"
          : health.reason === "unreachable"
            ? "health-unreachable"
            : "health-identity-mismatch";
      return failure(reason, candidates, true);
    }
    const source: ConnectionSource = usedOptions ? "options" : usedEnv ? "env" : "runtime";
    return {
      connection: {
        baseUrl: url,
        token,
        source,
        ...(health.info.appVersion === undefined ? {} : { appVersion: health.info.appVersion }),
      },
      reason: null,
      candidates,
      triedRuntime: true,
    };
  }

  const source: ConnectionSource = usedOptions ? "options" : "env";
  return { connection: { baseUrl: url, token, source }, reason: null, candidates, triedRuntime: false };
}

/** 給 `/memory` 用：把失敗原因轉成一句人看得懂的話（不含路徑）。 */
export function describeConnectionFailure(reason: ConnectionFailureReason | null): string {
  switch (reason) {
    case "no-config":
      return "找不到連線設定（可設 MNEMOSHELF_URL／MNEMOSHELF_TOKEN，或開啟 runtime.json）";
    case "runtime-missing":
      return "runtime 檔不存在或無法讀取（請確認路徑或設定 MNEMOSHELF_RUNTIME_FILE）";
    case "runtime-invalid":
      return "runtime 檔格式不符（schemaVersion／url／token／pid）";
    case "url-invalid":
      return "runtime 檔的 url 不是有效的 http(s) 位址";
    case "identity-mismatch":
      return "身分比對失敗（runtime 檔的 url 與連線來源不一致）";
    case "pid-dead":
      return "runtime 檔的服務行程已不存在（pid 不存活）";
    case "health-timeout":
      return "GET /health 逾時（服務沒有回應）";
    case "health-unreachable":
      return "GET /health 連線失敗（服務暫時無法連上）";
    case "health-identity-mismatch":
      return "GET /health 回應不是 mnemoshelf（身分比對失敗；不送 token）";
    default:
      // `null` 只會出現在「還沒有任何解析結果」時（或解析結果本身沒有原因碼）；
      // 不能說成「已連線」——呼叫端只在未連線時問這句話。
      return "尚未檢查連線（還沒有連線解析結果）";
  }
}

/** 只在測試與 `/memory` 使用的簡易 log（正式流程由 `createRuntime` 注入）。 */
export const defaultLog: LogFn = (message) => {
  console.error(message);
};
