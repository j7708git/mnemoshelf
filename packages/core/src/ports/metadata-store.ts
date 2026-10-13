import type {
  Chunk,
  Memory,
  MemoryKind,
  MemoryScope,
  NewChunk,
  NewMemory,
  NewRoot,
  RankedHit,
  Root,
  SearchFilter,
} from "./types.js";

/** `listMemories` 未指定 `limit` 時的預設筆數。 */
export const MEMORY_LIST_DEFAULT_LIMIT = 100;
/** `listMemories` 的 `limit` 上限（超過者夾到此值）。 */
export const MEMORY_LIST_MAX_LIMIT = 500;

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

  /** 新增記憶；`supersedes` 有值時把被取代者標記 `deletedAt`。 */
  addMemory(m: NewMemory): Promise<Memory>;
  getMemory(id: number): Promise<Memory | null>;
  /** 軟刪除。 */
  forgetMemory(id: number): Promise<void>;

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
