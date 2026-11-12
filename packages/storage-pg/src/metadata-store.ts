import {
  DuplicateRootError,
  MemorySourceConflictError,
  assertMemoryEmbeddingCursor,
  assertMemoryEmbeddingFailure,
  assertMemoryEmbeddingInput,
  assertMemoryQueryVector,
  assertMemorySourceChunks,
  memoryContentHash,
  memorySourceEventHash,
  normalizeMemoryLimit,
  normalizeChunkMedia,
  normalizeMemoryPatch,
  normalizeMemorySearchFilter,
  normalizeMemorySearchK,
  normalizeMemorySourceEventCheck,
  normalizeMemorySourceScope,
  readMemoryPolicy,
  validateMemorySourceWrite,
  type Chunk,
  type ChunkKind,
  type Memory,
  type MemoryEmbeddingFailure,
  type MemoryEmbeddingStats,
  type MemoryFilter,
  type MemoryKeywordHit,
  type MemoryKind,
  type MemoryPatch,
  type MemoryPolicy,
  type MemoryScope,
  type MemorySearchFilter,
  type MemorySource,
  type MemorySourceEventCheck,
  type MemorySourceMessage,
  type MemorySourceWriteResult,
  type MemoryVectorHit,
  type MetadataStore,
  type Modality,
  type NewChunk,
  type NewMemory,
  type NewMemorySource,
  type NewMemorySourceChunk,
  type NewRoot,
  type NormalizedMemorySearchFilter,
  type RankedHit,
  type Root,
  type RootMode,
  type RootPatch,
  type SearchFilter,
} from "@mnemoshelf/core";
import type { Pool, PoolClient } from "pg";
import { qualified } from "./schema.js";
import { segmentText } from "./segment.js";
import { withTransaction } from "./connection.js";
import { toVectorLiteral } from "./vector-index.js";

/** `PgMetadataStore` 的選項。 */
export interface PgMetadataStoreOptions {
  /** 資料表所在的 schema；省略時用 `public`。契約測試每個測試用一個臨時 schema。 */
  schema?: string;
}

/**
 * root 影片上限的值域（與 core `ports/metadata-store.ts` 的 `normalizeRootVideoMaxFileBytes` 同值）。
 *
 * 為什麼暫行重複：storage-pg 只從 `@mnemoshelf/core` 的公開入口 import，而該驗證器目前
 * 還沒被 PM 統一 export（見 notes 遺留項）；PM export 後應改 import 單一來源。
 */
const VIDEO_MAX_FILE_BYTES_MIN = 1;
const VIDEO_MAX_FILE_BYTES_MAX = 16 * 1024 * 1024 * 1024;

/** 驗證 root 影片上限；語意與 core 的 `normalizeRootVideoMaxFileBytes` 完全相同。 */
function normalizeRootVideoMaxFileBytes(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < VIDEO_MAX_FILE_BYTES_MIN ||
    value > VIDEO_MAX_FILE_BYTES_MAX
  ) {
    throw new TypeError("root 的影片單檔大小上限必須是 1–16 GiB 的整數（bytes）");
  }
  return value;
}

/**
 * root 通用單檔上限的值域（與 core `ports/metadata-store.ts` 的 `normalizeRootMaxFileBytes` 同值）。
 *
 * 為什麼重複一份：storage-pg 只從 `@mnemoshelf/core` 的公開入口 import；兩個後端都必須
 * 在沒有 core 執行期相依的情況下驗證，語意以 core 為準（見該函式的契約註解）。
 */
const MAX_FILE_BYTES_MIN = 1;
const MAX_FILE_BYTES_MAX = 16 * 1024 * 1024 * 1024;

/** 驗證 root 通用單檔上限；語意與 core 的 `normalizeRootMaxFileBytes` 完全相同。 */
function normalizeRootMaxFileBytes(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < MAX_FILE_BYTES_MIN ||
    value > MAX_FILE_BYTES_MAX
  ) {
    throw new TypeError("root 的單檔大小上限必須是 1–16 GiB 的整數（bytes）");
  }
  return value;
}

const ROOT_COLUMNS =
  "id, path, mode, modalities, include_rules, exclude_rules, respect_gitignore, watch, created_at, allow_agent_search, max_file_bytes, video_max_file_bytes";
const CHUNK_COLUMNS = "id, root_id, rel_path, seq, kind, text, content_hash, media_json";
const MEMORY_COLUMNS =
  `id, content, kind, scope, project, agent, supersedes, pinned, source_session, source_message, created_at, deleted_at,
   source_id, message_index, chunk_index, source_start, source_end, chunk_version`;
const MEMORY_SOURCE_COLUMNS =
  "id, agent, scope, project, source_session, source_turn, messages_json, request_hash, chunk_version, created_at, deleted_at";

/** `pg` 的 unique violation 錯誤碼（SQLite 是字串比對，PostgreSQL 是 SQLSTATE）。 */
const UNIQUE_VIOLATION = "23505";

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === UNIQUE_VIOLATION;
}

function parseStringArray(value: unknown): string[] {
  if (typeof value !== "string") return [];
  const parsed: unknown = JSON.parse(value);
  return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
}

function rowToRoot(row: Record<string, unknown>): Root {
  const root: Root = {
    id: Number(row.id),
    path: String(row.path),
    mode: String(row.mode) as RootMode,
    modalities: parseStringArray(row.modalities) as Modality[],
    include: parseStringArray(row.include_rules),
    exclude: parseStringArray(row.exclude_rules),
    respectGitignore: row.respect_gitignore === true,
    watch: row.watch === true,
    createdAt: String(row.created_at),
    allowAgentSearch: row.allow_agent_search === true,
  };
  // pg 的 bigint 以字串回傳（16 GiB > int4）：轉成 number；NULL → 不出現該鍵。
  if (row.max_file_bytes !== null && row.max_file_bytes !== undefined) {
    root.maxFileBytes = Number(row.max_file_bytes);
  }
  // pg 的 bigint 以字串回傳（16 GiB > int4）：轉成 number；NULL → 不出現該鍵。
  if (row.video_max_file_bytes !== null && row.video_max_file_bytes !== undefined) {
    root.videoMaxFileBytes = Number(row.video_max_file_bytes);
  }
  return root;
}

function rowToChunk(row: Record<string, unknown>): Chunk {
  const media = normalizeChunkMedia(row.media_json == null ? undefined : JSON.parse(String(row.media_json)));
  return {
    id: Number(row.id),
    rootId: Number(row.root_id),
    relPath: String(row.rel_path),
    seq: Number(row.seq),
    kind: String(row.kind) as ChunkKind,
    text: row.text === null || row.text === undefined ? null : String(row.text),
    contentHash: String(row.content_hash),
    ...(media === undefined ? {} : { media }),
  };
}

function rowToMemory(row: Record<string, unknown>): Memory {
  return {
    id: Number(row.id),
    content: String(row.content),
    kind: String(row.kind) as MemoryKind,
    scope: String(row.scope) as MemoryScope,
    project: row.project === null || row.project === undefined ? null : String(row.project),
    agent: String(row.agent),
    supersedes: row.supersedes === null || row.supersedes === undefined ? null : Number(row.supersedes),
    pinned: row.pinned === true,
    sourceSession: row.source_session === null || row.source_session === undefined ? null : String(row.source_session),
    sourceMessage: row.source_message === null || row.source_message === undefined ? null : String(row.source_message),
    sourceId: row.source_id == null ? null : Number(row.source_id),
    messageIndex: row.message_index == null ? null : Number(row.message_index),
    chunkIndex: row.chunk_index == null ? null : Number(row.chunk_index),
    sourceStart: row.source_start == null ? null : Number(row.source_start),
    sourceEnd: row.source_end == null ? null : Number(row.source_end),
    chunkVersion: row.chunk_version == null ? null : String(row.chunk_version),
    createdAt: String(row.created_at),
    deletedAt: row.deleted_at === null || row.deleted_at === undefined ? null : String(row.deleted_at),
  };
}

function rowToMemorySource(row: Record<string, unknown>): MemorySource {
  return {
    id: Number(row.id),
    agent: String(row.agent),
    scope: String(row.scope) as MemoryScope,
    project: row.project == null ? null : String(row.project),
    sourceSession: String(row.source_session),
    sourceTurn: String(row.source_turn),
    messages: JSON.parse(String(row.messages_json)) as MemorySourceMessage[],
    requestHash: String(row.request_hash),
    chunkVersion: String(row.chunk_version),
    createdAt: String(row.created_at),
    deletedAt: row.deleted_at == null ? null : String(row.deleted_at),
  };
}

/** 文字轉成存入 `seg` 欄位的斷詞結果；空白內容回傳 null（該列不進 FTS）。 */
function segmentOrNull(text: string | null): string | null {
  if (text === null || text.trim().length === 0) return null;
  return segmentText(text);
}

/** PostgreSQL 的記憶檢索 WHERE（`m` 是 memories 的別名；**先過濾、後排名**）。 */
interface PgMemorySearchWhere {
  clause: string;
  params: unknown[];
}

/**
 * 把正規化後的 `MemorySearchFilter` 組成 PostgreSQL WHERE 子句（卡 B2；兩方法共用）。
 *
 * `firstParamIndex` 是第一個可用的參數編號（呼叫端可能已用掉 $1..）：filter 參數會依序佔用
 * `firstParamIndex`、`firstParamIndex+1`…；bucket 之間 OR、`kind` 與 bucket 群組 AND。
 */
function buildPgMemorySearchWhere(filter: NormalizedMemorySearchFilter, firstParamIndex: number): PgMemorySearchWhere {
  const conditions = ["m.deleted_at is null"];
  const params: unknown[] = [];
  const placeholder = (): string => `$${firstParamIndex + params.length}`;

  if (filter.kind !== undefined) {
    conditions.push(`m.kind = ${placeholder()}`);
    params.push(filter.kind);
  }

  const buckets = filter.buckets;
  if (buckets !== undefined) {
    const parts: string[] = [];
    for (const bucket of buckets) {
      if (bucket.scope === "global") {
        parts.push("m.scope = 'global'");
        continue;
      }
      if (bucket.scope === "project") {
        if (bucket.project === undefined) {
          parts.push("m.scope = 'project'");
          continue;
        }
        parts.push(`(m.scope = 'project' and m.project = ${placeholder()})`);
        params.push(bucket.project);
        continue;
      }
      // scope === "agent"（正規化時已保證 agent 非空）
      parts.push(`(m.scope = 'agent' and m.agent = ${placeholder()})`);
      params.push(bucket.agent);
    }
    conditions.push(`(${parts.join(" or ")})`);
  }

  return { clause: conditions.join(" and "), params };
}

/**
 * 建表 DDL（冪等）。全部使用 schema 限定的表名。
 *
 * 與 SQLite 後端的對應（見研究筆記「Schema 對應地圖」）：
 * - `id` 用 `int4`（`pg` 對 `int8` 會回字串，契約要比對數字）；`created_at` 用 `text` ISO 字串，
 *   字典序＝時間序，與 SQLite 完全同位（`timestamptz` 會被 `pg` 回成 `Date`，反而要多一層轉換）。
 * - 刻意**不宣告** chunks→roots 的外鍵：`removeRoot(deleteData=false)` 會刪 root 列卻保留 chunks。
 * - 全文檢索不用虛擬表：`seg`（斷詞結果）＋ generated `tsvector('simple', seg)`＋ GIN。
 *   generated column 讓 tsvector 自動同步，省掉 SQLite 端手動維護 FTS 列的四個路徑。
 */
function metadataSchemaSql(schema: string): string {
  const roots = qualified(schema, "roots");
  const chunks = qualified(schema, "chunks");
  const memories = qualified(schema, "memories");
  const sources = qualified(schema, "memory_sources");
  const deletedSources = qualified(schema, "deleted_memory_sources");
  const policy = qualified(schema, "memory_policy");
  return `
    create table if not exists ${roots} (
      id integer generated always as identity primary key,
      path text not null unique,
      mode text not null,
      modalities text not null default '[]',
      include_rules text not null default '[]',
      exclude_rules text not null default '[]',
      respect_gitignore boolean not null default true,
      watch boolean not null default false,
      created_at text not null,
      allow_agent_search boolean not null default false,
      max_file_bytes bigint,
      video_max_file_bytes bigint
    );
    alter table ${roots} add column if not exists allow_agent_search boolean not null default false;
    alter table ${roots} add column if not exists max_file_bytes bigint;
    alter table ${roots} add column if not exists video_max_file_bytes bigint;

    create table if not exists ${chunks} (
      id integer generated always as identity primary key,
      root_id integer not null,
      rel_path text not null,
      seq integer not null,
      kind text not null,
      text text,
      content_hash text not null,
      seg text,
      tsv tsvector generated always as (to_tsvector('simple', seg)) stored
    );
    alter table ${chunks} add column if not exists media_json text;
    create index if not exists chunks_root_path_idx on ${chunks}(root_id, rel_path);
    create index if not exists chunks_tsv_gin on ${chunks} using gin (tsv);

    create table if not exists ${memories} (
      id integer generated always as identity primary key,
      content text not null,
      kind text not null,
      scope text not null,
      project text,
      agent text not null,
      supersedes integer,
      pinned boolean not null default false,
      source_session text,
      source_message text,
      created_at text not null,
      deleted_at text,
      content_hash text,
      seg text,
      tsv tsvector generated always as (to_tsvector('simple', seg)) stored
    );
    create index if not exists memories_tsv_gin on ${memories} using gin (tsv);

    -- 既有資料庫（本卡之前建立的表）補上 pinned；冪等，重複執行無害。
    alter table ${memories} add column if not exists pinned boolean not null default false;

    -- 卡 C2：寫入去重用的內容 hash（正規化後內容的 sha256；只存 hash、不含原文）。
    alter table ${memories} add column if not exists content_hash text;
    create index if not exists memories_content_hash_idx on ${memories}(content_hash);

    -- 卡 B1：記憶向量欄位。vector 刻意「不帶維度」（換 embedder／維度時由回填流程重算，
    -- 不在此處鎖死）；embedder 身分另存 text，換 embedder 後把舊向量視為 stale。
    alter table ${memories} add column if not exists embedding vector;
    alter table ${memories} add column if not exists embedding_embedder_id text;
    alter table ${memories} add column if not exists embedding_state text not null default 'pending';

    -- D4a：記憶的來源欄位（可空、additive；既有資料列為 NULL）。
    alter table ${memories} add column if not exists source_session text;
    alter table ${memories} add column if not exists source_message text;

    create table if not exists ${policy} (
      id integer primary key check (id = 1),
      mask_secrets boolean not null,
      version integer not null check (version >= 1)
    );
    create table if not exists ${sources} (
      id integer generated always as identity primary key,
      agent text not null,
      scope text not null,
      project text,
      source_session text not null,
      source_turn text not null,
      messages_json text not null,
      request_hash text not null,
      chunk_version text not null,
      created_at text not null,
      deleted_at text,
      unique (agent, source_session, source_turn)
    );
    create table if not exists ${deletedSources} (
      event_key_hash text primary key
    );

    alter table ${memories} add column if not exists source_id integer references ${sources}(id);
    alter table ${memories} add column if not exists message_index integer;
    alter table ${memories} add column if not exists chunk_index integer;
    alter table ${memories} add column if not exists source_start integer;
    alter table ${memories} add column if not exists source_end integer;
    alter table ${memories} add column if not exists chunk_version text;
    create unique index if not exists memories_source_chunk_idx on ${memories}(source_id, chunk_index);
  `;
}

/**
 * `MetadataStore` 的 PostgreSQL 實作。
 *
 * 全文檢索走「應用層 `Intl.Segmenter` 斷詞 ＋ `tsvector('simple')` ＋ GIN」（研究筆記方案 S），
 * 與 SQLite 後端行為一致；關鍵字排名用 `ts_rank`（越大越前），
 * 與 SQLite 的 `bm25`（越小越前）方向相反，因此合併時以分數由大到小排序。
 */
export class PgMetadataStore implements MetadataStore {
  private readonly pool: Pool;
  private readonly schema: string;
  private readonly roots: string;
  private readonly chunks: string;
  private readonly memories: string;
  private readonly sources: string;
  private readonly deletedSources: string;
  private readonly policy: string;

  constructor(pool: Pool, options: PgMetadataStoreOptions = {}) {
    this.pool = pool;
    this.schema = options.schema ?? "public";
    this.roots = qualified(this.schema, "roots");
    this.chunks = qualified(this.schema, "chunks");
    this.memories = qualified(this.schema, "memories");
    this.sources = qualified(this.schema, "memory_sources");
    this.deletedSources = qualified(this.schema, "deleted_memory_sources");
    this.policy = qualified(this.schema, "memory_policy");
  }

  async migrate(): Promise<void> {
    // `embedding vector` 需要 pgvector 型別。本後端可能在 `PgVectorIndex.migrate()` 之前先跑
    // （例如只跑 MetadataStore 契約測試的環境），因此自己確保擴充存在；`if not exists` 冪等，
    // 但建立擴充需要資料庫權限（與 PgVectorIndex 既有的要求相同）。
    await this.pool.query("create extension if not exists vector");
    // 多個 statement 以簡單查詢協定一次送出；全部 `if not exists`，可重複呼叫。
    await this.pool.query(metadataSchemaSql(this.schema));
    // 卡 C2：既有資料列的 content_hash 回填（只在欄位為 null 時寫入，可重複呼叫）。
    await this.backfillMemoryContentHashes();
  }

  async getMemoryPolicy(): Promise<MemoryPolicy> {
    const result = await this.pool.query(`select mask_secrets, version from ${this.policy} where id = 1`);
    return readMemoryPolicy(result.rows[0]);
  }

  async setMemoryPolicy(maskSecrets: boolean): Promise<MemoryPolicy> {
    if (typeof maskSecrets !== "boolean") throw new TypeError("maskSecrets 必須是布林值");
    return await withTransaction(this.pool, async (client) => {
      await client.query(`
        insert into ${this.policy} (id, mask_secrets, version) values (1, true, 1)
        on conflict (id) do nothing`);
      const locked = await client.query(`select mask_secrets, version from ${this.policy} where id = 1 for update`);
      const row = locked.rows[0];
      if (row === undefined) throw new Error("記憶遮罩政策未寫入");
      const current = readMemoryPolicy(row);
      if (current.maskSecrets === maskSecrets) return current;
      const updated = await client.query(`
        update ${this.policy} set mask_secrets = $1, version = version + 1 where id = 1
        returning mask_secrets, version`, [maskSecrets]);
      if (updated.rows[0] === undefined) throw new Error("記憶遮罩政策未更新");
      return readMemoryPolicy(updated.rows[0]);
    });
  }

  async checkMemorySource(input: MemorySourceEventCheck): Promise<"available" | "duplicate"> {
    const event = normalizeMemorySourceEventCheck(input);
    const result = await this.pool.query(`
      select s.deleted_at, s.request_hash,
             exists(select 1 from ${this.deletedSources} where event_key_hash = $4) as tombstone
        from (select 1) anchor
        left join ${this.sources} s on s.agent = $1 and s.source_session = $2 and s.source_turn = $3`,
    [event.agent, event.sourceSession, event.sourceTurn, memorySourceEventHash(event)]);
    const row = result.rows[0]!;
    if (row.tombstone || row.deleted_at !== null) throw new MemorySourceConflictError();
    if (row.request_hash === null) return "available";
    if (row.request_hash !== event.requestHash) throw new MemorySourceConflictError();
    return "duplicate";
  }

  async addMemorySource(input: NewMemorySource, chunks: NewMemorySourceChunk[]): Promise<MemorySourceWriteResult> {
    const sourceInput = validateMemorySourceWrite(input, chunks);
    const { agent, scope, project, sourceSession, sourceTurn, messages, requestHash, chunkVersion } = sourceInput;
    const snapshot = chunks.map((chunk) => ({ ...chunk }));
    const keyHash = memorySourceEventHash(sourceInput);
    return await withTransaction(this.pool, async (client) => {
      await client.query("set transaction isolation level read committed");
      await this.assertSourceNotTombstoned(client, keyHash);
      const inserted = await client.query(`
        insert into ${this.sources} (agent, scope, project, source_session, source_turn, messages_json, request_hash, chunk_version, created_at)
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        on conflict (agent, source_session, source_turn) do nothing
        returning ${MEMORY_SOURCE_COLUMNS}`,
      [agent, scope, project, sourceSession, sourceTurn, JSON.stringify(messages), requestHash, chunkVersion, new Date().toISOString()]);
      const row = inserted.rows[0];
      if (row !== undefined) {
        // 唯一索引的插入可能等到另一個交易硬刪完成，須用新的 snapshot 重查 tombstone。
        await this.assertSourceNotTombstoned(client, keyHash);
        const source = rowToMemorySource(row);
        return { source, memories: await this.insertSourceChunks(client, source, snapshot, false), duplicate: false };
      }

      const found = await client.query(`
        select ${MEMORY_SOURCE_COLUMNS} from ${this.sources}
         where agent = $1 and source_session = $2 and source_turn = $3 for update`,
      [agent, sourceSession, sourceTurn]);
      const existing = found.rows[0];
      if (existing === undefined || existing.deleted_at !== null || existing.request_hash !== requestHash) {
        throw new MemorySourceConflictError();
      }
      const source = rowToMemorySource(existing);
      return { source, memories: await this.readSourceChunks(client, source.id), duplicate: true };
    });
  }

  async getMemorySource(id: number): Promise<MemorySource | null> {
    return this.readSource(this.pool, id);
  }

  async listMemorySourcesForExport(): Promise<MemorySource[]> {
    const result = await this.pool.query(
      `select ${MEMORY_SOURCE_COLUMNS} from ${this.sources} where deleted_at is null order by created_at, id`,
    );
    return result.rows.map(rowToMemorySource);
  }

  async listMemorySourceChunks(id: number): Promise<Memory[]> {
    return this.readSourceChunks(this.pool, id);
  }

  async memorySourceEmbeddingStats(id: number, embedderId: string): Promise<MemoryEmbeddingStats> {
    return this.readMemoryEmbeddingStats(embedderId, id);
  }

  async replaceMemorySourceChunks(id: number, chunkVersion: string, chunks: NewMemorySourceChunk[]): Promise<Memory[]> {
    return await withTransaction(this.pool, async (client) => {
      const source = await this.readSource(client, id, true);
      if (source === null || source.deletedAt !== null) return [];
      assertMemorySourceChunks(source.messages, chunkVersion, chunks);
      const snapshot = chunks.map((chunk) => ({ ...chunk }));
      const result = await client.query(`select 1 from ${this.memories} where source_id = $1 and pinned limit 1`, [id]);
      await client.query(`delete from ${this.memories} where source_id = $1`, [id]);
      await client.query(`update ${this.sources} set chunk_version = $2 where id = $1`, [id, chunkVersion]);
      return this.insertSourceChunks(client, { ...source, chunkVersion }, snapshot, result.rows.length > 0);
    });
  }

  async updateMemorySource(id: number, patch: MemoryPatch): Promise<MemorySource | null> {
    return await withTransaction(this.pool, async (client) => {
      const source = await this.readSource(client, id, true);
      return source === null ? null : this.updateSource(client, source, patch);
    });
  }

  async deleteMemorySource(id: number, hard = false): Promise<boolean> {
    return await withTransaction(this.pool, async (client) => {
      const source = await this.readSource(client, id, true);
      return source === null ? false : this.deleteSource(client, source, hard);
    });
  }

  private async assertSourceNotTombstoned(client: PoolClient, eventKeyHash: string): Promise<void> {
    const result = await client.query(`select 1 from ${this.deletedSources} where event_key_hash = $1`, [eventKeyHash]);
    if (result.rows.length > 0) throw new MemorySourceConflictError();
  }

  private async readSource(connection: Pool | PoolClient, id: number, lock = false): Promise<MemorySource | null> {
    const result = await connection.query(
      `select ${MEMORY_SOURCE_COLUMNS} from ${this.sources} where id = $1 ${lock ? "for update" : ""}`, [id],
    );
    return result.rows[0] === undefined ? null : rowToMemorySource(result.rows[0]);
  }

  private async readSourceChunks(connection: Pool | PoolClient, id: number): Promise<Memory[]> {
    const result = await connection.query(
      `select ${MEMORY_COLUMNS} from ${this.memories} where source_id = $1 and deleted_at is null order by chunk_index`, [id],
    );
    return result.rows.map(rowToMemory);
  }

  private async insertSourceChunks(
    client: PoolClient, source: MemorySource, chunks: readonly NewMemorySourceChunk[], pinned: boolean,
  ): Promise<Memory[]> {
    const rows = chunks.map(({ content, messageIndex, chunkIndex, start, end }) => ({
      content,
      message_index: messageIndex,
      chunk_index: chunkIndex,
      source_start: start,
      source_end: end,
      source_message: source.messages[messageIndex]!.sourceMessage,
      seg: segmentOrNull(content),
    }));
    const inserted = await client.query(`
      insert into ${this.memories} (
        content, kind, scope, project, agent, pinned, source_session, source_message, created_at,
        source_id, message_index, chunk_index, source_start, source_end, chunk_version, seg
      )
      select content, 'fact', $2, $3, $4, $5, $6, source_message, $7,
             $8, message_index, chunk_index, source_start, source_end, $9, seg
        from json_to_recordset($1::json) as c(
          content text, message_index integer, chunk_index integer, source_start integer,
          source_end integer, source_message text, seg text
        )
       order by chunk_index
      returning ${MEMORY_COLUMNS}`,
    [JSON.stringify(rows), source.scope, source.project, source.agent, pinned, source.sourceSession,
      source.createdAt, source.id, source.chunkVersion]);
    if (inserted.rows.length !== chunks.length) throw new Error("原文切塊未完整寫入");
    return inserted.rows.map(rowToMemory).sort((a, b) => a.chunkIndex! - b.chunkIndex!);
  }

  private async updateSource(client: PoolClient, source: MemorySource, patch: MemoryPatch): Promise<MemorySource | null> {
    if (source.deletedAt !== null) return null;
    const next = normalizeMemorySourceScope(source, patch);
    await client.query(`update ${this.sources} set scope = $2, project = $3 where id = $1`, [source.id, next.scope, next.project]);
    await client.query(`update ${this.memories} set scope = $2, project = $3 where source_id = $1`, [source.id, next.scope, next.project]);
    return { ...source, ...next };
  }

  private async deleteSource(client: PoolClient, source: MemorySource, hard: boolean): Promise<boolean> {
    if (hard) {
      await client.query(`insert into ${this.deletedSources} (event_key_hash) values ($1) on conflict do nothing`,
        [memorySourceEventHash(source)]);
      await client.query(`delete from ${this.memories} where source_id = $1`, [source.id]);
      await client.query(`delete from ${this.sources} where id = $1`, [source.id]);
    } else if (source.deletedAt === null) {
      const deletedAt = new Date().toISOString();
      await client.query(`update ${this.sources} set deleted_at = $2 where id = $1`, [source.id, deletedAt]);
      await client.query(`update ${this.memories} set deleted_at = $2 where source_id = $1`, [source.id, deletedAt]);
    }
    return true;
  }

  private async markSuperseded(client: PoolClient, id: number, deletedAt: string): Promise<void> {
    const result = await client.query(`select source_id from ${this.memories} where id = $1`, [id]);
    if (result.rows[0]?.source_id != null) throw new MemorySourceConflictError();
    await client.query(`update ${this.memories} set deleted_at = $2 where id = $1 and deleted_at is null and source_id is null`,
      [id, deletedAt]);
  }

  /**
   * 回填 `content_hash`（migration 0004 的 PostgreSQL 對應）。
   *
   * 在單一交易內先撈出 `content_hash is null` 的列再逐列 update（資料量小、只在升級時跑一次）；
   * update 條件保留 `content_hash is null`，即使併發的 migrate 同時跑也不會覆寫已回填的值。
   */
  private async backfillMemoryContentHashes(): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      const pending = await client.query(
        `select id, content from ${this.memories} where content_hash is null and source_id is null order by id`,
      );
      for (const row of pending.rows) {
        await client.query(
          `update ${this.memories} set content_hash = $2 where id = $1 and content_hash is null`,
          [Number(row.id), memoryContentHash(String(row.content))],
        );
      }
    });
  }

  async addRoot(r: NewRoot): Promise<Root> {
    const createdAt = new Date().toISOString();
    // 驗證在寫入前（非法值不建立資料列）；null＝未設定，資料庫寫 NULL。
    const maxFileBytes = normalizeRootMaxFileBytes(r.maxFileBytes) ?? null;
    const videoMaxFileBytes = normalizeRootVideoMaxFileBytes(r.videoMaxFileBytes) ?? null;
    try {
      await this.pool.query(
        `insert into ${this.roots}(path, mode, modalities, include_rules, exclude_rules, respect_gitignore, watch, created_at, allow_agent_search, max_file_bytes, video_max_file_bytes)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          r.path,
          r.mode,
          JSON.stringify(r.modalities),
          JSON.stringify(r.include),
          JSON.stringify(r.exclude),
          r.respectGitignore,
          r.watch,
          createdAt,
          r.allowAgentSearch === true,
          maxFileBytes,
          videoMaxFileBytes,
        ],
      );
    } catch (error) {
      if (isUniqueViolation(error)) throw new DuplicateRootError(r.path);
      throw error;
    }

    const result = await this.pool.query(`select ${ROOT_COLUMNS} from ${this.roots} where path = $1`, [r.path]);
    if (result.rows.length === 0) throw new Error("新增 root 後讀不回資料列");
    return rowToRoot(result.rows[0]!);
  }

  async getRoot(id: number): Promise<Root | null> {
    const result = await this.pool.query(`select ${ROOT_COLUMNS} from ${this.roots} where id = $1`, [id]);
    return result.rows.length === 0 ? null : rowToRoot(result.rows[0]!);
  }

  async listRoots(): Promise<Root[]> {
    const result = await this.pool.query(`select ${ROOT_COLUMNS} from ${this.roots} order by id`);
    return result.rows.map(rowToRoot);
  }

  /**
   * 更新可變設定（`RootPatch`）；語意與 SQLite 後端完全相同（見 `MetadataStore.updateRoot`）。
   *
   * 以 `returning` 在同一次查詢拿到更新後的資料列：0 列＝id 不存在 → 回 `null`，
   * 不必先 select 再 update（也避免兩個後端語意分岔）。
   */
  async updateRoot(id: number, patch: RootPatch): Promise<Root | null> {
    // 四個欄位都可能要改，先讀現值（roots 只有個位數筆）：省略欄位＝保留現值。
    const current = await this.pool.query(`select ${ROOT_COLUMNS} from ${this.roots} where id = $1`, [id]);
    if (current.rows.length === 0) return null;
    const existing = rowToRoot(current.rows[0]!);

    const maxFileBytes =
      patch.maxFileBytes === undefined
        ? existing.maxFileBytes ?? null
        : normalizeRootMaxFileBytes(patch.maxFileBytes) ?? null;
    const videoMaxFileBytes =
      patch.videoMaxFileBytes === undefined
        ? existing.videoMaxFileBytes ?? null
        : normalizeRootVideoMaxFileBytes(patch.videoMaxFileBytes) ?? null;

    const result = await this.pool.query(
      `update ${this.roots}
          set modalities = $2, allow_agent_search = $3, max_file_bytes = $4, video_max_file_bytes = $5
        where id = $1 returning ${ROOT_COLUMNS}`,
      [
        id,
        JSON.stringify(patch.modalities ?? existing.modalities),
        patch.allowAgentSearch ?? existing.allowAgentSearch,
        maxFileBytes,
        videoMaxFileBytes,
      ],
    );
    return result.rows.length === 0 ? null : rowToRoot(result.rows[0]!);
  }

  async removeRoot(id: number, deleteData: boolean): Promise<{ removedChunkIds: number[] }> {
    return await withTransaction(this.pool, async (client) => {
      const found = await client.query(`select id from ${this.chunks} where root_id = $1 order by id`, [id]);
      const chunkIds = found.rows.map((row) => Number(row.id));

      if (deleteData) {
        await client.query(`delete from ${this.chunks} where root_id = $1`, [id]);
      }
      await client.query(`delete from ${this.roots} where id = $1`, [id]);

      return { removedChunkIds: deleteData ? chunkIds : [] };
    });
  }

  async replaceChunks(
    rootId: number,
    relPath: string,
    chunks: Omit<NewChunk, "rootId" | "relPath">[],
  ): Promise<Chunk[]> {
    const normalized = chunks.map((item) => ({ ...item, media: normalizeChunkMedia(item.media) }));
    return await withTransaction(this.pool, async (client) => {
      await client.query(`delete from ${this.chunks} where root_id = $1 and rel_path = $2`, [rootId, relPath]);

      const created: Chunk[] = [];
      for (const item of normalized) {
        const result = await client.query(
          `insert into ${this.chunks}(root_id, rel_path, seq, kind, text, content_hash, seg, media_json)
           values ($1, $2, $3, $4, $5, $6, $7, $8)
           returning ${CHUNK_COLUMNS}`,
          [rootId, relPath, item.seq, item.kind, item.text, item.contentHash, segmentOrNull(item.text),
            item.media === undefined ? null : JSON.stringify(item.media)],
        );
        created.push(rowToChunk(result.rows[0]!));
      }
      return created;
    });
  }

  async deleteChunksByPath(rootId: number, relPath: string): Promise<number[]> {
    return await withTransaction(this.pool, async (client) => {
      const found = await client.query(
        `select id from ${this.chunks} where root_id = $1 and rel_path = $2 order by id`,
        [rootId, relPath],
      );
      const ids = found.rows.map((row) => Number(row.id));
      if (ids.length > 0) {
        await client.query(`delete from ${this.chunks} where id = any($1::int[])`, [ids]);
      }
      return ids;
    });
  }

  async getChunks(ids: number[]): Promise<Chunk[]> {
    if (ids.length === 0) return [];
    const result = await this.pool.query(`select ${CHUNK_COLUMNS} from ${this.chunks} where id = any($1::int[])`, [
      ids,
    ]);
    const byId = new Map<number, Chunk>(result.rows.map((row) => [Number(row.id), rowToChunk(row)]));
    return ids
      .map((id) => byId.get(id))
      .filter((chunk): chunk is Chunk => chunk !== undefined);
  }

  async listChunksByPath(rootId: number, relPath: string): Promise<Chunk[]> {
    const result = await this.pool.query(
      `select ${CHUNK_COLUMNS} from ${this.chunks} where root_id = $1 and rel_path = $2 order by seq, id`,
      [rootId, relPath],
    );
    return result.rows.map(rowToChunk);
  }

  async listRelPaths(rootId: number): Promise<string[]> {
    const result = await this.pool.query(
      `select distinct rel_path from ${this.chunks} where root_id = $1 order by rel_path`,
      [rootId],
    );
    return result.rows.map((row) => String(row.rel_path));
  }

  async addMemory(m: NewMemory): Promise<Memory> {
    const createdAt = new Date().toISOString();
    const memoryId = await withTransaction(this.pool, async (client) => {
      if (m.supersedes !== null) {
        await this.markSuperseded(client, m.supersedes, createdAt);
      }
      const result = await client.query(
        `insert into ${this.memories}(content, kind, scope, project, agent, supersedes, source_session, source_message, created_at, deleted_at, seg, content_hash)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, null, $10, $11)
         returning id`,
        [
          m.content,
          m.kind,
          m.scope,
          m.project,
          m.agent,
          m.supersedes,
          m.sourceSession ?? null,
          m.sourceMessage ?? null,
          createdAt,
          segmentOrNull(m.content),
          memoryContentHash(m.content),
        ],
      );
      return Number(result.rows[0]!.id);
    });

    const created = await this.getMemory(memoryId);
    if (created === null) throw new Error("新增記憶後讀不回資料列");
    return created;
  }

  /**
   * 原子 insert-or-return-existing（見 `MetadataStore.addMemoryUnlessDuplicate`）。
   *
   * 去重 key＝（內容 hash, `scope`, `project`, `agent`），`project` 用
   * `coalesce(project, '') = coalesce($n, '')` 做 null-safe 比較。檢查與新增在同一句
   * `insert … select … where not exists`（單一 SQL 敘述，搭配交易處理 supersedes 與重讀），
   * 對齊 SQLite 後端的語意。
   */
  async addMemoryUnlessDuplicate(m: NewMemory): Promise<{ memory: Memory; duplicate: boolean }> {
    const createdAt = new Date().toISOString();
    const contentHash = memoryContentHash(m.content);

    const attempt = await withTransaction(this.pool, async (client) => {
      if (m.supersedes !== null) {
        await this.markSuperseded(client, m.supersedes, createdAt);
      }

      const inserted = await client.query(
        `insert into ${this.memories}(content, kind, scope, project, agent, supersedes, source_session, source_message, created_at, deleted_at, seg, content_hash)
         select $1, $2, $3, $4, $5, $6, $7, $8, $9, null, $10, $11
          where not exists (
            select 1 from ${this.memories}
             where content_hash = $11
               and scope = $3
               and coalesce(project, '') = coalesce($4::text, '')
               and agent = $5
               and deleted_at is null
               and source_id is null
          )
         returning ${MEMORY_COLUMNS}`,
        [
          m.content,
          m.kind,
          m.scope,
          m.project,
          m.agent,
          m.supersedes,
          m.sourceSession ?? null,
          m.sourceMessage ?? null,
          createdAt,
          segmentOrNull(m.content),
          contentHash,
        ],
      );

      if (inserted.rows.length > 0) return { memory: rowToMemory(inserted.rows[0]!), duplicate: false };

      const existing = await client.query(
        `select ${MEMORY_COLUMNS} from ${this.memories}
          where content_hash = $1
            and scope = $2
            and coalesce(project, '') = coalesce($3::text, '')
            and agent = $4
            and deleted_at is null
            and source_id is null
          order by id
          limit 1`,
        [contentHash, m.scope, m.project, m.agent],
      );
      if (existing.rows.length === 0) throw new Error("去重判定為重複，但讀不回既有記憶");
      return { memory: rowToMemory(existing.rows[0]!), duplicate: true };
    });

    return attempt;
  }

  async getMemory(id: number): Promise<Memory | null> {
    return this.readMemory(this.pool, id);
  }

  private async readMemory(connection: Pool | PoolClient, id: number, lock = false): Promise<Memory | null> {
    const result = await connection.query(
      `select ${MEMORY_COLUMNS} from ${this.memories} where id = $1 ${lock ? "for update" : ""}`, [id],
    );
    return result.rows.length === 0 ? null : rowToMemory(result.rows[0]!);
  }

  private async lockMemoryTarget(
    client: PoolClient, id: number,
  ): Promise<{ memory: Memory; source: MemorySource | null } | null> {
    const initial = await this.readMemory(client, id);
    if (initial === null) return null;
    if (initial.sourceId == null) {
      const memory = await this.readMemory(client, id, true);
      return memory === null ? null : { memory, source: null };
    }
    // 先鎖來源再碰子片段，與直接以 source id 更新／重建的鎖定順序一致。
    const source = await this.readSource(client, initial.sourceId, true);
    if (source === null) return null;
    const memory = await this.readMemory(client, id);
    return memory === null ? null : { memory, source };
  }

  async forgetMemory(id: number): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      const target = await this.lockMemoryTarget(client, id);
      if (target === null || target.memory.deletedAt !== null) return;
      if (target.source !== null) {
        await this.deleteSource(client, target.source, false);
      } else {
        await client.query(`update ${this.memories} set deleted_at = $2 where id = $1`, [id, new Date().toISOString()]);
      }
    });
  }

  /**
   * 冪等正規化舊版的矛盾 scope／project（語意與 SQLite 後端完全相同，見
   * `MetadataStore.normalizeLegacyMemoryScopes`）。
   *
   * 兩個 UPDATE 的條件互斥，因此 `rowCount` 可以直接相加；包含已軟刪除的列（純資料一致性）。
   * 第二次執行時條件已不成立，回傳 `updated: 0`。
   */
  async normalizeLegacyMemoryScopes(): Promise<{ updated: number }> {
    return await withTransaction(this.pool, async (client) => {
      const cleared = await client.query(
        `update ${this.memories} set project = null where scope in ('global', 'agent') and project is not null and source_id is null`,
      );
      const promoted = await client.query(
        `update ${this.memories}
            set scope = 'global', project = null
          where scope = 'project' and (project is null or btrim(project) = '') and source_id is null`,
      );
      return { updated: (cleared.rowCount ?? 0) + (promoted.rowCount ?? 0) };
    });
  }

  /**
   * 硬刪除記憶（見 `MetadataStore.hardDeleteMemory`）。
   *
   * `delete … where id` 的 `rowCount` 就是「真的有這一列」的答案；FTS 是 generated `tsv` 欄位，
   * 與主列同存亡，不需要另外刪除。向量欄位同樣隨列消失。
   */
  async hardDeleteMemory(id: number): Promise<boolean> {
    return await withTransaction(this.pool, async (client) => {
      const target = await this.lockMemoryTarget(client, id);
      if (target === null) return false;
      if (target.source !== null) return this.deleteSource(client, target.source, true);
      const result = await client.query(`delete from ${this.memories} where id = $1`, [id]);
      return (result.rowCount ?? 0) > 0;
    });
  }

  /** 設定釘選（冪等）；不存在的 id 更新不到任何列，等同無操作。 */
  async setMemoryPinned(id: number, pinned: boolean): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      const target = await this.lockMemoryTarget(client, id);
      if (target === null) return;
      if (target.source !== null) {
        await client.query(`update ${this.memories} set pinned = $2 where source_id = $1 and deleted_at is null`,
          [target.source.id, pinned]);
      } else {
        await client.query(`update ${this.memories} set pinned = $2 where id = $1`, [id, pinned]);
      }
    });
  }

  /**
   * 更新記憶的 `scope`／`project`（語意與 SQLite 後端完全相同，見 `MetadataStore.updateMemory`）。
   *
   * 先 select 現值以套用 `normalizeMemoryPatch`（合併與正規化只有一處），再以
   * `update … returning` 一次拿到更新後的列；`deleted_at is null` 讓「讀到之後才被軟刪除」
   * 的競態也回 `null`（0 列），與 SQLite 端一致。內容沒動，`seg`/`tsv` 不必重算。
   */
  async updateMemory(id: number, patch: MemoryPatch): Promise<Memory | null> {
    return await withTransaction(this.pool, async (client) => {
      const target = await this.lockMemoryTarget(client, id);
      if (target === null || target.memory.deletedAt !== null) return null;
      if (target.source !== null) {
        const source = await this.updateSource(client, target.source, patch);
        return source === null ? null : { ...target.memory, scope: source.scope, project: source.project };
      }
      const next = normalizeMemoryPatch(target.memory, patch);
      const result = await client.query(
        `update ${this.memories} set scope = $2, project = $3 where id = $1 returning ${MEMORY_COLUMNS}`,
        [id, next.scope, next.project],
      );
      return result.rows.length === 0 ? null : rowToMemory(result.rows[0]!);
    });
  }

  /**
   * 寫入記憶向量並設為 `ready`（語意與 SQLite 後端完全相同，見 `MetadataStore.markMemoryEmbedded`）。
   *
   * 以 pgvector 的文字格式（`[0.1,0.2,…]`）綁定參數、在 SQL 內 `$3::vector` 轉型；`vector`
   * 欄位不帶維度，換 embedder／維度時由回填流程覆寫。未知 id 或已軟刪除更新不到任何列。
   */
  async markMemoryEmbedded(id: number, embedderId: string, vec: Float32Array): Promise<void> {
    assertMemoryEmbeddingInput(embedderId, vec);
    await this.pool.query(
      `update ${this.memories}
          set embedding = $2::vector, embedding_embedder_id = $3, embedding_state = 'ready'
        where id = $1 and deleted_at is null`,
      [id, toVectorLiteral(vec), embedderId],
    );
  }

  /** 把狀態設為 `failed`／`too-long`；保留既有向量與 embedder 身分（見 `MetadataStore` 的說明）。 */
  async markMemoryEmbeddingFailed(id: number, reason: MemoryEmbeddingFailure): Promise<void> {
    assertMemoryEmbeddingFailure(reason);
    await this.pool.query(
      `update ${this.memories} set embedding_state = $1 where id = $2 and deleted_at is null`,
      [reason, id],
    );
  }

  /** 列出需要（重新）產生向量的未刪除記憶（見 `MetadataStore.listMemoriesNeedingEmbedding`）。 */
  async listMemoriesNeedingEmbedding(embedderId: string, limit?: number, before?: Pick<Memory, "createdAt" | "id">): Promise<Memory[]> {
    assertMemoryEmbeddingCursor(before);
    const normalized = normalizeMemoryLimit(limit);
    if (normalized === 0) return [];

    const result = await this.pool.query(
      `select ${MEMORY_COLUMNS} from ${this.memories}
        where deleted_at is null
          and (embedding_state in ('pending', 'failed')
               or (embedding_state = 'ready'
                   and (embedding_embedder_id is null or embedding_embedder_id <> $1)))
          ${before === undefined ? "" : "and (created_at, id) < ($3, $4)"}
        order by created_at desc, id desc
        limit $2`,
      before === undefined ? [embedderId, normalized] : [embedderId, normalized, before.createdAt, before.id],
    );
    return result.rows.map(rowToMemory);
  }

  /** 統計未刪除記憶的語意化狀態（見 `MetadataStore.memoryEmbeddingStats`；四個狀態數自洽）。 */
  async memoryEmbeddingStats(embedderId: string): Promise<MemoryEmbeddingStats> {
    return this.readMemoryEmbeddingStats(embedderId);
  }

  private async readMemoryEmbeddingStats(embedderId: string, sourceId?: number): Promise<MemoryEmbeddingStats> {
    const result = await this.pool.query(
      `select
         count(*)::int as total,
         (count(*) filter (where embedding_state = 'pending'))::int as pending,
         (count(*) filter (where embedding_state = 'ready'))::int as ready,
         (count(*) filter (where embedding_state = 'failed'))::int as failed,
         (count(*) filter (where embedding_state = 'too-long'))::int as too_long,
         (count(*) filter (
           where embedding_state = 'ready'
             and (embedding_embedder_id is null or embedding_embedder_id <> $1)
         ))::int as stale
       from ${this.memories} where deleted_at is null ${sourceId === undefined ? "" : "and source_id = $2"}`,
      sourceId === undefined ? [embedderId] : [embedderId, sourceId],
    );
    const row = result.rows[0] ?? {};
    const count = (value: unknown): number => Number(value ?? 0);
    return {
      total: count(row.total),
      pending: count(row.pending),
      ready: count(row.ready),
      failed: count(row.failed),
      tooLong: count(row.too_long),
      stale: count(row.stale),
    };
  }

  /**
   * 記憶語意檢索（見 `MetadataStore.searchMemoriesByVector`）。
   *
   * 同一句 SQL 內先以 `deleted_at`／`ready`／embedder 身分／filter 過濾，再用 pgvector 的
   * `<=>` 精確排序（**先過濾再排名**）。`embedding` 不帶維度，維度不符時 pgvector 會在查詢時
   * 報錯；為維持「維度不符 → TypeError」的跨後端語意，先以 `vector_dims()` 預檢。
   */
  async searchMemoriesByVector(
    queryVec: Float32Array,
    embedderId: string,
    filter: MemorySearchFilter,
    k: number,
  ): Promise<MemoryVectorHit[]> {
    assertMemoryQueryVector(queryVec);
    if (typeof embedderId !== "string" || embedderId.trim() === "") {
      throw new TypeError("embedderId 必須是非空字串");
    }
    const limit = normalizeMemorySearchK(k);
    if (limit === 0) return [];

    const normalized = normalizeMemorySearchFilter(filter);
    if (normalized.buckets !== undefined && normalized.buckets.length === 0) return [];

    // 維度預檢：向量 $1、filter 參數 $2..；沒有可用向量時不驗（查詢自然回空）。
    // 用 `distinct … limit 2`：同一 embedder 下可能混入不同維度的損壞資料，只驗第一列會讓
    // 主查詢踩到 pgvector 的原始錯誤；這裡只要發現「存在與查詢不同的維度」就拋 TypeError。
    // 成本與主查詢同級（掃同一組符合條件的列；memories.embedding 沒有索引可用），只多一次去重。
    const dimWhere = buildPgMemorySearchWhere(normalized, 2);
    const dimResult = await this.pool.query(
      `select distinct vector_dims(m.embedding) as dim
         from ${this.memories} m
        where ${dimWhere.clause}
          and m.embedding_state = 'ready'
          and m.embedding_embedder_id = $1
          and m.embedding is not null
        limit 2`,
      [embedderId, ...dimWhere.params],
    );
    const mismatchedDim = dimResult.rows
      .map((row) => Number(row.dim))
      .find((storedDim) => storedDim !== queryVec.length);
    if (mismatchedDim !== undefined) {
      throw new TypeError(`向量維度不符：查詢 ${queryVec.length} 維、記憶 ${mismatchedDim} 維`);
    }

    const where = buildPgMemorySearchWhere(normalized, 2);
    const embedderParam = 2 + where.params.length;
    const limitParam = 3 + where.params.length;
    const result = await this.pool.query(
      `select m.id as id, 1 - (m.embedding <=> $1::vector) as score
         from ${this.memories} m
        where ${where.clause}
          and m.embedding_state = 'ready'
          and m.embedding_embedder_id = $${embedderParam}
          and m.embedding is not null
        order by score desc, m.id asc
        limit $${limitParam}`,
      [toVectorLiteral(queryVec), ...where.params, embedderId, limit],
    );
    return result.rows.map((row) => ({ id: Number(row.id), score: Number(row.score) }));
  }

  /**
   * 記憶關鍵字檢索（見 `MetadataStore.searchMemoriesKeyword`）。
   *
   * 只查 memories 的 `tsv`（**不混 chunk**）；同一組 filter 在 SQL 先套用，再依 `ts_rank`
   * 排名，同分以 `id` 升冪決勝（與 SQLite 端一致、可重現）。`rank` 由回傳順序從 1 起算。
   */
  async searchMemoriesKeyword(query: string, filter: MemorySearchFilter, k: number): Promise<MemoryKeywordHit[]> {
    const limit = normalizeMemorySearchK(k);
    if (limit === 0) return [];
    const tokens = segmentText(query)
      .split(" ")
      .filter((token) => token.length > 0);
    if (tokens.length === 0) return [];

    const normalized = normalizeMemorySearchFilter(filter);
    if (normalized.buckets !== undefined && normalized.buckets.length === 0) return [];

    const tsquery = tokens.map((_, index) => `plainto_tsquery('simple', $${index + 1})`).join(" || ");
    const where = buildPgMemorySearchWhere(normalized, tokens.length + 1);
    const limitParam = 1 + tokens.length + where.params.length;

    const result = await this.pool.query(
      `with q as (select ${tsquery} as tsq)
       select m.id as id, ts_rank(m.tsv, q.tsq) as score
         from ${this.memories} m, q
        where m.tsv @@ q.tsq and ${where.clause}
        order by score desc, m.id asc
        limit $${limitParam}`,
      [...tokens, ...where.params, limit],
    );
    return result.rows.map((row, index) => ({ id: Number(row.id), rank: index + 1 }));
  }

  async listMemories(filter: MemoryFilter = {}): Promise<Memory[]> {
    const limit = normalizeMemoryLimit(filter.limit);
    if (limit === 0) return [];

    const conditions = ["deleted_at is null"];
    const params: unknown[] = [];
    if (filter.scope !== undefined) {
      params.push(filter.scope);
      conditions.push(`scope = $${params.length}`);
    }
    if (filter.project !== undefined) {
      params.push(filter.project);
      conditions.push(`project = $${params.length}`);
    }
    if (filter.agent !== undefined) {
      params.push(filter.agent);
      conditions.push(`agent = $${params.length}`);
    }
    if (filter.kind !== undefined) {
      params.push(filter.kind);
      conditions.push(`kind = $${params.length}`);
    }
    params.push(limit);

    const result = await this.pool.query(
      `select ${MEMORY_COLUMNS} from ${this.memories}
        where ${conditions.join(" and ")}
        order by created_at desc, id desc
        limit $${params.length}`,
      params,
    );
    return result.rows.map(rowToMemory);
  }

  /**
   * 列出全部未刪除的記憶（見 `MetadataStore.listMemoriesForExport` 的契約）。
   *
   * 備份用：**不套** `limit`、排序與 `listMemories` 相反（`created_at asc, id asc`）。
   */
  async listMemoriesForExport(): Promise<Memory[]> {
    const result = await this.pool.query(
      `select ${MEMORY_COLUMNS} from ${this.memories}
        where deleted_at is null
        order by created_at asc, id asc`,
    );
    return result.rows.map(rowToMemory);
  }

  /**
   * 關鍵字搜尋：chunk 與未刪除的記憶各查一次，合併後排序。
   *
   * - 查詢字串與內文都經 `segmentText` 斷詞，再用 `tsquery || tsquery`（OR）組合；
   *   每個 token 都以 `plainto_tsquery('simple', $n)` 參數綁定，**不做字串拼接**。
   * - `filter.rootIds` 未指定＝搜所有 chunk 與記憶；指定時只搜這些 root 的 chunk，
   *   記憶（沒有 root）不回傳；指定空陣列＝沒有任何可見 root，直接回空。
   * - 排名：`ts_rank` 越大越前，同分以 key 字典序決勝（與 SQLite 端一致、可重現）。
   */
  async searchKeyword(query: string, filter: SearchFilter, k: number): Promise<RankedHit[]> {
    if (k <= 0) return [];
    const tokens = segmentText(query)
      .split(" ")
      .filter((token) => token.length > 0);
    if (tokens.length === 0) return [];

    const rootIds = filter.rootIds;
    // 預設規則：rootIds 未指定才含記憶；呼叫端可用 includeMemories 明確覆寫。
    const includeMemories = filter.includeMemories ?? rootIds === undefined;

    const tsquery = tokens.map((_, index) => `plainto_tsquery('simple', $${index + 1})`).join(" || ");
    const scored: { key: string; score: number }[] = [];

    // chunk：指定 rootIds 時在 SQL 內過濾（先過濾再排序，避免先取前 k 再過濾而少給結果）。
    // 空陣列＝沒有任何可見 root，連查都不必查；但仍可能要用 includeMemories 取記憶。
    if (rootIds === undefined || rootIds.length > 0) {
      const params: unknown[] = [...tokens];
      let filterClause = "";
      if (rootIds !== undefined) {
        params.push(rootIds);
        filterClause = ` and c.root_id = any($${params.length}::int[])`;
      }
      params.push(k);
      const result = await this.pool.query(
        `with q as (select ${tsquery} as tsq)
         select 'c:' || c.id as key, ts_rank(c.tsv, q.tsq) as score
           from ${this.chunks} c, q
          where c.tsv @@ q.tsq${filterClause}
          order by score desc, key asc
          limit $${params.length}`,
        params,
      );
      for (const row of result.rows) scored.push({ key: String(row.key), score: Number(row.score) });
    }

    // 記憶：沒有 root，因此預設只在「未指定 rootIds」時納入（可用 includeMemories 覆寫）。
    if (includeMemories) {
      const params: unknown[] = [...tokens, k];
      const result = await this.pool.query(
        `with q as (select ${tsquery} as tsq)
         select 'm:' || m.id as key, ts_rank(m.tsv, q.tsq) as score
           from ${this.memories} m, q
          where m.tsv @@ q.tsq and m.deleted_at is null
          order by score desc, key asc
          limit $${params.length}`,
        params,
      );
      for (const row of result.rows) scored.push({ key: String(row.key), score: Number(row.score) });
    }

    scored.sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score;
      return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    });

    return scored.slice(0, k).map((hit, index) => ({ key: hit.key, rank: index + 1 }));
  }
}
