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
  /** 自動產生的 token 落地位置（spike 限定；正式的 safeStorage 管理見後續卡片）。 */
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
    tokenFile: path.join(userData, "spike-token.txt"),
  };
}

/** token 的來源。 */
export type TokenSource = "env" | "generated";

/** token 決策結果。 */
export interface TokenDecision {
  token: string;
  source: TokenSource;
}

/**
 * 決定這次啟動要用的 token。
 *
 * spike 階段：`MNEMOSHELF_TOKEN` 有值就沿用（與 `pnpm serve` 的用法一致），
 * 否則產生一組隨機 token 並落地到 userData（正式的 safeStorage 管理是下一張卡）。
 */
export function decideToken(env: NodeJS.ProcessEnv, generate: () => string): TokenDecision {
  const fromEnv = env.MNEMOSHELF_TOKEN;
  if (fromEnv !== undefined && fromEnv.trim() !== "") {
    return { token: fromEnv.trim(), source: "env" };
  }
  return { token: generate(), source: "generated" };
}

/** 交給 `createServer()` 的環境變數（覆寫值走 server 的同一條驗證路徑）。 */
export function buildServerEnv(input: {
  base: NodeJS.ProcessEnv;
  token: string;
  dataDir: string;
  modelDir: string;
  webDir: string;
}): NodeJS.ProcessEnv {
  return {
    ...input.base,
    MNEMOSHELF_TOKEN: input.token,
    MNEMOSHELF_DATA_DIR: input.dataDir,
    MNEMOSHELF_MODEL_DIR: input.modelDir,
    MNEMOSHELF_WEB_DIR: input.webDir,
    // 0（預設）＝由 OS 指派隨機埠；只綁 127.0.0.1（契約）。
    MNEMOSHELF_PORT: "0",
  };
}
