/**
 * 回合卡內容：抽取式、確定性、不含時間戳／回合 id。
 *
 * 規則（`docs/agent-integration.md` §確定性卡片內容）：
 * - 固定格式 `User: …\nAssistant: …`；
 * - 只取文字、不呼叫模型、不摘要；
 * - 同一份輸入重算兩次逐字相同；
 * - `<memory-context>`／附件／system-reminder／工具輸出都不進卡片。
 */
import { createHash } from "node:crypto";
import {
  MAX_CARD_ASSISTANT_CHARS,
  MAX_CARD_USER_CHARS,
  MAX_MEMORY_CHARS,
  MAX_SOURCE_REF_CHARS,
  MIN_USER_CHARS,
  TURN_AGENT,
} from "./config.js";
import { charLength, cleanText, truncateChars } from "./strip.js";
import type { MemoryWritePayload } from "./types.js";

export type CaptureSkip = "empty" | "short" | "no-assistant";

export interface TurnCardResult {
  content: string;
  userChars: number;
}

/**
 * 從一則使用者文字與助理文字組出卡片。
 *
 * 先清洗、再判斷長度；長度門檻看的是**剝除後**的使用者文字（含注入塊的回合
 * 可能原文很長，但實際使用者只打了幾個字）。
 */
export function buildTurnCard(
  rawUser: string,
  rawAssistant: string,
): { ok: true; card: TurnCardResult } | { ok: false; skip: CaptureSkip } {
  const user = cleanText(rawUser);
  if (user === "") return { ok: false, skip: "empty" };
  const userChars = charLength(user);
  if (userChars < MIN_USER_CHARS) return { ok: false, skip: "short" };

  const assistant = cleanText(rawAssistant);
  if (assistant === "") return { ok: false, skip: "no-assistant" };

  const content = [
    `User: ${truncateChars(user, MAX_CARD_USER_CHARS)}`,
    `Assistant: ${truncateChars(assistant, MAX_CARD_ASSISTANT_CHARS)}`,
  ].join("\n");

  // 最後一道保險：兩段上限合計已小於 server 上限，這裡只在常數被改動時才可能觸發。
  return {
    ok: true,
    card: { content: truncateChars(content, MAX_MEMORY_CHARS), userChars },
  };
}

/**
 * 縮短來源識別值。
 *
 * server 對 `sourceSession`／`sourceMessage` 超過 200 字元直接 400、不截斷；
 * 真的遇到超長值時用固定的 SHA-256 前 32 碼（同值同結果，可回溯比對）。
 */
export function shortenSourceRef(value: string): string {
  const trimmed = value.trim();
  // server 以 UTF-16 code unit 計算 `.length`（不是 code point），這裡保持一致。
  if (trimmed.length <= MAX_SOURCE_REF_CHARS) return trimmed;
  return `sha256:${createHash("sha256").update(trimmed).digest("hex").slice(0, 32)}`;
}

export interface CaptureInput {
  sessionId: string;
  turn: number;
  userText: string;
  assistantText: string;
  /** 已解析的專案名；null 代表 global。 */
  project: string | null;
}

/** 組出 `POST /memories` 的完整 payload；內容不合格時回 null。 */
export function buildCapturePayload(input: CaptureInput): MemoryWritePayload | null {
  const built = buildTurnCard(input.userText, input.assistantText);
  if (!built.ok) return null;
  const sourceSession = shortenSourceRef(input.sessionId);
  const sourceMessage = shortenSourceRef(String(input.turn));
  return {
    content: built.card.content,
    kind: "fact",
    scope: input.project === null ? "global" : "project",
    ...(input.project === null ? {} : { project: input.project }),
    agent: TURN_AGENT,
    sourceSession,
    sourceMessage,
  };
}
