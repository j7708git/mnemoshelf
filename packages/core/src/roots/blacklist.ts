/**
 * 黑名單判定（docs/roots-and-privacy.md §路徑安全第 2 點）。
 *
 * 規則以「路徑片段（目錄名）」與「檔名樣式」兩類比對，全部大小寫不敏感。
 * 這是路徑層級的判定：即使檔案位於使用者選的 root 內，命中即不索引、不回傳。
 *
 * Windows 的路徑變形也要命中（見 `normalizeSegment`）：Windows 會忽略檔名尾端的點與
 * 空白（`.env.`、`.ssh ` 等同 `.env`、`.ssh`），NTFS 的 Alternate Data Stream 也讓
 * `.env::$DATA` 這種片段被作業系統視為 `.env`。非 Windows 平台不做這些正規化，
 * 行為與檔案系統的實際語意一致。
 */

/** 一律排除的目錄名（小寫）。 */
const BLOCKED_DIR_NAMES: ReadonlySet<string> = new Set([
  // 設定與金鑰目錄
  ".ssh",
  ".gnupg",
  ".password-store",
  ".aws",
  ".kube",
  // 憑證／金鑰環與瀏覽器、郵件設定檔
  ".pki",
  ".mozilla",
  ".thunderbird",
  ".netscape",
]);

/** 一律排除的檔名樣式（比對正規化後的片段名稱）。 */
const BLOCKED_FILE_PATTERNS: readonly RegExp[] = [
  /^\.env$/, // .env
  /^\.env\..+$/, // .env.*（.env.example 例外，見 ALLOWED_NAMES）
  /\.pem$/,
  /\.key$/,
  /^id_(rsa|dsa|ecdsa|ed25519).*$/,
  /\.p12$/,
  /\.kdbx$/,
];

/** 明確放行的名稱（優先於黑名單）。 */
const ALLOWED_NAMES: ReadonlySet<string> = new Set([".env.example"]);

/** 路徑分隔：同時接受 POSIX 與 Windows 的分隔符，因為輸入可能來自任何平台。 */
const SEPARATOR_PATTERN = /[\\/]+/;

/** 檔名尾端的點與空白：Windows 會忽略它們。 */
const WINDOWS_TRAILING_PATTERN = /[. ]+$/;

/**
 * 把單一路徑片段正規化成比對用的名稱。
 *
 * - 一律轉小寫。
 * - 在 Windows（`win32`）額外處理兩種作業系統層級的路徑變形：
 *   1. NTFS ADS：只取 `:` 之前的部分（`.env::$DATA` → `.env`）；
 *   2. 尾端的點與空白：去掉（`.env.` → `.env`、`.ssh ` → `.ssh`）。
 */
export function normalizeSegment(segment: string, platform: NodeJS.Platform = process.platform): string {
  let name = segment;

  if (platform === "win32") {
    const streamSeparator = name.indexOf(":");
    if (streamSeparator !== -1) {
      name = name.slice(0, streamSeparator);
    }
    name = name.replace(WINDOWS_TRAILING_PATTERN, "");
  }

  return name.toLowerCase();
}

function findBlockedReason(relOrAbsPath: string, platform: NodeJS.Platform): string | null {
  const segments = relOrAbsPath.split(SEPARATOR_PATTERN).filter((segment) => segment.length > 0 && segment !== ".");

  for (const segment of segments) {
    const name = normalizeSegment(segment, platform);
    if (ALLOWED_NAMES.has(name)) continue;
    if (BLOCKED_DIR_NAMES.has(name)) return "受保護的設定或金鑰目錄";
    for (const pattern of BLOCKED_FILE_PATTERNS) {
      if (pattern.test(name)) return "受保護的檔名樣式";
    }
  }

  return null;
}

/**
 * 判斷路徑（相對或絕對）是否命中黑名單。
 *
 * 特性：
 * - `.env` 與 `.env.*` 命中，但 `.env.example` 放行。
 * - `.environment.md` 不命中（不是 `.env.` 開頭）。
 * - 目錄片段命中時，其下所有路徑皆命中。
 * - Windows 的路徑變形（`.env.`、`.ssh `、`.env::$DATA`）同樣命中。
 *
 * `platform` 參數是為了測試可注入；預設用執行時的 `process.platform`。
 */
export function isBlocked(relOrAbsPath: string, platform: NodeJS.Platform = process.platform): boolean {
  if (relOrAbsPath.length === 0) return false;
  return findBlockedReason(relOrAbsPath, platform) !== null;
}

/** 回傳命中的原因（供錯誤訊息使用），未命中則回傳 null。 */
export function blockedReason(relOrAbsPath: string, platform: NodeJS.Platform = process.platform): string | null {
  return findBlockedReason(relOrAbsPath, platform);
}
