/**
 * REST 路由（`node:http` 手寫，JSON in／JSON out；不引框架）。
 *
 * 契約（任務卡 §REST API）：
 * - `GET  /health`（免 token）→ `{status:"ok", service:"mnemoshelf", appVersion:"<版本>", build:"<commit>"}`
 *   （`service`／`appVersion`／`build` 是 additive 欄位；agent 用它確認連到的是 Mnemoshelf，
 *   降低「無關程式剛好佔用同一個埠」的風險——但它是免 token 的自我宣告，可被偽造，
 *   不防刻意偽造；見 `docs/roots-and-privacy.md` §信任模型）
 * - `POST /roots`、`GET /roots`、`GET /roots/:id`、`PATCH /roots/:id`（改 `modalities`）、
 *   `DELETE /roots/:id?deleteData=1`
 * - `POST /roots/:id/preview`、`POST /roots/:id/index`、`POST /roots/:id/index/cancel`
 * - `GET  /roots/:id/entries?path=`（目錄子項）、`GET /roots/:id/file?path=`（文字預覽／圖片位元組）、
 *   `GET /roots/:id/thumb?path=`（縮圖）、`GET /roots/:id/index/status`（索引进度輪詢）
 * - `GET|HEAD /roots/:id/media?path=`（影片播放：受 token／root 守衛的單一 Range；206／416、
 *   單次上限 4 MiB、串流不快取；見 `media.ts`）
 * - `GET  /diagnostics`（除錯資訊匯出：版本、平台、embedder（含執行裝置與退回原因）、每 root 統計、
 *   影片能力與解碼器狀態、記憶語意化狀態與背景 worker 統計；家目錄前綴遮罩成 `~`）
 * - `POST /search`（`query` 超過模型單筆輸入上限時 → `400 InputTooLongError`，見 `toHttpError`）
 * - `POST /memories`（精確去重：重複回 200＋`duplicate: true`，新增回 201 並 enqueue 背景嵌入）、
 *   `GET /memories`、`PATCH /memories/:id`、`POST /memories/:id/pin`、
 *   `DELETE /memories/:id`（預設軟刪除；`?hard=true` 硬刪除）
 * - `GET  /memories/export`（NDJSON 備份下載；讀取遮罩視圖、只含未刪除）
 *   `POST /memories/import`（NDJSON 匯入；raw body 上限 32 MiB、`?dryRun=1` 只預覽、
 *   整批先驗證，任何一行不合法就 400 且不寫）
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
  DEFAULT_VIDEO_MAX_FILE_BYTES,
  type DecoderAvailability,
  DuplicateRootError,
  indexRoot,
  isBlocked,
  type IndexRootOptions,
  type IndexRootResult,
  type IndexTimingEvent,
  MEMORY_SCOPES,
  type Memory,
  type MemoryKind,
  type MemoryPatch,
  type MemoryPolicy,
  MemorySourceConflictError,
  memorySourceEventHash,
  type MediaDecoder,
  type MemoryScope,
  type MetadataStore,
  type Modality,
  normalizeMemoryPatch,
  normalizeMemorySourceScope,
  normalizeRootMaxFileBytes,
  normalizeRootVideoMaxFileBytes,
  PathBlockedError,
  PathOutsideRootError,
  previewRoot,
  type Root,
  RootNotIndexableError,
  type RootPatch,
  RootTooBroadError,
  type Embedder,
  type EmbedderInfo,
  type EmbedderRuntimeStatus,
  type VectorIndex,
  type RootMode,
  type RootPreview,
  VIDEO_MAX_DURATION_SECONDS,
} from "@mnemoshelf/core";
import { LOOPBACK_HOST } from "../config.js";
import type { EmbedderSchedulingStatus } from "../worker-embedder.js";
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
import { buildMediaResponse, MediaSourceChangedError, sendStreamResult, type StreamRouteResult } from "./media.js";
import { MediaSessions, MediaOriginError, requireMediaOrigin } from "./media-sessions.js";
import { prepareUnifiedSearch, type SearchMode } from "../search.js";
import type { MemoryEmbeddingWorker } from "../memory-embedder.js";
import { maskSecrets } from "../secret-masking.js";
import {
  MEMORY_SEARCH_DEFAULT_K,
  MEMORY_SEARCH_MAX_K,
  buildMemorySearchBuckets,
  prepareMemoryRecall,
} from "../memory-search.js";
import {
  countImportDuplicates,
  MAX_MEMORY_CHARS,
  MAX_MEMORY_IMPORT_BYTES,
  MAX_MEMORY_METADATA_CHARS,
  MEMORY_EXPORT_CONTENT_TYPE,
  MEMORY_KINDS,
  memoryExportFilename,
  parseDryRunParam,
  planMemoryImport,
  serializeMemoriesExport,
  serializeRawMemoriesExport,
  type MemoryImportResponse,
} from "../memory-export.js";

import {
  createMemoryPresenter,
  loadCurrentMemoryPresentations,
  loadMemoryPresentations,
  memoryContentView,
  type PrepareMemoryPresentation,
} from "../memory-policy.js";
import {
  isMemoryVisible,
  MAX_MEMORY_SOURCE_BYTES,
  MemoryPolicyChangedError,
  paginateMemorySource,
  parseSourcePageOptions,
  parseSourceWriteRequest,
  prepareMemorySource,
  sourceMetadata,
} from "../memory-source.js";

/** JSON 請求主體上限。 */
export const MAX_JSON_BODY_BYTES = 1024 * 1024;
/** 記憶召回查詢字串長度上限（UTF-16 長度；超過回 400）。 */
export const MAX_MEMORY_QUERY_CHARS = 2000;
/**
 * 請求 URL（request-target）長度上限。
 *
 * 為什麼需要：request-target 會被切成路徑片段並逐段 `decodeURIComponent`，長度不設限就是
 * 一條免認證的記憶體／CPU 放大路徑（Node 的 HTTP parser 上限約 16 KB，仍遠大於實際需求）。
 * 超過者回 414，不進路由。
 */
export const MAX_REQUEST_URL_LENGTH = 8 * 1024;

// 記憶的長度上限定義在 `../memory-export.js`（REST 寫入與 NDJSON 匯入共用同一組）；
// 這裡保持原本的公開匯出路徑，呼叫端不需要改 import。
export { MAX_MEMORY_CHARS, MAX_MEMORY_METADATA_CHARS } from "../memory-export.js";

const MODALITIES: readonly Modality[] = ["text", "code", "image", "audio", "video"];

/**
 * 與影片有關的 skip／failed 原因（診斷只計這些，不把文字／音訊的原因混進影片統計）。
 *
 * 清單對齊 core：掃描階段兩個（`unsupported-video-format`／`video-too-large`）、
 * 處理階段六個（時長／解析度／無影像流／壞檔／codec／音軌），以及 decoder 環境錯誤。
 */
const VIDEO_INDEX_REASONS: ReadonlySet<string> = new Set([
  "unsupported-video-format",
  "video-too-large",
  "video-duration-exceeded",
  "video-resolution-exceeded",
  "video-no-stream",
  "invalid-video",
  "unsupported-video-codec",
  "unsupported-video-audio-track",
  "video-decoder-unavailable",
  "video-decode-timeout",
  "video-decode-cancelled",
  "video-not-found",
]);

/**
 * API 的第一段路徑前綴。
 *
 * 只有這些前綴會進 API 路由（要 token）；其餘路徑才可能由靜態檔／SPA fallback 服務。
 * 這個分界必須與 `dispatch` 的 `switch (segments[0])` 一致。
 */
export const API_PATH_PREFIXES: readonly string[] = ["health", "roots", "search", "memories", "memory-policy", "memory-sources", "diagnostics"];

/** 靜態檔回應的 CSP（UI 與 API 同源；`<img>` 走 blob/data，故放行 blob: 與 data:）。 */
export const STATIC_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' blob: data:",
  "media-src 'self' blob:",
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
  /**
   * 通用單檔大小上限（bytes；**per-root 持久化**，寫入 `Root.maxFileBytes`）。
   *
   * - 未提供或 `null`＝未設定（沿用服務層預設 10 MiB）；
   * - 有值必須是 1–16 GiB 的整數，否則 `400 ValidationError`；
   * - 影片不套用此上限（見 `videoMaxFileBytes`）。
   */
  maxFileBytes?: number | null;
  /**
   * 影片單檔大小上限（bytes；**per-root 持久化**，寫入 `Root.videoMaxFileBytes`）。
   *
   * - 未提供或 `null`＝未設定（沿用行程層 `MNEMOSHELF_VIDEO_MAX_FILE_BYTES`，再退回 512 MiB）；
   * - 有值必須是 1–16 GiB 的整數，否則 `400 ValidationError`。
   */
  videoMaxFileBytes?: number | null;
  /**
   * 是否允許 agent 搜尋這個 root（**per-root 持久化**）；未提供＝`false`（預設關閉）。
   *
   * 這是分享意圖／防誤用，不是安全邊界（單一 token 仍是本機 owner 全權）。
   */
  allowAgentSearch?: boolean;
}

/**
 * `PATCH /roots/:id` 的請求主體（見 `RootPatch`）。
 *
 * 四個欄位至少要提供一項；未提供的欄位＝不變。
 */
export interface PatchRootRequest {
  modalities?: Modality[];
  /** 是否允許 agent 搜尋（只影響之後的搜尋範圍，不需重新索引）。 */
  allowAgentSearch?: boolean;
  /** 通用單檔大小上限（bytes）；`null`＝清除設定（回服務層預設 10 MiB）、未提供＝不改。 */
  maxFileBytes?: number | null;
  /** 影片單檔大小上限（bytes）；`null`＝清除設定（回行程層預設）、未提供＝不改。 */
  videoMaxFileBytes?: number | null;
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
  policyVersion: number;
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

/**
 * `POST /memories` 的回應（卡 C2 的 additive 欄位；`Memory` 公開型別本身不變）。
 *
 * - `duplicate: true` 只會出現在 `200`：已有同 key 的未刪除記憶，這次沒有新增、也沒有 enqueue。
 * - `redacted`／`redactedCount` 描述這次**寫入前**的遮罩結果（與既有行為相同）；
 *   重複時為 `false`／`0`（沒有寫入任何內容）。
 */
export interface AddMemoryResponse extends Memory {
  duplicate: boolean;
  redacted: boolean;
  redactedCount: number;
}

/** `DELETE /memories/:id` 的軟刪除回應（形狀與 C2 之前相同）。 */
export interface ForgetMemoryResponse {
  id: number;
  deleted: boolean;
}

/** `DELETE /memories/:id?hard=true` 的硬刪除回應。 */
export interface HardDeleteMemoryResponse {
  id: number;
  deleted: true;
  hard: true;
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

/**
 * 影片能力不可用的固定原因碼。
 *
 * - `missing-ffmpeg`／`missing-ffprobe`：binary 不存在（decoder 已設定但檔案不在）；
 * - `ffmpeg-failed`／`ffprobe-failed`：binary 損毀、不可執行或 `-version` 失敗；
 * - `embedder-video-unsupported`：解碼器可用，但 embedder 沒有宣告／提供影片入口。
 *
 * 刻意不含路徑與 stderr：這是給 UI 顯示「為什麼影片不能用」的穩定標籤。
 */
export type VideoCapabilityReason =
  | "missing-ffmpeg"
  | "missing-ffprobe"
  | "ffmpeg-failed"
  | "ffprobe-failed"
  | "embedder-video-unsupported";

/**
 * 影片能力的對外摘要（additive；`GET /roots`、preview 與 `/diagnostics` 共用同一個形狀）。
 *
 * 為什麼要三態：`supportedModalities` 只是掃描層的內部選項，客戶端看不到；若只憑
 * 「preview 沒有列出影片候選」無法區分「使用者沒開／伺服器沒裝 decoder」與「裝了但壞掉」。
 * UI（C2）可據此先停用影片開關並顯示原因，而不是讓使用者開了才在索引時失敗。
 */
export interface VideoCapability {
  /** 服務是否已把影片接進預覽／索引（decoder 已設定＋可用＋embedder 具備影片入口）。 */
  available: boolean;
  /**
   * 三態：
   * - `disabled`：沒有設定 decoder（產品預設；影片模態會以 `unsupported-modality` 跳過）；
   * - `unavailable`：decoder 已設定但不可用（或 embedder 不支援影片）；索引時影片檔會以
   *   `video-decoder-unavailable` 等具名原因失敗，不是靜默跳過；
   * - `available`：可預覽、索引與播放。
   */
  state: "disabled" | "unavailable" | "available";
  /** `unavailable` 時的固定原因碼；`available`／`disabled` 為 `null`。 */
  reason: VideoCapabilityReason | null;
  /** embedder 是否宣告並提供影片入口（模型能力；與 decoder 可用性分開）。 */
  embedderVideo: boolean;
  /**
   * 影片單檔大小上限的**服務層預設**（bytes）；個別 root 可用 `Root.videoMaxFileBytes`
   * 覆寫。實際生效值＝`root.videoMaxFileBytes ?? maxFileBytes`。
   */
  maxFileBytes: number;
  /** 影片時長上限（秒；由解碼器強制，固定 600）。 */
  durationLimitSeconds: number;
  /** decoder 版本（可用時；不含路徑）。 */
  ffmpegVersion: string | null;
  ffprobeVersion: string | null;
}

/**
 * 本行程的影片索引統計（不含任何路徑／檔名）。
 *
 * 來源是**最近一輪**索引結果與最近一次 preview（行程內記憶體；重啟歸零）；
 * 與 `roots[].stats` 的通用統計分開，因為影片的原因碼需要單獨對帳
 * （例如 `video-too-large` 是掃描階段、`video-decoder-unavailable` 是處理階段）。
 */
export interface DiagnosticsVideoIndexing {
  /** 本行程「root 宣告 video 且服務已接通」並跑完的索引輪數。 */
  runs: number;
  /** 最近一輪完成的時間（ISO 8601）；從未跑過為 `null`。 */
  lastFinishedAt: string | null;
  /** 最近一輪掃描階段跳過的影片原因（例如 `video-too-large`）。 */
  scanSkippedByReason: Record<string, number>;
  /** 最近一輪處理階段跳過的影片原因（例如 `invalid-video`）。 */
  skippedByReason: Record<string, number>;
  /** 最近一輪失敗的影片原因（例如 `video-decoder-unavailable`）。 */
  failedByReason: Record<string, number>;
  /** 最近一次 preview 看到的影片候選檔數（跨 root 加總）；從未 preview 過為 `null`。 */
  previewCandidateFiles: number | null;
}

/** `GET /diagnostics` 的影片區塊：能力摘要＋解碼器狀態＋索引統計。 */
export interface DiagnosticsVideo extends VideoCapability {
  indexing: DiagnosticsVideoIndexing;
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
  /**
   * 這個 root **實際生效**的影片單檔大小上限（bytes）：
   * `root.videoMaxFileBytes` → 行程層預設（`MNEMOSHELF_VIDEO_MAX_FILE_BYTES`／512 MiB）。
   *
   * 與 `video.maxFileBytes`（服務層預設）搭配看：前者是這個 root 的值，後者是未設定時的預設。
   */
  videoMaxFileBytes: number;
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
  /** 推論排程狀態；完成視窗不代表檔案已寫入。未提供此能力時為 null。 */
  embedderScheduling: EmbedderSchedulingStatus | null;
  /** 本行程累計階段計時；embed 含排隊，prepare 含增量檢查。 */
  indexingTimings: Record<IndexTimingEvent["stage"], { calls: number; durationMs: number }>;
  roots: DiagnosticsRoot[];
  /** 進行中的索引任務（本行程；沒有時為空陣列）。 */
  indexing: { rootId: number; startedAt: string | null }[];
  /** 記憶語意化的狀態與背景 worker 統計（卡 B1；additive 欄位）。 */
  memories: DiagnosticsMemoryEmbedding;
  /** 影片能力、解碼器狀態與本行程影片索引統計（additive；不含路徑）。 */
  video: DiagnosticsVideo;
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
  error: { name: string; message: string; code?: string };
}

/** JSON 路由結果。 */
export interface JsonRouteResult {
  headers?: Record<string, string>;
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

type ImmediateRouteResult = JsonRouteResult | BytesRouteResult;
type PolicyRenderer = (policy: MemoryPolicy) => ImmediateRouteResult;
type PolicyRouteResult = { renderWithPolicy: PolicyRenderer };
type DeferredPolicyRouteResult = { preparePolicyResponse: PrepareMemoryPresentation<ImmediateRouteResult> };

/** 記憶內容在 HTTP 送出前依目前政策呈現。 */
export type RouteResult =
  | ImmediateRouteResult
  | StreamRouteResult
  | PolicyRouteResult
  | DeferredPolicyRouteResult;

/** 判斷路由結果是否為位元組回應。 */
function isBytesResult(result: ImmediateRouteResult): result is BytesRouteResult {
  return "bytes" in result;
}

/** 判斷路由結果是否為串流回應（影片播放）。 */
function isStreamResult(result: ImmediateRouteResult | StreamRouteResult): result is StreamRouteResult {
  return "stream" in result;
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
  embedder: Embedder & { readonly schedulingStatus?: EmbedderSchedulingStatus };
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
  /**
   * 索引限速（**選填**；由 `createServer` 依 `MNEMOSHELF_INDEX_RATE` 決定）。
   *
   * 未提供時完全沿用既有行為（檔案之間不休眠）。詳見 core 的 `IndexRootOptions.throttle`。
   */
  indexThrottle?: NonNullable<IndexRootOptions["throttle"]>;
  /**
   * 影片解碼器（選填；B1 `MediaDecoder`）。
   *
   * - 未提供：影片不納入預覽／索引（既有行為，`.mp4` 以 `unsupported-modality` 跳過）。
   * - 提供且可用：預覽與索引都宣告 video，索引時傳給 `indexRoot`。
   * - 提供但不可用：**索引仍傳給 `indexRoot`**，讓影片檔逐檔以
   *   `video-decoder-unavailable` 具名失敗（不是靜默跳過）；預覽不宣告 video
   *   （候選數會是 0），原因由 `videoCapability` 回報給 UI。
   */
  decoder?: MediaDecoder;
  /** 啟動時 decoder 可用性檢查結果（由 `createServer` 注入；未提供 decoder 時省略）。 */
  decoderAvailability?: DecoderAvailability | null;
  /**
   * 影片單檔大小上限的**行程層預設**（bytes）；預設 `DEFAULT_VIDEO_MAX_FILE_BYTES`（512 MiB）。
   *
   * 個別 root 可用持久化的 `Root.videoMaxFileBytes` 覆寫；生效值＝
   * `root.videoMaxFileBytes ?? 這個預設`，preview、indexer 有界快照與播放端點都用生效值。
   */
  videoMaxFileBytes?: number;
}

export interface RestApp {
  /** 交給 `http.createServer` 的請求處理函式。 */
  handler: (request: IncomingMessage, response: ServerResponse) => void;
  /** 正在進行的索引（root id → promise）。進行中再呼叫 → 409。 */
  readonly indexing: ReadonlyMap<number, Promise<IndexRootResult>>;
  /** 等待中的請求全部結束（測試用：確認沒有殘留的非同步工作）。 */
  settled(): Promise<void>;
  /**
   * 真正傳給 `indexRoot` 的限速參數（`undefined`＝不限速）。
   *
   * 唯讀、僅供診斷／測試核對「設定有接到索引器」；呼叫端不應修改它。
   */
  readonly indexThrottle: NonNullable<IndexRootOptions["throttle"]> | undefined;
  /** 啟動時 decoder 可用性檢查結果（未設定 decoder 為 `null`；測試與診斷核對用）。 */
  readonly decoderAvailability: DecoderAvailability | null;
  /** 影片單檔大小上限的行程層預設（bytes）；各 root 的生效值見 `Root.videoMaxFileBytes`。 */
  readonly videoMaxFileBytes: number;
  /** 影片能力摘要（`GET /roots`、preview 與 `/diagnostics` 共用同一個形狀）。 */
  readonly videoCapability: VideoCapability;
  /**
   * 中止所有進行中的索引（**關閉流程用**；additive）。
   *
   * - 對每個在途索引的 `AbortController` 送出 abort；索引會在 native 推論的下一個邊界
   *   （最長一個檔案的嵌入批次）以 `AbortError` 結束，由 `POST /roots/:id/index` 轉成
   *   `200 {cancelled: true}`（連線若已關閉則只是完成背景工作）。
   * - **冪等**；呼叫後這個 app 不再啟動新的索引（之後進來的索引請求直接以 cancelled 結束），
   *   讓 `createServer.close()` 不必等一整輪索引。
   * - 回傳這次實際中止的索引數（已經 abort 過的不重複計數）。
   */
  cancelAllIndexing(): number;
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
export function toHttpError(error: unknown): {
  status: number;
  body: ErrorResponse | { error: "policy-changed" };
  headers: Record<string, string>;
} {
  const named = (name: string, message: string): ErrorResponse => ({ error: { name, message } });

  if (error instanceof MediaSourceChangedError) return { status: 409, body: named(error.name, error.message), headers: { "cache-control": "no-store" } };
  if (error instanceof MediaOriginError) return { status: 403, body: named(error.name, error.message), headers: { "cache-control": "no-store" } };

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
  if (errorCodeOf(error) === "EEMBEDDERQUEUEFULL") {
    return {
      status: 503,
      body: { error: { name: "EmbedderQueueFullError", code: "EEMBEDDERQUEUEFULL", message: "嵌入工作已達資源上限，請稍後再試或縮小單次輸入" } },
      headers: { "retry-after": "1" },
    };
  }
  if (error instanceof MemoryPolicyChangedError) {
    return { status: 409, body: { error: "policy-changed" }, headers: {} };
  }
  if (error instanceof MemorySourceConflictError) {
    return { status: 409, body: { error: { name: error.name, message: error.message, code: error.code } }, headers: {} };
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

/**
 * 建置 commit：讀 `dist/build-info.json` 的 `commit`（由 `scripts/build-info.mjs` 在 build
 * 時寫入），讀不到或格式不符時退回 `MNEMOSHELF_BUILD_COMMIT`，再退回 `"unknown"`。
 *
 * 為什麼啟動時只讀一次：build marker 在行程生命週期內不會變，逐請求讀檔只是多餘 I/O。
 * 路徑相對 `import.meta.url`，src（測試）與 dist（正式）佈局一致：dist 下是
 * `packages/server/dist/build-info.json`；src 下不存在，自然走 fallback。
 *
 * `moduleUrl`／`env` 參數只供測試注入；正式呼叫一律用預設值。
 */
export function readBuildCommit(moduleUrl: string = import.meta.url, env: NodeJS.ProcessEnv = process.env): string {
  try {
    const url = new URL("../build-info.json", moduleUrl);
    const parsed = JSON.parse(readFileSync(url, "utf8")) as { commit?: unknown };
    if (typeof parsed.commit === "string" && parsed.commit.trim() !== "") return parsed.commit.trim();
  } catch {
    // 讀不到／不是合法 JSON：走 fallback。
  }
  const fallback = env.MNEMOSHELF_BUILD_COMMIT;
  return fallback !== undefined && fallback.trim() !== "" ? fallback.trim() : "unknown";
}

/** 建置 commit（行程啟動時讀一次；`/health` 的 `build`）。 */
export const BUILD_COMMIT = readBuildCommit();

/**
 * 服務身分（`GET /health` 的 `service`）。
 *
 * 呼叫端在送出 token 前會比對這個欄位。它能降低「連到不相干的服務」的風險，但這是**免 token 的
 * 自我宣告**：任何本機程式都能偽造，因此**不防**刻意偽造；Windows 上也沒有 pid 檢查可供交叉確認，
 * 共用機器請勿開啟連線資訊檔功能（見 `docs/roots-and-privacy.md` §信任模型）。
 */
export const SERVICE_NAME = "mnemoshelf";

/** 讀取並解析 JSON 請求主體；空主體視為 `{}`。 */
async function readJsonBody(request: IncomingMessage, limit = MAX_JSON_BODY_BYTES): Promise<Record<string, unknown>> {
  const text = await readTextBody(request, limit);
  if (text.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ValidationError("body", "不是合法的 JSON");
  }
  if (!isRecord(parsed)) throw new ValidationError("body", "必須是 JSON 物件");
  return parsed;
}

/**
 * 讀取原始請求主體（文字）並套用位元組上限；空主體回空字串。
 *
 * 兩層上限檢查：
 * 1. `Content-Length` 已宣告超過上限 → 立刻 413，不讀 body；
 * 2. 串流（chunked／未帶長度）則邊讀邊計數，超過後**停止累積但把剩下位元組排空**再拋
 *    `PayloadTooLargeError`，讓客戶端能收到 413。記憶體用量仍以 `limitBytes` 為界。
 */
async function readTextBody(request: IncomingMessage, limitBytes: number): Promise<string> {
  // 先看 Content-Length：明顯超量時不必等下載完才拒絕（也避免惡意客戶端用超大 body 佔頻寬）。
  // 需要排空的串流（chunked／未帶長度）仍由下方累積計數處理。
  const declared = request.headers["content-length"];
  if (declared !== undefined) {
    const declaredBytes = Number(declared);
    if (Number.isFinite(declaredBytes) && declaredBytes > limitBytes) {
      throw new PayloadTooLargeError(limitBytes);
    }
  }

  const chunks: Buffer[] = [];
  let total = 0;
  let exceeded = false;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > limitBytes) {
      exceeded = true;
      chunks.length = 0;
      continue;
    }
    chunks.push(buffer);
  }
  if (exceeded) throw new PayloadTooLargeError(limitBytes);
  const bytes = Buffer.concat(chunks);
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new ValidationError("body", "必須是有效的 UTF-8");
  }
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
 * 解析 root 的影片單檔大小上限欄位（`POST /roots`／`PATCH /roots/:id` 共用）。
 *
 * 驗證走 core 的 `normalizeRootVideoMaxFileBytes`（1 B–16 GiB 整數；兩後端與呼叫端共用同一套語意）；
 * 此處只把 core 的 `TypeError` 轉成 `400 ValidationError`，避免變成 500：
 * - `undefined` → `undefined`：未提供（POST＝未設定；PATCH＝不改）；
 * - `null` → `null`：清除／未設定（回行程層預設）；
 * - 合法整數 → 原值；
 * - 其他（0／負數／小數／NaN／Infinity／非數字／超過上限）→ `400 ValidationError`。
 */
function parseRootVideoMaxFileBytes(value: unknown, field: string): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  try {
    return normalizeRootVideoMaxFileBytes(value);
  } catch {
    throw new ValidationError(field, "必須是 1–16 GiB 的整數（bytes），或 null 表示未設定");
  }
}

/**
 * 解析 root 的通用單檔大小上限欄位（`POST /roots`／`PATCH /roots/:id` 共用）。
 *
 * 驗證走 core 的 `normalizeRootMaxFileBytes`（1 B–16 GiB 整數；兩後端與呼叫端共用同一套語意）：
 * - `undefined` → `undefined`：未提供（POST＝未設定；PATCH＝不改）；
 * - `null` → `null`：清除／未設定（回服務層預設 10 MiB）；
 * - 合法整數 → 原值；
 * - 其他（0／負數／小數／非數字／超過上限）→ `400 ValidationError`。
 */
function parseRootMaxFileBytes(value: unknown, field: string): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  try {
    return normalizeRootMaxFileBytes(value);
  } catch {
    throw new ValidationError(field, "必須是 1–16 GiB 的整數（bytes），或 null 表示未設定");
  }
}

/**
 * 解析 root 的分享開關（`allowAgentSearch`）；非 boolean → `400`，未提供＝`undefined`。
 */
function parseAllowAgentSearch(value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new ValidationError("allowAgentSearch", "必須是布林值");
  return value;
}

/**
 * 寫入路徑的 metadata 檢查：`agent`／`project` 若含 token-like 機密 → 拒絕（400）。
 *
 * 為什麼不遮而要拒絕：agent／project 是**查詢鍵**（過濾、召回 bucket 都用它精確比對）；
 * 若在寫入時改寫，呼叫端之後用原值查不到、語意會壞掉。因此要求呼叫端換一個不含機密的值。
 */
function assertNoSecretInMetadata(
  value: string,
  field: "agent" | "project" | "sourceSession" | "sourceMessage",
): void {
  if (maskSecrets(value).redacted) {
    throw new ValidationError(field, "不得包含機密（偵測到可能的 token／金鑰；請移除後再寫入）");
  }
}

/**
 * 解析 `POST /memories` 的可選來源欄位（D4a；`sourceSession`／`sourceMessage`）。
 *
 * 契約（見 docs/storage-ports.md §記憶的來源欄位）：
 * - 未提供（`undefined`／`null`）→ `null`（不是空字串）；
 * - 必須是字串；trim 後為空 → `400`（不靜默改成 `null`，避免呼叫端誤以為已記錄來源）；
 * - trim 後長度上限 `MAX_MEMORY_METADATA_CHARS`（200）→ 超過回 `400`，**不截斷**；
 * - 含 token-like 機密 → `400`（與 agent／project 相同：識別值不遮罩改寫）。
 *
 * 儲存的是 trim 後的值（前後空白沒有意義）。
 */
function optionalSourceRef(value: unknown, field: "sourceSession" | "sourceMessage"): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new ValidationError(field, "必須是字串或 null");
  const trimmed = value.trim();
  if (trimmed === "") {
    throw new ValidationError(field, "不得是空字串（沒有來源請省略或給 null）");
  }
  if (trimmed.length > MAX_MEMORY_METADATA_CHARS) {
    throw new ValidationError(field, `長度上限 ${MAX_MEMORY_METADATA_CHARS} 字元`);
  }
  assertNoSecretInMetadata(trimmed, field);
  return trimmed;
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

/**
 * 解析 `DELETE /memories/:id?hard=`（卡 C2）。
 *
 * 刻意比其他旗標嚴格：只接受 `true`／`1`（大小寫敏感）；未帶參數＝軟刪除；其他值（含空字串、
 * `false`、`yes`）一律 `400`——「硬刪除」不可用模糊寫法誤觸。
 */
function parseHardDeleteFlag(url: URL): boolean {
  if (!url.searchParams.has("hard")) return false;
  const value = url.searchParams.get("hard");
  if (value === "true" || value === "1") return true;
  throw new ValidationError("hard", "只接受 true 或 1（未帶參數＝軟刪除；硬刪除無法復原）");
}

function parseId(raw: string, resource: string): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw new NotFoundError(resource);
  return id;
}

function parseMemoryPatch(body: Record<string, unknown>): MemoryPatch {
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
  return patch;
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
  const mediaSessions = new MediaSessions();
  const indexingTimings: DiagnosticsResponse["indexingTimings"] = {
    scan: { calls: 0, durationMs: 0 }, read: { calls: 0, durationMs: 0 },
    prepare: { calls: 0, durationMs: 0 }, embed: { calls: 0, durationMs: 0 },
    write: { calls: 0, durationMs: 0 },
  };
  // 匯入的衝突預檢和寫入同排佇列，避免其他 REST 請求在兩者間改動來源。
  let memoryWrites = Promise.resolve();
  const serializeMemoryWrite = <T>(work: () => Promise<T>): Promise<T> => {
    const operation = memoryWrites.then(work);
    memoryWrites = operation.then(() => undefined, () => undefined);
    return operation;
  };

  const presentMemoryResponse = (status: number, id: number, extra = {}): DeferredPolicyRouteResult => ({
    preparePolicyResponse: async () => {
      const [entry] = await loadCurrentMemoryPresentations(deps.store, [id]);
      return (policy) => {
        const view = entry === undefined ? null : createMemoryPresenter(policy)(entry);
        return { status, body: view === null ? null : { ...view, ...extra, policyVersion: policy.version } };
      };
    },
  });

  const homeDir = deps.homeDir ?? homedir();

  // ---------------------------------------------------------------------------
  // 影片能力（decoder＋embedder）：三種狀態一次算清楚，供 preview／index／diagnostics 共用。
  // ---------------------------------------------------------------------------
  const videoMaxFileBytes = deps.videoMaxFileBytes ?? DEFAULT_VIDEO_MAX_FILE_BYTES;
  const decoderAvailability: DecoderAvailability | null = deps.decoderAvailability ?? null;
  /** decoder 是否已設定（設定但不可用時仍要讓索引具名失敗，不可靜默跳過）。 */
  const decoderConfigured = deps.decoder !== undefined;
  /** embedder 是否真的具備影片入口（模型能力；與 decoder 可用性分開）。 */
  const embedderVideoReady =
    deps.embedder.info.capabilities.video === true && typeof deps.embedder.embedVideo === "function";

  let videoCapabilityReason: VideoCapabilityReason | null = null;
  if (decoderConfigured) {
    if (!embedderVideoReady) videoCapabilityReason = "embedder-video-unsupported";
    else if (decoderAvailability?.available !== true) videoCapabilityReason = decoderAvailability?.reason ?? "ffmpeg-failed";
  }
  const videoAvailable = decoderConfigured && videoCapabilityReason === null;
  /**
   * 預覽用的 supportedModalities：**只在可用時**宣告 video。
   * 不可用時預覽不列影片候選（避免讓使用者以為能索引），原因由 `videoCapability` 回報。
   */
  const videoSupportedForScan = videoAvailable;
  /**
   * 索引時是否把 decoder 傳給 `indexRoot`：只要 decoder 已設定且 embedder 有影片入口就傳。
   * 不可用時 indexer 會逐檔 failed（reason `video-decoder-unavailable`），不是靜默跳過。
   */
  const videoSupportedForIndex = decoderConfigured && embedderVideoReady;
  /**
   * root 實際生效的影片單檔上限：per-root 設定 → 行程層（env／512 MiB）預設。
   * preview、index（有界快照）與播放端點都必須用這一個值。
   */
  const effectiveVideoMaxFileBytes = (root: Root): number => root.videoMaxFileBytes ?? videoMaxFileBytes;
  const videoCapability: VideoCapability = {
    available: videoAvailable,
    state: !decoderConfigured ? "disabled" : videoAvailable ? "available" : "unavailable",
    reason: videoCapabilityReason,
    embedderVideo: embedderVideoReady,
    // 服務層**預設**；個別 root 的實際值見 `GET /roots` 的 `videoMaxFileBytes`。
    maxFileBytes: videoMaxFileBytes,
    durationLimitSeconds: VIDEO_MAX_DURATION_SECONDS,
    ffmpegVersion: videoAvailable ? (decoderAvailability?.ffmpegVersion ?? null) : null,
    ffprobeVersion: videoAvailable ? (decoderAvailability?.ffprobeVersion ?? null) : null,
  };
  /** 本行程的影片索引統計（最近一輪；不含路徑；preview 候選數在每次診斷時才彙總）。 */
  const videoIndexing: Omit<DiagnosticsVideoIndexing, "previewCandidateFiles"> = {
    runs: 0,
    lastFinishedAt: null,
    scanSkippedByReason: {},
    skippedByReason: {},
    failedByReason: {},
  };
  /** 記錄一輪影片索引的結果（只計與影片有關的原因；不含任何路徑）。 */
  const recordVideoIndexRun = (result: IndexRootResult): void => {
    videoIndexing.runs += 1;
    videoIndexing.lastFinishedAt = new Date().toISOString();
    videoIndexing.scanSkippedByReason = countByReason(
      (result.scanSkippedFiles ?? []).filter((entry) => VIDEO_INDEX_REASONS.has(entry.reason)),
    );
    videoIndexing.skippedByReason = countByReason(
      result.skippedFiles.filter((entry) => VIDEO_INDEX_REASONS.has(entry.reason)),
    );
    videoIndexing.failedByReason = countByReason(
      result.failedFiles.filter((entry) => VIDEO_INDEX_REASONS.has(entry.reason)),
    );
  };

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
  /**
   * 關閉流程已要求停止索引（由 `cancelAllIndexing()` 設定；只增不減）。
   *
   * 設定後**不再啟動**新的索引：`startIndex` 直接以 `cancelled` 結束，避免關閉過程中
   * 又排進一輪新的索引而拖住 `createServer.close()`。
   */
  let indexesCancelled = false;
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
      const parsed = parseRootMaxFileBytes(body.maxFileBytes, "maxFileBytes");
      // undefined 只代表「未提供」（上面已排除），因此這裡必定是 number 或 null。
      if (typeof parsed === "number") maxFileBytes = parsed;
    }
    // 影片上限是 per-root 持久化欄位（null／未提供＝未設定，沿用行程層預設）。
    const videoMaxFileBytesSetting = parseRootVideoMaxFileBytes(body.videoMaxFileBytes, "videoMaxFileBytes");
    const allowAgentSearch = parseAllowAgentSearch(body.allowAgentSearch);

    const root = await deps.store.addRoot({
      path: realPath,
      mode,
      modalities,
      include,
      exclude,
      respectGitignore: body.respectGitignore ?? true,
      watch: false,
      ...(allowAgentSearch === undefined ? {} : { allowAgentSearch }),
      ...(maxFileBytes === undefined ? {} : { maxFileBytes }),
      ...(typeof videoMaxFileBytesSetting === "number" ? { videoMaxFileBytes: videoMaxFileBytesSetting } : {}),
    });
    return { status: 201, body: root };
  };

  /**
   * `PATCH /roots/:id`：更新 root 的可變設定（`modalities`、`allowAgentSearch`、
   * `maxFileBytes` 與 `videoMaxFileBytes`）。
   *
   * 語意：
   * - 四個欄位**至少提供一項**；未提供＝不變；非法 → `400`；未知的 root → `404`。
   * - `allowAgentSearch`：boolean；只影響之後 agent 的搜尋範圍，不需重新索引。
   * - `maxFileBytes`：number＝設定、`null`＝清除（回服務層預設 10 MiB）。
   * - `videoMaxFileBytes`：number＝設定、`null`＝清除（回行程層預設）。
   * - 成功回 `200`＋更新後的 root。
   * - **不自動觸發重新索引**：改的是設定，掃描層下一次索引才會看到新的模態／上限；
   *   關掉某個模態時既有的 chunk／向量也**不會立刻**釋放，要在下一次索引時由清理迴圈清掉
   *   （與 `DELETE`／模態切換的既有語意一致，見 docs/roots-and-privacy.md 的「改變模態」一節）。
   */
  const patchRoot = async (request: IncomingMessage, id: number): Promise<{ status: number; body: unknown }> => {
    await getRootOr404(id);
    const body = (await readJsonBody(request)) as unknown as PatchRootRequest;
    const patch: RootPatch = {};
    if (body.modalities !== undefined) patch.modalities = validateModalities(body.modalities);
    const allowAgentSearch = parseAllowAgentSearch(body.allowAgentSearch);
    if (allowAgentSearch !== undefined) patch.allowAgentSearch = allowAgentSearch;
    const maxFileBytesSetting = parseRootMaxFileBytes(body.maxFileBytes, "maxFileBytes");
    // undefined＝不改；null＝清除；number＝設定（RootPatch 的 null 有語意，不能和 undefined 混用）。
    if (maxFileBytesSetting !== undefined) patch.maxFileBytes = maxFileBytesSetting;
    const videoMaxFileBytesSetting = parseRootVideoMaxFileBytes(body.videoMaxFileBytes, "videoMaxFileBytes");
    // undefined＝不改；null＝清除；number＝設定（RootPatch 的 null 有語意，不能和 undefined 混用）。
    if (videoMaxFileBytesSetting !== undefined) patch.videoMaxFileBytes = videoMaxFileBytesSetting;
    if (Object.keys(patch).length === 0) {
      throw new ValidationError("body", "至少要提供 modalities、allowAgentSearch、maxFileBytes 或 videoMaxFileBytes");
    }
    const updated = await deps.store.updateRoot(id, patch);
    // 先行 getRootOr404 之後理論上不會是 null；並行刪除時仍以 404 回應，不吞掉。
    if (updated === null) throw new NotFoundError("root", id);
    mediaSessions.revokeRoot(id);
    return { status: 200, body: updated };
  };

  const previewFor = async (id: number): Promise<{ status: number; body: unknown }> => {
    const root = await getRootOr404(id);
    // 支援的模態：decoder 可用時才宣告 video（不可用時預覽不列影片候選；原因由 videoCapability 回報）。
    const supportedModalities: Modality[] = ["text", "code", "image"];
    if (deps.embedder.info.capabilities.audio && typeof deps.embedder.embedAudio === "function") {
      supportedModalities.push("audio");
    }
    if (videoSupportedForScan) supportedModalities.push("video");
    const preview = await previewRoot({
      path: root.path,
      modalities: root.modalities,
      include: root.include,
      exclude: root.exclude,
      respectGitignore: root.respectGitignore,
      // 通用上限與 indexer 共用同一個持久化值：per-root 設定 → 服務層預設 10 MiB。
      ...(root.maxFileBytes === undefined ? {} : { maxFileBytes: root.maxFileBytes }),
      // 影片上限與 indexer／播放端點共用同一個值：per-root 設定 → 行程層預設。
      videoMaxFileBytes: effectiveVideoMaxFileBytes(root),
    }, { supportedModalities });
    // 記住這次 preview 的統計：`GET /diagnostics` 會回報「上次量到的數字」（不重新掃描磁碟）。
    lastPreviewByRoot.set(id, preview);
    // additive：讓 UI 區分「未設定 decoder」與「設定但不可用」，不必只看候選數猜。
    return { status: 200, body: { ...preview, videoCapability } };
  };

  const startIndex = async (id: number): Promise<{ status: number; body: unknown }> => {
    const root = await getRootOr404(id);
    if (root.mode !== "index") throw new RootNotIndexableError(root.id, root.mode);
    if (indexing.has(id)) throw new IndexInProgressError(id);
    if (indexesCancelled) {
      // 關閉中（或已由 cancelAllIndexing 停止）：不再啟動新索引，直接回「已取消」。
      // 正常情況下連線已被關掉、不會走到這裡；這是關閉與請求競態時的防線。
      const body: IndexCancelledResponse = { rootId: id, durationMs: 0, cancelled: true };
      return { status: 200, body };
    }

    const startedAt = Date.now();
    const controller = new AbortController();
    indexStatus.begin(id);
    const run = indexRoot(root, {
      embedder: deps.embedder,
      store: deps.store,
      vec: deps.vec,
      signal: controller.signal,
      onProgress: (progress) => indexStatus.report(id, progress),
      onTiming: ({ stage, durationMs }) => {
        indexingTimings[stage].calls += 1;
        indexingTimings[stage].durationMs += durationMs;
      },
      // 通用上限：per-root 持久化設定 → 服務層預設 10 MiB（indexer 自己的 default）。
      ...(root.maxFileBytes === undefined ? {} : { maxFileBytes: root.maxFileBytes }),
      // 影片：decoder 設定且 embedder 有入口就傳（不可用時 indexer 逐檔具名 failed）。
      // videoMaxFileBytes 與 preview／播放端點共用同一個值（per-root 設定 → 行程層預設）。
      ...(videoSupportedForIndex
        ? { decoder: deps.decoder, videoMaxFileBytes: effectiveVideoMaxFileBytes(root) }
        : {}),
      ...(deps.indexThrottle === undefined ? {} : { throttle: deps.indexThrottle }),
    });
    indexing.set(id, run);
    indexControllers.set(id, controller);
    inflight.add(run);
    try {
      const result = await run;
      indexStatus.finish(id, result);
      // 影片索引統計（只有 root 宣告 video 且服務已接通時才計；不含路徑）。
      if (videoSupportedForIndex && root.modalities.includes("video")) recordVideoIndexRun(result);
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
   * 中止所有進行中的索引（提供給 `createServer.close()`；見 `RestApp.cancelAllIndexing`）。
   *
   * 只做「送 abort」：native 推論不可從 JS 中斷，索引會在 embedder 的下一個邊界
   * （批次視窗／下一個檔案開始前）結束；`close()` 另外有有限的寬限與放棄在途呼叫的後備。
   */
  const cancelAllIndexing = (): number => {
    indexesCancelled = true;
    let cancelled = 0;
    for (const controller of indexControllers.values()) {
      if (controller.signal.aborted) continue;
      controller.abort();
      cancelled += 1;
    }
    return cancelled;
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
   * 支援 WAV 回傳 audio/wav；其他二進位與媒體檔 → 415；超過大小上限 → 413。
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

  /**
   * `GET|HEAD /roots/:id/media?path=`：影片播放（單一 Range、206／416、單次上限 4 MiB）。
   *
   * 守衛：`dispatch` 已驗 token／loopback／Host；本函式再過 `buildMediaResponse` 的
   * realpath＋root 前綴＋黑名單，只服務 root 內的 `.mp4`。串流由 `sendStreamResult` 送出，
   * client 中止時 destroy 讀取串流（不整檔讀入記憶體、不快取）。
   */
  const readMedia = async (id: number, request: IncomingMessage, url: URL): Promise<RouteResult> => {
    const root = await getRootOr404(id);
    const method = (request.method ?? "GET").toUpperCase();
    return await buildMediaResponse(
      root,
      {
        relPath: url.searchParams.get("path"),
        rangeHeader: request.headers.range,
        headOnly: method === "HEAD",
      },
      { maxFileBytes: effectiveVideoMaxFileBytes(root) },
    );
  };

  const createMediaSession = async (id: number, request: IncomingMessage): Promise<RouteResult> => {
    const origin = requireMediaOrigin(request);
    const body = await readJsonBody(request);
    const root = await getRootOr404(id);
    const relPath = parseRelativePath(typeof body.path === "string" ? body.path : null, { allowEmpty: false });
    let expectedContentHash: string | undefined;
    if (body.chunkId !== undefined) {
      if (typeof body.chunkId !== "number" || !Number.isSafeInteger(body.chunkId) || body.chunkId <= 0) throw new ValidationError("chunkId", "必須為正整數。");
      const [chunk] = await deps.store.getChunks([body.chunkId]);
      if (chunk === undefined || chunk.rootId !== id || chunk.relPath !== relPath ||
          (chunk.media?.track !== "video" && chunk.media?.track !== "video-audio")) throw new MediaSourceChangedError();
      expectedContentHash = chunk.contentHash;
    }
    let version = "";
    await buildMediaResponse(root, { relPath, rangeHeader: undefined, headOnly: true }, {
      maxFileBytes: effectiveVideoMaxFileBytes(root), expectedContentHash,
      captureVersion: (value) => { version = value; },
    });
    const currentRoot = await getRootOr404(id);
    if (JSON.stringify(currentRoot) !== JSON.stringify(root)) throw new MediaSourceChangedError();
    const { cookie, ...bodyResult } = mediaSessions.create({ rootId: id, relPath, version, origin });
    return { status: 201, body: bodyResult, headers: { "set-cookie": cookie, "cache-control": "no-store" } };
  };

  const readMediaSession = async (id: number, sessionId: string, request: IncomingMessage): Promise<RouteResult> => {
    const session = mediaSessions.authorize(sessionId, id, request);
    const root = await getRootOr404(id);
    const result = await buildMediaResponse(root, {
      relPath: session.relPath, rangeHeader: request.headers.range, headOnly: request.method === "HEAD",
    }, { maxFileBytes: effectiveVideoMaxFileBytes(root), expectedVersion: session.version });
    mediaSessions.track(sessionId, result.stream);
    return result;
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
        videoMaxFileBytes: effectiveVideoMaxFileBytes(root),
        stats,
        statsSource,
        statsUnavailable: stats === null,
        lastIndex,
      };
    });

    const memoryStats = await deps.store.memoryEmbeddingStats(deps.embedder.info.id);
    const memoryWorkerStats = deps.memoryEmbedder.stats();
    // 影片候選檔數來自「最近一次 preview」（不為了診斷臨時掃描磁碟）；從未 preview 過為 null。
    const previewCandidateFiles =
      lastPreviewByRoot.size === 0
        ? null
        : [...lastPreviewByRoot.values()].reduce((sum, preview) => sum + preview.byKind.video.count, 0);

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
      embedderScheduling: deps.embedder.schedulingStatus ?? null,
      indexingTimings,
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
      // 影片：能力三態、decoder 狀態與本行程索引統計（不含路徑）。
      video: {
        ...videoCapability,
        indexing: { ...videoIndexing, previewCandidateFiles },
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
    mediaSessions.revokeRoot(id);
    if (deleteData) await deps.vec.deleteByRoot(id);
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
   * `POST /memories`：新增記憶（卡 C2：精確去重）。
   *
   * `supersedes`（可選）為被取代的記憶 id：帶了就把該筆標記軟刪除（見 `addMemory` 的契約），
   * UI 的「編輯」流程即以此產生新版本並取代舊版。**帶 `supersedes` 時跳過去重**（編輯語意優先）。
   *
   * `force`（可選，boolean；非 boolean → `400`）：強制新增，即使已有相同內容的未刪除記憶。
   *
   * 未帶 `force` 且非 `supersedes` 時走 `addMemoryUnlessDuplicate`：同一 key（正規化內容 hash＋
   * `scope`＋`project`＋`agent`）已有未刪除的記憶 → **不新增、不 enqueue**，回 `200`＋既有記憶
   * （讀取視圖，遮罩）＋`duplicate: true`；新增則回 `201`＋`duplicate: false`。
   * 去重比較的是**遮罩後**內容（寫入前已遮罩），因此「憑證不同但遮罩後同文」視為重複。
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
   * **D4a（來源欄位，additive）**：可選的 `sourceSession`／`sourceMessage`（各 ≤ 200 字元，
   * 超長或空白 → `400`，不截斷）；未提供或 `null` → 存 `null`。兩者都是不透明識別值、
   * 不是安全邊界，也**不參與**去重 key；寫入後不可經 `PATCH` 變更。
   *
   * 建立成功後只把 id 交給背景 worker（`memoryEmbedder.enqueue`）：**不等待嵌入**，
   * 回應仍是立即的 `201`；向量稍後就緒（狀態見 `GET /diagnostics` 的 `memories`）。
   */
  const addMemory = async (request: IncomingMessage): Promise<RouteResult> => {
    const body = await readJsonBody(request);
    const rawContent = requireString(body.content, "content", { maxLength: MAX_MEMORY_CHARS });
    for (const field of ["sourceId", "messageIndex", "chunkIndex", "sourceStart", "sourceEnd", "chunkVersion", "sourceTurn"]) {
      if (Object.hasOwn(body, field)) throw new ValidationError(field, "原文來源請使用專用端點");
    }
    const agent = requireString(body.agent, "agent", { maxLength: MAX_MEMORY_METADATA_CHARS });
    assertNoSecretInMetadata(agent, "agent");
    const kind = enumValue(body.kind, MEMORY_KINDS, "kind", "fact");
    // `force` 只影響寫入路徑；必須是 JSON boolean（字串 "true"、數字、null 一律 400），
    // 避免「硬刪除／強制新增」這類不可逆操作被模糊寫法誤觸。
    let force = false;
    if (body.force !== undefined) {
      if (typeof body.force !== "boolean") throw new ValidationError("force", "必須是布林值");
      force = body.force;
    }

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
    // D4a：來源欄位（可選、additive）；未提供存 null，不影響去重 key。
    const sourceSession = optionalSourceRef(body.sourceSession, "sourceSession");
    const sourceMessage = optionalSourceRef(body.sourceMessage, "sourceMessage");

    return await serializeMemoryWrite(async () => {
      const replaced = supersedes === null ? null : await deps.store.getMemory(supersedes);
      const policy = await deps.store.getMemoryPolicy();
      const masked = memoryContentView(rawContent, policy);
      const input = { content: masked.text, kind, scope, project, agent, supersedes, sourceSession, sourceMessage };
      const result = supersedes !== null || force
        ? { memory: await deps.store.addMemory(input), duplicate: false }
        : await deps.store.addMemoryUnlessDuplicate(input);

      const { id } = result.memory;
      if (result.duplicate) {
        return presentMemoryResponse(200, id, { duplicate: true, redacted: false, redactedCount: 0 });
      }
      if (replaced?.pinned === true) await deps.store.setMemoryPinned(id, true);
      deps.memoryEmbedder.enqueue(id);
      return presentMemoryResponse(201, id, { duplicate: false, redacted: masked.redacted, redactedCount: masked.count });
    });
  };

  /**
   * `POST /memories/:id/pin`：設定／取消釘選（冪等）。
   *
   * 主體 `{pinned?: boolean}`，省略時預設 `true`（只送空主體即為釘選）。
   * 未知的 id → 404（先 `getMemory` 判斷存在與否）；回傳更新後的記憶。
   */
  const pinMemory = async (request: IncomingMessage, id: number): Promise<RouteResult> => {
    const body = await readJsonBody(request);
    const pinned = optionalBoolean(body.pinned, "pinned") ?? true;
    return await serializeMemoryWrite(async () => {
      const existing = await deps.store.getMemory(id);
      if (existing === null || (existing.sourceId != null && existing.deletedAt !== null)) {
        throw new NotFoundError("記憶", id);
      }
      await deps.store.setMemoryPinned(id, pinned);
      return presentMemoryResponse(200, id);
    });
  };

  /**
   * `DELETE /memories/:id`：預設**軟刪除**（設定 `deleted_at`，回應形狀不變）。
   *
   * 帶 `?hard=true`（或 `hard=1`）改成**硬刪除**：真的刪除資料列（含 FTS；向量同列欄位），
   * 回應 `{ id, deleted: true, hard: true }`。可刪已軟刪除者；未知 id → `404`（與軟刪除一致）。
   * `hard` 的其他值 → `400`（值域只接受 `true`／`1`，見 `parseHardDeleteFlag`）。
   */
  const forgetMemory = async (id: number, hard: boolean): Promise<{ status: number; body: unknown }> => {
    return await serializeMemoryWrite(async () => {
      const memory = await deps.store.getMemory(id);
      if (memory === null) throw new NotFoundError("記憶", id);
      if (hard) {
        const deleted = await deps.store.hardDeleteMemory(id);
        if (!deleted) throw new NotFoundError("記憶", id);
        return { status: 200, body: { id, deleted: true, hard: true } };
      }
      const alreadyDeleted = memory.deletedAt !== null;
      if (!alreadyDeleted) await deps.store.forgetMemory(id);
      return { status: 200, body: { id, deleted: !alreadyDeleted } };
    });
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
  const patchMemory = async (request: IncomingMessage, id: number): Promise<RouteResult> => {
    const body = await readJsonBody(request);
    const patch = parseMemoryPatch(body);
    return await serializeMemoryWrite(async () => {
      const existing = await deps.store.getMemory(id);
      if (existing === null || existing.deletedAt !== null) throw new NotFoundError("記憶", id);

      // 合併現值後再驗一次（例如 scope 未提供、卻帶了非 null project 的 patch）。
      try {
        if (existing.sourceId == null) normalizeMemoryPatch(existing, patch);
        else normalizeMemorySourceScope(existing, patch);
      } catch (error) {
        throw new ValidationError("patch", error instanceof Error ? error.message : "非法的 patch");
      }

      const updated = await deps.store.updateMemory(id, patch);
      // 讀到之後才被軟刪除的競態：與未知 id 同樣回 404，不吞掉。
      if (updated === null) throw new NotFoundError("記憶", id);
      return presentMemoryResponse(200, id);
    });
  };

  const routeRoots = async (
    request: IncomingMessage,
    method: string,
    segments: string[],
    url: URL,
  ): Promise<RouteResult> => {
    if (segments.length === 1) {
      // additive：`video` 是服務層能力（三態），與每個 root 自己的 modalities 無關；
      // UI 可先看它決定影片開關能不能開，不必等 preview／index 才知道 decoder 壞掉。
      if (method === "GET") {
        return { status: 200, body: { roots: await deps.store.listRoots(), video: videoCapability } };
      }
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
      if (segments[2] === "media-sessions") {
        if (method !== "POST") throw new MethodNotAllowedError(method, ["POST"]);
        return await createMediaSession(id, request);
      }
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
      if (segments[2] === "media") {
        if (method !== "GET" && method !== "HEAD") throw new MethodNotAllowedError(method, ["GET", "HEAD"]);
        return await readMedia(id, request, url);
      }
    }

    if (segments.length === 4 && segments[2] === "media-sessions") {
      if (!/^[0-9a-f-]{36}$/.test(segments[3]!)) throw new ValidationError("session", "播放授權識別不合法。");
      if (method === "DELETE") {
        requireMediaOrigin(request);
        mediaSessions.revoke(segments[3]!);
        return { status: 200, body: { revoked: true }, headers: {
          "cache-control": "no-store",
          "set-cookie": `mnemoshelf_media=; HttpOnly; SameSite=Strict; Path=/roots/${id}/media-sessions/${segments[3]!}; Max-Age=0`,
        } };
      }
      if (method !== "GET" && method !== "HEAD") throw new MethodNotAllowedError(method, ["GET", "HEAD", "DELETE"]);
      return await readMediaSession(id, segments[3]!, request);
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

  const search = async (request: IncomingMessage): Promise<RouteResult> => {
    const body = await readJsonBody(request);
    // 型別以外一律由 normalizeSearchOptions 驗證（單一驗證來源）。
    const prepare = await prepareUnifiedSearch(
      { store: deps.store, vec: deps.vec, embedder: deps.embedder },
      {
        query: body.query as string,
        mode: body.mode as SearchMode | undefined,
        rootIds: body.rootIds as number[] | undefined,
        agentOnly: body.agentOnly as boolean | undefined,
        k: body.k as number | undefined,
      },
    );
    return {
      preparePolicyResponse: async () => {
        const render = await prepare();
        return (policy) => ({ status: 200, body: render(policy) });
      },
    };
  };

  /**
   * `GET /memories`：列出未刪除的記憶（由新到舊）。
   *
   * 過濾參數直接對應 `MetadataStore.listMemories` 的 `MemoryFilter`；`limit` 的預設與上限
   * 由儲存層的 `normalizeMemoryLimit` 決定（預設 100、上限 500），這裡只擋掉非正整數。
   */
  const listMemories = async (url: URL): Promise<RouteResult> => {
    const params = url.searchParams;
    const kind = optionalEnumParam(params.get("kind"), MEMORY_KINDS, "kind");
    const scope = optionalEnumParam(params.get("scope"), MEMORY_SCOPES, "scope");
    const project = optionalQueryString(params.get("project"), "project", {
      maxLength: MAX_MEMORY_METADATA_CHARS,
    });
    const agent = optionalQueryString(params.get("agent"), "agent", { maxLength: MAX_MEMORY_METADATA_CHARS });
    const limit = queryLimit(params.get("limit"));

    return {
      preparePolicyResponse: async () => {
        const rows = await deps.store.listMemories({
          ...(kind === undefined ? {} : { kind }),
          ...(scope === undefined ? {} : { scope }),
          ...(project === undefined ? {} : { project }),
          ...(agent === undefined ? {} : { agent }),
          ...(limit === undefined ? {} : { limit }),
        });
        const presentations = await loadMemoryPresentations(deps.store, rows);
        return (policy) => {
          const present = createMemoryPresenter(policy);
          const memories = presentations
            .filter(({ memory }) =>
              (scope === undefined || memory.scope === scope) &&
              (project === undefined || memory.project === project) &&
              (agent === undefined || memory.agent === agent),
            )
            .flatMap((entry) => present(entry) ?? []);
          const body: ListMemoriesResponse = { memories, untrusted: true, policyVersion: policy.version };
          return { status: 200, body };
        };
      },
    };
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
  const searchMemoriesRoute = async (request: IncomingMessage): Promise<RouteResult> => {
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

    const prepare = await prepareMemoryRecall(
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
    return {
      preparePolicyResponse: async () => {
        const render = await prepare();
        return (policy) => ({ status: 200, body: render(policy) });
      },
    };
  };

  const exportMemories = (url: URL): RouteResult => {
    const schemaVersion = url.searchParams.get("schemaVersion") ?? "2";
    if (schemaVersion !== "1" && schemaVersion !== "2") {
      throw new ValidationError("schemaVersion", "只接受 1 或 2");
    }
    return {
      preparePolicyResponse: async () => {
        const sources = await deps.store.listMemorySourcesForExport();
        if (schemaVersion === "1" && sources.length > 0) {
          return () => ({
            status: 409,
            body: { error: {
              name: "MemoryExportVersionConflict",
              code: "raw-sources-present",
              message: "備份含原文來源，請使用 schemaVersion=2",
            } },
          });
        }
        const rows = await deps.store.listMemoriesForExport();
        // 原文釘選保存在片段上；備份按整回合記錄，不另匯出每個片段。
        const pinnedSourceIds = new Set(rows.flatMap((memory) =>
          memory.sourceId != null && memory.pinned ? [memory.sourceId] : [],
        ));
        const sourceRecords = sources.map((source) => ({ ...source, pinned: pinnedSourceIds.has(source.id) }));
        return (policy) => {
          const present = createMemoryPresenter(policy);
          const memories = rows.flatMap((memory) => {
            if (memory.sourceId != null) return [];
            return present({ memory, source: null }) ?? [];
          });
          return {
            status: 200,
            bytes: schemaVersion === "1"
              ? serializeMemoriesExport(memories)
              : serializeRawMemoriesExport(memories, sourceRecords, policy),
            contentType: MEMORY_EXPORT_CONTENT_TYPE,
            headers: { "content-disposition": `attachment; filename="${memoryExportFilename()}"` },
          };
        };
      },
    };
  };

  const importMemories = async (request: IncomingMessage, url: URL): Promise<RouteResult> => {
    const dryRun = parseDryRunParam(url.searchParams.get("dryRun"));
    const text = await readTextBody(request, MAX_MEMORY_IMPORT_BYTES);
    return await serializeMemoryWrite(async () => {
      const policy = await deps.store.getMemoryPolicy();
      const plan = planMemoryImport(text, policy);
      const valid = plan.total - plan.invalidCount;
      const common = { dryRun, total: plan.total, valid, invalid: plan.invalid, redacted: plan.redacted };
      if (plan.invalidCount > 0) {
        return {
          status: 400,
          body: {
            ...common,
            error: {
              name: "ValidationError",
              message: `匯入檔有 ${plan.invalidCount} 行不合法，未寫入任何資料`,
            },
            duplicates: 0,
            created: 0,
            wouldCreate: 0,
          },
        };
      }

      const eventHashes = new Map<string, string>();
      const newSources: typeof plan.sources = [];
      let duplicates = 0;
      for (const source of plan.sources) {
        const { input } = source;
        const eventHash = memorySourceEventHash(input);
        const seen = eventHashes.get(eventHash);
        if (seen !== undefined) {
          if (seen !== input.requestHash) throw new MemorySourceConflictError();
          duplicates += 1;
          continue;
        }
        eventHashes.set(eventHash, input.requestHash);
        if (await deps.store.checkMemorySource(input) === "duplicate") duplicates += 1;
        else newSources.push(source);
      }

      if (dryRun) {
        const existing = await deps.store.listMemoriesForExport();
        duplicates += countImportDuplicates(plan.entries, existing.filter((memory) => memory.sourceId == null));
        const body: MemoryImportResponse = { ...common, duplicates, created: 0, wouldCreate: valid - duplicates };
        return { status: 200, body };
      }

      let created = 0;
      for (const { input, chunks, pinned } of newSources) {
        const result = await deps.store.addMemorySource(input, chunks);
        if (result.duplicate) duplicates += 1;
        else {
          const firstMemory = result.memories[0];
          if (pinned && firstMemory !== undefined) await deps.store.setMemoryPinned(firstMemory.id, true);
          for (const memory of result.memories) deps.memoryEmbedder.enqueue(memory.id);
          created += 1;
        }
      }

      for (const entry of plan.entries) {
        const result = await deps.store.addMemoryUnlessDuplicate({
          content: entry.content,
          kind: entry.kind,
          scope: entry.scope,
          project: entry.project,
          agent: entry.agent,
          supersedes: null,
          sourceSession: entry.sourceSession,
          sourceMessage: entry.sourceMessage,
        });
        if (result.duplicate) {
          duplicates += 1;
          continue;
        }
        if (entry.pinned) await deps.store.setMemoryPinned(result.memory.id, true);
        deps.memoryEmbedder.enqueue(result.memory.id);
        created += 1;
      }

      const body: MemoryImportResponse = { ...common, duplicates, created, wouldCreate: 0 };
      return { status: 200, body };
    });
  };

  const routeMemoryPolicy = async (
    request: IncomingMessage, method: string, segments: string[],
  ): Promise<RouteResult> => {
    if (segments.length !== 1) throw new NotFoundError("路徑");
    if (method === "GET") return { renderWithPolicy: (policy) => ({ status: 200, body: policy }) };
    if (method !== "PATCH") throw new MethodNotAllowedError(method, ["GET", "PATCH"]);
    const body = await readJsonBody(request);
    if (Object.keys(body).length !== 1 || typeof body.maskSecrets !== "boolean") {
      throw new ValidationError("body", "只接受 maskSecrets 布林欄位");
    }
    const maskSecrets = body.maskSecrets;
    const policy = await serializeMemoryWrite(() => deps.store.setMemoryPolicy(maskSecrets));
    return { status: 200, body: policy };
  };

  const addMemorySource = async (request: IncomingMessage): Promise<RouteResult> => {
    const source = parseSourceWriteRequest(await readJsonBody(request, MAX_MEMORY_SOURCE_BYTES));
    return await serializeMemoryWrite(async () => {
      const { input, chunks, redactedCount } = prepareMemorySource(source, await deps.store.getMemoryPolicy());
      const result = await deps.store.addMemorySource(input, chunks);
      if (!result.duplicate) {
        for (const memory of result.memories) deps.memoryEmbedder.enqueue(memory.id);
      }
      return {
        renderWithPolicy: (policy) => ({
          status: result.duplicate ? 200 : 201,
          body: {
            source: sourceMetadata(result.source),
            memoryIds: result.memories.map(({ id }) => id),
            duplicate: result.duplicate,
            saved: true,
            policyVersion: policy.version,
            redacted: !result.duplicate && redactedCount > 0,
            redactedCount: result.duplicate ? 0 : redactedCount,
          },
        }),
      };
    });
  };

  const readMemorySource = async (id: number, params: URLSearchParams): Promise<RouteResult> => {
    const scope = optionalEnumParam(params.get("scope"), MEMORY_SCOPES, "scope");
    const project = optionalQueryString(params.get("project"), "project", { maxLength: MAX_MEMORY_METADATA_CHARS });
    const agent = optionalQueryString(params.get("agent"), "agent", { maxLength: MAX_MEMORY_METADATA_CHARS });
    const includeAllProjects = booleanFlag(params.get("includeAllProjects"), "includeAllProjects", false);
    const buckets = buildMemorySearchBuckets({ scope, project, agent, includeAllProjects });
    const page = parseSourcePageOptions(params);
    const indexState = await deps.store.memorySourceEmbeddingStats(id, deps.embedder.info.id);
    return {
      preparePolicyResponse: async () => {
        const source = await deps.store.getMemorySource(id);
        if (source === null || source.deletedAt !== null || !isMemoryVisible(source, buckets)) {
          throw new NotFoundError("原文來源", id);
        }
        return (policy) => ({
          status: 200,
          body: { source: sourceMetadata(source), indexState, ...paginateMemorySource(source, page, policy) },
        });
      },
    };
  };

  const routeMemorySources = async (
    request: IncomingMessage, method: string, segments: string[], url: URL,
  ): Promise<RouteResult> => {
    if (segments.length === 1) {
      if (method === "POST") return await addMemorySource(request);
      throw new MethodNotAllowedError(method, ["POST"]);
    }
    if (segments.length !== 2 || !/^\d+$/.test(segments[1]!)) throw new NotFoundError("原文來源");
    const id = parseId(segments[1]!, "原文來源");
    if (!Number.isSafeInteger(id)) throw new NotFoundError("原文來源");
    if (method === "GET") return await readMemorySource(id, url.searchParams);
    if (method === "PATCH") {
      const patch = parseMemoryPatch(await readJsonBody(request));
      return await serializeMemoryWrite(async () => {
        let source;
        try {
          source = await deps.store.updateMemorySource(id, patch);
        } catch (error) {
          if (!(error instanceof TypeError)) throw error;
          throw new ValidationError("patch", error.message);
        }
        if (source === null) throw new NotFoundError("原文來源", id);
        const metadata = sourceMetadata(source);
        return {
          renderWithPolicy: (policy) => ({ status: 200, body: { source: metadata, policyVersion: policy.version } }),
        };
      });
    }
    if (method === "DELETE") {
      const hard = parseHardDeleteFlag(url);
      return await serializeMemoryWrite(async () => {
        if (!(await deps.store.deleteMemorySource(id, hard))) throw new NotFoundError("原文來源", id);
        return { status: 200, body: { deleted: true, hard } };
      });
    }
    throw new MethodNotAllowedError(method, ["GET", "PATCH", "DELETE"]);
  };

  const routeMemories = async (
    request: IncomingMessage,
    method: string,
    segments: string[],
    url: URL,
  ): Promise<RouteResult> => {
    if (segments.length === 1) {
      if (method === "POST") return await addMemory(request);
      if (method === "GET") return await listMemories(url);
      throw new MethodNotAllowedError(method, ["GET", "POST"]);
    }
    // 固定字面路徑必須在 `parseId` 之前處理，否則 "export"／"import" 會被當成 id。
    if (segments.length === 2 && segments[1] === "export") {
      if (method !== "GET") throw new MethodNotAllowedError(method, ["GET"]);
      return exportMemories(url);
    }
    if (segments.length === 2 && segments[1] === "import") {
      if (method !== "POST") throw new MethodNotAllowedError(method, ["POST"]);
      return await importMemories(request, url);
    }
    if (segments.length === 2 && segments[1] === "search") {
      if (method !== "POST") throw new MethodNotAllowedError(method, ["POST"]);
      return await searchMemoriesRoute(request);
    }
    if (segments.length === 2) {
      if (method === "DELETE") return await forgetMemory(parseId(segments[1]!, "記憶"), parseHardDeleteFlag(url));
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
      // 免 token；只放服務身分、版本與 build marker，沒有任何機密。
      sendJson(response, 200, {
        status: "ok",
        service: SERVICE_NAME,
        appVersion: APP_VERSION,
        build: BUILD_COMMIT,
      });
      return;
    }

    // 僅精確的播放 session GET/HEAD 以同源 cookie 授權，其他 API 仍必須帶 Bearer。
    const sessionRead = segments.length === 4 && segments[0] === "roots" && segments[2] === "media-sessions" && (method === "GET" || method === "HEAD");
    if (!sessionRead) requireToken(request, deps.token);

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
      case "memory-policy":
        result = await routeMemoryPolicy(request, method, segments);
        break;
      case "memory-sources":
        result = await routeMemorySources(request, method, segments, url);
        break;
      case "diagnostics":
        if (segments.length !== 1) throw new NotFoundError("路徑");
        if (method !== "GET") throw new MethodNotAllowedError(method, ["GET"]);
        result = await getDiagnostics();
        break;
      default:
        throw new NotFoundError("路徑");
    }

    const send = async (
      payload: ImmediateRouteResult | StreamRouteResult,
      headers: Record<string, string> = {},
    ): Promise<void> => {
      if (isStreamResult(payload)) {
        // 影片播放：串流直接寫出；等串流結束（或 client 中止）才回報完成，
        // 讓 close()／settled() 能看到仍在傳輸的回應。
        await sendStreamResult(response, payload);
        return;
      }
      if (isBytesResult(payload)) {
        sendBytes(response, payload.status, payload.contentType, payload.bytes, { ...payload.headers, ...headers });
      } else {
        sendJson(response, payload.status, payload.body, { ...payload.headers, ...headers });
      }
    };

    if ("status" in result) {
      await send(result);
    } else {
      const deferred = result;
      // 在同一佇列內確認可見性與政策，直到資料送出才允許來源變更。
      await serializeMemoryWrite(async () => {
        const render = "renderWithPolicy" in deferred
          ? deferred.renderWithPolicy
          : await deferred.preparePolicyResponse();
        const policy = await deps.store.getMemoryPolicy();
        await send(render(policy), { "X-Mnemoshelf-Policy-Version": String(policy.version), "cache-control": "no-store" });
      });
    }
  };

  const handler = (request: IncomingMessage, response: ServerResponse): void => {
    // 全部解析與路由都在 try 內：handler 是同步的 request listener，任何未捕捉的例外都會
    // 直接結束行程（見 parseRequestTarget 的說明）。
    const task = (async (): Promise<void> => {
      let memoryRequest = false;
      try {
        requireLoopback(request);
        requireLocalHost(request);
        const { url, segments } = parseRequestTarget(request);
        if (isApiPath(segments)) {
          memoryRequest = ["memories", "memory-policy", "memory-sources", "search"].includes(segments[0]!);
          await dispatch(request, response, url, segments);
        } else {
          await serveWeb(request, response, url);
        }
      } catch (error) {
        const mapped = toHttpError(error);
        if (mapped.status === 500) {
          if (memoryRequest) console.error("[mnemoshelf] 記憶請求失敗（InternalError）");
          else console.error("[mnemoshelf] 未預期的錯誤：", error);
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
    indexThrottle: deps.indexThrottle,
    decoderAvailability,
    videoMaxFileBytes,
    videoCapability,
    cancelAllIndexing,
    async settled(): Promise<void> {
      mediaSessions.close();
      // 索引是背景工作（回應會等它），這裡等所有在途請求結束。
      while (inflight.size > 0) {
        await Promise.allSettled([...inflight]);
      }
    },
  };
}
