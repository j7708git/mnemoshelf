import type {
  Chunk,
  Memory,
  MemoryEmbeddingState,
  MemoryKind,
  MemoryPatch,
  MemoryScope,
  NewChunk,
  NewMemory,
  NewRoot,
  RankedHit,
  Root,
  RootPatch,
  SearchFilter,
} from "./types.js";

/** `listMemories` 未指定 `limit` 時的預設筆數。 */
export const MEMORY_LIST_DEFAULT_LIMIT = 100;
/** `listMemories` 的 `limit` 上限（超過者夾到此值）。 */
export const MEMORY_LIST_MAX_LIMIT = 500;

/** 合法的記憶作用範圍（runtime 檢查用；型別上是 `MemoryScope`）。 */
export const MEMORY_SCOPES: readonly MemoryScope[] = ["global", "project", "agent"];

/** 合法的記憶向量狀態（runtime 檢查用；型別上是 `MemoryEmbeddingState`）。 */
export const MEMORY_EMBEDDING_STATES: readonly MemoryEmbeddingState[] = ["pending", "ready", "failed", "too-long"];

/**
 * 列舉記憶的過濾條件。全部可選，未指定（或 `undefined`）＝該欄位不過濾。
 * `project` 只比對字串：要列出「沒有專案」的記憶請改用其他欄位組合，
 * 本介面刻意不提供 `project: null` 的語意（避免與「不過濾」混淆）。
 */
export interface MemoryFilter {
  scope?: MemoryScope;
  project?: string;
  agent?: string;
  kind?: MemoryKind;
  /** 回傳筆數；預設 `MEMORY_LIST_DEFAULT_LIMIT`，上限 `MEMORY_LIST_MAX_LIMIT`。 */
  limit?: number;
}

/**
 * 把 `limit` 正規化成實際要查詢的筆數。
 *
 * - 未指定 → `MEMORY_LIST_DEFAULT_LIMIT`；
 * - 非正整數或 <= 0 → 0（呼叫端據此回傳空清單，與 `searchKeyword(k <= 0)` 的既有慣例一致）；
 * - 超過 `MEMORY_LIST_MAX_LIMIT` → 夾到上限。
 *
 * 放在 port 檔案裡，讓各實作與呼叫端共用同一套邊界語意（不得各自解讀）。
 */
export function normalizeMemoryLimit(limit: number | undefined): number {
  if (limit === undefined) return MEMORY_LIST_DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit <= 0) return 0;
  return Math.min(limit, MEMORY_LIST_MAX_LIMIT);
}

/**
 * 把 `MemoryPatch` 套用到現值上，回傳正規化後的 `scope`／`project`（`MetadataStore.updateMemory`）。
 *
 * 兩後端共用同一套語意（不得各自解讀）；REST 與 MCP 也以同一函式做前置驗證。規則：
 * - `patch` 兩個欄位都沒提供（或都是 `undefined`）→ 拋 `TypeError`（沒有要改的東西不是合法請求）；
 * - `scope` 不合法（runtime 值不在 `MEMORY_SCOPES` 內）→ 拋 `TypeError`；
 * - `scope === "project"`：`project` 以 patch 優先、否則沿用現值，**trim 後必須非空**，否則拋錯；
 * - `scope !== "project"`：結果一律 `project: null`（即使 patch 沒帶 `project`，也會把現值清掉）；
 *   若呼叫端**明確**給了非 null 的 `project` → 拋錯（語意矛盾，不要靜默忽略）。
 *
 * 拋錯型別刻意用 `TypeError`（呼叫端傳了語意不合法的參數），不新增專用錯誤型別；
 * 儲存層對「不存在／已軟刪除的 id」是先回 `null`、不做這裡的驗證（見 `MetadataStore.updateMemory`）。
 */
export function normalizeMemoryPatch(
  current: Pick<Memory, "scope" | "project">,
  patch: MemoryPatch,
): { scope: MemoryScope; project: string | null } {
  if (patch.scope === undefined && patch.project === undefined) {
    throw new TypeError("updateMemory 的 patch 至少要提供 scope 或 project");
  }

  const scope = patch.scope ?? current.scope;
  if (!(MEMORY_SCOPES as readonly string[]).includes(scope)) {
    throw new TypeError(`updateMemory 的 scope 不合法：${String(scope)}`);
  }

  if (scope === "project") {
    const raw = patch.project === undefined ? current.project : patch.project;
    if (typeof raw !== "string" || raw.trim().length === 0) {
      throw new TypeError("scope 為 project 時 project 必須是非空的專案名稱");
    }
    return { scope, project: raw.trim() };
  }

  if (patch.project !== undefined && patch.project !== null) {
    if (typeof patch.project !== "string") throw new TypeError("project 必須是字串或 null");
    throw new TypeError(`scope 為 ${scope} 時 project 必須是 null（全域／agent 範圍沒有專案）`);
  }
  return { scope, project: null };
}

/** `markMemoryEmbeddingFailed` 可設定的狀態：可重試的 `failed` 或永久跳過的 `too-long`。 */
export type MemoryEmbeddingFailure = "failed" | "too-long";

/** 記憶語意／關鍵字檢索的 `k` 上限（store 層；REST 較嚴格，另有自己的上限）。 */
export const MEMORY_SEARCH_MAX_K = 500;

/**
 * 把記憶檢索的 `k` 正規化成實際要查詢的筆數。
 *
 * - 非正整數或 <= 0 → 0（呼叫端據此回傳空清單，與 `searchKeyword(k <= 0)` 的慣例一致）；
 * - 超過 `MEMORY_SEARCH_MAX_K` → 夾到上限。
 *
 * 放在 port 檔案裡，讓各實作與呼叫端共用同一套邊界語意（不得各自解讀）。
 */
export function normalizeMemorySearchK(k: number): number {
  if (!Number.isInteger(k) || k <= 0) return 0;
  return Math.min(k, MEMORY_SEARCH_MAX_K);
}

/**
 * 記憶檢索的一個「可見 bucket」（OR 起來；卡 B2）。
 *
 * - `global`：只比對 `scope='global'`；不得帶 `project`／`agent`。
 * - `project`：比對 `scope='project'`；`project` 有值＝精確比對該專案名，**省略＝所有專案**
 *   （「找全部專案」用；這是介面層對「所有專案」的唯一表示，不需要列舉專案名）。
 * - `agent`：比對 `scope='agent' AND agent = ?`；`agent` 必填且非空白。
 */
export interface MemorySearchBucket {
  scope: MemoryScope;
  /** `scope=project` 時：有值＝精確比對專案名；省略＝所有專案。 */
  project?: string;
  /** `scope=agent` 時必填（比對 `memories.agent`）。 */
  agent?: string;
}

/**
 * 記憶檢索的過濾條件（`searchMemoriesByVector`／`searchMemoriesKeyword` 共用）。
 *
 * - `buckets` 未提供＝不限制 scope（仍永遠排除軟刪除）；空陣列＝沒有可見範圍（回空清單）。
 * - `kind` 精確比對。
 */
export interface MemorySearchFilter {
  buckets?: MemorySearchBucket[];
  kind?: MemoryKind;
}

/** 驗證並正規化後的 bucket（`project` 省略＝所有專案）。 */
export interface NormalizedMemorySearchBucket {
  scope: MemoryScope;
  project?: string;
  agent?: string;
}

/** `normalizeMemorySearchFilter` 的結果。 */
export interface NormalizedMemorySearchFilter {
  /** 未提供＝`undefined`；空陣列＝沒有可見範圍。 */
  buckets: NormalizedMemorySearchBucket[] | undefined;
  kind: MemoryKind | undefined;
}

/**
 * 驗證並正規化 `MemorySearchFilter`（兩後端共用；不得各自解讀）。
 *
 * 非法 bucket（scope 不合法、`global` 帶 `project`／`agent`、`agent` 缺 `agent` 或空白、
 * `project` 非字串）→ 拋 `TypeError`。`project` 名稱 trim 後儲存／比對（寫入端已 trim）；
 * `agent` 是寫入者標識，**不 trim**（只要求 trim 後非空）以維持精確比對。
 */
export function normalizeMemorySearchFilter(filter: MemorySearchFilter = {}): NormalizedMemorySearchFilter {
  if (filter === null || typeof filter !== "object") {
    throw new TypeError("MemorySearchFilter 必須是物件");
  }
  const kind = filter.kind;
  const rawBuckets = filter.buckets;
  if (rawBuckets === undefined) return { buckets: undefined, kind };
  if (!Array.isArray(rawBuckets)) throw new TypeError("MemorySearchFilter.buckets 必須是陣列");

  return {
    buckets: rawBuckets.map((bucket, index) => {
      if (bucket === null || typeof bucket !== "object" || Array.isArray(bucket)) {
        throw new TypeError(`buckets[${index}] 必須是物件`);
      }
      const record = bucket as { scope?: unknown; project?: unknown; agent?: unknown };
      const scope = record.scope;
      if (typeof scope !== "string" || !(MEMORY_SCOPES as readonly string[]).includes(scope)) {
        throw new TypeError(`buckets[${index}].scope 不合法：${String(scope)}`);
      }

      if (scope === "global") {
        if (record.project !== undefined || record.agent !== undefined) {
          throw new TypeError(`buckets[${index}]：scope=global 不得帶 project／agent`);
        }
        return { scope: "global" };
      }
      if (scope === "project") {
        if (record.project !== undefined && typeof record.project !== "string") {
          throw new TypeError(`buckets[${index}].project 必須是字串`);
        }
        return typeof record.project === "string"
          ? { scope: "project", project: record.project.trim() }
          : { scope: "project" };
      }
      // scope === "agent"
      if (typeof record.agent !== "string" || record.agent.trim() === "") {
        throw new TypeError(`buckets[${index}]：scope=agent 時 agent 必須是非空字串`);
      }
      return { scope: "agent", agent: record.agent };
    }),
    kind,
  };
}

/**
 * 驗證記憶向量檢索的查詢向量：必須是非空、只含有限值的 `Float32Array`。
 * 維度與資料不符時由實作在比對時拋 `TypeError`（不得默默跳過）。
 */
export function assertMemoryQueryVector(vector: Float32Array): void {
  if (!(vector instanceof Float32Array) || vector.length === 0) {
    throw new TypeError("queryVec 必須是非空的 Float32Array");
  }
  for (const value of vector) {
    if (!Number.isFinite(value)) throw new TypeError("queryVec 只能包含有限值");
  }
}

/**
 * 兩個向量的 cosine similarity（精確、O(dim)；SQLite 端在應用層計算）。
 * 維度不同 → 拋 `TypeError`；任一向量模長為 0 → 回 0（不出現 NaN）。
 *
 * 結果夾在 [-1, 1]：float32 資料以 float64 運算時，相同向量的比值可能出現 1+1e-16 這種
 * 浮點誤差，契約承諾 `score` 範圍是 [-1,1]，因此在邊界收斂（不影響排序）。
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new TypeError(`向量維度不符：查詢 ${a.length} 維、記憶 ${b.length} 維`);
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index += 1) {
    const left = a[index]!;
    const right = b[index]!;
    dot += left * right;
    normA += left * left;
    normB += right * right;
  }
  if (normA === 0 || normB === 0) return 0;
  const similarity = dot / (Math.sqrt(normA) * Math.sqrt(normB));
  return Math.min(1, Math.max(-1, similarity));
}

/**
 * 記憶語意檢索的一筆命中（store 層；只帶 id 與 cosine 分數，完整 `Memory` 由呼叫端補）。
 * 排序：`score` 降冪、同分 `id` 升冪。
 */
export interface MemoryVectorHit {
  id: number;
  /** cosine similarity（float，範圍 [-1, 1]）。 */
  score: number;
}

/** 記憶關鍵字檢索的一筆命中（store 層；`rank` 從 1 起算）。 */
export interface MemoryKeywordHit {
  id: number;
  rank: number;
}

/**
 * 記憶語意化的狀態統計（`MetadataStore.memoryEmbeddingStats`）。
 *
 * 只統計**未刪除**的記憶；四個狀態數必須自洽（`total = pending + ready + failed + tooLong`）。
 */
export interface MemoryEmbeddingStats {
  /** 未刪除的記憶總數。 */
  total: number;
  pending: number;
  ready: number;
  failed: number;
  /** `state = "too-long"` 的筆數（狀態字串有連字號，欄位名用 camelCase）。 */
  tooLong: number;
  /**
   * `state = "ready"` 但 `embedding_embedder_id` 不是查詢的 embedder（換 embedder 後待重嵌）。
   * 這是 `ready` 的子集，**不**另計入 `total`。
   */
  stale: number;
}

/**
 * 驗證 `markMemoryEmbedded` 的輸入。兩後端共用（不得各自解讀）：
 * `embedderId` 必須是 trim 後非空的字串；`vec` 必須是非空、只含有限值的 `Float32Array`。
 * **不驗證 L2 正規化**（由 embedder 契約保證，見 `docs/embedder-contract.md`）。
 */
export function assertMemoryEmbeddingInput(embedderId: string, vector: Float32Array): void {
  if (typeof embedderId !== "string" || embedderId.trim().length === 0) {
    throw new TypeError("embedderId 必須是非空字串");
  }
  if (!(vector instanceof Float32Array) || vector.length === 0) {
    throw new TypeError("vec 必須是非空的 Float32Array");
  }
  for (const value of vector) {
    if (!Number.isFinite(value)) throw new TypeError("vec 只能包含有限值");
  }
}

/** 驗證 `markMemoryEmbeddingFailed` 的 `reason`（runtime 值；型別之外的值一律拋 `TypeError`）。 */
export function assertMemoryEmbeddingFailure(reason: MemoryEmbeddingFailure): void {
  if (reason !== "failed" && reason !== "too-long") {
    throw new TypeError(`未知的記憶向量失敗狀態：${String(reason)}`);
  }
}

/**
 * 中繼資料儲存介面（預設實作為 SQLite）。
 * 職責：roots、檔案 chunk 文字、記憶、遷移。
 * 全文檢索的斷詞方式屬於實作細節，不得洩漏到介面。
 */
export interface MetadataStore {
  /** 套用遷移。必須可重複呼叫（冪等）。 */
  migrate(): Promise<void>;

  addRoot(r: NewRoot): Promise<Root>;
  getRoot(id: number): Promise<Root | null>;
  listRoots(): Promise<Root[]>;

  /**
   * 更新 root 的可變設定（見 `RootPatch`；目前只有 `modalities`）。
   *
   * - 回傳**更新後**的 root，讓呼叫端不必再讀一次；
   * - id 不存在時回 `null`（呼叫端據此回 404；本方法自己不拋錯，
   *   與 `setMemoryPinned` 對不存在 id 的「不拋錯」風格一致）；
   * - 只改設定，**不動**任何 chunk／向量：模態要在下一次 `indexRoot` 才會生效
   *   （關掉模態不會立刻釋放既有向量，重新索引時才由清理迴圈清掉）。
   */
  updateRoot(id: number, patch: RootPatch): Promise<Root | null>;

  /**
   * 移除 root。
   * `deleteData=true` 時連同該 root 的所有 chunks 一併刪除（向量由呼叫端另行刪除），
   * 並回傳被刪除的 chunk id；`deleteData=false` 時保留 chunks 且回傳空陣列。
   */
  removeRoot(id: number, deleteData: boolean): Promise<{ removedChunkIds: number[] }>;

  /** 以 (rootId, relPath) 為單位先清空舊 chunk 再寫入新的（冪等）。 */
  replaceChunks(
    rootId: number,
    relPath: string,
    chunks: Omit<NewChunk, "rootId" | "relPath">[],
  ): Promise<Chunk[]>;

  /** 刪除某個檔案的 chunks，回傳被刪除的 id。 */
  deleteChunksByPath(rootId: number, relPath: string): Promise<number[]>;

  /** 依 id 取回 chunks（順序依傳入的 ids，缺漏者略過）。 */
  getChunks(ids: number[]): Promise<Chunk[]>;

  /**
   * 列出某個檔案（`rootId` + `relPath`）的所有 chunk，依 `seq`（再依 id）排序。
   * 供 indexer 的內容 hash 增量比對讀取既有 chunk 的 `contentHash`。
   */
  listChunksByPath(rootId: number, relPath: string): Promise<Chunk[]>;

  /**
   * 列出某個 root 底下所有出現過的相對路徑（去重，依字典序排序）。
   * 供 indexer 找出「磁碟上已消失、但 DB 仍有資料」的檔案並清除。
   */
  listRelPaths(rootId: number): Promise<string[]>;

  /** 新增記憶；`supersedes` 有值時把被取代者標記 `deletedAt`。新增的記憶一律 `pinned=false`。 */
  addMemory(m: NewMemory): Promise<Memory>;

  /**
   * 寫入記憶，但**先做精確去重**：同一 key（內容 hash＋`scope`＋`project`＋`agent`）已有
   * 未刪除（`deletedAt == null`）的記憶時，不新增、回傳既有列與 `duplicate: true`；
   * 否則與 `addMemory` 相同地新增（含 FTS 維護、`content_hash`、`supersedes` 軟刪除、
   * `pinned` 預設 `false`）並回 `duplicate: false`。
   *
   * - **key 的內容部分**＝`memoryContentHash(m.content)`（Unicode NFC、trim、連續空白收斂；
   *   不轉大小寫、不動標點）。呼叫端（REST）傳入的是**遮罩後**內容，因此「憑證不同但遮罩後
   *   同文」視為重複。
   * - `project` 以 SQL 的 null-safe 比較（`is`／`coalesce`），不會因 null 比較漏判；
   *   非 `project` scope 的 `project` 一律是 `null`。
   * - **競態**：檢查與新增在同一個交易／單一 SQL 敘述內完成（本專案是單一寫入者；
   *   PostgreSQL 的實作以 `insert … where not exists` 語意對齊）。
   * - **已軟刪除者不計入**：軟刪除後可以再新增一筆相同內容；`duplicate` 的既有列一定是
   *   未刪除者。
   * - `supersedes` 有值時**仍會**先標記被取代者（與 `addMemory` 相同）；REST 的「編輯流程」
   *   另行跳過去重，不在這裡判斷。
   */
  addMemoryUnlessDuplicate(m: NewMemory): Promise<{ memory: Memory; duplicate: boolean }>;

  getMemory(id: number): Promise<Memory | null>;
  /** 軟刪除。 */
  forgetMemory(id: number): Promise<void>;

  /**
   * 把舊版留下的**矛盾 scope／project 組合**冪等正規化（啟動時呼叫一次）：
   *
   * - `scope in ('global','agent')` 但 `project` 非 null → `project = null`；
   * - `scope = 'project'` 但 `project` 為 null／空字串（trim 後）→ `scope = 'global'`
   *   且 `project = null`（無法猜專案）。
   *
   * 其他合法列不動；不清除、不合併任何記憶內容。回傳**實際更新**的列數（第二次呼叫為 0）。
   */
  normalizeLegacyMemoryScopes(): Promise<{ updated: number }>;

  /**
   * 硬刪除記憶資料列（含 FTS 列；向量是同一列的欄位，一併消失）。
   *
   * - 可刪已軟刪除者；未知 id 回 `false`（不拋錯、不建立列）。
   * - 僅保證「API／查詢不再可見、資料列不存在」；**不做取證級抹除**（SQLite WAL／檔案系統
   *   頁面可能仍有殘留，at-rest 仍為明文），見 `docs/roots-and-privacy.md`。
   * - 其他記憶的 `supersedes` 若指向被刪除的 id，屬歷史欄位，不影響讀取。
   */
  hardDeleteMemory(id: number): Promise<boolean>;

  /**
   * 設定記憶的釘選狀態（冪等；M3 擴充）。
   *
   * 不存在的 id 是**無操作**（不拋錯），與 `forgetMemory` 的既有風格一致；
   * 需要判斷存在與否的呼叫端（例如 REST 端點要回 404）請先 `getMemory`。
   */
  setMemoryPinned(id: number, pinned: boolean): Promise<void>;

  /**
   * 更新記憶的範圍與專案（`MemoryPatch`；共享開關的唯一寫入入口）。
   *
   * - 只改 `scope`／`project`；其餘欄位（`content`、`kind`、`agent`、`supersedes`、`pinned`、
   *   `createdAt`、`deletedAt`）原樣保留。
   * - **不存在或已軟刪除**（`deletedAt != null`）→ 回 `null`（不拋錯，也不改資料）。
   * - 以現值為基底套用 patch，正規化規則見 `normalizeMemoryPatch`（非法 patch 拋 `TypeError`）。
   * - **冪等**：同一個 patch 重複套用結果相同。
   * - 回傳**更新後**的完整 `Memory`，呼叫端不必再讀一次；`getMemory`／`listMemories` 也反映新值。
   */
  updateMemory(id: number, patch: MemoryPatch): Promise<Memory | null>;

  /**
   * 寫入記憶向量並把狀態設為 `ready`（卡 B1；背景 worker 的唯一成功寫入入口）。
   *
   * - 同時設定 `embedding`、`embedding_embedder_id` 與 `embedding_state='ready'`。
   * - **未知 id 或已軟刪除 → 無操作**（不拋錯，也不改資料）。
   * - `embedderId` 空白或 `vec` 空／含非有限值 → 拋 `TypeError`（見 `assertMemoryEmbeddingInput`）。
   * - 不驗證 L2 正規化（由 embedder 契約保證）；向量不暴露在 `Memory` 與 REST 回應。
   */
  markMemoryEmbedded(id: number, embedderId: string, vec: Float32Array): Promise<void>;

  /**
   * 把記憶的向量狀態設為 `failed`（可重試）或 `too-long`（永久跳過）。
   *
   * - **保留**既有 `embedding`／`embedding_embedder_id`（若有）：召回端只採 `ready` 且
   *   embedder 相符者（卡 B2），失敗狀態的舊向量不得被當成可用結果。
   * - 未知 id 或已軟刪除 → 無操作；`reason` 非法 → 拋 `TypeError`。
   */
  markMemoryEmbeddingFailed(id: number, reason: MemoryEmbeddingFailure): Promise<void>;

  /**
   * 列出需要（重新）產生向量的未刪除記憶，供回填與重試流程使用。
   *
   * 條件＝`state in ('pending','failed')` 或（`state='ready'` 但 embedder 不相符）；
   * **排除 `too-long`**。排序與 `listMemories` 相同（`createdAt` 由新到舊、同毫秒以 `id` 決序）；
   * `limit` 的邊界語意沿用 `normalizeMemoryLimit`（預設 100、上限 500、<= 0 回傳空清單）。
   */
  listMemoriesNeedingEmbedding(embedderId: string, limit?: number): Promise<Memory[]>;

  /** 統計未刪除記憶的語意化狀態（見 `MemoryEmbeddingStats`）。 */
  memoryEmbeddingStats(embedderId: string): Promise<MemoryEmbeddingStats>;

  /**
   * 記憶的**語意**檢索（卡 B2）：先過濾、再排名（不得先取 top-k 再過濾）。
   *
   * - 只取 `embedding_state='ready'`、`embedding_embedder_id = embedderId` 且未刪除的記憶；
   *   `filter`（bucket／kind）在 SQL 先套用，再計算 cosine similarity。
   * - `queryVec` 必須是非空、只含有限值的 `Float32Array`（見 `assertMemoryQueryVector`）；
   *   與資料維度不同 → 拋 `TypeError`（不默默跳過）。
   * - `k` 的邊界語意見 `normalizeMemorySearchK`（<= 0 回空、上限 500）。
   * - 回傳 `{id, score}`：`score` 為 cosine similarity（[-1, 1]）；排序 `score` 降冪、同分 `id` 升冪。
   * - 沒有可用向量時回 `[]`（不拋錯）；`filter.buckets` 空陣列也回 `[]`。
   */
  searchMemoriesByVector(
    queryVec: Float32Array,
    embedderId: string,
    filter: MemorySearchFilter,
    k: number,
  ): Promise<MemoryVectorHit[]>;

  /**
   * 記憶的**關鍵字**檢索（卡 B2）：沿用後端 FTS 與既有斷詞，**先套同一組 filter**、再排名。
   *
   * - 只回未刪除的記憶（**不得**混入 chunk 結果）；空查詢／無可搜尋詞 → `[]`。
   * - `k` 邊界同 `searchMemoriesByVector`（<= 0 空、上限 500）。
   * - 回傳 `{id, rank}`（rank 從 1 起算）；排序由後端 FTS 決定，同分以 `id` 決勝以確保可重現。
   */
  searchMemoriesKeyword(query: string, filter: MemorySearchFilter, k: number): Promise<MemoryKeywordHit[]>;

  /**
   * 列舉**未刪除**的記憶（軟刪除者與被取代者不會出現）。
   *
   * - 排序：`createdAt` 由新到舊；同一時間戳（同毫秒）以 `id` 由大到小決定，確保可重現。
   * - `filter` 全部可選，未指定＝不過濾；各欄位為精確比對（見 `MemoryFilter`）。
   * - `filter.limit` 的邊界語意見 `normalizeMemoryLimit`（預設 100、上限 500、<= 0 回傳空清單）。
   */
  listMemories(filter?: MemoryFilter): Promise<Memory[]>;

  /**
   * 列出**全部未刪除**的記憶，供備份匯出使用（見 `docs/storage-ports.md` §記憶的匯出／匯入）。
   *
   * - 只列未刪除者（軟刪除與被取代者不列）；**不受 `normalizeMemoryLimit` 的 500 筆上限限制**
   *   ——備份要全量，不是一次頁面查詢。
   * - 排序：`createdAt` 由**舊到新**（與 `listMemories` 相反）；同一毫秒以 `id` 由小到大決勝，
   *   匯入端依相同內容重建後仍可重現相對順序。
   * - 回傳的是資料庫原文（未遮罩）；遮罩是呼叫端（REST 匯出）的責任，與其他讀取路徑一致。
   * - 沒有任何未刪除記憶時回 `[]`（不拋錯）。
   */
  listMemoriesForExport(): Promise<Memory[]>;

  /** 關鍵字搜尋 chunk 文字與未刪除的記憶，回傳排名清單。 */
  searchKeyword(query: string, filter: SearchFilter, k: number): Promise<RankedHit[]>;
}
