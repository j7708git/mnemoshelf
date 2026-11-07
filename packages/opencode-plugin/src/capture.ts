/** 依 OpenCode 2.1.1 的 durable terminal event 與公開 session 快照保存可見文字。 */
import os from "node:os";
import path from "node:path";
import { STATUS_SENTINEL } from "./constants.js";
import {
  asRecord,
  occurredAt,
  sourceRef,
  stripCapturedText,
  visibleText,
  type MemorySourceMessage,
  type SourceWriteRequest,
} from "./raw-memory.js";
import { createSourceSpool } from "./spool.js";
import { formatLog, type Connection, type LogFn, type PluginContextLike } from "./types.js";

export const LEGACY_TURN_AGENT = "opencode-plugin/turn";
const FLUSH_INTERVAL_MS = 5 * 60 * 1000;
const CAPTURE_AGENT = "opencode-plugin/raw-turn";

interface TerminalEvent {
  sessionID: string;
  id?: string;
  created?: number;
  outcome: "succeeded" | "failed" | "interrupted";
  reason?: unknown;
}

function stringID(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function epoch(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function terminalEvent(value: unknown): TerminalEvent | null {
  const event = asRecord(value);
  const data = asRecord(event?.data);
  const sessionID = stringID(data?.sessionID);
  if (!sessionID || !event) return null;
  const outcome =
    event.type === "session.execution.succeeded" ? "succeeded" :
    event.type === "session.execution.failed" ? "failed" :
    event.type === "session.execution.interrupted" ? "interrupted" : null;
  return outcome === null ? null : {
    sessionID,
    id: stringID(event.id),
    created: epoch(event.created),
    outcome,
    reason: data?.reason,
  };
}

interface VisibleMessage {
  role: MemorySourceMessage["role"];
  id?: string;
  text: string;
  occurredAt: string | null;
  final: boolean;
  status: boolean;
}

function visibleMessage(record: Record<string, unknown>): VisibleMessage | null {
  // 明確的宿主型別優先，不能把 role=user 的 synthetic/system 當使用者原文。
  const role = record.type ?? record.role;
  const text = visibleText(record.content ?? record.text);
  if (text === null) return null;
  if (role === "synthetic" || record.synthetic === true) {
    return text.trimStart().startsWith(STATUS_SENTINEL)
      ? { role: "user", text: "", occurredAt: null, final: false, status: true }
      : null;
  }
  if (role !== "user" && role !== "assistant") return null;
  const cleaned = stripCapturedText(text);
  if (cleaned !== text && cleaned.trim() === "") return null;
  return {
    role,
    id: stringID(record.id),
    text: cleaned,
    occurredAt: occurredAt(asRecord(record.time)?.created),
    final: role === "assistant" && record.finish !== "tool-calls",
    status: role === "user" && text.trimStart().startsWith(STATUS_SENTINEL),
  };
}

type CaptureResolution =
  | { payload: SourceWriteRequest; boundary: "terminal-window" | "visible-context" }
  | { skip: string };

export function resolveCapture(input: {
  snapshot: unknown[];
  event: TerminalEvent;
  previousTerminal?: number;
  project: string | null;
}): CaptureResolution {
  const messages: VisibleMessage[] = [];
  let boundary: "terminal-window" | "visible-context" =
    input.previousTerminal === undefined ? "visible-context" : "terminal-window";
  for (const value of input.snapshot) {
    const record = asRecord(value);
    if (!record) continue;
    const time = asRecord(record.time);
    const created = epoch(time?.created);
    const completed = epoch(time?.completed);
    if (input.event.created !== undefined && (
      (created !== undefined && created > input.event.created) ||
      (completed !== undefined && completed > input.event.created)
    )) break;
    if (input.previousTerminal !== undefined && created !== undefined && created <= input.previousTerminal) continue;
    if (record.type === "idle") {
      // 新／舊宿主可能把終止標記帶進 context。末尾標記結束當次回合，中間標記為前次邊界。
      if (created !== undefined && input.event.created === created) break;
      messages.length = 0;
      boundary = "terminal-window";
      continue;
    }
    const parsed = visibleMessage(record);
    if (parsed !== null) messages.push(parsed);
  }

  // 沒有上一個終止水位時，只採本次快照中可定位的回合；有完整水位則保留所有 user
  // steering 與中間可見 assistant。未知舊宿主也不會宣稱取到不可見歷史。
  if (boundary === "visible-context") {
    let latestUser = -1;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index]!.role === "user") {
        latestUser = index;
        break;
      }
    }
    if (latestUser < 0) return { skip: "no-visible-user" };
    let start = latestUser;
    for (let index = latestUser - 1; index >= 0; index -= 1) {
      const message = messages[index]!;
      if (message.final || message.status) break;
      if (message.role === "user") start = index;
    }
    messages.splice(0, start);
  }

  const lastUser = messages.findLast((message) => message.role === "user");
  if (lastUser === undefined) return { skip: "no-visible-user" };
  if (lastUser.status || lastUser.text.trimStart().startsWith("/")) return { skip: "command-turn" };
  // 外掛的 synthetic 狀態若夾在多個可見 user 之間，不擷取它或它之前的命令回合。
  const lastStatus = messages.findLastIndex((message) => message.status);
  if (lastStatus >= 0) messages.splice(0, lastStatus + 1);
  const firstUser = messages.findIndex((message) => message.role === "user");
  if (firstUser < 0) return { skip: "no-visible-user" };
  messages.splice(0, firstUser);
  if (!messages.some((message) => message.text.trim() !== "")) return { skip: "no-visible-text" };

  const sourceSession = sourceRef(input.event.sessionID);
  const turnID = input.event.id === undefined
    ? (messages[0]?.id === undefined ? undefined : `first:${JSON.stringify([input.event.sessionID, messages[0].id])}`)
    : input.event.id;
  if (turnID === undefined) return { skip: "no-stable-turn-id" };
  const seen = new Set<string>();
  const output: MemorySourceMessage[] = [];
  for (const [index, message] of messages.entries()) {
    let id = sourceRef(message.id ?? `visible:${message.role}:${index}`);
    if (seen.has(id)) {
      if (message.id !== undefined) return { skip: "duplicate-host-message-id" };
      while (seen.has(id)) id = sourceRef(`fallback:${id}`);
    }
    seen.add(id);
    output.push({ sourceMessage: id, role: message.role, content: message.text, occurredAt: message.occurredAt });
  }
  return {
    boundary,
    payload: {
      agent: CAPTURE_AGENT,
      scope: input.project === null ? "global" : "project",
      ...(input.project === null ? {} : { project: input.project }),
      sourceSession,
      sourceTurn: sourceRef(turnID),
      messages: output,
    },
  };
}

export function resolveCaptureSpoolDir(input: {
  spoolDir?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
}): string {
  if (input.spoolDir) return path.resolve(input.spoolDir);
  const env = input.env ?? process.env;
  const home = input.home ?? os.homedir();
  const platform = input.platform ?? process.platform;
  const p = platform === "win32" ? path.win32 : path.posix;
  const base = platform === "win32"
    ? env.LOCALAPPDATA || p.join(home, "AppData", "Local")
    : platform === "darwin" ? p.join(home, "Library", "Application Support")
    : env.XDG_STATE_HOME || p.join(home, ".local", "state");
  return p.join(base, "mnemoshelf", "opencode-spool");
}

export function createCaptureRuntime(input: {
  ctx: PluginContextLike;
  enabled: boolean;
  onInterrupted: boolean;
  scope: "project" | "global";
  project: string | null;
  platform: NodeJS.Platform;
  dir: string;
  getConnection: () => Promise<Connection | null>;
  refreshConnection: () => Promise<Connection | null>;
  log: LogFn;
  fetchImpl?: typeof fetch;
  disableStartupFlush?: boolean;
}) {
  const { ctx, platform } = input;
  const p = platform === "win32" ? path.win32 : path.posix;
  const log = (event: string, fields?: Record<string, string | number | boolean | null>): void =>
    input.log(formatLog({ event, ...fields }));
  const spool = createSourceSpool({ dir: input.dir, log, fetchImpl: input.fetchImpl });
  const pending = new Set<Promise<void>>();
  const terminalTimes = new Map<string, { id?: string; created: number; previous?: number }>();
  let timer: NodeJS.Timeout | undefined;
  let initialTimer: NodeJS.Timeout | undefined;
  let iterator: AsyncIterator<unknown> | undefined;
  let disposed = false;
  let lastCapture: string | undefined;
  const skip = (reason: string): void => {
    lastCapture = reason;
    log("capture-skip", { reason });
  };

  const awaitIdle = async (): Promise<void> => {
    while (pending.size !== 0) await Promise.allSettled([...pending]);
    await spool.awaitIdle();
  };

  const handleEvent = async (value: unknown): Promise<void> => {
    const event = terminalEvent(value);
    if (!event) return;
    const last = terminalTimes.get(event.sessionID);
    const isReplay = event.id !== undefined && event.id === last?.id;
    const previousTerminal = isReplay ? last?.previous : last?.created;
    if (event.created !== undefined && previousTerminal !== undefined && event.created < previousTerminal) {
      skip("stale-terminal-event");
      return;
    }
    if (event.created !== undefined && !isReplay) {
      terminalTimes.delete(event.sessionID);
      terminalTimes.set(event.sessionID, { id: event.id, created: event.created, previous: previousTerminal });
      if (terminalTimes.size > 512) terminalTimes.delete(terminalTimes.keys().next().value!);
    }
    if (event.outcome === "failed") return;
    if (event.outcome === "interrupted" &&
      (!input.onInterrupted || event.reason === "shutdown" || event.reason === "superseded")) return;
    if (input.scope === "project" && input.project === null) {
      skip("project-unresolved");
      return;
    }
    if (!ctx.session.context || !ctx.session.get) {
      skip("host-context-unavailable");
      return;
    }

    // 在事件送達時立刻要求快照；與 ownership 查詢並行，避免等網路寫入後才抓到別輪。
    const [snapshot, info] = await Promise.all([
      ctx.session.context({ sessionID: event.sessionID }),
      ctx.session.get({ sessionID: event.sessionID }),
    ]);
    const session = asRecord(info);
    if (!session) {
      skip("host-session-unavailable");
      return;
    }
    if (stringID(session.parentID)) {
      skip("subagent");
      return;
    }
    const directory = stringID(asRecord(session.location)?.directory);
    const expected = stringID(ctx.location?.directory);
    const normalize = (value: string): string => {
      const resolved = p.resolve(value);
      return platform === "win32" ? resolved.toLowerCase() : resolved;
    };
    if (!directory || !expected || normalize(directory) !== normalize(expected)) {
      skip("other-location");
      return;
    }
    if (!Array.isArray(snapshot)) {
      skip("host-context-unavailable");
      return;
    }
    const resolved = resolveCapture({ snapshot, event, previousTerminal, project: input.project });
    if ("skip" in resolved) {
      skip(resolved.skip);
      return;
    }
    lastCapture = undefined;
    log("capture-snapshot", { boundary: resolved.boundary, messages: resolved.payload.messages.length });
    await spool.add(resolved.payload, input.getConnection);
  };

  const flush = async (): Promise<void> => {
    if (!disposed && input.enabled) await spool.flush(input.refreshConnection);
  };

  const start = (): void => {
    if (!input.enabled) return;
    if (input.disableStartupFlush !== true) {
      initialTimer = setTimeout(() => void flush(), 0);
      initialTimer.unref();
      timer = setInterval(() => void flush(), FLUSH_INTERVAL_MS);
      timer.unref();
    }
    if (!ctx.event) {
      skip("host-event-unavailable");
      return;
    }
    try {
      const active = ctx.event.subscribe()[Symbol.asyncIterator]();
      iterator = active;
      void (async () => {
        try {
          while (!disposed) {
            const next = await active.next();
            if (next.done || disposed) break;
            const work = handleEvent(next.value).catch(() => skip("host-capture-failed"));
            pending.add(work);
            void work.then(() => pending.delete(work));
          }
        } catch {
          if (!disposed) skip("host-event-stream-failed");
        }
      })();
    } catch {
      skip("host-event-subscribe-failed");
    }
  };

  const statusLines = (): string[] => {
    if (!input.enabled) return ["原文擷取：關閉（captureEnabled=false）"];
    const state = lastCapture ?? spool.lastState();
    return [
      "原文擷取：開啟（宿主可見的使用者與助理文字）",
      ...(state === undefined ? [] : [
        state === "upgrade-required"
          ? "原文待補送：服務不支援原文記憶，請升級 Mnemoshelf。"
          : `原文擷取狀態：${state}`,
      ]),
    ];
  };

  return {
    start, awaitIdle, flush, statusLines,
    async dispose(): Promise<void> {
      disposed = true;
      if (initialTimer) clearTimeout(initialTimer);
      if (timer) clearInterval(timer);
      // 宿主 stream 的 return 可能要等下一個事件；它不應阻擋 location 關閉。
      void iterator?.return?.().catch(() => undefined);
      await awaitIdle();
    },
  };
}
