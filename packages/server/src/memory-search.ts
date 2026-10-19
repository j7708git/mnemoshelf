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
import { maskSecrets } from "./secret-masking.js";

/** 未指定 `k` 時的預設回傳筆數。 */
export const MEMORY_SEARCH_DEFAULT_K = 10;
/** REST／MCP 介面的 `k` 上限（store 層另有 `MEMORY_SEARCH_MAX_K`＝500）。 */
export const MEMORY_SEARCH_MAX_K = 100;

/** 語意不可用時的原因（回應的 `degradedReason`）。 */
export type MemoryRecallDegradedReason = "no-embeddings" | "embedder-unavailable";

/** 命中來源：語意或關鍵字（降級／補足）。 */
export type MemoryRecallSource = "semantic" | "keyword";

/** 一筆召回結果：完整記憶欄位（與 `GET /memories` 一致）＋排名、分數與來源。 */
export interface MemoryRecallHit extends Memory {
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
}

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

/** 用 id 取回完整記憶；不存在／已刪除（搜尋後被刪）者略過。 */
async function loadHits(
  store: MetadataStore,
  ordered: { id: number; score: number; source: MemoryRecallSource }[],
): Promise<MemoryRecallHit[]> {
  const hits: MemoryRecallHit[] = [];
  for (const item of ordered) {
    const memory = await store.getMemory(item.id);
    if (memory === null || memory.deletedAt !== null) continue;
    // 讀取路徑再遮一次（既有 DB 可能有未遮罩資料；metadata 也保護）；
    // `untrusted` 讓呼叫端不會把內容當指令。
    const content = maskSecrets(memory.content);
    const agent = maskSecrets(memory.agent);
    const project = memory.project === null ? null : maskSecrets(memory.project).text;
    hits.push({
      ...memory,
      content: content.text,
      agent: agent.text,
      project,
      rank: hits.length + 1,
      score: item.score,
      source: item.source,
      untrusted: true,
    });
  }
  return hits;
}

/**
 * 執行記憶召回（語言無關的核心；REST／MCP 都走這裡）。
 *
 * @throws ValidationError 範圍不明確（見 `buildMemorySearchBuckets`）；其餘例外（資料層錯誤）往上拋。
 */
export async function searchMemories(
  deps: MemorySearchDeps,
  input: MemoryRecallInput,
): Promise<MemoryRecallResponseBody> {
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
  const semantic: { id: number; score: number }[] = [];

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
      const vectorHits = await deps.store.searchMemoriesByVector(queryVector, embedderId, filter, k);
      for (const hit of vectorHits) {
        if (input.minScore !== undefined && hit.score < input.minScore) continue;
        semantic.push(hit);
      }
    }
  }

  // 語意為主：只有在降級、或語意結果不足 k 時才用關鍵字（補足時不重排語意結果）。
  const keywordHits =
    degraded || semantic.length < k
      ? await deps.store.searchMemoriesKeyword(input.query, filter, k)
      : [];

  const ordered: { id: number; score: number; source: MemoryRecallSource }[] = semantic.map((hit) => ({
    id: hit.id,
    score: hit.score,
    source: "semantic" as const,
  }));

  if (degraded) {
    // 全部關鍵字：來源標 keyword，分數用 1/rank（僅排序輔助）。
    for (const hit of keywordHits) ordered.push({ id: hit.id, score: 1 / hit.rank, source: "keyword" });
  } else {
    const seen = new Set(ordered.map((hit) => hit.id));
    for (const hit of keywordHits) {
      if (seen.has(hit.id)) continue;
      seen.add(hit.id);
      ordered.push({ id: hit.id, score: 1 / hit.rank, source: "keyword" });
    }
  }

  return {
    query: input.query,
    k,
    degraded,
    degradedReason,
    memoryEmbedding,
    hits: await loadHits(deps.store, ordered.slice(0, k)),
  };
}
