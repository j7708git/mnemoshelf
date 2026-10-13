/**
 * 共用型別（storage-ports.md 的兩個窄介面所共用的實體與值物件）。
 * 欄位名稱是契約：不得刪減或改名。
 */

/** root 的模式：只瀏覽（不建索引）或瀏覽並建立語意索引。 */
export type RootMode = "browse" | "index";

/** 可索引的模態。 */
export type Modality = "text" | "code" | "image" | "audio" | "video";

/** chunk 的類型（與 Modality 同一組值）。 */
export type ChunkKind = Modality;

/** 已加入的 root（資料夾）。`path` 是解析過的真實路徑（realpath）。 */
export interface Root {
  id: number;
  /** realpath 後的絕對路徑。 */
  path: string;
  mode: RootMode;
  modalities: Modality[];
  include: string[];
  exclude: string[];
  respectGitignore: boolean;
  watch: boolean;
  /** ISO 8601 時間字串。 */
  createdAt: string;
}

/** 新增 root 時的輸入（id 與 createdAt 由儲存層產生）。 */
export type NewRoot = Omit<Root, "id" | "createdAt">;

/** 檔案切塊後的內容單位。 */
export interface Chunk {
  id: number;
  rootId: number;
  /** 相對 root 的路徑。 */
  relPath: string;
  /** 同一檔案內的順序。 */
  seq: number;
  kind: ChunkKind;
  /** 非文字模態（例如圖片）為 null。 */
  text: string | null;
  contentHash: string;
}

/** 新增 chunk 時的輸入（id 由儲存層產生）。 */
export type NewChunk = Omit<Chunk, "id">;

/** 記憶的種類。 */
export type MemoryKind = "fact" | "decision" | "pitfall" | "preference";

/** 記憶的作用範圍。 */
export type MemoryScope = "global" | "project" | "agent";

/** 一筆共享記憶。 */
export interface Memory {
  id: number;
  content: string;
  kind: MemoryKind;
  scope: MemoryScope;
  project: string | null;
  agent: string;
  /** 取代了哪一筆記憶（有的話，被取代者會被軟刪除）。 */
  supersedes: number | null;
  /** ISO 8601 時間字串。 */
  createdAt: string;
  /** ISO 8601 時間字串；未刪除時為 null。 */
  deletedAt: string | null;
}

/** 新增記憶時的輸入（id／createdAt／deletedAt 由儲存層產生）。 */
export type NewMemory = Omit<Memory, "id" | "createdAt" | "deletedAt">;

/** 查詢過濾條件。未指定 rootIds 表示不過濾。 */
export interface SearchFilter {
  rootIds?: number[];
}

/** 排名結果的一項。key 為 `c:<chunkId>` 或 `m:<memoryId>`；rank 從 1 起算。 */
export interface RankedHit {
  key: string;
  rank: number;
}
