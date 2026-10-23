/**
 * 矩陣評估的模型來源與 transport（**eval 專屬**，不是產品設定格式）。
 *
 * 兩種 transport 都是在模擬「宿主怎麼把 prompt 送到模型」：
 * - `openai`：`POST {baseUrl}/chat/completions`，`temperature: 0`、帶 `max_tokens`。
 * - `opencode`：`POST {serverUrl}/api/experimental/generate`，body 只有 `prompt` 與
 *   `{ providerID, id }`；憑證是 OpenCode server 自己的 Basic 認證，模型 key 不進 eval。
 *
 * 安全邊界：
 * - 憑證只從環境變數讀，**不寫進檔案、不進報告、不放進錯誤訊息**。
 * - 付費模型必須顯式 `--allow-paid` 才會被呼叫。
 * - 所有呼叫共用一個 `budget`；超過 `--max-calls` 立刻標記並中止（backstop）。
 */
import { promises as fs } from "node:fs";

import { ModelSelectionError } from "./models.mjs";

export class MatrixBudgetExceeded extends Error {
  constructor(limit) {
    super(`模型呼叫次數超過上限（--max-calls ${limit}）；已中止。`);
    this.name = "MatrixBudgetExceeded";
    this.code = "max-calls";
  }
}

export class MatrixTransportError extends Error {
  constructor(errorClass, message) {
    super(message);
    this.name = "MatrixTransportError";
    this.errorClass = errorClass;
  }
}

const TRANSPORTS = new Set(["openai", "opencode"]);

function asString(value) {
  return typeof value === "string" ? value : null;
}

/** 讀 matrix-models.json 並驗證形狀（錯誤直接指出檔案）。 */
export async function loadMatrixCatalog(file) {
  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    throw new ModelSelectionError(`讀不到模型清單 ${file}：${error?.message ?? error}`, "bad-matrix-catalog");
  }
  if (parsed === null || typeof parsed !== "object" || !Array.isArray(parsed.models)) {
    throw new ModelSelectionError(`${file} 格式不符（缺 models 陣列）`, "bad-matrix-catalog");
  }
  const problems = [];
  for (const entry of parsed.models) {
    if (entry === null || typeof entry !== "object") {
      problems.push("models 內有非物件項目");
      continue;
    }
    if (!asString(entry.id)) problems.push("有模型缺少 id");
    if (!TRANSPORTS.has(entry.transport)) problems.push(`${entry.id ?? "?"}：transport 只能是 openai／opencode`);
    if (!asString(entry.digestModel)) problems.push(`${entry.id ?? "?"}：缺少 digestModel`);
    if (!Number.isFinite(entry.timeoutMs) || entry.timeoutMs <= 0) {
      problems.push(`${entry.id ?? "?"}：timeoutMs 必須是正數`);
    }
    if (entry.transport === "openai") {
      if (!asString(entry.apiKeyEnv)) problems.push(`${entry.id ?? "?"}：openai transport 需要 apiKeyEnv`);
      if (!asString(entry.baseUrl) && !asString(entry.baseUrlEnv)) {
        problems.push(`${entry.id ?? "?"}：openai transport 需要 baseUrl 或 baseUrlEnv`);
      }
      if (!asString(entry.model)) problems.push(`${entry.id ?? "?"}：缺少 model（送到端點的模型 id）`);
    }
    if (entry.transport === "opencode") {
      if (!asString(entry.providerID) || !asString(entry.modelID)) {
        problems.push(`${entry.id ?? "?"}：opencode transport 需要 providerID 與 modelID`);
      }
      if (!asString(entry.serverUrlEnv) || !asString(entry.passwordEnv)) {
        problems.push(`${entry.id ?? "?"}：opencode transport 需要 serverUrlEnv 與 passwordEnv`);
      }
    }
  }
  if (problems.length > 0) {
    throw new ModelSelectionError(`${file} 驗證失敗：\n- ${problems.join("\n- ")}`, "bad-matrix-catalog");
  }
  return parsed;
}

/**
 * 選模型：`all`（預設）或逗號分隔的 id 清單。
 *
 * @param {object} catalog loadMatrixCatalog() 的結果
 * @param {string|null} spec
 */
export function selectMatrixModels(catalog, spec) {
  const models = catalog.models.filter((entry) => entry !== null && typeof entry === "object");
  const wanted = spec === null || spec === undefined || spec === "" || spec === "all"
    ? null
    : spec.split(",").map((value) => value.trim()).filter((value) => value !== "");
  if (wanted === null) return models;
  const selected = [];
  for (const id of wanted) {
    const found = models.find((entry) => entry.id === id);
    if (found === undefined) {
      throw new ModelSelectionError(
        `matrix-models.json 沒有模型：${id}（可用：${models.map((entry) => entry.id).join("、")}）`,
        "model-not-found",
      );
    }
    if (!selected.includes(found)) selected.push(found);
  }
  if (selected.length === 0) {
    throw new ModelSelectionError("沒有選到任何模型（--models）", "no-model");
  }
  return selected;
}

/** 只記變數名稱與是否有值，**不記值**。 */
function envState(names, env) {
  return names.map((name) => ({ name, present: typeof env[name] === "string" && env[name].trim() !== "" }));
}

/**
 * 解析單一模型的可執行條件（純函式，不發請求）。
 *
 * @returns {{
 *   ready: boolean,
 *   reasons: string[],
 *   env: Array<{name: string, present: boolean}>,
 *   connection: { url?: string, username?: string, password?: string, baseUrl?: string, apiKey?: string } | null,
 * }}
 */
export function resolveModelConfig(entry, { env = process.env, allowPaid = false } = {}) {
  const reasons = [];
  const names = [];
  const required = [];
  if (entry.transport === "openai") {
    if (typeof entry.baseUrlEnv === "string") required.push(entry.baseUrlEnv);
    required.push(entry.apiKeyEnv);
  } else {
    required.push(entry.serverUrlEnv, entry.passwordEnv);
  }
  names.push(...required);
  if (typeof entry.usernameEnv === "string") names.push(entry.usernameEnv);
  const states = envState(names, env);
  const missing = required.filter((name) => !states.find((state) => state.name === name)?.present);

  if (missing.length > 0) reasons.push(`缺少環境變數 ${missing.join("、")}`);
  if (entry.paid === true && allowPaid !== true) reasons.push("付費模型需要 --allow-paid 才會呼叫");
  if (entry.enabled === false) reasons.push("模型在 matrix-models.json 標示為停用");

  if (reasons.length > 0) return { ready: false, reasons, env: states, connection: null };

  if (entry.transport === "openai") {
    return {
      ready: true,
      reasons: [],
      env: states,
      connection: {
        baseUrl: typeof entry.baseUrl === "string" ? entry.baseUrl : env[entry.baseUrlEnv],
        apiKey: env[entry.apiKeyEnv],
      },
    };
  }
  const username =
    (typeof entry.usernameEnv === "string" && typeof env[entry.usernameEnv] === "string" && env[entry.usernameEnv] !== ""
      ? env[entry.usernameEnv]
      : entry.username) ?? "opencode";
  return {
    ready: true,
    reasons: [],
    env: states,
    connection: {
      url: env[entry.serverUrlEnv],
      username,
      password: env[entry.passwordEnv],
    },
  };
}

function trimUrl(url) {
  return String(url).replace(/\/+$/, "");
}

function shortMessage(value, limit = 160) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

async function readJsonBody(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/** 一次 OpenAI 相容 chat completion。 */
async function callOpenAi(entry, connection, prompt, signal) {
  const response = await fetch(`${trimUrl(connection.baseUrl)}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${connection.apiKey}`,
    },
    body: JSON.stringify({
      model: entry.model,
      temperature: entry.temperature ?? 0,
      max_tokens: entry.maxTokens ?? 1024,
      messages: [{ role: "user", content: prompt }],
    }),
    signal,
  });
  const body = await readJsonBody(response);
  if (!response.ok) {
    const detail = typeof body?.error?.message === "string" ? `（${shortMessage(body.error.message)}）` : "";
    throw new MatrixTransportError(
      response.status === 401 || response.status === 403
        ? `auth-${response.status}`
        : response.status === 429
          ? "rate-limit"
          : `http-${response.status}`,
      `模型端點回應 HTTP ${response.status}${detail}`,
    );
  }
  const content = body?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.trim() === "") {
    throw new MatrixTransportError("empty-text", "模型回應沒有文字內容");
  }
  const usage = body?.usage === undefined || body.usage === null
    ? null
    : {
        promptTokens: body.usage.prompt_tokens ?? null,
        completionTokens: body.usage.completion_tokens ?? null,
        totalTokens: body.usage.total_tokens ?? null,
      };
  return { text: content, usage };
}

/** 一次 OpenCode server 的 generate。 */
async function callOpenCode(entry, connection, prompt, signal) {
  const response = await fetch(`${trimUrl(connection.url)}/api/experimental/generate`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Basic ${Buffer.from(`${connection.username}:${connection.password}`, "utf8").toString("base64")}`,
    },
    body: JSON.stringify({ prompt, model: { providerID: entry.providerID, id: entry.modelID } }),
    signal,
  });
  const body = await readJsonBody(response);
  if (!response.ok) {
    const tag = typeof body?._tag === "string" ? body._tag : null;
    const message = typeof body?.message === "string" ? shortMessage(body.message) : null;
    const detail = tag === null && message === null ? "" : `（${[tag, message].filter(Boolean).join(": ")}）`;
    const errorClass =
      response.status === 401 || response.status === 403
        ? `auth-${response.status}`
        : response.status === 503
          ? "service-unavailable"
          : response.status === 400
            ? "bad-request"
            : `http-${response.status}`;
    throw new MatrixTransportError(errorClass, `OpenCode generate 回應 HTTP ${response.status}${detail}`);
  }
  const text = body?.data?.text;
  if (typeof text !== "string" || text.trim() === "") {
    throw new MatrixTransportError("empty-text", "OpenCode generate 回應沒有 data.text");
  }
  // 這個端點沒有 usage 欄位；不要臆測 token。
  return { text, usage: null };
}

function classifyThrown(error, abortedByHost) {
  if (error instanceof MatrixTransportError) return error.errorClass;
  if (error?.name === "TimeoutError") return "timeout";
  if (error?.name === "AbortError") return abortedByHost ? "aborted" : "timeout";
  if (error instanceof MatrixBudgetExceeded) return "max-calls";
  if (error?.name === "TypeError") return "network";
  return "unknown";
}

/**
 * 建立矩陣用的模型 runner。
 *
 * 回傳物件刻意與 L3 `createModelRunner()` 的介面相容（`call()`／`calls`／`callCount`），
 * 另外提供 `attempts`（含失敗的嘗試）與 `errorCounts` 給矩陣報告用。
 *
 * @param {object} entry matrix-models.json 的模型項
 * @param {object} input
 * @param {{limit: number, used: number, exceeded: boolean}} input.budget 跨模型的呼叫預算
 * @param {object} input.connection resolveModelConfig() 的 connection
 */
export function createMatrixRunner(entry, { budget, connection }) {
  const info = {
    id: entry.id,
    label: entry.label ?? entry.id,
    transport: entry.transport,
    digestModel: entry.digestModel,
    timeoutMs: entry.timeoutMs,
    paid: entry.paid === true,
    model: entry.transport === "openai" ? entry.model : `${entry.providerID}/${entry.modelID}`,
  };
  const calls = [];
  const attempts = [];
  const errorCounts = {};

  async function invoke(prompt, meta = {}) {
    budget.used += 1;
    if (budget.used > budget.limit) {
      budget.exceeded = true;
      throw new MatrixBudgetExceeded(budget.limit);
    }
    const started = performance.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), entry.timeoutMs);
    const hostSignal = meta.signal;
    let abortedByHost = false;
    const onHostAbort = () => {
      abortedByHost = true;
      controller.abort();
    };
    if (hostSignal !== undefined) {
      if (hostSignal.aborted === true) onHostAbort();
      else hostSignal.addEventListener("abort", onHostAbort, { once: true });
    }
    try {
      const result =
        entry.transport === "openai"
          ? await callOpenAi(entry, connection, prompt, controller.signal)
          : await callOpenCode(entry, connection, prompt, controller.signal);
      const latencyMs = performance.now() - started;
      const record = { ok: true, latencyMs, errorClass: null, text: result.text, usage: result.usage ?? null };
      attempts.push(record);
      calls.push({ text: result.text, usage: result.usage ?? null, latencyMs });
      return { text: result.text, usage: result.usage ?? null, latencyMs };
    } catch (error) {
      const latencyMs = performance.now() - started;
      const errorClass = classifyThrown(error, abortedByHost);
      errorCounts[errorClass] = (errorCounts[errorClass] ?? 0) + 1;
      attempts.push({ ok: false, latencyMs, errorClass, text: "", usage: null });
      if (error instanceof MatrixBudgetExceeded) throw error;
      // 錯誤訊息已在上面的 transport 內截短；這裡再壓一次，避免任何長字串落地。
      throw new MatrixTransportError(errorClass, shortMessage(error?.message ?? "unknown"));
    } finally {
      clearTimeout(timer);
      if (hostSignal !== undefined) hostSignal.removeEventListener?.("abort", onHostAbort);
    }
  }

  return {
    info,
    get calls() {
      return calls;
    },
    get attempts() {
      return attempts;
    },
    get callCount() {
      return attempts.length;
    },
    get errorCounts() {
      return { ...errorCounts };
    },
    get budgetExceeded() {
      return budget.exceeded;
    },
    async call(prompt, meta) {
      return invoke(prompt, meta);
    },
  };
}
