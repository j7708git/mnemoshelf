import {
  chunkMemorySourceMessages,
  MEMORY_SCOPES,
  memorySourceRequestHash,
  normalizeMemorySourceRequest,
  RAW_MEMORY_CHUNK_VERSION,
  type Memory,
  type MemoryOrganization,
  type MemoryPolicy,
  type MemoryScope,
  type MemorySearchBucket,
  type MemorySource,
  type MemorySourceMessage,
  type NewMemorySource,
} from "@mnemoshelf/core";
import { organizationOf, parseOrganizationOrigin } from "./memory-organization.js";
import { ValidationError } from "./errors.js";
import { memoryContentView, metadataView, sourceMessageView, splitsSurrogate } from "./memory-policy.js";

export const MAX_MEMORY_SOURCE_BYTES = 8 * 1024 * 1024;
export type SourceWriteRequest = Omit<NewMemorySource, "requestHash" | "chunkVersion">;

export interface SourceMetadata extends MemoryOrganization {
  id: number;
  agent: string;
  scope: MemoryScope;
  project: string | null;
  sourceSession: string;
  sourceTurn: string;
  createdAt: string;
  chunkVersion: string;
  messageCount: number;
}

type SourceCursor = { messageIndex: number; offset: number; policyVersion: number; recallVersion?: number };
type SourcePageOptions = Omit<SourceCursor, "policyVersion"> & { maxChars: number; policyVersion?: number };

export class MemoryPolicyChangedError extends Error {}

export function parseSourceWriteRequest(input: unknown): SourceWriteRequest {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ValidationError("source", "必須是 JSON 物件");
  }
  const allowed = ["agent", "scope", "project", "sourceSession", "sourceTurn", "messages", "originProject", "assignedProject"];
  if (Object.keys(input).some((key) => !allowed.includes(key))) {
    throw new ValidationError("source", "含有不支援的欄位");
  }
  const payload = input as SourceWriteRequest;
  if (!MEMORY_SCOPES.includes(payload.scope)) {
    throw new ValidationError("scope", "必須是 global、project 或 agent");
  }
  if (Array.isArray(payload.messages) && payload.messages.some(
    (message) => message !== null && typeof message === "object" &&
      Object.keys(message).some((key) => !["sourceMessage", "role", "content", "occurredAt"].includes(key)),
  )) {
    throw new ValidationError("messages", "含有不支援的訊息欄位");
  }
  try {
    return normalizeMemorySourceRequest({ ...payload, ...parseOrganizationOrigin(input as Record<string, unknown>), project: payload.project === undefined ? null : payload.project });
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    throw new ValidationError("source", error.message);
  }
}

export function prepareMemorySource(source: SourceWriteRequest, policy: MemoryPolicy) {
  const requestHash = memorySourceRequestHash(source);
  let redactedCount = 0;
  const messages = source.messages.map((message) => {
    const masked = memoryContentView(message.content, policy);
    redactedCount += masked.count;
    return { ...message, content: masked.text };
  });
  const input = { ...source, messages, requestHash, chunkVersion: RAW_MEMORY_CHUNK_VERSION };
  return { input, chunks: chunkMemorySourceMessages(messages), redactedCount };
}

export function sourceMetadata(source: MemorySource): SourceMetadata {
  return {
    ...organizationOf(source),
    originProject: metadataView(source.originProject),
    assignedProject: metadataView(source.assignedProject),
    id: source.id,
    agent: metadataView(source.agent),
    scope: source.scope,
    project: metadataView(source.project),
    sourceSession: metadataView(source.sourceSession),
    sourceTurn: metadataView(source.sourceTurn),
    createdAt: source.createdAt,
    chunkVersion: source.chunkVersion,
    messageCount: source.messages.length,
  };
}

export function sourceBackupView(source: MemorySource, policy: MemoryPolicy): SourceWriteRequest {
  const { agent, scope, project, sourceSession, sourceTurn } = sourceMetadata(source);
  return {
    agent, scope, project, sourceSession, sourceTurn,
    messages: source.messages.map((message) => sourceMessageView(message, policy)),
  };
}

export function isMemoryVisible(
  memory: Pick<Memory, "scope" | "project" | "agent"> & Partial<MemoryOrganization>,
  buckets: readonly MemorySearchBucket[],
): boolean {
  const policy = memory.recallPolicy ?? memory.scope;
  const project = memory.assignedProject === undefined ? memory.project : memory.assignedProject;
  if (policy === "disabled" || (policy === "project" && project === null)) return false;
  return buckets.some((bucket) =>
    bucket.scope === policy &&
    (bucket.project === undefined || bucket.project === project) &&
    (bucket.agent === undefined || bucket.agent === memory.agent),
  );
}

export function parseSourcePageOptions(params: URLSearchParams): SourcePageOptions {
  const numberParam = (name: string, min: number, max = Number.MAX_SAFE_INTEGER): number | undefined => {
    const raw = params.get(name);
    if (raw === null) return undefined;
    const value = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min || value > max) {
      throw new ValidationError(name, `必須是 ${min} 到 ${max} 之間的整數`);
    }
    return value;
  };
  const messageIndex = numberParam("messageIndex", 0);
  const offset = numberParam("offset", 0);
  const policyVersion = numberParam("policyVersion", 1);
  const recallVersion = numberParam("recallVersion", 0);
  const maxChars = numberParam("maxChars", 1, 32_000) ?? 8_000;
  if (((messageIndex ?? 0) > 0 || (offset ?? 0) > 0) && policyVersion === undefined) {
    throw new ValidationError("policyVersion", "續讀時必須提供政策版本");
  }
  return { messageIndex: messageIndex ?? 0, offset: offset ?? 0, maxChars, policyVersion, recallVersion };
}

export function paginateMemorySource(source: MemorySource, options: SourcePageOptions, policy: MemoryPolicy, recallVersion?: number) {
  if (recallVersion !== undefined && ((options.messageIndex > 0 || options.offset > 0) && options.recallVersion === undefined || options.recallVersion !== undefined && options.recallVersion !== recallVersion)) throw new MemoryPolicyChangedError();
  if (options.policyVersion !== undefined && options.policyVersion !== policy.version) {
    throw new MemoryPolicyChangedError();
  }
  if (options.messageIndex >= source.messages.length) {
    throw new ValidationError("messageIndex", "超出訊息範圍");
  }
  let { messageIndex, offset } = options;
  let remaining = options.maxChars;
  const messages: Array<MemorySourceMessage & {
    messageIndex: number;
    start: number;
    end: number;
    totalChars: number;
    complete: boolean;
  }> = [];

  for (; messageIndex < source.messages.length; messageIndex += 1, offset = 0) {
    const message = sourceMessageView(source.messages[messageIndex]!, policy);
    const totalChars = message.content.length;
    if (offset > totalChars || splitsSurrogate(message.content, offset)) {
      throw new ValidationError("offset", "超出可讀取的訊息字元範圍");
    }
    const limit = Math.min(totalChars, offset + remaining);
    const end = limit - Number(splitsSurrogate(message.content, limit));
    if (end === offset && end < totalChars) {
      if (messages.length === 0) throw new ValidationError("maxChars", "不足以讀取下一個完整字元");
      break;
    }
    messages.push({
      ...message,
      content: message.content.slice(offset, end),
      messageIndex,
      start: offset,
      end,
      totalChars,
      complete: offset === 0 && end === totalChars,
    });
    remaining -= end - offset;
    if (end < totalChars) {
      offset = end;
      break;
    }
  }
  const next: SourceCursor | null = messageIndex < source.messages.length
    ? { messageIndex, offset, policyVersion: policy.version, ...(recallVersion === undefined ? {} : { recallVersion }) }
    : null;
  return { messages, next, truncated: next !== null, policyVersion: policy.version, ...(recallVersion === undefined ? {} : { recallVersion }), untrusted: true as const };
}
