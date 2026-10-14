/**
 * 桌面殼的路徑與啟動設定解析（純函式，可單獨測試）。
 *
 * 兩個關鍵決策（M4 打包研究結論）：
 * - **模型快取**：transformers.js 的 `env.cacheDir` 預設相對於套件安裝位置，
 *   打包後會落在 `app.asar` 內（唯讀）→ 必須指到 `app.getPath("userData")` 底下。
 * - **Web UI 靜態檔**：放在 `resources/web`（`extraResources`），在 asar 之外；
 *   伺服器以 `MNEMOSHELF_WEB_DIR` 讀取。
 */
import path from "node:path";

/** 桌面殼執行期需要的路徑（全部已解析為絕對路徑）。 */
export interface DesktopPaths {
  /** Electron 的 userData 目錄（`app.getPath("userData")`）。 */
  userData: string;
  /** SQLite 資料庫所在目錄（`MNEMOSHELF_DATA_DIR`）。 */
  dataDir: string;
  /** 模型快取目錄（`MNEMOSHELF_MODEL_DIR`，同時是 transformers.js 的 `env.cacheDir`）。 */
  modelDir: string;
  /** Web UI 靜態檔目錄（`MNEMOSHELF_WEB_DIR`）。 */
  webDir: string;
  /** token 密文檔位置（由 `safeStorage` 加密後落地，見 `token-store.ts`）。 */
  tokenFile: string;
}

/** 由 userData 與 `resourcesPath` 組出執行期路徑。 */
export function resolveDesktopPaths(input: {
  userData: string;
  resourcesPath: string;
  /** 覆寫 Web UI 目錄；未給時用 `<resourcesPath>/web`。 */
  webDir?: string;
}): DesktopPaths {
  const userData = path.resolve(input.userData);
  return {
    userData,
    dataDir: path.join(userData, "data"),
    modelDir: path.join(userData, "models"),
    webDir: input.webDir === undefined ? path.join(path.resolve(input.resourcesPath), "web") : path.resolve(input.webDir),
    tokenFile: path.join(userData, "token.bin"),
  };
}

/** token 的來源（由 `token-store.ts` 決定；這裡只保留型別給其他模組使用）。 */
export type TokenSource = "env" | "stored" | "generated" | "session";

/** 桌面殼的命令列選項。 */
export interface CliOptions {
  /** `--headless`：不開視窗、不建系統匣，只跑 Core 服務。 */
  headless: boolean;
  /** `--hidden`：建立視窗但不主動顯示（開機自啟時用，從系統匣叫回來）。 */
  hidden: boolean;
}

/** 解析命令列選項（純函式，可單獨測試）。 */
export function parseCliArgs(argv: readonly string[]): CliOptions {
  return {
    headless: argv.includes("--headless"),
    hidden: argv.includes("--hidden"),
  };
}

/**
 * 交給 `createServer()` 的環境變數（覆寫值走 server 的同一條驗證路徑）。
 *
 * `MNEMOSHELF_PORT` 預設 0（由 OS 指派隨機埠，只綁 127.0.0.1）；外部若明確指定
 * （例如 headless 驗收要用固定埠 curl）則沿用該值。
 */
export function buildServerEnv(input: {
  base: NodeJS.ProcessEnv;
  token: string;
  dataDir: string;
  modelDir: string;
  webDir: string;
}): NodeJS.ProcessEnv {
  const port = input.base.MNEMOSHELF_PORT;
  return {
    ...input.base,
    MNEMOSHELF_TOKEN: input.token,
    MNEMOSHELF_DATA_DIR: input.dataDir,
    MNEMOSHELF_MODEL_DIR: input.modelDir,
    MNEMOSHELF_WEB_DIR: input.webDir,
    MNEMOSHELF_PORT: port === undefined || port.trim() === "" ? "0" : port,
  };
}
