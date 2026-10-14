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

// ---------------------------------------------------------------------------
// M3 檔案總管：加入資料夾引導、目錄樹、檔案預覽、索引进度
// ---------------------------------------------------------------------------

/** 目錄子項的種類。 */
export type EntryKind = "dir" | "text" | "code" | "image" | "audio" | "video" | "binary";

/** `GET /roots/:id/entries` 回傳的一個子項。 */
export interface DirEntry {
  name: string;
  /** 相對 root 的路徑（`/` 分隔）。 */
  path: string;
  kind: EntryKind;
  size: number | null;
  mimeType: string | null;
}

/** `POST /roots/:id/preview` 的統計（欄位以 Core 契約為準）。 */
export interface RootPreview {
  totalFiles: number;
  totalBytes: number;
  byKind: Record<string, { count: number; bytes: number }>;
  skipped: { relPath: string; reason: string }[];
  estimatedChunks: number;
  estimatedSeconds: number;
}

/** 文字預覽的回應主體。 */
export interface TextPreviewBody {
  kind: "text";
  path: string;
  size: number;
  truncated: boolean;
  content: string;
}

/** 索引进度輪詢的狀態。 */
export interface IndexStatus {
  rootId: number;
  state: "idle" | "running" | "completed" | "failed";
  progress: { processed: number; total: number; skippedUnchanged: number } | null;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  error: { name: string; message: string } | null;
  result: { total: number; processed: number; skippedUnchanged: number; removedFiles: number } | null;
}

/** 讀出伺服器錯誤回應的中文訊息；格式不符時回退成帶狀態碼的訊息。 */
export async function readErrorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: unknown } };
    if (typeof body?.error?.message === "string" && body.error.message.trim() !== "") {
      return body.error.message;
    }
  } catch {
    // 非 JSON 回應（例如代理層的錯誤頁）：用回退訊息。
  }
  return `${fallback}（HTTP ${response.status}）`;
}

/** 加入一個資料夾（root）。錯誤時丟出帶中文訊息的 `Error`。 */
export async function addRoot(input: { path: string; mode?: "browse" | "index" }): Promise<Root> {
  const response = await apiFetch("/roots", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "index", ...input }),
  });
  if (!response.ok) throw new Error(await readErrorMessage(response, "加入資料夾失敗"));
  return (await response.json()) as Root;
}

/** 移除一個資料夾；`deleteData` 為 true 時一併刪除索引資料。 */
export async function removeRoot(rootId: number, deleteData = false): Promise<void> {
  const response = await apiFetch(`/roots/${rootId}${deleteData ? "?deleteData=1" : ""}`, { method: "DELETE" });
  if (!response.ok) throw new Error(await readErrorMessage(response, "移除資料夾失敗"));
}

/** 對已加入的 root 做乾跑統計（不寫入）。 */
export async function previewRoot(rootId: number): Promise<RootPreview> {
  const response = await apiFetch(`/roots/${rootId}/preview`, { method: "POST" });
  if (!response.ok) throw new Error(await readErrorMessage(response, "讀取預覽統計失敗"));
  return (await response.json()) as RootPreview;
}

/** 觸發索引。**會等到索引結束才回應**，呼叫端通常不 await 它，改為輪詢狀態。 */
export async function startIndex(rootId: number): Promise<void> {
  const response = await apiFetch(`/roots/${rootId}/index`, { method: "POST" });
  if (!response.ok) throw new Error(await readErrorMessage(response, "索引失敗"));
}

/** 輪詢索引进度。 */
export async function getIndexStatus(rootId: number): Promise<IndexStatus> {
  const response = await apiFetch(`/roots/${rootId}/index/status`);
  if (!response.ok) throw new Error(await readErrorMessage(response, "讀取索引进度失敗"));
  return (await response.json()) as IndexStatus;
}

/** 列出某個相對路徑下的目錄子項（`path` 為空字串代表 root 本身）。 */
export async function listEntries(rootId: number, dirPath: string): Promise<DirEntry[]> {
  const response = await apiFetch(`/roots/${rootId}/entries?path=${encodeURIComponent(dirPath)}`);
  if (!response.ok) throw new Error(await readErrorMessage(response, "讀取目錄失敗"));
  const body = (await response.json()) as { entries?: unknown };
  if (!Array.isArray(body.entries)) throw new Error("伺服器回應格式不正確");
  return body.entries as DirEntry[];
}

/**
 * 讀取文字預覽（`GET /roots/:id/file`）。
 *
 * 二進位／媒體檔會被伺服器以 415 拒絕，訊息已是中文。
 */
export async function readTextPreview(rootId: number, filePath: string): Promise<TextPreviewBody> {
  const response = await apiFetch(`/roots/${rootId}/file?path=${encodeURIComponent(filePath)}`);
  if (!response.ok) throw new Error(await readErrorMessage(response, "讀取檔案失敗"));
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    throw new Error("這個檔案不是文字檔，無法以文字預覽。");
  }
  return (await response.json()) as TextPreviewBody;
}

/**
 * 取得圖片位元組並包成 blob URL。
 *
 * `<img src>` 帶不了 `Authorization`，所以一律 `fetch`＋`URL.createObjectURL`；
 * **呼叫端負責在不再使用時 `URL.revokeObjectURL`**。
 * `variant` 為 `thumb` 時走縮圖端點，`file` 時取原始位元組。
 */
export async function fetchImageBlobUrl(
  rootId: number,
  variant: "thumb" | "file",
  filePath: string,
): Promise<string> {
  const response = await apiFetch(`/roots/${rootId}/${variant}?path=${encodeURIComponent(filePath)}`);
  if (!response.ok) throw new Error(await readErrorMessage(response, "讀取圖片失敗"));
  return URL.createObjectURL(await response.blob());
}
