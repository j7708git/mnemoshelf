import { createHash } from "node:crypto";
import { MEMORY_SCOPES, normalizeMemoryPatch } from "../ports/metadata-store.js";
import type { Memory, MemoryPatch, MemoryScope } from "../ports/types.js";
import { maskSecrets } from "../privacy/secret-masking.js";

export interface MemoryPolicy {
  maskSecrets: boolean;
  version: number;
}

export interface MemorySourceMessage {
  sourceMessage: string;
  role: "user" | "assistant";
  content: string;
  occurredAt: string | null;
}

export interface MemorySource {
  id: number;
  agent: string;
  scope: MemoryScope;
  project: string | null;
  sourceSession: string;
  sourceTurn: string;
  messages: MemorySourceMessage[];
  requestHash: string;
  chunkVersion: string;
  createdAt: string;
  deletedAt: string | null;
}

export type NewMemorySource = Omit<MemorySource, "id" | "createdAt" | "deletedAt">;
export type MemorySourceEventCheck = Pick<NewMemorySource, "agent" | "sourceSession" | "sourceTurn" | "requestHash">;

export interface NewMemorySourceChunk {
  messageIndex: number;
  chunkIndex: number;
  start: number;
  end: number;
  content: string;
}

export interface MemorySourceWriteResult {
  source: MemorySource;
  memories: Memory[];
  duplicate: boolean;
}

export class MemorySourceConflictError extends Error {
  readonly code = "source-conflict";

  constructor() {
    super("原文來源事件衝突");
    this.name = "MemorySourceConflictError";
  }
}

export const RAW_MEMORY_CHUNK_VERSION = "raw-v1";
const MAX_CHUNK_LENGTH = 1024;
const CHUNK_OVERLAP = 128;
const MAX_METADATA_LENGTH = 200;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
// Unicode 模式只匹配孤立 surrogate，合法的 surrogate pair 視為單一 code point。
const UNSUPPORTED_TEXT = /[\0\uD800-\uDFFF]/u;

function splitsSurrogate(content: string, offset: number): boolean {
  const before = content.charCodeAt(offset - 1);
  const after = content.charCodeAt(offset);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

function splitsCrlf(content: string, offset: number): boolean {
  return content[offset - 1] === "\r" && content[offset] === "\n";
}

function chunkEnd(content: string, start: number): number {
  const limit = Math.min(content.length, start + MAX_CHUNK_LENGTH);
  if (limit === content.length) return limit;
  const end = splitsSurrogate(content, limit) || splitsCrlf(content, limit) ? limit - 1 : limit;
  const window = content.slice(start, end);
  let lastBreak = -1;
  let lastParagraph = -1;
  let previousBreak = -1;
  for (const match of window.matchAll(/\r\n|[\r\n]/g)) {
    const boundary = match.index + match[0].length;
    if (boundary >= MAX_CHUNK_LENGTH / 2) {
      lastBreak = boundary;
      if (previousBreak >= 0 && /^[ \t]*$/.test(window.slice(previousBreak, match.index))) {
        lastParagraph = boundary;
      }
    }
    previousBreak = boundary;
  }
  return start + (lastParagraph >= 0 ? lastParagraph : lastBreak >= 0 ? lastBreak : window.length);
}

/** 依保存文字切塊，位置以各訊息的 UTF-16 字元計算。 */
export function chunkMemorySourceMessages(
  messages: readonly Pick<MemorySourceMessage, "content">[],
): NewMemorySourceChunk[] {
  const chunks: NewMemorySourceChunk[] = [];
  for (const [messageIndex, { content }] of messages.entries()) {
    if (content.trim().length === 0) continue;
    let start = 0;
    while (start < content.length) {
      const end = chunkEnd(content, start);
      chunks.push({ messageIndex, chunkIndex: chunks.length, start, end, content: content.slice(start, end) });
      if (end === content.length) break;
      // 中途的切點至少在視窗後半段，扣掉重疊後仍會往前推進。
      start = end - CHUNK_OVERLAP;
      if (splitsSurrogate(content, start) || splitsCrlf(content, start)) start -= 1;
    }
  }
  return chunks;
}

type MemorySourceRequest = Omit<NewMemorySource, "requestHash" | "chunkVersion">;

function sourceMetadata(value: unknown, field: string): string {
  if (typeof value !== "string" || UNSUPPORTED_TEXT.test(value)) {
    throw new TypeError(`原文來源的 ${field} 必須是有效字串`);
  }
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > MAX_METADATA_LENGTH || maskSecrets(normalized).redacted) {
    throw new TypeError(`原文來源的 ${field} 不合法`);
  }
  return normalized;
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_TIMESTAMP.test(value) || !Number.isFinite(Date.parse(value))) return false;
  const day = value.slice(0, 10);
  // Date.parse 會將部分無效日期進位到下個月。
  return new Date(`${day}T00:00:00Z`).toISOString().startsWith(day);
}

/** 更新原文來源時，專案名稱沿用同一套來源 metadata 驗證。 */
export function normalizeMemorySourceScope(
  current: Pick<MemorySource, "scope" | "project">,
  patch: MemoryPatch,
): Pick<MemorySource, "scope" | "project"> {
  if (!MEMORY_SCOPES.includes(patch.scope === undefined ? current.scope : patch.scope)) {
    throw new TypeError("原文來源的 scope 不合法");
  }
  const { scope, project } = normalizeMemoryPatch(current, patch);
  return { scope, project: project === null ? null : sourceMetadata(project, "project") };
}

/** 驗證來源欄位並正規化識別值，訊息內容與時間保留原值。 */
export function normalizeMemorySourceRequest(input: MemorySourceRequest): MemorySourceRequest {
  const { scope, project } = normalizeMemorySourceScope(input, { scope: input.scope, project: input.project });
  const agent = sourceMetadata(input.agent, "agent");
  const sourceSession = sourceMetadata(input.sourceSession, "sourceSession");
  const sourceTurn = sourceMetadata(input.sourceTurn, "sourceTurn");
  if (!Array.isArray(input.messages) || input.messages.length === 0) throw new TypeError("原文來源缺少訊息");
  const ids = new Set<string>();
  const messages = Array.from(input.messages, (message): MemorySourceMessage => {
    if (message === null || typeof message !== "object") throw new TypeError("原文來源的訊息不合法");
    const sourceMessage = sourceMetadata(message.sourceMessage, "sourceMessage");
    if (ids.has(sourceMessage)) throw new TypeError("原文來源的訊息識別值重複");
    ids.add(sourceMessage);
    const { role, content, occurredAt } = message;
    if (role !== "user" && role !== "assistant") throw new TypeError("原文來源的訊息角色不合法");
    if (typeof content !== "string" || UNSUPPORTED_TEXT.test(content)) {
      throw new TypeError("原文來源的訊息必須是有效字串");
    }
    if (occurredAt !== null && !isIsoTimestamp(occurredAt)) {
      throw new TypeError("原文來源的訊息時間不合法");
    }
    return { sourceMessage, role, content, occurredAt };
  });
  if (messages.every(({ content }) => content.trim().length === 0)) throw new TypeError("原文來源的訊息全部為空");
  return { agent, scope, project, sourceSession, sourceTurn, messages };
}

function hashFields(fields: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(fields), "utf8").digest("hex");
}

/** 原始事件內容的雜湊，呼叫端須在機密遮罩前計算。 */
export function memorySourceRequestHash(input: MemorySourceRequest): string {
  const { agent, scope, project, sourceSession, sourceTurn, messages } = normalizeMemorySourceRequest(input);
  return hashFields([agent, scope, project, sourceSession, sourceTurn, messages]);
}

/** 只雜湊已正規化的事件識別，供硬刪除保留最小 tombstone。 */
export function memorySourceEventHash(source: Pick<MemorySource, "agent" | "sourceSession" | "sourceTurn">): string {
  return hashFields([source.agent, source.sourceSession, source.sourceTurn]);
}

/** 驗證來源切塊的順序、範圍與實際保存文字。 */
export function assertMemorySourceChunks(
  messages: readonly MemorySourceMessage[],
  chunkVersion: string,
  chunks: readonly NewMemorySourceChunk[],
): void {
  if (typeof chunkVersion !== "string" || !/^[A-Za-z0-9._-]{1,200}$/.test(chunkVersion)) {
    throw new TypeError("原文來源的切塊版本不合法");
  }
  if (!Array.isArray(chunks) || chunks.length === 0) throw new TypeError("原文來源缺少切塊");
  const emptyMessages = messages.map(({ content }) => content.trim().length === 0);
  for (const [index, chunk] of chunks.entries()) {
    if (chunk === null || typeof chunk !== "object") throw new TypeError("原文來源的切塊不合法");
    const { messageIndex, chunkIndex, start, end, content } = chunk;
    const message = messages[messageIndex];
    if (
      chunkIndex !== index || !Number.isInteger(messageIndex) || message === undefined || emptyMessages[messageIndex] ||
      !Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > message.content.length ||
      (chunkVersion === RAW_MEMORY_CHUNK_VERSION && end - start > MAX_CHUNK_LENGTH) ||
      splitsSurrogate(message.content, start) || splitsSurrogate(message.content, end) ||
      message.content.slice(start, end) !== content
    ) {
      throw new TypeError("原文來源的切塊範圍或內容不合法");
    }
  }
}

/** 在資料庫寫入前完整檢查來源及片段。 */
export function validateMemorySourceWrite(input: NewMemorySource, chunks: NewMemorySourceChunk[]): NewMemorySource {
  const normalized = normalizeMemorySourceRequest(input);
  const { requestHash, chunkVersion } = input;
  assertRequestHash(requestHash);
  assertMemorySourceChunks(normalized.messages, chunkVersion, chunks);
  return { ...normalized, requestHash, chunkVersion };
}

/** 預檢使用與正式寫入相同的事件識別正規化。 */
export function normalizeMemorySourceEventCheck(input: MemorySourceEventCheck): MemorySourceEventCheck {
  assertRequestHash(input.requestHash);
  return {
    agent: sourceMetadata(input.agent, "agent"),
    sourceSession: sourceMetadata(input.sourceSession, "sourceSession"),
    sourceTurn: sourceMetadata(input.sourceTurn, "sourceTurn"),
    requestHash: input.requestHash,
  };
}

function assertRequestHash(requestHash: unknown): void {
  if (typeof requestHash !== "string" || !/^[0-9a-f]{64}$/.test(requestHash)) {
    throw new TypeError("原文來源的事件內容雜湊不合法");
  }
}

/** SQLite 與 PostgreSQL 均須拒絕無法判讀的已存政策。 */
export function readMemoryPolicy(row: { mask_secrets?: unknown; version?: unknown } | undefined): MemoryPolicy {
  if (row === undefined) return { maskSecrets: true, version: 1 };
  const { mask_secrets: mask, version } = row;
  if (
    (mask !== true && mask !== false && mask !== 1 && mask !== 0) ||
    typeof version !== "number" || !Number.isSafeInteger(version) || version < 1
  ) {
    throw new Error("記憶遮罩政策資料不合法");
  }
  return { maskSecrets: mask === true || mask === 1, version };
}
