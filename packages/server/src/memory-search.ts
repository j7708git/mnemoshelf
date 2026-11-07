/**
 * 記憶語意召回（卡 B2）：`POST /memories/search` 與 MCP `search_memories` 共用的核心流程。
 *
 * 設計（docs/storage-ports.md §記憶檢索）：
 * - **先過濾再排名**：可見範圍（scope／project／agent）與 kind 組成 `MemorySearchFilter`，
 *   由 store 在 SQL 先套用；語意路徑用 `searchMemoriesByVector`（精確 cosine），
 *   關鍵字路徑用 `searchMemoriesKeyword`（FTS）。兩者都不混入檔案 chunk、不改 `/search`。
 * - **專案優先**：預設 bucket＝本專案＋global（＋呼叫端明確提供的 agent）；
 *   `includeAllProjects` 時跨所有專案。**明確指定 `scope` 時只回該 scope**（見
 *   `buildMemorySearchBuckets`）；只有未指定 scope 的預設路徑才包含自己的 agent。
 * - **語意為主**：語意結果依 cosine 排序；只有不足 `k` 時才用關鍵字結果**補足**（dedupe、不重排）。
 *   語意不可用（沒有**可用**的就緒向量／embedder 查詢失敗）→ 全部退回關鍵字，回應標 `degraded`。
 * - 原文可在同一路徑以一筆不同訊息補位，保留其餘命中的相對順序及原始分數。
 * - `minScore` 只過濾語意結果（0..1）；`k` 由呼叫端驗證（REST 上限 100）。
 *
 * 這個模組不碰 HTTP、也不碰資料庫抽象以外的東西；REST 與 MCP 都只做參數驗證／轉發。
 */
import type {
  Embedder,
  Memory,
  MemoryEmbeddingStats,
  MemoryKind,
  MemoryScope,
  MemorySearchBucket,
  MemorySearchFilter,
  MetadataStore,
} from "@mnemoshelf/core";
import { ValidationError } from "./errors.js";
import {
  createMemoryPresenter,
  loadCurrentMemoryPresentations,
  memoryContentView,
  type MemoryView,
  type PrepareMemoryPresentation,
} from "./memory-policy.js";
import { isMemoryVisible } from "./memory-source.js";

/** 未指定 `k` 時的預設回傳筆數。 */
export const MEMORY_SEARCH_DEFAULT_K = 10;
/** REST／MCP 介面的 `k` 上限（store 層另有 `MEMORY_SEARCH_MAX_K`＝500）。 */
export const MEMORY_SEARCH_MAX_K = 100;

/** 語意不可用時的原因（回應的 `degradedReason`）。 */
export type MemoryRecallDegradedReason = "no-embeddings" | "embedder-unavailable";

/** 命中來源：語意或關鍵字（降級／補足）。 */
export type MemoryRecallSource = "semantic" | "keyword";

/** 一筆召回結果：完整記憶欄位（與 `GET /memories` 一致）＋排名、分數與來源。 */
export type MemoryRecallHit = MemoryView & {
  /** 從 1 起算的結果順序。 */
  rank: number;
  /**
   * 語意結果＝cosine similarity（[-1,1]）；關鍵字結果＝`1/rank`（僅供排序比較的代理分數，
   * 不是 FTS 的原始 bm25／ts_rank）。
   */
  score: number;
  source: MemoryRecallSource;
  /** 記憶內容一律視為不受信任資料（agent 僅是來源標記，不是身分驗證）。 */
  untrusted: true;
};

/** `POST /memories/search`／`search_memories` 的輸入（形狀驗證由 REST 負責）。 */
export interface MemoryRecallInput {
  query: string;
  /** 專案名稱（trim 後非空才有效）。 */
  project?: string;
  /** true＝跨所有專案（忽略 `project`）。 */
  includeAllProjects?: boolean;
  /** 明確指定的範圍（有值時優先於預設 bucket 規則）。 */
  scope?: MemoryScope;
  /** 只有明確提供時才納入 agent scope（MCP 一律帶 client 名稱）。 */
  agent?: string;
  kind?: MemoryKind;
  /** 回傳筆數（呼叫端已驗證；未提供用 `MEMORY_SEARCH_DEFAULT_K`）。 */
  k?: number;
  /** 只過濾語意結果，0..1（呼叫端已驗證）。 */
  minScore?: number;
}

/** 召回結果（REST 回應主體；MCP 原樣轉發）。 */
export interface MemoryRecallResponseBody {
  query: string;
  k: number;
  policyVersion: number;
  degraded: boolean;
  degradedReason: MemoryRecallDegradedReason | null;
  /** 記憶語意化統計（與 `GET /diagnostics` 的 `memories` 相同來源）。 */
  memoryEmbedding: MemoryEmbeddingStats;
  hits: MemoryRecallHit[];
}

/** 執行召回所需的依賴。 */
export interface MemorySearchDeps {
  store: MetadataStore;
  embedder: Embedder;
}

/**
 * 依 REST／MCP 的規則組出可見 bucket（卡 B2 §4）。
 *
 * 未指定 `scope`：
 * - `includeAllProjects=true` → global ＋ 所有專案 ＋（有 agent 時）agent；
 * - 否則必須有 `project` → global ＋ 該專案 ＋（有 agent 時）agent；
 * - 兩者都沒有 → `ValidationError`（不明確的召回範圍，REST 回 400）。
 *
 * 明確指定 `scope` 時**只回該 scope**（不含其他 scope，也不含自己的 agent）：
 * - `global` → 只 global（agent／project 忽略）；
 * - `agent` → 只 agent，必須有 `agent`；
 * - `project` → 只 project：有 `project` 用該專案；否則需 `includeAllProjects=true`（所有專案），
 *   兩者皆無 → `ValidationError`。若同時給了 `project` 與 `includeAllProjects=true`，
 *   **`project` 優先**（`includeAllProjects` 被忽略；卡 B2 驗收 O3 明訂）。
 */
export function buildMemorySearchBuckets(
  input: Pick<MemoryRecallInput, "project" | "includeAllProjects" | "scope" | "agent">,
): MemorySearchBucket[] {
  const projectName = typeof input.project === "string" ? input.project.trim() : "";
  const hasProject = projectName !== "";
  const includeAllProjects = input.includeAllProjects === true;
  const agentName = typeof input.agent === "string" && input.agent.trim() !== "" ? input.agent : undefined;
  const agentBuckets: MemorySearchBucket[] = agentName === undefined ? [] : [{ scope: "agent", agent: agentName }];

  if (input.scope === "global") return [{ scope: "global" }];
  if (input.scope === "agent") {
    if (agentName === undefined) {
      throw new ValidationError("agent", "scope 為 agent 時必須提供 agent");
    }
    return [{ scope: "agent", agent: agentName }];
  }
  if (input.scope === "project") {
    // 明確 scope=project：只回 project 範圍（project 名稱優先於 includeAllProjects，且不含 agent）。
    if (hasProject) return [{ scope: "project", project: projectName }];
    if (includeAllProjects) return [{ scope: "project" }];
    throw new ValidationError("project", "scope 為 project 時必須提供 project 或 includeAllProjects=true");
  }

  // 未指定 scope 的預設路徑：本專案＋global（＋明確提供的 agent）。
  if (includeAllProjects) return [{ scope: "global" }, { scope: "project" }, ...agentBuckets];
  if (!hasProject) {
    throw new ValidationError(
      "project",
      "無法決定召回範圍：請提供 project，或指定 includeAllProjects=true（跨所有專案）",
    );
  }
  return [{ scope: "global" }, { scope: "project", project: projectName }, ...agentBuckets];
}

type RankedMemory = { id: number; score: number; source: MemoryRecallSource };
type RankedMemoryCandidate = { memory: Memory; item: RankedMemory };

/** 讓較高順位的來源補入另一則訊息，至多取代一筆較低順位來源的重複名額。 */
async function fillSourceComplement(
  store: MetadataStore,
  remainder: readonly RankedMemory[],
  selected: RankedMemoryCandidate[],
  laneStart: number,
  bySource: Map<number, Memory[]>,
  buckets: MemorySearchBucket[],
): Promise<void> {
  const heads = new Map<number, number>();
  const redundant: Array<{ index: number; head: number }> = [];
  for (let index = laneStart; index < selected.length; index += 1) {
    const { memory } = selected[index]!;
    if (memory.sourceId == null) continue;
    const head = heads.get(memory.sourceId);
    if (head === undefined) heads.set(memory.sourceId, index);
    else redundant.push({ index, head });
  }
  if (redundant.length === 0) return;
  const weakestHead = Math.max(...redundant.map(({ head }) => head));
  const targets = new Map([...heads].filter(([id, rank]) => rank < weakestHead && bySource.get(id)?.length === 1));
  if (targets.size === 0) return;

  let complement: RankedMemoryCandidate | undefined;
  let bestHead = weakestHead;
  const strongestTarget = Math.min(...targets.values());
  const seen = new Set(selected.map(({ memory }) => memory.id));
  for (const item of remainder) {
    if (seen.has(item.id)) continue;
    const memory = await store.getMemory(item.id);
    if (memory?.sourceId == null || memory.deletedAt !== null || !isMemoryVisible(memory, buckets)) continue;
    const head = targets.get(memory.sourceId);
    if (head === undefined || head >= bestHead || selected[head]?.memory.messageIndex === memory.messageIndex) continue;
    complement = { memory, item };
    bestHead = head;
    if (head === strongestTarget) break;
  }

  if (complement === undefined) return;
  const donor = redundant.findLast(({ head }) => head > bestHead)!;
  selected.splice(donor.index, 1);
  selected.push(complement);
}

async function selectHits(
  store: MetadataStore,
  ordered: RankedMemory[],
  buckets: MemorySearchBucket[],
  k: number,
  selected: RankedMemoryCandidate[] = [],
) {
  const seen = new Set(selected.map(({ memory }) => memory.id));
  const bySource = new Map<number, Memory[]>();
  for (const { memory } of selected) {
    if (memory.sourceId == null) continue;
    const group = bySource.get(memory.sourceId) ?? [];
    group.push(memory);
    bySource.set(memory.sourceId, group);
  }
  const laneStart = selected.length;
  let scanned = 0;
  for (const item of ordered) {
    if (selected.length >= k) break;
    scanned += 1;
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    const memory = await store.getMemory(item.id);
    if (memory === null || memory.deletedAt !== null || !isMemoryVisible(memory, buckets)) continue;
    if (memory.sourceId != null) {
      const group = bySource.get(memory.sourceId) ?? [];
      if (group.length >= 2 || group.some((other) =>
        other.messageIndex === memory.messageIndex &&
        (other.sourceStart ?? 0) < (memory.sourceEnd ?? 0) &&
        (memory.sourceStart ?? 0) < (other.sourceEnd ?? 0),
      )) continue;
      group.push(memory);
      bySource.set(memory.sourceId, group);
    }
    selected.push({ memory, item });
  }
  if (scanned < ordered.length) {
    await fillSourceComplement(store, ordered.slice(scanned), selected, laneStart, bySource, buckets);
  }
  return selected;
}

/**
 * 執行記憶召回（語言無關的核心；REST／MCP 都走這裡）。
 *
 * @throws ValidationError 範圍不明確（見 `buildMemorySearchBuckets`）；其餘例外（資料層錯誤）往上拋。
 */
export async function prepareMemoryRecall(
  deps: MemorySearchDeps,
  input: MemoryRecallInput,
): Promise<PrepareMemoryPresentation<MemoryRecallResponseBody>> {
  const buckets = buildMemorySearchBuckets(input);
  const k = input.k ?? MEMORY_SEARCH_DEFAULT_K;
  const filter: MemorySearchFilter = {
    buckets,
    ...(input.kind === undefined ? {} : { kind: input.kind }),
  };
  const embedderId = deps.embedder.info.id;
  const memoryEmbedding = await deps.store.memoryEmbeddingStats(embedderId);
  // 「可用」的就緒向量＝ready 減掉 stale。`stale` 是「state=ready 但 embedder 身分不符」，
  // 換 embedder 後、回填完成前所有 ready 都可能 stale（實際查不到任何向量）；此時必須視為
  // 沒有可用向量並降級，而不是進了語意路徑才發現空結果（卡 B2 驗收 O2）。
  const usableReady = Math.max(0, memoryEmbedding.ready - memoryEmbedding.stale);

  let degraded = false;
  let degradedReason: MemoryRecallDegradedReason | null = null;
  const semantic: RankedMemory[] = [];
  // 多取候選，避免同一個長來源的相鄰片段擠掉其他來源。
  const candidateLimit = Math.min(500, Math.max(k * 4, 40));

  if (usableReady <= 0) {
    // 沒有可用的就緒向量：連模型都不必載入，直接關鍵字。
    degraded = true;
    degradedReason = "no-embeddings";
  } else {
    let queryVector: Float32Array | undefined;
    try {
      queryVector = await deps.embedder.embedQuery(input.query);
    } catch {
      // 模型載入／推論失敗：退回關鍵字（回應標 degraded，不讓整個召回失敗）。
      degraded = true;
      degradedReason = "embedder-unavailable";
    }
    if (queryVector !== undefined) {
      const vectorHits = await deps.store.searchMemoriesByVector(queryVector, embedderId, filter, candidateLimit);
      for (const hit of vectorHits) {
        if (input.minScore !== undefined && hit.score < input.minScore) continue;
        semantic.push({ ...hit, source: "semantic" });
      }
    }
  }

  const selected = await selectHits(deps.store, semantic, buckets, k);
  if (selected.length < k) {
    const keyword = await deps.store.searchMemoriesKeyword(input.query, filter, candidateLimit);
    await selectHits(deps.store, keyword.map(({ id, rank }) => ({ id, score: 1 / rank, source: "keyword" })),
      buckets, k, selected);
  }

  const ranks = new Map(selected.map(({ memory, item }) => [memory.id, item]));
  return async () => {
    const presentations = await loadCurrentMemoryPresentations(deps.store, [...ranks.keys()]);
    return (policy) => {
      const present = createMemoryPresenter(policy);
      const hits: MemoryRecallHit[] = [];
      for (const entry of presentations) {
        if (!isMemoryVisible(entry.memory, buckets)) continue;
        const item = ranks.get(entry.memory.id)!;
        const view = present(entry, { query: input.query, maxChars: 420 });
        if (view !== null) {
          hits.push({ ...view, rank: hits.length + 1, score: item.score, source: item.source, untrusted: true });
        }
      }
      return {
        query: memoryContentView(input.query, policy).text,
        k,
        policyVersion: policy.version,
        degraded,
        degradedReason,
        memoryEmbedding,
        hits,
      };
    };
  };
}

export async function searchMemories(
  deps: MemorySearchDeps,
  input: MemoryRecallInput,
): Promise<MemoryRecallResponseBody> {
  const prepare = await prepareMemoryRecall(deps, input);
  const render = await prepare();
  return render(await deps.store.getMemoryPolicy());
}
