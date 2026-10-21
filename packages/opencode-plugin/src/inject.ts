/**
 * 把記憶區塊接到「當次最新一則 user 訊息」的 content 末端。
 *
 * 選擇 user message 而不是 system prompt 的原因（見研究筆記 §A1／§C）：
 * - 只影響當次 outgoing request，不寫回歷史；
 * - 不動 system 前綴，較有機會保留 provider 的 prompt cache；
 * - 記憶是不可信資料，放在 user 訊息比 system 更不容易被模型當成高權限指令。
 *
 * 若訊息或陣列被 freeze，先複製再替換；真的都失敗才退回 `event.system.push`。
 */
import type { ContextEventLike } from "./types.js";

/** 注入結果（給 log 用）。 */
export type InjectionResult = "message" | "system" | "skipped";

interface MessageLike {
  role?: unknown;
  content?: unknown;
}

interface PartLike {
  type?: unknown;
  text?: unknown;
}

function isUserMessage(message: unknown): message is MessageLike {
  return typeof message === "object" && message !== null && (message as MessageLike).role === "user";
}

function hasBlock(message: unknown, block: string): boolean {
  if (typeof message !== "object" || message === null) return false;
  const content = (message as MessageLike).content;
  if (typeof content === "string") return content.includes(block);
  if (!Array.isArray(content)) return false;
  return content.some((part) => typeof (part as PartLike)?.text === "string" && (part as PartLike).text === block);
}

function pushSystem(event: ContextEventLike, block: string): InjectionResult {
  try {
    if (!Array.isArray(event.system)) return "skipped";
    event.system.push({ type: "text", text: block });
    return "system";
  } catch {
    return "skipped";
  }
}

/**
 * 注入一個已組好的區塊。
 *
 * 優先序：就地改寫最新 user 訊息的 content → 複製訊息後替換 `event.messages[i]` →
 * `event.system.push` → 放棄。
 */
export function injectMemoryBlock(event: ContextEventLike, block: string): InjectionResult {
  if (typeof block !== "string" || block.trim() === "") return "skipped";
  if (typeof event !== "object" || event === null) return "skipped";
  const messages = event.messages;
  if (!Array.isArray(messages)) return pushSystem(event, block);

  let index = -1;
  for (let cursor = messages.length - 1; cursor >= 0; cursor -= 1) {
    if (isUserMessage(messages[cursor])) {
      index = cursor;
      break;
    }
  }
  if (index < 0) return pushSystem(event, block);

  const message = messages[index] as MessageLike;
  const content = message.content;
  const parts: unknown[] =
    Array.isArray(content)
      ? [...content]
      : typeof content === "string"
        ? [{ type: "text", text: content }]
        : [];
  if (parts.length === 0) return pushSystem(event, block);

  // 接在最後一個 text part 之後；沒有 text part 就接在末端。
  let lastText = -1;
  for (let cursor = 0; cursor < parts.length; cursor += 1) {
    if ((parts[cursor] as PartLike | null)?.type === "text") lastText = cursor;
  }
  const part = { type: "text", text: block };
  if (lastText >= 0) parts.splice(lastText + 1, 0, part);
  else parts.push(part);

  // 1) 就地改寫（frozen 會丟 TypeError）。
  try {
    (message as { content?: unknown }).content = parts;
    if (hasBlock(messages[index], block)) return "message";
  } catch {
    // 往下試複製。
  }

  // 2) 複製訊息後替換陣列元素（clone 保留原 proto，讓下游的 schema 檢查仍看得到同型別）。
  try {
    const clone = Object.assign(
      Object.create(Object.getPrototypeOf(message) as object | null),
      message,
    ) as MessageLike;
    (clone as { content?: unknown }).content = parts;
    (messages as unknown[])[index] = clone;
    if (hasBlock(messages[index], block)) return "message";
  } catch {
    // 往下試 system fallback。
  }

  return pushSystem(event, block);
}
