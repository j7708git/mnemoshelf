/**
 * 對 Core REST API 的存取層：token 保存與帶標頭的請求。
 *
 * token 決策（見 `project-notes/projects/mnemoshelf/research/web-ui-stack.md` §Q5）：
 * - 使用者貼上一次，存 `sessionStorage`（只活到分頁關閉，不落地到磁碟）；
 * - 每請求帶 `Authorization: Bearer <token>`；
 * - **token 絕不進 URL、絕不經 `VITE_*` 環境變數**（`VITE_*` 會被 build 期內嵌進 bundle）。
 *
 * 收到 401 一律清除 token 並讓呼叫端回到貼 token 的畫面。
 */

/** sessionStorage 的 key。 */
const TOKEN_KEY = "mnemoshelf.token";

/** 讀出目前的 token；沒有時回傳 null。 */
export function getToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    // 隱私模式等情況下 sessionStorage 可能不可用；視為沒有 token。
    return null;
  }
}

/** 寫入 token（只留在這個分頁）。 */
export function setToken(token: string): void {
  sessionStorage.setItem(TOKEN_KEY, token);
}

/** 清除 token。 */
export function clearToken(): void {
  sessionStorage.removeItem(TOKEN_KEY);
}

/** 伺服器回 401：token 缺失或不正確。 */
export class UnauthorizedApiError extends Error {
  constructor(message = "token 不正確或已失效") {
    super(message);
    this.name = "UnauthorizedApiError";
  }
}

/** 連不上本機服務（服務沒開、網路中斷等）。 */
export class NetworkError extends Error {
  constructor(message = "無法連線到本機服務，請確認 Mnemoshelf 服務正在執行。") {
    super(message);
    this.name = "NetworkError";
  }
}

/** `GET /roots` 回傳的 root（欄位以 Core 契約為準）。 */
export interface Root {
  id: number;
  path: string;
  mode: "browse" | "index";
  modalities: string[];
  include: string[];
  exclude: string[];
  respectGitignore: boolean;
  watch: boolean;
  createdAt: string;
}

/**
 * 帶 token 呼叫 API。
 *
 * 401 → 清除 token 並丟 `UnauthorizedApiError`；連線失敗 → 丟 `NetworkError`。
 * 其餘狀態碼原樣回傳，由呼叫端決定訊息。
 */
export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = getToken();
  const headers = new Headers(init.headers);
  if (token !== null) headers.set("authorization", `Bearer ${token}`);

  let response: Response;
  try {
    response = await fetch(path, { ...init, headers });
  } catch {
    throw new NetworkError();
  }

  if (response.status === 401) {
    clearToken();
    throw new UnauthorizedApiError();
  }
  return response;
}

/** 讀取 roots 清單。 */
export async function listRoots(): Promise<Root[]> {
  const response = await apiFetch("/roots");
  if (!response.ok) {
    throw new Error(`讀取資料夾清單失敗（HTTP ${response.status}）`);
  }
  const body = (await response.json()) as { roots?: unknown };
  if (!Array.isArray(body.roots)) {
    throw new Error("伺服器回應格式不正確");
  }
  return body.roots as Root[];
}
