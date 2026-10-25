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
 *    - 網址必須是本機 loopback（`127.0.0.1`／`localhost`；不是就拒絕，且不送任何請求）；
 *    - 網址必須與 `runtime.json` 記的一致（環境變數給了別的網址 → 拒絕：token 歸屬不明）；
 *    - `runtime.json` 記的 pid 必須還活著（POSIX；Windows 沒有可靠的 signal 0，略過）；
 *    - `GET <url>/health`（**不帶 Authorization**）必須回 `service === "mnemoshelf"`。
 *
 * 第 2 步找檔案時**明確指定即不猜**：`MNEMOSHELF_RUNTIME_FILE` 或 `MNEMOSHELF_DATA_DIR` 有設定時
 * 只試那個位置，讀不到就是 `runtime-missing`，不退回平台預設路徑（否則可能連到另一個服務實例，
 * 資料庫還可能不同）。只有兩個都沒設定時才依平台預設位置尋找。
 *
 * 第 2 步的檢查**降低的是「無關程式不小心佔用同一個埠」的風險**（例如上次的服務結束後，
 * 另一個本機程式剛好拿到同一個埠）。它**不防刻意偽造 `/health` 的程式**：`/health` 只是免 token 的
 * `{service:"mnemoshelf"}`，任何程式都能回一樣的內容。Windows 上沒有 pid 檢查（沒有可靠的 signal 0）；
 * POSIX 的 pid 檢查也只確認「這個 pid 還活著」，不確認它是不是 Mnemoshelf。因此這些檢查
 * **不能**保證 token 不會被送到錯的程式；共用機器的多人情境請不要開啟連線資訊檔功能，
 * 或改用獨立帳號／獨立資料目錄。
 *
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

/**
 * 網址是否為單純的本機 loopback 基底網址。
 *
 * 條件（全部成立才算）：
 * - 協定只接受 `http:`／`https:`（`file://127.0.0.1/...` 這種本機檔案 URL 一律拒絕）；
 * - 主機是 `127.0.0.1` 或 `localhost`（大小寫不拘；主機字串由 `URL` 正規化，
 *   因此 `2130706433`、`0x7f000001`、`0177.0.0.1`、`127.1` 都會被視為 `127.0.0.1`）；
 * - 不含帳密、查詢字串或片段（`runtime.json` 的 `url` 是基底網址；帶這些東西會被拼成
 *   錯誤的 `/health` 或讓 fetch 直接拒絕帶帳密的網址）。
 *
 * 為什麼要在送出任何請求之前檢查：`runtime.json` 是同使用者的程式可改寫的檔案
 * （見 `docs/roots-and-privacy.md` §信任模型）。若 `url` 被改成外部位址，
 * `GET /health` 這一步反而會把請求（與後續的 token）帶到本機之外；因此網址不是
 * 單純的 loopback 基底就直接拒絕，**一個請求都不送**。`localhost` 的解析結果由系統決定，
 * 這裡只做字面比對，與 `docs/agent-integration.md` 的契約一致。
 */
function isLoopbackBaseUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  if (parsed.username !== "" || parsed.password !== "") return false;
  if (parsed.search !== "" || parsed.hash !== "") return false;
  const hostname = parsed.hostname.toLowerCase();
  return hostname === "127.0.0.1" || hostname === "localhost";
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

/** runtime 候選路徑的解析結果（內部用；對外只提供 `runtimeCandidates`）。 */
interface RuntimeCandidatePlan {
  /** 依序嘗試的路徑（已去重）。 */
  candidates: string[];
  /**
   * 位置是否由使用者**明確指定**（`MNEMOSHELF_RUNTIME_FILE` 或 `MNEMOSHELF_DATA_DIR`）。
   *
   * 釘住時 `candidates` 只有那一個路徑，而且讀不到就是 `runtime-missing`：
   * **不得再退回平台預設路徑**（否則會連到另一個服務實例，可能是不同的資料庫）。
   */
  pinned: boolean;
}

/**
 * 算出 runtime 檔的候選路徑。三段**互斥**：
 *
 * 1. `MNEMOSHELF_RUNTIME_FILE` 有設定 → 只有那一個路徑。
 * 2. 否則 `MNEMOSHELF_DATA_DIR` 有設定 → 只有 `<MNEMOSHELF_DATA_DIR>/runtime.json`。
 * 3. 否則 → 依平台的預設位置（桌面版 `data` 路徑 ＋ CLI 資料目錄，順序固定）。
 *
 * 明確指定就代表「我要連這個檔案對應的服務」；再往下猜會讓 agent 連上另一個實例
 * （可能用不同的資料庫），因此第 1、2 段都**不再接平台預設候選**。
 */
function resolveRuntimeCandidatePlan(input: {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
}): RuntimeCandidatePlan {
  const platform = input.platform ?? process.platform;
  const env = input.env ?? process.env;
  const home = input.home ?? homedir();
  // 依目標平台選路徑規則：正式流程的 platform 就是 process.platform；測試可注入。
  const p = platform === "win32" ? path.win32 : path.posix;
  const appData = readNonEmptyString(env.APPDATA) ?? p.join(home, "AppData", "Roaming");
  const dataRoot = osUserDataDir(platform, env, home);

  // 1) 明確指定的檔案位置：只用這一個。使用者給的路徑是「目前這台機器」的路徑，
  //    用原生規則解析（不要套用模擬平台）。
  const explicitFile = readNonEmptyString(env.MNEMOSHELF_RUNTIME_FILE);
  if (explicitFile !== undefined) return { candidates: [path.resolve(explicitFile)], pinned: true };

  // 2) 明確指定的資料目錄：runtime 檔就在同一個目錄（CLI／headless 常見）。
  const explicitDataDir = readNonEmptyString(env.MNEMOSHELF_DATA_DIR);
  if (explicitDataDir !== undefined) {
    return {
      candidates: [path.resolve(path.join(explicitDataDir, "runtime.json"))],
      pinned: true,
    };
  }

  // 3) 平台預設位置（桌面版與 CLI 的路徑刻意不同，不要合併）。
  const candidates: string[] = [];
  const addPlatform = (value: string | undefined): void => {
    const trimmed = readNonEmptyString(value);
    if (trimmed === undefined) return;
    const resolved = p.resolve(trimmed);
    if (!candidates.includes(resolved)) candidates.push(resolved);
  };

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
  return { candidates, pinned: false };
}

/**
 * 依序回傳可能存在的 runtime 檔路徑（去重、保留順序）。
 *
 * 桌面版多一層 `data`：`<userData>/data/runtime.json`；CLI 是 `<OS 資料目錄>/mnemoshelf/runtime.json`。
 * 兩者刻意不同（大小寫也不同），不要合併成同一個路徑。
 *
 * **明確指定即不猜**：`MNEMOSHELF_RUNTIME_FILE` 或 `MNEMOSHELF_DATA_DIR` 有設定時，回傳的
 * 清單**只有那一個**路徑（見 `resolveRuntimeCandidatePlan`）；只有兩者都沒設定時才回傳平台預設
 * 候選。讀不到時由呼叫端回報 `runtime-missing`，不會改試別的位置。
 */
export function runtimeCandidates(input: {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
}): string[] {
  return resolveRuntimeCandidatePlan(input).candidates;
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
      // `/health` 不該被導到別的位址：導向會把請求（與後續的 token 判斷）帶離原本的服務。
      redirect: "error",
      signal: controller.signal,
    });
    // 非 2xx 是「這個位址有回應，但不是我們要的服務」→ 身分不明，不是暫時連不上。
    if (!response.ok) return { ok: false, reason: "http-error" };
    let info: unknown;
    try {
      info = (await response.json()) as unknown;
    } catch {
      return { ok: false, reason: "not-json" };
    }
    // 回應必須是物件：JSON `null`（或陣列、字串、數字）一律視為身分不符，
    // 不能讓 `null.service` 這種存取拋 TypeError 而被誤分類成「連不上」。
    if (typeof info !== "object" || info === null || Array.isArray(info)) {
      return { ok: false, reason: "wrong-service" };
    }
    const record = info as HealthInfo;
    if (typeof record.service !== "string" || record.service !== SERVICE_NAME) {
      return { ok: false, reason: "wrong-service" };
    }
    return { ok: true, appVersion: typeof record.appVersion === "string" ? record.appVersion : null };
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
    // 明確指定（檔案或資料目錄）時候選只有那一個，且不再退回平台預設路徑。
    const plan = resolveRuntimeCandidatePlan({ platform, env, home });
    const candidates = plan.candidates;

    let record: AgentRuntimeFile | null = null;
    let sawInvalid = false;
    for (const candidate of candidates) {
      let text: string;
      try {
        text = await readFileImpl(candidate);
      } catch {
        // 檔案不存在或讀不到 → 換下一個候選位置（只有「未明確指定」時才可能有多個）。
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
      // 位置被釘住（明確指定）卻讀不到 → runtime-missing；讀到了但不合法 → runtime-invalid；
      // 完全沒有線索（未指定、平台預設也沒有）→ no-config。
      const reason: McpConnectionFailureReason = sawInvalid
        ? "runtime-invalid"
        : plan.pinned
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

    // 網址必須是本機 loopback：不是就拒絕，且**不送任何請求**（含不帶 token 的 `/health`）。
    if (!isLoopbackBaseUrl(url)) {
      throw new McpConnectionError(
        "url-not-loopback",
        describeMcpConnectionFailure("url-not-loopback"),
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

/**
 * 每個失敗代碼對應一句使用者看得懂的話（不含路徑、不含 token）。
 *
 * 刻意用 `Record<McpConnectionFailureReason, string>`：新增失敗代碼時這裡必須補齊，
 * 否則 TypeScript 編譯不過。不要改回 `switch` ＋ `default`——`default` 會把漏掉的代碼吞掉。
 */
export const MCP_CONNECTION_FAILURE_MESSAGES: Record<McpConnectionFailureReason, string> = {
  "no-config":
    "找不到連線設定：請設定 MNEMOSHELF_URL 與 MNEMOSHELF_TOKEN，或在 Mnemoshelf 的「Agent 連線資訊」開啟連線資訊檔",
  "runtime-missing":
    "找不到 agent 連線資訊檔（runtime.json）：請確認 Mnemoshelf 正在執行且該功能已開啟，或直接設定 MNEMOSHELF_URL 與 MNEMOSHELF_TOKEN",
  "runtime-invalid":
    "agent 連線資訊檔格式不符：需要 schemaVersion 為 1、非空的 url 與 token、正整數 pid，且 startedAt 與 appVersion 都是字串",
  "url-not-loopback":
    "agent 連線資訊檔的網址不是單純的本機 loopback 基底網址（只接受 http／https、主機 127.0.0.1 或 localhost，且不含帳密、查詢字串或片段）；已拒絕使用，且沒有送出任何請求或 token",
  "identity-mismatch":
    "環境變數 MNEMOSHELF_URL 與連線資訊檔的網址不一致，無法確定 token 屬於哪個服務，已拒絕使用",
  "pid-dead":
    "連線資訊檔所指的服務行程已經結束（可能是上次執行留下的舊檔）；請重新啟動 Mnemoshelf",
  "health-timeout": "連線資訊檔所指的服務沒有在期限內回應；請確認 Mnemoshelf 正在執行",
  "health-unreachable": "連線資訊檔所指的服務連不上；請確認 Mnemoshelf 正在執行",
  "health-identity-mismatch":
    "連線資訊檔所指的位址上不是 Mnemoshelf 服務（可能是埠被其他程式占用）；已拒絕送出 token",
};

/** 失敗原因轉成一句使用者看得懂的話（不含路徑、不含 token）。 */
export function describeMcpConnectionFailure(reason: McpConnectionFailureReason): string {
  return MCP_CONNECTION_FAILURE_MESSAGES[reason];
}
