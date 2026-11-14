/** 記憶 NDJSON 備份的序列化、整批驗證與匯入計畫。 */
import {
  MEMORY_SCOPES,
  memoryContentHash,
  type Memory,
  type MemoryKind,
  type MemoryScope,
  type MemoryPolicy,
  type MemorySource,
  type MemoryOrganization,
  type MemoryRecallSettings,
  type MemoryRecallRule,
  type MemoryExportRecord as StoredMemoryExportRecord,
} from "@mnemoshelf/core";
import { organizationOf, parseOrganizationSnapshot, parseRecallRule } from "./memory-organization.js";
import { ValidationError } from "./errors.js";
import { maskSecrets } from "./secret-masking.js";
import { memoryContentView, metadataView } from "./memory-policy.js";
import { parseSourceWriteRequest, prepareMemorySource, sourceBackupView, sourceMetadata } from "./memory-source.js";

/** 舊版扁平記憶備份的格式版本。 */
export const MEMORY_EXPORT_SCHEMA_VERSION = 1;
export const RAW_MEMORY_EXPORT_SCHEMA_VERSION = 2;
export const ORGANIZED_MEMORY_EXPORT_SCHEMA_VERSION = 3;
/** 匯出回應的 content-type（NDJSON）。 */
export const MEMORY_EXPORT_CONTENT_TYPE = "application/x-ndjson; charset=utf-8";
/** 匯入請求主體上限（32 MiB）；超過回 413。 */
export const MAX_MEMORY_IMPORT_BYTES = 32 * 1024 * 1024;
/** 400 回應最多回報幾行錯誤（避免整份都是壞行時回應爆量）。 */
export const MAX_MEMORY_IMPORT_ERRORS = 100;
/** 單筆記憶內容長度上限（UTF-16 長度；與 `POST /memories` 相同）。 */
export const MAX_MEMORY_CHARS = 8000;
/** 記憶的 agent／project 名稱長度上限（UTF-16 長度；與 `POST /memories` 相同）。 */
export const MAX_MEMORY_METADATA_CHARS = 200;
/** 合法的記憶種類（與 `MemoryKind` 一致；REST 與匯入共用同一份）。 */
export const MEMORY_KINDS: readonly MemoryKind[] = ["fact", "decision", "pitfall", "preference"];

/** 匯出檔的一列（欄位順序就是序列化順序，方便人眼看 diff）。 */
export interface MemoryExportRecord {
  schemaVersion: typeof MEMORY_EXPORT_SCHEMA_VERSION;
  id: number;
  content: string;
  kind: MemoryKind;
  scope: MemoryScope;
  project: string | null;
  agent: string;
  /** 寫入來源（session／訊息；D4a）。舊備份沒有這兩個欄位，匯入時補 `null`。 */
  sourceSession: string | null;
  sourceMessage: string | null;
  pinned: boolean;
  createdAt: string;
  supersedes: number | null;
}

/** 通過格式驗證、等待寫入的一筆匯入資料（`content` 已是遮罩後內容）。 */
export interface MemoryImportEntry {
  dedupe: { scope: MemoryScope; project: string | null };
  organization: MemoryOrganization;
  /** 來源行號（從 1 起算，含被忽略的空行）。 */
  line: number;
  content: string;
  kind: MemoryKind;
  scope: MemoryScope;
  project: string | null;
  agent: string;
  /** 來源欄位（舊備份缺欄位＝`null`；有值時已 trim 並驗證長度／機密）。 */
  sourceSession: string | null;
  sourceMessage: string | null;
  pinned: boolean;
  /** 這一行的 `content` 是否被遮罩過。 */
  redacted: boolean;
}

/** 一行不合法（`line` 從 1 起算；`reason` 不含原文，避免把機密寫進回應）。 */
export interface MemoryImportLineError {
  line: number;
  reason: string;
}

/** `planMemoryImport` 的結果；不含任何寫入動作。 */
export interface MemoryImportPlan {
  rules?: MemoryRecallRule[];
  /** 非空行的總數（空白行忽略、不計入）。 */
  total: number;
  /** 通過驗證的資料列。 */
  entries: MemoryImportEntry[];
  /** 通過驗證且已依同一政策快照備妥的原文來源。 */
  sources: Array<ReturnType<typeof prepareMemorySource> & { pinned: boolean }>;
  /** 前 `MAX_MEMORY_IMPORT_ERRORS` 筆錯誤。 */
  invalid: MemoryImportLineError[];
  /** 不合法的行數（可能大於 `invalid.length`，用於計算 `valid`）。 */
  invalidCount: number;
  /** `entries` 中被遮罩的內容筆數。 */
  redacted: number;
}

/** `POST /memories/import` 的回應（成功或 dry-run；400 時另含 `error`）。 */
export interface MemoryImportResponse {
  rules?: { mode: "preserve" | "replace"; available: number; availableInBackup: boolean; replaced: boolean; revision: number };
  partial?: boolean;
  failed?: number;
  dryRun: boolean;
  total: number;
  valid: number;
  invalid: MemoryImportLineError[];
  /** 因為與既有（或同批次較早）的未刪除記憶同 key 而跳過的筆數。 */
  duplicates: number;
  /** 內容被遮罩的筆數（以「筆」計，不是機密片段數）。 */
  redacted: number;
  /** 實際新增的筆數（dry-run 一律 0）。 */
  created: number;
  /** dry-run 預計新增的筆數（正式匯入一律 0）。 */
  wouldCreate: number;
}

/** 匯出日期檔名：`memories-YYYYMMDD.ndjson`（本地時間）。 */
export function memoryExportFilename(now: Date = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `memories-${year}${month}${day}.ndjson`;
}

/** 把一筆（已遮罩的）記憶轉成匯出列。 */
export function memoryExportRecord(memory: Memory): MemoryExportRecord {
  return {
    schemaVersion: MEMORY_EXPORT_SCHEMA_VERSION,
    id: memory.id,
    content: memory.content,
    kind: memory.kind,
    scope: memory.scope,
    project: memory.project,
    agent: memory.agent,
    sourceSession: memory.sourceSession,
    sourceMessage: memory.sourceMessage,
    pinned: memory.pinned,
    createdAt: memory.createdAt,
    supersedes: memory.supersedes,
  };
}

/** 序列化一列（不含換行）。 */
export function serializeMemoryExportLine(memory: Memory): string {
  return JSON.stringify(memoryExportRecord(memory));
}

/**
 * 序列化整份匯出檔：一行一筆、**結尾換行**；0 筆時回空 Buffer（不是只有換行的檔案）。
 */
export function serializeMemoriesExport(memories: readonly Memory[]): Buffer {
  if (memories.length === 0) return Buffer.alloc(0);
  const text = `${memories.map(serializeMemoryExportLine).join("\n")}\n`;
  return Buffer.from(text, "utf8");
}

/** 匯出 v2 的記憶與原文來源列，來源片段由匯入端重建。 */
export function serializeRawMemoriesExport(
  memories: readonly Memory[], sources: readonly (MemorySource & { pinned: boolean })[], policy: MemoryPolicy,
): Buffer {
  const schemaVersion = RAW_MEMORY_EXPORT_SCHEMA_VERSION;
  const rows = memories.map((memory) => {
    const { schemaVersion: _legacyVersion, ...fields } = memoryExportRecord(memory);
    return JSON.stringify({ schemaVersion, type: "memory", memory: fields });
  });
  for (const source of sources) {
    rows.push(JSON.stringify({
      schemaVersion,
      type: "source",
      source: sourceBackupView(source, policy),
      createdAt: source.createdAt,
      pinned: source.pinned,
    }));
  }
  return rows.length === 0 ? Buffer.alloc(0) : Buffer.from(`${rows.join("\n")}\n`, "utf8");
}

/**
 * 解析 `POST /memories/import` 的 `dryRun` 查詢參數。
 *
 * 刻意嚴格：未帶參數＝正式匯入；只接受 `1`／`true`，其他值（含空字串、`0`、`false`、`YES`）
 * 一律 400——避免「以為是預覽、其實已寫入」。
 */
export function parseDryRunParam(value: string | null): boolean {
  if (value === null) return false;
  if (value === "1" || value === "true") return true;
  throw new ValidationError("dryRun", "只接受 1 或 true（未帶參數＝正式匯入）");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function lineError(reason: string): never {
  throw new Error(reason);
}

/** 必填的非空字串（trim 後非空；保留原文，長度上限以原文計）。 */
function requireImportString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    lineError(`${field} 必須是非空的字串`);
  }
  if (value.length > maxLength) lineError(`${field} 長度上限 ${maxLength} 字元`);
  return value;
}

/** agent／project／來源欄位是查詢鍵或識別值：含 token-like 機密時整行不合法（不遮罩改寫）。 */
function assertImportMetadataClean(
  value: string,
  field: "agent" | "project" | "sourceSession" | "sourceMessage",
): void {
  if (maskSecrets(value).redacted) {
    lineError(`${field} 不得包含機密（偵測到可能的 token／金鑰；請移除後再匯入）`);
  }
}

/**
 * 解析可選的來源欄位（`sourceSession`／`sourceMessage`；D4a）。
 *
 * - 省略或 `null` → `null`（舊備份沒有這兩個欄位時就是這條路徑）；
 * - 有值必須是字串；trim 後為空 → 該行不合法（不靜默改成 `null`）；
 * - 長度上限 `MAX_MEMORY_METADATA_CHARS`（以 trim 後計），超過不截斷、整行不合法；
 * - 含 token-like 機密 → 整行不合法（與 agent／project 相同理由：識別值不遮罩改寫）。
 */
function optionalImportSourceRef(value: unknown, field: "sourceSession" | "sourceMessage"): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") lineError(`${field} 必須是字串或 null`);
  const trimmed = value.trim();
  if (trimmed === "") lineError(`${field} 不得是空字串（沒有來源請省略或給 null）`);
  if (trimmed.length > MAX_MEMORY_METADATA_CHARS) {
    lineError(`${field} 長度上限 ${MAX_MEMORY_METADATA_CHARS} 字元`);
  }
  assertImportMetadataClean(trimmed, field);
  return trimmed;
}

/**
 * 驗證並正規化一行匯入資料。
 *
 * 規則與 `POST /memories` 一致（單一來源概念，勿各自解讀）：
 * - `content` 必填、非空、≤ `MAX_MEMORY_CHARS`，先遮罩；
 * - `kind` 可省略（預設 `fact`）；`scope` 可省略（有 `project` → `project`，否則 `global`）；
 * - `scope=project` 的 `project` 必須 trim 後非空；非 project scope 不得帶字串 project
 *   （`project: null` 視同未提供，匯出檔的全域列就是這樣）；
 * - `agent` 必填、≤ `MAX_MEMORY_METADATA_CHARS`；agent／project 不得 token-like；
 * - `pinned` 可省略（預設 false），有提供就必須是 boolean；
 * - `sourceSession`／`sourceMessage` 可省略（D4a；省略或 `null` → `null`），有值必須是
 *   非空、≤ 200 字元的字串（trim 後儲存），且不得是 token-like 機密；
 * - `schemaVersion` 可省略，有提供就必須是 1（來源欄位是 additive，因此**不升版**）；
 * - `id`／`createdAt`／`supersedes` 與未知欄位一律忽略（不保留）。
 */
function parseImportLine(record: unknown, line: number, policy: MemoryPolicy): MemoryImportEntry {
  if (!isRecord(record)) lineError("每一行必須是 JSON 物件");

  if (record.schemaVersion !== undefined && record.schemaVersion !== MEMORY_EXPORT_SCHEMA_VERSION) {
    lineError(`schemaVersion 必須是 ${MEMORY_EXPORT_SCHEMA_VERSION}（或省略）`);
  }

  const rawContent = requireImportString(record.content, "content", MAX_MEMORY_CHARS);
  const masked = memoryContentView(rawContent, policy);

  const kind =
    record.kind === undefined || record.kind === null
      ? "fact"
      : typeof record.kind === "string" && (MEMORY_KINDS as readonly string[]).includes(record.kind)
        ? (record.kind as MemoryKind)
        : lineError(`kind 必須是 ${MEMORY_KINDS.join(" / ")} 之一`);

  const agent = requireImportString(record.agent, "agent", MAX_MEMORY_METADATA_CHARS);
  assertImportMetadataClean(agent, "agent");

  let projectInput: string | undefined;
  if (record.project !== undefined && record.project !== null) {
    if (typeof record.project !== "string") lineError("project 必須是字串或 null");
    if (record.project.length > MAX_MEMORY_METADATA_CHARS) {
      lineError(`project 長度上限 ${MAX_MEMORY_METADATA_CHARS} 字元`);
    }
    projectInput = record.project;
  }
  const hasProject = projectInput !== undefined;

  let scope: MemoryScope;
  if (record.scope === undefined) {
    scope = hasProject ? "project" : "global";
  } else if (record.scope === null) {
    lineError(`scope 必須是 ${MEMORY_SCOPES.join(" / ")} 之一`);
  } else if (typeof record.scope !== "string" || !(MEMORY_SCOPES as readonly string[]).includes(record.scope)) {
    lineError(`scope 必須是 ${MEMORY_SCOPES.join(" / ")} 之一`);
  } else {
    scope = record.scope as MemoryScope;
  }

  let project: string | null = null;
  if (scope === "project") {
    const trimmed = projectInput?.trim() ?? "";
    if (trimmed === "") lineError("scope 為 project 時必須提供非空的專案名稱");
    assertImportMetadataClean(trimmed, "project");
    project = trimmed;
  } else if (hasProject) {
    lineError(`scope 為 ${scope} 時 project 必須是 null（全域／agent 範圍沒有專案）`);
  }

  const sourceSession = optionalImportSourceRef(record.sourceSession, "sourceSession");
  const sourceMessage = optionalImportSourceRef(record.sourceMessage, "sourceMessage");

  let pinned = false;
  if (record.pinned !== undefined) {
    if (typeof record.pinned !== "boolean") lineError("pinned 必須是布林值");
    pinned = record.pinned;
  }

  return {
    line,
    content: masked.text,
    kind,
    scope,
    project,
    agent,
    sourceSession,
    sourceMessage,
    pinned,
    redacted: masked.redacted,
    dedupe: { scope, project },
    organization: { originProject: null, assignedProject: project, recallPolicy: scope, recallPolicySource: "legacy", recallRuleId: null, recallRuleRevision: null },
  };
}

/**
 * 解析整份 NDJSON 並逐行驗證（**不寫入**）。
 *
 * - 空行（含只有空白的行）忽略；`\r\n` 的 `\r` 會去掉；開頭的 BOM 會去掉。
 * - `total` 是非空行數；`valid = total - invalidCount`。
 * - 錯誤只保留前 `MAX_MEMORY_IMPORT_ERRORS` 筆，但 `invalidCount` 仍是完整計數。
 */
export function planMemoryImport(
  text: string, policy: MemoryPolicy = { maskSecrets: true, version: 1 },
): MemoryImportPlan {
  const normalized = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = normalized.split("\n");
  const entries: MemoryImportEntry[] = [];
  const sources: MemoryImportPlan["sources"] = [];
  const invalid: MemoryImportLineError[] = [];
  let total = 0;
  let invalidCount = 0;
  let redacted = 0;
  let rules: MemoryRecallRule[] | undefined;

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index]!.endsWith("\r") ? lines[index]!.slice(0, -1) : lines[index]!;
    if (raw.trim() === "") continue;
    total += 1;
    const line = index + 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      invalidCount += 1;
      if (invalid.length < MAX_MEMORY_IMPORT_ERRORS) {
        invalid.push({ line, reason: "不是合法的 JSON" });
      }
      continue;
    }
    try {
      let organization: MemoryOrganization | undefined;
      let dedupe: MemoryImportEntry["dedupe"] | undefined;
      if (isRecord(parsed) && parsed.schemaVersion === ORGANIZED_MEMORY_EXPORT_SCHEMA_VERSION) {
        if (parsed.type === "settings") {
          if (rules !== undefined || !Array.isArray(parsed.rules)) lineError("v3 規則設定只能有一列");
          rules = parsed.rules.map((rule: unknown) => parseRecallRule(rule));
          const ids = new Set(rules.map((rule) => rule.id));
          const selectors = new Set(rules.map((rule) => JSON.stringify([rule.project ?? null, rule.writer ?? null])));
          if (ids.size !== rules.length || selectors.size !== rules.length) lineError("規則 id 或 selector 重複");
          total -= 1;
          continue;
        }
        organization = parseOrganizationSnapshot(parsed.organization);
        if (parsed.type === "memory") {
          if (!isRecord(parsed.dedupe)) lineError("v3 memory 必須保留 dedupe scope/project");
          const scope = parsed.dedupe.scope;
          const project = parsed.dedupe.project;
          if (!MEMORY_SCOPES.includes(scope as MemoryScope)) lineError("dedupe.scope 不合法");
          if (scope === "project") { requireImportString(project, "dedupe.project", MAX_MEMORY_METADATA_CHARS); if (maskSecrets(project as string).redacted) lineError("dedupe.project 不得含機密"); }
          else if (project !== null) lineError("dedupe.project 在非 project 範圍必須是 null");
          dedupe = { scope: scope as MemoryScope, project: typeof project === "string" ? project.trim() : null };
        }
      }
      if (isRecord(parsed) && (parsed.schemaVersion === RAW_MEMORY_EXPORT_SCHEMA_VERSION || parsed.schemaVersion === ORGANIZED_MEMORY_EXPORT_SCHEMA_VERSION)) {
        if (parsed.type === "source") {
          if (typeof parsed.createdAt !== "string" || !Number.isFinite(Date.parse(parsed.createdAt))) {
            lineError("createdAt 必須是有效的 ISO 8601 時間");
          }
          if (parsed.pinned !== undefined && typeof parsed.pinned !== "boolean") {
            lineError("pinned 必須是布林值");
          }
          const source = prepareMemorySource(parseSourceWriteRequest(parsed.source), policy);
          source.input.organization = organization ?? { originProject: null, assignedProject: source.input.project, recallPolicy: source.input.scope, recallPolicySource: "legacy", recallRuleId: null, recallRuleRevision: null };
          sources.push({ ...source, pinned: parsed.pinned ?? false });
          if (source.redactedCount > 0) redacted += 1;
          continue;
        }
        if (parsed.type !== "memory") lineError("v2 type 必須是 memory 或 source");
        parsed = parsed.memory;
      }
      const entry = parseImportLine(parsed, line, policy);
      if (organization !== undefined) entry.organization = organization;
      if (dedupe !== undefined) entry.dedupe = dedupe;
      entries.push(entry);
      if (entry.redacted) redacted += 1;
    } catch (error) {
      invalidCount += 1;
      if (invalid.length < MAX_MEMORY_IMPORT_ERRORS) {
        invalid.push({ line, reason: error instanceof Error ? error.message : "不合法" });
      }
    }
  }

  return { total, entries, sources, invalid, invalidCount, redacted, ...(rules === undefined ? {} : { rules }) };
}

/** 匯入去重採原始 scope/project、寫入者、歸屬與內容 hash；兩種專案欄位皆 null-safe。 */
type DedupeRecord = Pick<Memory, "content" | "scope" | "project" | "agent"> & { assignedProject?: string | null; organization?: MemoryOrganization; dedupe?: MemoryImportEntry["dedupe"]; dedupeScope?: MemoryScope; dedupeProject?: string | null };
function duplicateKey(memory: DedupeRecord): string {
  const scope = memory.dedupe?.scope ?? memory.dedupeScope ?? memory.scope;
  const project = memory.dedupe !== undefined ? memory.dedupe.project : memory.dedupeScope !== undefined ? memory.dedupeProject : memory.project;
  const assigned = memory.organization !== undefined ? memory.organization.assignedProject : memory.assignedProject === undefined ? memory.project : memory.assignedProject;
  return [memoryContentHash(memory.content), scope, project ?? "\u0000", memory.agent, assigned ?? "\u0000"].join("\u0000");
}

/**
 * dry-run 用：估算這批（已遮罩的）資料會有幾筆被去重跳過。
 *
 * 與正式匯入的一致性：`existing` 傳入 `listMemoriesForExport()` 的全部未刪除記憶
 * （資料庫原文；其內容 hash 與儲存層的 `content_hash` 同源），依序比對；
 * **同批次內較早的資料也算進去**（正式匯入時第二筆相同內容會被跳過）。
 * 正式匯入不採信這個估算，而是用 `addMemoryUnlessDuplicate` 的實際結果計數。
 */
export function countImportDuplicates(
  entries: readonly DedupeRecord[],
  existing: readonly (DedupeRecord & Pick<Memory, "deletedAt">)[],
): number {
  const seen = new Set<string>();
  for (const memory of existing) {
    if (memory.deletedAt !== null) continue;
    seen.add(duplicateKey(memory));
  }
  let duplicates = 0;
  for (const entry of entries) {
    const key = duplicateKey(entry);
    if (seen.has(key)) duplicates += 1;
    else seen.add(key);
  }
  return duplicates;
}

/** v3 保留組織與規則快照；不包含內部 hash、已刪除歷史或 tombstone。 */
export function serializeOrganizedMemoriesExport(
  memories: readonly StoredMemoryExportRecord[], sources: readonly (MemorySource & { pinned: boolean })[], policy: MemoryPolicy,
  settings: MemoryRecallSettings,
): Buffer {
  const schemaVersion = ORGANIZED_MEMORY_EXPORT_SCHEMA_VERSION;
  const rows: unknown[] = [{ schemaVersion, type: "settings", rules: settings.rules }];
  for (const memory of memories) {
    const { schemaVersion: _version, ...fields } = memoryExportRecord(memory);
    rows.push({ schemaVersion, type: "memory", memory: fields, organization: organizationOf(memory), dedupe: { scope: memory.dedupeScope, project: metadataView(memory.dedupeProject) } });
  }
  for (const source of sources) rows.push({ schemaVersion, type: "source", source: sourceBackupView(source, policy), organization: organizationOf(sourceMetadata(source)), createdAt: source.createdAt, pinned: source.pinned });
  return Buffer.from(rows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
}
