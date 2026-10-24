/**
 * Agent 連線資訊檔（`runtime.json`）：讓同一台機器上的 agent 不必手動複製 token。
 *
 * 檔案位置預設 `<dataDir>/runtime.json`（可由 `MNEMOSHELF_RUNTIME_FILE` 覆寫），內容：
 *
 * ```json
 * {
 *   "schemaVersion": 1,
 *   "url": "http://127.0.0.1:12345",
 *   "token": "<MNEMOSHELF_TOKEN>",
 *   "pid": 1234,
 *   "startedAt": "2026-10-21T00:00:00.000Z",
 *   "appVersion": "0.3.0"
 * }
 * ```
 *
 * 設計決策：
 * - **只在 `MNEMOSHELF_AGENT_DISCOVERY=on` 時寫**（預設 off）；檔案含全權 token，
 *   不該在未明示開啟時出現。
 * - **原子寫入**（同目錄的 `.tmp` 再 rename），權限 `0600`；任何失敗都先清掉 `.tmp`，
 *   不留下含 token 的半成品。寫入失敗不阻止 server 啟動，只記一則不含 token 的 warning。
 * - **關閉時只刪自己的檔**：檔案內的 `pid` 等於本行程才刪，避免誤刪另一個行程
 *   （例如 dev server 與桌面版同時存在）的連線資訊。
 * - **關閉功能時清殘留**：上次若被 SIGKILL／當機，檔案會留著；以 discovery=off 啟動時
 *   直接清除，否則「已關閉」的功能仍留下有效 token。
 * - 本模組**不得**把 token 印進 log；所有訊息都只描述路徑與動作。
 *
 * 安全邊界（與 `docs/agent-integration.md` 一致）：`0600` 只擋其他使用者，不擋同使用者
 * 身分的程式；同使用者程式仍可讀取、甚至改寫這個檔案。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

/** 檔案格式版本（未來若改欄位語意才遞增）。 */
export const AGENT_RUNTIME_SCHEMA_VERSION = 1;

/** `runtime.json` 的內容。 */
export interface AgentRuntimeFile {
  schemaVersion: typeof AGENT_RUNTIME_SCHEMA_VERSION;
  /** 服務網址（永遠是 `http://127.0.0.1:<port>`）。 */
  url: string;
  /** REST 的 Bearer token（本機全權）。 */
  token: string;
  /** 寫入檔案（＝啟動服務）的行程 pid。 */
  pid: number;
  /** 服務啟動時間（ISO 8601）。 */
  startedAt: string;
  /** 服務版本（與 `GET /health` 的 `appVersion` 相同）。 */
  appVersion: string;
}

/** 寫入檔案時需要的內容（`pid`／`startedAt` 由本模組填）。 */
export interface AgentRuntimeWriteInput {
  url: string;
  token: string;
}

/** 記錄訊息（預設 `console.error`；測試可注入）。 */
type Log = (message: string) => void;

const defaultLog: Log = (message) => {
  console.error(message);
};

/**
 * 格式錯誤或不可信時回傳 null（呼叫端不應拿去使用）。
 *
 * 這個解析器是 `runtime.json` 格式的**唯一權威**：寫出（`writeRuntimeFile`）與讀取
 * （`readRuntimeFile`）共用它，外部讀取者（例如 MCP 入口的連線解析）也用同一份規則，
 * 避免兩邊對「什麼算合法」有不同解讀。
 *
 * 驗證刻意偏嚴：網址與 token 不得為空、pid 必須是正整數。少一份就整份不可用——
 * 「用半份資料連線」比「連不上」更危險。
 */
export function parseRuntimeFile(text: string): AgentRuntimeFile | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (record.schemaVersion !== AGENT_RUNTIME_SCHEMA_VERSION) return null;
  if (typeof record.url !== "string" || record.url.trim() === "") return null;
  if (typeof record.token !== "string" || record.token.trim() === "") return null;
  if (typeof record.pid !== "number" || !Number.isInteger(record.pid) || record.pid <= 0) return null;
  if (typeof record.startedAt !== "string" || typeof record.appVersion !== "string") return null;
  return {
    schemaVersion: AGENT_RUNTIME_SCHEMA_VERSION,
    url: record.url,
    token: record.token,
    pid: record.pid,
    startedAt: record.startedAt,
    appVersion: record.appVersion,
  };
}

/**
 * 讀出連線資訊檔；不存在、格式錯誤或權限不足都回 `null`。
 *
 * `readFileImpl` 可注入（測試用）；預設走 `fs.readFile`。
 */
export async function readRuntimeFile(
  file: string,
  readFileImpl: (file: string) => Promise<string> = (target) => fs.readFile(target, "utf8"),
): Promise<AgentRuntimeFile | null> {
  let text: string;
  try {
    text = await readFileImpl(file);
  } catch {
    return null;
  }
  return parseRuntimeFile(text);
}

/** 刪除暫存檔（best-effort；不存在是正常情況）。 */
async function removeTempFile(file: string): Promise<void> {
  await fs.rm(`${file}.tmp`, { force: true }).catch(() => undefined);
}

/**
 * 以原子寫入產生連線資訊檔。
 *
 * 實作：先寫同目錄的 `<file>.tmp`（`0600`），再 `rename` 覆蓋正式檔。`rename` 在同一個
 * 檔案系統內是原子的，因此讀者不會看到半份 JSON。任何一步失敗都會清掉 `.tmp` 後拋錯；
 * 呼叫端（`createAgentDiscovery().write`）會把它降級成 warning，不阻止服務啟動。
 */
export async function writeRuntimeFile(
  file: string,
  record: Omit<AgentRuntimeFile, "schemaVersion" | "pid" | "startedAt"> & {
    pid?: number;
    startedAt?: string;
  },
): Promise<AgentRuntimeFile> {
  const payload: AgentRuntimeFile = {
    schemaVersion: AGENT_RUNTIME_SCHEMA_VERSION,
    url: record.url,
    token: record.token,
    pid: record.pid ?? process.pid,
    startedAt: record.startedAt ?? new Date().toISOString(),
    appVersion: record.appVersion,
  };
  const temp = `${file}.tmp`;
  const directory = path.dirname(file);
  try {
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(temp, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
    // umask 會影響 writeFile 的 mode；POSIX 上再明確 chmod 一次。Windows 沒有 POSIX mode，
    // 檔案位於使用者專屬的資料目錄（由使用者 profile 的 ACL 保護），沿用既有 best-effort 慣例。
    if (process.platform !== "win32") await fs.chmod(temp, 0o600);
    await fs.rename(temp, file);
    if (process.platform !== "win32") await fs.chmod(file, 0o600);
    return payload;
  } catch (error) {
    await removeTempFile(file);
    throw error;
  }
}

/**
 * 無條件刪除連線資訊檔（含殘留的 `.tmp`）。
 *
 * 用於「功能已關閉」與桌面版關閉開關（不需要判斷 pid：使用者已明確要求不要留檔）。
 */
export async function removeRuntimeFile(file: string): Promise<void> {
  await fs.rm(file, { force: true });
  await removeTempFile(file);
}

/**
 * 只在檔案內的 pid 等於 `pid` 時刪除；回傳是否真的刪了。
 *
 * 檔案不存在、格式壞掉或 pid 不同都回 `false`（不猜、不誤刪別人的檔）。
 * 格式壞掉時記一則 warning（不含檔案內容），讓「關閉後還有檔案」有線索可查。
 */
export async function removeRuntimeFileIfOwned(
  file: string,
  pid: number = process.pid,
  log: Log = defaultLog,
): Promise<boolean> {
  const record = await readRuntimeFile(file);
  if (record === null) {
    // 只有「檔案真的存在但讀不懂」才警告；不存在是正常情況。
    try {
      await fs.stat(file);
      log("[mnemoshelf] 連線資訊檔格式無法辨識，保留不刪（無法確認是不是本行程寫的）");
    } catch {
      // 檔案不存在：正常。
    }
    return false;
  }
  if (record.pid !== pid) return false;
  await fs.rm(file, { force: true });
  await removeTempFile(file);
  return true;
}

/**
 * 服務用的連線資訊檔生命週期。
 *
 * `createServer()` 依序呼叫：`clearStale()`（僅 discovery=off）→ `write()`（on）→
 * 關閉時 `removeIfOwned()`。所有失敗都只記錄，不讓服務起不來／關不掉。
 */
export interface AgentDiscovery {
  readonly enabled: boolean;
  readonly file: string;
  /** discovery=off 時清除上次殘留（含 `.tmp`）；on 時什麼都不做。 */
  clearStale(): Promise<void>;
  /** 寫出檔案；成功回 `true`。失敗記 warning（不含 token）並回 `false`。 */
  write(input: AgentRuntimeWriteInput): Promise<boolean>;
  /** 關閉時刪除「自己的」檔案（pid 不符則保留）。 */
  removeIfOwned(): Promise<void>;
  /** 無條件刪除（寫入後續失敗時清掉已寫出的檔）。 */
  remove(): Promise<void>;
}

export interface CreateAgentDiscoveryOptions {
  enabled: boolean;
  file: string;
  appVersion: string;
  /** 測試注入的 pid（預設本行程）。 */
  pid?: number;
  /** 測試注入的啟動時間。 */
  startedAt?: string;
  log?: Log;
}

/** 建立連線資訊檔的生命週期物件（不自行啟動任何計時器／背景工作）。 */
export function createAgentDiscovery(options: CreateAgentDiscoveryOptions): AgentDiscovery {
  const log = options.log ?? defaultLog;
  const pid = options.pid ?? process.pid;
  const file = path.resolve(options.file);

  return {
    enabled: options.enabled,
    file,
    async clearStale(): Promise<void> {
      if (options.enabled) return;
      // 上次 SIGKILL／當機留下的檔：功能已關閉，不能讓有效 token 留在磁碟上。
      try {
        await removeRuntimeFile(file);
      } catch (error) {
        log(
          `[mnemoshelf] 無法清除舊的連線資訊檔（discovery=off）：${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    },
    async write(input: AgentRuntimeWriteInput): Promise<boolean> {
      try {
        await writeRuntimeFile(file, {
          url: input.url,
          token: input.token,
          pid,
          appVersion: options.appVersion,
          ...(options.startedAt === undefined ? {} : { startedAt: options.startedAt }),
        });
        log("[mnemoshelf] 已寫出 agent 連線資訊檔（不含 token 的內容不會被記錄）");
        return true;
      } catch (error) {
        // 只記錄原因（例如 EACCES／ENOSPC），不記錄內容；檔案寫不出來不阻止服務啟動。
        log(
          `[mnemoshelf] 無法寫出 agent 連線資訊檔（服務照常執行）：${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return false;
      }
    },
    async removeIfOwned(): Promise<void> {
      try {
        await removeRuntimeFileIfOwned(file, pid, log);
      } catch (error) {
        log(
          `[mnemoshelf] 無法刪除 agent 連線資訊檔：${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    },
    async remove(): Promise<void> {
      try {
        await removeRuntimeFile(file);
      } catch (error) {
        log(
          `[mnemoshelf] 無法刪除 agent 連線資訊檔：${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    },
  };
}
