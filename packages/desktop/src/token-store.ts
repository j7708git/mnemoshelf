/**
 * 桌面殼的 token 管理：由應用程式自己產生、加密保存、自動沿用，使用者不必再手動貼。
 *
 * 決策與理由：
 * - 服務只綁 `127.0.0.1`（契約，見 `docs/roots-and-privacy.md`），token 只在**本機**流動：
 *   由 main process 產生後以 `webRequest` 注入 `Authorization` 標頭，renderer 完全看不到 token。
 * - 保存**只走** Electron 的 `safeStorage`（Linux 走系統金鑰庫、macOS Keychain、Windows DPAPI），
 *   落地的是密文（`<userData>/token.bin`，權限 0600）。**不寫明碼檔**。
 * - 沒有可用的加密後端時（例如 Linux 沒有金鑰庫／`XDG_CURRENT_DESKTOP` 缺失導致 Chromium
 *   退到 `basic_text`），改成「只在本次執行有效的隨機 token」並回報可讀的 notice：
 *   應用仍然可用（token 由殼自己注入），但不會偷偷降級成明碼保存。
 * - `MNEMOSHELF_TOKEN` 有值時沿用（與 `pnpm serve`／MCP 的用法一致），不落地。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

/** `safeStorage` 的最小介面（注入以便測試，不直接相依 electron）。 */
export interface SafeStorageLike {
  /** 這個環境是否有可用的加密後端。 */
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

/** token 的來源。 */
export type TokenSource =
  /** 由 `MNEMOSHELF_TOKEN` 帶入（開發／與 CLI 並用）。 */
  | "env"
  /** 從 userData 的密文檔解出（正常情形）。 */
  | "stored"
  /** 這次啟動新產生並加密落地（第一次啟動）。 */
  | "generated"
  /** 這次啟動新產生、只留在記憶體（環境沒有可用的加密後端）。 */
  | "session";

/** token 的狀態。**不含 token 本身**，可以安全地送到 renderer 顯示。 */
export interface TokenInfo {
  source: TokenSource;
  /** token 是否已加密落地。 */
  persisted: boolean;
  /** 這個環境是否有可用的加密後端。 */
  encryptionAvailable: boolean;
  /** 密文檔路徑。 */
  location: string;
  /** 給使用者看的說明；沒有特別事項時為 null。 */
  notice: string | null;
}

/** `loadOrCreateToken()` 的結果：狀態 ＋ token 本身（token 只留在 main process）。 */
export interface TokenState extends TokenInfo {
  token: string;
}

/** 去掉 token 本身，只留可以外送的狀態。 */
export function toTokenInfo(state: TokenState): TokenInfo {
  const { token: _token, ...info } = state;
  return info;
}

/** 讀檔失敗只有「不存在」是可預期的，其餘（權限等）也要能被區分。 */
async function readFileOrNull(file: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

export interface LoadOrCreateTokenOptions {
  /** 密文檔路徑（`<userData>/token.bin`）。 */
  tokenFile: string;
  storage: SafeStorageLike;
  /** 環境變數來源（預設 `process.env`）。 */
  env?: NodeJS.ProcessEnv;
  /** 產生新 token（預設 32 bytes 的 hex）。 */
  generate: () => string;
  /** 記錄可讀訊息（預設不輸出）。 */
  log?: (message: string) => void;
}

/**
 * 決定這次啟動要用的 token。
 *
 * 順序：`MNEMOSHELF_TOKEN` → userData 的密文 → 新產生。
 * 每一步的失敗都降級成「本次執行有效」並帶可讀 notice，不讓應用起不來。
 */
export async function loadOrCreateToken(options: LoadOrCreateTokenOptions): Promise<TokenState> {
  const env = options.env ?? process.env;
  const log = options.log ?? ((): void => {});
  const location = path.resolve(options.tokenFile);
  const encryptionAvailable = options.storage.isEncryptionAvailable();

  const fromEnv = env.MNEMOSHELF_TOKEN;
  if (fromEnv !== undefined && fromEnv.trim() !== "") {
    log("token 來源：環境變數 MNEMOSHELF_TOKEN");
    return {
      token: fromEnv.trim(),
      source: "env",
      persisted: false,
      encryptionAvailable,
      location,
      notice: null,
    };
  }

  if (!encryptionAvailable) {
    log("此環境沒有可用的 safeStorage 加密後端：token 只保留在本次執行（不落地）");
    return {
      token: options.generate(),
      source: "session",
      persisted: false,
      encryptionAvailable,
      location,
      notice:
        "這個環境沒有可用的系統金鑰庫（safeStorage），存取 token 只保留在本次執行，不會寫到磁碟；" +
        "重新啟動會換一組新 token（應用會自動沿用，不需要手動輸入）。",
    };
  }

  const existing = await readFileOrNull(location).catch((error: unknown) => {
    log(`讀取 token 檔失敗（改產生新 token）：${describeError(error)}`);
    return null;
  });
  if (existing !== null && existing.length > 0) {
    try {
      const token = options.storage.decryptString(existing).trim();
      if (token !== "") {
        log(`token 來源：既有密文檔（${location}）`);
        return { token, source: "stored", persisted: true, encryptionAvailable, location, notice: null };
      }
      log("token 檔內容為空：改產生新 token");
    } catch (error) {
      // 金鑰庫換了、檔案被截斷等都可能解不開；token 是可替換的（由殼自己注入），所以直接重產生。
      log(`token 檔無法解密（改產生新 token）：${describeError(error)}`);
    }
  }

  const token = options.generate();
  try {
    await fs.mkdir(path.dirname(location), { recursive: true });
    await fs.writeFile(location, options.storage.encryptString(token), { mode: 0o600 });
    log(`已產生 token 並加密寫入 ${location}`);
    return { token, source: "generated", persisted: true, encryptionAvailable, location, notice: null };
  } catch (error) {
    log(`token 無法寫入（只保留在本次執行）：${describeError(error)}`);
    return {
      token,
      source: "session",
      persisted: false,
      encryptionAvailable,
      location,
      notice: `存取 token 無法寫入 ${location}（${describeError(error)}）；本次執行仍可正常使用，重新啟動會換一組新 token。`,
    };
  }
}
