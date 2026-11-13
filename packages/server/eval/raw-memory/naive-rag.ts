/**
 * Stage 3 對照基線：純原始對話切片 Naive RAG（無 raw-turn 配對、無範圍遮罩包覆、純向量 top-k）。
 *
 * 設計對照目的（`project-notes/projects/mnemoshelf/plan.md` Stage 3）：
 * - 將 `User: ...\nAssistant: ...` 原始回合文字以固定長度（512 code points、重疊 64）切塊；
 * - 使用與受測系統完全相同的 SQLite + Embedder 向量儲存與餘弦相似度；
 * - 檢索採用純向量 top-k（`k=4`、`minScore=0`、不做關鍵字補足、不做回合展開／重排）；
 * - 在同一 `900` Unicode code points 上限內直接依排名截斷裝箱，供與 `dsh-plugin`／`opencode-plugin` 對比。
 */
import {
  openDatabase,
  runMigrations,
  SqliteMetadataStore,
  type Embedder,
  type SqliteDatabase,
} from "@mnemoshelf/core";
import type { UnseenTurn } from "./unseen-fixture.js";

function codePointLength(text: string): number {
  return Array.from(text).length;
}

export const NAIVE_RAG_CHUNK_CHARS = 512;
export const NAIVE_RAG_CHUNK_OVERLAP = 64;
export const NAIVE_RAG_TOP_K = 4;
export const NAIVE_RAG_BUDGET_CHARS = 900;

export interface NaiveRagChunkRecord {
  id: number;
  turnId: string;
  project: string;
  chunkIndex: number;
  content: string;
}

export interface NaiveRagHit {
  id: number;
  turnId: string;
  chunkIndex: number;
  score: number;
  source: "semantic" | "keyword";
  content: string;
}

export interface NaiveRagSearchResult {
  block: string;
  chars: number;
  hits: NaiveRagHit[];
  keptCount: number;
}

/** 依 Unicode code points 做固定長度與重疊的純文字切片。 */
export function chunkRawText(
  text: string,
  chunkSize = NAIVE_RAG_CHUNK_CHARS,
  overlap = NAIVE_RAG_CHUNK_OVERLAP,
): string[] {
  if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
    throw new RangeError("chunkSize 必須為正整數");
  }
  if (!Number.isInteger(overlap) || overlap < 0 || overlap >= chunkSize) {
    throw new RangeError("overlap 必須為非負整數且小於 chunkSize");
  }
  const codePoints = Array.from(text);
  if (codePoints.length === 0) return [];
  if (codePoints.length <= chunkSize) return [text];

  const step = chunkSize - overlap;
  const chunks: string[] = [];
  for (let start = 0; start < codePoints.length; start += step) {
    const slice = codePoints.slice(start, start + chunkSize).join("");
    chunks.push(slice);
    if (start + chunkSize >= codePoints.length) break;
  }
  return chunks;
}

/** 依 Naive RAG 習慣在單一字元預算內依排名裝箱（超出時第一筆截斷、其餘整筆捨棄）。 */
export function packNaiveRagHits(
  hits: readonly NaiveRagHit[],
  budgetChars = NAIVE_RAG_BUDGET_CHARS,
): { block: string; chars: number; keptCount: number } {
  if (!Number.isInteger(budgetChars) || budgetChars <= 0 || hits.length === 0) {
    return { block: "", chars: 0, keptCount: 0 };
  }
  const parts: string[] = [];
  let used = 0;
  for (const hit of hits) {
    const entry = `[${hit.turnId}#${hit.chunkIndex}]\n${hit.content}`;
    const separatorChars = parts.length === 0 ? 0 : 2;
    const entryChars = codePointLength(entry);
    if (parts.length === 0) {
      if (entryChars <= budgetChars) {
        parts.push(entry);
        used = entryChars;
        continue;
      }
      const truncated = Array.from(entry).slice(0, budgetChars).join("");
      parts.push(truncated);
      used = codePointLength(truncated);
      break;
    }
    if (used + separatorChars + entryChars > budgetChars) break;
    parts.push(entry);
    used += separatorChars + entryChars;
  }
  const block = parts.join("\n\n");
  return { block, chars: codePointLength(block), keptCount: parts.length };
}

export class NaiveRagBaseline {
  private readonly db: SqliteDatabase;
  private readonly store: SqliteMetadataStore;
  private readonly embedder: Embedder;
  private readonly mode: "keyword" | "real";
  private readonly chunksById = new Map<number, NaiveRagChunkRecord>();
  readonly turnCount: number;
  readonly chunkCount: number;

  private constructor(input: {
    db: SqliteDatabase;
    store: SqliteMetadataStore;
    embedder: Embedder;
    mode: "keyword" | "real";
    chunksById: Map<number, NaiveRagChunkRecord>;
    turnCount: number;
  }) {
    this.db = input.db;
    this.store = input.store;
    this.embedder = input.embedder;
    this.mode = input.mode;
    this.chunksById = input.chunksById;
    this.turnCount = input.turnCount;
    this.chunkCount = input.chunksById.size;
  }

  static async create(
    backend: { mode: string; embedder: Embedder },
    turns: readonly UnseenTurn[],
  ): Promise<NaiveRagBaseline> {
    const db = openDatabase(":memory:");
    runMigrations(db);
    const store = new SqliteMetadataStore(db);
    const chunksById = new Map<number, NaiveRagChunkRecord>();

    try {
      for (const turn of turns) {
        const rawText = `User: ${turn.user}\nAssistant: ${turn.assistant}`;
        const pieces = chunkRawText(rawText, NAIVE_RAG_CHUNK_CHARS, NAIVE_RAG_CHUNK_OVERLAP);
        for (let chunkIndex = 0; chunkIndex < pieces.length; chunkIndex += 1) {
          const content = pieces[chunkIndex]!;
          const memory = await store.addMemory({
            agent: "naive-rag",
            scope: "project",
            project: turn.project,
            kind: "fact",
            content,
            supersedes: null,
          });
          if (backend.mode === "real") {
            const vector = await backend.embedder.embedDocument(content);
            await store.markMemoryEmbedded(memory.id, backend.embedder.info.id, vector);
          }
          chunksById.set(memory.id, {
            id: memory.id,
            turnId: turn.id,
            project: turn.project,
            chunkIndex,
            content,
          });
        }
      }
    } catch (error) {
      db.close();
      throw error;
    }

    const mode: "keyword" | "real" = backend.mode === "real" ? "real" : "keyword";
    return new NaiveRagBaseline({
      db,
      store,
      embedder: backend.embedder,
      mode,
      chunksById,
      turnCount: turns.length,
    });
  }

  async search(input: {
    project: string;
    query: string;
    k?: number;
    budgetChars?: number;
  }): Promise<NaiveRagSearchResult> {
    const k = input.k ?? NAIVE_RAG_TOP_K;
    const budgetChars = input.budgetChars ?? NAIVE_RAG_BUDGET_CHARS;
    const filter = { buckets: [{ scope: "project" as const, project: input.project }] };
    const hits: NaiveRagHit[] = [];

    if (this.mode === "real") {
      const queryVec = await this.embedder.embedQuery(input.query);
      const vectorHits = await this.store.searchMemoriesByVector(
        queryVec,
        this.embedder.info.id,
        filter,
        k,
      );
      for (const hit of vectorHits) {
        const record = this.chunksById.get(hit.id);
        if (!record) continue;
        hits.push({
          id: hit.id,
          turnId: record.turnId,
          chunkIndex: record.chunkIndex,
          score: hit.score,
          source: "semantic",
          content: record.content,
        });
      }
    } else {
      const keywordHits = await this.store.searchMemoriesKeyword(input.query, filter, k);
      for (const hit of keywordHits) {
        const record = this.chunksById.get(hit.id);
        if (!record) continue;
        hits.push({
          id: hit.id,
          turnId: record.turnId,
          chunkIndex: record.chunkIndex,
          score: 1 / hit.rank,
          source: "keyword",
          content: record.content,
        });
      }
    }

    const packed = packNaiveRagHits(hits, budgetChars);
    return {
      block: packed.block,
      chars: packed.chars,
      hits,
      keptCount: packed.keptCount,
    };
  }

  close(): void {
    this.db.close();
  }
}
