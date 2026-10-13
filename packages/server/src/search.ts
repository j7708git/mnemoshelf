/**
 * 統一搜尋：關鍵字（`MetadataStore.searchKeyword`）與向量（`VectorIndex.searchVector`）
 * 兩路，依 `mode` 決定跑哪幾路，多路時以 Reciprocal Rank Fusion 合併
 * （storage-ports.md §設計規則 1；RRF 在應用層，不由後端負責）。
 *
 * 為什麼預設 `hybrid`：M0 spike 顯示向量單獨可能更好，但當時尚未以真實查詢複測。
 * **現況（M1 整體驗收後）**：`hybrid` 仍是預設，但 M1 資料顯示 `vector` 單獨表現較佳
 * （樣本小、且為 tester 自評相關性，非嚴謹評測）；M2 會複測並修訂契約，**預設值可能改變**，
 * 需要固定行為的呼叫端請明確帶 `mode`。三種模式同時暴露，就是為了讓整體驗收能用同一組查詢實測。
 *
 * 來源標註（docs/roots-and-privacy.md §Agent 存取）：每個命中都帶足以回溯的來源欄位
 * （chunk：`rootId`＋`relPath`＋`seq`；memory：`agent`）。回傳的文字一律視為不受信任資料。
 */
import {
  rrfMerge,
  RRF_DEFAULT_K,
  type ChunkKind,
  type Embedder,
  type MemoryKind,
  type MemoryScope,
  type MetadataStore,
  type RankedHit,
  type SearchFilter,
  type VectorIndex,
} from "@mnemoshelf/core";
import { ValidationError } from "./errors.js";

/** 支援的搜尋模式。 */
export const SEARCH_MODES = ["keyword", "vector", "hybrid"] as const;
export type SearchMode = (typeof SEARCH_MODES)[number];

export const DEFAULT_SEARCH_MODE: SearchMode = "hybrid";
export const DEFAULT_SEARCH_K = 10;
/** `k` 的上限（任務卡明定）。超過者會被夾到上限，不視為錯誤。 */
export const MAX_SEARCH_K = 100;
/** 命中片段回傳的最大字元數（超過即截斷並標記 `textTruncated`）。 */
export const TEXT_SNIPPET_MAX_CHARS = 500;

/** 檔案片段命中。 */
export interface ChunkSearchHit {
  type: "chunk";
  /** `c:<chunkId>`。 */
  key: string;
  /** 合併後的名次，從 1 起算、連續。 */
  rank: number;
  /** RRF 分數（`Σ 1/(60+rank)`）；單模式時等同該路徑的分數。 */
  score: number;
  rootId: number;
  /** 相對 root 的路徑（`/` 分隔）。 */
  relPath: string;
  /** 同一檔案內的順序。 */
  seq: number;
  kind: ChunkKind;
  /** 文字片段（媒體檔為 null）；長度上限 `TEXT_SNIPPET_MAX_CHARS`。 */
  text: string | null;
  textTruncated: boolean;
}

/** 記憶命中。 */
export interface MemorySearchHit {
  type: "memory";
  /** `m:<memoryId>`。 */
  key: string;
  rank: number;
  score: number;
  id: number;
  kind: MemoryKind;
  scope: MemoryScope;
  /** 記憶沒有 root：`null` 表示全域；`project`／`agent` 範圍時為所屬名稱。 */
  project: string | null;
  /** 寫入這筆記憶的 agent 標識——來源標註的一部分。 */
  agent: string;
  /** 記憶內容片段，長度上限 `TEXT_SNIPPET_MAX_CHARS`。 */
  text: string;
  textTruncated: boolean;
}

export type SearchHit = ChunkSearchHit | MemorySearchHit;

export interface UnifiedSearchDeps {
  store: MetadataStore;
  vec: VectorIndex;
  /** 向量那一路需要它把查詢字串轉成向量（與索引用同一個實例，`dim` 由建構保證一致）。 */
  embedder: Embedder;
}

export interface UnifiedSearchOptions {
  query: string;
  /** 預設 `hybrid`。 */
  mode?: SearchMode;
  /** 未指定（或空陣列以外的清單）時不過濾；指定時只搜尋這些 root（記憶因此不納入）。 */
  rootIds?: number[];
  /** 預設 10，上限 100。 */
  k?: number;
}

export interface UnifiedSearchResult {
  mode: SearchMode;
  /** 實際生效的 `k`（夾住上限後）。 */
  k: number;
  hits: SearchHit[];
}

/** 合併後的一項：名次、分數與鍵。 */
export interface FusedHit {
  key: string;
  rank: number;
  score: number;
}

/**
 * 合併多份排名清單。
 *
 * 排序以 `rrfMerge` 為準；分數在此以同一條公式重算，讓回應能帶 `score`。
 * 單模式（只有一份清單）時等同把該清單的分數標準化，三種模式的分數因此可比較。
 */
export function fuseRanked(lists: RankedHit[][], k: number = RRF_DEFAULT_K): FusedHit[] {
  const scores = new Map<string, number>();
  for (const list of lists) {
    for (const hit of list) {
      scores.set(hit.key, (scores.get(hit.key) ?? 0) + 1 / (k + hit.rank));
    }
  }
  return rrfMerge(lists, k).map((hit) => ({
    key: hit.key,
    rank: hit.rank,
    score: Number((scores.get(hit.key) ?? 0).toFixed(12)),
  }));
}

/** 依選項決定要跑哪幾路，回傳各路的排名清單（順序不影響 RRF）。 */
async function rankLists(
  deps: UnifiedSearchDeps,
  query: string,
  mode: SearchMode,
  filter: SearchFilter,
  k: number,
): Promise<RankedHit[][]> {
  const lists: RankedHit[][] = [];
  if (mode === "keyword" || mode === "hybrid") {
    lists.push(await deps.store.searchKeyword(query, filter, k));
  }
  if (mode === "vector" || mode === "hybrid") {
    const queryVector = await deps.embedder.embedQuery(query);
    lists.push(await deps.vec.searchVector(queryVector, filter, k));
  }
  return lists;
}

/** 截斷片段並回報是否截斷。 */
function snippet(text: string): { text: string; textTruncated: boolean } {
  if (text.length <= TEXT_SNIPPET_MAX_CHARS) return { text, textTruncated: false };
  return { text: text.slice(0, TEXT_SNIPPET_MAX_CHARS), textTruncated: true };
}

/** 驗證並正規化搜尋選項。 */
export function normalizeSearchOptions(options: UnifiedSearchOptions): {
  query: string;
  mode: SearchMode;
  rootIds: number[] | undefined;
  k: number;
} {
  const query = options.query;
  if (typeof query !== "string" || query.trim().length === 0) {
    throw new ValidationError("query", "必須是非空的字串");
  }

  const mode = options.mode ?? DEFAULT_SEARCH_MODE;
  if (!(SEARCH_MODES as readonly string[]).includes(mode)) {
    throw new ValidationError("mode", `必須是 ${SEARCH_MODES.join(" / ")} 之一`);
  }

  let rootIds: number[] | undefined;
  if (options.rootIds !== undefined) {
    if (!Array.isArray(options.rootIds) || options.rootIds.some((id) => !Number.isInteger(id) || id <= 0)) {
      throw new ValidationError("rootIds", "必須是正整數陣列");
    }
    if (options.rootIds.length === 0) {
      throw new ValidationError("rootIds", "若提供則不得為空陣列（空陣列語意不明，請省略）");
    }
    rootIds = [...options.rootIds];
  }

  const requested = options.k ?? DEFAULT_SEARCH_K;
  if (!Number.isInteger(requested) || requested <= 0) {
    throw new ValidationError("k", "必須是正整數");
  }

  return { query, mode, rootIds, k: Math.min(requested, MAX_SEARCH_K) };
}

/**
 * 統一搜尋。回傳的命中都帶來源欄位（見檔頭）。
 *
 * 註：記憶目前只進關鍵字那一路（`remember` 不嵌入內容），因此 `vector` 模式不會有記憶命中；
 * `rootIds` 有指定時記憶一律不納入（storage-ports.md 對 `searchKeyword` 的既有規則）。
 */
export async function unifiedSearch(
  deps: UnifiedSearchDeps,
  options: UnifiedSearchOptions,
): Promise<UnifiedSearchResult> {
  const { query, mode, rootIds, k } = normalizeSearchOptions(options);
  const filter: SearchFilter = rootIds === undefined ? {} : { rootIds };

  const lists = await rankLists(deps, query, mode, filter, k);
  const fused = fuseRanked(lists).slice(0, k);

  const chunkIds: number[] = [];
  const chunkRanks = new Map<number, FusedHit>();
  const memoryIds: number[] = [];
  const memoryRanks = new Map<number, FusedHit>();

  for (const hit of fused) {
    const [prefix, rawId] = [hit.key.slice(0, 2), Number(hit.key.slice(2))];
    if (!Number.isInteger(rawId)) continue;
    if (prefix === "c:") {
      chunkIds.push(rawId);
      chunkRanks.set(rawId, hit);
    } else if (prefix === "m:") {
      memoryIds.push(rawId);
      memoryRanks.set(rawId, hit);
    }
  }

  const hits: SearchHit[] = [];

  if (chunkIds.length > 0) {
    // getChunks 依傳入 ids 的順序回傳（缺漏者略過），因此這裡另外用 fused 的名次排序。
    const chunks = await deps.store.getChunks(chunkIds);
    for (const chunk of chunks) {
      const fusedHit = chunkRanks.get(chunk.id);
      if (fusedHit === undefined) continue;
      const text = chunk.text === null ? null : snippet(chunk.text);
      hits.push({
        type: "chunk",
        key: fusedHit.key,
        rank: fusedHit.rank,
        score: fusedHit.score,
        rootId: chunk.rootId,
        relPath: chunk.relPath,
        seq: chunk.seq,
        kind: chunk.kind,
        text: text === null ? null : text.text,
        textTruncated: text === null ? false : text.textTruncated,
      });
    }
  }

  for (const memoryId of memoryIds) {
    const memory = await deps.store.getMemory(memoryId);
    if (memory === null || memory.deletedAt !== null) continue;
    const fusedHit = memoryRanks.get(memoryId);
    if (fusedHit === undefined) continue;
    const text = snippet(memory.content);
    hits.push({
      type: "memory",
      key: fusedHit.key,
      rank: fusedHit.rank,
      score: fusedHit.score,
      id: memory.id,
      kind: memory.kind,
      scope: memory.scope,
      project: memory.project,
      agent: memory.agent,
      text: text.text,
      textTruncated: text.textTruncated,
    });
  }

  // 名次依 fused 的順序（chunk 與記憶交錯），且重新編號成連續的 1..n。
  hits.sort((a, b) => a.rank - b.rank);
  return { mode, k, hits: hits.map((hit, index) => ({ ...hit, rank: index + 1 })) };
}
