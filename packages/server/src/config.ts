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

  return { dataDir, dbPath: path.join(dataDir, "mnemoshelf.db"), token, modelDir, port, webDir };
}

/** MCP stdio 入口的連線設定（`MNEMOSHELF_URL` + `MNEMOSHELF_TOKEN`）。 */
export interface McpConfig {
  url: string;
  token: string;
}

/** 讀出 MCP 入口設定；兩個變數都必填，缺少者列入錯誤的 `missing`。 */
export function loadMcpConfig(env: NodeJS.ProcessEnv = process.env): McpConfig {
  const missing: string[] = [];
  const url = env.MNEMOSHELF_URL;
  const token = env.MNEMOSHELF_TOKEN;
  if (url === undefined || url.trim() === "") missing.push("MNEMOSHELF_URL");
  if (token === undefined || token.trim() === "") missing.push("MNEMOSHELF_TOKEN");
  if (missing.length > 0) throw new MissingMcpConfigError(missing);
  return { url: url!.replace(/\/+$/, ""), token: token! };
}
