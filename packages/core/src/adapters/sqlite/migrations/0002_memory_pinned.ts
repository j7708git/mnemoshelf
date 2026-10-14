import { selectRows } from "../driver.js";
import type { Migration } from "./0001_init.js";

/**
 * 0002_memory_pinned：為 memories 補上 `pinned` 欄位（M3 記憶釘選）。
 *
 * 既有資料庫的既有資料預設 `0`（false）；新資料庫也會經過此遷移（0001 先建表、這裡補欄位）。
 * SQLite 的 `alter table add column` 沒有 `if not exists`，因此先查 `pragma table_info`
 * 再決定是否補欄位，維持「`up` 必須冪等」的約定。
 */
export const migration0002MemoryPinned: Migration = {
  id: "0002_memory_pinned",
  up(db): void {
    const columns = selectRows(db, "pragma table_info(memories)").map((row) => String(row.name));
    if (!columns.includes("pinned")) {
      db.exec("alter table memories add column pinned integer not null default 0;");
    }
  },
};
