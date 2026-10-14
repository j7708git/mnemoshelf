import {
  DuplicateRootError,
  normalizeMemoryLimit,
  type Chunk,
  type ChunkKind,
  type Memory,
  type MemoryFilter,
  type MemoryKind,
  type MemoryScope,
  type MetadataStore,
  type Modality,
  type NewChunk,
  type NewMemory,
  type NewRoot,
  type RankedHit,
  type Root,
  type RootMode,
  type SearchFilter,
} from "@mnemoshelf/core";
import type { Pool } from "pg";
import { qualified } from "./schema.js";
import { segmentText } from "./segment.js";
import { withTransaction } from "./connection.js";

/** `PgMetadataStore` 的選項。 */
export interface PgMetadataStoreOptions {
  /** 資料表所在的 schema；省略時用 `public`。契約測試每個測試用一個臨時 schema。 */
  schema?: string;
}

const ROOT_COLUMNS =
  "id, path, mode, modalities, include_rules, exclude_rules, respect_gitignore, watch, created_at";
const CHUNK_COLUMNS = "id, root_id, rel_path, seq, kind, text, content_hash";
const MEMORY_COLUMNS = "id, content, kind, scope, project, agent, supersedes, pinned, created_at, deleted_at";

/** `pg` 的 unique violation 錯誤碼（SQLite 是字串比對，PostgreSQL 是 SQLSTATE）。 */
const UNIQUE_VIOLATION = "23505";

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === UNIQUE_VIOLATION;
}

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
    respectGitignore: row.respect_gitignore === true,
    watch: row.watch === true,
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
    pinned: row.pinned === true,
    createdAt: String(row.created_at),
    deletedAt: row.deleted_at === null || row.deleted_at === undefined ? null : String(row.deleted_at),
  };
}

/** 文字轉成存入 `seg` 欄位的斷詞結果；空白內容回傳 null（該列不進 FTS）。 */
function segmentOrNull(text: string | null): string | null {
  if (text === null || text.trim().length === 0) return null;
  return segmentText(text);
}

/**
 * 建表 DDL（冪等）。全部使用 schema 限定的表名。
 *
 * 與 SQLite 後端的對應（見研究筆記「Schema 對應地圖」）：
 * - `id` 用 `int4`（`pg` 對 `int8` 會回字串，契約要比對數字）；`created_at` 用 `text` ISO 字串，
 *   字典序＝時間序，與 SQLite 完全同位（`timestamptz` 會被 `pg` 回成 `Date`，反而要多一層轉換）。
 * - 刻意**不宣告** chunks→roots 的外鍵：`removeRoot(deleteData=false)` 會刪 root 列卻保留 chunks。
 * - 全文檢索不用虛擬表：`seg`（斷詞結果）＋ generated `tsvector('simple', seg)`＋ GIN。
 *   generated column 讓 tsvector 自動同步，省掉 SQLite 端手動維護 FTS 列的四個路徑。
 */
function metadataSchemaSql(schema: string): string {
  const roots = qualified(schema, "roots");
  const chunks = qualified(schema, "chunks");
  const memories = qualified(schema, "memories");
  return `
    create table if not exists ${roots} (
      id integer generated always as identity primary key,
      path text not null unique,
      mode text not null,
      modalities text not null default '[]',
      include_rules text not null default '[]',
      exclude_rules text not null default '[]',
      respect_gitignore boolean not null default true,
      watch boolean not null default false,
      created_at text not null
    );

    create table if not exists ${chunks} (
      id integer generated always as identity primary key,
      root_id integer not null,
      rel_path text not null,
      seq integer not null,
      kind text not null,
      text text,
      content_hash text not null,
      seg text,
      tsv tsvector generated always as (to_tsvector('simple', seg)) stored
    );
    create index if not exists chunks_root_path_idx on ${chunks}(root_id, rel_path);
    create index if not exists chunks_tsv_gin on ${chunks} using gin (tsv);

    create table if not exists ${memories} (
      id integer generated always as identity primary key,
      content text not null,
      kind text not null,
      scope text not null,
      project text,
      agent text not null,
      supersedes integer,
      pinned boolean not null default false,
      created_at text not null,
      deleted_at text,
      seg text,
      tsv tsvector generated always as (to_tsvector('simple', seg)) stored
    );
    create index if not exists memories_tsv_gin on ${memories} using gin (tsv);

    -- 既有資料庫（本卡之前建立的表）補上 pinned；冪等，重複執行無害。
    alter table ${memories} add column if not exists pinned boolean not null default false;
  `;
}

/**
 * `MetadataStore` 的 PostgreSQL 實作。
 *
 * 全文檢索走「應用層 `Intl.Segmenter` 斷詞 ＋ `tsvector('simple')` ＋ GIN」（研究筆記方案 S），
 * 與 SQLite 後端行為一致；關鍵字排名用 `ts_rank`（越大越前），
 * 與 SQLite 的 `bm25`（越小越前）方向相反，因此合併時以分數由大到小排序。
 */
export class PgMetadataStore implements MetadataStore {
  private readonly pool: Pool;
  private readonly schema: string;
  private readonly roots: string;
  private readonly chunks: string;
  private readonly memories: string;

  constructor(pool: Pool, options: PgMetadataStoreOptions = {}) {
    this.pool = pool;
    this.schema = options.schema ?? "public";
    this.roots = qualified(this.schema, "roots");
    this.chunks = qualified(this.schema, "chunks");
    this.memories = qualified(this.schema, "memories");
  }

  async migrate(): Promise<void> {
    // 多個 statement 以簡單查詢協定一次送出；全部 `if not exists`，可重複呼叫。
    await this.pool.query(metadataSchemaSql(this.schema));
  }

  async addRoot(r: NewRoot): Promise<Root> {
    const createdAt = new Date().toISOString();
    try {
      await this.pool.query(
        `insert into ${this.roots}(path, mode, modalities, include_rules, exclude_rules, respect_gitignore, watch, created_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          r.path,
          r.mode,
          JSON.stringify(r.modalities),
          JSON.stringify(r.include),
          JSON.stringify(r.exclude),
          r.respectGitignore,
          r.watch,
          createdAt,
        ],
      );
    } catch (error) {
      if (isUniqueViolation(error)) throw new DuplicateRootError(r.path);
      throw error;
    }

    const result = await this.pool.query(`select ${ROOT_COLUMNS} from ${this.roots} where path = $1`, [r.path]);
    if (result.rows.length === 0) throw new Error("新增 root 後讀不回資料列");
    return rowToRoot(result.rows[0]!);
  }

  async getRoot(id: number): Promise<Root | null> {
    const result = await this.pool.query(`select ${ROOT_COLUMNS} from ${this.roots} where id = $1`, [id]);
    return result.rows.length === 0 ? null : rowToRoot(result.rows[0]!);
  }

  async listRoots(): Promise<Root[]> {
    const result = await this.pool.query(`select ${ROOT_COLUMNS} from ${this.roots} order by id`);
    return result.rows.map(rowToRoot);
  }

  async removeRoot(id: number, deleteData: boolean): Promise<{ removedChunkIds: number[] }> {
    return await withTransaction(this.pool, async (client) => {
      const found = await client.query(`select id from ${this.chunks} where root_id = $1 order by id`, [id]);
      const chunkIds = found.rows.map((row) => Number(row.id));

      if (deleteData) {
        await client.query(`delete from ${this.chunks} where root_id = $1`, [id]);
      }
      await client.query(`delete from ${this.roots} where id = $1`, [id]);

      return { removedChunkIds: deleteData ? chunkIds : [] };
    });
  }

  async replaceChunks(
    rootId: number,
    relPath: string,
    chunks: Omit<NewChunk, "rootId" | "relPath">[],
  ): Promise<Chunk[]> {
    return await withTransaction(this.pool, async (client) => {
      await client.query(`delete from ${this.chunks} where root_id = $1 and rel_path = $2`, [rootId, relPath]);

      const created: Chunk[] = [];
      for (const item of chunks) {
        const result = await client.query(
          `insert into ${this.chunks}(root_id, rel_path, seq, kind, text, content_hash, seg)
           values ($1, $2, $3, $4, $5, $6, $7)
           returning ${CHUNK_COLUMNS}`,
          [rootId, relPath, item.seq, item.kind, item.text, item.contentHash, segmentOrNull(item.text)],
        );
        created.push(rowToChunk(result.rows[0]!));
      }
      return created;
    });
  }

  async deleteChunksByPath(rootId: number, relPath: string): Promise<number[]> {
    return await withTransaction(this.pool, async (client) => {
      const found = await client.query(
        `select id from ${this.chunks} where root_id = $1 and rel_path = $2 order by id`,
        [rootId, relPath],
      );
      const ids = found.rows.map((row) => Number(row.id));
      if (ids.length > 0) {
        await client.query(`delete from ${this.chunks} where id = any($1::int[])`, [ids]);
      }
      return ids;
    });
  }

  async getChunks(ids: number[]): Promise<Chunk[]> {
    if (ids.length === 0) return [];
    const result = await this.pool.query(`select ${CHUNK_COLUMNS} from ${this.chunks} where id = any($1::int[])`, [
      ids,
    ]);
    const byId = new Map<number, Chunk>(result.rows.map((row) => [Number(row.id), rowToChunk(row)]));
    return ids
      .map((id) => byId.get(id))
      .filter((chunk): chunk is Chunk => chunk !== undefined);
  }

  async listChunksByPath(rootId: number, relPath: string): Promise<Chunk[]> {
    const result = await this.pool.query(
      `select ${CHUNK_COLUMNS} from ${this.chunks} where root_id = $1 and rel_path = $2 order by seq, id`,
      [rootId, relPath],
    );
    return result.rows.map(rowToChunk);
  }

  async listRelPaths(rootId: number): Promise<string[]> {
    const result = await this.pool.query(
      `select distinct rel_path from ${this.chunks} where root_id = $1 order by rel_path`,
      [rootId],
    );
    return result.rows.map((row) => String(row.rel_path));
  }

  async addMemory(m: NewMemory): Promise<Memory> {
    const createdAt = new Date().toISOString();
    const memoryId = await withTransaction(this.pool, async (client) => {
      if (m.supersedes !== null) {
        await client.query(`update ${this.memories} set deleted_at = $1 where id = $2 and deleted_at is null`, [
          createdAt,
          m.supersedes,
        ]);
      }
      const result = await client.query(
        `insert into ${this.memories}(content, kind, scope, project, agent, supersedes, created_at, deleted_at, seg)
         values ($1, $2, $3, $4, $5, $6, $7, null, $8)
         returning id`,
        [m.content, m.kind, m.scope, m.project, m.agent, m.supersedes, createdAt, segmentOrNull(m.content)],
      );
      return Number(result.rows[0]!.id);
    });

    const created = await this.getMemory(memoryId);
    if (created === null) throw new Error("新增記憶後讀不回資料列");
    return created;
  }

  async getMemory(id: number): Promise<Memory | null> {
    const result = await this.pool.query(`select ${MEMORY_COLUMNS} from ${this.memories} where id = $1`, [id]);
    return result.rows.length === 0 ? null : rowToMemory(result.rows[0]!);
  }

  async forgetMemory(id: number): Promise<void> {
    await this.pool.query(`update ${this.memories} set deleted_at = $1 where id = $2 and deleted_at is null`, [
      new Date().toISOString(),
      id,
    ]);
  }

  /** 設定釘選（冪等）；不存在的 id 更新不到任何列，等同無操作。 */
  async setMemoryPinned(id: number, pinned: boolean): Promise<void> {
    await this.pool.query(`update ${this.memories} set pinned = $1 where id = $2`, [pinned, id]);
  }

  async listMemories(filter: MemoryFilter = {}): Promise<Memory[]> {
    const limit = normalizeMemoryLimit(filter.limit);
    if (limit === 0) return [];

    const conditions = ["deleted_at is null"];
    const params: unknown[] = [];
    if (filter.scope !== undefined) {
      params.push(filter.scope);
      conditions.push(`scope = $${params.length}`);
    }
    if (filter.project !== undefined) {
      params.push(filter.project);
      conditions.push(`project = $${params.length}`);
    }
    if (filter.agent !== undefined) {
      params.push(filter.agent);
      conditions.push(`agent = $${params.length}`);
    }
    if (filter.kind !== undefined) {
      params.push(filter.kind);
      conditions.push(`kind = $${params.length}`);
    }
    params.push(limit);

    const result = await this.pool.query(
      `select ${MEMORY_COLUMNS} from ${this.memories}
        where ${conditions.join(" and ")}
        order by created_at desc, id desc
        limit $${params.length}`,
      params,
    );
    return result.rows.map(rowToMemory);
  }

  /**
   * 關鍵字搜尋：chunk 與未刪除的記憶各查一次，合併後排序。
   *
   * - 查詢字串與內文都經 `segmentText` 斷詞，再用 `tsquery || tsquery`（OR）組合；
   *   每個 token 都以 `plainto_tsquery('simple', $n)` 參數綁定，**不做字串拼接**。
   * - `filter.rootIds` 未指定＝搜所有 chunk 與記憶；指定時只搜這些 root 的 chunk，
   *   記憶（沒有 root）不回傳；指定空陣列＝沒有任何可見 root，直接回空。
   * - 排名：`ts_rank` 越大越前，同分以 key 字典序決勝（與 SQLite 端一致、可重現）。
   */
  async searchKeyword(query: string, filter: SearchFilter, k: number): Promise<RankedHit[]> {
    if (k <= 0) return [];
    const tokens = segmentText(query)
      .split(" ")
      .filter((token) => token.length > 0);
    if (tokens.length === 0) return [];

    const rootIds = filter.rootIds;
    if (rootIds !== undefined && rootIds.length === 0) return [];

    const tsquery = tokens.map((_, index) => `plainto_tsquery('simple', $${index + 1})`).join(" || ");
    const scored: { key: string; score: number }[] = [];

    // chunk：指定 rootIds 時在 SQL 內過濾（先過濾再排序，避免先取前 k 再過濾而少給結果）。
    {
      const params: unknown[] = [...tokens];
      let filterClause = "";
      if (rootIds !== undefined) {
        params.push(rootIds);
        filterClause = ` and c.root_id = any($${params.length}::int[])`;
      }
      params.push(k);
      const result = await this.pool.query(
        `with q as (select ${tsquery} as tsq)
         select 'c:' || c.id as key, ts_rank(c.tsv, q.tsq) as score
           from ${this.chunks} c, q
          where c.tsv @@ q.tsq${filterClause}
          order by score desc, key asc
          limit $${params.length}`,
        params,
      );
      for (const row of result.rows) scored.push({ key: String(row.key), score: Number(row.score) });
    }

    // 記憶：沒有 root，因此只有「未指定 rootIds」時才納入。
    if (rootIds === undefined) {
      const params: unknown[] = [...tokens, k];
      const result = await this.pool.query(
        `with q as (select ${tsquery} as tsq)
         select 'm:' || m.id as key, ts_rank(m.tsv, q.tsq) as score
           from ${this.memories} m, q
          where m.tsv @@ q.tsq and m.deleted_at is null
          order by score desc, key asc
          limit $${params.length}`,
        params,
      );
      for (const row of result.rows) scored.push({ key: String(row.key), score: Number(row.score) });
    }

    scored.sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score;
      return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    });

    return scored.slice(0, k).map((hit, index) => ({ key: hit.key, rank: index + 1 }));
  }
}
