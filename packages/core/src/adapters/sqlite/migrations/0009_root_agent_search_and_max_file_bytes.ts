import { selectRows } from "../driver.js";
import type { Migration } from "./0001_init.js";

/**
 * 0009：root 的 agent 分享開關與通用單檔大小上限。
 *
 * - `allow_agent_search`：`not null default 0`。既有 roots 升級後一律 `false`（預設關閉）；
 *   值只有 true／false，沒有「未設定」語意。
 * - `max_file_bytes`：nullable。NULL 代表「未設定，沿用服務層預設 10 MiB」，與「使用者明確
 *   設成 10 MiB」語意不同（後者不會隨服務層預設改變）。舊 row 一律 NULL，讀回時物件不出現
 *   `maxFileBytes` 鍵；不補值、不改寫任何資料。
 *
 * 冪等：用 `pragma table_info` 檢查欄位存在才加，重跑安全。
 */
export const migration0009RootAgentSearchAndMaxFileBytes: Migration = {
  id: "0009_root_agent_search_and_max_file_bytes",
  up(db): void {
    const columns = selectRows(db, "pragma table_info(roots)").map((row) => String(row.name));
    if (!columns.includes("allow_agent_search")) {
      db.exec("alter table roots add column allow_agent_search integer not null default 0;");
    }
    if (!columns.includes("max_file_bytes")) db.exec("alter table roots add column max_file_bytes integer;");
  },
};
