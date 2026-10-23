/**
 * 記憶卡與合成查詢題庫共用的「禁用樣式」清單。
 *
 * 這份清單只放樣式，不得含任何真實路徑字面——工作區隱私政策會擋下含個人
 * 本機路徑的 commit。安全寫法與自我驗證見同目錄的 `forbidden-patterns.test.ts`。
 *
 * 為什麼家目錄規則看起來重複：
 * - 舊規則（要求結尾斜線、或兩個字面反斜線）全數保留，不弱化既有覆蓋。
 * - 新規則補上「結尾沒有斜線的 Unix 家目錄」與「單反斜線的 Windows 家目錄前綴」。
 * - 陣列順序會影響失敗訊息裡出現哪一條規則，新規則一律排在對應舊規則之後。
 */
export interface ForbiddenPattern {
  /** 樣式名稱（失敗訊息用；不要放真實樣本）。 */
  name: string;
  pattern: RegExp;
}

export const FORBIDDEN_PATTERNS: readonly ForbiddenPattern[] = [
  { name: "email", pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
  { name: "openai-key", pattern: /\bsk-[A-Za-z0-9_-]{20,}/ },
  { name: "github-token", pattern: /\bgh[pousr]_[A-Za-z0-9]{10,}/ },
  { name: "bearer-token", pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/ },
  { name: "private-key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "home-path", pattern: /\/home\/[^/\s]+\// },
  { name: "users-path", pattern: /\/Users\/[^/\s]+\// },
  { name: "home-path-bare", pattern: /\/home\/[^/\s"']+/ },
  { name: "users-path-bare", pattern: /\/Users\/[^/\s"']+/ },
  { name: "windows-users-path", pattern: /[A-Za-z]:\\\\Users\\\\/ },
  { name: "windows-users-path-named", pattern: /[A-Za-z]:\\Users\\[^\\\s"']+/ },
  { name: "windows-users-path-single", pattern: /[A-Za-z]:\\+Users\\+/ },
  { name: "aws-access-key", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
];
