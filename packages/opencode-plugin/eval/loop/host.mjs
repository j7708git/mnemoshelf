/**
 * 假宿主（fake OpenCode host）＋ canned 模型。
 *
 * 目的：讓 `createMemoryRuntime()` 的完整迴圈（事件 → 快照 → 回合解析 → 模型 → 寫入 →
 * 召回注入）在沒有人操作、也沒有真模型的情況下跑完。server 與 embedder 是真的。
 *
 * 每個宿主實例都有**自己的** `ctx.storage`、訊息、事件流、模型呼叫紀錄與 digest.log，
 * 避免去重鍵與預算跨實例串線。
 *
 * 重要：`ctx.model.list()` 一定要回一筆與 `digestModel` 完全相符的 `providerID`＋`id`；
 * 否則 digest 啟動期驗證會得到 `model-unavailable`，之後每回合直接跳過、一次模型都不呼叫。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = path.resolve(HERE, "..", "..");

/** canned 模型：provider／id 必須與 `digestModel` 一致。 */
export const DIGEST_MODEL = "canned/digest-model";
export const DIGEST_PROVIDER = "canned";
export const DIGEST_MODEL_ID = "digest-model";

/** 模型清單項（`Model.Info` 的欄位形狀與產品碼假設一致）。 */
const MODEL_ENTRY = { id: DIGEST_MODEL_ID, modelID: DIGEST_MODEL_ID, providerID: DIGEST_PROVIDER };

let runtimePromise;
/** 動態載入建置產物：`ensureBuild()` 一定要先跑過，否則這裡才會丟錯。 */
function loadRuntime() {
  runtimePromise ??= import(pathToFileURL(path.join(PACKAGE_DIR, "dist", "recall.js")).href);
  return runtimePromise;
}

export function tick(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function abortError() {
  return Object.assign(new Error("aborted"), { name: "AbortError" });
}

/** 可被 AbortSignal 中斷的 sleep（模型延遲與搜尋逾時都會用到）。 */
export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener?.("abort", onAbort);
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(abortError());
    };
    if (signal?.aborted === true) {
      onAbort();
      return;
    }
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

/** 逐回合推送的宿主事件流（形狀同 `session.execution.succeeded`）。 */
export class EventFeed {
  constructor() {
    this.items = [];
    this.resolver = undefined;
    this.closed = false;
    this.sequence = 0;
  }

  push(event) {
    if (this.resolver !== undefined) {
      const resolve = this.resolver;
      this.resolver = undefined;
      resolve({ value: event, done: false });
      return;
    }
    this.items.push(event);
  }

  close() {
    this.closed = true;
    if (this.resolver !== undefined) {
      const resolve = this.resolver;
      this.resolver = undefined;
      resolve({ value: undefined, done: true });
    }
  }

  async *stream() {
    try {
      for (;;) {
        if (this.items.length > 0) {
          yield this.items.shift();
          continue;
        }
        if (this.closed) return;
        const next = await new Promise((resolve) => {
          this.resolver = resolve;
        });
        if (next.done === true) return;
        yield next.value;
      }
    } finally {
      this.closed = true;
    }
  }
}

/** 每個宿主實例獨立的 `ctx.storage`（去重鍵與預算計數）。 */
export function memoryStorage() {
  const map = new Map();
  return {
    map,
    get: async (key) => map.get(key),
    set: async (key, value) => {
      map.set(key, value);
    },
    remove: async (key) => {
      map.delete(key);
    },
    scan: async ({ prefix, after, limit }) => {
      const keys = [...map.keys()].filter((key) => key.startsWith(prefix)).sort();
      const start = after === undefined ? 0 : keys.indexOf(after) + 1;
      const size = limit ?? 100;
      const page = keys.slice(start, start + size);
      const next = keys[start + page.length];
      return {
        entries: page.map((key) => ({ key, value: map.get(key) })),
        ...(next === undefined ? {} : { next }),
      };
    },
  };
}

/* ------------------------------------------------------------------ *
 * 訊息與事件（形狀以 `test/digest-runtime.test.ts` 為準）
 * ------------------------------------------------------------------ */

export function userMessage(id, text) {
  // 同時帶 `role` 與 `type`：召回端看 `role`，digest 端看 `type`（真實宿主兩者都有）。
  return { id, role: "user", type: "user", time: { created: 0 }, content: [{ type: "text", text }] };
}

export function assistantMessage(id, text) {
  return { id, role: "assistant", type: "assistant", time: { created: 0 }, content: [{ type: "text", text }] };
}

export function succeededEvent(sessionID, sequence = 0) {
  return {
    id: `evt-${sessionID}-${sequence}`,
    type: "session.execution.succeeded",
    data: { sessionID },
  };
}

/** 合成回合的使用者文字（含 token，canned 模型會從 prompt 讀回來）。 */
export function turnUser(token) {
  return `${token}：這一輪要確認對話記憶 harness 的回合邊界與寫入行為，並把結論記下來。`;
}

/** 合成回合的助理文字（與使用者文字合計遠超過 40 字元門檻）。 */
export function turnAssistant(token) {
  return `${token} 的助理回覆：已確認快照水位線、去重鍵與寫入流程都照規格運作，下一步補上更多測試。`;
}

/** 從 digest prompt 取回本回合 token（沒有就給固定字串）。 */
export function tokenFromPrompt(prompt) {
  const match = /TURN-[A-Z0-9]+(?:-[A-Z0-9]+)*/.exec(prompt);
  return match === null ? "TURN-UNKNOWN-00" : match[0];
}

function turnNumber(token) {
  const match = /-(\d+)$/.exec(token);
  return match === null ? 0 : Number(match[1]);
}

/**
 * 預設 canned 回應：合法的 digest JSON。
 *
 * - `turn` 一定帶 token，讓報告與伺服器查詢能對回回合。
 * - 每 3 回合附一則原子記憶，`quote` 直接用 token（一定出現在本回合原文）。
 */
export function cannedTurnResponse(prompt) {
  const token = tokenFromPrompt(prompt);
  const n = turnNumber(token);
  const kind = n % 6 === 0 ? "pitfall" : n % 3 === 0 ? "decision" : "fact";
  const items =
    n > 0 && n % 3 === 0
      ? [{ content: `ITEM-${token} 已確認的原子記憶：本輪結論可以繼續，無未解問題。`, kind, quote: token }]
      : [];
  return {
    text: JSON.stringify({
      turn: `${token} 回合紀錄：本輪討論 harness 的回合邊界與寫入流程，結論是快照水位線正確，下一步補測試。`,
      items,
    }),
  };
}

/** 空結果（模型認為這回合沒有可記的內容）。 */
export function cannedEmptyResponse() {
  return { text: JSON.stringify({ turn: "", items: [] }) };
}

/** 模型回了非 JSON 的說明文字。 */
export function cannedBadJsonResponse() {
  return { text: "這一輪沒有結構化資料，只是一段說明文字。" };
}

/** 固定成功 JSON（用於冪等測試；不含原子記憶，寫入張數可預期）。 */
export function cannedFixedTurnResponse(token) {
  return { text: JSON.stringify({ turn: `${token} 回合紀錄：固定內容，用於冪等測試。`, items: [] }) };
}

/** 取事件中實際注入的 `<memory-context>` 區塊（沒有回空字串）。 */
export function injectedBlock(event) {
  for (const message of event.messages ?? []) {
    if (!Array.isArray(message?.content)) continue;
    for (const part of message.content) {
      if (typeof part?.text === "string" && part.text.includes("<memory-context")) return part.text;
    }
  }
  for (const part of event.system ?? []) {
    if (typeof part?.text === "string" && part.text.includes("<memory-context")) return part.text;
  }
  return "";
}

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/* ------------------------------------------------------------------ *
 * 宿主
 * ------------------------------------------------------------------ */

/**
 * 建立一個假宿主實例，並用它啟動真正的 `createMemoryRuntime()`。
 *
 * @param {object} input
 * @param {string} input.name 實例名稱（只用在報告與 log 檔名）。
 * @param {string} input.directory 這個實例的 location 目錄（函式內會 realpath）。
 * @param {boolean} [input.chat] 是否為 OpenChamber 聊天 session 目錄。
 * @param {string} input.baseUrl 真 server 的 URL。
 * @param {string} input.token 真 server 的 token。
 * @param {object} [input.settings] 合併進 plugin options 的設定。
 * @param {string} input.logFile digest.log 路徑。
 * @param {string} input.home 假家目錄（避免讀到使用者狀態）。
 * @param {Function} [input.canned] canned 回應（讀 prompt，回 `{text}`）。
 * @param {number} [input.delayMs] 模型延遲（毫秒）。
 * @param {"ok"|"missing"} [input.modelList] `ctx.model.list()` 的行為。
 * @param {string|null} [input.sessionGetDirectory] 覆寫 `ctx.session.get` 的目錄。
 * @param {string|null} [input.parentID] 有值代表 subagent session。
 * @param {"none"|"other-location"|"model-missing"} [input.fault] 全域負向對照。
 * @param {boolean} [input.ignoreFault] 忽略全域負向對照（負向自我檢查用）。
 * @param {"search-503"|"search-timeout"|"digest-write-500"|null} [input.fetchFault] 個別 HTTP 故障。
 * @param {number} [input.digestTimeoutMs] 覆寫 digest 的模型／寫入 timeout（測試用）。
 */
export async function createHost(input) {
  const { name, baseUrl, token, logFile, home } = input;
  const directory = await fs.realpath(input.directory);
  const settings = input.settings ?? {};
  const canned = input.canned ?? cannedTurnResponse;
  const delayMs = input.delayMs ?? 0;
  const ignoreFault = input.ignoreFault === true;
  const fault = ignoreFault ? "none" : (input.fault ?? "none");
  const modelListMode =
    input.modelList === "missing" || fault === "model-missing" ? "missing" : "ok";
  const wrongDirectory =
    input.sessionGetDirectory ??
    (fault === "other-location"
      ? path.join(path.dirname(directory), `${path.basename(directory)}-not-this-location`)
      : null);
  const fetchFault = input.fetchFault ?? null;

  const messages = new Map();
  const counters = new Map();
  const snapshots = [];
  const logs = [];
  const posts = [];
  const modelCalls = [];
  const synthetic = [];
  const commands = new Map();
  const storage = memoryStorage();
  const feed = new EventFeed();
  const rawFetch = globalThis.fetch;

  let modelListCalls = 0;
  let modelMatched = false;
  let writeAttempts = 0;
  let contextHook = null;
  let cleanup;
  let recallSequence = 0;

  const fetchImpl = async (request, init = {}) => {
    const url = String(request);
    const method = (init.method ?? "GET").toUpperCase();
    if (method === "POST" && url.endsWith("/memories")) {
      let body = {};
      try {
        body = JSON.parse(String(init.body ?? "{}"));
      } catch {
        body = {};
      }
      const isDigest = typeof body.agent === "string" && body.agent.startsWith("opencode-plugin");
      posts.push({ body, isDigest, at: Date.now() });
      if (isDigest) writeAttempts += 1;
      if (fetchFault === "digest-write-500" && isDigest) {
        return jsonResponse({ error: { message: "synthetic write failure" } }, 500);
      }
    }
    if (method === "POST" && url.endsWith("/memories/search")) {
      if (fetchFault === "search-503") {
        return jsonResponse({ error: { message: "synthetic search failure" } }, 503);
      }
      if (fetchFault === "search-timeout") {
        // 故意拖超過外掛的 150ms timeout；abort 由呼叫端負責。
        await sleep(700, init.signal);
      }
    }
    return rawFetch(request, init);
  };

  const ctx = {
    app: { version: "2.1.1-fake" },
    options: { ...settings, baseUrl, token },
    location: input.chat === true
      ? { directory }
      : { directory, project: { canonical: directory, directory } },
    session: {
      hook: async (hookName, callback) => {
        if (hookName !== "context") throw new Error(`不支援的 hook：${hookName}`);
        contextHook = callback;
        return { dispose: async () => undefined };
      },
      synthetic: async (payload) => {
        synthetic.push(payload);
        return {};
      },
      context: async ({ sessionID }) => {
        const snapshot = structuredClone(messages.get(sessionID) ?? []);
        snapshots.push(snapshot.map((message) => message?.id ?? null));
        return snapshot;
      },
      get: async () => ({
        location: { directory: wrongDirectory ?? directory },
        ...(typeof input.parentID === "string" && input.parentID !== ""
          ? { parentID: input.parentID }
          : {}),
      }),
    },
    command: {
      transform: async (callback) => {
        callback({
          add: (definition) => {
            commands.set(definition.name, definition);
          },
        });
        return { dispose: async () => undefined };
      },
    },
    generate: {
      text: async (payload, options = {}) => {
        const callIndex = modelCalls.length;
        modelCalls.push({ callIndex, prompt: payload.prompt, model: payload.model ?? null, at: Date.now() });
        if (delayMs > 0) await sleep(delayMs, options.signal);
        const output = await canned(payload.prompt, { callIndex, signal: options.signal });
        return { text: typeof output?.text === "string" ? output.text : "" };
      },
    },
    model: {
      list: async () => {
        modelListCalls += 1;
        const data = modelListMode === "ok" ? [MODEL_ENTRY] : [];
        modelMatched = data.some(
          (entry) => entry.providerID === DIGEST_PROVIDER && entry.id === DIGEST_MODEL_ID,
        );
        return { location: { directory }, data };
      },
    },
    storage,
    event: { subscribe: () => feed.stream() },
  };

  const { createMemoryRuntime } = await loadRuntime();
  cleanup = await createMemoryRuntime(ctx, {
    env: {},
    platform: process.platform,
    home,
    log: (line) => logs.push(line),
    fetchImpl,
    readFileImpl: async () => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
    connectionWaitMs: 200,
    digestLogFile: logFile,
    ...(input.digestTimeoutMs === undefined ? {} : { digestTimeoutMs: input.digestTimeoutMs }),
  });

  const host = {
    name,
    directory,
    ctx,
    settings,
    logs,
    posts,
    modelCalls,
    synthetic,
    commands,
    storage,
    cleanup,
    get modelListCalls() {
      return modelListCalls;
    },
    get modelMatched() {
      return modelMatched;
    },
    get writeAttempts() {
      return writeAttempts;
    },
    get modelCallCount() {
      return modelCalls.length;
    },
    pushTurn(sessionID, userText, assistantText) {
      const index = (counters.get(sessionID) ?? 0) + 1;
      counters.set(sessionID, index);
      // 訊息 id 刻意不含 sessionID：報告引用 sourceMessage 時不會帶出 session 識別。
      const userID = `u-${index}`;
      const assistantID = `a-${index}`;
      host.appendMessage(sessionID, userMessage(userID, userText));
      host.appendMessage(sessionID, assistantMessage(assistantID, assistantText));
      return { userID, assistantID };
    },
    appendMessage(sessionID, message) {
      const list = messages.get(sessionID) ?? [];
      list.push(message);
      messages.set(sessionID, list);
      return list;
    },
    messagesFor(sessionID) {
      return messages.get(sessionID) ?? [];
    },
    /** 等這次事件真的被處理（快照被讀走）；模型不可用等早退情況最多等 300ms。 */
    async waitForSnapshot(before, timeoutMs = 300) {
      const started = Date.now();
      while (snapshots.length <= before && Date.now() - started < timeoutMs) await tick(5);
      return snapshots.length > before;
    },
    /** 只推事件，不等 digest 完成（用來製造「事件之後才追加訊息」）。 */
    async dispatch(sessionID) {
      const before = snapshots.length;
      feed.push(succeededEvent(sessionID, feed.sequence++));
      await host.waitForSnapshot(before);
    },
    /** 推事件並等這個實例所有排隊中的 digest 結束。 */
    async settle(sessionID) {
      const before = snapshots.length;
      feed.push(succeededEvent(sessionID, feed.sequence++));
      await host.waitForSnapshot(before);
      await cleanup.awaitIdle?.();
      await tick(5);
    },
    /** 呼叫真正註冊的 context hook（召回注入走正式流程）。 */
    async recall({ sessionID, text, kind = "primary" }) {
      if (contextHook === null) throw new Error("context hook 尚未註冊");
      recallSequence += 1;
      const event = {
        sessionID,
        kind,
        messages: [userMessage(`r-${sessionID}-${recallSequence}`, text)],
        system: [],
      };
      await contextHook(event);
      return event;
    },
    /** 等背景連線解析完成（options 來源不需要 /health，但仍是非同步）。 */
    async waitConnected() {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (logs.some((line) => line.includes('"event":"connection"'))) return true;
        await tick(10);
      }
      return false;
    },
    async waitIdle() {
      await cleanup.awaitIdle?.();
      await tick(5);
    },
    /** 解析過濾後的結構化 log（`[mnemoshelf] {...}`）。 */
    logPayloads(eventName) {
      const entries = [];
      for (const line of logs) {
        const match = /^\[mnemoshelf\] (\{.*\})$/.exec(line);
        if (match === null) continue;
        try {
          const payload = JSON.parse(match[1]);
          if (eventName === undefined || payload.event === eventName) entries.push(payload);
        } catch {
          // 非 JSON 的 log 不列入（產品碼目前只輸出結構化 log）。
        }
      }
      return entries;
    },
    async readDigestLines() {
      try {
        const text = await fs.readFile(logFile, "utf8");
        return text.split(/\r?\n/).filter((line) => line !== "");
      } catch {
        return [];
      }
    },
    async close() {
      feed.close();
      try {
        await cleanup();
      } catch {
        // 收尾失敗不影響報告。
      }
    },
  };

  await host.waitConnected();
  return host;
}
