import { DuplicateRootError } from "../../errors.js";
import {
  normalizeMemoryLimit,
  normalizeMemoryPatch,
  type MemoryFilter,
  type MetadataStore,
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
