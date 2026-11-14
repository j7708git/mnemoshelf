import { buildMemorySearchBuckets, type MemoryRecallInput } from "./memory-search.js";
import { isMemoryVisible, MemoryPolicyChangedError } from "./memory-source.js";
import { organizationOf } from "./memory-organization.js";
/**
 * 統一搜尋：關鍵字（`MetadataStore.searchKeyword`）與向量（`VectorIndex.searchVector`）
 * 兩路，依 `mode` 決定跑哪幾路，多路時以 Reciprocal Rank Fusion 合併
 * （storage-ports.md §設計規則 1；RRF 在應用層，不由後端負責）。
 *
 * 為什麼預設 `vector`（M2 契約修訂，2026-10-14）：M0 spike 顯示向量單獨可能更好；M1 整體驗收以
 * 8 個自然語句查詢複測，三模式 Top-1 相關次數為 **vector 8/8 ＞ hybrid 7/8 ＞ keyword 5/8**，
 * 且有反例（中文查詢找圖時，`hybrid` 的 keyword 路壓過 vector 路的正確命中）。因此預設由 `hybrid`
 * 改為 `vector`；`hybrid`（RRF）與 `keyword` **保留為選用**，需要時明確帶 `mode`。
 * 樣本小、且為 tester 自評相關性，非嚴謹評測（見 docs/storage-ports.md §搜尋模式與預設）。
 *
 * 來源標註（docs/roots-and-privacy.md §Agent 存取）：每個命中都帶足以回溯的來源欄位
 * （chunk：`rootId`＋`relPath`＋`seq`；memory：`agent`）。回傳的文字一律視為不受信任資料。
 */
import {
  rrfMerge,
  RRF_DEFAULT_K,
  type ChunkKind,
  type ChunkMedia,
  type Embedder,
  type MemoryKind,
  type Memory,
  type MemorySourceMessage,
  type MemoryScope,
  type MetadataStore,
  type RankedHit,
  type SearchFilter,
  type VectorIndex,
} from "@mnemoshelf/core";
import { ValidationError } from "./errors.js";
import { createMemoryPresenter, loadCurrentMemoryPresentations, type PrepareMemoryPresentation } from "./memory-policy.js";

/** 支援的搜尋模式。 */
export const SEARCH_MODES = ["keyword", "vector", "hybrid"] as const;
export type SearchMode = (typeof SEARCH_MODES)[number];

export const DEFAULT_SEARCH_MODE: SearchMode = "vector";
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
  /** 音訊片段的來源時間與產生版本；舊 chunk 省略。 */
  media?: ChunkMedia;
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
  sourceType: "raw-turn" | "legacy-memory";
  sourceId?: number | null;
  messageIndex?: number | null;
  chunkIndex?: number | null;
  sourceStart?: number | null;
  sourceEnd?: number | null;
  chunkVersion?: string | null;
  role?: MemorySourceMessage["role"];
  occurredAt?: string | null;
  sourceTurn?: string;
  sourceSession?: string | null;
  sourceMessage?: string | null;
  hasMore?: true;
  snippetStart?: number;
  snippetEnd?: number;
  snippetAnchor?: number;
  untrusted: true;
}

export type SearchHit = ChunkSearchHit | MemorySearchHit;

export interface UnifiedSearchDeps {
  store: MetadataStore;
  vec: VectorIndex;
  /** 向量那一路需要它把查詢字串轉成向量（與索引用同一個實例，`dim` 由建構保證一致）。 */
  embedder: Embedder;
}

export interface UnifiedSearchOptions {
  memoryContext?: Omit<MemoryRecallInput, "query">;
  query: string;
  /** 預設 `vector`（M2 起）；`hybrid`（RRF）與 `keyword` 為選用。 */
  mode?: SearchMode;
  /** 未指定（或空陣列以外的清單）時不過濾；指定時只搜尋這些 root（記憶因此不納入）。 */
  rootIds?: number[];
  /**
   * 只搜尋「允許 agent 搜尋」的 roots（`Root.allowAgentSearch === true`）。
   *
   * - Web UI 預設 `false`（搜全部）；MCP `search` 預設 `true`。
   * - 與 `rootIds` 同時給＝**取交集**（agentOnly 是更嚴格的一層）。
   * - **只過濾 roots／檔案 chunks，不影響 memories**：使用者沒有指定 `rootIds` 時，記憶仍照
   *   keyword／hybrid 的既有規則納入；有指定 `rootIds` 時維持「記憶不納入」的既有語意。
   */
  agentOnly?: boolean;
  /** 預設 10，上限 100。 */
  k?: number;
}

export interface UnifiedSearchResult {
  mode: SearchMode;
  /** 實際生效的 `k`（夾住上限後）。 */
  k: number;
  hits: SearchHit[];
  policyVersion: number;
  recallVersion: number;
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
  agentOnly: boolean;
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

  // 只有 undefined（未提供）才套預設 false；null／字串等一律視為非法（不靜默當成 false）。
  const agentOnly = options.agentOnly === undefined ? false : options.agentOnly;
  if (typeof agentOnly !== "boolean") {
    throw new ValidationError("agentOnly", "必須是布林值");
  }

  const requested = options.k ?? DEFAULT_SEARCH_K;
  if (!Number.isInteger(requested) || requested <= 0) {
    throw new ValidationError("k", "必須是正整數");
  }

  return { query, mode, rootIds, agentOnly, k: Math.min(requested, MAX_SEARCH_K) };
}

/**
 * `agentOnly` 的有效 root 清單：只留 `allowAgentSearch === true` 的 roots。
 *
 * - 未帶 `rootIds`：回全部已勾選分享的 root id；沒有勾選時是**空陣列**（＝沒有可見 root，
 *   與 `SearchFilter.rootIds` 的空陣列語意一致）。
 * - 有帶 `rootIds`：取交集（agentOnly 是更嚴格的一層）。
 */
async function agentOnlyRootIds(store: MetadataStore, rootIds: number[] | undefined): Promise<number[]> {
  const shared = (await store.listRoots()).filter((root) => root.allowAgentSearch).map((root) => root.id);
  if (rootIds === undefined) return shared;
  const sharedSet = new Set(shared);
  return rootIds.filter((id) => sharedSet.has(id));
}

/**
 * 統一搜尋。回傳的命中都帶來源欄位（見檔頭）。
 *
 * 註：記憶目前只進關鍵字那一路（`remember` 不嵌入內容），因此 `vector` 模式（含預設）不會有記憶命中；
 * 需要搜尋記憶時明確帶 `mode: "keyword"` 或 `"hybrid"`。`rootIds` 有指定時記憶一律不納入
 * （storage-ports.md 對 `searchKeyword` 的既有規則）。
 */
export async function prepareUnifiedSearch(
  deps: UnifiedSearchDeps,
  options: UnifiedSearchOptions,
): Promise<PrepareMemoryPresentation<UnifiedSearchResult>> {
  const { query, mode, rootIds, agentOnly, k } = normalizeSearchOptions(options);
  const recallVersion = (await deps.store.getMemoryRecallSettings()).dataRevision;
  const memoryContext = options.memoryContext ?? (agentOnly ? { scope: "global" as const } : undefined);
  const memoryBuckets = memoryContext === undefined ? undefined : buildMemorySearchBuckets(memoryContext);
  // agentOnly 與 rootIds 在同一層過濾：agentOnly 先縮成「已勾選分享」的清單，再與 rootIds 取交集。
  // 沒有勾選任何 root 時得到空陣列——`SearchFilter.rootIds: []` 的既有語意是「沒有可見 root」，
  // chunk 路徑自然回空；記憶在 rootIds 有指定時本來就不納入（見檔頭與 storage-ports.md）。
  const effectiveRootIds = agentOnly ? await agentOnlyRootIds(deps.store, rootIds) : rootIds;
  const filter: SearchFilter = effectiveRootIds === undefined ? {} : { rootIds: effectiveRootIds };
  filter.memoryFilter = { ...(memoryBuckets === undefined ? {} : { buckets: memoryBuckets }), ...(memoryContext?.writer === undefined ? {} : { writer: memoryContext.writer }) };
  // agentOnly 只縮小「檔案」範圍，不影響記憶：使用者沒有指定 rootIds 時仍納入記憶。
  // （有指定 rootIds 時維持既有規則：記憶不納入。）
  if (agentOnly && rootIds === undefined) filter.includeMemories = true;

  const candidateLimit =
    mode === "keyword" && effectiveRootIds === undefined ? Math.min(k * 4, 500) : k;
  const lists = await rankLists(deps, query, mode, filter, candidateLimit);
  const fused = fuseRanked(lists);
  const chunkRanks = new Map<number, FusedHit>();
  const memoryRanks = new Map<number, FusedHit>();
  const memories: Memory[] = [];
  const sourceCounts = new Map<number, number>();

  for (const hit of fused) {
    if (chunkRanks.size + memories.length >= k) break;
    const id = Number(hit.key.slice(2));
    if (!Number.isInteger(id)) continue;
    if (hit.key.startsWith("c:")) {
      chunkRanks.set(id, hit);
    } else if (hit.key.startsWith("m:")) {
      const memory = await deps.store.getMemory(id);
      if (memory === null || memory.deletedAt !== null) continue;
      if (memory.sourceId != null) {
        const count = sourceCounts.get(memory.sourceId) ?? 0;
        if (count >= 2) continue;
        sourceCounts.set(memory.sourceId, count + 1);
      }
      memories.push(memory);
      memoryRanks.set(id, hit);
    }
  }

  const hits: SearchHit[] = [];
  if (chunkRanks.size > 0) {
    const chunks = await deps.store.getChunks([...chunkRanks.keys()]);
    for (const chunk of chunks) {
      const fusedHit = chunkRanks.get(chunk.id)!;
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
        ...(chunk.media === undefined ? {} : { media: chunk.media }),
        text: text === null ? null : text.text,
        textTruncated: text === null ? false : text.textTruncated,
      });
    }
  }

  return async () => {
    if ((await deps.store.getMemoryRecallSettings()).dataRevision !== recallVersion) throw new MemoryPolicyChangedError();
    const presentations = await loadCurrentMemoryPresentations(deps.store, [...memoryRanks.keys()]);
    if ((await deps.store.getMemoryRecallSettings()).dataRevision !== recallVersion) throw new MemoryPolicyChangedError();
    return (policy) => {
      const rendered = [...hits];
      const present = createMemoryPresenter(policy);
      for (const entry of presentations) {
        if (entry.memory.recallPolicy === "disabled" || (memoryBuckets !== undefined && !isMemoryVisible(entry.memory, memoryBuckets))) continue;
        const memory = present(entry, { query, maxChars: TEXT_SNIPPET_MAX_CHARS });
        if (memory === null) continue;
        const hit = memoryRanks.get(memory.id)!;
        const text = memory.sourceType === "raw-turn"
          ? { text: memory.content, textTruncated: memory.truncated }
          : snippet(memory.content);
        rendered.push({
          ...organizationOf(memory),
          type: "memory",
          key: hit.key,
          rank: hit.rank,
          score: hit.score,
          id: memory.id,
          kind: memory.kind,
          scope: memory.scope,
          project: memory.project,
          agent: memory.agent,
          sourceSession: memory.sourceSession,
          sourceMessage: memory.sourceMessage,
          sourceType: memory.sourceType,
          ...(memory.sourceType === "raw-turn" && {
            sourceId: memory.sourceId,
            messageIndex: memory.messageIndex,
            chunkIndex: memory.chunkIndex,
            sourceStart: memory.sourceStart,
            sourceEnd: memory.sourceEnd,
            chunkVersion: memory.chunkVersion,
            role: memory.role,
            occurredAt: memory.occurredAt,
            sourceTurn: memory.sourceTurn,
            hasMore: memory.hasMore,
            snippetStart: memory.snippetStart,
            snippetEnd: memory.snippetEnd,
            snippetAnchor: memory.snippetAnchor,
          }),
          untrusted: true,
          ...text,
        });
      }

      rendered.sort((a, b) => a.rank - b.rank);
      return { mode, k, hits: rendered.map((hit, index) => ({ ...hit, rank: index + 1 })), policyVersion: policy.version, recallVersion };
    };
  };
}

export async function unifiedSearch(
  deps: UnifiedSearchDeps,
  options: UnifiedSearchOptions,
): Promise<UnifiedSearchResult> {
  const prepare = await prepareUnifiedSearch(deps, options);
  const render = await prepare();
  return render(await deps.store.getMemoryPolicy());
}
