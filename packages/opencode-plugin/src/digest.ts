/**
 * 回合結束自動摘要（per-turn digest）。
 *
 * 觸發：宿主的 durable 事件 `session.execution.succeeded`（每個 busy period 的 terminal
 * 只發一次）。`session.idle` 在 OpenCode 2.1.1 已 deprecated 且沒有 publisher，不可用。
 *
 * 邊界（刻意設計）：
 * - 收到 terminal 事件的**當下**先抓一次 `ctx.session.context({ sessionID })` 快照，並以
 *   「當下最後一則非 synthetic 的 assistant 訊息」的 id 當**水位線**；回合內容只取
 *   「最近一則非 synthetic user → 水位線 assistant」之間。不用「陣列最後一則」，因為
 *   上一回合的 digest 還沒跑完時，下一回合可能已經結束。
 * - 同一 `sessionID` 的工作**串行**（promise 鏈）；不同 session 可並行。
 * - 全程 fire-and-forget：任何失敗只記結構化 log（不含對話內容、prompt、token），
 *   不影響 session、不重試超過一次。
 *
 * 外掛與 server 的職責邊界（刻意設計）：
 * - 外掛：收回合事件、抓快照、呼叫摘要模型、把卡片送進 `POST /memories`；
 *   除了「這一回合要不要記」之外不決定產品規則，也不保存記憶內容。
 * - server：去重、儲存、查詢；不呼叫模型、不決定摘要內容。
 * - 因此換宿主（例如未來的其他 agent）只需重寫這個檔的取樣與送出路徑，server 不用改。
 */
import { DEFAULT_DIGEST_TIMEOUT_MS, parseDigestModel } from "./config.js";
import { MEMORY_CONTEXT_OPEN, STATUS_SENTINEL, SYSTEM_REMINDER_PREFIX } from "./constants.js";
import { appendDigestLog, digestLogPath, digestSessionHash, formatDigestLogLine } from "./digest-log.js";
import { charLength, tailChars, truncateChars } from "./text.js";
import {
  formatLog,
  type Connection,
  type GenerateDomainLike,
  type LogFn,
  type PluginContextLike,
  type Settings,
  type StorageLike,
} from "./types.js";

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

/** 這一回合的卡片數（診斷與 `/memory` 的「候選 N 筆」用）。 */
export function countDigestCards(parsed: DigestParseResult): number {
  return candidateDigestCards(parsed).length;
}

/** `YYYY-MM-DD`（使用者本地時區；今日統計鍵用它）。 */
export function formatDay(date: Date): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/* ------------------------------------------------------------------ *
 * 持久狀態：去重鍵與今日統計（`ctx.storage`，失敗時退回 process 內快取）
 * ------------------------------------------------------------------ */

const SEEN_PREFIX = "digest:";
const STATS_PREFIX = "digest-stats:";
const SCAN_LIMIT = 200;
const SCAN_MAX_PAGES = 20;
const SEEN_HARD_LIMIT = 5000;

/** `ctx.storage` 的子集（見 `types.ts` 的 `StorageLike`）。 */
export type DigestStoreHost = StorageLike;

/**
 * 今日統計：只作 `/memory` 顯示，**不是上限**，不擋任何寫入。
 *
 * 這是 read-modify-write；多個外掛實例同時寫同一天時可能偏低（lost update）。
 * 數字只用來回答「今天做了多少事」，不參與任何產品決策。
 */
export interface DigestDayStats {
  /** 實際呼叫摘要模型的次數。 */
  calls: number;
  /** 成功寫入的卡數（不含 duplicate）。 */
  ok: number;
  /** server 回 `duplicate: true` 的卡數。 */
  duplicate: number;
  /** 卡片寫入失敗數（重試後仍失敗）。 */
  failed: number;
  /** 模型呼叫失敗或解析失敗的回合數。 */
  callFailed: number;
  /** 最後更新時間（ISO 8601）。 */
  updatedAt: string;
}

export type DigestStatsDelta = Partial<Omit<DigestDayStats, "updatedAt">>;

export interface DigestStore {
  prune(now: Date): Promise<void>;
  hasSeen(key: string): Promise<boolean>;
  markSeen(key: string, at: Date): Promise<void>;
  /** 今日統計；`null`＝讀不到（顯示端要說「未知」，不可拿 0 冒充）。 */
  dayStats(day: string): Promise<DigestDayStats | null>;
  bumpStats(day: string, at: Date, delta: DigestStatsDelta): Promise<void>;
}

function emptyStats(): DigestDayStats {
  return { calls: 0, ok: 0, duplicate: 0, failed: 0, callFailed: 0, updatedAt: "" };
}

/** 讀統計值；缺欄位視為 0，任何一欄不合法就整筆丟棄（不猜半份資料）。 */
function statsFromValue(value: unknown): DigestDayStats | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const stats = emptyStats();
  for (const field of ["calls", "ok", "duplicate", "failed", "callFailed"] as const) {
    const raw = record[field];
    if (raw === undefined) continue;
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) return null;
    stats[field] = Math.floor(raw);
  }
  stats.updatedAt = typeof record.updatedAt === "string" ? record.updatedAt : "";
  return stats;
}

function dayFromValue(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const day = (value as { day?: unknown }).day;
  return typeof day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}

async function scanAll(host: DigestStoreHost, prefix: string): Promise<{ key: string; value: unknown }[]> {
  const entries: { key: string; value: unknown }[] = [];
  let after: string | undefined;
  for (let page = 0; page < SCAN_MAX_PAGES; page += 1) {
    const result = await host.scan({
      prefix,
      limit: SCAN_LIMIT,
      ...(after === undefined ? {} : { after }),
    });
    for (const entry of result.entries) entries.push({ key: entry.key, value: entry.value });
    if (result.next === undefined || result.next === "" || entries.length >= 2000) break;
    after = result.next;
  }
  return entries;
}

class DigestStoreImpl implements DigestStore {
  private readonly seen = new Map<string, string>();
  private readonly stats = new Map<string, DigestDayStats>();
  /** 統計掃描是否成功；失敗時顯示端要說「今日：未知」。 */
  private statsReadable = true;
  private loading: Promise<void> | null = null;
  private loaded = false;

  constructor(private readonly host: DigestStoreHost | undefined) {}

  private load(): Promise<void> {
    if (this.loaded) return Promise.resolve();
    if (this.loading === null) {
      this.loading = this.readAll().finally(() => {
        this.loaded = true;
        this.loading = null;
      });
    }
    return this.loading;
  }

  private async readAll(): Promise<void> {
    const host = this.host;
    if (host === undefined) return;
    try {
      for (const entry of await scanAll(host, SEEN_PREFIX)) {
        const day = dayFromValue(entry.value);
        if (day !== null) this.seen.set(entry.key, day);
      }
    } catch {
      // storage 讀不到：退化成本次 process 的記憶體快取（去重仍在，只是跨行程不連續）。
    }
    try {
      for (const entry of await scanAll(host, STATS_PREFIX)) {
        const stats = statsFromValue(entry.value);
        if (stats !== null) this.stats.set(entry.key.slice(STATS_PREFIX.length), stats);
      }
    } catch {
      // 統計讀不到只影響顯示；寫入照常、記憶體快取照常累加。
      this.statsReadable = false;
    }
  }

  private persist(key: string, value: unknown): void {
    const host = this.host;
    if (host === undefined) return;
    try {
      void host.set(key, value).catch(() => undefined);
    } catch {
      // 同步丟錯也忽略：狀態寫不進去不影響這一輪的寫入。
    }
  }

  private drop(key: string): void {
    const host = this.host;
    if (host === undefined) return;
    try {
      void host.remove(key).catch(() => undefined);
    } catch {
      // 同上。
    }
  }

  async hasSeen(key: string): Promise<boolean> {
    await this.load();
    return this.seen.has(key);
  }

  async markSeen(key: string, at: Date): Promise<void> {
    await this.load();
    const day = formatDay(at);
    this.seen.set(key, day);
    if (this.seen.size > SEEN_HARD_LIMIT) {
      const overflow = this.seen.size - SEEN_HARD_LIMIT;
      let removed = 0;
      for (const oldKey of this.seen.keys()) {
        if (removed >= overflow) break;
        this.seen.delete(oldKey);
        removed += 1;
      }
    }
    this.persist(key, { day });
  }

  async dayStats(day: string): Promise<DigestDayStats | null> {
    await this.load();
    const stored = this.stats.get(day);
    if (stored !== undefined) return stored;
    if (!this.statsReadable) return null;
    return emptyStats();
  }

  async bumpStats(day: string, at: Date, delta: DigestStatsDelta): Promise<void> {
    await this.load();
    const current = this.stats.get(day) ?? emptyStats();
    const add = (value: number | undefined): number => Math.max(0, Math.floor(value ?? 0));
    const next: DigestDayStats = {
      calls: current.calls + add(delta.calls),
      ok: current.ok + add(delta.ok),
      duplicate: current.duplicate + add(delta.duplicate),
      failed: current.failed + add(delta.failed),
      callFailed: current.callFailed + add(delta.callFailed),
      updatedAt: at.toISOString(),
    };
    this.stats.set(day, next);
    this.persist(`${STATS_PREFIX}${day}`, next);
  }

  async prune(now: Date): Promise<void> {
    await this.load();
    const cutoff = new Date(now.getTime() - DIGEST_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const cutoffDay = formatDay(cutoff);
    const cutoffStamp = cutoff.toISOString();
    for (const [key, day] of [...this.seen]) {
      // `YYYY-MM-DD` 可以直接字串比較。
      if (day >= cutoffDay) continue;
      this.seen.delete(key);
      this.drop(key);
    }
    for (const [key, stats] of [...this.stats]) {
      // 沒有 updatedAt 的舊資料一律視為過期。
      if (stats.updatedAt !== "" && stats.updatedAt >= cutoffStamp) continue;
      this.stats.delete(key);
      this.drop(`${STATS_PREFIX}${key}`);
    }
  }
}

/** 建立 digest 的狀態存放（沒有 `ctx.storage` 時只存在 process 記憶體）。 */
export function createDigestStore(host: DigestStoreHost | undefined): DigestStore {
  return new DigestStoreImpl(host);
}

/* ------------------------------------------------------------------ *
 * 寫入（POST /memories）
 * ------------------------------------------------------------------ */

export type DigestWriteFailure = "http" | "network" | "timeout";

export type DigestWriteResult =
  | { ok: true; duplicate: boolean }
  | { ok: false; reason: DigestWriteFailure; status?: number };

export interface DigestWriteInput {
  connection: Connection;
  /**
   * 寫入範圍：一般目錄 `project`（需 `project`）；OpenChamber 聊天 session 為 `global`
   * （不帶 `project`，記憶對所有專案可見）。
   */
  scope: "project" | "global";
  project: string | null;
  sessionID: string;
  messageID: string;
  item: DigestItem;
  /** 寫入的 `agent` 標記；回合紀錄用 `DIGEST_TURN_AGENT`，其餘預設 `DIGEST_AGENT`。 */
  agent?: string;
  /** 強制新增（跳過 server 的精確去重）；只有回合紀錄使用。 */
  force?: boolean;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

/** 來源欄位在 server 端上限 200 字元；這裡先截，避免整批 400。 */
const SOURCE_REF_MAX_CHARS = 200;

async function postMemory(input: DigestWriteInput): Promise<DigestWriteResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const body = {
    content: input.item.content,
    kind: input.item.kind,
    ...(input.scope === "global"
      ? { scope: "global" }
      : { scope: "project", project: input.project }),
    agent: input.agent ?? DIGEST_AGENT,
    sourceSession: truncateChars(input.sessionID, SOURCE_REF_MAX_CHARS),
    sourceMessage: truncateChars(input.messageID, SOURCE_REF_MAX_CHARS),
    // 回合紀錄「不套用去重」：每回合本來就不同，內容相同時 server 仍必須存成兩張。
    ...(input.force === true ? { force: true } : {}),
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    const response = await fetchImpl(`${input.connection.baseUrl}/memories`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        authorization: `Bearer ${input.connection.token}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      return {
        ok: false,
        reason: "http",
        status: response.status,
      };
    }
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      // 2xx 但沒有 JSON：server 仍可能已寫入；保守當成功（去重鍵交給下一輪的 server 去重）。
      return { ok: true, duplicate: false };
    }
    return { ok: true, duplicate: (parsed as { duplicate?: unknown } | null)?.duplicate === true };
  } catch {
    return { ok: false, reason: controller.signal.aborted ? "timeout" : "network" };
  } finally {
    clearTimeout(timer);
  }
}

/** 寫一張卡；失敗最多再試一次（4xx 不重試，5xx／429／網路錯誤才重試）。 */
export async function writeDigestMemory(input: DigestWriteInput): Promise<DigestWriteResult> {
  let result = await postMemory(input);
  for (let attempt = 1; attempt < DIGEST_MAX_ATTEMPTS; attempt += 1) {
    if (result.ok) return result;
    const retryable =
      result.status === undefined || result.status >= 500 || result.status === 429;
    if (!retryable) return result;
    result = await postMemory(input);
  }
  return result;
}

/* ------------------------------------------------------------------ *
 * runtime
 * ------------------------------------------------------------------ */

export type DigestSkipReason =
  | "no-model"
  | "model-unavailable"
  | "offline"
  | "project-unresolved"
  | "subagent"
  | "other-location"
  | "no-session-api"
  | "session-lookup-failed"
  | "no-context-api"
  | "bad-context"
  | "capture-failed"
  | "no-messages"
  | "no-assistant"
  | "no-user"
  | "no-user-text"
  | "slash"
  | "status-turn"
  | "empty"
  | "short"
  | "already";

/** 單張卡的寫入結果（只記角色與狀態，不含內容）。 */
export interface DigestCardResult {
  role: "turn" | "item";
  state: "ok" | "duplicate" | "failed";
  /** HTTP 狀態碼（只有 failed 且拿得到時才有）。 */
  status?: number;
}

export type DigestOutcome =
  | {
      state: "ok";
      at: string;
      /** 成功寫入的卡數（不含 duplicate）。 */
      written: number;
      /** 這一回合的候選卡片數。 */
      items: number;
      /** server 回 duplicate 的卡數。 */
      duplicates: number;
      /** 卡片寫入失敗數。 */
      failed: number;
      cards: DigestCardResult[];
    }
  | { state: "skipped"; at: string; reason: DigestSkipReason }
  | {
      state: "failed";
      at: string;
      reason: string;
      /** 全部卡片都失敗時，逐卡結果仍要留給診斷。 */
      cards?: DigestCardResult[];
      failed?: number;
    };

/** 跳過原因的顯示文字（`/memory` 用；不含任何內容）。 */
export function skipReasonText(reason: string): string {
  switch (reason) {
    case "no-model":
      return "未指定 digestModel（不會呼叫模型）";
    case "model-unavailable":
      return "digestModel 不存在或未啟用（不會呼叫模型）";
    case "offline":
      return "未連線 mnemoshelf";
    case "project-unresolved":
      return "專案名未解析";
    case "subagent":
      return "subagent session 不寫入";
    case "other-location":
      return "不是本 location 的 session";
    case "no-session-api":
      return "宿主沒有 session.get";
    case "session-lookup-failed":
      return "讀不到 session 資訊";
    case "no-context-api":
      return "宿主沒有 session.context";
    case "bad-context":
      return "session.context 回應格式不符";
    case "capture-failed":
      return "抓取回合快照失敗";
    case "no-messages":
      return "快照沒有訊息";
    case "no-assistant":
      return "沒有可用的助理訊息";
    case "no-user":
      return "沒有使用者訊息";
    case "no-user-text":
      return "本回合沒有實質使用者文字";
    case "slash":
      return "slash command 回合";
    case "status-turn":
      return "外掛狀態訊息回合";
    case "empty":
      return "本回合沒有可用文字";
    case "short":
      return "本回合對話太短";
    case "already":
      return "同一回合已處理過";
    default:
      return reason;
  }
}

function failureText(reason: string): string {
  if (reason === "not-json") return "模型回應不是 JSON";
  if (reason === "shape") return "模型回應缺少 items 陣列";
  if (reason === "empty-response") return "模型回應為空";
  if (reason === "timeout") return "逾時";
  if (reason === "no-generate") return "宿主沒有 generate.text";
  if (reason === "network") return "寫入連線失敗";
  if (/^http-\d+$/.test(reason)) return `寫入失敗（HTTP ${reason.slice(5)}）`;
  return reason;
}

export interface DigestRuntimeDeps {
  ctx: PluginContextLike;
  settings: Settings;
  /** 一般專案的專案名；聊天 session 為 `null`（配合 `scope:"global"`）。 */
  project: string | null;
  /** 寫入範圍：一般專案 `project`；OpenChamber 聊天 session `global`。 */
  scope: "project" | "global";
  /** 本 plugin 實例所屬的 location 目錄（ownership 比對用）。 */
  locationDirectory: string | undefined;
  platform?: NodeJS.Platform;
  /** 沿用召回流程解析出來的連線（digest 不自己找一次）。 */
  getConnection: () => Promise<Connection | null>;
  log: LogFn;
  now?: () => Date;
  fetchImpl?: typeof fetch;
  /** 測試用：覆寫摘要（模型呼叫）與寫入的 timeout。 */
  timeoutMs?: number;
  /** 診斷紀錄路徑的解析來源（預設 `process.env`／`os.homedir()`／`process.platform`）。 */
  env?: NodeJS.ProcessEnv;
  home?: string;
  /** 測試用：直接指定 digest 診斷紀錄檔路徑。 */
  logFile?: string;
}

export interface DigestRuntime {
  /** 開始訂閱事件流；宿主沒有 `ctx.event` 時回 `false`（不拋錯）。 */
  start(): boolean;
  /** 等所有排隊中的 digest 結束（測試與關閉用）。 */
  awaitIdle(): Promise<void>;
  /** `/memory` 的狀態行。 */
  statusLines(): Promise<string[]>;
  dispose(): Promise<void>;
}

interface TerminalEvent {
  type: "succeeded" | "failed" | "interrupted";
  sessionID: string;
  reason?: string;
}

/** 只認 terminal 事件；payload 只有 `sessionID`（以及 interrupted 的 reason）。 */
export function parseTerminalEvent(value: unknown): TerminalEvent | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as { type?: unknown; data?: unknown };
  const type =
    record.type === "session.execution.succeeded"
      ? "succeeded"
      : record.type === "session.execution.failed"
        ? "failed"
        : record.type === "session.execution.interrupted"
          ? "interrupted"
          : null;
  if (type === null) return null;
  const data = record.data;
  if (typeof data !== "object" || data === null) return null;
  const sessionID = (data as { sessionID?: unknown }).sessionID;
  if (typeof sessionID !== "string" || sessionID === "") return null;
  const reason = (data as { reason?: unknown }).reason;
  return {
    type,
    sessionID,
    ...(typeof reason === "string" ? { reason } : {}),
  };
}

/** 目錄比對（容忍結尾分隔符；Windows 不區分大小寫）。 */
function sameDirectory(
  left: string | undefined,
  right: string | undefined,
  platform: NodeJS.Platform,
): boolean {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const normalize = (value: string): string => {
    const trimmed = value.trim().replace(/[\\/]+$/, "");
    return platform === "win32" ? trimmed.toLowerCase() : trimmed;
  };
  const a = normalize(left);
  const b = normalize(right);
  return a !== "" && a === b;
}

class DigestFailure extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "DigestFailure";
  }
}

/** 帶 timeout 的單次呼叫；超時會 abort 並以 `timeout` 失敗。 */
async function withTimeout<T>(run: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new DigestFailure("timeout"));
    }, ms);
  });
  const work = Promise.resolve().then(() => run(controller.signal));
  // 競速落敗的一方之後若才 reject，不能變成 unhandled rejection。
  work.catch(() => undefined);
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function errorName(error: unknown): string {
  if (error instanceof DigestFailure) return error.reason;
  return error instanceof Error ? error.name : "unknown";
}

/**
 * 失敗原因：`<name>: <message>`（≤200 字元）。
 *
 * 只取錯誤型別與訊息，不插入 prompt、對話內容、token；多餘空白壓成單行。
 * `DigestFailure` 是外掛自己的控制流程錯誤（`timeout`、`empty-response`…），
 * 本來就只有原因碼，維持原樣（`/memory` 另有中文說明）。
 */
export function failureReason(error: unknown): string {
  if (error instanceof DigestFailure) return error.reason;
  if (!(error instanceof Error)) return "unknown";
  const name = error.name === "" ? "Error" : error.name;
  const message = error.message.replace(/\s+/g, " ").trim();
  return truncateChars(message === "" ? name : `${name}: ${message}`, MAX_FAILURE_REASON_CHARS);
}

/** 啟動期模型驗證的結果。 */
export type DigestModelCheck =
  | { state: "ok" }
  | { state: "model-unavailable" }
  | { state: "unchecked"; reason: "no-model-api" | "list-error" | "timeout" | "bad-response" };

/**
 * 用 `ctx.model.list()` 驗證 `digestModel` 是否存在。
 *
 * 判定條件刻意與宿主的 `generate.text` 解析一致：清單內有一筆 `providerID` 與 `id`
 * **完全相符**。`@opencode/plugin` 2.1.1 的 `ctx.model.list()` 回
 * `{ location, data: Model.Info[] }`，而該清單本身只含 `enabled` 的模型；因此
 * 「找不到」也涵蓋「模型存在但被停用」。
 *
 * 清單取不到（沒有 API、呼叫失敗、格式不符、逾時）時回 `unchecked`：呼叫端退回
 * 「不驗證、照舊」的行為，不因此停掉 digest。
 */
export async function checkDigestModel(
  ctx: Pick<PluginContextLike, "model">,
  model: { providerID: string; id: string },
  options: { timeoutMs?: number } = {},
): Promise<DigestModelCheck> {
  const domain = ctx.model;
  const list = domain?.list;
  if (domain === undefined || typeof list !== "function") {
    return { state: "unchecked", reason: "no-model-api" };
  }
  let output: unknown;
  try {
    output = await withTimeout(() => list.call(domain), options.timeoutMs ?? DEFAULT_DIGEST_TIMEOUT_MS);
  } catch (error) {
    const timedOut = error instanceof DigestFailure && error.reason === "timeout";
    return { state: "unchecked", reason: timedOut ? "timeout" : "list-error" };
  }
  // 正常是 `{ location, data }`；同時容忍宿主直接回陣列（形狀改變時不要誤判成不存在）。
  const entries = Array.isArray(output) ? output : (output as { data?: unknown } | null)?.data;
  if (!Array.isArray(entries)) return { state: "unchecked", reason: "bad-response" };
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as { id?: unknown; providerID?: unknown };
    if (record.providerID === model.providerID && record.id === model.id) return { state: "ok" };
  }
  return { state: "model-unavailable" };
}

/**
 * 建立 digest runtime。
 *
 * 注意：即使 `digestEnabled=false` 也會建立（`/memory` 要顯示關閉狀態），但**不會訂閱事件**，
 * 因此完全不會呼叫模型。
 */
export function createDigestRuntime(deps: DigestRuntimeDeps): DigestRuntime {
  const { ctx, settings, project, log } = deps;
  const now = deps.now ?? (() => new Date());
  const platform = deps.platform ?? process.platform;
  const model = parseDigestModel(settings.digestModel);
  const store = createDigestStore(ctx.storage);
  /** 模型呼叫與模型清單檢查的 timeout（由 `digestTimeoutMs` 設定，測試可覆寫）。 */
  const modelTimeoutMs = deps.timeoutMs ?? settings.digestTimeoutMs;
  /** 寫入單張卡的 timeout：維持原本的 8 秒，不隨 `digestTimeoutMs` 改變。 */
  const writeTimeoutMs = deps.timeoutMs ?? DIGEST_TIMEOUT_MS;
  /** digest 診斷紀錄檔（只記狀態與原因，不含對話／卡片／prompt／token）。 */
  const logFile =
    deps.logFile ??
    digestLogPath({
      ...(deps.env === undefined ? {} : { env: deps.env }),
      ...(deps.home === undefined ? {} : { home: deps.home }),
      platform,
    });
  const pendingLogs = new Set<Promise<void>>();

  /** 同一 session 的 digest 串行；不同 session 可並行。 */
  const chains = new Map<string, Promise<void>>();
  let pending = 0;
  let handling = 0;
  let last: DigestOutcome | undefined;
  let warnedNoModel = false;
  let warnedOffline = false;
  let disposed = false;
  let iterator: AsyncIterator<unknown> | undefined;
  let prunePromise: Promise<void> | undefined;
  /** 啟動期模型驗證：只做一次，結果供每回合跳過與 `/memory` 使用。 */
  let modelCheck: Promise<DigestModelCheck> | undefined;
  let modelCheckResult: DigestModelCheck | undefined;

  const ensurePruned = (): Promise<void> => {
    if (prunePromise === undefined) {
      prunePromise = store.prune(now()).catch(() => undefined);
    }
    return prunePromise;
  };

  /** 今日統計遞增；任何失敗都吞掉（只供顯示，不得影響 digest 的結果）。 */
  const bumpStats = async (day: string, delta: DigestStatsDelta): Promise<void> => {
    try {
      await store.bumpStats(day, now(), delta);
    } catch {
      // 統計寫不進去不影響這一輪的寫入。
    }
  };

  /**
   * 記一次嘗試：`/memory` 的最近結果（同步）＋檔案診斷紀錄（fire-and-forget）。
   *
   * 診斷紀錄失敗一律吞掉；沒有 await，不會拖慢或改變 digest 的結果。
   */
  const record = (sessionID: string, outcome: DigestOutcome, latencyMs?: number): void => {
    last = outcome;
    const measured = Math.max(0, Math.floor(latencyMs ?? 0));
    const entry = {
      at: outcome.at,
      session: digestSessionHash(sessionID),
      state: outcome.state,
      ...(outcome.state === "ok" ? {} : { reason: outcome.reason }),
      model: settings.digestModel ?? "none",
      latencyMs: measured,
      items: outcome.state === "ok" ? outcome.items : 0,
      written: outcome.state === "ok" ? outcome.written : 0,
      ...(outcome.state === "ok"
        ? { duplicates: outcome.duplicates, failed: outcome.failed, cards: outcome.cards }
        : outcome.state === "failed" && outcome.cards !== undefined
          ? { failed: outcome.failed ?? 0, cards: outcome.cards }
          : {}),
    };
    const task = appendDigestLog(logFile, formatDigestLogLine(entry)).catch(() => undefined);
    pendingLogs.add(task);
    void task.then(() => {
      pendingLogs.delete(task);
    });

    const payload: Record<string, unknown> = {
      event: "digest",
      sessionID,
      state: outcome.state,
      at: outcome.at,
    };
    if (outcome.state === "ok") {
      payload.written = outcome.written;
      payload.items = outcome.items;
      payload.duplicates = outcome.duplicates;
      payload.failed = outcome.failed;
    } else {
      payload.reason = outcome.reason;
    }
    if (latencyMs !== undefined) payload.latencyMs = latencyMs;
    log(formatLog(payload));
  };

  const skip = (sessionID: string, reason: DigestSkipReason, at = now()): void => {
    record(sessionID, { state: "skipped", at: at.toISOString(), reason });
  };

  const warnNoModel = (): void => {
    if (warnedNoModel) return;
    warnedNoModel = true;
    log(
      formatLog({
        event: "digest",
        state: "no-model",
        consequence: "digest-skipped",
      }),
    );
  };

  /**
   * 啟動期模型驗證（每個 runtime 只做一次）。
   *
   * - 模型不存在／被停用 → 記**一次** warning，`/memory` 標成模型不可用，之後每回合
   *   直接跳過（不呼叫模型）；不是每回合失敗一次。
   * - 清單取不到 → 記一次 warning，退回「不驗證、照舊」的行為（不要因此停掉 digest）。
   *
   * 驗證在背景進行（`start()` 不 await），不拖慢 setup；第一次回合會等它完成。
   */
  const verifyModel = (): Promise<DigestModelCheck> => {
    if (modelCheck !== undefined) return modelCheck;
    const ref = model;
    const check: Promise<DigestModelCheck> =
      ref === null
        ? Promise.resolve<DigestModelCheck>({ state: "unchecked", reason: "no-model-api" })
        : checkDigestModel(ctx, ref, { timeoutMs: modelTimeoutMs }).catch(
            (): DigestModelCheck => ({ state: "unchecked", reason: "list-error" }),
          );
    modelCheck = check
      .then((result) => {
        modelCheckResult = result;
        if (result.state === "model-unavailable") {
          log(
            formatLog({
              event: "digest",
              state: "model-unavailable",
              model: settings.digestModel,
              consequence: "digest-skipped",
            }),
          );
        } else if (result.state === "unchecked") {
          log(
            formatLog({
              event: "digest",
              state: "model-unchecked",
              reason: result.reason,
              model: settings.digestModel,
              consequence: "validation-skipped",
            }),
          );
        }
        return result;
      })
      // log 本身若丟錯也不讓啟動期驗證變成 unhandled rejection：退回「不驗證」。
      .catch((): DigestModelCheck => ({ state: "unchecked", reason: "list-error" }));
    return modelCheck;
  };

  /** 讀 session 資訊：subagent 與「不是本 location」都在這裡擋掉。 */
  const checkOwnership = async (
    sessionID: string,
  ): Promise<{ ok: true } | { ok: false; reason: DigestSkipReason }> => {
    const get = ctx.session.get;
    if (get === undefined) return { ok: false, reason: "no-session-api" };
    let info: unknown;
    try {
      info = await get.call(ctx.session, { sessionID });
    } catch {
      return { ok: false, reason: "session-lookup-failed" };
    }
    if (typeof info !== "object" || info === null) {
      return { ok: false, reason: "session-lookup-failed" };
    }
    const parentID = (info as { parentID?: unknown }).parentID;
    if (typeof parentID === "string" && parentID !== "") return { ok: false, reason: "subagent" };
    const directory = (info as { location?: { directory?: unknown } | null }).location?.directory;
    if (!sameDirectory(typeof directory === "string" ? directory : undefined, deps.locationDirectory, platform)) {
      return { ok: false, reason: "other-location" };
    }
    return { ok: true };
  };

  const callModel = async (prompt: string): Promise<string> => {
    const generate: GenerateDomainLike | undefined = ctx.generate;
    if (generate === undefined || model === null) throw new DigestFailure("no-generate");
    const output = await withTimeout(
      (signal) => generate.text({ prompt, model }, { signal }),
      modelTimeoutMs,
    );
    const text = typeof output?.text === "string" ? output.text : "";
    if (text.trim() === "") throw new DigestFailure("empty-response");
    return text;
  };

  const runDigest = async (sessionID: string, snapshot: unknown[]): Promise<void> => {
    const startedAt = now();
    const startedMs = Date.now();
    await ensurePruned();

    const resolved = resolveDigestTurn(snapshot);
    if ("skip" in resolved) {
      skip(sessionID, resolved.skip, startedAt);
      return;
    }
    const turn = resolved.turn;
    const seenKey = `digest:${sessionID}:${turn.assistantMessageID}`;
    if (await store.hasSeen(seenKey)) {
      skip(sessionID, "already", startedAt);
      return;
    }
    if (project === null && deps.scope === "project") {
      skip(sessionID, "project-unresolved", startedAt);
      return;
    }
    const day = formatDay(startedAt);

    const ownership = await checkOwnership(sessionID);
    if (!ownership.ok) {
      skip(sessionID, ownership.reason, startedAt);
      return;
    }

    const connection = await deps.getConnection();
    if (connection === null) {
      if (!warnedOffline) {
        warnedOffline = true;
        log(formatLog({ event: "digest", state: "offline", consequence: "digest-skipped" }));
      }
      skip(sessionID, "offline", startedAt);
      return;
    }

    // 統計只作顯示：呼叫前先記一次，模型失敗也算一次呼叫。
    await bumpStats(day, { calls: 1 });
    let raw: string;
    try {
      raw = await callModel(buildDigestPrompt(turn));
    } catch (error) {
      await bumpStats(day, { callFailed: 1 });
      record(
        sessionID,
        { state: "failed", at: now().toISOString(), reason: failureReason(error) },
        Date.now() - startedMs,
      );
      return;
    }

    const parsed = parseDigestItems(raw, turn.sourceText, MAX_DIGEST_ITEMS);
    if (parsed.error !== undefined) {
      await bumpStats(day, { callFailed: 1 });
      record(
        sessionID,
        { state: "failed", at: now().toISOString(), reason: parsed.error },
        Date.now() - startedMs,
      );
      return;
    }
    // 輸出形狀固定：1 張回合紀錄＋最多 2 則原子記憶（items 已由 parse 截斷）。
    const cards = buildDigestCards(parsed);
    const candidateCount = countDigestCards(parsed);
    if (cards.length === 0) {
      // 模型回空就回空：不造假一張空回合卡。「這回合沒有可記的內容」也算處理完成，
      // 標記去重，避免同一事件重送時再花一次模型錢。
      await store.markSeen(seenKey, now());
      record(
        sessionID,
        {
          state: "ok",
          at: now().toISOString(),
          written: 0,
          items: 0,
          duplicates: 0,
          failed: 0,
          cards: [],
        },
        Date.now() - startedMs,
      );
      return;
    }

    let written = 0;
    let duplicates = 0;
    let failed = 0;
    let lastStatus: number | undefined;
    const results: DigestCardResult[] = [];
    for (const card of cards) {
      const role: DigestCardResult["role"] = card.agent === DIGEST_TURN_AGENT ? "turn" : "item";
      const result = await writeDigestMemory({
        connection,
        scope: deps.scope,
        project,
        sessionID,
        messageID: turn.assistantMessageID,
        item: card.item,
        agent: card.agent,
        force: card.force,
        timeoutMs: writeTimeoutMs,
        ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
      });
      if (result.ok) {
        if (result.duplicate) {
          duplicates += 1;
          results.push({ role, state: "duplicate" });
        } else {
          written += 1;
          results.push({ role, state: "ok" });
        }
        continue;
      }
      failed += 1;
      lastStatus = result.status;
      results.push({
        role,
        state: "failed",
        ...(result.status === undefined ? {} : { status: result.status }),
      });
    }
    // 統計一次寫入整回合的結果（read-modify-write；只作顯示，偏低不影響行為）。
    await bumpStats(day, { ok: written, duplicate: duplicates, failed });

    if (written > 0 || duplicates > 0) {
      // 至少一張成功或全部重複都算處理完成：標記去重，不重複花模型錢。
      await store.markSeen(seenKey, now());
      record(
        sessionID,
        {
          state: "ok",
          at: now().toISOString(),
          written,
          items: candidateCount,
          duplicates,
          failed,
          cards: results,
        },
        Date.now() - startedMs,
      );
      return;
    }
    record(
      sessionID,
      {
        state: "failed",
        at: now().toISOString(),
        reason: lastStatus === undefined ? "network" : `http-${lastStatus}`,
        failed,
        cards: results,
      },
      Date.now() - startedMs,
    );
  };

  const enqueue = (sessionID: string, snapshot: unknown[]): void => {
    const previous = chains.get(sessionID) ?? Promise.resolve();
    pending += 1;
    const task: Promise<void> = previous
      .then(() => runDigest(sessionID, snapshot))
      .catch((error: unknown) => {
        // 任何預期外的錯誤都只記原因（不含對話內容）：不讓 digest 影響 session。
        record(sessionID, {
          state: "failed",
          at: now().toISOString(),
          reason: failureReason(error),
        });
      });
    chains.set(sessionID, task);
    void task.then(() => {
      pending -= 1;
      if (chains.get(sessionID) === task) chains.delete(sessionID);
    });
  };

  const handleEvent = async (raw: unknown): Promise<void> => {
    handling += 1;
    try {
      const event = parseTerminalEvent(raw);
      if (event === null) return;
      // `failed` 永遠不寫；`interrupted` 依設定，且關機造成的絕不補寫。
      if (event.type === "failed") return;
      if (event.type === "interrupted") {
        if (!settings.digestOnInterrupted) return;
        if (event.reason === "shutdown") return;
      }
      if (model === null) {
        warnNoModel();
        skip(event.sessionID, "no-model");
        return;
      }
      // 啟動期驗證過模型不存在：每回合直接跳過，連快照與模型呼叫都不做。
      const check = await verifyModel();
      if (check.state === "model-unavailable") {
        skip(event.sessionID, "model-unavailable");
        return;
      }
      const capture = ctx.session.context;
      if (capture === undefined) {
        skip(event.sessionID, "no-context-api");
        return;
      }
      // 關鍵：事件到的當下就抓快照，之後排隊也只處理這份（水位線不隨時間漂移）。
      let snapshot: unknown;
      try {
        snapshot = await capture.call(ctx.session, { sessionID: event.sessionID });
      } catch {
        skip(event.sessionID, "capture-failed");
        return;
      }
      if (!Array.isArray(snapshot)) {
        skip(event.sessionID, "bad-context");
        return;
      }
      enqueue(event.sessionID, snapshot);
    } catch (error) {
      log(formatLog({ event: "digest", state: "event-error", reason: errorName(error) }));
    } finally {
      handling -= 1;
    }
  };

  const start = (): boolean => {
    if (!settings.digestEnabled) return false;
    if (model === null) {
      warnNoModel();
      return false;
    }
    // 啟動期驗證一次（背景）：模型不存在時只 warning 一次，之後每回合直接跳過。
    void verifyModel();
    const subscribe = ctx.event?.subscribe;
    if (ctx.event === undefined || typeof subscribe !== "function") {
      log(formatLog({ event: "digest", state: "unsupported", reason: "no-event-api" }));
      return false;
    }
    if (iterator !== undefined) return true;
    try {
      const stream = subscribe.call(ctx.event);
      const active = stream[Symbol.asyncIterator]();
      iterator = active;
      void (async () => {
        try {
          for (;;) {
            const next = await active.next();
            if (next.done === true) break;
            if (disposed) break;
            // fire-and-forget：事件處理不阻塞事件流，任何例外都不外洩。
            void handleEvent(next.value).catch(() => undefined);
          }
        } catch (error) {
          if (!disposed) {
            log(formatLog({ event: "digest", state: "stream-error", reason: errorName(error) }));
          }
        }
      })();
    } catch (error) {
      log(formatLog({ event: "digest", state: "subscribe-failed", reason: errorName(error) }));
      return false;
    }
    log(
      formatLog({
        event: "digest",
        state: "enabled",
        onInterrupted: settings.digestOnInterrupted,
      }),
    );
    void ensurePruned();
    return true;
  };

  const awaitIdle = async (): Promise<void> => {
    // `handling` 涵蓋「事件已收到、還沒排進佇列」的窗口；`pending` 涵蓋已排隊的工作。
    for (let round = 0; round < 100; round += 1) {
      if (pending === 0 && handling === 0) break;
      await Promise.allSettled([...chains.values()]);
      if (pending === 0 && handling === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    // 診斷紀錄是 fire-and-forget 的；這裡等它落地，測試與關閉流程才看得到完整檔案。
    if (pendingLogs.size > 0) await Promise.allSettled([...pendingLogs]);
  };

  /**
   * 今日統計的顯示文字（只供顯示，不是上限）。
   *
   * - 未連線：`今日：未知（未連線）`——不拿本機舊數字冒充。
   * - 統計讀不到：`今日：未知`。
   */
  const todayStatsText = async (): Promise<string> => {
    const connection = await deps.getConnection();
    if (connection === null) return "今日：未知（未連線）";
    const stats = await store.dayStats(formatDay(now()));
    if (stats === null) return "今日：未知";
    return `今日 呼叫 ${stats.calls}｜寫入 ${stats.ok}｜重複 ${stats.duplicate}｜失敗 ${stats.failed}（回合 ${stats.callFailed}）`;
  };

  const statusLines = async (): Promise<string[]> => {
    const lines: string[] = [];
    const today = await todayStatsText();
    if (!settings.digestEnabled) {
      lines.push(`摘要：關閉（digestEnabled=false；${today}）`);
    } else if (model === null) {
      lines.push(
        `摘要：已開啟但未指定模型（digestEnabled=true、digestModel 未設定：不會呼叫模型、不會寫入；${today}）`,
      );
    } else if (modelCheckResult?.state === "model-unavailable") {
      lines.push(
        `摘要：已開啟但模型不可用（${settings.digestModel}：providerID 或 model id 不存在／未啟用；不會呼叫模型；${today}）`,
      );
    } else {
      // 清單取不到時誠實標示「未驗證」：行為與以前相同（照舊嘗試），但使用者看得到原因。
      const unchecked =
        modelCheckResult?.state === "unchecked" ? "；模型清單取不到，未驗證模型是否存在" : "";
      lines.push(`摘要：開啟（模型 ${settings.digestModel}；${today}${unchecked}）`);
    }
    if (last === undefined) {
      lines.push("最近摘要：尚無紀錄");
    } else if (last.state === "ok") {
      // 只有「真的寫了東西」才說成功；0 筆時要說清楚是重複、失敗還是沒有可記的內容。
      let detail: string;
      if (last.written === 0 && last.duplicates === 0 && last.failed === 0) {
        detail = "本回合沒有可記的內容";
      } else {
        const notes: string[] = [];
        if (last.duplicates > 0) notes.push(`重複 ${last.duplicates} 筆`);
        if (last.failed > 0) notes.push(`失敗 ${last.failed} 筆`);
        detail = `成功寫入 ${last.written} 筆${notes.length === 0 ? "" : `（${notes.join("、")}）`}`;
      }
      lines.push(`最近摘要：${last.at}｜${detail}`);
    } else if (last.state === "skipped") {
      lines.push(`最近摘要：${last.at}｜跳過：${skipReasonText(last.reason)}`);
    } else {
      lines.push(`最近摘要：${last.at}｜失敗：${truncateChars(failureText(last.reason), MAX_FAILURE_REASON_CHARS)}`);
      // 只給路徑、不給內容：方便使用者把檔案交回來排查。
      lines.push(`紀錄：${logFile}`);
    }
    return lines;
  };

  const dispose = async (): Promise<void> => {
    disposed = true;
    const active = iterator;
    iterator = undefined;
    if (active !== undefined) {
      try {
        // 不 await：事件流的 next() 可能永遠懸著，關閉不能被它拖住。
        const closing = active.return?.(undefined);
        if (closing !== undefined) void closing.catch(() => undefined);
      } catch {
        // 收尾失敗不影響宿主關閉。
      }
    }
    // 刻意不等排隊中的工作：關閉不應被模型 timeout 拖住；未完成的 digest 不補跑。
  };

  return { start, awaitIdle, statusLines, dispose };
}
