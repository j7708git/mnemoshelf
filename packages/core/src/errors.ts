/**
 * 具名的錯誤型別。一律使用 Error 子類別，不拋字串。
 * 例外訊息不得包含敏感資訊：絕對路徑只放在欄位裡，訊息文字用相對路徑、root id 或數值。
 */

/** 要求的路徑不在任何已加入的 root 之內（含 `..` 與 symlink 逃脫）。 */
export class PathOutsideRootError extends Error {
  /** 被要求解析的絕對路徑（放在欄位，不放進訊息）。 */
  readonly requested: string;

  constructor(requested: string) {
    super("要求的路徑不在任何已加入的 root 之內");
    this.name = "PathOutsideRootError";
    this.requested = requested;
  }
}

/** 路徑命中黑名單（設定／金鑰目錄或檔名樣式）。 */
export class PathBlockedError extends Error {
  /** 觸發黑名單的相對路徑（可安全放在訊息中）。 */
  readonly blockedPath: string;

  constructor(blockedPath: string, reason: string) {
    super(`路徑命中黑名單（${reason}）：${blockedPath}`);
    this.name = "PathBlockedError";
    this.blockedPath = blockedPath;
  }
}

/** root 過寬（檔案系統根目錄或家目錄本身）。 */
export class RootTooBroadError extends Error {
  /** 被拒絕的絕對路徑。 */
  readonly path: string;

  constructor(path: string) {
    super("root 過寬：不得使用檔案系統根目錄或家目錄本身，請改選更具體的子目錄");
    this.name = "RootTooBroadError";
    this.path = path;
  }
}

/** 向量維度不符。 */
export class VectorDimensionError extends Error {
  readonly expected: number;
  readonly received: number;

  constructor(expected: number, received: number) {
    super(`向量維度不符：預期 ${expected} 維，收到 ${received} 維`);
    this.name = "VectorDimensionError";
    this.expected = expected;
    this.received = received;
  }
}

/** 向量未 L2 正規化（模長偏離 1 超過容差）。 */
export class VectorNotNormalizedError extends Error {
  /** 量到的模長。 */
  readonly norm: number;
  /** 容差。 */
  readonly tolerance: number;
  /** 出問題的向量鍵（若有）。 */
  readonly key: string | null;

  constructor(norm: number, tolerance: number, key: string | null = null) {
    const where = key === null ? "" : `（key=${key}）`;
    super(`向量未 L2 正規化${where}：模長 ${Number.isFinite(norm) ? norm.toFixed(6) : "非有限值"}，容差 ${tolerance}`);
    this.name = "VectorNotNormalizedError";
    this.norm = norm;
    this.tolerance = tolerance;
    this.key = key;
  }
}

/** 同一個 root 路徑重複加入。 */
export class DuplicateRootError extends Error {
  readonly path: string;

  constructor(path: string) {
    super(`此目錄已經加入過：${path}`);
    this.name = "DuplicateRootError";
    this.path = path;
  }
}
