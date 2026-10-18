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

/**
 * 更新既有 root 時**可變更**的欄位（`MetadataStore.updateRoot`）。
 *
 * 為什麼只有 `modalities`：`path`／`mode` 改變等同換一個 root（索引內容、清理語意都會變），
 * 應以「移除再加入」處理；`include`／`exclude`／`respectGitignore` 目前沒有 UI／REST 入口，
 * 尚未定義變更語意。欄位未提供（`undefined`）＝該欄位不變。
 *
 * 變更模態**不會**動任何既有 chunk／向量：要重新索引才會生效（見 `indexRoot` 的清理語意）。
 */
export interface RootPatch {
  modalities?: Modality[];
}

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

/**
 * 記憶向量的狀態機（卡 B1；存在 `memories.embedding_state`，**不是** `Memory` 的公開欄位）。
 *
 * - `pending`：待嵌入（新資料與既有資料的預設）；
 * - `ready`：向量已產生且可信（還要 `embedding_embedder_id` 與查詢的 embedder 相符）；
 * - `failed`：嵌入失敗，可重試（回填流程會再試）；
 * - `too-long`：超過 embedder 的單筆輸入上限，**永久跳過**（重試也不會成功）。
 */
export type MemoryEmbeddingState = "pending" | "ready" | "failed" | "too-long";

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
  /**
   * 是否釘選（M3 擴充）。
   *
   * 由 `MetadataStore.setMemoryPinned` 設定；既有資料與新增的記憶一律預設 `false`。
   * 這是管理面的標記，**不影響**搜尋排名或 `listMemories` 的排序（UI 自行把釘選者排前面）。
   */
  pinned: boolean;
  /** ISO 8601 時間字串。 */
  createdAt: string;
  /** ISO 8601 時間字串；未刪除時為 null。 */
  deletedAt: string | null;
}

/**
 * 新增記憶時的輸入（id／createdAt／deletedAt 由儲存層產生）。
 *
 * `pinned` 刻意**不在**輸入內：新增的記憶一律 `false`，要釘選請用
 * `MetadataStore.setMemoryPinned`（見 `Memory.pinned`）。
 */
export type NewMemory = Omit<Memory, "id" | "createdAt" | "deletedAt" | "pinned">;

/**
 * 更新既有記憶時**可變更**的欄位（`MetadataStore.updateMemory`）。
 *
 * 為什麼只有這兩個：內容的變更一律走 supersede（建立新版本、舊版軟刪除），避免無痕改寫歷史；
 * `kind`／`agent`／`supersedes`／`pinned`／`createdAt`／`deletedAt` 都是不可變欄位。
 * 欄位未提供（`undefined`）＝該欄位不變；兩個都沒提供＝非法 patch（儲存層拋錯）。
 *
 * 有效結果的正規化（見 `normalizeMemoryPatch`）：
 * - `scope === "project"` → `project` 必須是非空字串（trim 後），否則拋錯；
 * - `scope !== "project"` → `project` 一律為 `null`（明確帶非 null 的 `project` 為非法 patch）。
 */
export interface MemoryPatch {
  scope?: MemoryScope;
  project?: string | null;
}

/** 查詢過濾條件。未指定 rootIds 表示不過濾。 */
export interface SearchFilter {
  rootIds?: number[];
}

/** 排名結果的一項。key 為 `c:<chunkId>` 或 `m:<memoryId>`；rank 從 1 起算。 */
export interface RankedHit {
  key: string;
  rank: number;
}
