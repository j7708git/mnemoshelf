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
  /**
   * 是否允許 agent 搜尋這個 root 的檔案片段（MCP `search` 等入口的預設範圍）。
   *
   * - 資料庫欄位 `allow_agent_search`：not null default 0；既有 roots 升級後一律 `false`。
   * - 這是**分享意圖／防誤用**，不是安全邊界：持有同一組 token 的程式仍是本機 owner 全權
   *   （見 `docs/roots-and-privacy.md` §信任模型）。
   */
  allowAgentSearch: boolean;
  /**
   * 通用單檔大小上限（bytes；**不套用影片**）。**選填**，未設定時由呼叫端沿用服務層預設
   * （10 MiB）。
   *
   * - 值域是整數 1–16 GiB（由 `normalizeRootMaxFileBytes` 驗證）。
   * - 舊資料列為 NULL 時**不出現**這個鍵（不得補 10 MiB：預設值屬呼叫端語意）。
   */
  maxFileBytes?: number;
  /**
   * 影片單檔大小上限（bytes）；**選填**，未設定時由呼叫端沿用行程層預設
   * （`MNEMOSHELF_VIDEO_MAX_FILE_BYTES`，再退回 512 MiB）。
   *
   * - 只套用影片（`video` 模態）；通用 `maxFileBytes` 的 10 MiB 不套用影片。
   * - 值域是整數 1–16 GiB（由 `normalizeRootVideoMaxFileBytes` 驗證）。
   * - 舊資料列為 NULL 時**不出現**這個鍵（不得補 512 MiB：預設值屬呼叫端語意）。
   */
  videoMaxFileBytes?: number;
}

/** 新增 root 時的輸入（id 與 createdAt 由儲存層產生）。 */
export type NewRoot = Omit<Root, "id" | "createdAt" | "allowAgentSearch"> & {
  /**
   * 是否允許 agent 搜尋；**選填**，省略＝`false`（DB 欄位 default 0）。
   *
   * 讓既有呼叫端不必為新增欄位全面改寫；新入口（REST）仍會明帶使用者的選擇。
   */
  allowAgentSearch?: boolean;
};

/**
 * 更新既有 root 時**可變更**的欄位（`MetadataStore.updateRoot`）。
 *
 * 為什麼只有 `modalities`、`allowAgentSearch`、`maxFileBytes` 與 `videoMaxFileBytes`：
 * `path`／`mode` 改變等同換一個 root（索引內容、清理語意都會變），應以「移除再加入」處理；
 * `include`／`exclude`／`respectGitignore` 目前沒有 UI／REST 入口，尚未定義變更語意。
 * 欄位未提供（`undefined`）＝該欄位不變。
 *
 * - 變更模態**不會**動任何既有 chunk／向量：要重新索引才會生效（見 `indexRoot` 的清理語意）。
 * - `allowAgentSearch`：`true`／`false`＝設定分享意圖；只影響之後的 agent 搜尋範圍，
 *   不動既有索引，也不需要重新索引。
 * - `maxFileBytes`：`number`＝設定新上限；`null`＝清除設定（回到服務層預設 10 MiB）；
 *   `undefined`＝不改。變更只影響下一次 preview／index，不動既有索引。
 * - `videoMaxFileBytes`：`number`＝設定新上限；`null`＝清除設定（回到行程層預設）；
 *   `undefined`＝不改。變更只影響下一次 preview／index 與播放端點，不動既有索引。
 */
export interface RootPatch {
  modalities?: Modality[];
  /** 是否允許 agent 搜尋這個 root（分享意圖；不是安全邊界）。 */
  allowAgentSearch?: boolean;
  /** 通用單檔大小上限（bytes）；`null` 表示清除設定。值域見 `normalizeRootMaxFileBytes`。 */
  maxFileBytes?: number | null;
  /** 影片單檔大小上限（bytes）；`null` 表示清除設定。值域見 `normalizeRootVideoMaxFileBytes`。 */
  videoMaxFileBytes?: number | null;
}

/** 時間片段的來源軌道（`ChunkMedia.track`）。 */
export type ChunkMediaTrack = "audio" | "video" | "video-audio";

/**
 * 媒體片段可記錄的來源容器（v1 白名單）。
 *
 * `wav` 是既有音訊片段；`mp4` 是影片 v1 唯一支援的容器（見影片里程碑）。
 * 舊資料沒有這個欄位，讀取端不得補值。
 */
export type ChunkMediaContainer = "wav" | "mp4";

/**
 * 媒體片段的來源位置與可重現的嵌入身分；時間單位為秒。
 *
 * 這是 additive 擴充：音訊里程碑的舊資料只有 `startSeconds`／`endSeconds`／`track:"audio"`
 * 與三個嵌入身分欄位，因此新增欄位一律**選填**（舊列不得被補 `null` 或空陣列）。
 * 欄位語意、合法範圍與 `seq` 規則見 `docs/storage-ports.md`。
 */
export interface ChunkMedia {
  startSeconds: number;
  endSeconds: number;
  /**
   * 來源軌道：
   * - `video`：影片**畫面**片段（`kind:"video"`），保留 `frameTimesSeconds`；
   * - `video-audio`：影片**所選音軌**片段（`kind:"audio"`），保留 `streamIndex`；
   * - `audio`：舊資料與獨立 WAV 音訊片段。
   */
  track: ChunkMediaTrack;
  /** 來源容器；舊資料省略。 */
  container?: ChunkMediaContainer;
  /** 來源 stream index（影片所選音軌**必填**；畫面片段可省略）。 */
  streamIndex?: number;
  /** 畫面片段實際採用的幀時間（秒；`track:"video"` 必填，落在片段區間內）。 */
  frameTimesSeconds?: number[];
  preprocessVersion: string;
  embedderId: string;
  embeddingDim: number;
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
  /** 時間型片段（音訊／影片）才提供；既有文字／圖片與舊資料省略此欄。 */
  media?: ChunkMedia;
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
  /**
   * 寫入這筆記憶的 session 識別（來源；D4a 擴充）。
   *
   * 由寫入端自行提供的不透明字串（例如自動寫入者的 session id），**不是**安全邊界，
   * 也不參與去重 key。未提供或舊資料一律 `null`（不是空字串）；寫入後不可變更
   * （`MemoryPatch` 不含此欄位）。
   */
  sourceSession: string | null;
  /** 寫入這筆記憶的訊息識別（來源；D4a 擴充）。未提供或舊資料一律 `null`；不可變更。 */
  sourceMessage: string | null;
  /** 原文來源與保存文字的 UTF-16 位置。舊記憶的欄位為 null。 */
  sourceId?: number | null;
  messageIndex?: number | null;
  chunkIndex?: number | null;
  sourceStart?: number | null;
  sourceEnd?: number | null;
  chunkVersion?: string | null;
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
 *
 * `sourceSession`／`sourceMessage` 是**選填**（未提供或 `null` → 儲存為 `null`）：
 * 這樣既有的呼叫端不必改，也讓舊資料與新資料共用同一個型別（D4a 是 additive 擴充）。
 */
export type NewMemory = Omit<
  Memory,
  "id" | "createdAt" | "deletedAt" | "pinned" | "sourceSession" | "sourceMessage" |
    "sourceId" | "messageIndex" | "chunkIndex" | "sourceStart" | "sourceEnd" | "chunkVersion"
> & {
  sourceSession?: string | null;
  sourceMessage?: string | null;
};

/**
 * 更新既有記憶時**可變更**的欄位（`MetadataStore.updateMemory`）。
 *
 * 為什麼只有這兩個：內容的變更一律走 supersede（建立新版本、舊版軟刪除），避免無痕改寫歷史；
 * `kind`／`agent`／`supersedes`／`pinned`／`sourceSession`／`sourceMessage`／`createdAt`／
 * `deletedAt` 都是不可變欄位。
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
  /**
   * 是否納入記憶（只有 `searchKeyword` 會回記憶；向量索引本身不含記憶）。
   *
   * - `undefined`（預設）：依既有規則——未指定 `rootIds` 時納入；指定了 `rootIds`
   *   （含空陣列）時**不納入**（記憶沒有 root）。
   * - `true`：即使指定了 `rootIds` 也納入記憶；chunk 仍只搜指定（或空）roots。
   *   給「只縮小檔案搜尋範圍、不影響記憶」的呼叫端使用（例如 `/search` 的 `agentOnly`）。
   * - `false`：一律不納入記憶。
   */
  includeMemories?: boolean;
}

/** 排名結果的一項。key 為 `c:<chunkId>` 或 `m:<memoryId>`；rank 從 1 起算。 */
export interface RankedHit {
  key: string;
  rank: number;
}
