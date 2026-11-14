/**
 * 宿主外掛共用的原文回合協定。兩個外掛可獨立安裝，這裡只依賴 Node 與純文字遮罩。
 */
import { createHash } from "node:crypto";
import { maskSecrets } from "./secret-masking.js";

export interface MemorySourceMessage {
  sourceMessage: string;
  role: "user" | "assistant";
  content: string;
  occurredAt: string | null;
}

export interface SourceWriteRequest {
  agent: string;
  scope: "project" | "global";
  project?: string;
  sourceSession: string;
  sourceTurn: string;
  messages: MemorySourceMessage[];
}

export interface MemoryPolicy {
  maskSecrets: boolean;
  version: number;
  recallVersion?: number;
}

export interface RawConnection {
  baseUrl: string;
  token: string;
}

export type PolicyResult =
  | { ok: true; policy: MemoryPolicy }
  | { ok: false; reason: "upgrade-required" | "policy-unavailable" };

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function isPositiveId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** 識別值太長或像機密時取確定性雜湊，避免在 metadata 裡留下可辨識憑證。 */
export function sourceRef(value: string): string {
  if (value === value.trim() && value.length <= 200 && !maskSecrets(value).redacted) return value;
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

/** 僅接受宿主提供的時間（兩宿主的原始時間是 epoch 毫秒）；未知時間維持 null。 */
export function occurredAt(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** 只抽取 text blocks，連接時不插入宿主沒有提供的空白。 */
export function visibleText(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  let found = false;
  const parts: string[] = [];
  for (const part of content) {
    const record = asRecord(part);
    if (record?.type !== "text" || typeof record.text !== "string") continue;
    if (record.synthetic === true || record.ignored === true || record.hidden === true) continue;
    found = true;
    parts.push(record.text);
  }
  return found ? parts.join("") : null;
}

/** 只剝除宿主包裹與記憶注入；區塊外的字元、CRLF 和空白逐字保留。 */
export function stripCapturedText(text: string): string {
  return text.replace(
    /<\s*(memory-context|system-reminder|attached-file|attachment|file)\b[^>]*>[\s\S]*?(?:<\s*\/\s*\1\s*>|$)|<\s*\/\s*(?:memory-context|system-reminder|attached-file|attachment|file)\s*>/gi,
    "",
  );
}

/** 缺少明確的關閉政策時，所有訊息全文先遮罩，再建立第一次與補送共用的 payload。 */
export function prepareSource(
  payload: SourceWriteRequest,
  policy: MemoryPolicy | null,
): { payload: SourceWriteRequest; redactedCount: number } {
  if (policy?.maskSecrets === false) return { payload, redactedCount: 0 };
  let redactedCount = 0;
  const messages = payload.messages.map((message) => {
    const masked = maskSecrets(message.content);
    redactedCount += masked.count;
    return { ...message, content: masked.text };
  });
  return { payload: { ...payload, messages }, redactedCount };
}

/** 每次注入前讀取，不以舊值代替失敗的政策讀取。 */
export async function readMemoryPolicy(
  connection: RawConnection,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 5000,
): Promise<PolicyResult> {
  try {
    const response = await fetchImpl(`${connection.baseUrl}/memory-policy`, {
      method: "GET",
      headers: { accept: "application/json", authorization: `Bearer ${connection.token}` },
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status === 404) return { ok: false, reason: "upgrade-required" };
    if (!response.ok) return { ok: false, reason: "policy-unavailable" };
    const policy = asRecord(await response.json().catch(() => null));
    if (typeof policy?.maskSecrets !== "boolean" || !isPositiveId(policy.version)) {
      return { ok: false, reason: "upgrade-required" };
    }
    return { ok: true, policy: { maskSecrets: policy.maskSecrets, version: policy.version, ...(typeof policy.recallVersion === "number" && Number.isSafeInteger(policy.recallVersion) && policy.recallVersion >= 0 ? { recallVersion: policy.recallVersion } : {}) } };
  } catch {
    return { ok: false, reason: "policy-unavailable" };
  }
}
