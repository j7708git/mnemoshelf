/**
 * 桌面版的最小設定持久化（`<userData>/agentSettings.json`，`0600`）。
 *
 * 目前只有一個設定：`agentDiscovery`（預設 **on**）——是否讓 server 寫出
 * `<dataDir>/runtime.json`，供同機的 agent／MCP client 自動取得網址與 token。
 *
 * 為什麼自己寫一個檔案：桌面版原本沒有通用 settings 機制（開機自啟的狀態是從 OS 讀回、
 * token 是唯讀），與其引入一套通用設定框架，不如照需求放一個最小、可稽核的 JSON。
 * 檔案沿用 `MNEMOSHELF_DESKTOP_USER_DATA` 的覆寫語意（`resolveDesktopPaths()` 已處理）。
 *
 * 行為：
 * - 讀檔失敗／格式不合法 → 回預設值（on）並記錄訊息；不讓應用起不來。
 * - 寫檔失敗 → 拋錯（呼叫端把錯誤顯示在設定頁）；設定沒有生效時不要假裝成功。
 * - **關閉開關時無條件立即刪除 runtime 檔**：token 跨重啟恆定，只靠「下次啟動不寫」
 *   等於把有效 token 留在磁碟上。刪除失敗回報 `error`，由設定頁顯示「連線資訊檔未清除」。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

/** 設定檔格式版本（未來若改欄位語意才遞增）。 */
export const AGENT_SETTINGS_SCHEMA_VERSION = 1;

/** 桌面版 agent 相關設定。 */
export interface AgentSettings {
  schemaVersion: number;
  /** 是否寫出 `runtime.json`（預設 true）。 */
  agentDiscovery: boolean;
}

/** 預設值：連線發現**開啟**（桌面版是單人本機應用，方便 agent 直接連上）。 */
export function defaultAgentSettings(): AgentSettings {
  return { schemaVersion: AGENT_SETTINGS_SCHEMA_VERSION, agentDiscovery: true };
}

type Log = (message: string) => void;

const defaultLog: Log = (message) => {
  console.error(`[mnemoshelf-desktop] ${message}`);
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 讀出設定；不存在或格式不合法時回預設值（不拋錯）。
 *
 * 只認 `agentDiscovery` 是 boolean 的合法值；其他欄位目前沒有，未來新增時要保持向後相容。
 */
export async function readAgentSettings(file: string, log: Log = defaultLog): Promise<AgentSettings> {
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      log(`讀取 agentSettings.json 失敗，使用預設值：${error instanceof Error ? error.message : String(error)}`);
    }
    return defaultAgentSettings();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    log("agentSettings.json 不是合法 JSON，使用預設值（agentDiscovery=on）");
    return defaultAgentSettings();
  }
  if (!isRecord(parsed) || typeof parsed.agentDiscovery !== "boolean") {
    log("agentSettings.json 缺少 agentDiscovery，使用預設值（agentDiscovery=on）");
    return defaultAgentSettings();
  }
  return { schemaVersion: AGENT_SETTINGS_SCHEMA_VERSION, agentDiscovery: parsed.agentDiscovery };
}

/**
 * 寫出設定（原子寫入、權限 `0600`）。
 *
 * 先寫 `<file>.tmp` 再 rename，避免中途失敗留下半份 JSON；失敗時清掉 `.tmp` 後拋錯。
 */
export async function writeAgentSettings(file: string, settings: AgentSettings): Promise<void> {
  const target = path.resolve(file);
  const temp = `${target}.tmp`;
  try {
    await fs.mkdir(path.dirname(target), { recursive: true });
    const body = `${JSON.stringify(
      { schemaVersion: AGENT_SETTINGS_SCHEMA_VERSION, agentDiscovery: settings.agentDiscovery },
      null,
      2,
    )}\n`;
    await fs.writeFile(temp, body, { mode: 0o600 });
    // umask 會影響 writeFile 的 mode；POSIX 上再明確 chmod。Windows 沒有 POSIX mode，
    // 檔案位於使用者專屬的 userData（由 profile ACL 保護），沿用既有 best-effort 慣例。
    if (process.platform !== "win32") await fs.chmod(temp, 0o600);
    await fs.rename(temp, target);
    if (process.platform !== "win32") await fs.chmod(target, 0o600);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * 連線資訊檔目前是否可用（設定頁狀態列用）。
 *
 * 只有「存在且是一般檔案」才算可用：路徑被目錄佔用、symlink 指向非檔案、stat 失敗
 * （權限、消失）都回 `false`，避免把「寫檔失敗但路徑有東西」誤報成「已寫出／可用」。
 * `fs.stat()` 會跟隨 symlink，因此 symlink 指向一般檔案時仍視為可用（與實際讀檔一致）。
 */
export async function runtimeFileExists(file: string): Promise<boolean> {
  try {
    return (await fs.stat(file)).isFile();
  } catch {
    return false;
  }
}

export interface StartupDiscoveryDecision {
  /** 這次執行的 server 是否真的以 discovery=on 啟動（設定頁的 `active`）。 */
  active: boolean;
  /** 是否要檢查／回報 runtime 檔的寫出結果（只有「啟動時開啟且啟動期間沒被改」才檢查）。 */
  verifyFile: boolean;
}

/**
 * 啟動期間的 `agentDiscovery` 決策（純函式；`main.ts` 在 `createServer()` 前後各讀一次）。
 *
 * 關鍵：`createServer()` 用的是**啟動當下**捕獲的值，不是 `createServer()` 回來時的模組變數。
 * 若 startup 期間 IPC 改過設定，這次執行仍然照舊值跑（要重啟才生效），因此：
 * - `active=false`，讓設定頁顯示「重新啟動後生效」，而不是拿新值宣稱已生效；
 * - 不去檢查 runtime 檔、也不報「無法寫出連線資訊」——真正原因是「要重啟」，不是權限或磁碟。
 */
export function resolveStartupDiscovery(input: {
  /** `createServer()` 之前捕獲的設定（實際傳給 server 的值）。 */
  startup: boolean;
  /** `createServer()` 之後模組層級目前的值（IPC 可能改過）。 */
  current: boolean;
}): StartupDiscoveryDecision {
  if (input.current !== input.startup) return { active: false, verifyFile: false };
  return { active: input.startup, verifyFile: input.startup };
}

export interface SetAgentDiscoveryOptions {
  settingsFile: string;
  runtimeFile: string;
  enabled: boolean;
  log?: Log;
}

export interface SetAgentDiscoveryResult {
  settings: AgentSettings;
  /** 是否成功刪除連線資訊檔（關閉時才會有動作）。 */
  runtimeFileRemoved: boolean;
  /** 「連線資訊檔未清除」之類的錯誤；沒有時為 null。 */
  error: string | null;
}

/**
 * 套用 `agentDiscovery` 開關：持久化設定，關閉時**立即**刪除 runtime 檔。
 *
 * 刪檔失敗不讓整個操作失敗（設定已寫入、下次啟動也不會再寫），但回報 `error` 讓設定頁
 * 明示「連線資訊檔未清除」。訊息刻意不含路徑（路徑由設定頁另外顯示）。
 */
export async function setAgentDiscovery(options: SetAgentDiscoveryOptions): Promise<SetAgentDiscoveryResult> {
  const log = options.log ?? defaultLog;
  const settings: AgentSettings = {
    schemaVersion: AGENT_SETTINGS_SCHEMA_VERSION,
    agentDiscovery: options.enabled,
  };
  await writeAgentSettings(options.settingsFile, settings);

  if (options.enabled) return { settings, runtimeFileRemoved: false, error: null };

  try {
    await fs.rm(path.resolve(options.runtimeFile), { force: true });
    // 半成品也一起清（正常關閉不會留下，但上次寫檔中斷時可能還有）。
    await fs.rm(`${path.resolve(options.runtimeFile)}.tmp`, { force: true }).catch(() => undefined);
    return { settings, runtimeFileRemoved: true, error: null };
  } catch (error) {
    log(`無法刪除連線資訊檔（agent discovery 已關閉）：${error instanceof Error ? error.message : String(error)}`);
    return { settings, runtimeFileRemoved: false, error: "連線資訊檔未清除" };
  }
}
