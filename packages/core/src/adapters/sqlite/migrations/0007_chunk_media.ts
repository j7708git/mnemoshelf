import { selectRows } from "../driver.js";
import type { Migration } from "./0001_init.js";

/** 音訊片段定位；既有資料保留，欄位為 NULL，不改寫檔案內容或向量。 */
export const migration0007ChunkMedia: Migration = {
  id: "0007_chunk_media",
  up(db): void {
    const columns = selectRows(db, "pragma table_info(chunks)").map((row) => String(row.name));
    if (!columns.includes("media_json")) db.exec("alter table chunks add column media_json text;");
  },
};
