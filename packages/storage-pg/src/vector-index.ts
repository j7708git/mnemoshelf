import {
  DEFAULT_DIM,
  NORMALIZATION_TOLERANCE,
  VectorDimensionError,
  VectorNotNormalizedError,
  vectorNorm,
  type RankedHit,
  type SearchFilter,
} from "@mnemoshelf/core";
import type { VectorIndex, VectorItem } from "@mnemoshelf/core";
import type { Pool } from "pg";
import { qualified } from "./schema.js";
import { withTransaction } from "./connection.js";
import { VectorColumnDimensionError } from "./errors.js";

/** `PgVectorIndex` 的選項。 */
export interface PgVectorIndexOptions {
  /** 向量維度；省略時用 core 的 `DEFAULT_DIM`（512）。維度寫死進 `vector(N)` 型別。 */
  dim?: number;
  /** 資料表所在的 schema；省略時用 `public`。 */
  schema?: string;
}

/** KNN 查詢的 `k` 上限（與 SQLite 後端的 `MAX_KNN_K` 同值，超過者夾住而非報錯）。 */
export const MAX_SEARCH_K = 4096;

/**
 * `Float32Array` → pgvector 的文字表示 `[1,2,...]`。
 *
 * 不使用 `pgvector` npm 套件：本 port 從不讀回向量（`searchVector` 只回 key/rank），
 * 寫入端只要字面值即可；`pgvector.toSql` 也只吃 `number[]`（實測吃 `Float32Array` 會拋錯）。
 */
export function toVectorLiteral(vec: Float32Array): string {
  const parts = new Array<string>(vec.length);
  for (let i = 0; i < vec.length; i += 1) parts[i] = String(vec[i]);
  return `[${parts.join(",")}]`;
}

/**
 * pgvector 欄位型別字串的維度（`vector(512)` → 512）；非「帶維度的 vector」型別回傳 `null`。
 *
 * `format_type` 在型別不在 `search_path` 時會加 schema 前綴（例如 `public.vector(512)`），
 * 因此允許一個選用的 schema 限定詞。
 */
function parseVectorColumnDim(typeName: string): number | null {
  const match = /^(?:[A-Za-z_][A-Za-z0-9_]*\.)?vector\((\d+)\)$/.exec(typeName.trim());
  return match === null ? null : Number(match[1]);
}

/**
 * 建表 DDL（冪等）。
 *
 * - `embedding vector(N)`：維度寫死在型別，`dim` 由建構子決定。
 * - `seq bigint generated always as identity`：**單調遞增序**，用來重現「覆寫＝刪除後重插」
 *   的 tie 排序（見 `upsert` 的說明）。
 * - HNSW ＋ `vector_cosine_ops`：可在空表建立（migrate 友善），查詢時另開 iterative scan。
 * - `root_id` 是一般整數欄（沒有 vec0 的 partition key 概念）；`NULL` 代表全域物件（記憶）。
 *
 * 冪等只代表「重複呼叫不出錯」：表已存在時**不會**改既有結構。因此維度變更不會被這段 DDL
 * 反映，`migrate()` 會先檢查既有欄位維度並在不符時拋 `VectorColumnDimensionError`。
 */
function vectorSchemaSql(schema: string, dim: number): string {
  const vectors = qualified(schema, "vectors");
  return `
    create table if not exists ${vectors} (
      key text primary key,
      root_id integer,
      embedder_id text not null,
      embedding vector(${dim}) not null,
      seq bigint generated always as identity
    );
    create index if not exists vectors_root_idx on ${vectors}(root_id);
    create index if not exists vectors_hnsw on ${vectors} using hnsw (embedding vector_cosine_ops);
  `;
}

/**
 * `VectorIndex` 的 pgvector 實作。
 *
 * 距離用 cosine（`<=>`）；輸入向量已 L2 正規化，因此 cosine 與 L2 的排序相同。
 *
 * 兩個關鍵實作決定（研究筆記「實測坑位」）：
 * 1. **tie 排序**：pgvector 不保證距離相同時的順序。契約要求「同 key 覆寫後排在後面」，
 *    因此 `upsert` 實作成 **delete＋insert**，配合單調遞增的 `seq` 欄位，查詢時
 *    `ORDER BY distance, seq`，模仿 sqlite-vec 的 rowid（插入序）行為。
 * 2. **帶 rootIds 的過濾**：近似索引的過濾是在 index scan 之後才套用，預設會少給結果；
 *    每個查詢前在交易內 `SET LOCAL hnsw.iterative_scan = strict_order` 才會回滿。
 *    仍受 `hnsw.max_scan_tuples`（預設 20000）上限影響，詳見 `docs/storage-ports.md` 的「PostgreSQL 後端」一節。
 */
export class PgVectorIndex implements VectorIndex {
  readonly dim: number;

  private readonly pool: Pool;
  private readonly vectors: string;
  private readonly schema: string;

  constructor(pool: Pool, options: PgVectorIndexOptions = {}) {
    const dim = options.dim ?? DEFAULT_DIM;
    if (!Number.isInteger(dim) || dim <= 0) {
      throw new Error(`向量維度必須是正整數，收到 ${String(dim)}`);
    }
    this.pool = pool;
    this.dim = dim;
    this.schema = options.schema ?? "public";
    this.vectors = qualified(this.schema, "vectors");
  }

  /** 建立 pgvector 擴充與向量表／索引；可重複呼叫（冪等）。 */
  async migrate(): Promise<void> {
    // 先單獨建立擴充：`vector` 型別要在後續 DDL 的型別解析時就存在。
    await this.pool.query("create extension if not exists vector");
    // 維度檢查必須在 DDL 之前：`create table if not exists` 不會驗證、也不會改既有欄位型別。
    await this.assertExistingEmbeddingDim();
    await this.pool.query(vectorSchemaSql(this.schema, this.dim));
  }

  /**
   * 檢查既有的 `vectors.embedding` 欄位維度；與本次 `dim` 不符就拋 `VectorColumnDimensionError`。
   *
   * 表或欄位不存在時直接返回，交給 `migrate()` 的 DDL 建立（表不存在是正常首跑情境）。
   * 用 `format_type(atttypid, atttypmod)` 取得**帶維度的型別名**（如 `vector(512)`）再解析數字，
   * 不直接解讀 `atttypmod`：pgvector 的 typmod 編碼不保證等於維度。
   * 維度不符時只拋錯，**不**靜默 drop 表或改欄位型別。
   */
  private async assertExistingEmbeddingDim(): Promise<void> {
    const result = await this.pool.query(
      `select format_type(a.atttypid, a.atttypmod) as type
         from pg_attribute a
         join pg_class c on c.oid = a.attrelid
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = $1
          and c.relname = 'vectors'
          and a.attname = 'embedding'
          and a.attnum > 0
          and not a.attisdropped`,
      [this.schema],
    );

    const row = result.rows[0];
    if (row === undefined) return;

    const actualType = String(row.type);
    const actual = parseVectorColumnDim(actualType);
    if (actual !== this.dim) {
      throw new VectorColumnDimensionError(this.dim, actual, actualType, this.schema, "vectors");
    }
  }

  /**
   * 寫入或覆寫。先驗證所有向量（維度、正規化），任何一筆不合格就整批不寫。
   * 覆寫以 delete＋insert 實作，讓 `seq` 遞增（見類別說明）。
   */
  async upsert(items: VectorItem[]): Promise<void> {
    if (items.length === 0) return;

    for (const item of items) {
      if (item.vec.length !== this.dim) {
        throw new VectorDimensionError(this.dim, item.vec.length);
      }
      const norm = vectorNorm(item.vec);
      if (!Number.isFinite(norm) || Math.abs(norm - 1) > NORMALIZATION_TOLERANCE) {
        throw new VectorNotNormalizedError(norm, NORMALIZATION_TOLERANCE, item.key);
      }
    }

    await withTransaction(this.pool, async (client) => {
      for (const item of items) {
        await client.query(`delete from ${this.vectors} where key = $1`, [item.key]);
        await client.query(
          `insert into ${this.vectors}(key, root_id, embedder_id, embedding) values ($1, $2, $3, $4::vector)`,
          [item.key, item.rootId, item.embedderId, toVectorLiteral(item.vec)],
        );
      }
    });
  }

  async deleteByKeys(keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    await this.pool.query(`delete from ${this.vectors} where key = any($1::text[])`, [keys]);
  }

  async deleteByRoot(rootId: number): Promise<void> {
    await this.pool.query(`delete from ${this.vectors} where root_id = $1`, [rootId]);
  }

  async searchVector(vec: Float32Array, filter: SearchFilter, k: number): Promise<RankedHit[]> {
    if (vec.length !== this.dim) {
      throw new VectorDimensionError(this.dim, vec.length);
    }
    if (k <= 0) return [];

    const rootIds = filter.rootIds;
    // 指定空的 rootIds＝沒有任何可見 root。
    if (rootIds !== undefined && rootIds.length === 0) return [];

    const limit = Math.min(k, MAX_SEARCH_K);

    const rows = await withTransaction(this.pool, async (client) => {
      // SET LOCAL 只在交易內有效、且只影響這條連線；連線歸還池後不殘留。
      await client.query("set local hnsw.iterative_scan = strict_order");
      const result = await client.query(
        `select key from ${this.vectors}
          where ($1::int[] is null or root_id = any($1::int[]))
          order by embedding <=> $2::vector, seq
          limit $3`,
        [rootIds ?? null, toVectorLiteral(vec), limit],
      );
      return result.rows;
    });

    return rows.map((row, index) => ({ key: String(row.key), rank: index + 1 }));
  }

  async count(): Promise<number> {
    const result = await this.pool.query(`select count(*) as count from ${this.vectors}`);
    return Number(result.rows[0]?.count ?? 0);
  }

  async existingKeys(keys: string[]): Promise<Set<string>> {
    const found = new Set<string>();
    if (keys.length === 0) return found;
    const result = await this.pool.query(`select key from ${this.vectors} where key = any($1::text[])`, [keys]);
    for (const row of result.rows) found.add(String(row.key));
    return found;
  }

  async embedderIds(): Promise<string[]> {
    const result = await this.pool.query(
      `select distinct embedder_id as id from ${this.vectors} order by embedder_id`,
    );
    return result.rows.map((row) => String(row.id));
  }
}
