/**
 * 模型來源：預設 canned 基線（完全離線、零成本、確定性）；可選 OpenAI 相容端點。
 *
 * 安全邊界：
 * - 憑證只從環境變數讀，**不寫進任何檔案**、不進報告。
 * - `paid: true` 的模型必須顯式 `--allow-paid` 才會被選用。
 * - 每次呼叫都受 `maxCalls` 保護，超過就中止整場評估（不會默默把錢燒完）。
 */
import { promises as fs } from "node:fs";
import { cannedBaselineResponse } from "./canned.mjs";

export class ModelSelectionError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "ModelSelectionError";
    this.code = code;
  }
}

export class MaxCallsExceeded extends Error {
  constructor(limit) {
    super(`模型呼叫次數超過上限（--max-calls ${limit}）；已中止。`);
    this.name = "MaxCallsExceeded";
    this.code = "max-calls";
  }
}

export async function loadModelCatalog(file) {
  const text = await fs.readFile(file, "utf8");
  const parsed = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || !Array.isArray(parsed.models)) {
    throw new ModelSelectionError(`${file} 格式不符（缺 models 陣列）`, "bad-model-catalog");
  }
  return parsed;
}

/** 選第一個 enabled 的模型；`--model` 可指定 id。 */
export function selectModel(catalog, requestedId) {
  const models = catalog.models.filter((entry) => entry !== null && typeof entry === "object");
  if (typeof requestedId === "string" && requestedId !== "") {
    const found = models.find((entry) => entry.id === requestedId);
    if (found === undefined) throw new ModelSelectionError(`models.json 沒有模型：${requestedId}`, "model-not-found");
    if (found.enabled === false) throw new ModelSelectionError(`模型已停用：${requestedId}`, "model-disabled");
    return found;
  }
  const first = models.find((entry) => entry.enabled !== false);
  if (first === undefined) throw new ModelSelectionError("models.json 沒有可執行的模型", "no-model");
  return first;
}

function describeEntry(entry) {
  return {
    id: entry.id,
    kind: entry.kind === "openai-compatible" ? "openai-compatible" : "canned",
    paid: entry.paid === true,
    model: typeof entry.model === "string" ? entry.model : null,
  };
}

/**
 * 建立模型 runner。
 *
 * @param {object} entry models.json 的模型項
 * @param {object} options
 * @param {number} options.maxCalls 呼叫上限
 * @param {boolean} options.allowPaid 是否允許付費模型
 * @param {NodeJS.ProcessEnv} [options.env]
 */
export function createModelRunner(entry, { maxCalls, allowPaid, env = process.env }) {
  const info = describeEntry(entry);
  if (info.paid && allowPaid !== true) {
    throw new ModelSelectionError(
      `模型 ${entry.id} 標示為付費；需要顯式 --allow-paid 才會呼叫。`,
      "paid-model-guard",
    );
  }
  if (info.kind === "openai-compatible") {
    const baseUrl = typeof entry.baseUrlEnv === "string" ? env[entry.baseUrlEnv] : undefined;
    const apiKey = typeof entry.apiKeyEnv === "string" ? env[entry.apiKeyEnv] : undefined;
    if (typeof baseUrl !== "string" || baseUrl.trim() === "" || typeof apiKey !== "string" || apiKey.trim() === "") {
      throw new ModelSelectionError(
        `模型 ${entry.id} 需要環境變數 ${entry.baseUrlEnv ?? "?"}／${entry.apiKeyEnv ?? "?"}；未設定，NOT RUN。`,
        "missing-credentials",
      );
    }
  }

  const calls = [];
  let count = 0;

  async function callCanned(prompt) {
    const started = performance.now();
    const output = cannedBaselineResponse(prompt);
    return { text: output.text, usage: null, latencyMs: performance.now() - started };
  }

  async function callOpenAiCompatible(prompt, { signal } = {}) {
    const baseUrl = String(env[entry.baseUrlEnv]).replace(/\/+$/, "");
    const apiKey = String(env[entry.apiKeyEnv]);
    const started = performance.now();
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: entry.model,
        temperature: entry.temperature ?? 0,
        messages: [{ role: "user", content: prompt }],
      }),
      ...(signal === undefined ? {} : { signal }),
    });
    const latencyMs = performance.now() - started;
    if (!response.ok) {
      throw new Error(`模型端點回應 HTTP ${response.status}`);
    }
    const body = await response.json();
    const content = body?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.trim() === "") {
      throw new Error("模型回應沒有文字內容");
    }
    const usage =
      body?.usage === undefined || body.usage === null
        ? null
        : {
            promptTokens: body.usage.prompt_tokens ?? null,
            completionTokens: body.usage.completion_tokens ?? null,
            totalTokens: body.usage.total_tokens ?? null,
          };
    return { text: content, usage, latencyMs };
  }

  return {
    info,
    get callCount() {
      return count;
    },
    get calls() {
      return calls;
    },
    /**
     * 呼叫模型。回傳 `{ text, usage, latencyMs }`；`usage` 沒有就是 `null`（報告標 N/A）。
     */
    async call(prompt, meta = {}) {
      count += 1;
      if (count > maxCalls) throw new MaxCallsExceeded(maxCalls);
      const result =
        info.kind === "canned"
          ? await callCanned(prompt)
          : await callOpenAiCompatible(prompt, meta);
      calls.push({ text: result.text, usage: result.usage ?? null, latencyMs: result.latencyMs });
      return result;
    },
  };
}
