/**
 * 歷史摘要評測的純函式。正式外掛不載入這個模組；
 * 保留固定資料集的解析與組卡行為，便於重跑舊版基準。
 */
import { MEMORY_CONTEXT_OPEN, STATUS_SENTINEL, SYSTEM_REMINDER_PREFIX } from "./constants.js";
import { charLength, tailChars, truncateChars } from "./text.js";

/** 單次寫入（`POST /memories`）的 timeout；超過就放棄（不拖住任何東西）。 */
export const DIGEST_TIMEOUT_MS = 8000;

/** 寫入失敗最多再試一次（總請求數 ≤2）。 */
export const DIGEST_MAX_ATTEMPTS = 2;

/** 去重鍵／計數的保留天數。 */
export const DIGEST_RETENTION_DAYS = 30;

/** 失敗原因的長度上限（`<name>: <message>`；`/memory` 與 log 都靠它保持單行）。 */
export const MAX_FAILURE_REASON_CHARS = 200;

/** 送給模型的使用者文字上限（字元）。 */
export const MAX_DIGEST_USER_CHARS = 1200;

/** 送給模型的助理文字上限（字元；保留結尾，因為最終回覆在後面）。 */
export const MAX_DIGEST_ASSISTANT_CHARS = 2500;

/** 回合紀錄（`turn`）的內容上限（字元）。 */
export const MAX_TURN_CONTENT_CHARS = 300;

/** 每回合最多幾則原子記憶（`items`）；回合紀錄另計一張。 */
export const MAX_DIGEST_ITEMS = 2;

/** user＋assistant 合計低於這個字元數就跳過（省錢）。 */
export const MIN_DIGEST_TURN_CHARS = 40;

/** 單張記憶卡內容上限（字元）。 */
export const MAX_DIGEST_CONTENT_CHARS = 400;

/** 單張記憶卡 quote 上限（字元）。 */
export const MAX_DIGEST_QUOTE_CHARS = 120;

/** digest 寫入的 `agent` 標記（與使用者手寫的卡區分）。 */
export const DIGEST_AGENT = "opencode-plugin";

/**
 * 回合紀錄卡的 `agent` 標記。
 *
 * 仍以 `opencode-plugin` 為前綴，web 的「只看自動寫入」篩選才看得到它；
 * 後綴 `/turn` 讓召回端能只查回合紀錄（`GET /memories?agent=…`）。
 */
export const DIGEST_TURN_AGENT = "opencode-plugin/turn";

/** server 的合法 kind；模型回了別的值一律當 `fact`。 */
export const DIGEST_KINDS = ["decision", "pitfall", "fact", "preference"] as const;

export type DigestKind = (typeof DIGEST_KINDS)[number];

function isDigestKind(value: unknown): value is DigestKind {
  return typeof value === "string" && (DIGEST_KINDS as readonly string[]).includes(value);
}

/** 只保留 `type:"text"` 的 part，其他（reasoning／tool／media）一律丟棄。 */
function textParts(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part !== "object" || part === null) continue;
    const typed = part as { type?: unknown; text?: unknown };
    if (typed.type !== "text" || typeof typed.text !== "string") continue;
    if (typed.text === "") continue;
    parts.push(typed.text);
  }
  return parts.join("\n");
}

/** 剝除外掛自己注入的 `<memory-context>` 區塊（含沒有收尾標籤的不完整區塊）。 */
export function stripMemoryContext(text: string): string {
  return text
    .replace(/<\s*memory-context\b[^>]*>[\s\S]*?<\s*\/\s*memory-context\s*>/gi, " ")
    .replace(/<\s*memory-context\b[^>]*>[\s\S]*$/i, " ")
    .replace(/<\s*\/?\s*memory-context\b[^>]*>/gi, " ");
}

/**
 * 剝除宿主內嵌的附件區塊（檔案內容、system-reminder）。
 *
 * `SessionMessageUser.files` 的內容原本就只放在附件欄位、不會進 `text`；但有些宿主／
 * 工具會把檔案內容以 `<file …>…</file>` 內嵌成文字，這些內容不該被摘要、也不該送給模型。
 */
export function stripHostBlocks(text: string): string {
  return text
    .replace(/<file\b[^>]*>[\s\S]*?<\s*\/\s*file\s*>/gi, " ")
    .replace(/<attached-file\b[^>]*>[\s\S]*?<\s*\/\s*attached-file\s*>/gi, " ")
    .replace(/<system-reminder\b[^>]*>[\s\S]*?<\s*\/\s*system-reminder\s*>/gi, " ");
}

/** digest 取文字前的統一清洗：注入塊、內嵌附件。 */
function cleanDigestText(text: string): string {
  return stripHostBlocks(stripMemoryContext(text)).trim();
}

type NormalizedRole = "user" | "assistant" | "other";

interface NormalizedMessage {
  id?: string;
  role: NormalizedRole;
  synthetic: boolean;
  text: string;
}

/**
 * 把宿主的訊息正規化成 digest 需要的四個欄位。
 *
 * 真實 `session.context` 是 `SessionMessageInfo[]`（`type:"user"|"assistant"|"synthetic"|…`）；
 * 這裡同時容忍舊式 `role` 欄位，讓測試與舊宿主都能跑。
 */
function normalizeMessage(value: unknown): NormalizedMessage | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as {
    id?: unknown;
    role?: unknown;
    type?: unknown;
    synthetic?: unknown;
    content?: unknown;
    text?: unknown;
  };
  const type = typeof record.type === "string" ? record.type : undefined;
  const role: NormalizedRole =
    // `SessionMessageSynthetic` 在模型請求裡是 user 角色；digest 必須看得到它，
    // 才能判斷「這個回合沒有真正的使用者輸入」。
    type === "user" || type === "synthetic" || record.role === "user"
      ? "user"
      : type === "assistant" || record.role === "assistant"
        ? "assistant"
        : "other";
  let text = textParts(record.content);
  if (text === "" && typeof record.content === "string") text = record.content;
  if (text === "" && typeof record.text === "string") text = record.text;
  const synthetic =
    type === "synthetic" ||
    type === "system" ||
    record.synthetic === true ||
    text.trimStart().startsWith(SYSTEM_REMINDER_PREFIX);
  return {
    ...(typeof record.id === "string" && record.id !== "" ? { id: record.id } : {}),
    role,
    synthetic,
    text,
  };
}

export type DigestTurnSkip =
  | "no-messages"
  | "no-assistant"
  | "no-user"
  | "no-user-text"
  | "slash"
  | "status-turn"
  | "empty"
  | "short";

export interface DigestTurn {
  /** 水位線：這一回合最後一則非 synthetic assistant 的 id（也是去重鍵的一部分）。 */
  assistantMessageID: string;
  userMessageID?: string;
  /** 剝除注入塊並截到 1200 字元後的使用者文字。 */
  userText: string;
  /** 剝除注入塊並截到 2500 字元後的助理文字。 */
  assistantText: string;
  /** 用來驗證 quote 的原文（未截斷、已剝除注入塊）。 */
  sourceText: string;
}

export type DigestTurnResult = { turn: DigestTurn } | { skip: DigestTurnSkip };

/**
 * 解析「一個回合」。
 *
 * 1. 從尾端找最後一則非 synthetic 的 assistant（水位線）；
 * 2. 從它往前找最近一則非 synthetic 的 user；
 * 3. 兩者之間（含）就是本回合；助理文字只取這段區間內的 assistant 訊息。
 */
export function resolveDigestTurn(messages: unknown[]): DigestTurnResult {
  if (!Array.isArray(messages) || messages.length === 0) return { skip: "no-messages" };
  const normalized: NormalizedMessage[] = [];
  for (const message of messages) {
    const parsed = normalizeMessage(message);
    if (parsed !== null) normalized.push(parsed);
  }

  let assistantIndex = -1;
  for (let index = normalized.length - 1; index >= 0; index -= 1) {
    const message = normalized[index];
    if (message.role === "assistant" && !message.synthetic && message.id !== undefined) {
      assistantIndex = index;
      break;
    }
  }
  if (assistantIndex < 0) return { skip: "no-assistant" };
  const assistant = normalized[assistantIndex];

  let userIndex = -1;
  for (let index = assistantIndex - 1; index >= 0; index -= 1) {
    const message = normalized[index];
    if (message.role !== "user") continue;
    if (message.synthetic) {
      // 外掛／指令的 synthetic 訊息（`/memory` 狀態輸出…）**自成一個回合**：
      // 它的 assistant 回覆不能回頭配對上一個真 prompt，否則等於把舊回合再摘要一次。
      if (message.text.trimStart().startsWith(STATUS_SENTINEL)) return { skip: "status-turn" };
      // 其餘 synthetic（例如 Plan mode 的 `<system-reminder>`）屬於同一回合，往前找真 prompt。
      continue;
    }
    userIndex = index;
    break;
  }
  if (userIndex < 0) return { skip: "no-user" };
  const user = normalized[userIndex];

  const userRaw = cleanDigestText(user.text);
  if (userRaw === "") return { skip: "no-user-text" };
  if (userRaw.startsWith(STATUS_SENTINEL)) return { skip: "status-turn" };
  // slash command（含外掛自己的指令）不是使用者實質輸入，摘要它只會浪費錢。
  if (userRaw.startsWith("/")) return { skip: "slash" };

  const assistantParts: string[] = [];
  for (let index = userIndex + 1; index <= assistantIndex; index += 1) {
    const message = normalized[index];
    if (message.role !== "assistant" || message.synthetic) continue;
    const cleaned = cleanDigestText(message.text);
    if (cleaned !== "") assistantParts.push(cleaned);
  }
  const assistantRaw = assistantParts.join("\n").trim();
  if (assistantRaw === "") return { skip: "empty" };
  if (charLength(userRaw) + charLength(assistantRaw) < MIN_DIGEST_TURN_CHARS) return { skip: "short" };

  return {
    turn: {
      assistantMessageID: assistant.id as string,
      ...(user.id === undefined ? {} : { userMessageID: user.id }),
      userText: truncateChars(userRaw, MAX_DIGEST_USER_CHARS),
      assistantText: tailChars(assistantRaw, MAX_DIGEST_ASSISTANT_CHARS),
      sourceText: `${userRaw}\n${assistantRaw}`,
    },
  };
}

/** 組出送給摘要模型的 prompt（只含這一回合的對話文字，不含工具輸出）。 */
export function buildDigestPrompt(input: { userText: string; assistantText: string }): string {
  return [
    "你是對話記憶整理器。只根據下面這一個回合的對話，整理出一張「回合紀錄」與 0–2 則值得長期保留的原子記憶。",
    "",
    "規則：",
    "- turn 是這一回合的紀錄：寫「討論主題 → 結論／決定 → 下一步或未解問題」，用第三人稱、具體",
    "  （保留專有名詞）；沒有下一步就省略該段。最多 300 字，不要客套、不要逐字重述。",
    "- 只寫對話中明確出現的內容；不要推測、不要補充背景。",
    "- items 是跨回合仍然有用的原子記憶（0–2 則）；不要與 turn 重複。",
    "- 每則 content 是一句可獨立理解的濃縮句（最多 400 字），不要放程式碼區塊。",
    "- kind 只能是 decision（做了什麼取捨）、pitfall（踩到的坑）、fact（已確認的事實）、",
    "  preference（偏好或慣例）。",
    "- quote 必須是這一回合對話原文中連續出現的片段（最多 120 字），用來佐證這則記憶。",
    '- 沒有值得長期保留的內容就回 {"turn":"","items":[]}；有回合內容但沒有原子記憶時 items 給空陣列。',
    "- 只輸出 JSON，不要解釋、不要 code fence。格式：",
    '{"turn":"這輪的紀錄","items":[{"content":"...","kind":"decision","quote":"..."}]}',
    "",
    "這一回合的使用者訊息：",
    input.userText,
    "",
    "助理這一回合的最終回覆：",
    input.assistantText,
  ].join("\n");
}

export interface DigestItem {
  content: string;
  kind: string;
  quote: string;
}

export type DigestParseError = "not-json" | "shape";

export interface DigestParseResult {
  /** 回合紀錄；`null` 代表模型沒給（缺失／非字串／空白）→ 不寫回合卡。 */
  turn: string | null;
  items: DigestItem[];
  /** 被丟棄的筆數（缺欄位、quote 對不上、重複內容、與 turn 重複）。 */
  rejected: number;
  error?: DigestParseError;
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** quote 是否真的出現在本回合原文（容許空白正規化；不容許改寫）。 */
function quoteMatches(quote: string, sourceText: string): boolean {
  if (quote === "") return false;
  if (sourceText.includes(quote)) return true;
  return collapseWhitespace(sourceText).includes(collapseWhitespace(quote));
}

/** 從模型輸出取出 JSON 物件本體（容忍 code fence 與前後說明文字）。 */
function jsonPayload(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const fenced = /^```(?:json|JSON)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  const body = fenced !== null && typeof fenced[1] === "string" ? fenced[1].trim() : trimmed;
  if (body === "") return null;
  if (body.startsWith("{")) return body;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  return body.slice(start, end + 1);
}

/**
 * 解析並驗證模型輸出（回合紀錄＋原子記憶）。
 *
 * 嚴格度：`items` 必須是陣列（唯獨 `turn` 有內容、而模型省略 `items` 時視為空陣列，
 * 不因此丟掉整張回合卡）；每筆的 `quote` 必須真的出現在本回合原文，否則丟棄該筆
 * （這是防止模型無中生有的主要防線）。`kind` 不在合法清單時當 `fact`。
 *
 * `turn` 缺失／非字串／空白 → `null`（不是錯誤）；超過 300 字截斷。
 */
export function parseDigestItems(
  raw: string,
  sourceText: string,
  limit: number,
): DigestParseResult {
  const payload = jsonPayload(raw);
  if (payload === null) return { turn: null, items: [], rejected: 0, error: "not-json" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return { turn: null, items: [], rejected: 0, error: "not-json" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { turn: null, items: [], rejected: 0, error: "shape" };
  }
  const record = parsed as { turn?: unknown; items?: unknown };
  const turnRaw = typeof record.turn === "string" ? collapseWhitespace(record.turn) : "";
  const turn = turnRaw === "" ? null : truncateChars(turnRaw, MAX_TURN_CONTENT_CHARS);
  const list = record.items;
  if (list === undefined && turn !== null) return { turn, items: [], rejected: 0 };
  if (!Array.isArray(list)) return { turn, items: [], rejected: 0, error: "shape" };

  const items: DigestItem[] = [];
  const seen = new Set<string>();
  const turnKey = turn === null ? "" : turn.toLowerCase();
  let rejected = 0;
  for (const entry of list) {
    if (items.length >= limit) break;
    if (typeof entry !== "object" || entry === null) {
      rejected += 1;
      continue;
    }
    const item = entry as { content?: unknown; kind?: unknown; quote?: unknown };
    const content = typeof item.content === "string" ? collapseWhitespace(item.content) : "";
    const quoteRaw = typeof item.quote === "string" ? item.quote.trim() : "";
    if (content === "" || quoteRaw === "") {
      rejected += 1;
      continue;
    }
    const quote = truncateChars(quoteRaw, MAX_DIGEST_QUOTE_CHARS);
    if (!quoteMatches(quote, sourceText)) {
      rejected += 1;
      continue;
    }
    const normalized = truncateChars(content, MAX_DIGEST_CONTENT_CHARS);
    const key = normalized.toLowerCase();
    // 原子記憶不得與回合紀錄重複（prompt 已要求；這裡是最後一道保險）。
    if (seen.has(key) || (turnKey !== "" && key === turnKey)) {
      rejected += 1;
      continue;
    }
    seen.add(key);
    items.push({ content: normalized, kind: isDigestKind(item.kind) ? item.kind : "fact", quote });
  }
  return { turn, items, rejected };
}

/* ------------------------------------------------------------------ *
 * 組卡片（純函式）
 * ------------------------------------------------------------------ */

/** 一張待寫入的記憶卡：`item` 是 payload，`agent`／`force` 決定寫入語意。 */
export interface DigestCard {
  item: DigestItem;
  agent: string;
  force: boolean;
}

/**
 * 由解析結果組出**未截斷**的候選卡片（回合紀錄先、原子記憶後）。
 *
 * 抽成獨立函式的理由：L3 的摘要品質量測（`eval/digest/`）要直接驗證
 * 「產品真的會寫出什麼卡片」，所以它必須能呼叫和 runtime 完全相同的組卡邏輯，
 * 而不是在 harness 裡自己模仿一份——模仿的版本會和產品碼漂移，量到的就不是產品行為。
 */
function candidateDigestCards(parsed: DigestParseResult): DigestCard[] {
  const cards: DigestCard[] = [];
  if (parsed.turn !== null) {
    cards.push({
      item: { content: parsed.turn, kind: "fact", quote: "" },
      agent: DIGEST_TURN_AGENT,
      force: true,
    });
  }
  for (const item of parsed.items) {
    cards.push({ item, agent: DIGEST_AGENT, force: false });
  }
  return cards;
}

/**
 * 這一回合實際要送出的卡片：候選卡片（回合紀錄優先、原子記憶在後）。
 *
 * 輸出形狀**寫死**：1 張回合紀錄（有內容時）＋最多 `MAX_DIGEST_ITEMS`（2）則原子記憶；
 * 「最多 2 則」由 `parseDigestItems()` 的 limit 保證，這裡不再截斷、也沒有任何設定可調。
 *
 * 純函式：不讀設定、不碰 store、不發請求。`runDigest()` 與 L3 的 harness 共用它，
 * 「harness 量到的卡片」因此就是「runtime 會 POST 的卡片」。
 */
export function buildDigestCards(parsed: DigestParseResult): DigestCard[] {
  return candidateDigestCards(parsed);
}

/** `YYYY-MM-DD`（使用者本地時區；今日統計鍵用它）。 */
