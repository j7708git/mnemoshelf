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

/** 一次召回的最終統計（不含 query／記憶內容）。 */
export interface RecallStats {
  /** server 回傳筆數。 */
  returned: number;
  /** 實際放進區塊的筆數。 */
  kept: number;
  /** 區塊字元數。 */
  chars: number;
  /** 請求延遲（毫秒）。 */
  latencyMs: number;
  /** 跳過原因；有值代表這輪沒有注入。 */
  skipped?: string;
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

/** 本外掛用到的 `ctx.session` 子集。 */
export interface SessionDomainLike {
  hook(
    name: "context",
    callback: (event: ContextEventLike) => Promise<void> | void,
  ): Promise<RegistrationLike | void>;
  synthetic(input: { sessionID: string; text: string }): Promise<unknown>;
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
}

/** 結構化的單行 log。 */
export function formatLog(payload: Record<string, unknown>): string {
  return `[mnemoshelf] ${JSON.stringify(payload)}`;
}
