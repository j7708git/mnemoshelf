/**
 * MCP stdio 入口的連線解析：環境變數優先，其次是 agent 連線資訊檔（`runtime.json`）。
 *
 * 為什麼需要這一層：桌面版已經會寫出 `runtime.json`（含網址與 token），但 MCP 入口原本
 * 只讀 `MNEMOSHELF_URL`／`MNEMOSHELF_TOKEN` 兩個環境變數，使用者得手動複製貼上 token。
 * 讓入口也能讀 `runtime.json`，「裝好應用程式 → 設定 MCP → 直接可用」就成立，
 * 而且**不需要把 token 放進剪貼簿或設定檔**。
 *
 * 連線優先序（`resolveMcpConnection`）：
 *
 * 1. `MNEMOSHELF_URL` **與** `MNEMOSHELF_TOKEN` 都設定 → 直接用（來源 `env`）。
 *    這是使用者明確指定的連線，不做身分驗證。
 * 2. 否則讀 `runtime.json`（來源 `runtime`）。讀到的憑證**一律先驗身分**再使用：
 *    - 網址必須與 `runtime.json` 記的一致（環境變數給了別的網址 → 拒絕：token 歸屬不明）；
 *    - `runtime.json` 記的 pid 必須還活著（POSIX；Windows 沒有可靠的 signal 0，略過）；
 *    - `GET <url>/health`（**不帶 Authorization**）必須回 `service === "mnemoshelf"`。
 *
 * 第 2 步的三道檢查是為了避免「過期的檔 ＋ 被重用的埠」把全權 token 送到無關的本機程式。
 * 驗證失敗一律視同未連線：**不送 token、不重試猜測**。
 *
 * 安全邊界（docs/roots-and-privacy.md §信任模型）：`runtime.json` 的 `0600` 只擋其他使用者，
 * 不擋同使用者身分的程式；`agent` 只是來源標記，不是身分驗證。
 */
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parseRuntimeFile, type AgentRuntimeFile } from "../agent-discovery.js";
import { loadMcpConfig, type McpConfig } from "../config.js";
import { McpConnectionError, MissingMcpConfigError, type McpConnectionFailureReason } from "../errors.js";
import { SERVICE_NAME } from "../http/app.js";

/** 讀非空字串；空白視為未設定。 */
function readNonEmptyString(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** 去掉尾端斜線（基底網址正規化）。 */
function normalizeBaseUrl(value: string | undefined): string | undefined {
  const trimmed = readNonEmptyString(value);
  if (trimmed === undefined) return undefined;
  return trimmed.replace(/\/+$/, "");
}

/** `GET /health` 的回應（只取需要的欄位）。 */
interface HealthInfo {
  service?: unknown;
  appVersion?: unknown;
}

/** 連線來源的標記（給除錯與 `/memory` 顯示用）。 */
export type McpConnectionSource = "env" | "runtime";

/** `GET /health` 的結果。 */
export type HealthCheckResult =
  | { ok: true; appVersion: string | null }
  | { ok: false; reason: "timeout" | "unreachable" | "not-json" | "wrong-service" | "http-error" };

/** `/health` 的逾時（毫秒）。逾時算「暫時連不上」，與「確定不是 mnemoshelf」分開。 */
export const MCP_HEALTH_TIMEOUT_MS = 5_000;

/**
 * 依序回傳可能存在的 runtime 檔路徑（去重、保留順序）。
 *
 * 桌面版多一層 `data`：`<userData>/data/runtime.json`；CLI 是 `<OS 資料目錄>/mnemoshelf/runtime.json`。
 * 兩者刻意不同（大小寫也不同），不要合併成同一個路徑。
 *
 * 順序：明確指定的路徑 → 明確指定的資料目錄 → 依平台的預設位置。
 */
export function runtimeCandidates(input: {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
}): string[] {
  const platform = input.platform ?? process.platform;
  const env = input.env ?? process.env;
  const home = input.home ?? homedir();
  // 依目標平台選路徑規則：正式流程的 platform 就是 process.platform；測試可注入。
  const p = platform === "win32" ? path.win32 : path.posix;
  const appData = readNonEmptyString(env.APPDATA) ?? p.join(home, "AppData", "Roaming");
  const dataRoot = osUserDataDir(platform, env, home);

  const candidates: string[] = [];
  const addNative = (value: string | undefined): void => {
    const trimmed = readNonEmptyString(value);
    if (trimmed === undefined) return;
    const resolved = path.resolve(trimmed);
    if (!candidates.includes(resolved)) candidates.push(resolved);
  };
  const addPlatform = (value: string | undefined): void => {
    const trimmed = readNonEmptyString(value);
    if (trimmed === undefined) return;
    const resolved = p.resolve(trimmed);
    if (!candidates.includes(resolved)) candidates.push(resolved);
  };

  // 使用者明確給的路徑是「目前這台機器」的路徑，用原生規則解析（不要套用模擬平台）。
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
    // 桌面版的 userData 尊重 XDG_CONFIG_HOME；CLI 的資料目錄尊重 XDG_DATA_HOME。
    const configRoot = readNonEmptyString(env.XDG_CONFIG_HOME) ?? p.join(home, ".config");
    addPlatform(p.join(configRoot, "Mnemoshelf", "data", "runtime.json"));
    addPlatform(p.join(dataRoot, "mnemoshelf", "runtime.json"));
  }
  return candidates;
}

/**
 * OS 使用者資料目錄（跨平台，不硬寫分隔符；與 server 的 `config.ts` 同一套規則）。
 *
 * 與 `config.ts` 的 `osUserDataDir` 重複是刻意的：那個是私有的、給 server 啟動用；
 * 這裡需要跨平台（測試會注入 platform），所以各自一份、規則一致。
 */
function osUserDataDir(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string): string {
  if (platform === "win32") {
    const appData = readNonEmptyString(env.APPDATA);
    return appData ?? path.win32.join(home, "AppData", "Roaming");
  }
  if (platform === "darwin") return path.posix.join(home, "Library", "Application Support");
  const xdg = readNonEmptyString(env.XDG_DATA_HOME);
  return xdg ?? path.posix.join(home, ".local", "share");
}

/** POSIX 上確認 pid 還活著；Windows 沒有可靠的 signal 0，直接視為通過（與外掛同一語意）。 */
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

/** 打 `GET /health`（不帶 Authorization）確認服務身分。 */
export async function checkServiceHealth(input: {
  baseUrl: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<HealthCheckResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? MCP_HEALTH_TIMEOUT_MS);
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
    if (info.service !== SERVICE_NAME) return { ok: false, reason: "wrong-service" };
    return { ok: true, appVersion: typeof info.appVersion === "string" ? info.appVersion : null };
  } catch {
    return { ok: false, reason: controller.signal.aborted ? "timeout" : "unreachable" };
  } finally {
    clearTimeout(timer);
  }
}

/** 連線解析失敗的原因（穩定字串，可程式比對；不含路徑與 token）。 */
export type { McpConnectionFailureReason } from "../errors.js";

/** 連線解析成功的結果。 */
export interface McpConnection {
  /** 給 MCP server 用的連線設定。 */
  config: McpConfig;
  /** 憑證來自環境變數還是連線資訊檔。 */
  source: McpConnectionSource;
}

/** `resolveMcpConnection` 的輸入（測試可注入每個外部依賴）。 */
export interface ResolveMcpConnectionOptions {
  /** 環境變數來源；預設 `process.env`。 */
  env?: NodeJS.ProcessEnv;
  /** 目標平台；預設 `process.platform`。 */
  platform?: NodeJS.Platform;
  /** 家目錄；預設 `os.homedir()`。 */
  home?: string;
  /** 測試注入的 `fetch`；預設全域 `fetch`。 */
  fetchImpl?: typeof fetch;
  /** 測試注入的讀檔；預設 `fs.readFile`。 */
  readFileImpl?: (file: string) => Promise<string>;
  /** 測試注入的行程存活檢查；預設 `process.kill(pid, 0)`。 */
  killImpl?: (pid: number, signal: 0) => void;
  /** `/health` 的逾時（毫秒）。 */
  healthTimeoutMs?: number;
}

/**
 * 解析 MCP 入口的連線設定。
 *
 * 找不到任何可用連線時丟 `McpConnectionError`（含穩定的 `reason`）；
 * 環境變數不完整時，錯誤訊息會指出缺哪一個。
 */
export async function resolveMcpConnection(options: ResolveMcpConnectionOptions = {}): Promise<McpConnection> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();
  const readFileImpl = options.readFileImpl ?? ((file: string) => fs.readFile(file, "utf8"));

  // 1) 環境變數兩個都有 → 直接用。這是使用者明確指定的連線，不做身分驗證。
  try {
    return { config: loadMcpConfig(env), source: "env" };
  } catch (error) {
    if (!(error instanceof MissingMcpConfigError)) throw error;
    // 2) 否則改用連線資訊檔；缺哪個環境變數要寫進錯誤訊息。
    const missingEnv = error.missing;
    const candidates = runtimeCandidates({ platform, env, home });

    let record: AgentRuntimeFile | null = null;
    let sawInvalid = false;
    for (const candidate of candidates) {
      let text: string;
      try {
        text = await readFileImpl(candidate);
      } catch {
        // 檔案不存在或讀不到 → 換下一個候選位置。
        continue;
      }
      const parsed = parseRuntimeFile(text);
      if (parsed === null) {
        // 檔案在，但內容不是合法的連線資訊 → 記下來；沒有其他可用候選時才報錯。
        sawInvalid = true;
        continue;
      }
      record = parsed;
      break;
    }

    if (record === null) {
      const explicitRuntime = readNonEmptyString(env.MNEMOSHELF_RUNTIME_FILE) !== undefined;
      const reason: McpConnectionFailureReason = sawInvalid
        ? "runtime-invalid"
        : explicitRuntime
          ? "runtime-missing"
          : "no-config";
      throw new McpConnectionError(
        reason,
        `${describeMcpConnectionFailure(reason)}（缺少的環境變數：${missingEnv.join("、")}）`,
      );
    }

    const url = normalizeBaseUrl(record.url);
    if (url === undefined) {
      throw new McpConnectionError(
        "runtime-invalid",
        describeMcpConnectionFailure("runtime-invalid"),
      );
    }

    // 環境變數有給網址、卻與連線資訊檔不一致 → token 的歸屬不明，寧可不用。
    const envUrl = normalizeBaseUrl(env.MNEMOSHELF_URL);
    if (envUrl !== undefined && envUrl !== url) {
      throw new McpConnectionError(
        "identity-mismatch",
        describeMcpConnectionFailure("identity-mismatch"),
      );
    }

    if (!isProcessAlive(record.pid, platform, options.killImpl)) {
      throw new McpConnectionError("pid-dead", describeMcpConnectionFailure("pid-dead"));
    }

    const health = await checkServiceHealth({
      baseUrl: url,
      ...(options.healthTimeoutMs === undefined ? {} : { timeoutMs: options.healthTimeoutMs }),
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    });
    if (!health.ok) {
      const reason: McpConnectionFailureReason =
        health.reason === "timeout"
          ? "health-timeout"
          : health.reason === "unreachable"
            ? "health-unreachable"
            : "health-identity-mismatch";
      throw new McpConnectionError(reason, describeMcpConnectionFailure(reason));
    }

    // 讀到 runtime 檔了：token 來自檔案，網址也以檔案為準。
    const projectSetting = readNonEmptyString(env.MNEMOSHELF_PROJECT);
    return {
      config: {
        url,
        token: record.token,
        ...(projectSetting === undefined ? {} : { project: projectSetting }),
      },
      source: "runtime",
    };
  }
}

/** 失敗原因轉成一句使用者看得懂的話（不含路徑、不含 token）。 */
export function describeMcpConnectionFailure(reason: McpConnectionFailureReason): string {
  switch (reason) {
    case "no-config":
      return "找不到連線設定：請設定 MNEMOSHELF_URL 與 MNEMOSHELF_TOKEN，或在 Mnemoshelf 的「Agent 連線資訊」開啟連線資訊檔";
    case "runtime-missing":
      return "找不到 agent 連線資訊檔（runtime.json）：請確認 Mnemoshelf 正在執行且該功能已開啟，或直接設定 MNEMOSHELF_URL 與 MNEMOSHELF_TOKEN";
    case "runtime-invalid":
      return "agent 連線資訊檔格式不符（需要 schemaVersion、url、token、pid）";
    case "identity-mismatch":
      return "環境變數 MNEMOSHELF_URL 與連線資訊檔的網址不一致，無法確定 token 屬於哪個服務，已拒絕使用";
    case "pid-dead":
      return "連線資訊檔所指的服務行程已經結束（可能是上次執行留下的舊檔）；請重新啟動 Mnemoshelf";
    case "health-timeout":
      return "連線資訊檔所指的服務沒有在期限內回應；請確認 Mnemoshelf 正在執行";
    case "health-unreachable":
      return "連線資訊檔所指的服務連不上；請確認 Mnemoshelf 正在執行";
    case "health-identity-mismatch":
      return "連線資訊檔所指的位址上不是 Mnemoshelf 服務（可能是埠被其他程式占用）；已拒絕送出 token";
    default:
      return "無法解析 MCP 連線設定";
  }
}
