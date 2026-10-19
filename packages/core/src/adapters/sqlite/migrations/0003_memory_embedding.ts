import { selectRows } from "../driver.js";
import type { Migration } from "./0001_init.js";

/**
 * 0003_memory_embedding：為 memories 補上向量欄位（卡 B1 記憶語意化基礎）。
 *
 * - `embedding blob`：向量以 little-endian float32 位元組儲存；未嵌入時為 NULL。
 * - `embedding_embedder_id text`：產生這個向量的 embedder 身分（換 embedder 後視為 stale）。
 * - `embedding_state text not null default 'pending'`：狀態機（見 `MemoryEmbeddingState`）。
 *
 * 既有資料（含已軟刪除者）一律預設 `pending`，但回填流程只處理未刪除者（由 worker 負責）。
 * SQLite 的 `alter table add column` 沒有 `if not exists`（也不能帶 `not null` 的 non-constant
 * default 以外限制），因此先查 `pragma table_info` 再逐欄補上，維持「`up` 冪等」的約定。
 */
export const migration0003MemoryEmbedding: Migration = {
  id: "0003_memory_embedding",
  up(db): void {
    const columns = selectRows(db, "pragma table_info(memories)").map((row) => String(row.name));
    if (!columns.includes("embedding")) {
      db.exec("alter table memories add column embedding blob;");
    }
    if (!columns.includes("embedding_embedder_id")) {
      db.exec("alter table memories add column embedding_embedder_id text;");
    }
    if (!columns.includes("embedding_state")) {
      // 既有資料列會自動取得預設值 'pending'（SQLite 允許 constant default 的 add column）。
      db.exec("alter table memories add column embedding_state text not null default 'pending';");
    }
  },
};
