/**
 * S6 spike：OpenCode HTTP server 的 `/api/experimental/generate` 轉介路徑。
 *
 * 這條路的用途是「eval 把 prompt 交給本機 OpenCode server，由它用自己持有的
 * provider 憑證呼叫模型」——`opencode-go` 的 key 不進 eval、不進報告。
 *
 * 邊界：
 * - 這裡只放**認證方式與 schema**，不存任何密碼／token；密碼一律由呼叫端從環境變數帶入。
 * - 靜態結論是 2026-10-23 在本機實測所得；每次執行仍會用 `probeOpenCodeEndpoint()`
 *   做一次唯讀探測（GET /openapi.json，不呼叫模型），把即時結果寫進報告。
 */

/** spike 當時的靜態結論（不含憑證；port 是本機當時實測的那一個）。 */
export const SPIKE_FINDINGS = {
  checkedAt: "2026-10-23",
  endpoint: "POST /api/experimental/generate",
  operationId: "experimental.generate.text",
  endpointExists: true,
  auth: {
    scheme: "HTTP Basic",
    username: "opencode",
    usernameEnv: "MNEMOSHELF_EVAL_OPENCODE_USERNAME",
    passwordEnv: "MNEMOSHELF_EVAL_OPENCODE_PASSWORD",
    passwordSource: "OpenCode server 行程自己的 OPENCODE_SERVER_PASSWORD（由 server 持有）",
    unauthenticatedStatus: 401,
    unauthenticatedBody: '{"_tag":"UnauthorizedError","message":"Authentication required"}',
  },
  request: {
    contentType: "application/json",
    body: {
      prompt: "string（必填）",
      model: { providerID: "string", id: "string", variant: "string（可選）" },
    },
    notes: [
      "model 省略時用 server 的預設模型。",
      "缺 prompt → 400 InvalidRequestError（Missing key at [\"prompt\"]）。",
      "多餘欄位實測被忽略（openapi 文件標 additionalProperties:false，但 server 沒有拒絕）。",
    ],
  },
  response: {
    successStatus: 200,
    body: { data: { text: "string" } },
    notes: ["沒有 usage／token 欄位 → 報告的 token 與成本一律 N/A，不臆測。"],
  },
  minimalExchange: {
    request: {
      prompt: "只回覆兩個字：ok",
      model: { providerID: "opencode-go", id: "deepseek-v4.1-flash" },
    },
    response: { data: { text: "ok" } },
  },
  errorCodes: [
    { status: 401, tag: "UnauthorizedError", when: "沒有 Basic 認證或密碼不符" },
    { status: 400, tag: "InvalidRequestError", when: "缺 prompt／模型不可用（Model unavailable: provider/id）" },
    { status: 404, tag: "LocationNotFoundError", when: "location 不存在（本路徑用不到）" },
    { status: 503, tag: "ServiceUnavailableError", when: "server 尚未就緒或服務不可用" },
  ],
  latency: {
    openapiProbeMs: 107,
    minimalGenerateMs: [2008, 3108],
    minimalGenerateNote: "prompt 只要求回「ok」；含模型端網路時間，不含 digest 的長 prompt。",
  },
  portsTried: [
    { port: 37121, app: 200, generateWithoutAuth: 401, generateWithAuth: 200, usable: true },
    { port: 44359, app: 200, generateWithoutAuth: 401, generateWithAuth: 200, usable: true },
    { port: 45999, app: 200, generateWithoutAuth: 401, generateWithAuth: 401, usable: false },
  ],
  chosenPort: 37121,
  conclusion:
    "端點存在且可用：Basic 認證（username=opencode、password=server 的 OPENCODE_SERVER_PASSWORD）後 POST 回 200 {data:{text}}；" +
    "失敗處理依使用者裁決，spike 不可用時該模型一律 NOT RUN，不改走 OpenRouter。",
};

/** 把 URL 正規化（去掉結尾斜線）。 */
function trimUrl(url) {
  return String(url).replace(/\/+$/, "");
}

/**
 * 唯讀探測 OpenCode server：確認端點存在、認證可用與延遲。
 *
 * 只打 `GET {url}/openapi.json`（不呼叫模型、不產生費用）。
 *
 * @param {{ url: string, username: string, password: string, timeoutMs?: number }} input
 * @returns {Promise<{
 *   reachable: boolean,
 *   authOk: boolean,
 *   status: number|null,
 *   latencyMs: number|null,
 *   endpointExists: boolean|null,
 *   errorClass: string|null,
 *   message: string|null,
 * }>}
 */
export async function probeOpenCodeEndpoint({ url, username, password, timeoutMs = 10000 }) {
  const started = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${trimUrl(url)}/openapi.json`, {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`,
      },
      signal: controller.signal,
    });
    const latencyMs = Math.round(performance.now() - started);
    if (response.status !== 200) {
      return {
        reachable: true,
        authOk: false,
        status: response.status,
        latencyMs,
        endpointExists: null,
        errorClass: response.status === 401 ? "auth-401" : `http-${response.status}`,
        message: `GET /openapi.json 回應 HTTP ${response.status}`,
      };
    }
    const body = await response.json().catch(() => null);
    const paths = body !== null && typeof body === "object" && typeof body.paths === "object" ? body.paths : {};
    return {
      reachable: true,
      authOk: true,
      status: 200,
      latencyMs,
      endpointExists: Object.prototype.hasOwnProperty.call(paths, "/api/experimental/generate"),
      errorClass: null,
      message: null,
    };
  } catch (error) {
    const aborted = error?.name === "AbortError" || error?.name === "TimeoutError";
    return {
      reachable: false,
      authOk: false,
      status: null,
      latencyMs: null,
      endpointExists: null,
      errorClass: aborted ? "timeout" : "network",
      message: aborted ? `探測逾時（${timeoutMs}ms）` : "連不上 OpenCode server",
    };
  } finally {
    clearTimeout(timer);
  }
}
