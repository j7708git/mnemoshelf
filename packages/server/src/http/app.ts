/**
 * REST 路由（`node:http` 手寫，JSON in／JSON out；不引框架）。
 *
 * 契約（任務卡 §REST API）：
 * - `GET  /health`（免 token）→ `{status:"ok"}`
 * - `POST /roots`、`GET /roots`、`GET /roots/:id`、`PATCH /roots/:id`（改 `modalities`）、
 *   `DELETE /roots/:id?deleteData=1`
 * - `POST /roots/:id/preview`、`POST /roots/:id/index`、`POST /roots/:id/index/cancel`
 * - `GET  /roots/:id/entries?path=`（目錄子項）、`GET /roots/:id/file?path=`（文字預覽／圖片位元組）、
 *   `GET /roots/:id/thumb?path=`（縮圖）、`GET /roots/:id/index/status`（索引进度輪詢）
 * - `GET  /diagnostics`（除錯資訊匯出：版本、平台、embedder（含執行裝置與退回原因）、每 root 統計、
 *   記憶語意化狀態與背景 worker 統計；家目錄前綴遮罩成 `~`）
 * - `POST /search`（`query` 超過模型單筆輸入上限時 → `400 InputTooLongError`，見 `toHttpError`）
 * - `POST /memories`（建立後只 enqueue 背景嵌入，立即回 201）、`GET /memories`、`PATCH /memories/:id`、
 *   `POST /memories/:id/pin`、`DELETE /memories/:id`
 * - `POST /memories/search`（記憶語意召回；先過濾再排名，語意不可用時降級關鍵字，見 `memory-search.ts`）
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
import { existsSync, promises as fs, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { arch, homedir, platform } from "node:os";
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
  type MemoryPatch,
  type MemoryScope,
  type MetadataStore,
  type Modality,
  normalizeMemoryPatch,
  PathBlockedError,
  PathOutsideRootError,
  previewRoot,
  type Root,
  RootNotIndexableError,
  RootTooBroadError,
  type Embedder,
  type EmbedderInfo,
  type EmbedderRuntimeStatus,
  type VectorIndex,
  type RootMode,
  type RootPreview,
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
import { IndexStatusTracker, type IndexState, type IndexStatus } from "../index-status.js";
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
import type { MemoryEmbeddingWorker } from "../memory-embedder.js";
import { maskSecrets } from "../secret-masking.js";
import {
  MEMORY_SEARCH_DEFAULT_K,
  MEMORY_SEARCH_MAX_K,
  searchMemories,
  type MemoryRecallResponseBody,
} from "../memory-search.js";

/** JSON 請求主體上限。 */
export const MAX_JSON_BODY_BYTES = 1024 * 1024;
/** 單筆記憶內容長度上限（契約未明定，由本實作決定的濫用防護）。 */
export const MAX_MEMORY_CHARS = 8000;
/** 記憶召回查詢字串長度上限（UTF-16 長度；超過回 400）。 */
export const MAX_MEMORY_QUERY_CHARS = 2000;
/** 記憶的 agent／project 名稱長度上限（UTF-16 長度；超過回 400）。 */
export const MAX_MEMORY_METADATA_CHARS = 200;
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
export const API_PATH_PREFIXES: readonly string[] = ["health", "roots", "search", "memories", "diagnostics"];

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

/** `PATCH /roots/:id` 的請求主體（目前只有 `modalities` 可改；見 `RootPatch`）。 */
export interface PatchRootRequest {
  modalities?: Modality[];
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
  /** 記憶內容一律視為不受信任資料（agent 僅是來源標記，不是身分驗證）。 */
  untrusted: true;
}

/**
 * `PATCH /memories/:id` 的請求主體（共享開關）。
 *
 * 只接受 `scope`／`project`；其餘欄位（`content`、`kind`、`pinned` 等）一律 `400`（不靜默忽略）。
 * 至少提供一個欄位；`scope: "project"` 時 `project` 必須明確給非空字串。
 */
export interface PatchMemoryRequest {
  scope?: MemoryScope;
  project?: string | null;
}

/** `POST /roots/:id/index` 的回應（`IndexRootResult` 摘要＋量測）。 */
export interface IndexRootResponse extends IndexRootResult {
  rootId: number;
  durationMs: number;
}

/**
 * `POST /roots/:id/index` 在**索引被取消**時的回應。
 *
 * 取消是正常的使用者操作，不是伺服器錯誤，因此仍回 200；`cancelled` 讓呼叫端能區分
 * 「這一輪跑完」與「被中止」。真正的狀態以 `GET /roots/:id/index/status` 為準
 * （此時為 `cancelled`）。
 */
export interface IndexCancelledResponse {
  rootId: number;
  durationMs: number;
  cancelled: true;
}

/** `POST /roots/:id/index/cancel` 的回應。 */
export interface CancelIndexResponse {
  rootId: number;
  /** 一律為 true；沒有進行中的索引時回 404 而非此主體。 */
  cancelled: boolean;
}

// ---------------------------------------------------------------------------
// 除錯資訊匯出（`GET /diagnostics`）
// ---------------------------------------------------------------------------

/** `GET /diagnostics` 的應用與環境資訊。 */
export interface DiagnosticsAppInfo {
  name: string;
  /** 服務（`@mnemoshelf/server`）的 package.json version。 */
  version: string;
  /** `process.version`（例如 `v22.14.0`）。 */
  node: string;
  /** `os.platform()`（例如 `linux`／`darwin`／`win32`）。 */
  platform: string;
  /** `os.arch()`（例如 `x64`／`arm64`）。 */
  arch: string;
}

/**
 * 一個 root 的檔案統計。
 *
 * 來源是**既有**的 preview 或索引結果（見 `DiagnosticsRoot.statsSource`）；
 * 索引結果不含位元組／模態分佈／chunk 估計，因此那些欄位為 `null`。
 */
export interface DiagnosticsFileStats {
  totalFiles: number;
  /** 總位元組；索引結果不帶此欄位 → `null`。 */
  totalBytes: number | null;
  /** 依模態分佈；索引結果不帶 → `null`。 */
  byKind: Record<string, { count: number; bytes: number }> | null;
  /** 被跳過的檔案依 `reason` 短標籤分組的計數。 */
  skippedByReason: Record<string, number>;
  /** 粗估 chunk 數；索引結果不帶 → `null`。 */
  estimatedChunks: number | null;
}

/**
 * 一個 root 最近一次索引結果的摘要（**本行程記憶體**；服務重啟後為 `null`）。
 *
 * 計數優先用完成的 `result`，索引仍在進行時退回最近一次 `progress`。
 */
export interface DiagnosticsIndexSummary {
  state: IndexState;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  total: number | null;
  processed: number | null;
  skippedUnchanged: number | null;
  /** 被跳過的檔案數（不含 `skippedUnchanged`）。 */
  skippedFiles: number;
  /** 處理失敗的檔案數。 */
  failedFiles: number;
  /** 失敗檔依短標籤 `reason` 分組的計數。 */
  failedByReason: Record<string, number>;
}

/** 一個 root 的診斷資訊（路徑等字串的家目錄前綴已遮罩成 `~`）。 */
export interface DiagnosticsRoot {
  id: number;
  /** 家目錄前綴已遮罩成 `~`。 */
  path: string;
  mode: RootMode;
  modalities: Modality[];
  include: string[];
  exclude: string[];
  respectGitignore: boolean;
  createdAt: string;
  /** 上次 preview 或索引的統計；從未量測過為 `null`。 */
  stats: DiagnosticsFileStats | null;
  /** 統計來源；從未 preview／索引過為 `null`。 */
  statsSource: "preview" | "index" | null;
  /** 從未 preview／索引過（`stats === null`）時為 true；不讓整體診斷失敗。 */
  statsUnavailable: boolean;
  lastIndex: DiagnosticsIndexSummary | null;
}

/** `GET /diagnostics` 的回應。 */
export interface DiagnosticsResponse {
  generatedAt: string;
  app: DiagnosticsAppInfo;
  /** embedder 的能力宣告（`id` 含 dtype 等識別資訊）。 */
  embedder: EmbedderInfo;
  /**
   * embedder 的執行裝置狀態（實際使用的 device／退回原因／批次視窗）。
   *
   * embedder 未提供 `runtimeStatus`（例如測試用的假實作）時為 `null`。模型尚未載入時
   * `device` 是依平台與設定解析出的計畫值（`loaded: false`）。
   */
  embedderRuntime: EmbedderRuntimeStatus | null;
  roots: DiagnosticsRoot[];
  /** 進行中的索引任務（本行程；沒有時為空陣列）。 */
  indexing: { rootId: number; startedAt: string | null }[];
  /** 記憶語意化的狀態與背景 worker 統計（卡 B1；additive 欄位）。 */
  memories: DiagnosticsMemoryEmbedding;
}

/**
 * `GET /diagnostics` 的記憶語意化統計（卡 B1）。
 *
 * `total`／四個狀態數／`stale` 來自 `MetadataStore.memoryEmbeddingStats`
 * （`total = pending + ready + failed + tooLong`）；`worker.*` 是本行程 worker 的累計計數
 * （重啟歸零，佇列長度是即時值）。
 */
export interface DiagnosticsMemoryEmbedding {
  /** 未刪除的記憶總數。 */
  total: number;
  ready: number;
  pending: number;
  failed: number;
  tooLong: number;
  /** `ready` 但 embedder 身分與目前 embedder 不同（換 embedder 後待重嵌）。 */
  stale: number;
  worker: {
    queued: number;
    processing: number;
    embedded: number;
    failed: number;
    tooLong: number;
  };
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
  /** 記憶向量背景 worker（卡 B1）：`POST /memories` enqueue、診斷讀 stats。 */
  memoryEmbedder: MemoryEmbeddingWorker;
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
 * 從未知錯誤取出穩定錯誤碼（duck-typing）。
 *
 * `server` **不得** import embedder 套件（依賴方向相反），因此不判 `instanceof`，
 * 只看錯誤物件上有沒有一個字串 `code`——這正是 embedder 契約的跨套件標記
 * （見 `docs/embedder-contract.md` §無法解碼／處理的輸入；core 以同樣方式判 `undecodable`）。
 */
function errorCodeOf(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
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
  // embedder 的輸入類失敗（穩定錯誤碼，見 docs/embedder-contract.md §無法解碼／處理的輸入）。
  // `/search` 的 `query` 沒有長度上限：一份超過模型單筆上限的查詢會讓 `embedQuery` 拋
  // `input-too-long`，那是一個**使用者可修正的輸入問題**，不該變成 500「伺服器內部錯誤」。
  // server **不得** import embedder 套件，故以 duck-typing 判 `code`（沿用 repo 既有
  // 「以穩定碼／名稱辨識」的跨套件慣例；core 的 `isMediaDecodeError` 同款）。
  if (errorCodeOf(error) === "input-too-long") {
    return {
      status: 400,
      body: named("InputTooLongError", "輸入超過模型的單筆輸入上限（token 數過多），請縮短後再試"),
      headers: {},
    };
  }
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

/**
 * 把家目錄前綴換成 `~`（跨平台：`/` 與 `\` 都視為分隔符）。
 *
 * 為什麼要自己處理分隔符：`node:path` 在 POSIX 上不把 `\` 當分隔符，Windows 風格的
 * 字串（例如 `C:\Users\<user>\docs`）在 Linux 上以 `path.relative` 比對會失準。
 * 這裡先把兩種分隔符正規化成 `/` 再比對，因此同一份程式碼在三平台都能正確遮罩。
 *
 * 只在「值就是家目錄本身，或家目錄後面緊接分隔符」時替換，避免把 `/home/user2`
 * 誤遮成 `~2`；沒命中時原樣回傳。命中時的結果一律以 `/` 分隔（便於閱讀、不含 OS 差異）。
 * Windows 磁碟路徑（`C:\...`）不分大小寫；POSIX 路徑區分大小寫。
 */
export function maskHomePath(value: string, homeDir: string): string {
  if (homeDir.length === 0) return value;
  const normalize = (input: string): string => input.replace(/\\/g, "/").replace(/\/+$/, "");
  const home = normalize(homeDir);
  if (home.length === 0) return value;
  const target = normalize(value);

  const caseInsensitive = /^[A-Za-z]:\//.test(home);
  const comparable = caseInsensitive ? target.toLowerCase() : target;
  const prefix = caseInsensitive ? home.toLowerCase() : home;
  // 沒命中就原樣回傳（不順手改動分隔符，避免影響與家目錄無關的字串）。
  if (comparable !== prefix && !comparable.startsWith(`${prefix}/`)) return value;

  return comparable.length === prefix.length ? "~" : `~${target.slice(home.length)}`;
}

/**
 * 遞迴把輸出中**所有字串**的家目錄前綴遮成 `~`。
 *
 * 為什麼整份遞迴而不是逐欄位遮罩：診斷輸出會隨欄位演進，逐欄位處理容易漏；
 * 走完整份物件是「預設安全」的做法（新欄位自動被遮）。
 */
export function maskDiagnostics<T>(value: T, homeDir: string): T {
  if (typeof value === "string") return maskHomePath(value, homeDir) as unknown as T;
  if (Array.isArray(value)) return value.map((item) => maskDiagnostics(item, homeDir)) as unknown as T;
  if (value !== null && typeof value === "object") {
    const masked: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      masked[key] = maskDiagnostics(item, homeDir);
    }
    return masked as unknown as T;
  }
  return value;
}

/** 把帶 `reason` 的項目清單依 reason 分組計數。 */
function countByReason(entries: readonly { reason: string }[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entry of entries) counts[entry.reason] = (counts[entry.reason] ?? 0) + 1;
  return counts;
}

/**
 * 服務版本：讀 `@mnemoshelf/server` 自己的 package.json。
 *
 * 版本來源＝server 套件版本，與 release 對準（發版時 server 與 desktop 的版本
 * 同步為 release 版本；desktop 端的 tag → app 版本同步見 CI 的 desktop-release.yml）。
 * 為什麼不是桌面殼的版本：服務是獨立可跑的元件，不該相依 desktop 套件；
 * 桌面殼若要報自己的版本，需另外提供（目前未接）。讀不到時回 `"0.0.0"`，不讓診斷失敗。
 */
function readPackageVersion(): string {
  try {
    const url = new URL("../../package.json", import.meta.url);
    const parsed = JSON.parse(readFileSync(url, "utf8")) as { version?: unknown };
    if (typeof parsed.version === "string" && parsed.version.trim() !== "") return parsed.version;
  } catch {
    // 打包或非標準佈局下讀不到：回退固定值。
  }
  return "0.0.0";
}

/** 服務版本（行程啟動時讀一次）。 */
export const APP_VERSION = readPackageVersion();

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

function optionalString(value: unknown, field: string, options: { maxLength?: number } = {}): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new ValidationError(field, "必須是字串");
  if (options.maxLength !== undefined && value.length > options.maxLength) {
    throw new ValidationError(field, `長度上限 ${options.maxLength} 字元`);
  }
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

/**
 * 讀取路徑的記憶遮罩：對 `content`／`agent`／`project` 再套一次 `maskSecrets`（idempotent）。
 *
 * 既有 DB 可能存著未遮罩的舊資料，因此列表、單筆回應與召回命中都經過這裡再輸出；
 * 已遮罩過的內容不會二次匹配（`[REDACTED:...]` 不會被規則再吃一次）。
 */
function maskMemoryContent(memory: Memory): Memory {
  const content = maskSecrets(memory.content);
  const agent = maskSecrets(memory.agent);
  const project = memory.project === null ? null : maskSecrets(memory.project).text;
  if (!content.redacted && !agent.redacted && project === memory.project) return memory;
  return { ...memory, content: content.text, agent: agent.text, project };
}

/**
 * 寫入路徑的 metadata 檢查：`agent`／`project` 若含 token-like 機密 → 拒絕（400）。
 *
 * 為什麼不遮而要拒絕：agent／project 是**查詢鍵**（過濾、召回 bucket 都用它精確比對）；
 * 若在寫入時改寫，呼叫端之後用原值查不到、語意會壞掉。因此要求呼叫端換一個不含機密的值。
 */
function assertNoSecretInMetadata(value: string, field: "agent" | "project"): void {
  if (maskSecrets(value).redacted) {
    throw new ValidationError(field, "不得包含機密（偵測到可能的 token／金鑰；請移除後再寫入）");
  }
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
function optionalQueryString(value: string | null, field: string, options: { maxLength?: number } = {}): string | undefined {
  if (value === null || value.trim() === "") return undefined;
  if (options.maxLength !== undefined && value.length > options.maxLength) {
    throw new ValidationError(field, `長度上限 ${options.maxLength} 字元`);
  }
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
  /**
   * 每 root 最近一次 preview 的統計（行程內記憶體）。
   *
   * 為什麼要留：preview 端點本身不寫入任何狀態，而 `GET /diagnostics` 需要「已加入的 root
   * 上次看到什麼數字」。刻意**不**為了產診斷檔而臨時掃描磁碟（診斷不該變成慢操作），
   * 因此只回報既有結果；從未 preview 過的 root 標 `statsUnavailable`。
   */
  const lastPreviewByRoot = new Map<number, RootPreview>();
  const indexing = new Map<number, Promise<IndexRootResult>>();
  /**
   * 進行中索引的 `AbortController`（每個 root 一個，與 `indexing` 同生命週期）。
   *
   * `indexRoot` 本來就支援 `signal`；這裡只是把「誰能觸發 abort」暴露給 REST。
   * 只放進行中的任務：`finally` 移除，因此取消已結束的任務會找不到 controller（回 404）。
   */
  const indexControllers = new Map<number, AbortController>();
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

  /**
   * `PATCH /roots/:id`：更新 root 的可變設定（目前只有 `modalities`）。
   *
   * 語意：
   * - `modalities` 必須提供（本端點只改這個欄位）；缺少或非法 → `400`；未知的 root → `404`。
   * - 成功回 `200`＋更新後的 root。
   * - **不自動觸發重新索引**：改的是設定，掃描層下一次索引才會看到新的模態；
   *   關掉某個模態時既有的 chunk／向量也**不會立刻**釋放，要在下一次索引時由清理迴圈清掉
   *   （與 `DELETE`／模態切換的既有語意一致，見 README）。
   */
  const patchRoot = async (request: IncomingMessage, id: number): Promise<{ status: number; body: unknown }> => {
    await getRootOr404(id);
    const body = (await readJsonBody(request)) as unknown as PatchRootRequest;
    if (body.modalities === undefined) {
      throw new ValidationError("modalities", "必須提供要更新的欄位（目前只支援 modalities）");
    }
    const modalities = validateModalities(body.modalities);
    const updated = await deps.store.updateRoot(id, { modalities });
    // 先行 getRootOr404 之後理論上不會是 null；並行刪除時仍以 404 回應，不吞掉。
    if (updated === null) throw new NotFoundError("root", id);
    return { status: 200, body: updated };
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
    // 記住這次 preview 的統計：`GET /diagnostics` 會回報「上次量到的數字」（不重新掃描磁碟）。
    lastPreviewByRoot.set(id, preview);
    return { status: 200, body: preview };
  };

  const startIndex = async (id: number): Promise<{ status: number; body: unknown }> => {
    const root = await getRootOr404(id);
    if (root.mode !== "index") throw new RootNotIndexableError(root.id, root.mode);
    if (indexing.has(id)) throw new IndexInProgressError(id);

    const startedAt = Date.now();
    const maxFileBytes = maxFileBytesByRoot.get(id);
    const controller = new AbortController();
    indexStatus.begin(id);
    const run = indexRoot(root, {
      embedder: deps.embedder,
      store: deps.store,
      vec: deps.vec,
      signal: controller.signal,
      onProgress: (progress) => indexStatus.report(id, progress),
      ...(maxFileBytes === undefined ? {} : { maxFileBytes }),
    });
    indexing.set(id, run);
    indexControllers.set(id, controller);
    inflight.add(run);
    try {
      const result = await run;
      indexStatus.finish(id, result);
      return { status: 200, body: { rootId: id, durationMs: Date.now() - startedAt, ...result } };
    } catch (error) {
      // 取消是使用者要求（不是錯誤）：標記 `cancelled`，並以 200＋`cancelled` 回應，
      // 呼叫端才不會把正常取消當成伺服器錯誤。
      if (controller.signal.aborted) {
        indexStatus.cancel(id);
        const body: IndexCancelledResponse = { rootId: id, durationMs: Date.now() - startedAt, cancelled: true };
        return { status: 200, body };
      }
      indexStatus.fail(id, error);
      throw error;
    } finally {
      indexing.delete(id);
      indexControllers.delete(id);
      inflight.delete(run);
    }
  };

  /**
   * `POST /roots/:id/index/cancel`：中止該 root **自己的**進行中索引。
   *
   * - 只中止這個 root 的任務（controller 以 root id 存放），不影響其他 root。
   * - root 不存在 → 404；root 存在但沒有進行中的索引 → 404（沒有可取消的任務）。
   * - 中止後 `indexRoot` 拋 `AbortError`，`startIndex` 會把狀態標成 `cancelled`；
   *   已寫入的資料按檔交易，維持一致，之後可再索引（失敗／被中止的檔案下一輪重做）。
   */
  const cancelIndex = async (id: number): Promise<{ status: number; body: unknown }> => {
    await getRootOr404(id);
    const controller = indexControllers.get(id);
    if (controller === undefined) throw new NotFoundError("進行中的索引", id);
    controller.abort();
    const body: CancelIndexResponse = { rootId: id, cancelled: true };
    return { status: 200, body };
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

  /**
   * 組出 `GET /diagnostics` 的主體（尚未遮罩家目錄）。
   *
   * 統計來源優先序：**preview**（欄位最完整）→ **索引結果**（缺位元組／模態／chunk 估計）。
   * 兩者都沒有時 `stats` 為 `null`＋`statsUnavailable: true`，**不造數字、也不臨時掃描磁碟**。
   * 單一 root 缺統計不影響其他 root，整體仍回 200。
   */
  const buildDiagnostics = async (): Promise<DiagnosticsResponse> => {
    const roots = await deps.store.listRoots();
    const rootSummaries: DiagnosticsRoot[] = roots.map((root) => {
      const preview = lastPreviewByRoot.get(root.id) ?? null;
      const status = indexStatus.status(root.id);
      const result = status.result;

      let stats: DiagnosticsFileStats | null = null;
      let statsSource: "preview" | "index" | null = null;
      if (preview !== null) {
        stats = {
          totalFiles: preview.totalFiles,
          totalBytes: preview.totalBytes,
          byKind: Object.fromEntries(
            Object.entries(preview.byKind).map(([kind, stat]) => [kind, { count: stat.count, bytes: stat.bytes }]),
          ),
          skippedByReason: countByReason(preview.skipped),
          estimatedChunks: preview.estimatedChunks,
        };
        statsSource = "preview";
      } else if (result !== null) {
        stats = {
          totalFiles: result.total,
          totalBytes: null,
          byKind: null,
          skippedByReason: countByReason(result.skippedFiles),
          estimatedChunks: null,
        };
        statsSource = "index";
      }

      const lastIndex: DiagnosticsIndexSummary | null =
        status.state === "idle"
          ? null
          : {
              state: status.state,
              startedAt: status.startedAt,
              finishedAt: status.finishedAt,
              durationMs: status.durationMs,
              total: result?.total ?? status.progress?.total ?? null,
              processed: result?.processed ?? status.progress?.processed ?? null,
              skippedUnchanged: result?.skippedUnchanged ?? status.progress?.skippedUnchanged ?? null,
              skippedFiles: result?.skippedFiles.length ?? status.progress?.skipped ?? 0,
              failedFiles: result?.failedFiles.length ?? status.progress?.failed ?? 0,
              failedByReason: result === null ? {} : countByReason(result.failedFiles),
            };

      return {
        id: root.id,
        path: root.path,
        mode: root.mode,
        modalities: root.modalities,
        include: root.include,
        exclude: root.exclude,
        respectGitignore: root.respectGitignore,
        createdAt: root.createdAt,
        stats,
        statsSource,
        statsUnavailable: stats === null,
        lastIndex,
      };
    });

    const memoryStats = await deps.store.memoryEmbeddingStats(deps.embedder.info.id);
    const memoryWorkerStats = deps.memoryEmbedder.stats();

    const raw: DiagnosticsResponse = {
      generatedAt: new Date().toISOString(),
      app: {
        name: "mnemoshelf",
        version: APP_VERSION,
        node: process.version,
        platform: platform(),
        arch: arch(),
      },
      embedder: deps.embedder.info,
      // 執行裝置狀態（選填能力）：DML／CPU、退回原因、批次視窗；未提供時為 null。
      embedderRuntime: deps.embedder.runtimeStatus ?? null,
      roots: rootSummaries,
      indexing: [...indexing.keys()].map((rootId) => ({ rootId, startedAt: indexStatus.status(rootId).startedAt })),
      memories: {
        total: memoryStats.total,
        ready: memoryStats.ready,
        pending: memoryStats.pending,
        failed: memoryStats.failed,
        tooLong: memoryStats.tooLong,
        stale: memoryStats.stale,
        // 本行程累計；重啟歸零、佇列長度是即時值（卡 B1）。
        worker: {
          queued: memoryWorkerStats.queued,
          processing: memoryWorkerStats.processing,
          embedded: memoryWorkerStats.embedded,
          failed: memoryWorkerStats.failed,
          tooLong: memoryWorkerStats.tooLong,
        },
      },
    };
    // 一律遮罩家目錄前綴：不輸出使用者家目錄的絕對路徑（見 repo 隱私規範）。
    return maskDiagnostics(raw, homeDir);
  };

  /** `GET /diagnostics`：匯出環境與統計事實（家目錄前綴遮罩；不含檔案內容／token／子檔案清單）。 */
  const getDiagnostics = async (): Promise<RouteResult> => {
    return { status: 200, body: await buildDiagnostics() };
  };

  const removeRoot = async (id: number, deleteData: boolean): Promise<{ status: number; body: unknown }> => {
    await getRootOr404(id);
    if (indexing.has(id)) throw new IndexInProgressError(id);
    const { removedChunkIds } = await deps.store.removeRoot(id, deleteData);
    if (deleteData) await deps.vec.deleteByRoot(id);
    maxFileBytesByRoot.delete(id);
    lastPreviewByRoot.delete(id);
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
   *
   * 被取代者原本若已釘選，新版本**繼承**其 `pinned`（`NewMemory` 契約仍無 `pinned`，
   * 新記憶一律 `false`；這裡是 server 端在建立後補一次 `setMemoryPinned` 的行為細節）。
   *
   * **O2（卡 B1）scope／project 正規化**：
   * - `scope` 省略且有 `project` → 視為 `scope: "project"`（方便呼叫端；避免默默存出矛盾組合）；
   * - `scope` 省略且無 `project` → `global`（維持既有預設）；
   * - `scope: "project"` 且 `project` 缺少／空字串 → `400`（專案名 trim 後儲存）；
   * - `scope: "global" | "agent"` 且帶非 null `project` → `400`。
   *
   * 建立成功後只把 id 交給背景 worker（`memoryEmbedder.enqueue`）：**不等待嵌入**，
   * 回應仍是立即的 `201`；向量稍後就緒（狀態見 `GET /diagnostics` 的 `memories`）。
   */
  const addMemory = async (request: IncomingMessage): Promise<{ status: number; body: unknown }> => {
    const body = await readJsonBody(request);
    const rawContent = requireString(body.content, "content", { maxLength: MAX_MEMORY_CHARS });
    // 寫入前先遮罩可辨識的機密（不回傳、不記錄原文）；`redacted` 會是回應的 additive 欄位。
    const maskedContent = maskSecrets(rawContent);
    const content = maskedContent.text;
    const agent = requireString(body.agent, "agent", { maxLength: MAX_MEMORY_METADATA_CHARS });
    assertNoSecretInMetadata(agent, "agent");
    const kind = enumValue(body.kind, MEMORY_KINDS, "kind", "fact");

    const projectInput = optionalString(body.project, "project", { maxLength: MAX_MEMORY_METADATA_CHARS });
    const hasProject = projectInput !== undefined;
    let scope: MemoryScope;
    if (body.scope === undefined) {
      // 省略 scope：有 project 就視為 project，否則沿用既有預設 global。
      scope = hasProject ? "project" : "global";
    } else {
      // **顯式**提供的 scope 必須是合法字串；`null`／數字／其他型別一律 400——
      // 不把「非字串」靜默當成「未指定」（O2／O4，卡 B1）。
      if (body.scope === null) throw new ValidationError("scope", `必須是 ${MEMORY_SCOPES.join(" / ")} 之一`);
      scope = enumValue(body.scope, MEMORY_SCOPES, "scope", "global");
    }
    let project: string | null = null;
    if (scope === "project") {
      const trimmed = projectInput?.trim() ?? "";
      if (trimmed === "") throw new ValidationError("project", "scope 為 project 時必須提供非空的專案名稱");
      project = trimmed;
    } else if (hasProject) {
      throw new ValidationError("project", `scope 為 ${scope} 時 project 必須是 null（全域／agent 範圍沒有專案）`);
    }
    if (project !== null) assertNoSecretInMetadata(project, "project");
    const supersedes = optionalId(body.supersedes, "supersedes");

    // 先讀被取代者（若存在）的 pinned：建立新記憶會把舊版軟刪除，之後仍可讀，但先讀較清楚。
    const replaced = supersedes === null ? null : await deps.store.getMemory(supersedes);
    let memory: Memory = await deps.store.addMemory({ content, kind, scope, project, agent, supersedes });
    if (replaced?.pinned === true) {
      await deps.store.setMemoryPinned(memory.id, true);
      memory = (await deps.store.getMemory(memory.id)) ?? memory;
    }
    // 背景、非阻塞：回應不必等模型。supersedes 產生的新版本同樣要嵌入。
    deps.memoryEmbedder.enqueue(memory.id);
    // `Memory` 公開型別不變；`redacted`／`redactedCount` 只是這個端點的 additive 回應欄位。
    return {
      status: 201,
      body: { ...memory, redacted: maskedContent.redacted, redactedCount: maskedContent.count },
    };
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
    const existing = await deps.store.getMemory(id);
    if (existing === null) throw new NotFoundError("記憶", id);
    await deps.store.setMemoryPinned(id, pinned);
    const updated = await deps.store.getMemory(id);
    return { status: 200, body: updated === null ? null : maskMemoryContent(updated) };
  };

  const forgetMemory = async (id: number): Promise<{ status: number; body: unknown }> => {
    const memory = await deps.store.getMemory(id);
    if (memory === null) throw new NotFoundError("記憶", id);
    const alreadyDeleted = memory.deletedAt !== null;
    if (!alreadyDeleted) await deps.store.forgetMemory(id);
    return { status: 200, body: { id, deleted: !alreadyDeleted } };
  };

  /**
   * `PATCH /memories/:id`：更新記憶的範圍與專案（共享開關）。
   *
   * 規格（卡 A §2）：
   * - 主體 `{scope?, project?}`；只接受這兩個欄位，其餘（`content`、`kind`、`pinned`…）→ `400`，
   *   不靜默忽略；至少提供一個欄位，否則 `400`。
   * - `scope` 非合法值 → `400`；`project` 非字串／非 null → `400`。
   * - `scope: "project"` 且 `project` 缺少／空字串 → `400`（**必須明確指定**目標專案）；
   *   `scope: "global" | "agent"` 且帶非 null `project` → `400`。
   * - 不存在的 id 或已軟刪除 → `404`；成功回 `200`＋更新後的完整 `Memory`。
   *
   * 驗證分兩層：先做請求形狀（與上述明確規則），再讀現值用 `normalizeMemoryPatch`
   * 驗「合併後的結果」（例如只帶非 null `project` 但現值 scope 不是 project）。實際寫入仍走
   * `store.updateMemory`（同一套正規化語意在儲存層把關）。
   */
  const patchMemory = async (request: IncomingMessage, id: number): Promise<{ status: number; body: unknown }> => {
    const body = await readJsonBody(request);
    const allowedFields: readonly string[] = ["scope", "project"];
    for (const key of Object.keys(body)) {
      if (!allowedFields.includes(key)) {
        throw new ValidationError(key, "不支援的欄位（共享開關只能改 scope 與 project）");
      }
    }
    if (body.scope === undefined && body.project === undefined) {
      throw new ValidationError("body", "至少要提供 scope 或 project");
    }

    const patch: MemoryPatch = {};
    if (body.scope !== undefined) {
      if (typeof body.scope !== "string" || !(MEMORY_SCOPES as readonly string[]).includes(body.scope)) {
        throw new ValidationError("scope", `必須是 ${MEMORY_SCOPES.join(" / ")} 之一`);
      }
      patch.scope = body.scope as MemoryScope;
    }
    if (body.project !== undefined) {
      if (body.project !== null && typeof body.project !== "string") {
        throw new ValidationError("project", "必須是字串或 null");
      }
      if (typeof body.project === "string" && body.project.length > MAX_MEMORY_METADATA_CHARS) {
        throw new ValidationError("project", `長度上限 ${MAX_MEMORY_METADATA_CHARS} 字元`);
      }
      if (typeof body.project === "string") assertNoSecretInMetadata(body.project, "project");
      patch.project = body.project as string | null;
    }

    // 明確規則：切成專案時一定要指定目標專案；非專案範圍不得帶專案。
    if (patch.scope === "project") {
      if (patch.project === undefined || patch.project === null || patch.project.trim() === "") {
        throw new ValidationError("project", "scope 為 project 時必須提供非空的專案名稱");
      }
    } else if (patch.scope !== undefined && patch.project !== undefined && patch.project !== null) {
      throw new ValidationError("project", `scope 為 ${patch.scope} 時 project 必須是 null`);
    }

    const existing = await deps.store.getMemory(id);
    if (existing === null || existing.deletedAt !== null) throw new NotFoundError("記憶", id);

    // 合併現值後再驗一次（例如 scope 未提供、卻帶了非 null project 的 patch）。
    try {
      normalizeMemoryPatch(existing, patch);
    } catch (error) {
      throw new ValidationError("patch", error instanceof Error ? error.message : "非法的 patch");
    }

    const updated = await deps.store.updateMemory(id, patch);
    // 讀到之後才被軟刪除的競態：與未知 id 同樣回 404，不吞掉。
    if (updated === null) throw new NotFoundError("記憶", id);
    return { status: 200, body: maskMemoryContent(updated) };
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
      if (method === "PATCH") return await patchRoot(request, id);
      if (method === "DELETE") return await removeRoot(id, booleanFlag(url.searchParams.get("deleteData"), "deleteData", false));
      throw new MethodNotAllowedError(method, ["GET", "PATCH", "DELETE"]);
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

    // `GET /roots/:id/index/status`（索引进度輪詢）與 `POST /roots/:id/index/cancel`（取消）。
    if (segments.length === 4 && segments[2] === "index" && segments[3] === "status") {
      if (method !== "GET") throw new MethodNotAllowedError(method, ["GET"]);
      return await getIndexStatus(id);
    }
    if (segments.length === 4 && segments[2] === "index" && segments[3] === "cancel") {
      if (method !== "POST") throw new MethodNotAllowedError(method, ["POST"]);
      return await cancelIndex(id);
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
    const project = optionalQueryString(params.get("project"), "project", {
      maxLength: MAX_MEMORY_METADATA_CHARS,
    });
    const agent = optionalQueryString(params.get("agent"), "agent", { maxLength: MAX_MEMORY_METADATA_CHARS });
    const limit = queryLimit(params.get("limit"));

    const memories = (await deps.store.listMemories({
      ...(kind === undefined ? {} : { kind }),
      ...(scope === undefined ? {} : { scope }),
      ...(project === undefined ? {} : { project }),
      ...(agent === undefined ? {} : { agent }),
      ...(limit === undefined ? {} : { limit }),
    })).map(maskMemoryContent);
    // 頂層的 trust 標記：記憶內容一律視為不受信任資料（不改 `Memory` 型別）。
    return { status: 200, body: { memories, untrusted: true } };
  };

  /**
   * `POST /memories/search`：記憶語意召回（卡 B2）。
   *
   * 驗證在這裡做（形狀與 400 邊界），召回流程（bucket 組法／語意優先／關鍵字降級／minScore）
   * 在 `memory-search.ts`（REST 與 MCP 共用同一條路徑）：
   * - `query` 必填非空；`k` 非正整數 → 400，超過上限夾到 `MEMORY_SEARCH_MAX_K`（100）；
   * - `scope`／`kind` 有提供時必須是合法值；`minScore` 必須在 0..1；
   * - 未提供 `project` 且未 `includeAllProjects` → 由 bucket 組法回 400（避免不明確的召回範圍）；
   * - 成功回 `200`＋`{query,k,degraded,degradedReason,memoryEmbedding,hits}`。
   */
  const searchMemoriesRoute = async (request: IncomingMessage): Promise<{ status: number; body: unknown }> => {
    const body = await readJsonBody(request);
    const query = requireString(body.query, "query", { maxLength: MAX_MEMORY_QUERY_CHARS });

    const projectRaw = optionalString(body.project, "project", { maxLength: MAX_MEMORY_METADATA_CHARS });
    const project = projectRaw === undefined ? undefined : projectRaw.trim();
    const projectValue = project === "" ? undefined : project;

    const includeAllProjects = optionalBoolean(body.includeAllProjects, "includeAllProjects");

    let scope: MemoryScope | undefined;
    if (body.scope !== undefined) {
      if (typeof body.scope !== "string" || !(MEMORY_SCOPES as readonly string[]).includes(body.scope)) {
        throw new ValidationError("scope", `必須是 ${MEMORY_SCOPES.join(" / ")} 之一`);
      }
      scope = body.scope as MemoryScope;
    }

    const agentRaw = optionalString(body.agent, "agent", { maxLength: MAX_MEMORY_METADATA_CHARS });
    const agent = agentRaw === undefined || agentRaw.trim() === "" ? undefined : agentRaw;

    let kind: MemoryKind | undefined;
    if (body.kind !== undefined) {
      if (typeof body.kind !== "string" || !(MEMORY_KINDS as readonly string[]).includes(body.kind)) {
        throw new ValidationError("kind", `必須是 ${MEMORY_KINDS.join(" / ")} 之一`);
      }
      kind = body.kind as MemoryKind;
    }

    let k = MEMORY_SEARCH_DEFAULT_K;
    if (body.k !== undefined) {
      if (typeof body.k !== "number" || !Number.isInteger(body.k) || body.k <= 0) {
        throw new ValidationError("k", "必須是正整數");
      }
      k = Math.min(body.k, MEMORY_SEARCH_MAX_K);
    }

    let minScore: number | undefined;
    if (body.minScore !== undefined) {
      if (
        typeof body.minScore !== "number" ||
        !Number.isFinite(body.minScore) ||
        body.minScore < 0 ||
        body.minScore > 1
      ) {
        throw new ValidationError("minScore", "必須是 0 到 1 之間的數字");
      }
      minScore = body.minScore;
    }

    const result: MemoryRecallResponseBody = await searchMemories(
      { store: deps.store, embedder: deps.embedder },
      {
        query,
        ...(projectValue === undefined ? {} : { project: projectValue }),
        ...(includeAllProjects === undefined ? {} : { includeAllProjects }),
        ...(scope === undefined ? {} : { scope }),
        ...(agent === undefined ? {} : { agent }),
        ...(kind === undefined ? {} : { kind }),
        k,
        ...(minScore === undefined ? {} : { minScore }),
      },
    );
    return { status: 200, body: result };
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
    if (segments.length === 2 && segments[1] === "search") {
      if (method !== "POST") throw new MethodNotAllowedError(method, ["POST"]);
      return await searchMemoriesRoute(request);
    }
    if (segments.length === 2) {
      if (method === "DELETE") return await forgetMemory(parseId(segments[1]!, "記憶"));
      if (method === "PATCH") return await patchMemory(request, parseId(segments[1]!, "記憶"));
      throw new MethodNotAllowedError(method, ["DELETE", "PATCH"]);
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
      case "diagnostics":
        if (segments.length !== 1) throw new NotFoundError("路徑");
        if (method !== "GET") throw new MethodNotAllowedError(method, ["GET"]);
        result = await getDiagnostics();
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
