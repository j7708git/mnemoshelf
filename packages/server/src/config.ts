/**
 * 環境變數解析（伺服器層）。
 *
 * | 變數 | 用途 | 預設 |
 * |---|---|---|
 * | `MNEMOSHELF_DATA_DIR` | 資料目錄（SQLite 檔所在） | OS 使用者資料目錄下的 `mnemoshelf` |
 * | `MNEMOSHELF_TOKEN` | REST 的 Bearer token | **無預設，未設即啟動失敗** |
 * | `MNEMOSHELF_MODEL_DIR` | 模型快取目錄（交給 embedder） | embedder 自己的預設（OS 使用者資料目錄） |
 * | `MNEMOSHELF_PORT` | 監聽埠 | `0`（隨機埠） |
 * | `MNEMOSHELF_WEB_DIR` | Web UI 靜態檔目錄 | 本 repo 的 `packages/web/dist` |
 * | `MNEMOSHELF_MEMORY_BACKFILL` | 啟動時是否回填既有記憶向量（`on`／`off`） | `on` |
 * | `MNEMOSHELF_INDEX_RATE` | 索引限速 `off`／`normal`／`low`（索引時每檔之間休眠） | `off` |
 * | `MNEMOSHELF_AGENT_DISCOVERY` | 是否寫出 agent 連線資訊檔（`on`／`off`；檔案含 token） | `off` |
 * | `MNEMOSHELF_RUNTIME_FILE` | 連線資訊檔路徑（覆寫 `<dataDir>/runtime.json`） | `<dataDir>/runtime.json` |
 *
 * MCP stdio 入口（`loadMcpConfig`）另有自己的三個變數：`MNEMOSHELF_URL`、`MNEMOSHELF_TOKEN`
 * （**兩個都設定**才會直接使用；缺任何一個就改讀 `runtime.json`）與 `MNEMOSHELF_PROJECT`
 * （選配的預設專案名稱；供 `remember` 與 `search_memories` 在工具參數沒帶 `project` 時使用）。
 *
 * 另有三個**由 embedder 直接讀取**（不經此處解析，本表僅登錄以免漏查；見
 * `@mnemoshelf/embedder-transformers` 的 `device.ts`）：
 *
 * | 變數 | 用途 | 預設 |
 * |---|---|---|
 * | `MNEMOSHELF_EMBED_DEVICE` | 嵌入裝置 `auto`／`cpu`／`dml`／`coreml`（`auto`＝Windows 試 dml、macOS 試 coreml） | `auto` |
 * | `MNEMOSHELF_EMBED_DML_DEVICE_ID` | DirectML adapter 索引（非負整數，多顯卡時指定獨顯） | `0`（預設顯示卡） |
 * | `MNEMOSHELF_EMBED_ORT_LOG` | ONNX Runtime log 等級 `0`–`4`（`0`＝verbose；診斷用） | 未設定（不覆寫 ORT 預設） |
 *
 * token 刻意不自動產生：自動生成會讓使用者誤以為已經有保護，實際上 token 沒人知道、
 * 也沒人能通過驗證。未設時直接失敗並提示產生方式（`MissingTokenError`）。
 */
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MissingMcpConfigError, MissingTokenError, ValidationError } from "./errors.js";

/** 服務綁定的位址：只綁 loopback，永遠不可設定成 0.0.0.0。 */
export const LOOPBACK_HOST = "127.0.0.1";

/** 索引限速等級（`MNEMOSHELF_INDEX_RATE`）。 */
export type IndexRate = "off" | "normal" | "low";

/**
 * 各限速等級在「檔案與檔案之間」插入的休眠毫秒。
 *
 * 為什麼是這種 duty-cycle 而不是降低模型執行緒數：推論成本主要在 native 端，一次 `Run`
 * 無法中斷；在檔案邊界休眠最便宜、可取消，也完全不會改變檢索品質（切塊、模型、
 * 批次視窗都不動）。`normal` 讓出一點 CPU 給 UI／其他程式，`low` 明顯降低索引佔用
 * （總時間變長是預期代價）。
 */
export const INDEX_RATE_BETWEEN_FILES_MS: Readonly<Record<IndexRate, number>> = {
  off: 0,
  normal: 50,
  low: 250,
};

export interface ServerConfig {
  /** 資料目錄（已解析為絕對路徑）。 */
  dataDir: string;
  /** SQLite 資料庫檔路徑（`<dataDir>/mnemoshelf.db`）。 */
  dbPath: string;
  token: string;
  /** 模型快取目錄；未設定時回傳 undefined，由 embedder 決定預設。 */
  modelDir: string | undefined;
  /** 監聽埠；0 表示由 OS 指派。 */
  port: number;
  /** Web UI 靜態檔目錄（已解析為絕對路徑；不存在時 API 仍正常，靜態路徑回 404）。 */
  webDir: string;
  /**
   * 啟動時是否回填既有記憶向量（`MNEMOSHELF_MEMORY_BACKFILL=on|off`，預設 `on`）。
   *
   * `off` 只停**啟動回填**：新寫入的記憶仍會在建立後 enqueue 嵌入；既有 pending／failed／stale
   * 資料留到下一次以 `on` 啟動時才回填。
   */
  memoryBackfill: boolean;
  /**
   * 索引限速（`MNEMOSHELF_INDEX_RATE=off|normal|low`，預設 `off`）。
   *
   * `off`＝現行行為（檔案之間不休眠）；`normal`／`low` 在檔案邊界休眠
   * （見 `INDEX_RATE_BETWEEN_FILES_MS`）。非法值直接拒絕啟動。
   */
  indexRate: IndexRate;
  /**
   * 是否寫出 agent 連線資訊檔（`MNEMOSHELF_AGENT_DISCOVERY=on|off`，預設 `off`）。
   *
   * 檔案含 Bearer token；只有使用者（或桌面版設定）明確開啟時才寫。關閉時啟動會順便清除
   * 上次殘留的檔案，避免「已關閉」的功能仍留下有效 token。
   */
  agentDiscovery: boolean;
  /**
   * 連線資訊檔路徑（`MNEMOSHELF_RUNTIME_FILE`，預設 `<dataDir>/runtime.json`）。
   *
   * 自訂 `MNEMOSHELF_DATA_DIR` 的外部程式要能算出同一個位置；算不出來時請明確設定這個變數
   * （見 `docs/agent-integration.md`）。
   */
  runtimeFile: string;
}

/**
 * Web UI build 產物的預設位置：本檔所在的套件目錄往上兩層再進 `web/dist`。
 *
 * `src/config.ts` 與 build 後的 `dist/config.js` 都位於 `packages/server/` 底下，
 * 因此兩種情況下 `../../web/dist` 都指向 `packages/web/dist`（不硬寫分隔符）。
 */
function defaultWebDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "web", "dist");
}

/** OS 使用者資料目錄（跨平台，不硬寫分隔符；與 embedder 的預設邏輯一致）。 */
function osUserDataDir(home: string): string {
  if (process.platform === "win32") {
    const appData = process.env.APPDATA;
    return appData !== undefined && appData.trim() !== "" ? appData : path.join(home, "AppData", "Roaming");
  }
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support");
  }
  const xdg = process.env.XDG_DATA_HOME;
  return xdg !== undefined && xdg.trim() !== "" ? xdg : path.join(home, ".local", "share");
}

/** 從環境變數讀出設定；缺少 token 時丟 `MissingTokenError`。 */
export function loadServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const token = env.MNEMOSHELF_TOKEN;
  if (token === undefined || token.trim() === "") throw new MissingTokenError();

  const dataDirSetting = env.MNEMOSHELF_DATA_DIR;
  const dataDir =
    dataDirSetting !== undefined && dataDirSetting.trim() !== ""
      ? path.resolve(dataDirSetting)
      : path.join(osUserDataDir(homedir()), "mnemoshelf");

  const modelDirSetting = env.MNEMOSHELF_MODEL_DIR;
  const modelDir = modelDirSetting !== undefined && modelDirSetting.trim() !== "" ? path.resolve(modelDirSetting) : undefined;

  const portSetting = env.MNEMOSHELF_PORT;
  let port = 0;
  if (portSetting !== undefined && portSetting.trim() !== "") {
    const parsed = Number(portSetting);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
      throw new ValidationError("MNEMOSHELF_PORT", "必須是 0–65535 的整數");
    }
    port = parsed;
  }

  const webDirSetting = env.MNEMOSHELF_WEB_DIR;
  const webDir =
    webDirSetting !== undefined && webDirSetting.trim() !== "" ? path.resolve(webDirSetting) : defaultWebDir();

  // 啟動回填 opt-out（預設 on）。只接受 on／off（大小寫不拘）；其他值直接拒絕啟動。
  const backfillSetting = env.MNEMOSHELF_MEMORY_BACKFILL;
  let memoryBackfill = true;
  if (backfillSetting !== undefined && backfillSetting.trim() !== "") {
    const normalized = backfillSetting.trim().toLowerCase();
    if (normalized !== "on" && normalized !== "off") {
      throw new ValidationError("MNEMOSHELF_MEMORY_BACKFILL", "必須是 on 或 off");
    }
    memoryBackfill = normalized === "on";
  }

  // 索引限速（預設 off＝現行行為）。只接受 off／normal／low（大小寫不拘）；
  // 與其他開關一致：非法值直接拒絕啟動，而不是默默退回預設（使用者設了卻沒生效最難查）。
  const indexRateSetting = env.MNEMOSHELF_INDEX_RATE;
  let indexRate: IndexRate = "off";
  if (indexRateSetting !== undefined && indexRateSetting.trim() !== "") {
    const normalized = indexRateSetting.trim().toLowerCase();
    if (normalized !== "off" && normalized !== "normal" && normalized !== "low") {
      throw new ValidationError("MNEMOSHELF_INDEX_RATE", "必須是 off、normal 或 low");
    }
    indexRate = normalized;
  }

  // Agent 連線資訊檔（預設 off）：檔案含全權 token，只在明確開啟時寫出。
  // 與其他 on／off 開關一致：非法值直接拒絕啟動（大小寫不拘）。
  const discoverySetting = env.MNEMOSHELF_AGENT_DISCOVERY;
  let agentDiscovery = false;
  if (discoverySetting !== undefined && discoverySetting.trim() !== "") {
    const normalized = discoverySetting.trim().toLowerCase();
    if (normalized !== "on" && normalized !== "off") {
      throw new ValidationError("MNEMOSHELF_AGENT_DISCOVERY", "必須是 on 或 off");
    }
    agentDiscovery = normalized === "on";
  }

  const runtimeFileSetting = env.MNEMOSHELF_RUNTIME_FILE;
  const runtimeFile =
    runtimeFileSetting !== undefined && runtimeFileSetting.trim() !== ""
      ? path.resolve(runtimeFileSetting)
      : path.join(dataDir, "runtime.json");

  return {
    dataDir,
    dbPath: path.join(dataDir, "mnemoshelf.db"),
    token,
    modelDir,
    port,
    webDir,
    memoryBackfill,
    indexRate,
    agentDiscovery,
    runtimeFile,
  };
}

/** MCP stdio 入口的連線設定（`MNEMOSHELF_URL` + `MNEMOSHELF_TOKEN`）。 */
export interface McpConfig {
  url: string;
  token: string;
  /**
   * 這個 MCP 行程的預設專案（選配；來自 `MNEMOSHELF_PROJECT`）。
   *
   * 未設定（或只有空白）時為 `undefined`；`remember` 解析不到工具參數時會依序退回它、
   * 再退回 `process.cwd()` 的 basename（見 `mcp/stdio.ts` 的 `resolveProjectName`）。
   */
  project?: string;
}

/**
 * 讀出 MCP 入口設定；`MNEMOSHELF_URL`／`MNEMOSHELF_TOKEN` 缺少者列入錯誤的 `missing`
 * （呼叫端據此改讀 `runtime.json`；只有兩個都在時才會直接使用環境變數）。
 *
 * `MNEMOSHELF_PROJECT` 是選配的預設專案名稱（trim 後非空才採用；純空白視為未設定），
 * 供 `remember` 與 `search_memories` 在工具參數沒帶 `project` 時使用。
 */
export function loadMcpConfig(env: NodeJS.ProcessEnv = process.env): McpConfig {
  const missing: string[] = [];
  const url = env.MNEMOSHELF_URL;
  const token = env.MNEMOSHELF_TOKEN;
  if (url === undefined || url.trim() === "") missing.push("MNEMOSHELF_URL");
  if (token === undefined || token.trim() === "") missing.push("MNEMOSHELF_TOKEN");
  if (missing.length > 0) throw new MissingMcpConfigError(missing);

  const projectSetting = env.MNEMOSHELF_PROJECT;
  const project = projectSetting !== undefined && projectSetting.trim() !== "" ? projectSetting.trim() : undefined;

  return {
    url: url!.replace(/\/+$/, ""),
    token: token!,
    ...(project === undefined ? {} : { project }),
  };
}
