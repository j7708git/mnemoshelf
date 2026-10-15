/**
 * 對 Core REST API 的存取層：token 保存與帶標頭的請求。
 *
 * token 決策：
 * - 使用者貼上一次，存 `sessionStorage`（只活到分頁關閉，不落地到磁碟）；
 * - 每請求帶 `Authorization: Bearer <token>`；
 * - **token 絕不進 URL、絕不經 `VITE_*` 環境變數**（`VITE_*` 會被 build 期內嵌進 bundle）。
 *
 * 收到 401 一律清除 token，並以 `window` 全域事件（`UNAUTHORIZED_EVENT`）通知整個 UI
 * 回到貼 token 的畫面（各面板不必各自處理 401）。
 */

/** sessionStorage 的 key。 */
const TOKEN_KEY = "mnemoshelf.token";

/** 401 時派送的全域事件名稱；`App.tsx` 監聽後切回貼 token 畫面。 */
export const UNAUTHORIZED_EVENT = "mnemoshelf:unauthorized";

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
 * 401 → 清除 token、派送 `UNAUTHORIZED_EVENT` 並丟 `UnauthorizedApiError`；
 * 連線失敗 → 丟 `NetworkError`。其餘狀態碼原樣回傳，由呼叫端決定訊息。
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
    // 通知整個 UI 回到貼 token 畫面；呼叫端各自的錯誤處理不需要再管 401。
    if (typeof window !== "undefined") {
      window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    }
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
  state: "idle" | "running" | "completed" | "failed" | "cancelled";
  progress: {
    processed: number;
    total: number;
    skippedUnchanged: number;
    skipped: number;
    failed: number;
    processedChunks: number;
    estimatedChunks: number;
  } | null;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  error: { name: string; message: string } | null;
  result: {
    total: number;
    processed: number;
    skippedUnchanged: number;
    removedFiles: number;
    failedFiles: { relPath: string; reason: string }[];
  } | null;
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

/**
 * 取消進行中的索引（`POST /roots/:id/index/cancel`）。
 *
 * 沒有進行中的索引時伺服器回 404，這裡不視為錯誤（冪等：目的已達成）；
 * 其餘失敗照常丟錯。實際狀態仍以 `getIndexStatus` 為準。
 */
export async function cancelIndex(rootId: number): Promise<void> {
  const response = await apiFetch(`/roots/${rootId}/index/cancel`, { method: "POST" });
  if (response.ok || response.status === 404) return;
  throw new Error(await readErrorMessage(response, "取消索引失敗"));
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

// ---------------------------------------------------------------------------
// M3 收尾：統一搜尋、記憶管理（列表／釘選／編輯／刪除／來源）
// ---------------------------------------------------------------------------

/** 記憶的種類（與 Core 契約一致）。 */
export type MemoryKind = "fact" | "decision" | "pitfall" | "preference";

/** 記憶的作用範圍（與 Core 契約一致）。 */
export type MemoryScope = "global" | "project" | "agent";

/** `GET /memories` 回傳的記憶（欄位以 Core 契約為準）。 */
export interface Memory {
  id: number;
  content: string;
  kind: MemoryKind;
  scope: MemoryScope;
  project: string | null;
  /** 寫入這筆記憶的 agent 標識（來源）。 */
  agent: string;
  /** 取代了哪一筆記憶（編輯流程會產生新版本並標記取代舊版）。 */
  supersedes: number | null;
  /** 是否釘選（釘選者在清單優先顯示）。 */
  pinned: boolean;
  createdAt: string;
  deletedAt: string | null;
}

/** 搜尋模式（與 Core 契約一致）；UI 預設 `hybrid`（含記憶命中）。 */
export const SEARCH_MODES = ["vector", "hybrid", "keyword"] as const;
export type SearchMode = (typeof SEARCH_MODES)[number];

/** 檔案片段命中。 */
export interface ChunkSearchHit {
  type: "chunk";
  key: string;
  rank: number;
  score: number;
  rootId: number;
  relPath: string;
  seq: number;
  kind: EntryKind;
  text: string | null;
  textTruncated: boolean;
}

/** 記憶命中。 */
export interface MemorySearchHit {
  type: "memory";
  key: string;
  rank: number;
  score: number;
  id: number;
  kind: MemoryKind;
  scope: MemoryScope;
  project: string | null;
  agent: string;
  text: string;
  textTruncated: boolean;
}

export type SearchHit = ChunkSearchHit | MemorySearchHit;

/** `POST /search` 的回應。 */
export interface SearchResult {
  mode: SearchMode;
  k: number;
  hits: SearchHit[];
}

/** 統一搜尋；`mode` 由呼叫端明確帶入（UI 預設 hybrid）。 */
export async function search(input: {
  query: string;
  mode: SearchMode;
  rootIds?: number[];
  k?: number;
}): Promise<SearchResult> {
  const response = await apiFetch("/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw new Error(await readErrorMessage(response, "搜尋失敗"));
  return (await response.json()) as SearchResult;
}

/** 列出未刪除的記憶（由新到舊；pinned 由呼叫端另行排序）。 */
export async function listMemories(): Promise<Memory[]> {
  const response = await apiFetch("/memories");
  if (!response.ok) throw new Error(await readErrorMessage(response, "讀取記憶清單失敗"));
  const body = (await response.json()) as { memories?: unknown };
  if (!Array.isArray(body.memories)) throw new Error("伺服器回應格式不正確");
  return body.memories as Memory[];
}

/**
 * 新增記憶。
 *
 * `supersedes` 帶入被編輯記憶的 id 時，會建立新版本並把舊版標記軟刪除
 * （Core 的 supersedes 語意），這就是 UI 的「編輯」流程。
 */
export async function addMemory(input: {
  content: string;
  agent: string;
  kind?: MemoryKind;
  scope?: MemoryScope;
  project?: string | null;
  supersedes?: number | null;
}): Promise<Memory> {
  const response = await apiFetch("/memories", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw new Error(await readErrorMessage(response, "儲存記憶失敗"));
  return (await response.json()) as Memory;
}

/** 設定／取消釘選（冪等）；回傳更新後的記憶。 */
export async function pinMemory(id: number, pinned: boolean): Promise<Memory> {
  const response = await apiFetch(`/memories/${id}/pin`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pinned }),
  });
  if (!response.ok) throw new Error(await readErrorMessage(response, "更新釘選狀態失敗"));
  return (await response.json()) as Memory;
}

/** 軟刪除記憶。 */
export async function deleteMemory(id: number): Promise<void> {
  const response = await apiFetch(`/memories/${id}`, { method: "DELETE" });
  if (!response.ok) throw new Error(await readErrorMessage(response, "刪除記憶失敗"));
}

// ---------------------------------------------------------------------------
// 除錯資訊匯出（`GET /diagnostics`）
// ---------------------------------------------------------------------------

/** `GET /diagnostics` 的應用與環境資訊（欄位以 server 契約為準）。 */
export interface DiagnosticsAppInfo {
  name: string;
  version: string;
  node: string;
  platform: string;
  arch: string;
}

/** 一個 root 的檔案統計；缺的欄位為 `null`（例如只有索引結果時）。 */
export interface DiagnosticsFileStats {
  totalFiles: number;
  totalBytes: number | null;
  byKind: Record<string, { count: number; bytes: number }> | null;
  skippedByReason: Record<string, number>;
  estimatedChunks: number | null;
}

/** 一個 root 最近一次索引結果的摘要（本行程；服務重啟後為 null）。 */
export interface DiagnosticsIndexSummary {
  state: "idle" | "running" | "completed" | "failed" | "cancelled";
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  total: number | null;
  processed: number | null;
  skippedUnchanged: number | null;
  skippedFiles: number;
  failedFiles: number;
  failedByReason: Record<string, number>;
}

/** 一個 root 的診斷資訊（路徑的家目錄前綴已遮罩成 `~`）。 */
export interface DiagnosticsRoot {
  id: number;
  path: string;
  mode: "browse" | "index";
  modalities: string[];
  include: string[];
  exclude: string[];
  respectGitignore: boolean;
  createdAt: string;
  stats: DiagnosticsFileStats | null;
  statsSource: "preview" | "index" | null;
  statsUnavailable: boolean;
  lastIndex: DiagnosticsIndexSummary | null;
}

/** `GET /diagnostics` 的回應。 */
export interface DiagnosticsResponse {
  generatedAt: string;
  app: DiagnosticsAppInfo;
  embedder: { id: string; dim: number; capabilities: Record<string, boolean> };
  roots: DiagnosticsRoot[];
  indexing: { rootId: number; startedAt: string | null }[];
}

/** 取得診斷資訊（`GET /diagnostics`）。 */
export async function fetchDiagnostics(): Promise<DiagnosticsResponse> {
  const response = await apiFetch("/diagnostics");
  if (!response.ok) throw new Error(await readErrorMessage(response, "讀取診斷資訊失敗"));
  return (await response.json()) as DiagnosticsResponse;
}

/**
 * 診斷檔的檔名：`mnemoshelf-diagnostics-<版本>-<YYYYMMDD>.json`。
 *
 * 版本來自伺服器回報的 app 版本；日期取 `generatedAt`（無法解析時標 `unknown-date`）。
 */
export function diagnosticsFilename(version: string, generatedAt: string): string {
  const date = new Date(generatedAt);
  const stamp = Number.isNaN(date.getTime())
    ? "unknown-date"
    : `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}`;
  const safeVersion = version.replace(/[^0-9A-Za-z._-]/g, "_");
  return `mnemoshelf-diagnostics-${safeVersion}-${stamp}.json`;
}

/**
 * 匯出診斷資訊：取得 JSON 後以 Blob＋`<a download>` 觸發下載（與圖片 fetch 模式一致）。
 *
 * 回傳實際使用的檔名，讓 UI 能顯示「已匯出 …」。
 */
export async function downloadDiagnostics(): Promise<{ filename: string }> {
  const diagnostics = await fetchDiagnostics();
  const json = `${JSON.stringify(diagnostics, null, 2)}\n`;
  const filename = diagnosticsFilename(diagnostics.app.version, diagnostics.generatedAt);
  const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    // 讓瀏覽器有時間讀取 blob 之後再釋放。
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return { filename };
}
