import { selectRows } from "../driver.js";
import type { Migration } from "./0001_init.js";

/**
 * 0008：per-root 影片單檔大小上限（nullable，舊資料列為 NULL）。
 *
 * 為什麼 nullable 而不是 not null default 512 MiB：NULL 代表「未設定，沿用行程層預設」，
 * 與「使用者明確設成 512 MiB」語意不同（後者不會隨 `MNEMOSHELF_VIDEO_MAX_FILE_BYTES` 改變）。
 * 舊 row 一律 NULL，讀回時物件不出現 `videoMaxFileBytes` 鍵；不補值、不改寫任何資料。
 *
 * 冪等：用 `pragma table_info` 檢查欄位存在才加，重跑安全。
 */
export const migration0008RootVideoMaxFileBytes: Migration = {
  id: "0008_root_video_max_file_bytes",
  up(db): void {
    const columns = selectRows(db, "pragma table_info(roots)").map((row) => String(row.name));
    if (!columns.includes("video_max_file_bytes")) db.exec("alter table roots add column video_max_file_bytes integer;");
  },
};
