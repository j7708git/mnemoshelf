/**
 * 記憶內容的機密遮罩（curated 規則；不做全面熵遮罩）。
 *
 * 為什麼是 curated 而不是「高熵字串一律遮」：記憶裡常有 commit SHA、UUID、雜湊、base64 片段，
 * 全面熵遮罩會把這些正常內容破壞掉（對 agent 的用處反而變差）。這裡只遮**可辨識的憑證樣式**：
 * PEM 私鑰、常見 token 前綴、JWT、`Bearer`、敏感名稱的賦值、連線字串的帳密。
 *
 * 誠實限制：curated 規則仍可能對**極少數**程式識別字誤判（例如極長的 dotted 名稱）；也無法保證
 * 涵蓋所有憑證格式。寫入記憶時的遮罩會**改寫內容**，呼叫端可用回應的 `redacted`／`redactedCount`
 * 確認。文件（docs/roots-and-privacy.md）說明同一組限制。
 *
 * 契約：
 * - 命中片段替換成穩定的 `[REDACTED:<kind>]`，**不記錄原文**；不整筆拒絕。
 * - **idempotent**：已遮罩的文字再跑一次不會二次匹配（回傳 `redacted: false`、`count: 0`）。
 * - 寫入記憶前遮一次；讀取（列表／召回／`/search` 記憶命中／MCP）再遮一次，保護既有未遮罩資料。
 */

/** 遮罩片段的固定前綴（後端與文件共用；kind 接在冒號後）。 */
export const REDACTED_PREFIX = "[REDACTED:";

/** 可辨識的機密類別（出現在 `[REDACTED:<kind>]` 的 kind 位置）。 */
export type SecretKind = "private-key" | "connection-string" | "bearer" | "jwt" | "token" | "assignment";

/** `maskSecrets` 的結果。 */
export interface MaskSecretsResult {
  /** 遮罩後的文字（沒有命中時與輸入相同）。 */
  text: string;
  /** 是否至少遮了一處。 */
  redacted: boolean;
  /** 遮罩次數（每次規則命中算 1；同一段文字可能被多條規則依序處理）。 */
  count: number;
}

/**
 * 遮罩規則（依序套用）。每條規則的 replacement 都刻意讓結果**不再符合同一條規則**，
 * 這是 idempotency 的來源：所有規則都排除 `[REDACTED:` 開頭的值。
 *
 * 不用 `String.replace` 的全域字串（避免 `$` 解讀），一律用函式回傳固定 placeholder。
 */
interface MaskRule {
  pattern: RegExp;
  kind: SecretKind;
}

/**
 * 常見憑證的「名稱」清單（賦值樣式用）。
 *
 * 用完整名稱（而不是單獨的 `token`／`secret`）避免過度誤遮；名稱前的邊界用
 * `(?<![A-Za-z0-9])` 而不是 `\b`：`_` 是 word character，`\b` 會讓 `DB_PASSWORD`／
 * `my_token` 這類底線前綴完全無法命中。允許在底線後開始匹配也讓替換結果保留原名
 * （`my_token=[REDACTED:assignment]`，而不是 `my_[REDACTED:assignment]`）。
 */
const SECRET_KEY_PATTERN =
  // `secret[_-]?key(?:[_-]base)?` 放在單獨的 `secret` 之前：`SECRET_KEY`／`DJANGO_SECRET_KEY`／
  // `SECRET_KEY_BASE` 必須取最長匹配，否則只會匹配到 `secret` 而卡在後面的底線（`\b` 不成立）。
  "client[_-]?secret|secret[_-]?key(?:[_-]base)?|access[_-]?token|refresh[_-]?token|private[_-]?key|api[_-]?key|apikey|auth[_-]?token|secret|token|password|passwd|pwd";

const RULES: readonly MaskRule[] = [
  // 1) PEM 私鑰區塊（含常見的 `RSA`／`EC`／`OPENSSH` 等標頭）。
  { pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, kind: "private-key" },
  // 2) 只剩開頭的 PEM（被截斷的私鑰）：只遮標頭本身，避免把後面正常內容整段吃掉。
  { pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g, kind: "private-key" },
  // 3a) 已知會帶帳密的 DB／訊息佇列 scheme：密碼允許 `/` 等特殊字元
  //     （`postgres://user:pa/ss@host`）。整個 userinfo 遮掉、保留 scheme 與 host。
  {
    pattern:
      /\b(postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|rediss?|amqps?|mssql|sqlserver|ldaps?|smtps?):\/\/(?!\[REDACTED:)([^\s:@/]*):((?!\[REDACTED:)[^\s@]+)@/gi,
    kind: "connection-string",
  },
  // 3b) 泛用 URL（`https://user:pass@host` 或其他 scheme）：只把 `user:pass@` 當帳密，
  //     且**密碼不得含 `/`**——避免把 `https://host:8080/@me`、
  //     `https://host:443/path?email=a@b` 這類 `:port/@`／query email 誤判成帳密。
  {
    pattern: /\b([a-z][a-z0-9+.-]*):\/\/(?!\[REDACTED:)([^\s:@/]*):((?!\[REDACTED:)[^\s@/]+)@/gi,
    kind: "connection-string",
  },
  // 4) `Bearer <token>`（大小寫不拘；保留原本的前綴大小寫，方便看出這裡是授權標頭）。
  { pattern: /\b(Bearer)[ \t]+((?!\[REDACTED:)[A-Za-z0-9._~+/=-]{20,})/gi, kind: "bearer" },
  // 5) JWT：第一段必須是 JSON header 的 base64url（`eyJ…`），三段且後兩段 >= 8。
  //    要求 `eyJ` 才不會把 `application.services.authentication` 這類 dotted 識別字誤遮。
  { pattern: /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, kind: "jwt" },
  // 6) 常見 token 前綴（整段 token 遮掉）。
  //    `sk-` 要求 >= 20 字元，並排除 `sk-learn…`（scikit-learn 生態的套件名，
  //    例如 `sk-learn-extra-trees-classifier`）；真 token（`sk-proj-…` 等）仍遮。
  { pattern: /\bsk-(?!learn\b)[A-Za-z0-9_-]{20,}/gi, kind: "token" },
  { pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{10,})/g, kind: "token" },
  { pattern: /\bxox[baprs]-[A-Za-z0-9-]{8,}/g, kind: "token" },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, kind: "token" },
  { pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g, kind: "token" },
  // 7) 敏感名稱的賦值：支援 `key = value`、`key: value`、JSON 風格 `"key":"value"`。
  //    引號值 >= 8 字元；未引號值 >= 16 字元，且排除 `.`／括號等屬性存取字元
  //    （避免把屬性存取這類正常程式碼誤遮）。
  //    名稱前用 `(?<![A-Za-z0-9])`：底線不是字母數字，因此 `DB_PASSWORD`／`my_token`
  //    能在底線後命中，且替換時保留整個名稱（見上方 SECRET_KEY_PATTERN 的說明）。
  {
    pattern: new RegExp(
      `(?<![A-Za-z0-9])(${SECRET_KEY_PATTERN})\\b([ \\t]*(?:"[ \\t]*)?[:=][ \\t]*)` +
        `(?:"((?!\\[REDACTED:)[^"]{8,})"|'((?!\\[REDACTED:)[^']{8,})'|((?!\\[REDACTED:)[^\\s"',;.(){}[\\]]{16,}))`,
      "gi",
    ),
    kind: "assignment",
  },
];

/**
 * 判斷賦值的「值」是否只是程式中的參考（環境變數、屬性存取、常數名），而非字面憑證。
 *
 * 這是為了避免遮罩正常程式碼（例如環境變數或物件屬性的參考）；
 * 真正的字面憑證不會長成這些形式。
 *
 * **只套用在未引號值**：引號內的內容是字面字串，即使長得像 `req.body.password` 也已經是
 * 寫進記憶／檔案的字面值，一律遮罩（否則 `password = "req.body.password"` 會漏遮）。
 */
function looksLikeCodeReference(value: string): boolean {
  if (/^(?:process\.env|import\.meta\.env|req\.|request\.|ctx\.|this\.)/.test(value)) return true;
  // 全大寫常數／環境變數名（例如 `PASSWORD_MIN_LENGTH`）：必須含底線分段才算識別字。
  // 純大寫英數字面值（例如未引號的十六進位字串）不是識別字，不能豁免，否則假密鑰會漏遮。
  if (/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(value)) return true;
  if (/^\$/.test(value)) return true; // shell 變數
  if (/^[A-Za-z_$][\w$]*(?:\.[\w$]+)+$/.test(value)) return true; // dotted property access
  return false;
}

/**
 * 遮罩一段文字中的可辨識機密。
 *
 * @returns `text` 為遮罩後文字；`redacted`／`count` 供 API 回報（例如 `POST /memories`）。
 * 非字串輸入直接拋 `TypeError`（呼叫端只會傳字串；避免默默吞掉程式錯誤）。
 */
export function maskSecrets(text: string): MaskSecretsResult {
  if (typeof text !== "string") throw new TypeError("maskSecrets 只接受字串");

  let current = text;
  let count = 0;

  for (const rule of RULES) {
    current = current.replace(rule.pattern, (...args: unknown[]) => {
      // 最後兩個參數是 offset 與原字串；前面的捕獲群組用在需要保留結構的規則。
      const groups = args.slice(0, -2).map((value) => (typeof value === "string" ? value : undefined));
      const placeholder = `${REDACTED_PREFIX}${rule.kind}]`;

      if (rule.kind === "connection-string") {
        count += 1;
        // 保留 scheme：`scheme://[REDACTED:connection-string]@host`。
        return `${groups[1]}://${placeholder}@`;
      }
      if (rule.kind === "bearer") {
        count += 1;
        // 保留原本的 `Bearer` / `bearer` 大小寫。
        return `${groups[1]} ${placeholder}`;
      }
      if (rule.kind === "assignment") {
        // groups：0=整個 match、1=名稱、2=分隔符（可含 JSON 的引號）、3=雙引號值、
        // 4=單引號值、5=未引號值。
        const value = groups[3] ?? groups[4] ?? groups[5] ?? "";
        const quote = groups[3] !== undefined ? '"' : groups[4] !== undefined ? "'" : "";
        // 引號值一律視為字面值；只有未引號值才用程式參考判斷（見 looksLikeCodeReference）。
        if (quote === "" && looksLikeCodeReference(value)) return args[0] as string; // 不遮、不計數
        count += 1;
        const prefix = `${groups[1] ?? ""}${groups[2] ?? ""}`;
        return quote === "" ? `${prefix}${placeholder}` : `${prefix}${quote}${placeholder}${quote}`;
      }
      count += 1;
      return placeholder;
    });
  }

  return { text: current, redacted: count > 0, count };
}

/** 是否含已遮罩片段（給測試／診斷用；不影響遮罩流程）。 */
export function containsRedacted(text: string): boolean {
  return text.includes(REDACTED_PREFIX);
}
