import type { RankedHit, SearchFilter } from "./types.js";

/** 一筆要寫入向量索引的資料。 */
export interface VectorItem {
  /** `c:<chunkId>` 或 `m:<memoryId>`。 */
  key: string;
  /** 所屬 root；全域物件（例如記憶）為 null。 */
  rootId: number | null;
  /** 產生此向量的 embedder 識別（換 embedder 時用來判斷哪些要重建）。 */
  embedderId: string;
  /** 已 L2 正規化的向量，長度等於索引的 dim。 */
  vec: Float32Array;
}

/**
 * 向量索引介面（預設實作為 sqlite-vec）。
 * 職責：寫入向量、帶過濾條件的 top-k 近鄰查詢。
 * 混合排序（RRF）在應用層，不由本介面負責。
 */
export interface VectorIndex {
  /** 索引的向量維度。 */
  readonly dim: number;

  /** 寫入或覆寫（同 key 為覆寫）。 */
  upsert(items: VectorItem[]): Promise<void>;

  deleteByKeys(keys: string[]): Promise<void>;

  /** 刪除某個 root 的所有向量（rootId 為 null 的向量不受影響）。 */
  deleteByRoot(rootId: number): Promise<void>;

  /**
   * 向量近鄰查詢。
   * `filter.rootIds` 未指定時不過濾（含 rootId 為 null 的向量）；
   * 指定時只回傳這些 root 的向量，`rootId: null` 者不回傳。
   */
  searchVector(vec: Float32Array, filter: SearchFilter, k: number): Promise<RankedHit[]>;

  count(): Promise<number>;

  /**
   * 回傳輸入 `keys` 中實際存在於索引者（其餘忽略）。
   * 供 indexer 的增量判斷確認「DB 有 chunk，但向量是否齊」，缺向量時整檔重做。
   * 唯讀，不改變索引內容。
   */
  existingKeys(keys: string[]): Promise<Set<string>>;

  /** 回傳目前索引裡出現過的 embedderId 集合，用於偵測更換 embedder。 */
  embedderIds(): Promise<string[]>;
}
