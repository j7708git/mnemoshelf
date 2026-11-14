import { createHash } from "node:crypto";
import type { Memory } from "../ports/types.js";

export interface MemoryLibraryFilter {
  project?: string;
  unassigned?: boolean;
  writer?: string;
  type?: "source" | "memory";
  query?: string;
  limit?: number;
  cursor?: string;
}

export interface MemoryLibraryEntry {
  type: "source" | "memory";
  id: number;
  memory: Memory;
  chunkCount: number;
}

export interface MemoryLibraryPage {
  recallVersion: number;
  entries: MemoryLibraryEntry[];
  total: number;
  counts: { sources: number; memories: number };
  facets: { projects: string[]; writers: string[]; hasUnassigned: boolean };
  nextCursor: string | null;
}

interface LibraryCursor {
  version: 1;
  filter: string;
  pinned: number;
  createdAt: string;
  type: "source" | "memory";
  id: number;
}

interface NormalizedLibraryFilter {
  project: string | null;
  unassigned: boolean;
  writer: string | null;
  type: "source" | "memory" | null;
  query: string | null;
  limit: number;
  fingerprint: string;
  cursor: LibraryCursor | null;
}

/** 游標只帶排序鍵與條件雜湊，不把查詢文字或來源標記放進可攜資料。 */
export function normalizeMemoryLibraryFilter(input: MemoryLibraryFilter = {}): NormalizedLibraryFilter {
  const string = (value: unknown, field: string, max: number): string | null => {
    if (value === undefined) return null;
    if (typeof value !== "string" || value.length === 0 || value.length > max || value.includes("\0")) {
      throw new TypeError(`${field} 必須是 1 至 ${max} 字元的文字`);
    }
    return value;
  };
  const project = string(input.project, "project", 200);
  const writer = string(input.writer, "writer", 200);
  const query = string(input.query, "query", 8000);
  if (input.unassigned !== undefined && typeof input.unassigned !== "boolean") throw new TypeError("unassigned 必須是布林值");
  const unassigned = input.unassigned === true;
  if (project !== null && unassigned) throw new TypeError("project 與 unassigned 不可同時指定");
  const type = input.type ?? null;
  if (type !== null && type !== "source" && type !== "memory") throw new TypeError("type 必須是 source 或 memory");
  if (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || input.limit <= 0)) throw new TypeError("limit 必須是正整數");
  const limit = Math.min(input.limit ?? 25, 100);
  const fingerprint = createHash("sha256").update(JSON.stringify({ project, unassigned, writer, type, query })).digest("hex");
  let cursor: LibraryCursor | null = null;
  if (input.cursor !== undefined) {
    try {
      if (typeof input.cursor !== "string" || input.cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(input.cursor)) throw new Error();
      const decoded = Buffer.from(input.cursor, "base64url");
      if (decoded.toString("base64url") !== input.cursor) throw new Error();
      const value = JSON.parse(decoded.toString("utf8")) as LibraryCursor;
      if (value === null || value.version !== 1 || value.filter !== fingerprint ||
        (value.pinned !== 0 && value.pinned !== 1) ||
        (value.type !== "source" && value.type !== "memory") ||
        !Number.isSafeInteger(value.id) || value.id <= 0 ||
        typeof value.createdAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.createdAt) ||
        !Number.isFinite(Date.parse(value.createdAt)) || new Date(value.createdAt).toISOString() !== value.createdAt) throw new Error();
      cursor = value;
    } catch {
      throw new TypeError("cursor 不合法或與目前篩選條件不符，請重新載入第一頁");
    }
  }
  return { project, unassigned, writer, type, query, limit, fingerprint, cursor };
}

/** 兩個 adapter 共用聚合與分頁順序；資料表名稱只能由 adapter 傳入其可信常數。 */
export function buildMemoryLibrarySql(
  input: MemoryLibraryFilter,
  dialect: "sqlite" | "postgres",
  tables: { memories: string; sources: string; settings: string },
): { sql: string; params: unknown[]; filter: NormalizedLibraryFilter } {
  const filter = normalizeMemoryLibraryFilter(input);
  const params: unknown[] = [];
  const bind = (value: unknown) => { params.push(value); return dialect === "sqlite" ? `?${params.length}` : `$${params.length}`; };
  const conditions: string[] = [];
  if (filter.project !== null) conditions.push(`project = ${bind(filter.project)}`);
  if (filter.unassigned) conditions.push("project is null");
  if (filter.writer !== null) conditions.push(`writer = ${bind(filter.writer)}`);
  if (filter.type !== null) conditions.push(`library_type = ${bind(filter.type)}`);
  if (filter.query !== null) {
    const query = bind(filter.query);
    const contains = dialect === "sqlite" ? `instr(q.content, ${query})` : `strpos(q.content, ${query})`;
    conditions.push(`exists (select 1 from ${tables.memories} q where q.deleted_at is null
      and ((library_type = 'memory' and q.id = library_id) or (library_type = 'source' and q.source_id = library_id))
      and ${contains} > 0)`);
  }
  const where = conditions.length === 0 ? "1 = 1" : conditions.join(" and ");
  let after = "1 = 1";
  if (filter.cursor !== null) {
    const pinned = bind(filter.cursor.pinned);
    const createdAt = bind(filter.cursor.createdAt);
    const type = bind(filter.cursor.type);
    const id = bind(filter.cursor.id);
    after = `(library_pinned < ${pinned} or (library_pinned = ${pinned} and
      (library_created_at < ${createdAt} or (library_created_at = ${createdAt} and
        (library_type > ${type} or (library_type = ${type} and library_id < ${id}))))))`;
  }
  const limit = bind(filter.limit + 1);
  const jsonAggregate = dialect === "sqlite" ? "json_group_array(value)" : "json_agg(value)";
  const sql = `with library as (
    select 'memory' as library_type, m.id as library_id, m.id as representative_id,
      m.assigned_project as project, m.agent as writer, case when m.pinned then 1 else 0 end as library_pinned,
      m.created_at as library_created_at, 1 as chunk_count
      from ${tables.memories} m where m.deleted_at is null and m.source_id is null
    union all
    select 'source', s.id, min(m.id), s.assigned_project, s.agent,
      max(case when m.pinned then 1 else 0 end), s.created_at, count(*)
      from ${tables.sources} s join ${tables.memories} m on m.source_id = s.id
      where s.deleted_at is null and m.deleted_at is null
      group by s.id, s.assigned_project, s.agent, s.created_at
  ), filtered as (select * from library where ${where}),
  page as (select * from filtered where ${after}
    order by library_pinned desc, library_created_at desc, library_type asc, library_id desc limit ${limit}),
  stats as (select count(*) as total,
    coalesce(sum(case when library_type = 'source' then 1 else 0 end), 0) as sources,
    coalesce(sum(case when library_type = 'memory' then 1 else 0 end), 0) as memories from filtered),
  facets as (select
    (select ${jsonAggregate} from (select distinct project as value from library where project is not null order by project) p) as projects,
    (select ${jsonAggregate} from (select distinct writer as value from library order by writer) w) as writers,
    (select count(*) from library where project is null) as unassigned)
  select m.*, page.library_type, page.library_id, page.library_pinned, page.library_created_at, page.chunk_count,
    stats.total, stats.sources, stats.memories, facets.projects, facets.writers, facets.unassigned,
    (select data_revision from ${tables.settings} where id = 1) as recall_version
    from stats cross join facets left join page on 1 = 1
    left join ${tables.memories} m on m.id = page.representative_id
    order by page.library_pinned desc, page.library_created_at desc, page.library_type asc, page.library_id desc`;
  if (dialect === "sqlite") {
    const positional: unknown[] = [];
    const sqliteSql = sql.replace(/\?(\d+)/g, (_, index: string) => {
      positional.push(params[Number(index) - 1]);
      return "?";
    });
    return { sql: sqliteSql, params: positional, filter };
  }
  return { sql, params, filter };
}

/** SQL 在同一個查詢快照回傳完整統計、選單及一頁代表列。 */
export function readMemoryLibraryRows(
  rows: Record<string, unknown>[],
  filter: NormalizedLibraryFilter,
  toMemory: (row: Record<string, unknown>) => Memory,
): MemoryLibraryPage {
  const meta = rows[0]!;
  const items = rows.filter((row) => row.library_id != null);
  const selected = items.slice(0, filter.limit);
  const last = selected.at(-1);
  const cursor: LibraryCursor | null = items.length > filter.limit && last !== undefined ? {
    version: 1, filter: filter.fingerprint, pinned: Number(last.library_pinned),
    createdAt: String(last.library_created_at), type: last.library_type as LibraryCursor["type"], id: Number(last.library_id),
  } : null;
  const strings = (value: unknown): string[] => value == null ? [] : typeof value === "string" ? JSON.parse(value) as string[] : value as string[];
  return {
    recallVersion: Number(meta.recall_version),
    entries: selected.map((row) => ({
      type: row.library_type as MemoryLibraryEntry["type"], id: Number(row.library_id),
      memory: { ...toMemory(row), pinned: Number(row.library_pinned) !== 0 }, chunkCount: Number(row.chunk_count),
    })),
    total: Number(meta.total), counts: { sources: Number(meta.sources), memories: Number(meta.memories) },
    facets: { projects: strings(meta.projects), writers: strings(meta.writers), hasUnassigned: Number(meta.unassigned) > 0 },
    nextCursor: cursor === null ? null : Buffer.from(JSON.stringify(cursor)).toString("base64url"),
  };
}
