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
import { createAgentDiscovery } from "./agent-discovery.js";
import {
  INDEX_RATE_BETWEEN_FILES_MS,
  LOOPBACK_HOST,
  loadServerConfig,
  type ServerConfig,
} from "./config.js";
import { APP_VERSION, createRestApp, type RestApp } from "./http/app.js";
import { MemoryEmbeddingWorker, type MemoryEmbeddingWorkerOptions } from "./memory-embedder.js";
import { WorkerEmbedder } from "./worker-embedder.js";

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
  /**
   * 覆寫 embedder（測試注入 `FakeEmbedder`）；預設 `WorkerEmbedder`（worker thread 內跑
   * `TransformersEmbedder`，模型 lazy 載入，主執行緒不被推論阻塞）。
   */
  embedder?: Embedder;
  /** 「過寬 root」判定的家目錄基準；預設 `os.homedir()`。 */
  homeDir?: string;
  /**
   * 記憶嵌入 worker 的調校（卡 B1；測試可把重試延遲設 0）。
   * `store`／`embedder` 由 `createServer` 自己注入，這裡只接受調校欄位。
   */
  memoryEmbedding?: Pick<
    MemoryEmbeddingWorkerOptions,
    "batchSize" | "retryAttempts" | "retryDelayMs" | "backfillOnStart"
  >;
  /**
   * 測試注入：listen 成功、連線資訊檔寫出之後、`createServer()` 回傳之前執行的鉤子。
   *
   * 用來驗證「啟動後段失敗時不留含 token 的 runtime 檔」——正式路徑不會使用。
   */
  afterStart?: () => void | Promise<void>;
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
  /** 記憶向量背景 worker（卡 B1；診斷與測試可讀 stats）。 */
  memoryEmbedder: MemoryEmbeddingWorker;
  app: RestApp;
  /**
   * 關閉 HTTP、**取消在途索引**、等目前在途的嵌入批次收尾、釋放 embedder 與資料庫。
   *
   * 「取消在途索引、等一個推論批次、安全結束」：先中止在途索引（該輪可能是 `cancelled`，
   * 未完成的檔案下次索引重做）並停止記憶嵌入 worker；再等目前在途的 native 推論批次收尾
   * （idle 時立即完成），最後才 dispose embedder（此時 worker 閒置，可安全 terminate）並關 DB。
   * 因此 **close 回傳後再結束行程是安全的**（不會 N-API abort）；代價是索引中關閉最壞多等
   * 目前那一個批次。若批次超過上限（預設 120 秒）會記錄並完成關閉，此時不保證可安全
   * `process.exit()`（worker 卡死的理論邊界）。已寫入的檔案是逐檔交易，重啟後可正常再索引。
   */
  close(): Promise<void>;
}

/**
 * 收緊資料目錄與 DB 檔的權限（POSIX：目錄 `700`、DB／WAL／SHM `600`）。
 *
 * **best-effort**：Windows 沒有 POSIX mode，直接略過；chmod 失敗只記錄、不中斷啟動
 * （磁碟格式／權限模型差異可能讓 chmod 無效，但不該讓服務開不起來）。
 */
async function restrictDataPermissions(dataDir: string, dbPath: string): Promise<void> {
  if (process.platform === "win32") return;
  const chmod = async (target: string, mode: number, ignoreMissing: boolean): Promise<void> => {
    try {
      await fs.chmod(target, mode);
    } catch (error) {
      if (ignoreMissing && (error as { code?: unknown }).code === "ENOENT") return;
      console.error("[mnemoshelf] 無法收緊資料權限：", error instanceof Error ? error.message : String(error));
    }
  };
  await chmod(dataDir, 0o700, false);
  await chmod(dbPath, 0o600, false);
  // WAL／SHM 是 SQLite 依需要建立的附屬檔；不存在是正常情況。
  await chmod(`${dbPath}-wal`, 0o600, true);
  await chmod(`${dbPath}-shm`, 0o600, true);
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
 * 關閉時等「目前在途的 native 推論」收尾的上限（毫秒）。
 *
 * 取消在途索引後，索引會在 embedder 的下一個邊界結束；但 native 推論本身不可中斷，
 * 安全關閉必須等**目前這一個批次**跑完（實測數秒到數十秒）。這裡給足一個批次的時間，
 * 不再用 2 秒硬放棄（放棄後立刻 `process.exit()` 會 SIGABRT）。
 * 真的超過（worker 卡死）才記錄並完成關閉；此時不宣稱可安全結束行程（理論邊界）。
 */
const CLOSE_DRAIN_TIMEOUT_MS = 120_000;

/**
 * 注入 embedder（沒有 `drain()`：測試的 `FakeEmbedder` 等）的既有有限等待（毫秒）。
 *
 * 這類 embedder 沒有 native 推論／worker thread，維持原語意：先等背景工作自然收尾，
 * 超過就 `dispose()` 強制收尾，close 不被永不返回的假嵌入拖住。
 */
const CLOSE_GRACE_MS = 2_000;

/** 強制收尾後，等背景工作真正結束的上限（毫秒；只給沒有 drain 的注入 embedder）。 */
const CLOSE_FORCE_MS = 2_000;

/** drain 完成後，等剩餘 HTTP／背景工作收尾的上限（毫秒；正常情況是 0，只是防線）。 */
const CLOSE_SETTLE_MS = 5_000;

/** 有 `drain()` 能力的 embedder（`WorkerEmbedder`；注入的實作通常沒有）。 */
interface DrainableEmbedder {
  /** 等目前在途／已排隊的嵌入呼叫全部結束（只等不拋）。 */
  drain(): Promise<void>;
}

/** 傳 `timeoutMs` 給 `WorkerEmbedder.dispose()` 用；其他 `Embedder` 實作會忽略多餘參數。 */
interface DisposableEmbedder extends Embedder {
  dispose(options?: { timeoutMs?: number }): Promise<void>;
}

/** 取得 embedder 的 `drain()` 能力（沒有就回 `null`，走注入 embedder 的舊路徑）。 */
function drainableEmbedder(embedder: Embedder): DrainableEmbedder | null {
  const candidate = embedder as Partial<DrainableEmbedder>;
  return typeof candidate.drain === "function" ? (candidate as DrainableEmbedder) : null;
}

/**
 * 等 promise 最多 `ms` 毫秒；回傳是否在期限內完成。
 *
 * 只用於關閉流程的「有限等待」：rejection 也算完成（呼叫端之後不依賴結果），
 * 且**不會**把計時器留到 promise 之後才清掉。
 */
async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([promise.then(() => true, () => true), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * 建立並啟動常駐服務。
 *
 * embedder 預設是 `WorkerEmbedder`：真的 `TransformersEmbedder` 在 **worker thread** 內
 * （lazy：啟動不下載模型，第一次索引／查詢才載入），主執行緒只做 HTTP／DB，推論不會阻塞 API。
 * 注入 `options.embedder`（例如測試的 `FakeEmbedder`）時維持直接使用、不建立 worker。
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

  // Agent 連線資訊檔（預設 off）：關閉時先清掉上次 SIGKILL／當機留下的檔，
  // 不讓「已關閉」的功能仍留下有效 token。開啟時在 listen 成功後才寫（見下方）。
  const discovery = createAgentDiscovery({
    enabled: config.agentDiscovery,
    file: config.runtimeFile,
    appVersion: APP_VERSION,
  });
  await discovery.clearStale();

  await fs.mkdir(config.dataDir, { recursive: true });

  const db: SqliteDatabase = openDatabase(config.dbPath);
  const store: MetadataStore = new SqliteMetadataStore(db);
  await store.migrate();
  // 卡 C2：把舊版留下的矛盾 scope／project 冪等正規化（只記筆數，不記錄任何內容）。
  // 放在開機路徑（監聽之前）完成，之後的 REST／MCP 都只會看到合法組合。
  const normalizedLegacyMemories = await store.normalizeLegacyMemoryScopes();
  if (normalizedLegacyMemories.updated > 0) {
    console.error(`[mnemoshelf] 已正規化 ${normalizedLegacyMemories.updated} 筆 legacy 記憶 scope`);
  }
  // 資料庫與其 WAL 檔可能含敏感記憶內容：建立後立刻收緊權限（best-effort、POSIX only）。
  await restrictDataPermissions(config.dataDir, config.dbPath);

  const embedder: Embedder =
    options.embedder ??
    new WorkerEmbedder({
      embedderOptions: {
        // 應用版本是裝置決定快取的身分欄位之一：換版本時 macOS 的 CoreML 自我測試會重測一次
        // （量測結果與當時的實作綁在一起，見 embedder 的 `self-test.ts`）。
        appVersion: APP_VERSION,
        ...(config.modelDir === undefined ? {} : { cacheDir: config.modelDir }),
      },
    });
  const vec: VectorIndex = new SqliteVectorIndex(db, embedder.info.dim);

  // 記憶向量背景 worker（卡 B1）：非阻塞回填既有記憶，之後由 POST /memories enqueue。
  const memoryEmbedder = new MemoryEmbeddingWorker({
    store,
    embedder,
    ...(options.memoryEmbedding ?? {}),
    // 設定檔的 `MNEMOSHELF_MEMORY_BACKFILL` 決定啟動回填；測試可用 options 覆寫。
    backfillOnStart: options.memoryEmbedding?.backfillOnStart ?? config.memoryBackfill,
  });

  const app = createRestApp({
    store,
    vec,
    embedder,
    token: config.token,
    webDir: config.webDir,
    memoryEmbedder,
    ...(options.homeDir === undefined ? {} : { homeDir: options.homeDir }),
    // 索引限速（MNEMOSHELF_INDEX_RATE）：0＝off，完全不傳（行為與舊版相同）。
    ...(INDEX_RATE_BETWEEN_FILES_MS[config.indexRate] > 0
      ? { indexThrottle: { betweenFilesMs: INDEX_RATE_BETWEEN_FILES_MS[config.indexRate] } }
      : {}),
  });

  const server = http.createServer(app.handler);
  const port = await listen(server, config.port);

  // 監聽成功後才啟動背景回填（啟動失敗時不留背景工作）。
  memoryEmbedder.start();

  /**
   * 最後一步：寫出 agent 連線資訊檔（只在 discovery=on）。
   *
   * 放在 listen 與 `memoryEmbedder.start()` 都成功之後：外部程式拿到檔案時，服務一定已經
   * 可以接受請求。若「寫檔之後、`createServer()` 回傳之前」還有步驟失敗（`afterStart` 注入，
   * 或未來新增的啟動後段），先刪檔再收掉資源並拋錯——不能留下指向半死服務的 token 檔。
   * 單純的寫檔失敗（權限／磁碟）已在 `discovery.write()` 內降級成 warning，不阻止啟動。
   */
  try {
    if (discovery.enabled) {
      await discovery.write({ url: `http://${LOOPBACK_HOST}:${port}`, token: config.token });
    }
    await options.afterStart?.();
  } catch (error) {
    await discovery.remove();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    // 與 `close()` 對稱：先中止在途索引，再等它們（與記憶嵌入）真的收尾，最後才關 DB。
    // 少了這段，啟動後段失敗時在途索引可能寫進已關閉的資料庫（或留下未處理的 rejection）。
    const cancelled = app.cancelAllIndexing();
    if (cancelled > 0) {
      console.error(`[mnemoshelf] 啟動失敗回滾：已取消 ${cancelled} 個在途索引`);
    }
    const settled = Promise.all([app.settled(), memoryEmbedder.close()]).then(() => undefined);
    const drainable = drainableEmbedder(embedder);
    const drained =
      drainable === null
        ? await settlesWithin(settled, CLOSE_GRACE_MS)
        : await settlesWithin(
            Promise.all([settled, drainable.drain()]).then(() => undefined),
            CLOSE_DRAIN_TIMEOUT_MS,
          );
    if (!drained) {
      console.error("[mnemoshelf] 啟動失敗回滾：背景工作未在期限內結束，仍繼續關閉（不 hang）");
    }
    await embedder.dispose().catch(() => undefined);
    db.close();
    throw error;
  }

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
    memoryEmbedder,
    app,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      // 先移除連線資訊檔（只刪自己 pid 的檔；失敗只記錄，不讓關閉失敗）。
      // 放在最前面：token 檔存在的時間越短越好，即使後面的關閉流程較久。
      await discovery.removeIfOwned();
      // 先停止接受新連線並把既有連線收乾淨（含 keep-alive），否則 server.close() 會一直等。
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));

      // 關閉優先：先中止所有在途索引。索引是背景工作，native 推論本身不可中斷，因此這裡只送
      // abort；下面的等待／drain 才是 close 的實際邊界。
      const cancelled = app.cancelAllIndexing();
      if (cancelled > 0) {
        console.error(
          `[mnemoshelf] 關閉中：已取消 ${cancelled} 個在途索引（未完成的檔案下次索引重做）`,
        );
      }
      // 記憶嵌入 worker 也停止拉新工作；它會等目前那一筆嵌入結束。
      const memoryClosed = memoryEmbedder.close();
      // 背景工作＝在途 HTTP 請求（含索引）＋目前這一筆記憶嵌入。
      const settled = Promise.all([app.settled(), memoryClosed]).then(() => undefined);

      const drainable = drainableEmbedder(embedder);
      if (drainable !== null) {
        // 安全關閉：等目前在途的 native 推論批次收尾（不再 2 秒硬放棄）。`settled` 涵蓋在途
        // HTTP（索引／搜尋）與記憶嵌入；`drain` 涵蓋直接呼叫 embedder 的背景工作，兩者一起等。
        const drained = await settlesWithin(
          Promise.all([settled, drainable.drain()]).then(() => undefined),
          CLOSE_DRAIN_TIMEOUT_MS,
        );
        if (drained) {
          // worker 已閒置：dispose 只會釋放模型並在安全邊界 terminate（不 abort 行程）。
          await embedder.dispose();
        } else {
          // worker 卡死（超過一個批次的理論上限）：記錄、放棄等待，不再重複等一輪。
          // 此時不能宣稱「close 後立刻 process.exit 安全」——文件已寫明理論邊界。
          console.error(
            `[mnemoshelf] 關閉時在途推論超過 ${CLOSE_DRAIN_TIMEOUT_MS}ms 仍未收尾；` +
              "仍完成關閉，但此時結束行程不保證安全（native 批次可能還在跑）",
          );
          await (embedder as DisposableEmbedder).dispose({ timeoutMs: 0 });
          // 放棄在途呼叫後讓背景工作以清楚的關閉錯誤收尾，避免 db.close() 與在途寫入交錯。
          if (!(await settlesWithin(settled, CLOSE_SETTLE_MS))) {
            console.error("[mnemoshelf] 關閉時背景工作未在期限內結束，仍繼續關閉（不 hang）");
          }
        }
      } else {
        // 注入的 embedder（沒有 drain；例如測試的 FakeEmbedder）：維持既有「有限等待＋強制
        // 收尾」語意，避免被永不返回的假嵌入拖住。真的 WorkerEmbedder 走上面的安全路徑。
        if (!(await settlesWithin(settled, CLOSE_GRACE_MS))) {
          // 讓 embedder 放棄在途呼叫（以清楚的關閉錯誤結束），索引已 abort 會優先當成取消。
          const disposing = embedder.dispose();
          if (!(await settlesWithin(settled, CLOSE_FORCE_MS))) {
            // 理論上只剩「注入的 embedder 不理 dispose」；仍不 hang，但記錄下來供診斷。
            console.error("[mnemoshelf] 關閉時背景工作未在期限內結束，仍繼續關閉（不 hang）");
          }
          // 放棄路徑會立刻返回；仍給 dispose 一個上限，避免注入的 embedder 不守約定。
          await settlesWithin(disposing, CLOSE_FORCE_MS);
        }
        // 正常路徑：優雅關閉 embedder；強制路徑已 dispose 過（第二次是 no-op）。
        await embedder.dispose();
      }
      db.close();
    },
  };
}

export { LOOPBACK_HOST, loadMcpConfig, loadServerConfig } from "./config.js";
export type { IndexRate, McpConfig, ServerConfig } from "./config.js";
export {
  AGENT_RUNTIME_SCHEMA_VERSION,
  createAgentDiscovery,
  parseRuntimeFile,
  readRuntimeFile,
  removeRuntimeFile,
  removeRuntimeFileIfOwned,
  writeRuntimeFile,
} from "./agent-discovery.js";
export type {
  AgentDiscovery,
  AgentRuntimeFile,
  AgentRuntimeWriteInput,
  CreateAgentDiscoveryOptions,
} from "./agent-discovery.js";
export {
  EmbedderWorkerClosedError,
  EmbedderWorkerCrashError,
  WorkerEmbedder,
} from "./worker-embedder.js";
export type {
  EmbedderWorkerEvent,
  EmbedderWorkerLike,
  EmbedderWorkerMethod,
  WorkerEmbedderOptions,
} from "./worker-embedder.js";
export {
  FileTooLargeError,
  IndexInProgressError,
  InvalidHostError,
  InvalidRequestUrlError,
  McpConnectionError,
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
export type { McpConnectionFailureReason } from "./errors.js";
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
  MAX_MEMORY_METADATA_CHARS,
  MAX_MEMORY_QUERY_CHARS,
  MAX_REQUEST_URL_LENGTH,
  parseRequestTarget,
  SERVICE_NAME,
  STATIC_CSP,
  toHttpError,
} from "./http/app.js";
export type {
  AddMemoryResponse,
  AddRootRequest,
  BytesRouteResult,
  CancelIndexResponse,
  DiagnosticsAppInfo,
  DiagnosticsFileStats,
  DiagnosticsIndexSummary,
  DiagnosticsResponse,
  DiagnosticsRoot,
  ErrorResponse,
  ForgetMemoryResponse,
  HardDeleteMemoryResponse,
  IndexCancelledResponse,
  IndexRootResponse,
  JsonRouteResult,
  ListEntriesResponse,
  ListMemoriesResponse,
  PatchMemoryRequest,
  PatchRootRequest,
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
export { createMcpServer, MCP_TOOLS, resolveProjectName, runStdio, UNTRUSTED_DATA_WARNING } from "./mcp/stdio.js";
export {
  checkServiceHealth,
  describeMcpConnectionFailure,
  isProcessAlive,
  MCP_HEALTH_TIMEOUT_MS,
  resolveMcpConnection,
  runtimeCandidates,
} from "./mcp/runtime-connection.js";
export type {
  HealthCheckResult,
  McpConnection,
  McpConnectionSource,
  ResolveMcpConnectionOptions,
} from "./mcp/runtime-connection.js";
export { containsRedacted, maskSecrets, REDACTED_PREFIX } from "./secret-masking.js";
export type { MaskSecretsResult, SecretKind } from "./secret-masking.js";
export type { McpServerOptions, ProjectResolution, ResolveProjectOptions } from "./mcp/stdio.js";
export {
  buildMemorySearchBuckets,
  MEMORY_SEARCH_DEFAULT_K,
  MEMORY_SEARCH_MAX_K,
  searchMemories,
} from "./memory-search.js";
export type {
  MemoryRecallDegradedReason,
  MemoryRecallHit,
  MemoryRecallInput,
  MemoryRecallResponseBody,
  MemoryRecallSource,
  MemorySearchDeps,
} from "./memory-search.js";
export {
  MEMORY_EMBEDDING_DEFAULT_BATCH_SIZE,
  MEMORY_EMBEDDING_DEFAULT_RETRY_ATTEMPTS,
  MEMORY_EMBEDDING_DEFAULT_RETRY_DELAY_MS,
  MemoryEmbeddingWorker,
} from "./memory-embedder.js";
export type { MemoryEmbeddingWorkerOptions, MemoryEmbeddingWorkerStats } from "./memory-embedder.js";
export {
  countImportDuplicates,
  MAX_MEMORY_IMPORT_BYTES,
  MAX_MEMORY_IMPORT_ERRORS,
  MEMORY_EXPORT_CONTENT_TYPE,
  MEMORY_EXPORT_SCHEMA_VERSION,
  MEMORY_KINDS,
  memoryExportFilename,
  memoryExportRecord,
  parseDryRunParam,
  planMemoryImport,
  serializeMemoryExportLine,
  serializeMemoriesExport,
} from "./memory-export.js";
export type {
  MemoryExportRecord,
  MemoryImportEntry,
  MemoryImportLineError,
  MemoryImportPlan,
  MemoryImportResponse,
} from "./memory-export.js";
