import { DuplicateRootError } from "../../errors.js";
import {
  assertMemoryEmbeddingFailure,
  assertMemoryEmbeddingInput,
  assertMemoryQueryVector,
  cosineSimilarity,
  normalizeMemoryLimit,
  normalizeMemoryPatch,
  normalizeMemorySearchFilter,
  normalizeMemorySearchK,
  type MemoryEmbeddingFailure,
  type MemoryEmbeddingStats,
  type MemoryFilter,
  type MemoryKeywordHit,
  type MemorySearchFilter,
  type MemoryVectorHit,
  type MetadataStore,
  type NormalizedMemorySearchFilter,
} from "../../ports/metadata-store.js";
import type {
  Chunk,
  ChunkKind,
  Memory,
  MemoryKind,
  MemoryPatch,
  MemoryScope,
  Modality,
  NewChunk,
  NewMemory,
  NewRoot,
  RankedHit,
  Root,
  RootMode,
  RootPatch,
  SearchFilter,
} from "../../ports/types.js";
import { selectRow, selectRows, type SqliteDatabase } from "./driver.js";
import { runMigrations } from "./db.js";
import { buildMatchExpression, segmentText } from "./segment.js";

const ROOT_COLUMNS = "id, path, mode, modalities, include_rules, exclude_rules, respect_gitignore, watch, created_at";
const CHUNK_COLUMNS = "id, root_id, rel_path, seq, kind, text, content_hash";
const MEMORY_COLUMNS = "id, content, kind, scope, project, agent, supersedes, pinned, created_at, deleted_at";

function parseStringArray(value: unknown): string[] {
  if (typeof value !== "string") return [];
  const parsed: unknown = JSON.parse(value);
  return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
}

function rowToRoot(row: Record<string, unknown>): Root {
  return {
    id: Number(row.id),
    path: String(row.path),
    mode: String(row.mode) as RootMode,
    modalities: parseStringArray(row.modalities) as Modality[],
    include: parseStringArray(row.include_rules),
    exclude: parseStringArray(row.exclude_rules),
    respectGitignore: Number(row.respect_gitignore) !== 0,
    watch: Number(row.watch) !== 0,
    createdAt: String(row.created_at),
  };
}

function rowToChunk(row: Record<string, unknown>): Chunk {
  return {
    id: Number(row.id),
    rootId: Number(row.root_id),
    relPath: String(row.rel_path),
    seq: Number(row.seq),
    kind: String(row.kind) as ChunkKind,
    text: row.text === null || row.text === undefined ? null : String(row.text),
    contentHash: String(row.content_hash),
  };
}

function rowToMemory(row: Record<string, unknown>): Memory {
  return {
    id: Number(row.id),
    content: String(row.content),
    kind: String(row.kind) as MemoryKind,
    scope: String(row.scope) as MemoryScope,
    project: row.project === null || row.project === undefined ? null : String(row.project),
    agent: String(row.agent),
    supersedes: row.supersedes === null || row.supersedes === undefined ? null : Number(row.supersedes),
    pinned: Number(row.pinned) !== 0,
    createdAt: String(row.created_at),
    deletedAt: row.deleted_at === null || row.deleted_at === undefined ? null : String(row.deleted_at),
  };
}

/**
 * 把記憶向量編碼成 SQLite BLOB（little-endian float32，與 `Float32Array` 的記憶體配置相同）。
 *
 * 先包成 `Uint8Array` 再交給 `Buffer.from` 是**複製**（不是共享 view）：避免呼叫端日後改寫
 * 同一個 `Float32Array` 就悄悄改到資料庫裡的值，也避免 BLOB 參照到被回收的緩衝區。
 * 讀回端（卡 B2）以對稱方式解碼；本卡不把向量暴露在 `Memory`。
 */
function encodeEmbedding(vector: Float32Array): Buffer {
  return Buffer.from(new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength));
}

/**
 * 解碼 SQLite BLOB 回 `Float32Array`（`encodeEmbedding` 的對稱操作）。
 *
 * `better-sqlite3` 回傳的 `Buffer` 是 `Uint8Array` 的子類，但它的位元組偏移不保證是 4 的倍數；
 * 這裡先**複製**成新的 `Uint8Array` 再建立 `Float32Array`，避免未對齊的 view 在某些平台出錯。
 * `NULL`／空值回 `null`；位元組長度不是 4 的倍數＝資料損毀 → 拋 `TypeError`。
 */
function decodeEmbedding(value: unknown): Float32Array | null {
  if (!(value instanceof Uint8Array) || value.byteLength === 0) return null;
  if (value.byteLength % 4 !== 0) throw new TypeError("記憶向量資料損毀（位元組長度不是 4 的倍數）");
  const bytes = new Uint8Array(value);
  return new Float32Array(bytes.buffer, 0, bytes.byteLength / 4);
}

/** SQLite 的記憶檢索 WHERE（`m` 是 memories 的別名；**先過濾、後排名**）。 */
interface MemorySearchWhere {
  clause: string;
  params: unknown[];
}

/**
 * 把正規化後的 `MemorySearchFilter` 組成 SQLite WHERE 子句（卡 B2；兩方法共用）。
 *
 * 參數綁定順序與 SQL 中的 `?` 出現順序一致；bucket 之間是 OR、`kind` 與 bucket 群組是 AND。
 */
function buildMemorySearchWhere(filter: NormalizedMemorySearchFilter): MemorySearchWhere {
  const conditions = ["m.deleted_at is null"];
  const params: unknown[] = [];

  if (filter.kind !== undefined) {
    conditions.push("m.kind = ?");
    params.push(filter.kind);
  }

  const buckets = filter.buckets;
  if (buckets !== undefined) {
    const parts: string[] = [];
    for (const bucket of buckets) {
      if (bucket.scope === "global") {
        parts.push("m.scope = 'global'");
        continue;
      }
      if (bucket.scope === "project") {
        if (bucket.project === undefined) {
          parts.push("m.scope = 'project'");
          continue;
        }
        params.push(bucket.project);
        parts.push("(m.scope = 'project' and m.project = ?)");
        continue;
      }
      // scope === "agent"（正規化時已保證 agent 非空）
      params.push(bucket.agent);
      parts.push("(m.scope = 'agent' and m.agent = ?)");
    }
    conditions.push(`(${parts.join(" or ")})`);
  }

  return { clause: conditions.join(" and "), params };
}

/**
 * MetadataStore 的 SQLite 實作。
 *
 * 實作細節（依 spike 筆記 §8）：
 * - 全文檢索用 FTS5 + `unicode61`，內文以 `Intl.Segmenter('zh-Hant')` 斷詞（方案 S），
 *   因此兩字中文詞可搜。
 * - 同 key 的 chunk／記憶以 FTS rowid 對應，查詢時 join 回主表並以 `bm25()` 排序。
 */
export class SqliteMetadataStore implements MetadataStore {
  private readonly db: SqliteDatabase;

  constructor(db: SqliteDatabase) {
    this.db = db;
  }

  async migrate(): Promise<void> {
    runMigrations(this.db);
  }

  async addRoot(r: NewRoot): Promise<Root> {
    const createdAt = new Date().toISOString();
    try {
      this.db
        .prepare(
          `insert into roots(path, mode, modalities, include_rules, exclude_rules, respect_gitignore, watch, created_at)
           values (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          r.path,
          r.mode,
          JSON.stringify(r.modalities),
          JSON.stringify(r.include),
          JSON.stringify(r.exclude),
          r.respectGitignore ? 1 : 0,
          r.watch ? 1 : 0,
          createdAt,
        );
    } catch (error) {
      if (String(error).includes("UNIQUE constraint failed")) {
        throw new DuplicateRootError(r.path);
      }
      throw error;
    }

    const row = selectRow(this.db, `select ${ROOT_COLUMNS} from roots where path = ?`, r.path);
    if (row === undefined) throw new Error("新增 root 後讀不回資料列");
    return rowToRoot(row);
  }

  async getRoot(id: number): Promise<Root | null> {
    const row = selectRow(this.db, `select ${ROOT_COLUMNS} from roots where id = ?`, id);
    return row === undefined ? null : rowToRoot(row);
  }

  async listRoots(): Promise<Root[]> {
    return selectRows(this.db, `select ${ROOT_COLUMNS} from roots order by id`).map(rowToRoot);
  }

  /**
   * 更新可變設定（`RootPatch`）。
   *
   * 先讀回現值再寫入（而不是 `update … set modalities = coalesce(?, modalities)`）：
   * 欄位省略＝不變的語意留在這裡，`null` 這種 SQL 值不必進到介面；
   * 代價是多一次 select（roots 只有個位數筆，可忽略）。
   */
  async updateRoot(id: number, patch: RootPatch): Promise<Root | null> {
    const existing = await this.getRoot(id);
    if (existing === null) return null;

    this.db
      .prepare("update roots set modalities = ? where id = ?")
      .run(JSON.stringify(patch.modalities ?? existing.modalities), id);

    return await this.getRoot(id);
  }

  async removeRoot(id: number, deleteData: boolean): Promise<{ removedChunkIds: number[] }> {
    const remove = this.db.transaction((): number[] => {
      const chunkIds = selectRows(this.db, "select id from chunks where root_id = ? order by id", id).map((row) =>
        Number(row.id),
      );

      if (deleteData) {
        const deleteFts = this.db.prepare("delete from chunks_fts where rowid = ?");
        for (const chunkId of chunkIds) deleteFts.run(chunkId);
        this.db.prepare("delete from chunks where root_id = ?").run(id);
      }

      this.db.prepare("delete from roots where id = ?").run(id);
      return deleteData ? chunkIds : [];
    });

    return { removedChunkIds: remove() };
  }

  async replaceChunks(
    rootId: number,
    relPath: string,
    chunks: Omit<NewChunk, "rootId" | "relPath">[],
  ): Promise<Chunk[]> {
    const replace = this.db.transaction((items: Omit<NewChunk, "rootId" | "relPath">[]): number[] => {
      const existing = selectRows(
        this.db,
        "select id from chunks where root_id = ? and rel_path = ? order by id",
        rootId,
        relPath,
      ).map((row) => Number(row.id));

      const deleteFts = this.db.prepare("delete from chunks_fts where rowid = ?");
      const deleteChunk = this.db.prepare("delete from chunks where id = ?");
      for (const existingId of existing) {
        deleteFts.run(existingId);
        deleteChunk.run(existingId);
      }

      const insert = this.db.prepare(
        "insert into chunks(root_id, rel_path, seq, kind, text, content_hash) values (?, ?, ?, ?, ?, ?)",
      );
      const insertFts = this.db.prepare("insert into chunks_fts(rowid, seg) values (?, ?)");

      const created: number[] = [];
      for (const item of items) {
        const info = insert.run(rootId, relPath, item.seq, item.kind, item.text, item.contentHash);
        const chunkId = Number(info.lastInsertRowid);
        created.push(chunkId);
        if (item.text !== null && item.text.trim().length > 0) {
          insertFts.run(chunkId, segmentText(item.text));
        }
      }
      return created;
    });

    return this.getChunks(replace(chunks));
  }

  async deleteChunksByPath(rootId: number, relPath: string): Promise<number[]> {
    const remove = this.db.transaction((): number[] => {
      const ids = selectRows(
        this.db,
        "select id from chunks where root_id = ? and rel_path = ? order by id",
        rootId,
        relPath,
      ).map((row) => Number(row.id));

      const deleteFts = this.db.prepare("delete from chunks_fts where rowid = ?");
      const deleteChunk = this.db.prepare("delete from chunks where id = ?");
      for (const id of ids) {
        deleteFts.run(id);
        deleteChunk.run(id);
      }
      return ids;
    });

    return remove();
  }

  async getChunks(ids: number[]): Promise<Chunk[]> {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(", ");
    const rows = selectRows(this.db, `select ${CHUNK_COLUMNS} from chunks where id in (${placeholders})`, ...ids);
    const byId = new Map(rows.map((row) => [Number(row.id), rowToChunk(row)]));
    return ids
      .map((id) => byId.get(id))
      .filter((chunk): chunk is Chunk => chunk !== undefined);
  }

  async listChunksByPath(rootId: number, relPath: string): Promise<Chunk[]> {
    return selectRows(
      this.db,
      `select ${CHUNK_COLUMNS} from chunks where root_id = ? and rel_path = ? order by seq, id`,
      rootId,
      relPath,
    ).map(rowToChunk);
  }

  async listRelPaths(rootId: number): Promise<string[]> {
    return selectRows(this.db, "select distinct rel_path from chunks where root_id = ? order by rel_path", rootId).map(
      (row) => String(row.rel_path),
    );
  }

  async addMemory(m: NewMemory): Promise<Memory> {
    const createdAt = new Date().toISOString();
    const insert = this.db.transaction((): number => {
      if (m.supersedes !== null) {
        this.db
          .prepare("update memories set deleted_at = ? where id = ? and deleted_at is null")
          .run(createdAt, m.supersedes);
      }
      const info = this.db
        .prepare(
          `insert into memories(content, kind, scope, project, agent, supersedes, created_at, deleted_at)
           values (?, ?, ?, ?, ?, ?, ?, null)`,
        )
        .run(m.content, m.kind, m.scope, m.project, m.agent, m.supersedes, createdAt);
      const memoryId = Number(info.lastInsertRowid);
      if (m.content.trim().length > 0) {
        this.db.prepare("insert into memories_fts(rowid, seg) values (?, ?)").run(memoryId, segmentText(m.content));
      }
      return memoryId;
    });

    const memoryId = insert();
    const created = await this.getMemory(memoryId);
    if (created === null) throw new Error("新增記憶後讀不回資料列");
    return created;
  }

  async getMemory(id: number): Promise<Memory | null> {
    const row = selectRow(this.db, `select ${MEMORY_COLUMNS} from memories where id = ?`, id);
    return row === undefined ? null : rowToMemory(row);
  }

  async forgetMemory(id: number): Promise<void> {
    this.db.prepare("update memories set deleted_at = ? where id = ? and deleted_at is null").run(new Date().toISOString(), id);
  }

  /** 設定釘選（冪等）；不存在的 id 更新不到任何列，等同無操作。 */
  async setMemoryPinned(id: number, pinned: boolean): Promise<void> {
    this.db.prepare("update memories set pinned = ? where id = ?").run(pinned ? 1 : 0, id);
  }

  /**
   * 更新記憶的 `scope`／`project`（見 `MetadataStore.updateMemory`）。
   *
   * 先讀回現值再套 patch（`normalizeMemoryPatch`）——合併與正規化語意只有一處，
   * 不寫成 `coalesce(?, …)` 這種 SQL 表達；`deleted_at is null` 讓「讀到之後才被軟刪除」
   * 的競態也回 `null`，與 PG 端的 `returning` 語意一致。內容沒動，因此 FTS 列不必更新。
   */
  async updateMemory(id: number, patch: MemoryPatch): Promise<Memory | null> {
    const existing = await this.getMemory(id);
    if (existing === null || existing.deletedAt !== null) return null;

    const next = normalizeMemoryPatch(existing, patch);
    this.db
      .prepare("update memories set scope = ?, project = ? where id = ? and deleted_at is null")
      .run(next.scope, next.project, id);
    return await this.getMemory(id);
  }

  /**
   * 寫入記憶向量並設為 `ready`（見 `MetadataStore.markMemoryEmbedded`）。
   *
   * `deleted_at is null` 讓「讀到之後才被軟刪除」的競態變成 no-op；未知 id 同樣更新不到任何列。
   * 狀態與向量在同一個 UPDATE 寫入，不會觀察到「ready 但沒有向量」的中間狀態。
   */
  async markMemoryEmbedded(id: number, embedderId: string, vec: Float32Array): Promise<void> {
    assertMemoryEmbeddingInput(embedderId, vec);
    this.db
      .prepare(
        `update memories
            set embedding = ?, embedding_embedder_id = ?, embedding_state = 'ready'
          where id = ? and deleted_at is null`,
      )
      .run(encodeEmbedding(vec), embedderId, id);
  }

  /**
   * 把狀態設為 `failed`／`too-long`（見 `MetadataStore.markMemoryEmbeddingFailed`）。
   *
   * 刻意**不**清掉既有 `embedding`／`embedding_embedder_id`：卡 B2 的召回端只採 `ready` 且
   * embedder 相符者，保留舊向量可讓「同一 embedder 重試成功」時省一次寫入，也便於診斷。
   */
  async markMemoryEmbeddingFailed(id: number, reason: MemoryEmbeddingFailure): Promise<void> {
    assertMemoryEmbeddingFailure(reason);
    this.db
      .prepare("update memories set embedding_state = ? where id = ? and deleted_at is null")
      .run(reason, id);
  }

  /**
   * 列出需要（重新）產生向量的未刪除記憶（見 `MetadataStore.listMemoriesNeedingEmbedding`）。
   *
   * `embedding_embedder_id is null` 也視為 stale：`ready` 正常一定有 embedder id，但防禦
   * 早期手動改資料或未來遷移留下的半套狀態。
   */
  async listMemoriesNeedingEmbedding(embedderId: string, limit?: number): Promise<Memory[]> {
    const normalized = normalizeMemoryLimit(limit);
    if (normalized === 0) return [];

    return selectRows(
      this.db,
      `select ${MEMORY_COLUMNS} from memories
        where deleted_at is null
          and (embedding_state in ('pending', 'failed')
               or (embedding_state = 'ready'
                   and (embedding_embedder_id is null or embedding_embedder_id <> ?)))
        order by created_at desc, id desc
        limit ?`,
      embedderId,
      normalized,
    ).map(rowToMemory);
  }

  /** 統計未刪除記憶的語意化狀態（見 `MetadataStore.memoryEmbeddingStats`；四個狀態數自洽）。 */
  async memoryEmbeddingStats(embedderId: string): Promise<MemoryEmbeddingStats> {
    const row = selectRow(
      this.db,
      `select
         count(*) as total,
         sum(case when embedding_state = 'pending' then 1 else 0 end) as pending,
         sum(case when embedding_state = 'ready' then 1 else 0 end) as ready,
         sum(case when embedding_state = 'failed' then 1 else 0 end) as failed,
         sum(case when embedding_state = 'too-long' then 1 else 0 end) as too_long,
         sum(case
               when embedding_state = 'ready'
                and (embedding_embedder_id is null or embedding_embedder_id <> ?)
               then 1 else 0
             end) as stale
       from memories where deleted_at is null`,
      embedderId,
    );

    const count = (value: unknown): number => Number(value ?? 0);
    return {
      total: count(row?.total),
      pending: count(row?.pending),
      ready: count(row?.ready),
      failed: count(row?.failed),
      tooLong: count(row?.too_long),
      stale: count(row?.stale),
    };
  }

  /**
   * 記憶語意檢索（見 `MetadataStore.searchMemoriesByVector`）。
   *
   * SQL 先套 filter 與 `ready`／embedder 身分條件，**再**在 JS 算 cosine（精確、O(n)）——
   * 不會出現「先取 top-k 再過濾」而少給結果的問題。`linear scan` 對千～萬筆記憶可接受（卡 B2 的取捨）。
   */
  async searchMemoriesByVector(
    queryVec: Float32Array,
    embedderId: string,
    filter: MemorySearchFilter,
    k: number,
  ): Promise<MemoryVectorHit[]> {
    assertMemoryQueryVector(queryVec);
    if (typeof embedderId !== "string" || embedderId.trim() === "") {
      throw new TypeError("embedderId 必須是非空字串");
    }
    const limit = normalizeMemorySearchK(k);
    if (limit === 0) return [];

    const normalized = normalizeMemorySearchFilter(filter);
    if (normalized.buckets !== undefined && normalized.buckets.length === 0) return [];
    const where = buildMemorySearchWhere(normalized);

    const rows = selectRows(
      this.db,
      `select m.id as id, m.embedding as embedding
         from memories m
        where ${where.clause}
          and m.embedding_state = 'ready'
          and m.embedding_embedder_id = ?`,
      ...where.params,
      embedderId,
    );

    const scored: MemoryVectorHit[] = [];
    for (const row of rows) {
      const vector = decodeEmbedding(row.embedding);
      if (vector === null) continue;
      // 維度不同時 cosineSimilarity 會拋 TypeError（不得默默跳過損壞的向量資料）。
      scored.push({ id: Number(row.id), score: cosineSimilarity(queryVec, vector) });
    }
    scored.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.id - b.id));
    return scored.slice(0, limit);
  }

  /**
   * 記憶關鍵字檢索（見 `MetadataStore.searchMemoriesKeyword`）。
   *
   * 只查 `memories_fts`（**不混 chunk**）；同一組 filter 在 SQL 先套用，再依 bm25 排名，
   * 同分以 `id` 升冪決勝（可重現）。`rank` 由回傳順序從 1 起算。
   */
  async searchMemoriesKeyword(query: string, filter: MemorySearchFilter, k: number): Promise<MemoryKeywordHit[]> {
    const limit = normalizeMemorySearchK(k);
    if (limit === 0) return [];
    const matchExpression = buildMatchExpression(query);
    if (matchExpression === null) return [];

    const normalized = normalizeMemorySearchFilter(filter);
    if (normalized.buckets !== undefined && normalized.buckets.length === 0) return [];
    const where = buildMemorySearchWhere(normalized);

    return selectRows(
      this.db,
      `select m.id as id, bm25(memories_fts) as score
         from memories_fts join memories m on m.id = memories_fts.rowid
        where memories_fts match ? and ${where.clause}
        order by score, m.id
        limit ?`,
      matchExpression,
      ...where.params,
      limit,
    ).map((row, index) => ({ id: Number(row.id), rank: index + 1 }));
  }

  /**
   * 列舉未刪除的記憶（見 `MetadataStore.listMemories` 的契約）。
   *
   * 排序 `created_at desc, id desc`：`created_at` 是毫秒精度的 ISO 字串，同一毫秒內新增的多筆
   * 記憶需要 `id` 當決勝鍵，否則順序不確定（不可重現）。欄位條件全部用參數綁定，不做字串拼接。
   */
  async listMemories(filter: MemoryFilter = {}): Promise<Memory[]> {
    const limit = normalizeMemoryLimit(filter.limit);
    if (limit === 0) return [];

    const conditions = ["deleted_at is null"];
    const params: unknown[] = [];
    if (filter.scope !== undefined) {
      conditions.push("scope = ?");
      params.push(filter.scope);
    }
    if (filter.project !== undefined) {
      conditions.push("project = ?");
      params.push(filter.project);
    }
    if (filter.agent !== undefined) {
      conditions.push("agent = ?");
      params.push(filter.agent);
    }
    if (filter.kind !== undefined) {
      conditions.push("kind = ?");
      params.push(filter.kind);
    }

    return selectRows(
      this.db,
      `select ${MEMORY_COLUMNS} from memories where ${conditions.join(" and ")} order by created_at desc, id desc limit ?`,
      ...params,
      limit,
    ).map(rowToMemory);
  }

  /**
   * 關鍵字搜尋。
   *
   * 排名：chunk 與記憶各自以 `bm25()` 排序，再合併成單一清單（分數越小越前面），
   * 同分以 key 的字典序決定，確保可重現。
   * `filter.rootIds` 未指定時搜尋所有 chunk 與未刪除的記憶；指定時只搜尋這些 root 的
   * chunk（記憶沒有 root，因此不回傳；與向量查詢對 null root 的規則一致）。
   */
  async searchKeyword(query: string, filter: SearchFilter, k: number): Promise<RankedHit[]> {
    if (k <= 0) return [];
    const matchExpression = buildMatchExpression(query);
    if (matchExpression === null) return [];

    const scored: { key: string; score: number }[] = [];
    const rootIds = filter.rootIds;

    if (rootIds === undefined || rootIds.length > 0) {
      const chunkSql =
        rootIds === undefined
          ? `select chunks.id as id, bm25(chunks_fts) as score
               from chunks_fts join chunks on chunks.id = chunks_fts.rowid
              where chunks_fts match ? and chunks.text is not null
              order by score limit ?`
          : `select chunks.id as id, bm25(chunks_fts) as score
               from chunks_fts join chunks on chunks.id = chunks_fts.rowid
              where chunks_fts match ? and chunks.root_id in (${rootIds.map(() => "?").join(", ")})
              order by score limit ?`;
      const chunkParams: unknown[] = rootIds === undefined ? [matchExpression, k] : [matchExpression, ...rootIds, k];
      for (const row of selectRows(this.db, chunkSql, ...chunkParams)) {
        scored.push({ key: `c:${Number(row.id)}`, score: Number(row.score) });
      }
    }

    if (rootIds === undefined) {
      const rows = selectRows(
        this.db,
        `select memories.id as id, bm25(memories_fts) as score
           from memories_fts join memories on memories.id = memories_fts.rowid
          where memories_fts match ? and memories.deleted_at is null
          order by score limit ?`,
        matchExpression,
        k,
      );
      for (const row of rows) {
        scored.push({ key: `m:${Number(row.id)}`, score: Number(row.score) });
      }
    }

    scored.sort((a, b) => {
      if (a.score !== b.score) return a.score - b.score;
      return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    });

    return scored.slice(0, k).map((hit, index) => ({ key: hit.key, rank: index + 1 }));
  }
}
