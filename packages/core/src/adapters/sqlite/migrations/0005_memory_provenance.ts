import { selectRows } from "../driver.js";
import type { Migration } from "./0001_init.js";

/**
 * 0005_memory_provenance：為 memories 補上來源欄位（D4a；讓每筆記憶能回答「誰寫的、
 * 哪個 session、什麼時候」——`createdAt` 已存在，這裡只補後兩者）。
 *
 * - `source_session text`：寫入端的 session 識別（不透明字串，可為 NULL）。
 * - `source_message text`：寫入端的訊息識別（不透明字串，可為 NULL）。
 *
 * 兩者都是**可空的 additive 欄位**：既有資料列保持原值、這兩欄為 NULL；
 * 不重建表、不動任何既有欄位，也不改匯出的 `schemaVersion`。
 * 沒有 down migration（與 0001～0004 的慣例一致：本專案的遷移只往前）。
 *
 * SQLite 的 `alter table add column` 沒有 `if not exists`，因此先查 `pragma table_info`
 * 再逐欄補上，維持「`up` 冪等」的約定。
 */
export const migration0005MemoryProvenance: Migration = {
  id: "0005_memory_provenance",
  up(db): void {
    const columns = selectRows(db, "pragma table_info(memories)").map((row) => String(row.name));
    if (!columns.includes("source_session")) {
      db.exec("alter table memories add column source_session text;");
    }
    if (!columns.includes("source_message")) {
      db.exec("alter table memories add column source_message text;");
    }
  },
};
