/**
 * 外掛共用的型別。
 *
 * 這裡刻意用「結構型別」描述宿主（OpenCode／OpenChamber）提供的 `ctx`，而不是直接依賴
 * `@opencode/plugin` 的 `Context`：核心邏輯因此可以在一般 Node（vitest）裡用假 ctx 測試，
 * 不必載入宿主 runtime；真正的 `Context` 只在 `index.ts` 邊界做一次轉型。
 */

/** 召回開關。 */
export type TriggerMode = "first-turn+explicit" | "every-turn";

/** 外掛設定（由 plugin options 解析而來；所有值都已夾在合法範圍）。 */
export interface Settings {
  baseUrl?: string;
  token?: string;
  runtimeFile?: string;
  project?: string;
  trigger: TriggerMode;
  /** 送給 server 的候選筆數。 */
  kMax: number;
  /** 最多注入幾筆。 */
  maxItems: number;
  /** 語意命中的最低 cosine。 */
  minScore: number;
  /** 召回請求 timeout（毫秒）。 */
  timeoutMs: number;
  /** `fact` 每筆字元上限。 */
  maxFactChars: number;
  /** 其他 kind 每筆字元上限。 */
  maxOtherChars: number;
  /** 項目行合計軟上限。 */
  softChars: number;
  /** 整個區塊硬上限。 */
  hardChars: number;
  /** 同一 session 內已注入 id 的 TTL（輪）。 */
  dedupeTTL: number;
  /** 每次召回固定注入最近幾筆回合紀錄（0–5；0＝關閉）。 */
  recentTurns: number;
  /** 回合結束自動摘要（digest）總開關；預設關閉。 */
  digestEnabled: boolean;
  /** digest 用的模型（`<providerID>/<modelID>`）；未設定＝跳過，不退回目前 session 模型。 */
  digestModel: string | null;
  /** `interrupted`（非 shutdown）是否也補寫；預設關閉。 */
  digestOnInterrupted: boolean;
  /** digest 模型呼叫／模型清單檢查的 timeout（毫秒，3000–120000）；預設 45000。 */
  digestTimeoutMs: number;
}

/** 連線來源（除錯與 `/memory` 顯示用；不含 token）。 */
export type ConnectionSource = "options" | "env" | "runtime";

/** 已解析且（runtime 檔）通過身分驗證的連線。 */
export interface Connection {
  /** 已去掉結尾斜線的 base URL。 */
  baseUrl: string;
  token: string;
  source: ConnectionSource;
  /** `GET /health` 回報的服務版本（runtime 檔來源才有）。 */
  appVersion?: string;
}

/** `GET /health` 的回應（只取用得到的欄位）。 */
export interface HealthInfo {
  status?: string;
  service?: string;
  appVersion?: string;
}

/** `runtime.json` 的內容（與 server `agent-discovery.ts` 的格式一致）。 */
export interface RuntimeFileRecord {
  schemaVersion: 1;
  url: string;
  token: string;
  pid: number;
  startedAt?: string;
  appVersion?: string;
}

/** server `POST /memories/search` 的單筆命中（只宣告本外掛會用到的欄位）。 */
export interface RecallHit {
  id: number;
  content: string;
  kind: string;
  project: string | null;
  pinned?: boolean;
  createdAt: string;
  /** `semantic`＝cosine；`keyword`＝`1/rank`（僅供排序，不是 cosine）。 */
  source: "semantic" | "keyword";
  score: number;
  rank?: number;
}

/** server 回應主體（只取 `hits` 與降級旗標）。 */
export interface RecallResponse {
  hits: RecallHit[];
  degraded?: boolean;
}

/** `GET /memories` 的單筆回合紀錄（只宣告召回會用到的欄位）。 */
export interface RecallTurn {
  id: number;
  content: string;
  /** ISO 8601 時間字串。 */
  createdAt: string;
}

/** 一次召回的最終統計（不含 query／記憶內容）。 */
export interface RecallStats {
  /** server 回傳筆數。 */
  returned: number;
  /** 實際放進區塊的筆數（含回合紀錄）。 */
  kept: number;
  /** 區塊字元數。 */
  chars: number;
  /** 請求延遲（毫秒）。 */
  latencyMs: number;
  /** 區塊內有幾筆回合紀錄。 */
  turns?: number;
  /** 跳過原因；有值代表這輪沒有注入。 */
  skipped?: string;
  /**
   * 語意搜尋失敗、但最近回合紀錄仍注入時的原因（`timeout`／`network`／`http`／`bad-response`）。
   * 與 `skipped` 互斥：有這個欄位代表有注入（只有回合紀錄），只是語意部分失敗。
   */
  recallFailure?: string;
  /** 完成時間（ISO 8601）。 */
  at?: string;
}

/** 結構化 log：只放計數與原因，不放 query／記憶內容／token。 */
export type LogFn = (message: string) => void;

/** 宿主傳給 context hook 的事件（只宣告本外掛需要的欄位）。 */
export interface ContextEventLike {
  readonly sessionID: string;
  /** 目前只見過 `primary`；不存在時也要照常處理。 */
  kind?: string;
  messages: unknown[];
  system: { type: "text"; text: string; [key: string]: unknown }[];
}

/** hook／transform 註冊後的回傳（可 dispose）。 */
export interface RegistrationLike {
  dispose?: () => Promise<void> | void;
}

/** 指令被叫用時的輸入。 */
export interface CommandInvocationLike {
  sessionID: string;
  prompt?: { text?: string };
}

/** 指令編輯器（`ctx.command.transform` 的回呼參數）。 */
export interface CommandEditorLike {
  add(definition: {
    name: string;
    description?: string;
    execute: (input: CommandInvocationLike) => Promise<void>;
  }): void;
}

/** 宿主 `Session.Info` 中本外掛會用到的欄位（digest 的 ownership／subagent 判斷）。 */
export interface SessionInfoLike {
  /** 非空代表這是 subagent session（digest 跳過）。 */
  parentID?: string | null;
  /** session 所屬的 location（worktree／目錄）。 */
  location?: { directory?: string } | null;
}

/** 送給 `ctx.generate.text` 的模型參照（`GenerateTextInput.model`）。 */
export interface GenerateModelRefLike {
  id: string;
  providerID: string;
  variant?: string;
}

/** 本外掛用到的 `ctx.generate` 子集。 */
export interface GenerateDomainLike {
  text(
    input: { prompt: string; model?: GenerateModelRefLike | null },
    options?: { signal?: AbortSignal },
  ): Promise<{ text: string }>;
}

/** 本外掛用到的 `ctx.storage` 子集（plugin 專屬的持久 KV）。 */
export interface StorageLike {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
  scan(options: {
    prefix: string;
    after?: string;
    limit?: number;
  }): Promise<{ entries: readonly { readonly key: string; readonly value: unknown }[]; next?: string }>;
}

/**
 * 宿主模型清單的一筆（`ctx.model.list()` 回傳的 `data`）。
 *
 * `@opencode/plugin` 2.1.1 的 `ModelDomain.list()` 回 `{ location, data: Model.Info[] }`，
 * 其中 `Model.Info` 同時有 `id` 與 `modelID`（多數 provider 兩者相同）。`generate.text`
 * 解析模型時比對的是 `providerID` + `id`，所以 digest 的啟動期驗證也用這兩個欄位。
 */
export interface ModelInfoLike {
  /** 模型在宿主內的 id（`generate.text` 接受的那個）。 */
  id: string;
  /** provider 原始 model id；部分宿主會與 `id` 不同（別名）。 */
  modelID?: string;
  providerID: string;
}

/** `ctx.model.list()` 的回傳（只宣告本外掛會用到的欄位）。 */
export interface ModelListOutputLike {
  data?: readonly ModelInfoLike[];
}

/** 本外掛用到的 `ctx.model` 子集（digest 的啟動期模型驗證）。 */
export interface ModelDomainLike {
  list(input?: { location?: { directory?: string } }): Promise<ModelListOutputLike>;
}

/** 本外掛用到的 `ctx.session` 子集。 */
export interface SessionDomainLike {
  hook(
    name: "context",
    callback: (event: ContextEventLike) => Promise<void> | void,
  ): Promise<RegistrationLike | void>;
  synthetic(input: { sessionID: string; text: string }): Promise<unknown>;
  /** 取整個 session 的訊息（digest 的回合邊界靠它）。 */
  context?(input: { sessionID: string }): Promise<unknown>;
  /** 取 session 資訊（digest 的 ownership／subagent 判斷靠它）。 */
  get?(input: { sessionID: string }): Promise<unknown>;
}

/** 本外掛用到的 `ctx` 子集（真正的 Context 在 index.ts 轉型進來）。 */
export interface PluginContextLike {
  app?: { version?: string };
  options?: Record<string, unknown>;
  location?: {
    directory?: string;
    project?: { directory?: string; canonical?: string } | null;
  };
  session: SessionDomainLike;
  command?: {
    transform(callback: (editor: CommandEditorLike) => void): Promise<RegistrationLike | void>;
  };
  /** 全域事件流（digest 訂閱 `session.execution.*`；召回不使用）。 */
  event?: { subscribe(options?: unknown): AsyncIterable<unknown> };
  /** 指定模型的單次文字生成（digest 摘要用）。 */
  generate?: GenerateDomainLike;
  /** 宿主可用模型清單（digest 啟動期驗證 `digestModel` 是否存在）。 */
  model?: ModelDomainLike;
  /** plugin 專屬持久 KV（digest 的去重鍵與今日統計）。 */
  storage?: StorageLike;
}

/** 結構化的單行 log。 */
export function formatLog(payload: Record<string, unknown>): string {
  return `[mnemoshelf] ${JSON.stringify(payload)}`;
}
