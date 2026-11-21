import type { Migration } from "./0001_init.js";

/** 記憶自動注入設定（單列）：全域預設模式與逐專案覆寫；冪等。 */
export const migration0011MemoryAutoInject: Migration = {
  id: "0011_memory_auto_inject",
  up(db) {
    db.exec(`create table if not exists memory_auto_inject_settings (
      id integer primary key check (id = 1),
      revision integer not null,
      default_mode text not null,
      projects_json text not null);
      insert or ignore into memory_auto_inject_settings (id, revision, default_mode, projects_json) values (1, 1, 'all', '{}');`);
  },
};
