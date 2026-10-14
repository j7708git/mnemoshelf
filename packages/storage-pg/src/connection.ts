import { Pool, type PoolClient } from "pg";

/** `createPgPool` 的選項。 */
export interface CreatePgPoolOptions {
  /** 連線池上限；省略時用 `pg` 的預設值。 */
  max?: number;
}

/**
 * 建立 PostgreSQL 連線池。
 *
 * 連線字串由呼叫端提供（本機服務或契約測試的 testcontainers 容器皆同）；
 * 本套件不自行讀取環境變數，避免把「服務設定」的職責帶進儲存層。
 */
export function createPgPool(connectionString: string, options: CreatePgPoolOptions = {}): Pool {
  return new Pool({
    connectionString,
    ...(options.max === undefined ? {} : { max: options.max }),
  });
}

/**
 * 在單一連線上跑一段交易：`begin` → `fn(client)` → `commit`；`fn` 拋錯時 `rollback`。
 *
 * 為什麼一定要固定同一條連線：`pg` 的 `Pool` 不保證後續查詢回到同一條連線，
 * 而 `SET LOCAL`（例如 `hnsw.iterative_scan`）只在交易內、且只對該連線有效。
 * 交易結束後連線歸還池中，設定不會殘留到其他查詢。
 */
export async function withTransaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (error) {
    try {
      await client.query("rollback");
    } catch {
      // 交易可能已因錯誤中止，rollback 也會失敗；保留原始錯誤往上拋。
    }
    throw error;
  } finally {
    client.release();
  }
}
