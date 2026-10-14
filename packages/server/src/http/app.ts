/**
 * REST 路由（`node:http` 手寫，JSON in／JSON out；不引框架）。
 *
 * 契約（任務卡 §REST API）：
 * - `GET  /health`（免 token）→ `{status:"ok"}`
 * - `POST /roots`、`GET /roots`、`GET /roots/:id`、`DELETE /roots/:id?deleteData=1`
 * - `POST /roots/:id/preview`、`POST /roots/:id/index`
 * - `GET  /roots/:id/entries?path=`（目錄子項）、`GET /roots/:id/file?path=`（文字預覽／圖片位元組）、
 *   `GET /roots/:id/thumb?path=`（縮圖）、`GET /roots/:id/index/status`（索引进度輪詢）
 * - `POST /search`
 * - `POST /memories`、`GET /memories`、`POST /memories/:id/pin`、`DELETE /memories/:id`
 *
 * 行為規則：
 * - **單一寫入者**：資料庫只被本行程開啟；本模組是唯一的寫入路徑（MCP 走 HTTP 進來的）。
 * - **唯讀使用者檔案**：沒有任何端點寫入 root 目錄——只讀檔、只寫自己的資料庫。
 * - 錯誤一律 `{error:{name,message}}`＋適當狀態碼；錯誤訊息由各錯誤型別決定，不含本機絕對路徑。
 *
 * 靜態檔服務（Web UI）：
 * - 路由順序是「**先 API（要 token）→ 再靜態檔 → 最後 SPA fallback**」，否則未知 API 路徑會被
 *   fallback 吃成 `index.html` 而不是 404 JSON。
 * - 靜態檔**不要 token**（`<script src>`／`<link>` 帶不了自訂標頭；`index.html` 與 bundle 不含機密）。
 * - SPA fallback 自己寫（不用 sirv 的 `single`）：只有 GET／HEAD、`Accept` 接受 HTML、
 *   且路徑「不像檔案」時才回 `index.html`；路徑解析不得超出靜態根目錄。
 * - 靜態根目錄不存在時（還沒 build）API 仍正常，靜態路徑回 404 JSON，不 crash。
 */
import { existsSync, promises as fs } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { homedir } from "node:os";
import path from "node:path";
import sirv from "sirv";
import {
  assertRootAllowed,
  blockedReason,
  DEFAULT_PREVIEW_MODALITIES,
  DuplicateRootError,
  indexRoot,
  isBlocked,
  type IndexRootResult,
  type Memory,
  type MemoryKind,
  type MemoryScope,
  type MetadataStore,
  type Modality,
  PathBlockedError,
  PathOutsideRootError,
  previewRoot,
  type Root,
  RootNotIndexableError,
  RootTooBroadError,
  type Embedder,
  type VectorIndex,
} from "@mnemoshelf/core";
import { LOOPBACK_HOST } from "../config.js";
import {
  FileTooLargeError,
  IndexInProgressError,
  InvalidHostError,
  InvalidRequestUrlError,
  MethodNotAllowedError,
  NotFoundError,
  NonLoopbackRequestError,
  PayloadTooLargeError,
  RequestUriTooLongError,
  UnauthorizedError,
  UnsupportedFileTypeError,
  ValidationError,
} from "../errors.js";
import { IndexStatusTracker, type IndexStatus } from "../index-status.js";
import {
  listDirectoryEntries,
  makeThumbnail,
  parseRelativePath,
  readFilePreview,
  ThumbnailCache,
  type DirEntry,
  type FilePreview,
  type TextPreview,
} from "./explorer.js";
import { requireLocalHost, requireLoopback, requireToken } from "./auth.js";
import { unifiedSearch, type SearchMode, type UnifiedSearchResult } from "../search.js";

/** JSON 請求主體上限。 */
export const MAX_JSON_BODY_BYTES = 1024 * 1024;
/** 單筆記憶內容長度上限（契約未明定，由本實作決定的濫用防護）。 */
export const MAX_MEMORY_CHARS = 8000;
/**
 * 請求 URL（request-target）長度上限。
 *
 * 為什麼需要：request-target 會被切成路徑片段並逐段 `decodeURIComponent`，長度不設限就是
 * 一條免認證的記憶體／CPU 放大路徑（Node 的 HTTP parser 上限約 16 KB，仍遠大於實際需求）。
 * 超過者回 414，不進路由。
 */
export const MAX_REQUEST_URL_LENGTH = 8 * 1024;

const MODALITIES: readonly Modality[] = ["text", "code", "image", "audio", "video"];
const MEMORY_KINDS: readonly MemoryKind[] = ["fact", "decision", "pitfall", "preference"];
const MEMORY_SCOPES: readonly MemoryScope[] = ["global", "project", "agent"];

/**
 * API 的第一段路徑前綴。
 *
 * 只有這些前綴會進 API 路由（要 token）；其餘路徑才可能由靜態檔／SPA fallback 服務。
 * 這個分界必須與 `dispatch` 的 `switch (segments[0])` 一致。
 */
export const API_PATH_PREFIXES: readonly string[] = ["health", "roots", "search", "memories"];

/** 靜態檔回應的 CSP（UI 與 API 同源；`<img>` 走 blob/data，故放行 blob: 與 data:）。 */
export const STATIC_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' blob: data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

/** 請求是否指向 API（`/health`、`/roots`、`/search`、`/memories` 及其子路徑）。 */
export function isApiPath(segments: readonly string[]): boolean {
  return segments.length > 0 && API_PATH_PREFIXES.includes(segments[0]!);
}

/**
 * 用戶端是否接受 HTML。
 *
 * `Accept` 缺席視為不接受（API 用戶端通常會帶 `Accept: application/json`）；
 * `text/html` 或萬用字元型別（`curl` 預設送的那種）都算，瀏覽器則送 `text/html,...`。
 */
export function acceptsHtml(accept: string | undefined): boolean {
  if (typeof accept !== "string") return false;
  return accept.includes("text/html") || accept.includes("*/*");
}

/**
 * 路徑是否「看起來像檔案」（最後一段含副檔名）。
 *
 * 這種路徑在找不到檔案時**不**做 SPA fallback（回 404），避免把缺失的 asset
 * 或 `/foo.json` 之類的回成 `index.html`（與 sirv 預設 `ignores` 的行為一致）。
 */
export function looksLikeFile(pathname: string): boolean {
  const segments = pathname.split("/").filter((segment) => segment !== "");
  const last = segments.length > 0 ? segments[segments.length - 1]! : "";
  return /\.[A-Za-z0-9]+$/.test(last);
}

/** `POST /roots` 的請求主體。 */
export interface AddRootRequest {
  path: string;
  mode?: "browse" | "index";
  modalities?: Modality[];
  include?: string[];
  exclude?: string[];
  respectGitignore?: boolean;
  /** 單檔大小上限；`Root` 契約沒有此欄位，因此只存在行程內，重啟後回退預設 10 MB（見 README）。 */
  maxFileBytes?: number;
}

/** `DELETE /roots/:id` 的回應。 */
export interface RemoveRootResponse {
  rootId: number;
  /** 是否同時刪除 chunk 與向量（`?deleteData=1`）。 */
  deletedData: boolean;
  /** 被刪除的 chunk 數（未刪資料時為 0）。 */
  removedChunks: number;
}

/** `GET /memories` 的回應（未刪除的記憶，由新到舊）。 */
export interface ListMemoriesResponse {
  memories: Memory[];
}

/** `POST /roots/:id/index` 的回應（`IndexRootResult` 摘要＋量測）。 */
export interface IndexRootResponse extends IndexRootResult {
  rootId: number;
  durationMs: number;
}

/** 統一的錯誤回應格式。 */
export interface ErrorResponse {
  error: { name: string; message: string };
}

/** JSON 路由結果。 */
export interface JsonRouteResult {
  status: number;
  body: unknown;
}

/** 位元組路由結果（圖片原始位元組、縮圖）：直接以位元組回應，不經 JSON。 */
export interface BytesRouteResult {
  status: number;
  bytes: Buffer;
  contentType: string;
  headers?: Record<string, string>;
}

/** 路由函式的回傳值：JSON 或位元組。 */
export type RouteResult = JsonRouteResult | BytesRouteResult;

/** 判斷路由結果是否為位元組回應。 */
function isBytesResult(result: RouteResult): result is BytesRouteResult {
  return "bytes" in result;
}

/** `GET /roots/:id/entries` 的回應。 */
export interface ListEntriesResponse {
  /** 正規化後的相對 root 路徑（`/` 分隔；root 本身為空字串）。 */
  path: string;
  entries: DirEntry[];
}

export interface RestAppDeps {
  store: MetadataStore;
  vec: VectorIndex;
  embedder: Embedder;
  token: string;
  /** root 加入時的「過寬」判定基準；預設 `os.homedir()`。 */
  homeDir?: string;
  /**
   * Web UI 靜態檔根目錄（絕對路徑）。
   *
   * 不存在時靜態路徑一律回 404 JSON（API 不受影響）——讓「還沒 build UI」不是啟動錯誤。
   */
  webDir: string;
}

export interface RestApp {
  /** 交給 `http.createServer` 的請求處理函式。 */
  handler: (request: IncomingMessage, response: ServerResponse) => void;
  /** 正在進行的索引（root id → promise）。進行中再呼叫 → 409。 */
  readonly indexing: ReadonlyMap<number, Promise<IndexRootResult>>;
  /** 等待中的請求全部結束（測試用：確認沒有殘留的非同步工作）。 */
  settled(): Promise<void>;
}

function sendJson(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = `${JSON.stringify(body)}\n`;
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    ...headers,
  });
  response.end(payload);
}

/** 直接以位元組回應（圖片原始位元組、縮圖）；`content-type` 由呼叫端指定。 */
function sendBytes(
  response: ServerResponse,
  status: number,
  contentType: string,
  body: Buffer,
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, {
    "content-type": contentType,
    "content-length": body.byteLength,
    ...headers,
  });
  response.end(body);
}

/**
 * 把錯誤映射成 HTTP 狀態碼與回應主體。
 *
 * 訊息**逐一由各錯誤型別決定**（這些訊息本身不含本機絕對路徑）；
 * 未預期的錯誤一律回應 500 的固定訊息，細節只寫到 stderr。
 */
export function toHttpError(error: unknown): { status: number; body: ErrorResponse; headers: Record<string, string> } {
  const named = (name: string, message: string): ErrorResponse => ({ error: { name, message } });

  if (error instanceof UnauthorizedError) return { status: 401, body: named(error.name, error.message), headers: {} };
  if (error instanceof NonLoopbackRequestError) return { status: 403, body: named(error.name, error.message), headers: {} };
  if (error instanceof InvalidHostError) return { status: 403, body: named(error.name, error.message), headers: {} };
  if (error instanceof RootTooBroadError) return { status: 422, body: named(error.name, error.message), headers: {} };
  if (error instanceof PathOutsideRootError) return { status: 403, body: named(error.name, error.message), headers: {} };
  if (error instanceof PathBlockedError) return { status: 403, body: named(error.name, error.message), headers: {} };
  if (error instanceof DuplicateRootError) {
    // 刻意不帶路徑：`DuplicateRootError.message` 內含絕對路徑。
    return { status: 409, body: named(error.name, "此目錄已經加入過"), headers: {} };
  }
  if (error instanceof RootNotIndexableError) return { status: 400, body: named(error.name, error.message), headers: {} };
  if (error instanceof NotFoundError) return { status: 404, body: named(error.name, error.message), headers: {} };
  if (error instanceof ValidationError) return { status: 400, body: named(error.name, error.message), headers: {} };
  if (error instanceof IndexInProgressError) return { status: 409, body: named(error.name, error.message), headers: {} };
  if (error instanceof PayloadTooLargeError) return { status: 413, body: named(error.name, error.message), headers: {} };
  if (error instanceof FileTooLargeError) return { status: 413, body: named(error.name, error.message), headers: {} };
  if (error instanceof UnsupportedFileTypeError) return { status: 415, body: named(error.name, error.message), headers: {} };
  if (error instanceof InvalidRequestUrlError) return { status: 400, body: named(error.name, error.message), headers: {} };
  if (error instanceof RequestUriTooLongError) {
    return { status: 414, body: named(error.name, error.message), headers: {} };
  }
  if (error instanceof MethodNotAllowedError) {
    return { status: 405, body: named(error.name, error.message), headers: { allow: error.allowed.join(", ") } };
  }

  return { status: 500, body: named("InternalError", "伺服器內部錯誤"), headers: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 讀取並解析 JSON 請求主體；空主體視為 `{}`。 */
async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_JSON_BODY_BYTES) {
      request.destroy();
      throw new PayloadTooLargeError(MAX_JSON_BODY_BYTES);
    }
    chunks.push(buffer);
  }
  if (total === 0) return {};
  const text = Buffer.concat(chunks).toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ValidationError("body", "不是合法的 JSON");
  }
  if (!isRecord(parsed)) throw new ValidationError("body", "必須是 JSON 物件");
  return parsed;
}

function requireString(value: unknown, field: string, options: { maxLength?: number } = {}): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ValidationError(field, "必須是非空的字串");
  }
  if (options.maxLength !== undefined && value.length > options.maxLength) {
    throw new ValidationError(field, `長度上限 ${options.maxLength} 字元`);
  }
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new ValidationError(field, "必須是字串");
  return value;
}

/** 解析可選的布林欄位；未提供（`undefined`／`null`）時回傳 `undefined`。 */
function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw new ValidationError(field, "必須是布林值");
  return value;
}

/** 解析可選的正整數 id（例如 `supersedes`）；未提供時回傳 `null`。 */
function optionalId(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new ValidationError(field, "必須是正整數");
  }
  return value;
}

function optionalStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new ValidationError(field, "必須是字串陣列");
  }
  return value as string[];
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], field: string, fallback: T): T {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new ValidationError(field, `必須是 ${allowed.join(" / ")} 之一`);
  }
  return value as T;
}

/** 解析 `deleteData` 之類的旗標；未提供時回傳 fallback。 */
function booleanFlag(value: string | null, field: string, fallback: boolean): boolean {
  if (value === null) return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === "" || normalized === "0" || normalized === "false" || normalized === "no") return false;
  if (normalized === "1" || normalized === "true" || normalized === "yes") return true;
  throw new ValidationError(field, "必須是 1/0（或 true/false）");
}

function parseId(raw: string, resource: string): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw new NotFoundError(resource);
  return id;
}

/** 解析查詢字串裡的列舉參數；未提供（或空字串）＝不過濾。 */
function optionalEnumParam<T extends string>(value: string | null, allowed: readonly T[], field: string): T | undefined {
  if (value === null || value.trim() === "") return undefined;
  if (!(allowed as readonly string[]).includes(value)) {
    throw new ValidationError(field, `必須是 ${allowed.join(" / ")} 之一`);
  }
  return value as T;
}

/** 解析查詢字串裡的文字參數；未提供（或空字串）＝不過濾。 */
function optionalQueryString(value: string | null, field: string): string | undefined {
  if (value === null || value.trim() === "") return undefined;
  return value;
}

/** 解析查詢字串裡的 limit；未提供＝由儲存層套用預設值。 */
function queryLimit(value: string | null): number | undefined {
  if (value === null || value.trim() === "") return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ValidationError("limit", "必須是正整數");
  }
  return parsed;
}

/**
 * 解析 request-target（`request.url`）成 `URL` 與路徑片段。
 *
 * **必須在 `try` 內呼叫**：`new URL()` 對畸形目標（例如 `//[`，Node 的 HTTP parser 會照常
 * 交給 handler）會丟 `TypeError: Invalid URL`；而 handler 是同步的 request listener，
 * 未捕捉的例外會直接結束整個行程（單一寫入者服務，等於免認證的 DoS）。
 * 解析失敗一律轉成具名錯誤（400／414），訊息不含原始 URL 的內容。
 */
export function parseRequestTarget(request: IncomingMessage): { url: URL; segments: string[] } {
  const raw = request.url ?? "/";
  if (Buffer.byteLength(raw, "utf8") > MAX_REQUEST_URL_LENGTH) {
    throw new RequestUriTooLongError(MAX_REQUEST_URL_LENGTH);
  }

  let url: URL;
  try {
    url = new URL(raw, `http://${LOOPBACK_HOST}`);
  } catch {
    throw new InvalidRequestUrlError("格式不正確");
  }

  const segments: string[] = [];
  for (const segment of url.pathname.split("/")) {
    if (segment.length === 0) continue;
    try {
      segments.push(decodeURIComponent(segment));
    } catch {
      // 百分比編碼壞掉（例如 `/%`）：這是畸形的 request-target，不當成一般路徑放行。
      throw new InvalidRequestUrlError("百分比編碼無法解碼");
    }
  }

  return { url, segments };
}

export function createRestApp(deps: RestAppDeps): RestApp {
  const homeDir = deps.homeDir ?? homedir();
  /**
   * 行程內的每 root 單檔大小上限（`Root` 契約無此欄位，重啟即失、回退 indexer 預設 10 MB）。
   * 這是刻意的取捨（PM 裁示：文件化，不持久化）；要持久化需 migration 與契約變更。
   */
  const maxFileBytesByRoot = new Map<number, number>();
  const indexing = new Map<number, Promise<IndexRootResult>>();
  const inflight = new Set<Promise<unknown>>();
  /** 索引工作狀態（行程內記憶體；供 `GET /roots/:id/index/status` 輪詢）。 */
  const indexStatus = new IndexStatusTracker();
  /** 縮圖快取（行程內記憶體；不寫磁碟）。 */
  const thumbnailCache = new ThumbnailCache();

  // 靜態檔根目錄：不存在時（還沒 build UI）不建立 sirv handler，靜態路徑一律 404。
  const webDir = path.resolve(deps.webDir);
  const webIndexPath = path.join(webDir, "index.html");
  const staticFiles = existsSync(webDir)
    ? sirv(webDir, {
        dev: process.env.NODE_ENV !== "production",
        etag: true,
        setHeaders: (response) => {
          response.setHeader("Content-Security-Policy", STATIC_CSP);
        },
      })
    : null;

  /**
   * 先嘗試靜態檔；sirv 沒命中時回傳 false。
   *
   * sirv 的 `next` 是同步呼叫的，命中時也在同步階段就 `writeHead`（檔案內容之後才 stream），
   * 因此呼叫後即可判斷是否已接手。
   */
  const tryStaticFile = (request: IncomingMessage, response: ServerResponse): boolean => {
    if (staticFiles === null) return false;
    let fellThrough = false;
    staticFiles(request, response, () => {
      fellThrough = true;
    });
    return !fellThrough;
  };

  /**
   * 服務靜態檔與 SPA fallback（不含 API；API 由 `dispatch` 處理）。
   *
   * 順序：真實檔案 → 找不到時，GET／HEAD＋接受 HTML＋路徑不像檔案 → `index.html` → 否則 404 JSON。
   */
  const serveWeb = async (request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> => {
    const method = (request.method ?? "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD") throw new MethodNotAllowedError(method, ["GET", "HEAD"]);

    if (tryStaticFile(request, response)) return;

    // SPA fallback：只有「接受 HTML」的瀏覽器導航才回 index.html；其餘（含 API 用戶端）維持 404 JSON。
    if (!acceptsHtml(request.headers.accept) || looksLikeFile(url.pathname)) throw new NotFoundError("路徑");
    if (!existsSync(webIndexPath)) throw new NotFoundError("路徑");

    const html = await fs.readFile(webIndexPath);
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-length": html.byteLength,
      "cache-control": "no-cache",
      "content-security-policy": STATIC_CSP,
    });
    response.end(method === "HEAD" ? undefined : html);
  };

  const getRootOr404 = async (id: number): Promise<Root> => {
    const root = await deps.store.getRoot(id);
    if (root === null) throw new NotFoundError("root", id);
    return root;
  };

  const validateModalities = (value: unknown): Modality[] => {
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
      throw new ValidationError("modalities", "必須是模態名稱陣列");
    }
    const list = value as string[];
    for (const item of list) {
      if (!MODALITIES.includes(item as Modality)) {
        throw new ValidationError("modalities", `必須是 ${MODALITIES.join(" / ")} 的子集`);
      }
    }
    return list as Modality[];
  };

  const createRoot = async (request: IncomingMessage): Promise<{ status: number; body: unknown }> => {
    const body = (await readJsonBody(request)) as unknown as AddRootRequest;
    const requestedPath = requireString(body.path, "path");

    let realPath: string;
    try {
      realPath = await fs.realpath(requestedPath);
    } catch {
      throw new ValidationError("path", "路徑不存在或無法解析");
    }
    const stats = await fs.stat(realPath);
    if (!stats.isDirectory()) throw new ValidationError("path", "必須是目錄");

    // 過寬（檔案系統根／家目錄本身）→ RootTooBroadError（422）；黑名單 → PathBlockedError（403）。
    assertRootAllowed(realPath, { homeDir });
    if (isBlocked(realPath)) throw new PathBlockedError(realPath.split(/[\\/]/).pop() ?? realPath, blockedReason(realPath) ?? "黑名單");

    const mode = enumValue(body.mode, ["browse", "index"] as const, "mode", "index");
    const modalities = body.modalities === undefined
      ? [...DEFAULT_PREVIEW_MODALITIES]
      : validateModalities(body.modalities);
    const include = optionalStringArray(body.include, "include") ?? [];
    const exclude = optionalStringArray(body.exclude, "exclude") ?? [];
    if (body.respectGitignore !== undefined && typeof body.respectGitignore !== "boolean") {
      throw new ValidationError("respectGitignore", "必須是布林值");
    }
    let maxFileBytes: number | undefined;
    if (body.maxFileBytes !== undefined) {
      if (!Number.isInteger(body.maxFileBytes) || body.maxFileBytes <= 0) {
        throw new ValidationError("maxFileBytes", "必須是正整數");
      }
      maxFileBytes = body.maxFileBytes;
    }

    const root = await deps.store.addRoot({
      path: realPath,
      mode,
      modalities,
      include,
      exclude,
      respectGitignore: body.respectGitignore ?? true,
      watch: false,
    });
    if (maxFileBytes !== undefined) maxFileBytesByRoot.set(root.id, maxFileBytes);
    return { status: 201, body: root };
  };

  const previewFor = async (id: number): Promise<{ status: number; body: unknown }> => {
    const root = await getRootOr404(id);
    const maxFileBytes = maxFileBytesByRoot.get(id);
    const preview = await previewRoot({
      path: root.path,
      modalities: root.modalities,
      include: root.include,
      exclude: root.exclude,
      respectGitignore: root.respectGitignore,
      ...(maxFileBytes === undefined ? {} : { maxFileBytes }),
    });
    return { status: 200, body: preview };
  };

  const startIndex = async (id: number): Promise<{ status: number; body: unknown }> => {
    const root = await getRootOr404(id);
    if (root.mode !== "index") throw new RootNotIndexableError(root.id, root.mode);
    if (indexing.has(id)) throw new IndexInProgressError(id);

    const startedAt = Date.now();
    const maxFileBytes = maxFileBytesByRoot.get(id);
    indexStatus.begin(id);
    const run = indexRoot(root, {
      embedder: deps.embedder,
      store: deps.store,
      vec: deps.vec,
      onProgress: (progress) => indexStatus.report(id, progress),
      ...(maxFileBytes === undefined ? {} : { maxFileBytes }),
    });
    indexing.set(id, run);
    inflight.add(run);
    try {
      const result = await run;
      indexStatus.finish(id, result);
      return { status: 200, body: { rootId: id, durationMs: Date.now() - startedAt, ...result } };
    } catch (error) {
      indexStatus.fail(id, error);
      throw error;
    } finally {
      indexing.delete(id);
      inflight.delete(run);
    }
  };

  /**
   * `GET /roots/:id/entries?path=`：列出相對路徑下的目錄子項。
   *
   * `path` 缺漏或為絕對路徑 → 400；逃出 root（含 `..`、symlink）或命中黑名單 → 403；
   * 目標不是目錄 → 400；不存在 → 404。所有存取都經 `resolveInsideRoot`。
   */
  const listEntries = async (id: number, url: URL): Promise<RouteResult> => {
    const root = await getRootOr404(id);
    const relPath = parseRelativePath(url.searchParams.get("path"), { allowEmpty: true });
    const body: ListEntriesResponse = await listDirectoryEntries(root, relPath);
    return { status: 200, body };
  };

  /**
   * `GET /roots/:id/file?path=`：文字預覽（JSON）或圖片原始位元組（帶 Content-Type）。
   *
   * 二進位與媒體檔 → 415；超過大小上限 → 413。
   */
  const readFile = async (id: number, url: URL): Promise<RouteResult> => {
    const root = await getRootOr404(id);
    const relPath = parseRelativePath(url.searchParams.get("path"), { allowEmpty: false });
    const preview: FilePreview = await readFilePreview(root, relPath);
    if (preview.kind === "text") {
      const body: TextPreview = preview;
      return { status: 200, body };
    }
    return {
      status: 200,
      bytes: preview.bytes,
      contentType: preview.contentType,
      headers: { "cache-control": "private, max-age=60" },
    };
  };

  /** `GET /roots/:id/thumb?path=`：用 `sharp` 產生縮圖（記憶體快取）。 */
  const readThumbnail = async (id: number, url: URL): Promise<RouteResult> => {
    const root = await getRootOr404(id);
    const relPath = parseRelativePath(url.searchParams.get("path"), { allowEmpty: false });
    const thumbnail = await makeThumbnail(root, relPath, thumbnailCache);
    return {
      status: 200,
      bytes: thumbnail.bytes,
      contentType: thumbnail.contentType,
      headers: { "cache-control": "private, max-age=300" },
    };
  };

  /** `GET /roots/:id/index/status`：輪詢索引进度（行程內記憶體狀態）。 */
  const getIndexStatus = async (id: number): Promise<RouteResult> => {
    await getRootOr404(id);
    const status: IndexStatus = indexStatus.status(id);
    return { status: 200, body: status };
  };

  const removeRoot = async (id: number, deleteData: boolean): Promise<{ status: number; body: unknown }> => {
    await getRootOr404(id);
    if (indexing.has(id)) throw new IndexInProgressError(id);
    const { removedChunkIds } = await deps.store.removeRoot(id, deleteData);
    if (deleteData) await deps.vec.deleteByRoot(id);
    maxFileBytesByRoot.delete(id);
    indexStatus.clear(id);
    const body: RemoveRootResponse = {
      rootId: id,
      deletedData: deleteData,
      removedChunks: removedChunkIds.length,
    };
    return { status: 200, body };
  };

  /**
   * `POST /memories`：新增記憶。
   *
   * `supersedes`（可選）為被取代的記憶 id：帶了就把該筆標記軟刪除（見 `addMemory` 的契約），
   * UI 的「編輯」流程即以此產生新版本並取代舊版。
   */
  const addMemory = async (request: IncomingMessage): Promise<{ status: number; body: unknown }> => {
    const body = await readJsonBody(request);
    const content = requireString(body.content, "content", { maxLength: MAX_MEMORY_CHARS });
    const agent = requireString(body.agent, "agent");
    const kind = enumValue(body.kind, MEMORY_KINDS, "kind", "fact");
    const scope = enumValue(body.scope, MEMORY_SCOPES, "scope", "global");
    const project = optionalString(body.project, "project") ?? null;
    const supersedes = optionalId(body.supersedes, "supersedes");

    const memory: Memory = await deps.store.addMemory({ content, kind, scope, project, agent, supersedes });
    return { status: 201, body: memory };
  };

  /**
   * `POST /memories/:id/pin`：設定／取消釘選（冪等）。
   *
   * 主體 `{pinned?: boolean}`，省略時預設 `true`（只送空主體即為釘選）。
   * 未知的 id → 404（先 `getMemory` 判斷存在與否）；回傳更新後的記憶。
   */
  const pinMemory = async (request: IncomingMessage, id: number): Promise<{ status: number; body: unknown }> => {
    const body = await readJsonBody(request);
    const pinned = optionalBoolean(body.pinned, "pinned") ?? true;
    if ((await deps.store.getMemory(id)) === null) throw new NotFoundError("記憶", id);
    await deps.store.setMemoryPinned(id, pinned);
    return { status: 200, body: await deps.store.getMemory(id) };
  };

  const forgetMemory = async (id: number): Promise<{ status: number; body: unknown }> => {
    const memory = await deps.store.getMemory(id);
    if (memory === null) throw new NotFoundError("記憶", id);
    const alreadyDeleted = memory.deletedAt !== null;
    if (!alreadyDeleted) await deps.store.forgetMemory(id);
    return { status: 200, body: { id, deleted: !alreadyDeleted } };
  };

  const routeRoots = async (
    request: IncomingMessage,
    method: string,
    segments: string[],
    url: URL,
  ): Promise<RouteResult> => {
    if (segments.length === 1) {
      if (method === "GET") return { status: 200, body: { roots: await deps.store.listRoots() } };
      if (method === "POST") return await createRoot(request);
      throw new MethodNotAllowedError(method, ["GET", "POST"]);
    }

    const id = parseId(segments[1]!, "root");

    if (segments.length === 2) {
      if (method === "GET") return { status: 200, body: await getRootOr404(id) };
      if (method === "DELETE") return await removeRoot(id, booleanFlag(url.searchParams.get("deleteData"), "deleteData", false));
      throw new MethodNotAllowedError(method, ["GET", "DELETE"]);
    }

    if (segments.length === 3) {
      if (segments[2] === "preview") {
        if (method !== "POST") throw new MethodNotAllowedError(method, ["POST"]);
        return await previewFor(id);
      }
      if (segments[2] === "index") {
        if (method !== "POST") throw new MethodNotAllowedError(method, ["POST"]);
        return await startIndex(id);
      }
      if (segments[2] === "entries") {
        if (method !== "GET") throw new MethodNotAllowedError(method, ["GET"]);
        return await listEntries(id, url);
      }
      if (segments[2] === "file") {
        if (method !== "GET") throw new MethodNotAllowedError(method, ["GET"]);
        return await readFile(id, url);
      }
      if (segments[2] === "thumb") {
        if (method !== "GET") throw new MethodNotAllowedError(method, ["GET"]);
        return await readThumbnail(id, url);
      }
    }

    // `GET /roots/:id/index/status`（索引进度輪詢）。
    if (segments.length === 4 && segments[2] === "index" && segments[3] === "status") {
      if (method !== "GET") throw new MethodNotAllowedError(method, ["GET"]);
      return await getIndexStatus(id);
    }

    throw new NotFoundError("路徑");
  };

  const search = async (request: IncomingMessage): Promise<{ status: number; body: UnifiedSearchResult }> => {
    const body = await readJsonBody(request);
    // 型別以外一律由 normalizeSearchOptions 驗證（單一驗證來源）。
    const result = await unifiedSearch(
      { store: deps.store, vec: deps.vec, embedder: deps.embedder },
      {
        query: body.query as string,
        mode: body.mode as SearchMode | undefined,
        rootIds: body.rootIds as number[] | undefined,
        k: body.k as number | undefined,
      },
    );
    return { status: 200, body: result };
  };

  /**
   * `GET /memories`：列出未刪除的記憶（由新到舊）。
   *
   * 過濾參數直接對應 `MetadataStore.listMemories` 的 `MemoryFilter`；`limit` 的預設與上限
   * 由儲存層的 `normalizeMemoryLimit` 決定（預設 100、上限 500），這裡只擋掉非正整數。
   */
  const listMemories = async (url: URL): Promise<{ status: number; body: unknown }> => {
    const params = url.searchParams;
    const kind = optionalEnumParam(params.get("kind"), MEMORY_KINDS, "kind");
    const scope = optionalEnumParam(params.get("scope"), MEMORY_SCOPES, "scope");
    const project = optionalQueryString(params.get("project"), "project");
    const agent = optionalQueryString(params.get("agent"), "agent");
    const limit = queryLimit(params.get("limit"));

    const memories = await deps.store.listMemories({
      ...(kind === undefined ? {} : { kind }),
      ...(scope === undefined ? {} : { scope }),
      ...(project === undefined ? {} : { project }),
      ...(agent === undefined ? {} : { agent }),
      ...(limit === undefined ? {} : { limit }),
    });
    return { status: 200, body: { memories } };
  };

  const routeMemories = async (
    request: IncomingMessage,
    method: string,
    segments: string[],
    url: URL,
  ): Promise<{ status: number; body: unknown }> => {
    if (segments.length === 1) {
      if (method === "POST") return await addMemory(request);
      if (method === "GET") return await listMemories(url);
      throw new MethodNotAllowedError(method, ["GET", "POST"]);
    }
    if (segments.length === 2) {
      if (method !== "DELETE") throw new MethodNotAllowedError(method, ["DELETE"]);
      return await forgetMemory(parseId(segments[1]!, "記憶"));
    }
    if (segments.length === 3 && segments[2] === "pin") {
      if (method !== "POST") throw new MethodNotAllowedError(method, ["POST"]);
      return await pinMemory(request, parseId(segments[1]!, "記憶"));
    }
    throw new NotFoundError("路徑");
  };

  const dispatch = async (
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    segments: string[],
  ): Promise<void> => {
    const method = (request.method ?? "GET").toUpperCase();

    if (method === "GET" && segments.length === 1 && segments[0] === "health") {
      sendJson(response, 200, { status: "ok" });
      return;
    }

    // 除 /health 外一律要 token。
    requireToken(request, deps.token);

    let result: RouteResult;
    switch (segments[0]) {
      case "roots":
        result = await routeRoots(request, method, segments, url);
        break;
      case "search":
        if (segments.length !== 1) throw new NotFoundError("路徑");
        if (method !== "POST") throw new MethodNotAllowedError(method, ["POST"]);
        result = await search(request);
        break;
      case "memories":
        result = await routeMemories(request, method, segments, url);
        break;
      default:
        throw new NotFoundError("路徑");
    }

    if (isBytesResult(result)) {
      sendBytes(response, result.status, result.contentType, result.bytes, result.headers ?? {});
    } else {
      sendJson(response, result.status, result.body);
    }
  };

  const handler = (request: IncomingMessage, response: ServerResponse): void => {
    // 全部解析與路由都在 try 內：handler 是同步的 request listener，任何未捕捉的例外都會
    // 直接結束行程（見 parseRequestTarget 的說明）。
    const task = (async (): Promise<void> => {
      try {
        requireLoopback(request);
        requireLocalHost(request);
        const { url, segments } = parseRequestTarget(request);
        if (isApiPath(segments)) {
          await dispatch(request, response, url, segments);
        } else {
          await serveWeb(request, response, url);
        }
      } catch (error) {
        const mapped = toHttpError(error);
        if (mapped.status === 500) {
          console.error("[mnemoshelf] 未預期的錯誤：", error);
        }
        try {
          if (response.destroyed || response.writableEnded) return;
          if (!response.headersSent) sendJson(response, mapped.status, mapped.body, mapped.headers);
          else response.end();
        } catch (sendError) {
          // 回應已寫不出去（對方斷線等）：吞掉並記錄，不讓它變成未處理的例外。
          console.error("[mnemoshelf] 回應寫入失敗：", sendError);
        }
      }
    })();

    // task 永不 reject：未處理的 rejection 在 Node 22 預設會結束行程，等於同一條崩潰路徑。
    const settled = task.catch((error: unknown) => {
      console.error("[mnemoshelf] 請求處理發生未預期的例外：", error);
    });
    inflight.add(settled);
    void settled.finally(() => inflight.delete(settled));
  };

  return {
    handler,
    indexing,
    async settled(): Promise<void> {
      // 索引是背景工作（回應會等它），這裡等所有在途請求結束。
      while (inflight.size > 0) {
        await Promise.allSettled([...inflight]);
      }
    },
  };
}
