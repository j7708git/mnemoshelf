import { VectorDimensionError, VectorNotNormalizedError } from "../../errors.js";
import type { RankedHit, SearchFilter } from "../../ports/types.js";
import type { VectorIndex, VectorItem } from "../../ports/vector-index.js";
import { DEFAULT_DIM } from "./db.js";
import { selectRow, selectRows, type SqliteDatabase } from "./driver.js";

/** 向量正規化的容差（embedder-contract.md：模長 1，容差 1e-3）。 */
export const NORMALIZATION_TOLERANCE = 1e-3;

/** sqlite-vec 0.1.9 的 KNN `k` 硬上限（spike 實測，文件未載）。 */
export const MAX_KNN_K = 4096;

/** 量測向量的 L2 模長。 */
export function vectorNorm(vec: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < vec.length; i += 1) {
    const value = vec[i];
    sum += value * value;
  }
  return Math.sqrt(sum);
}

/**
 * VectorIndex 的 sqlite-vec 實作。
 *
 * 實作細節（依 spike 筆記 §8）：
 * - `root_id` 以 **partition key** 宣告，過濾發生在掃描之前（實測比 metadata column
 *   快約 6 倍，且精確）。
 * - `rootId: null`（全域物件）以 SQL NULL 存入 partition key：未指定過濾時會被掃到，
 *   指定 `rootIds` 時自然被 `in (...)` 排除。
 * - vec0 不支援 `insert or replace`，upsert 以「先 delete by key 再 insert」在同一個
 *   交易內完成。
 * - vec0 的 integer 欄位必須以 BigInt 綁定（實測：傳 JS number 會被視為 FLOAT 而拒收）。
 */
export class SqliteVectorIndex implements VectorIndex {
  readonly dim: number;

  private readonly db: SqliteDatabase;

  constructor(db: SqliteDatabase, dim: number = DEFAULT_DIM) {
    if (!Number.isInteger(dim) || dim <= 0) {
      throw new Error(`向量維度必須是正整數，收到 ${String(dim)}`);
    }
    this.db = db;
    this.dim = dim;
    this.ensureSchema();
  }

  /** 建立 vec0 表並檢查維度一致；可重複呼叫。 */
  private ensureSchema(): void {
    this.db.exec(`
      create table if not exists vector_meta (
        id integer primary key check (id = 1),
        dim integer not null,
        created_at text not null
      );
    `);

    const existing = selectRow(this.db, "select dim from vector_meta where id = 1");
    if (existing === undefined) {
      this.db
        .prepare("insert into vector_meta(id, dim, created_at) values (1, ?, ?)")
        .run(this.dim, new Date().toISOString());
    } else if (Number(existing.dim) !== this.dim) {
      throw new Error(`向量索引既有維度為 ${Number(existing.dim)}，與要求的 ${this.dim} 不符（換 embedder 需重建索引）`);
    }

    this.db.exec(`
      create virtual table if not exists vectors using vec0(
        key text primary key,
        root_id integer partition key,
        embedder_id text,
        embedding float[${this.dim}]
      );
    `);
  }

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

    const remove = this.db.prepare("delete from vectors where key = ?");
    const insert = this.db.prepare(
      "insert into vectors(key, root_id, embedder_id, embedding) values (?, ?, ?, ?)",
    );

    const write = this.db.transaction((rows: VectorItem[]) => {
      for (const row of rows) {
        remove.run(row.key);
        insert.run(
          row.key,
          row.rootId === null ? null : BigInt(row.rootId),
          row.embedderId,
          Buffer.from(row.vec.buffer, row.vec.byteOffset, row.vec.byteLength),
        );
      }
    });

    write(items);
  }

  async deleteByKeys(keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    const remove = this.db.prepare("delete from vectors where key = ?");
    const run = this.db.transaction((items: string[]) => {
      for (const key of items) remove.run(key);
    });
    run(keys);
  }

  async deleteByRoot(rootId: number): Promise<void> {
    this.db.prepare("delete from vectors where root_id = ?").run(BigInt(rootId));
  }

  async searchVector(vec: Float32Array, filter: SearchFilter, k: number): Promise<RankedHit[]> {
    if (vec.length !== this.dim) {
      throw new VectorDimensionError(this.dim, vec.length);
    }
    if (k <= 0) return [];

    const rootIds = filter.rootIds;
    // 指定空的 rootIds 表示「沒有任何 root 可見」→ 沒有結果。
    if (rootIds !== undefined && rootIds.length === 0) return [];

    const limit = Math.min(k, MAX_KNN_K);
    const blob = Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);

    const sql =
      rootIds === undefined
        ? "select key, distance from vectors where embedding match ? and k = ? order by distance"
        : `select key, distance from vectors
             where embedding match ? and k = ? and root_id in (${rootIds.map(() => "?").join(", ")})
             order by distance`;

    const params: unknown[] =
      rootIds === undefined ? [blob, limit] : [blob, limit, ...rootIds.map((id) => BigInt(id))];

    const rows = selectRows(this.db, sql, ...params);
    return rows.map((row, index) => ({ key: String(row.key), rank: index + 1 }));
  }

  async count(): Promise<number> {
    const row = selectRow(this.db, "select count(*) as count from vectors");
    return Number(row?.count ?? 0);
  }

  async existingKeys(keys: string[]): Promise<Set<string>> {
    const found = new Set<string>();
    if (keys.length === 0) return found;

    // vec0 的 WHERE 只保證支援主鍵（key）等值查詢，因此逐鍵查；每檔的 chunk 數不多。
    const statement = this.db.prepare<unknown[], { key: unknown }>("select key from vectors where key = ?");
    for (const key of keys) {
      if (statement.get(key) !== undefined) found.add(key);
    }
    return found;
  }

  async embedderIds(): Promise<string[]> {
    return selectRows(this.db, "select distinct embedder_id as id from vectors order by embedder_id").map((row) =>
      String(row.id),
    );
  }
}
