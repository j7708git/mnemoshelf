/**
 * dsh 外掛 API 的結構型別。
 *
 * 這裡刻意**不** import `@deepseek-ai/dsh-*`：外掛執行時只需要 dsh 注入的
 * `Context`，型別只是為了在本 repo 內取得 strict 檢查。manifest 仍依 T2 §12.8
 * 宣告 peerDependencies（標成 optional，避免 pnpm 為了型別去安裝整套 dsh）。
 *
 * 形狀來源：`project-notes/projects/mnemoshelf/research/2026-10-28-dsh-plugin-api.md`
 * §2（pre-step）、§3–§4（session 事件）、§5（session 過濾）。
 */

/** 一段純文字 content block。 */
export interface TextBlockLike {
  type: "text";
  text: string;
}

/** dsh 訊息的 `source`；`kind` 是辨識注入來源的主要依據，`form` 只是 UI 提示。 */
export interface MessageSourceLike {
  kind?: string;
  form?: string;
}

/** 模型可見訊息（`user/message`／`assistant/message` 的內容）。 */
export interface MessageLike {
  id?: string;
  role?: string;
  content?: unknown;
  source?: MessageSourceLike;
}

/** `agent.session` 只需要 id。 */
export interface SessionLike {
  id: string;
}

export interface AgentLike {
  session: SessionLike;
}

/** `session/event` 的廣播事件；`data` 依事件型別而異，由 handler 逐項收斂。 */
export interface SessionEventLike {
  type: string;
  seq?: number;
  data?: Record<string, unknown>;
}

export interface PreStepPayloadLike {
  agent: AgentLike;
  messages: MessageLike[];
  turn: number;
  step: number;
  signal?: AbortSignal;
}

export type PreStepDecisionLike =
  | { kind: "reject" }
  | { kind: "enter"; messages: MessageLike[]; startsRequestSeries?: true };

export type NextLike = () => Promise<PreStepDecisionLike>;

/** 只宣告本外掛用到的 cordis 介面；其他服務不碰。 */
export interface PluginContextLike {
  on(event: string, listener: (...args: never[]) => unknown): unknown;
  effect?(setup: () => () => void, label?: string): unknown;
}

/** `POST /memories/search` 的回應命中最小小形狀。 */
export interface RecallHitLike {
  id?: unknown;
  content?: unknown;
  kind?: unknown;
  createdAt?: unknown;
  score?: unknown;
  source?: unknown;
  pinned?: unknown;
}

/** 解析完成的 Mnemoshelf 連線（含全權 token；不得寫進 log／spool）。 */
export interface Connection {
  baseUrl: string;
  token: string;
  source: "options" | "env" | "runtime";
  appVersion?: string;
}

export type ConnectionSource = Connection["source"];

/** runtime.json 的已驗證內容（與 server `agent-discovery.ts` 同一套規則）。 */
export interface RuntimeFileRecord {
  schemaVersion: 1;
  url: string;
  token: string;
  pid: number;
  startedAt: string;
  appVersion: string;
}

/** `POST /memories` 的請求主體（只放卡片需要的欄位）。 */
export interface MemoryWritePayload {
  content: string;
  kind: "fact";
  scope: "project" | "global";
  project?: string;
  agent: "dsh/turn";
  sourceSession: string;
  sourceMessage: string;
}

/** spool 檔案的內容；**不含** token、url 或任何連線資訊。 */
export interface SpoolRecord {
  schemaVersion: 1;
  createdAt: number;
  payload: MemoryWritePayload;
}

/** 結構化 log：只接受事件名與純量／計數欄位，避免把內容或憑證帶出去。 */
export type LogFn = (event: string, fields?: Record<string, string | number | boolean | null>) => void;

/** 測試可注入的依賴；正式流程全部用預設值。 */
export interface RuntimeDeps {
  fetchImpl?: typeof fetch;
  readFileImpl?: (file: string) => Promise<string>;
  killImpl?: (pid: number, signal: 0) => void;
  log?: LogFn;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
  cwd?: string;
  /** 測試用：覆寫 spool 目錄（正式流程是 `<DSH_HOME>/mnemoshelf-spool`）。 */
  spoolDir?: string;
  /** 測試用：縮短補送間隔；正式流程固定 5 分鐘。 */
  flushIntervalMs?: number;
  /** 測試用：關閉啟動補送（避免背景計時器干擾斷言）。 */
  disableStartupFlush?: boolean;
}
