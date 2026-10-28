/**
 * `@mnemoshelf/dsh-plugin` 入口。
 *
 * 生命週期：
 * - `agent/created`：記住自己的 session id（`session/event` 是全域廣播，必須過濾）。
 * - `agent/pre-step`：回合第一步、且有真人輸入時，召回並追加一則 `user/message`。
 * - `session/event`：緩衝本 session 的 user／assistant 文字；`turn/end` 後寫一張回合卡。
 * - 啟動與每 5 分鐘補送 spool。
 *
 * 所有 handler 都 fail-open：召回失敗只影響「這次不注入」，寫入失敗進 spool；
 * **不得**讓 dsh 回合失敗（`agent/pre-step` 的例外會讓整個回合變 error，見 T2 §8.2）。
 */
import { randomUUID } from "node:crypto";
import os from "node:os";
import {
  CONNECTION_WAIT_MS,
  SPOOL_FLUSH_INTERVAL_MS,
  createConnectionManager,
  readSettings,
  resolveProject,
  resolveSpoolDir,
} from "./config.js";
import { buildCapturePayload, buildTurnCard } from "./capture.js";
import { RECALL_FORM, RECALL_SOURCE_KIND, isHumanMessage, recallForMessages } from "./recall.js";
import { flushSpool, postMemory, writeSpool } from "./spool.js";
import { asRecord, textOfContent } from "./strip.js";
import type {
  AgentLike,
  LogFn,
  MessageLike,
  PreStepDecisionLike,
  RuntimeDeps,
  SessionEventLike,
} from "./types.js";

export const name = "mnemoshelf-dsh-plugin";

/** 需要 sessions 服務（`agent/*` 與 `session/event` 由它提供）。 */
export const inject = ["sessions"];

interface TurnBuffer {
  turn: number | undefined;
  lastUser: string;
  lastAssistant: string;
}

function newTurnBuffer(): TurnBuffer {
  return { turn: undefined, lastUser: "", lastAssistant: "" };
}

function sessionIdOf(value: unknown): string | null {
  const record = asRecord(value);
  if (record === null) return null;
  const id = record.id;
  return typeof id === "string" && id !== "" ? id : null;
}

function agentOf(value: unknown): AgentLike | null {
  const record = asRecord(value);
  if (record === null) return null;
  const agent = asRecord(record.agent);
  if (agent === null) return null;
  const session = asRecord(agent.session);
  const id = session === null ? null : sessionIdOf(session);
  if (id === null) return null;
  return { session: { id } };
}

function reasonKindOf(event: SessionEventLike): string | null {
  const data = asRecord(event.data);
  const reason = data === null ? null : asRecord(data.reason);
  const kind = reason === null ? null : reason.kind;
  return typeof kind === "string" ? kind : null;
}

/** 正式流程的 log：stderr、單行、只放事件名與計數／代碼。 */
const defaultLog: LogFn = (event, fields) => {
  try {
    const suffix = fields === undefined ? "" : ` ${JSON.stringify(fields)}`;
    console.error(`[mnemoshelf-dsh] ${event}${suffix}`);
  } catch {
    // log 失敗不影響回合。
  }
};

export interface PluginRuntime {
  dispose(): void;
  /** 測試用：等待背景工作結束（正式流程不需要）。 */
  readonly flush: () => Promise<void>;
}

/**
 * 建立外掛 runtime。`deps` 只給測試注入；正式流程由 `apply` 使用預設值。
 */
export function createRuntime(
  ctx: import("./types.js").PluginContextLike,
  rawConfig: unknown,
  deps: RuntimeDeps = {},
): PluginRuntime {
  const log = deps.log ?? defaultLog;
  const now = deps.now ?? (() => new Date());
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const home = deps.home ?? os.homedir();
  const cwd = deps.cwd ?? process.cwd();

  const settings = readSettings(rawConfig);
  const project = resolveProject({
    optionProject: settings.project,
    envProject: env.MNEMOSHELF_PROJECT,
    cwd,
    home,
    platform,
  });
  const spoolDir =
    deps.spoolDir ?? resolveSpoolDir({ optionSpoolDir: settings.spoolDir, env, home });

  const connections = createConnectionManager({ settings, deps, log });
  const ownSessionIds = new Set<string>();
  const buffers = new Map<string, TurnBuffer>();
  let warnedOffline = false;
  let flushRunning = false;
  let disposed = false;

  const bufferFor = (sessionId: string): TurnBuffer => {
    let buffer = buffers.get(sessionId);
    if (buffer === undefined) {
      buffer = newTurnBuffer();
      buffers.set(sessionId, buffer);
    }
    return buffer;
  };

  const writeTurn = async (input: {
    sessionId: string;
    turn: number;
    userText: string;
    assistantText: string;
    reason: string;
  }): Promise<void> => {
    if (input.reason !== "completed") {
      log("turn-skip", { reason: input.reason });
      return;
    }
    const card = buildTurnCard(input.userText, input.assistantText);
    if (!card.ok) {
      log("turn-skip", { reason: card.skip });
      return;
    }
    const payload = buildCapturePayload({
      sessionId: input.sessionId,
      turn: input.turn,
      userText: input.userText,
      assistantText: input.assistantText,
      project,
    });
    if (payload === null) {
      log("turn-skip", { reason: "empty" });
      return;
    }

    let connection = await connections.get(CONNECTION_WAIT_MS);
    if (connection === null) {
      // 寫入發生在回合結束後，可以多等一次完整解析（含 /health）。
      connection = (await connections.ensure()).connection;
    }
    if (connection === null) {
      const resolution = connections.lastResolution();
      // 曾連上、之後 runtime.json 被移除（服務正常關閉會刪檔）也值得 spool：
      // spool 不含 token，服務回來後用新的 runtime.json 補送。
      if (resolution?.spoolable === true || connections.everConnected()) {
        await writeSpool({ dir: spoolDir, payload, now: now(), log });
        log("write-spooled", { reason: resolution?.reason ?? "offline" });
      } else {
        log("write-disabled", { reason: resolution?.reason ?? "offline" });
      }
      return;
    }

    const posted = await postMemory({
      connection,
      payload,
      ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
    });
    if (posted.ok) {
      log("write-ok", { status: posted.status, duplicate: posted.duplicate });
      warnedOffline = false;
      return;
    }
    connections.invalidate();
    await writeSpool({ dir: spoolDir, payload, now: now(), log });
    log("write-spooled", {
      reason: posted.reason,
      status: posted.status ?? null,
    });
  };

  const onSessionEvent = (sessionValue: unknown, eventValue: unknown): void => {
    try {
      const sessionId = sessionIdOf(sessionValue);
      if (sessionId === null || !ownSessionIds.has(sessionId)) return;
      const event = asRecord(eventValue);
      if (event === null || typeof event.type !== "string") return;
      const data = asRecord(event.data) ?? {};

      switch (event.type) {
        case "turn/start": {
          const buffer = bufferFor(sessionId);
          buffer.turn = typeof data.turn === "number" ? data.turn : undefined;
          buffer.lastUser = "";
          buffer.lastAssistant = "";
          return;
        }
        case "user/message": {
          const source = asRecord(data.source);
          if (source?.kind !== "user") return;
          const buffer = bufferFor(sessionId);
          buffer.lastUser = textOfContent(data.content);
          return;
        }
        case "assistant/message": {
          const message = asRecord(data.message);
          const text = textOfContent(message?.content);
          if (text.trim() === "") return;
          bufferFor(sessionId).lastAssistant = text;
          return;
        }
        case "turn/end": {
          const buffer = buffers.get(sessionId);
          if (buffer === undefined) return;
          const turn = typeof data.turn === "number" ? data.turn : buffer.turn;
          const userText = buffer.lastUser;
          const assistantText = buffer.lastAssistant;
          const reason = reasonKindOf({ type: event.type, data });
          buffers.set(sessionId, newTurnBuffer());
          if (turn === undefined) return;
          void writeTurn({
            sessionId,
            turn,
            userText,
            assistantText,
            reason: reason ?? "unknown",
          }).catch(() => {
            log("write-error", { reason: "handler" });
          });
          return;
        }
        default:
          return;
      }
    } catch (error) {
      log("event-error", { reason: error instanceof Error ? error.name : "unknown" });
    }
  };

  const onPreStep = async (
    payloadValue: unknown,
    next: () => Promise<PreStepDecisionLike>,
  ): Promise<PreStepDecisionLike> => {
    const decision = await next();
    try {
      if (decision.kind !== "enter") return decision;
      const payload = asRecord(payloadValue);
      if (payload === null) return decision;
      if (payload.step !== 1) return decision;
      const signal = payload.signal;
      if (signal instanceof AbortSignal && signal.aborted) return decision;

      const messages = Array.isArray(payload.messages)
        ? (payload.messages as MessageLike[])
        : [];
      if (!messages.some(isHumanMessage)) return decision;

      const agent = agentOf(payload);
      if (agent !== null) ownSessionIds.add(agent.session.id);

      const connection = await connections.get(CONNECTION_WAIT_MS);
      if (connection === null) {
        const resolution = connections.lastResolution();
        if (!warnedOffline) {
          warnedOffline = true;
          log("recall-skip", { reason: resolution?.reason ?? "offline" });
        }
        return decision;
      }
      warnedOffline = false;

      const result = await recallForMessages({
        messages,
        connection,
        project,
        now: now(),
        ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
      });
      if (result.block === "") {
        log("recall-skip", { reason: result.skip ?? "empty", hits: result.hits });
        return decision;
      }

      const message: MessageLike = {
        id: randomUUID(),
        role: "user",
        content: [{ type: "text", text: result.block }],
        source: { kind: RECALL_SOURCE_KIND, form: RECALL_FORM },
      };
      log("recall-inject", { hits: result.hits, chars: result.chars });
      return { ...decision, messages: [...decision.messages, message] };
    } catch (error) {
      // pre-step 的例外會讓整個回合變 error（T2 §8.2）：一律回原 decision。
      log("recall-error", { reason: error instanceof Error ? error.name : "unknown" });
      return decision;
    }
  };

  const runFlush = async (): Promise<void> => {
    if (disposed || flushRunning) return;
    flushRunning = true;
    try {
      const resolution = await connections.refresh();
      const result = await flushSpool({
        dir: spoolDir,
        connection: resolution.connection,
        log,
        ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
      });
      if (result.remaining > 0 && resolution.connection === null) {
        log("spool-offline", { reason: resolution.reason ?? "offline", remaining: result.remaining });
      }
    } catch {
      log("spool-error", { phase: "flush" });
    } finally {
      flushRunning = false;
    }
  };

  // 背景解析連線；不在 apply 階段阻塞 dsh 開機。
  void connections
    .ensure()
    .then((resolution) => {
      log("connection", {
        state: resolution.connection === null ? "offline" : "connected",
        reason: resolution.reason,
      });
    })
    .catch(() => {
      log("connection", { state: "offline", reason: "resolve-failed" });
    });

  let initialTimer: NodeJS.Timeout | undefined;
  let interval: NodeJS.Timeout | undefined;
  if (deps.disableStartupFlush !== true) {
    initialTimer = setTimeout(() => {
      void runFlush();
    }, 0);
    initialTimer.unref();
    interval = setInterval(() => {
      void runFlush();
    }, deps.flushIntervalMs ?? SPOOL_FLUSH_INTERVAL_MS);
    interval.unref();
  }

  ctx.on("agent/created", (payloadValue: unknown) => {
    try {
      const agent = agentOf(payloadValue);
      if (agent === null) return;
      ownSessionIds.add(agent.session.id);
      bufferFor(agent.session.id);
    } catch {
      log("event-error", { reason: "agent-created" });
    }
  });

  ctx.on("agent/disposed", (payloadValue: unknown) => {
    try {
      const agent = agentOf(payloadValue);
      if (agent === null) return;
      ownSessionIds.delete(agent.session.id);
      buffers.delete(agent.session.id);
    } catch {
      log("event-error", { reason: "agent-disposed" });
    }
  });

  ctx.on("session/event", onSessionEvent);
  ctx.on("agent/pre-step", onPreStep);

  const dispose = (): void => {
    disposed = true;
    if (initialTimer !== undefined) clearTimeout(initialTimer);
    if (interval !== undefined) clearInterval(interval);
    ownSessionIds.clear();
    buffers.clear();
  };

  ctx.effect?.(() => dispose, "mnemoshelf-dsh-plugin: dispose");

  return { dispose, flush: runFlush };
}

/** cordis 外掛入口。 */
export function apply(ctx: import("./types.js").PluginContextLike, config: unknown): void {
  createRuntime(ctx, config);
}
