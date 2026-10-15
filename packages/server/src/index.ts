/**
 * `@mnemoshelf/server`：Core 常駐服務的組裝層。
 *
 * `createServer()` 把既有元件接起來（**單一寫入者**：只有本行程開資料庫）：
 * 環境設定 → SQLite（`MetadataStore`＋`VectorIndex`）→ embedder → REST app → 監聽 127.0.0.1。
 * MCP 入口（`./mcp`）是薄轉發層，只走 HTTP，不碰資料庫。
 *
 * 公開 API 與契約：docs/storage-ports.md（單一寫入者）、docs/roots-and-privacy.md（路徑與來源標註）。
 */
import { promises as fs } from "node:fs";
import http from "node:http";
import {
  openDatabase,
  SqliteMetadataStore,
  SqliteVectorIndex,
  type Embedder,
  type MetadataStore,
  type SqliteDatabase,
  type VectorIndex,
} from "@mnemoshelf/core";
import { TransformersEmbedder } from "@mnemoshelf/embedder-transformers";
import { LOOPBACK_HOST, loadServerConfig, type ServerConfig } from "./config.js";
import { createRestApp, type RestApp } from "./http/app.js";

export interface CreateServerOptions {
  /** 環境變數來源；預設 `process.env`。 */
  env?: NodeJS.ProcessEnv;
  /** 覆寫 `MNEMOSHELF_TOKEN`。 */
  token?: string;
  /** 覆寫 `MNEMOSHELF_DATA_DIR`。 */
  dataDir?: string;
  /** 覆寫 `MNEMOSHELF_PORT`；0（預設）表示由 OS 指派隨機埠。 */
  port?: number;
  /** 覆寫 `MNEMOSHELF_WEB_DIR`（Web UI 靜態檔目錄）。 */
  webDir?: string;
  /** 覆寫 embedder（測試注入 `FakeEmbedder`；預設 `TransformersEmbedder`，lazy 載入）。 */
  embedder?: Embedder;
  /** 「過寬 root」判定的家目錄基準；預設 `os.homedir()`。 */
  homeDir?: string;
}

export interface MnemoshelfServer {
  /** 底層 HTTP server（已 listen）。 */
  server: http.Server;
  host: string;
  /** 實際監聽的埠（`port: 0` 時為 OS 指派的號碼）。 */
  port: number;
  /** `http://127.0.0.1:<port>`。 */
  url: string;
  config: ServerConfig;
  store: MetadataStore;
  vec: VectorIndex;
  embedder: Embedder;
  app: RestApp;
  /** 關閉 HTTP、等背景工作結束、釋放 embedder 與資料庫。 */
  close(): Promise<void>;
}

/** 監聽指定的 loopback 埠。 */
async function listen(server: http.Server, port: number): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(port, LOOPBACK_HOST, () => {
      server.off("error", onError);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("無法取得監聽埠");
  return address.port;
}

/**
 * 建立並啟動常駐服務。
 *
 * embedder 預設是 `TransformersEmbedder`（lazy：啟動不下載模型，第一次索引才載入）。
 * 資料目錄不存在時會建立（只建立自己的資料目錄，不動使用者的 root）。
 */
export async function createServer(options: CreateServerOptions = {}): Promise<MnemoshelfServer> {
  const env: NodeJS.ProcessEnv = { ...(options.env ?? process.env) };
  if (options.token !== undefined) env.MNEMOSHELF_TOKEN = options.token;
  if (options.dataDir !== undefined) env.MNEMOSHELF_DATA_DIR = options.dataDir;
  if (options.port !== undefined) env.MNEMOSHELF_PORT = String(options.port);
  if (options.webDir !== undefined) env.MNEMOSHELF_WEB_DIR = options.webDir;
  // 設定只有一處驗證來源（loadServerConfig）；覆寫值也走同一條路徑。
  const config: ServerConfig = loadServerConfig(env);

  await fs.mkdir(config.dataDir, { recursive: true });

  const db: SqliteDatabase = openDatabase(config.dbPath);
  const store: MetadataStore = new SqliteMetadataStore(db);
  await store.migrate();

  const embedder: Embedder =
    options.embedder ?? new TransformersEmbedder(config.modelDir === undefined ? {} : { cacheDir: config.modelDir });
  const vec: VectorIndex = new SqliteVectorIndex(db, embedder.info.dim);

  const app = createRestApp({
    store,
    vec,
    embedder,
    token: config.token,
    webDir: config.webDir,
    ...(options.homeDir === undefined ? {} : { homeDir: options.homeDir }),
  });

  const server = http.createServer(app.handler);
  const port = await listen(server, config.port);

  let closed = false;
  return {
    server,
    host: LOOPBACK_HOST,
    port,
    url: `http://${LOOPBACK_HOST}:${port}`,
    config,
    store,
    vec,
    embedder,
    app,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      // 先停止接受新連線並把既有連線收乾淨（含 keep-alive），否則 server.close() 會一直等；
      // 再等在途請求收尾，最後釋放 embedder 與資料庫。
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await app.settled();
      await embedder.dispose();
      db.close();
    },
  };
}

export { LOOPBACK_HOST, loadMcpConfig, loadServerConfig } from "./config.js";
export type { McpConfig, ServerConfig } from "./config.js";
export {
  FileTooLargeError,
  IndexInProgressError,
  InvalidHostError,
  InvalidRequestUrlError,
  MethodNotAllowedError,
  MissingMcpConfigError,
  MissingTokenError,
  NonLoopbackRequestError,
  NotFoundError,
  PayloadTooLargeError,
  RequestUriTooLongError,
  UnauthorizedError,
  UnsupportedFileTypeError,
  ValidationError,
} from "./errors.js";
export { IndexStatusTracker } from "./index-status.js";
export type { IndexErrorInfo, IndexState, IndexStatus } from "./index-status.js";
export {
  listDirectoryEntries,
  makeThumbnail,
  MAX_IMAGE_BYTES,
  MAX_TEXT_PREVIEW_BYTES,
  MAX_THUMBNAIL_INPUT_BYTES,
  parseRelativePath,
  readFilePreview,
  resolveTarget,
  THUMBNAIL_CACHE_LIMIT,
  THUMBNAIL_MAX_WIDTH,
  ThumbnailCache,
} from "./http/explorer.js";
export type {
  DirEntry,
  EntryKind,
  FilePreview,
  ImageBytes,
  ResolvedTarget,
  TextPreview,
  ThumbnailResult,
} from "./http/explorer.js";
export {
  acceptsHtml,
  API_PATH_PREFIXES,
  APP_VERSION,
  createRestApp,
  isApiPath,
  looksLikeFile,
  maskDiagnostics,
  maskHomePath,
  MAX_JSON_BODY_BYTES,
  MAX_MEMORY_CHARS,
  MAX_REQUEST_URL_LENGTH,
  parseRequestTarget,
  STATIC_CSP,
  toHttpError,
} from "./http/app.js";
export type {
  AddRootRequest,
  BytesRouteResult,
  CancelIndexResponse,
  DiagnosticsAppInfo,
  DiagnosticsFileStats,
  DiagnosticsIndexSummary,
  DiagnosticsResponse,
  DiagnosticsRoot,
  ErrorResponse,
  IndexCancelledResponse,
  IndexRootResponse,
  JsonRouteResult,
  ListEntriesResponse,
  ListMemoriesResponse,
  RemoveRootResponse,
  RestApp,
  RestAppDeps,
  RouteResult,
} from "./http/app.js";
export { isLocalHostHeader, isLoopbackAddress, parseBearerToken, requireLocalHost, requireToken, tokensMatch } from "./http/auth.js";
export {
  DEFAULT_SEARCH_K,
  DEFAULT_SEARCH_MODE,
  fuseRanked,
  MAX_SEARCH_K,
  normalizeSearchOptions,
  SEARCH_MODES,
  TEXT_SNIPPET_MAX_CHARS,
  unifiedSearch,
} from "./search.js";
export type {
  ChunkSearchHit,
  FusedHit,
  MemorySearchHit,
  SearchHit,
  SearchMode,
  UnifiedSearchDeps,
  UnifiedSearchOptions,
  UnifiedSearchResult,
} from "./search.js";
export { createMcpServer, MCP_TOOLS, runStdio, UNTRUSTED_DATA_WARNING } from "./mcp/stdio.js";
export type { McpServerOptions } from "./mcp/stdio.js";
