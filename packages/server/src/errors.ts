/**
 * 伺服器層的具名錯誤（沿用 core 的風格：一律 Error 子類別、訊息不含敏感資訊）。
 *
 * 這些錯誤是 REST 狀態碼的來源：`http/app.ts` 依型別（或名稱）映射，不做字串比對以外的猜測。
 * **訊息文字不得包含本機絕對路徑**；需要路徑時只放相對路徑或識別碼。
 */

/** 啟動時缺少 `MNEMOSHELF_TOKEN`。刻意不自動產生：避免使用者誤以為服務有保護。 */
export class MissingTokenError extends Error {
  constructor() {
    super(
      "未設定 MNEMOSHELF_TOKEN：服務只綁 127.0.0.1，但仍需要 token 保護。請先產生一組再啟動，例如 `openssl rand -hex 32`（Windows 可用 `node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"`）",
    );
    this.name = "MissingTokenError";
  }
}

/** 缺少 MCP stdio 入口所需的連線設定（`MNEMOSHELF_URL` / `MNEMOSHELF_TOKEN`）。 */
export class MissingMcpConfigError extends Error {
  /** 缺少的環境變數名稱。 */
  readonly missing: string[];

  constructor(missing: string[]) {
    super(`MCP 入口缺少環境變數：${missing.join("、")}`);
    this.name = "MissingMcpConfigError";
    this.missing = missing;
  }
}

/**
 * MCP 入口無法解析出可用連線（環境變數不完整，且連線資訊檔也不可用）。
 *
 * `reason` 是穩定字串（可程式比對）；訊息只說明「要怎麼解決」，**不含路徑、不含 token**。
 * 與 `MissingMcpConfigError` 分開的原因：後者只代表「環境變數少了哪些」，
 * 而這裡代表「連線資訊檔也救不了」，兩者的使用者動作不同（補環境變數 vs 開啟功能／重啟）。
 */
export type McpConnectionFailureReason =
  /** 沒有任何連線來源（既無環境變數，也找不到連線資訊檔）。 */
  | "no-config"
  /** 使用者明確指定了連線資訊檔路徑，但檔案不存在或讀不出來。 */
  | "runtime-missing"
  /** 連線資訊檔格式不符（需要 schemaVersion 1、非空 url／token、正整數 pid、字串 startedAt／appVersion）。 */
  | "runtime-invalid"
  /** 連線資訊檔的網址不是 loopback（只接受 `127.0.0.1`／`localhost`）。 */
  | "url-not-loopback"
  /** 環境變數的網址與連線資訊檔不一致，token 的歸屬不明。 */
  | "identity-mismatch"
  /** 連線資訊檔所指的行程已經結束（舊檔）。 */
  | "pid-dead"
  /** `/health` 逾時。 */
  | "health-timeout"
  /** `/health` 連不上。 */
  | "health-unreachable"
  /** `/health` 有回應但不是 mnemoshelf（服務身分不符）。 */
  | "health-identity-mismatch";

/** MCP 入口的連線解析失敗。 */
export class McpConnectionError extends Error {
  /** 穩定的失敗原因標籤。 */
  readonly reason: McpConnectionFailureReason;

  constructor(reason: McpConnectionFailureReason, message: string) {
    super(message);
    this.name = "McpConnectionError";
    this.reason = reason;
  }
}

/** 工具呼叫在連線層失敗時的穩定代碼（使用者看得懂，不含實作細節）。 */
export const MCP_CONNECTION_LOST_CODE = "connection-lost" as const;

/**
 * 工具呼叫在連線層失敗，且**沒有**安全地重試（或重試後仍失敗）。
 *
 * 有三種情境，訊息都要讓使用者知道「現在該做什麼」：
 * - 寫入帶 `force: true`：重試可能多寫一筆，結果未知；
 * - 刪除：重試可能拿到 404 而被誤當成「刪除失敗」；
 * - 唯讀工具重試一次後仍失敗。
 *
 * 訊息只帶穩定代碼與解法，**不含 token、不含路徑、也不含 `fetch failed` 這類實作細節**；
 * 原始錯誤只由呼叫端寫進 stderr 的診斷輸出。
 */
export class McpConnectionLostError extends Error {
  /** 穩定代碼；使用者與文件可以據此對照。 */
  readonly code: typeof MCP_CONNECTION_LOST_CODE = MCP_CONNECTION_LOST_CODE;
  /** 這次失敗的動作類型（只用來選訊息，不會出現在訊息裡）。 */
  readonly effect: "write" | "delete" | "read";

  constructor(effect: "write" | "delete" | "read") {
    super(connectionLostMessage(effect));
    this.name = "McpConnectionLostError";
    this.effect = effect;
  }
}

function connectionLostMessage(effect: "write" | "delete" | "read"): string {
  if (effect === "read") {
    return (
      `工具呼叫失敗（${MCP_CONNECTION_LOST_CODE}）：連線中斷，已自動重試一次仍失敗。` +
      `請確認 Mnemoshelf 正在執行，稍後再試。`
    );
  }
  const action = effect === "write" ? "寫入" : "刪除";
  return (
    `工具呼叫失敗（${MCP_CONNECTION_LOST_CODE}）：連線中斷，這次${action}的結果未知，` +
    `因此沒有自動重試（重試可能造成重複或刪錯）。請先查詢確認目前狀態，再決定是否重試。`
  );
}

/** token 缺失或不正確（HTTP 401）。訊息不回傳收到的值。 */
export class UnauthorizedError extends Error {
  constructor(reason = "缺少或錯誤的 Authorization: Bearer token") {
    super(reason);
    this.name = "UnauthorizedError";
  }
}

/** 請求來源不是 loopback（HTTP 403）。服務只綁 127.0.0.1，這是縱深防禦。 */
export class NonLoopbackRequestError extends Error {
  constructor() {
    super("只接受來自 loopback 位址的請求");
    this.name = "NonLoopbackRequestError";
  }
}

/**
 * `Host` header 不是本機位址（HTTP 403）。
 *
 * 服務綁在 loopback 仍會被惡意網頁以 DNS rebinding 打進來，因此只接受
 * `127.0.0.1`／`localhost`／`[::1]`（可帶埠號）。訊息不回傳收到的值。
 */
export class InvalidHostError extends Error {
  constructor() {
    super("Host header 不是本機位址（只接受 127.0.0.1、localhost 或 [::1]）");
    this.name = "InvalidHostError";
  }
}

/** 找不到資源（HTTP 404）。`resource` 是資源種類名稱，`id` 是識別碼。 */
export class NotFoundError extends Error {
  readonly resource: string;
  readonly id: number | null;

  constructor(resource: string, id: number | null = null) {
    super(id === null ? `找不到${resource}` : `找不到${resource} ${id}`);
    this.name = "NotFoundError";
    this.resource = resource;
    this.id = id;
  }
}

/** 請求內容不合法（HTTP 400）。訊息只帶欄位名稱與原因，不回傳使用者資料。 */
export class ValidationError extends Error {
  readonly field: string;

  constructor(field: string, reason: string) {
    super(`請求內容不合法（${field}）：${reason}`);
    this.name = "ValidationError";
    this.field = field;
  }
}

/** 同一個 root 的索引已在進行中（HTTP 409）。本卡不做索引佇列。 */
export class IndexInProgressError extends Error {
  readonly rootId: number;

  constructor(rootId: number) {
    super(`root ${rootId} 的索引正在進行中，請稍後再試`);
    this.name = "IndexInProgressError";
    this.rootId = rootId;
  }
}

/**
 * 這個型別的檔案不支援此操作（HTTP 415）。
 *
 * 用於「文字預覽遇到二進位／媒體檔」與「縮圖遇到非圖片」等情形。
 * 訊息只帶**相對路徑**（或檔名），不含本機絕對路徑；呼叫端不得據此洩漏 root 外的資訊。
 */
export class UnsupportedFileTypeError extends Error {
  /** 相對 root 的路徑（POSIX 分隔）；未知時為空字串。 */
  readonly relPath: string;

  constructor(relPath: string, reason: string) {
    super(`不支援這個檔案的預覽（${relPath === "" ? "檔案" : relPath}）：${reason}`);
    this.name = "UnsupportedFileTypeError";
    this.relPath = relPath;
  }
}

/** 檔案過大，超過此操作的上限（HTTP 413）。訊息只帶相對路徑與上限值。 */
export class FileTooLargeError extends Error {
  readonly relPath: string;
  readonly limitBytes: number;

  constructor(relPath: string, limitBytes: number) {
    super(`檔案過大，無法處理（${relPath === "" ? "檔案" : relPath}；上限 ${limitBytes} bytes）`);
    this.name = "FileTooLargeError";
    this.relPath = relPath;
    this.limitBytes = limitBytes;
  }
}

/** 請求方法不支援（HTTP 405）。 */
export class MethodNotAllowedError extends Error {
  readonly allowed: string[];

  constructor(method: string, allowed: string[]) {
    super(`不支援 ${method}，允許的方法：${allowed.join("、")}`);
    this.name = "MethodNotAllowedError";
    this.allowed = allowed;
  }
}

/** 請求主體過大（HTTP 413）。 */
export class PayloadTooLargeError extends Error {
  constructor(limitBytes: number) {
    super(`請求主體超過上限（${limitBytes} bytes）`);
    this.name = "PayloadTooLargeError";
  }
}

/**
 * 請求目標（request-target）無法解析（HTTP 400）。
 *
 * 刻意**不帶原始 URL**：那是不可信的輸入，不該出現在回應裡（也不該進 log 的訊息欄）。
 * `reason` 只放固定的原因描述。
 */
export class InvalidRequestUrlError extends Error {
  constructor(reason: string) {
    super(`無法解析請求 URL：${reason}`);
    this.name = "InvalidRequestUrlError";
  }
}

/** 請求 URL 過長（HTTP 414）。 */
export class RequestUriTooLongError extends Error {
  readonly limit: number;

  constructor(limit: number) {
    super(`請求 URL 過長（上限 ${limit} bytes）`);
    this.name = "RequestUriTooLongError";
    this.limit = limit;
  }
}
