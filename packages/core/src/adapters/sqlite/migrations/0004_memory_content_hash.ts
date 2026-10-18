import { memoryContentHash } from "../../../memory/content-normalize.js";
import { selectRows } from "../driver.js";
import type { Migration } from "./0001_init.js";

/**
 * 0004_memory_content_hash：為 memories 補上 `content_hash` 欄位與索引（寫入去重）。
 *
 * - `content_hash text`：記憶內容經 `memoryContentHash`（Unicode NFC → trim → 連續空白收斂，
 *   再取 sha256 hex）後的結果；**只存 hash、不含原文**，只在本機資料庫內使用。
 * - 既有資料列在遷移時同步回填（資料量小）；已軟刪除者同樣回填，但去重只看未刪除者。
 *
 * SQLite 的 `alter table add column` 沒有 `if not exists`（與 0002／0003 相同），因此先查
 * `pragma table_info` 再決定是否補欄位；索引與回填都以「`content_hash is null`」為條件，
 * 重複執行（例如中斷後重跑、或欄位已存在但回填未完成）不會重算或覆寫既有值，維持冪等。
 */
export const migration0004MemoryContentHash: Migration = {
  id: "0004_memory_content_hash",
  up(db): void {
    const columns = selectRows(db, "pragma table_info(memories)").map((row) => String(row.name));
    if (!columns.includes("content_hash")) {
      db.exec("alter table memories add column content_hash text;");
    }
    db.exec("create index if not exists idx_memories_content_hash on memories(content_hash);");

    const pending = selectRows(db, "select id, content from memories where content_hash is null");
    if (pending.length === 0) return;
    const update = db.prepare("update memories set content_hash = ? where id = ? and content_hash is null");
    for (const row of pending) {
      update.run(memoryContentHash(String(row.content)), Number(row.id));
    }
  },
};
