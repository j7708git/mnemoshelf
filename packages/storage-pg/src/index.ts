/**
 * `@mnemoshelf/storage-pg`：Mnemoshelf 的第二儲存後端。
 *
 * 以 PostgreSQL＋pgvector 實作 core 的兩個窄 port（`MetadataStore`、`VectorIndex`），
 * 通過 core 既有的契約測試（`@mnemoshelf/core/testing`），驗證「儲存可替換」的抽象。
 * 不改動 core 的任何程式碼或公開契約。
 */
export { PgMetadataStore, type PgMetadataStoreOptions } from "./metadata-store.js";
export {
  MAX_SEARCH_K,
  PgVectorIndex,
  toVectorLiteral,
  type PgVectorIndexOptions,
} from "./vector-index.js";
export { createPgPool, withTransaction, type CreatePgPoolOptions } from "./connection.js";
export { segmentText } from "./segment.js";
