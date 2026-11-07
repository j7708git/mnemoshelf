/** 把 dsh 公開的 user／assistant 訊息送入原文來源協定。 */
import { TURN_AGENT } from "./config.js";
import {
  occurredAt,
  sourceRef,
  stripCapturedText,
  visibleText,
  type MemorySourceMessage,
  type SourceWriteRequest,
} from "./raw-memory.js";

export function captureMessage(input: {
  id: unknown;
  role: MemorySourceMessage["role"];
  content: unknown;
  time: unknown;
  ordinal: number;
}): MemorySourceMessage | null {
  const text = visibleText(input.content);
  if (text === null) return null;
  const content = stripCapturedText(text);
  if (content.trim() === "" && content !== text) return null; // 只有注入／宿主包裹，整則不擷取。
  const id = typeof input.id === "string" && input.id.trim() !== ""
    ? input.id
    : `visible:${input.role}:${input.ordinal}`;
  return { sourceMessage: sourceRef(id), role: input.role, content, occurredAt: occurredAt(input.time) };
}

export function buildCapturePayload(input: {
  sessionId: string;
  turn: number;
  messages: MemorySourceMessage[];
  project: string | null;
}): SourceWriteRequest | null {
  if (!input.messages.some((message) => message.role === "user")) return null;
  if (!input.messages.some((message) => message.content.trim() !== "")) return null;
  return {
    agent: TURN_AGENT,
    scope: input.project === null ? "global" : "project",
    ...(input.project === null ? {} : { project: input.project }),
    sourceSession: sourceRef(input.sessionId),
    sourceTurn: String(input.turn),
    messages: input.messages,
  };
}
