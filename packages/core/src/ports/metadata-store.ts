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
  getMemory(id: number): Promise<Memory | null>;
  /** 軟刪除。 */
  forgetMemory(id: number): Promise<void>;

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
   * 列舉**未刪除**的記憶（軟刪除者與被取代者不會出現）。
   *
   * - 排序：`createdAt` 由新到舊；同一時間戳（同毫秒）以 `id` 由大到小決定，確保可重現。
   * - `filter` 全部可選，未指定＝不過濾；各欄位為精確比對（見 `MemoryFilter`）。
   * - `filter.limit` 的邊界語意見 `normalizeMemoryLimit`（預設 100、上限 500、<= 0 回傳空清單）。
   */
  listMemories(filter?: MemoryFilter): Promise<Memory[]>;

  /** 關鍵字搜尋 chunk 文字與未刪除的記憶，回傳排名清單。 */
  searchKeyword(query: string, filter: SearchFilter, k: number): Promise<RankedHit[]>;
}
