import type {
  Chunk,
  Memory,
  NewChunk,
  NewMemory,
  NewRoot,
  RankedHit,
  Root,
  SearchFilter,
} from "./types.js";

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

  /** 關鍵字搜尋 chunk 文字與未刪除的記憶，回傳排名清單。 */
  searchKeyword(query: string, filter: SearchFilter, k: number): Promise<RankedHit[]>;
}
