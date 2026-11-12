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
/** 只保留活動播放器的撤銷憑證；登出與元件卸載後立即移除。 */
const mediaSessionTokens = new Map<string, string | null>();

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
  for (const [url, token] of mediaSessionTokens) {
    void fetch(url, { method: "DELETE", credentials: "same-origin", keepalive: true,
      headers: token === null ? {} : { authorization: `Bearer ${token}` },
    }).catch(() => undefined);
  }
  mediaSessionTokens.clear();
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

export class MemoryPolicyUnavailableError extends Error {
  constructor() {
    super("本機服務需要升級才能使用記憶遮罩設定。");
    this.name = "MemoryPolicyUnavailableError";
  }
}

export interface MemoryPolicy {
  maskSecrets: boolean;
  version: number;
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
  /**
   * 是否允許 agent 搜尋這個 root 的檔案片段（MCP `search` 的預設範圍）。
   *
   * 預設 `false`；舊版服務沒有這個欄位時 UI 一律視為未分享。
   * 這是分享意圖／防誤用，不是多租戶硬隔離（單一 token 仍是本機 owner 全權）。
   */
  allowAgentSearch: boolean;
  /**
   * 這個 root 的通用單檔大小上限（bytes；**不套用影片**）。
   *
   * - 有值：per-root 設定（1 B–16 GiB）；
   * - **缺省**：未設定，沿用服務層預設 10 MiB。契約明定舊資料列不得補值，
   *   因此未設定時這個鍵**不存在**（不是 null）。
   */
  maxFileBytes?: number;
  /**
   * 這個 root 的影片單檔大小上限（bytes；只套用影片）。
   *
   * - 有值：per-root 設定（1–16 GiB）；
   * - **缺省**：未設定，沿用服務層預設（`videoCapability.maxFileBytes`，產品預設 512 MiB）。
   *   契約明定舊資料列不得補 512 MiB，因此未設定時這個鍵**不存在**（不是 null）。
   *
   * 舊版服務沒有這個欄位，UI 一律視為未設定。
   */
  videoMaxFileBytes?: number;
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

async function requestMemoryPolicy(init?: RequestInit): Promise<MemoryPolicy> {
  const headers = new Headers(init?.headers);
  headers.set("accept", "application/json");
  const response = await apiFetch("/memory-policy", { ...init, headers, cache: "no-store" });
  if (response.status === 404) throw new MemoryPolicyUnavailableError();
  if (!response.ok) throw new Error(`本機服務回應 HTTP ${response.status}。`);
  const body = (await response.json().catch(() => null)) as Partial<MemoryPolicy> | null;
  if (body === null || typeof body.maskSecrets !== "boolean" || typeof body.version !== "number" ||
    !Number.isSafeInteger(body.version) || body.version < 1) {
    throw new Error("本機服務回傳的記憶遮罩設定格式不正確。");
  }
  return { maskSecrets: body.maskSecrets, version: body.version };
}

export function fetchMemoryPolicy(): Promise<MemoryPolicy> {
  return requestMemoryPolicy();
}

export function updateMemoryPolicy(maskSecrets: boolean): Promise<MemoryPolicy> {
  return requestMemoryPolicy({
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ maskSecrets }),
  });
}

/** 影片能力三態的形狀檢查（舊版服務沒有這個欄位，不能假設一定存在）。 */
export function isVideoCapability(value: unknown): value is VideoCapability {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.available === "boolean" &&
    (record.state === "disabled" || record.state === "unavailable" || record.state === "available") &&
    (record.reason === null || typeof record.reason === "string") &&
    typeof record.embedderVideo === "boolean" &&
    typeof record.maxFileBytes === "number" &&
    typeof record.durationLimitSeconds === "number"
  );
}

/** `GET /roots` 的回應：清單＋服務層的影片能力（additive `video` 欄位）。 */
export interface RootsResponse {
  roots: Root[];
  /** 舊版服務沒有這個欄位時為 `null`（UI 不可據此宣告影片可用）。 */
  video: VideoCapability | null;
}

/**
 * 讀取 roots 清單與影片能力（一次請求）。
 *
 * `video` 是**服務層**能力（decoder 是否可用），與每個 root 自己的 `modalities` 無關；
 * UI 用它決定「含影片」開關能不能開、以及不能開的原因。
 */
export async function fetchRoots(): Promise<RootsResponse> {
  const response = await apiFetch("/roots");
  if (!response.ok) {
    throw new Error(`讀取資料夾清單失敗（HTTP ${response.status}）`);
  }
  const body = (await response.json()) as { roots?: unknown; video?: unknown };
  if (!Array.isArray(body.roots)) {
    throw new Error("伺服器回應格式不正確");
  }
  return { roots: body.roots as Root[], video: isVideoCapability(body.video) ? body.video : null };
}

/** 讀取 roots 清單（只要清單的呼叫端用；需要影片能力請用 `fetchRoots`）。 */
export async function listRoots(): Promise<Root[]> {
  return (await fetchRoots()).roots;
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

/**
 * 影片能力不可用的固定原因碼（與 server `VideoCapabilityReason` 一致）。
 *
 * 刻意只有穩定標籤、不含路徑或 stderr：UI 依此顯示「為什麼影片不能用」。
 */
export type VideoCapabilityReason =
  | "missing-ffmpeg"
  | "missing-ffprobe"
  | "ffmpeg-failed"
  | "ffprobe-failed"
  | "embedder-video-unsupported";

/**
 * 影片能力三態（`GET /roots` 的 `video`、preview 的 `videoCapability`、diagnostics 的 `video`）。
 *
 * - `disabled`：服務沒有設定解碼器（產品預設）；
 * - `unavailable`：已設定但不可用（binary 缺失／損毀，或 embedder 不支援影片）；
 * - `available`：可預覽、索引與播放。
 *
 * UI 據此在**使用者打開開關前**停用並顯示原因，而不是讓使用者開了才在索引時全數失敗。
 */
export interface VideoCapability {
  available: boolean;
  state: "disabled" | "unavailable" | "available";
  reason: VideoCapabilityReason | null;
  embedderVideo: boolean;
  /** 影片單檔大小上限（bytes；掃描、有界快照與播放端點共用同一個值）。 */
  maxFileBytes: number;
  /** 影片時長上限（秒；600）。 */
  durationLimitSeconds: number;
  ffmpegVersion: string | null;
  ffprobeVersion: string | null;
}

/**
 * 影片候選的預覽語意（B3a）：**不讀媒體、不啟動 probe、不由壓縮大小換算時長**。
 *
 * 所有段數／秒數欄位都是**上界**，不是實際值；實際時長與片段數要等確認索引後 probe 才知道。
 */
export interface VideoPreviewEstimate {
  /** 候選影片檔數（掃描納入者；`video-too-large` 等跳過的不計）。 */
  files: number;
  /** 預覽不讀媒體，時長一律未知。 */
  durationKnown: false;
  /** 是否計入影片音軌（`video` 與 `audio` 都開啟才計入）。 */
  includesAudioTrack: boolean;
  /** 每檔畫面片段數上界（600 秒 ÷ 4 秒 = 150）。 */
  visualSegmentsPerFileMax: number;
  /** 每檔音軌片段數上界（600 秒 ÷ 10 秒 = 60）；未計入音軌時為 0。 */
  audioSegmentsPerFileMax: number;
  /** 全部候選片段數上界（**不是**實際片段數）。 */
  estimatedSegmentCountMax: number;
  /** 以片段上界推估的索引秒數上界（**不是**實際耗時、也不是影片時長）。 */
  estimatedSecondsMax: number;
}

/** `POST /roots/:id/preview` 的統計（欄位以 Core 契約為準）。 */
export interface RootPreview {
  totalFiles: number;
  totalBytes: number;
  byKind: Record<string, { count: number; bytes: number }>;
  skipped: { relPath: string; reason: string }[];
  estimatedChunks: number;
  estimatedSeconds: number;
  /**
   * 估時分解（文字與圖片分開；三者相加＝`estimatedSeconds`）。
   *
   * 舊版服務沒有這個欄位，因此標為可選：UI 缺值時只顯示總秒數。
   */
  estimated?: {
    textSeconds: number;
    imageSeconds: number;
    otherSeconds: number;
    seconds: number;
  };
  /**
   * 影片候選的預覽語意（B3a；預覽不讀媒體、不啟動 probe）。
   *
   * 沒有影片候選時為 `null`；**舊版服務沒有這個欄位**（此時 UI 視為沒有影片候選）。
   * 時長一律 `durationKnown: false`：不得由壓縮大小換算或顯示捏造的秒數。
   */
  video?: VideoPreviewEstimate | null;
  /**
   * 影片能力三態（C1 additive 欄位；與 `GET /roots` 的 `video` 同形狀）。
   *
   * 舊版服務沒有此欄位：UI 只能依候選數推測，不把它當成「已確認可用」。
   */
  videoCapability?: VideoCapability;
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
  /**
   * 單調遞增的輪次序號（伺服器每 `begin()` 加一）；`idle` 為 `null`。
   *
   * 用來分辨「本輪的終態」與「上一輪殘留的終態」：`POST /index` 還在路上時，
   * 第一次輪詢可能看到上一輪的 `completed`／`failed`／`cancelled`（見 `IndexPollGate`）。
   */
  runSeq: number | null;
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
    /**
     * 被跳過的檔案與固定原因（additive；舊版服務沒有這兩個欄位）。
     *
     * 影片的 probe 階段原因（時長／解析度／codec／音軌）會出現在這裡；
     * 掃描階段的原因（`video-too-large` 等）在 `scanSkippedFiles`。
     */
    skippedFiles?: { relPath: string; reason: string }[];
    scanSkippedFiles?: { relPath: string; reason: string }[];
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

/**
 * 加入一個資料夾（root）。錯誤時丟出帶中文訊息的 `Error`。
 *
 * `modalities` 省略時由服務端套預設（`text`／`code`）——**加入含照片的資料夾時必須明帶
 * `image`**，否則圖片會在掃描階段被記成 `modality-off` 跳過（見 UI 的「含圖片」勾選）。
 */
export async function addRoot(input: {
  path: string;
  mode?: "browse" | "index";
  modalities?: string[];
  /**
   * 通用單檔大小上限（bytes；1 B–16 GiB）。省略＝沿用服務預設 10 MiB。
   *
   * UI 以 MiB 輸入、換算成 bytes 後送出（見 `RootsList.tsx` 的 `parseMaxFileLimitMiB`）。
   */
  maxFileBytes?: number;
  /**
   * 影片單檔大小上限（bytes；1–16 GiB）。省略＝沿用服務預設。
   *
   * UI 以 MiB 輸入、換算成 bytes 後送出（見 `media.ts` 的 `parseVideoLimitMiB`）。
   */
  videoMaxFileBytes?: number;
  /** 是否允許 agent 搜尋；省略＝false（預設關閉）。 */
  allowAgentSearch?: boolean;
}): Promise<Root> {
  const response = await apiFetch("/roots", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "index", ...input }),
  });
  if (!response.ok) throw new Error(await readErrorMessage(response, "加入資料夾失敗"));
  return (await response.json()) as Root;
}

/**
 * 更新已加入 root 的可變設定（`PATCH /roots/:id`；目前只有 `modalities`）。
 *
 * **只改設定，不會自動重新索引**：新模態要等下一次索引才會生效，因此呼叫端要自己提示
 * 使用者「重新索引」。
 */
export async function updateRootModalities(rootId: number, modalities: string[]): Promise<Root> {
  const response = await apiFetch(`/roots/${rootId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ modalities }),
  });
  if (!response.ok) throw new Error(await readErrorMessage(response, "更新資料夾設定失敗"));
  return (await response.json()) as Root;
}

/** 影片單檔大小上限的契約上限（bytes；16 GiB）。 */
const VIDEO_MAX_FILE_BYTES_LIMIT = 16 * 1024 * 1024 * 1024;

/**
 * 更新單一 root 的影片單檔大小上限（`PATCH /roots/:id` 的 additive 欄位）。
 *
 * `videoMaxFileBytes` 是 **bytes**（1–16 GiB）；傳 `null` 表示**清除設定**、回到服務層預設
 * （Core 的 `RootPatch` 契約）。UI 的輸入單位是 MiB，由呼叫端先以 `parseVideoLimitMiB`
 * 驗證與換算。只改設定、不自動重新索引（與 modalities 相同）；影片模態未開啟時也可以設定。
 */
export async function updateRootVideoMaxFileBytes(rootId: number, videoMaxFileBytes: number | null): Promise<Root> {
  if (videoMaxFileBytes !== null) {
    if (!Number.isSafeInteger(videoMaxFileBytes) || videoMaxFileBytes < 1 || videoMaxFileBytes > VIDEO_MAX_FILE_BYTES_LIMIT) {
      throw new Error("影片單檔大小上限必須是 1 byte–16 GiB 的整數 bytes。");
    }
  }
  const response = await apiFetch(`/roots/${rootId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ videoMaxFileBytes }),
  });
  if (!response.ok) throw new Error(await readErrorMessage(response, "更新影片上限失敗"));
  return (await response.json()) as Root;
}

/** 通用單檔大小上限的契約上限（bytes；16 GiB）。 */
const MAX_FILE_BYTES_LIMIT = 16 * 1024 * 1024 * 1024;

/**
 * 更新單一 root 的**通用**單檔大小上限（`PATCH /roots/:id` 的 `maxFileBytes`）。
 *
 * `maxFileBytes` 是 **bytes**（1 B–16 GiB）；傳 `null` 表示**清除設定**、回到服務層預設
 * 10 MiB（Core 的 `RootPatch` 契約）。UI 的輸入單位是 MiB，由呼叫端先驗證與換算。
 * 只改設定、不自動重新索引；影片不套用這個上限。
 */
export async function updateRootMaxFileBytes(rootId: number, maxFileBytes: number | null): Promise<Root> {
  if (maxFileBytes !== null) {
    if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes < 1 || maxFileBytes > MAX_FILE_BYTES_LIMIT) {
      throw new Error("單檔大小上限必須是 1 byte–16 GiB 的整數 bytes。");
    }
  }
  const response = await apiFetch(`/roots/${rootId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ maxFileBytes }),
  });
  if (!response.ok) throw new Error(await readErrorMessage(response, "更新單檔上限失敗"));
  return (await response.json()) as Root;
}

/**
 * 更新單一 root 的「允許 Agent 搜尋此資料夾」開關（`PATCH /roots/:id` 的 `allowAgentSearch`）。
 *
 * 這是分享意圖／防誤用，不是多租戶硬隔離；只影響之後 agent 的搜尋範圍，不動既有索引，
 * 也不需要重新索引。
 */
export async function updateRootAgentSearch(rootId: number, allowAgentSearch: boolean): Promise<Root> {
  if (typeof allowAgentSearch !== "boolean") {
    throw new Error("allowAgentSearch 必須是布林值。");
  }
  const response = await apiFetch(`/roots/${rootId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ allowAgentSearch }),
  });
  if (!response.ok) throw new Error(await readErrorMessage(response, "更新 Agent 搜尋設定失敗"));
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

/**
 * 伺服器以非 2xx 狀態碼拒絕請求時丟出；`status` 保留原始 HTTP 狀態碼。
 *
 * 為什麼需要結構化錯誤：呼叫端有時要依狀態碼做不同處置，而不是只看訊息文字。
 * 例如 `POST /index` 的 **409**（單一工作模型下代表「同一 root 已有一輪索引在跑」）
 * 不是失敗，不該把流程轉成 `failed`（見 `AddRootFlow.beginIndex`）。
 */
export class HttpStatusError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpStatusError";
  }
}

/**
 * 這個錯誤是否代表「同一 root 已有進行中的索引」（HTTP 409）？
 *
 * 409 的語意不是失敗，而是「你要的那一輪**已經存在、正在跑**」。呼叫端的正確反應是
 * **改為追蹤那一輪**（以採納型 gate，見 `IndexPollGate` 與 `PollTrack`），而不是把它當成
 * 要忽略的舊輪、也不是把流程轉成 `failed`。
 */
export function isIndexAlreadyRunningError(error: unknown): boolean {
  return error instanceof HttpStatusError && error.status === 409;
}

/** 觸發索引。**會等到索引結束才回應**，呼叫端通常不 await 它，改為輪詢狀態。 */
export async function startIndex(rootId: number): Promise<void> {
  const response = await apiFetch(`/roots/${rootId}/index`, { method: "POST" });
  if (!response.ok) {
    throw new HttpStatusError(response.status, await readErrorMessage(response, "索引失敗"));
  }
}

/**
 * 取消進行中的索引（`POST /roots/:id/index/cancel`）。
 *
 * 回傳值區分兩種情況：
 * - `"cancelled"`：伺服器回 200，確實中止了一輪進行中的索引。
 * - `"not-running"`：伺服器回 404，代表**當下**沒有進行中的索引。這不是錯誤
 *   （冪等語意保留：目的可能已達成），但呼叫端不能就此當成「已取消」——
 *   `POST /index` 可能還在路上，索引隨後才啟動（見 `cancelIndexWithRetry`）。
 *
 * 其餘失敗照常丟錯。實際狀態仍以 `getIndexStatus` 為準。
 */
export async function cancelIndex(rootId: number): Promise<"cancelled" | "not-running"> {
  const response = await apiFetch(`/roots/${rootId}/index/cancel`, { method: "POST" });
  if (response.ok) return "cancelled";
  if (response.status === 404) return "not-running";
  throw new Error(await readErrorMessage(response, "取消索引失敗"));
}

/** 取消重試窗口的輪詢間隔（毫秒）。 */
export const CANCEL_RETRY_INTERVAL_MS = 800;
/**
 * 取消重試窗口的輪詢次數上限。
 *
 * 為什麼是 10 次 × 800ms ≈ 8 秒：`POST /index` 是**背景觸發**（呼叫端不 await），
 * 從按下「開始索引」到伺服器真的開始跑通常只差幾十毫秒；8 秒足以涵蓋本機服務的
 * 正常排程延遲與一次短暫的請求重送，又不會讓「取消中…」的按鈕卡住使用者太久。
 */
export const CANCEL_RETRY_MAX_TICKS = 10;

/** 取消請求的結果。 */
export type CancelRequestOutcome =
  /** 確實取消了一輪進行中的索引。 */
  | "cancelled"
  /** 窗口內沒能取消：任務已在終態，或這輪索引從未成功啟動。 */
  | "finished";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 要求取消索引，並處理「取消請求比索引註冊更早到達」的競態。
 *
 * 情境：UI 以 `void startIndex(rootId)` 觸發索引後**立即**顯示「取消索引」；使用者按下時，
 * `POST /index` 可能還沒被伺服器處理，`POST /cancel` 因此回 404（當下沒有進行中的索引），
 * 但索引隨後就啟動——若把 404 當成「已取消」，取消意圖會**靜默丟失**。
 *
 * 修法：404 時進入短重試窗口——每 `CANCEL_RETRY_INTERVAL_MS` 輪詢一次 `getIndexStatus`，
 * 最多 `CANCEL_RETRY_MAX_TICKS` 次：
 * - 看到本輪的 `running` → 再呼叫 `cancelIndex`；成功即回 `"cancelled"`。
 * - 看到**本輪**的終態（`completed`／`failed`／`cancelled`）→ 任務已結束，回 `"finished"`。
 * - 仍是 `idle`（索引尚未啟動）→ 繼續等，直到窗口結束。
 *
 * 「本輪」的判準用 `runSeq`：進入窗口前先取得當時的 `runSeq`（舊輪的值）。若看到的終態
 * 帶**相同**的 `runSeq`，那是上一輪的殘留（例如重新索引後立刻取消），不是本輪，繼續等。
 * 窗口用盡仍未觀察到本輪 → 回 `"finished"`（索引從未成功啟動，沒有可取消的對象），
 * 讓呼叫端離開取消流程、不會卡死。
 *
 * **取不到 baseline 的取捨（W4）**：baseline 是判斷「本輪是否已結束」的唯一依據，取得失敗時
 * **不能**把它當成 `null`——若舊輪 `runSeq=1`，`1 !== null` 會讓舊輪的終態被誤判成本輪結束，
 * 取消意圖在索引真正啟動前就丟失。這裡先重試一次；仍失敗才進入「未知 baseline」模式：
 * 不採信 `runSeq` 比對，改以「窗口內終態是否變化」判斷——第一次看到的終態先記下，若後續
 * 觀察到不同 `runSeq` 的終態（代表有一輪新的索引跑完）才回 `"finished"`；若整個窗口都停在
 * 同一個終態，視為舊輪殘留、等窗口用盡。代價是「索引在這輪窗口內跑完」時，最壞情況會多等
 * 到窗口結束才回 `"finished"`（不會誤丟取消意圖，只是慢一點收斂）。
 */
export async function cancelIndexWithRetry(rootId: number): Promise<CancelRequestOutcome> {
  // baseline 先取，失敗重試一次；兩次都失敗才走「未知 baseline」模式。
  let baselineKnown = false;
  let baselineRunSeq: number | null = null;
  for (let attempt = 0; attempt < 2 && !baselineKnown; attempt += 1) {
    try {
      baselineRunSeq = (await getIndexStatus(rootId)).runSeq;
      baselineKnown = true;
    } catch {
      // 讀取失敗：再試一次（第二次仍失敗則離開迴圈，`baselineKnown` 保持 false）。
    }
  }

  const first = await cancelIndex(rootId);
  if (first === "cancelled") return "cancelled";

  // 未知 baseline 模式下，記下第一次看到的終態 `runSeq`；它改變才代表本輪真的結束。
  let seenTerminalRunSeq: number | null | undefined;

  for (let tick = 0; tick < CANCEL_RETRY_MAX_TICKS; tick += 1) {
    await delay(CANCEL_RETRY_INTERVAL_MS);
    let status: IndexStatus;
    try {
      status = await getIndexStatus(rootId);
    } catch {
      // 讀取失敗：窗口內再試一次。
      continue;
    }
    if (status.state === "running") {
      const again = await cancelIndex(rootId);
      if (again === "cancelled") return "cancelled";
      continue;
    }
    if (!isTerminalIndexState(status.state)) continue; // idle：本輪可能還沒被伺服器接受。

    if (baselineKnown) {
      if (status.runSeq !== baselineRunSeq) {
        // 本輪已結束（完成／失敗／取消）：取消意圖已無作用對象。
        return "finished";
      }
      continue; // 上一輪殘留的終態：繼續等窗口。
    }

    // 未知 baseline：不採信 `runSeq` 比對，改看「終態是否在窗口內變化」。
    if (seenTerminalRunSeq === undefined) {
      seenTerminalRunSeq = status.runSeq;
      continue; // 第一次看到終態：可能是舊輪殘留，先觀察。
    }
    if (status.runSeq !== seenTerminalRunSeq) {
      // 終態的 `runSeq` 在窗口內改變 → 有一輪新的索引跑完 → 本輪已結束。
      return "finished";
    }
    // 仍是同一個終態：持續觀察，直到窗口用盡。
  }
  return "finished";
}

/** 是否為索引的終態（本輪不會再有變化）。 */
export function isTerminalIndexState(state: IndexStatus["state"]): boolean {
  return state === "completed" || state === "failed" || state === "cancelled";
}

/**
 * 輪詢停止的寬限**毫秒預算**（見 `IndexPollGate`）。
 *
 * 為什麼要有界：若 `POST /index` 根本失敗、或伺服器一直回**上一輪**的終態，輪詢就永遠
 * 觀察不到本輪而無限輪下去；寬限用盡就停止，讓 UI 收斂（不卡在「索引中」）。
 *
 * 為什麼用毫秒而非 tick 數：各流程的輪詢間隔不同（ExplorerPanel 1.5 秒、AddRootFlow
 * 0.8 秒），同一個「tick 數」在兩邊代表不同長度。改以共同的毫秒預算表達，由
 * `IndexPollGate` 依各流程傳入的間隔換算成 tick 數，兩邊的實際容忍時間才一致
 * （12 秒＝1.5 秒 × 8 tick＝0.8 秒 × 15 tick）。
 */
export const INDEX_POLL_GRACE_MS = 12000;

/** `IndexPollGate.observe` 的判定結果。 */
export type PollOutcome =
  /** 繼續輪詢（本輪還沒結束，或還沒被觀察到）。 */
  | { kind: "continue" }
  /** 本輪已終止；`state` 可信。 */
  | { kind: "terminal" }
  /** 寬限用盡仍沒看到本輪（POST 失敗或伺服器一直回舊輪終態）：停止輪詢。 */
  | { kind: "stalled" };

/**
 * 輪詢門控的 baseline：發起本輪索引**之前**的 `runSeq`。
 *
 * - `number`：已知舊輪的 `runSeq`。
 * - `null`：**確定**沒有舊輪（例如剛加入、尚未索引過的新 root；`idle` 的 `runSeq` 本就是 `null`）。
 * - `"unknown"`：`getIndexStatus` 取不到 baseline（瞬時失敗）。**不可**退化成 `null`：
 *   若舊輪 `runSeq=1`，`1 !== null` 會讓舊輪的終態被誤判成本輪結束而停止輪詢。此值進入
 *   「未知 baseline」模式（見 `IndexPollGate`）。
 */
export type PollBaseline = number | null | "unknown";

/**
 * 輪詢門控要追蹤哪一輪（`IndexPollGate` 的建構判準）。
 *
 * - `PollBaseline`（`number`／`null`／`"unknown"`）：發起**本輪之前**取得的舊輪 `runSeq`；
 *   gate 等一個「`runSeq` **不同於** baseline」的終態，即本輪結束（見 `PollBaseline`）。
 * - `{ adopt: number }`：**採納**某一輪——本輪就是該 `runSeq`（`POST /index` 回 409 時，
 *   他方／先行啟動的那一輪）；該輪的終態即結束（見 `IndexPollGate` 的採納模式）。
 *
 * 兩者是同一件事的兩面：baseline 模式「排除舊輪、等新輪」，採納模式「直接認領正在跑的那一輪」。
 */
export type PollTrack = PollBaseline | { adopt: number };

/** `PollTrack` 是否為採納模式（`PollBaseline` 中的 `null` 也是 object，故須一併排除）。 */
function isAdoptTrack(track: PollTrack): track is { adopt: number } {
  return typeof track === "object" && track !== null;
}

/**
 * 一輪索引的輪詢判準（修「重新索引時第一次輪詢看到上一輪終態而提早停止」的競態）。
 *
 * 問題：發起新一輪索引後立刻輪詢，此時 `POST /index` 可能還沒到伺服器，第一次輪詢會看到
 * **上一輪**的 `completed`／`failed`／`cancelled`；若據此停止輪詢，新一輪的進度與取消鈕
 * 就會整輪隱藏。
 *
 * 用法：發起新一輪前先取得當時的 `runSeq`（舊輪的值）建立此物件，並傳入該流程的輪詢間隔
 * （毫秒）；每次輪詢把結果交給 `observe()`：
 * - `state` 非終態（`idle`／`running`）→ 繼續輪（本輪可能還沒被觀察到）。
 * - 終態且 `runSeq !== baseline` → 本輪終止。
 * - 終態且 `runSeq === baseline` → 上一輪殘留，繼續輪；累計的殘留時間達
 *   `INDEX_POLL_GRACE_MS`（由 `pollIntervalMs` 換算成 tick 數）才回 `stalled`。
 *
 * **baseline 為 `"unknown"`（取不到）時**：不採信 `runSeq` 比對（沒有可信的舊值可比起），
 * 改以「本輪進展」為準：
 * - 第一次看到的終態先記下（可能是舊輪殘留），**不**據此停止；之後若一直看到**相同**
 *   `runSeq` 的終態，累計到寬限用盡才回 `stalled`。
 * - 觀察到 `running`，或看到**不同 `runSeq`** 的終態（代表有一輪新的索引跑起來／跑完），
 *   即視為本輪已有進展；此後的終態就是本輪終止，回 `terminal`。
 * 這個模式對「暫時取不到 baseline」已足夠：本輪真的啟動後一定會出現 `running` 或新終態，
 * 屆時就能正確收斂（見 `AddRootFlow`／`ExplorerPanel` 的 preflight）。
 *
 * **採納模式（`{ adopt: runSeq }`）**：`POST /index` 回 409 時的語意是「你要的那一輪已經存在、
 * 正在跑」——不是失敗，而是**改為追蹤那一輪**。此時 preflight 取到的 baseline 恰好就是他方
 * 先啟動的那一輪（`runSeq` 較新）；若仍以它為 baseline，gate 會把那一輪的**終態**當成「要忽略
 * 的舊輪殘留」而一路等到寬限 → 明明正常結束卻顯示 `stalled`。採納模式反過來認領它：
 * - 終態且 `runSeq === adopted` → 本輪結束（`terminal`）。
 * - 終態且 `runSeq > adopted`（採納後又跑了一輪更高的終態）→ 亦視為 `terminal`：我們要跟的那一輪
 *   已被覆蓋，顯示**最新**狀態即可，不必再等（取捨：不區分「採納輪自己的終態」與「更新的終態」，
 *   兩者對使用者都是「這輪已經結束、這是目前結果」）。
 * - 終態但 `runSeq < adopted`（理論上 `runSeq` 單調、不會回頭；防禦性處理）→ 尚未看到採納輪，
 *   累計寬限（與既有語意一致）。
 * - `running`／非終態 → `continue`；一直沒看到採納輪的任何活動也是寬限用盡才 `stalled`。
 */
export class IndexPollGate {
  private staleTicks = 0;
  /** 寬限 tick 數：`INDEX_POLL_GRACE_MS` 除以本流程輪詢間隔後無條件進位（至少 1）。 */
  private readonly graceTicks: number;
  /** unknown 模式下第一次看到的終態 `runSeq`；用來判斷之後是否出現了「新一輪」的終態。 */
  private seenTerminalRunSeq: number | null | undefined;
  /** unknown 模式下是否看過 `running`（有一輪真的在跑 → 其後的終態即本輪終止）。 */
  private sawRunning = false;

  constructor(
    private readonly track: PollTrack,
    pollIntervalMs: number,
  ) {
    this.graceTicks = Math.max(1, Math.ceil(INDEX_POLL_GRACE_MS / Math.max(1, pollIntervalMs)));
  }

  observe(status: Pick<IndexStatus, "state" | "runSeq">): PollOutcome {
    if (!isTerminalIndexState(status.state)) {
      // 非終態：本輪可能還沒被伺服器接受（idle），或正在跑（running）。繼續輪。
      if (status.state === "running") this.sawRunning = true;
      return { kind: "continue" };
    }

    if (isAdoptTrack(this.track)) {
      const adopted = this.track.adopt;
      // `runSeq >= adopted`：採納輪自己的終態（`===`），或採納後又有一輪更高的終態（`>`）——
      // 兩者都代表「這輪已經結束」，顯示最新狀態即可（見類別註解的取捨說明）。
      if (status.runSeq !== null && status.runSeq >= adopted) return { kind: "terminal" };
      // `runSeq < adopted`：採納輪之前的殘留終態，尚未看到採納輪 → 累計寬限。
    } else if (this.track === "unknown") {
      if (this.sawRunning) return { kind: "terminal" };
      if (this.seenTerminalRunSeq === undefined) {
        // 第一次看到終態：可能是舊輪殘留，先記下、不據此停止。
        this.seenTerminalRunSeq = status.runSeq;
      } else if (status.runSeq !== this.seenTerminalRunSeq) {
        // 終態的 `runSeq` 變了 → 有一輪新的索引跑完 → 本輪終止。
        return { kind: "terminal" };
      }
    } else if (status.runSeq !== this.track) {
      return { kind: "terminal" };
    }

    this.staleTicks += 1;
    return this.staleTicks >= this.graceTicks ? { kind: "stalled" } : { kind: "continue" };
  }
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

/** 音訊經授權端點取得；呼叫端負責釋放 blob URL。 */
export async function fetchAudioBlobUrl(rootId: number, filePath: string): Promise<string> {
  const response = await apiFetch(`/roots/${rootId}/file?path=${encodeURIComponent(filePath)}`);
  if (!response.ok) throw new Error(await readErrorMessage(response, "讀取音訊失敗"));
  if (!(response.headers.get("content-type") ?? "").startsWith("audio/wav")) {
    throw new Error("此檔案不是支援的 WAV 音訊。");
  }
  return URL.createObjectURL(await response.blob());
}

// ---------------------------------------------------------------------------
// 影片播放（`GET|HEAD /roots/:id/media?path=`；同源單一 Range）
// ---------------------------------------------------------------------------

/**
 * 影片播放端點的路徑（同源）。
 *
 * **token 不進 URL**：桌面版由 Electron main process 以 `webRequest` 對同源請求注入
 * `Authorization`。此為既有 Bearer 端點；播放器使用短效 session URL，支援 standalone。
 */
export function mediaUrl(rootId: number, relPath: string): string {
  return `/roots/${rootId}/media?path=${encodeURIComponent(relPath)}`;
}

/** 播放器只取得 locator；授權 secret 由瀏覽器保存於 HttpOnly cookie。 */
export interface MediaPlaybackSession { url: string; expiresAt: string }

export async function createMediaPlaybackSession(rootId: number, relPath: string, chunkId?: number): Promise<MediaPlaybackSession> {
  const token = getToken();
  const response = await apiFetch(`/roots/${rootId}/media-sessions`, {
    method: "POST", credentials: "same-origin", cache: "no-store",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ path: relPath, chunkId }),
  });
  if (!response.ok) throw new Error(mediaPlaybackErrorMessage(response.status, await readErrorMessage(response, "建立播放授權失敗")));
  const session = await response.json() as MediaPlaybackSession;
  if (!new RegExp(`^/roots/${rootId}/media-sessions/[0-9a-f-]{36}$`).test(session.url) || !Number.isFinite(Date.parse(session.expiresAt))) {
    throw new Error("播放授權回應不合法。");
  }
  mediaSessionTokens.set(session.url, token);
  return session;
}

/** 關閉預覽／換來源時撤銷；不讓短效授權繼續供新請求使用。 */
export async function revokeMediaPlaybackSession(session: MediaPlaybackSession): Promise<void> {
  const token = mediaSessionTokens.get(session.url) ?? getToken();
  mediaSessionTokens.delete(session.url);
  const response = await fetch(session.url, { method: "DELETE", credentials: "same-origin", keepalive: true,
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error("撤銷播放授權失敗。");
}

/** Session 的 401 是播放授權逾期，不應清掉全域 Bearer 登入。 */
export async function probeMediaPlaybackSession(session: MediaPlaybackSession): Promise<MediaProbeResult> {
  const response = await fetch(session.url, { method: "HEAD", credentials: "same-origin", cache: "no-store" });
  if (!response.ok) return { kind: "error", status: response.status, message: response.status === 401
    ? "播放授權已逾期或撤銷，請重新授權播放。"
    : mediaPlaybackErrorMessage(response.status, "無法播放這個影片。") };
  return { kind: "ok", contentLength: Number(response.headers.get("content-length")), acceptRanges: response.headers.get("accept-ranges") === "bytes" };
}

/**
 * 播放端點的 HTTP 錯誤 → 中文訊息（對應 server `media.ts` 的狀態碼語意）。
 *
 * `<video>` 的 `error` 事件拿不到 HTTP 狀態碼，因此播放失敗時用 `probeMedia` 的 HEAD 結果
 * 補上可讀原因（401 由 `apiFetch` 全域處理，不會走到這裡）。
 */
export function mediaPlaybackErrorMessage(status: number, fallbackMessage: string, maxFileBytes?: number): string {
  switch (status) {
    case 400:
      return "影片路徑不合法。";
    case 403:
      return "沒有權限讀取這個影片（不在已加入的資料夾內，或被黑名單排除）。";
    case 404:
      return "影片檔案不存在或已被移動；請重新整理目錄後再試。";
    case 409:
      return "影片來源已變更或原命中已失效；請重新索引並重新搜尋後播放。";
    case 413: {
      const limit = typeof maxFileBytes === "number" && Number.isFinite(maxFileBytes) && maxFileBytes > 0
        ? `（目前上限 ${Math.round(maxFileBytes / (1024 * 1024))} MiB）`
        : "";
      return `影片超過單檔大小上限${limit}，不支援播放。`;
    }
    case 415:
      return "這個檔案不是支援的 .mp4 影片（v1 只播放 MP4）。";
    case 416:
      return "播放器要求的位元組範圍無效（檔案可能已變更）；請重新載入。";
    default:
      return status >= 500 ? `本機服務發生錯誤（HTTP ${status}）。` : fallbackMessage;
  }
}

/** 播放前探測的結果（HEAD，不讀取 body）。 */
export type MediaProbeResult =
  | { kind: "ok"; contentLength: number | null; acceptRanges: boolean }
  | { kind: "error"; status: number; message: string };

/**
 * 以 HEAD 探測影片端點（授權請求；不讀取內容）。
 *
 * 用途：`<video>` 播放失敗時判斷是授權、root 守衛、大小上限、格式還是 Range 問題，
 * 讓錯誤訊息可讀而不是只說「無法播放」。
 */
export async function probeMedia(rootId: number, relPath: string): Promise<MediaProbeResult> {
  const response = await apiFetch(mediaUrl(rootId, relPath), { method: "HEAD", cache: "no-store" });
  if (!response.ok) {
    return {
      kind: "error",
      status: response.status,
      message: mediaPlaybackErrorMessage(
        response.status,
        await readErrorMessage(response, "無法播放這個影片"),
      ),
    };
  }
  const lengthHeader = response.headers.get("content-length");
  const parsedLength = lengthHeader === null ? Number.NaN : Number(lengthHeader);
  return {
    kind: "ok",
    contentLength: Number.isSafeInteger(parsedLength) && parsedLength >= 0 ? parsedLength : null,
    acceptRanges: response.headers.get("accept-ranges") === "bytes",
  };
}

// ---------------------------------------------------------------------------
// M3 收尾：統一搜尋、記憶管理（列表／釘選／編輯／刪除／來源）
// ---------------------------------------------------------------------------

/** 記憶的種類（與 Core 契約一致）。 */
export type MemoryKind = "fact" | "decision" | "pitfall" | "preference";

/** 記憶的作用範圍（與 Core 契約一致）。 */
export type MemoryScope = "global" | "project" | "agent";

export type MemorySourceRole = "user" | "assistant";

interface MemorySourceReference {
  sourceId?: number | null;
  messageIndex?: number | null;
  chunkIndex?: number | null;
  sourceStart?: number | null;
  sourceEnd?: number | null;
  chunkVersion?: string | null;
  sourceType?: "raw-turn" | "legacy-memory";
  role?: MemorySourceRole | null;
  occurredAt?: string | null;
  sourceTurn?: string | null;
  hasMore?: boolean;
}

/** `GET /memories` 回傳的記憶（欄位以 Core 契約為準）。 */
export interface Memory extends MemorySourceReference {
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
  /** 寫入這筆記憶的 session 識別（來源；未提供或舊資料為 null）。 */
  sourceSession: string | null;
  /** 寫入這筆記憶的訊息識別（來源；未提供或舊資料為 null）。 */
  sourceMessage: string | null;
  createdAt: string;
  deletedAt: string | null;
}

/** 搜尋模式（與 Core 契約一致）；UI 預設 `hybrid`（含記憶命中）。 */
export const SEARCH_MODES = ["vector", "hybrid", "keyword"] as const;
export type SearchMode = (typeof SEARCH_MODES)[number];

/** 時間片段的來源軌道（與 core `ChunkMedia.track` 一致）。 */
export type ChunkMediaTrack = "audio" | "video" | "video-audio";

/** 時間片段的來源容器（舊資料沒有；影片 v1 只有 `mp4`）。 */
export type ChunkMediaContainer = "wav" | "mp4";

/**
 * 搜尋命中的時間定位資訊（`Chunk.media`；見 `docs/storage-ports.md` §影片片段）。
 *
 * 「畫面」與「音軌」的差別看 `track`，**不是**看 `kind`：
 * - `track:"video"`：影片**畫面**片段（`kind:"video"`，`frameTimesSeconds` 必填）；
 * - `track:"video-audio"`：影片**所選音軌**片段（`kind:"audio"`，`streamIndex` 必填）；
 * - `track:"audio"`：獨立 WAV 音訊片段（舊資料只有這種形狀）。
 */
export interface ChunkMedia {
  startSeconds: number;
  endSeconds: number;
  track: ChunkMediaTrack;
  /** 來源容器；舊音訊資料沒有這個欄位。 */
  container?: ChunkMediaContainer;
  /** 影片所選音軌的 stream index（`track:"video-audio"` 必填）。 */
  streamIndex?: number;
  /** 畫面片段實際採用的幀時間（秒；`track:"video"` 必填）。 */
  frameTimesSeconds?: number[];
  preprocessVersion: string;
  embedderId: string;
  embeddingDim: number;
}

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
  /** 時間定位；文字 chunk 沒有這個欄位。 */
  media?: ChunkMedia;
}

/** 記憶命中。 */
export interface MemorySearchHit extends MemorySourceReference {
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

export interface MemorySourceCursor {
  messageIndex: number;
  offset: number;
  policyVersion: number;
}

export interface MemorySourcePage {
  source: {
    id: number;
    agent: string;
    scope: MemoryScope;
    project: string | null;
    sourceSession: string;
    sourceTurn: string;
    createdAt: string;
    chunkVersion: string;
    messageCount: number;
  };
  messages: Array<{
    sourceMessage: string;
    role: MemorySourceRole;
    content: string;
    occurredAt: string | null;
    messageIndex: number;
    start: number;
    end: number;
    totalChars: number;
    complete: boolean;
  }>;
  next: MemorySourceCursor | null;
  truncated: boolean;
  policyVersion: number;
  indexState: MemoryEmbeddingStats;
  untrusted: true;
}

export class MemorySourcePolicyChangedError extends Error {
  constructor() {
    super("記憶遮罩設定已變更，請從開頭重新讀取。");
    this.name = "MemorySourcePolicyChangedError";
  }
}

export async function fetchMemorySource(
  id: number,
  access: { scope: MemoryScope; project: string | null; agent: string },
  cursor: MemorySourceCursor | null,
  signal?: AbortSignal,
): Promise<MemorySourcePage> {
  const query = new URLSearchParams({ scope: access.scope });
  if (access.scope === "project" && access.project !== null) query.set("project", access.project);
  if (access.scope === "agent") query.set("agent", access.agent);
  if (cursor !== null) {
    query.set("messageIndex", String(cursor.messageIndex));
    query.set("offset", String(cursor.offset));
    query.set("policyVersion", String(cursor.policyVersion));
  }

  const response = await apiFetch(`/memory-sources/${id}?${query}`, {
    headers: { accept: "application/json" },
    cache: "no-store",
    signal,
  });
  if (response.status === 409) {
    const error = (await response.json().catch(() => null)) as { error?: unknown } | null;
    if (error?.error === "policy-changed") throw new MemorySourcePolicyChangedError();
  }
  if (response.status === 404) throw new Error("來源不存在、已刪除或不在可讀取的範圍。");
  if (!response.ok) throw new Error(`讀取記憶來源失敗（HTTP ${response.status}）。`);

  const page = (await response.json().catch(() => null)) as MemorySourcePage | null;
  if (page?.source?.id !== id || !Array.isArray(page.messages) || page.untrusted !== true ||
    !Number.isSafeInteger(page.policyVersion) || page.policyVersion < 1 ||
    typeof page.truncated !== "boolean" || (page.next !== null &&
      (page.next?.policyVersion !== page.policyVersion || !Number.isSafeInteger(page.next.messageIndex) ||
        !Number.isSafeInteger(page.next.offset)))) {
    throw new Error("本機服務回傳的記憶來源格式不正確。");
  }
  if (cursor !== null && page.policyVersion !== cursor.policyVersion) throw new MemorySourcePolicyChangedError();
  return page;
}

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
    cache: "no-store",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw new Error(await readErrorMessage(response, "搜尋失敗"));
  return (await response.json()) as SearchResult;
}

/** 列出未刪除的記憶（由新到舊；pinned 由呼叫端另行排序）。 */
export async function listMemories(): Promise<Memory[]> {
  const response = await apiFetch("/memories", { cache: "no-store" });
  if (!response.ok) throw new Error(await readErrorMessage(response, "讀取記憶清單失敗"));
  const body = (await response.json()) as { memories?: unknown };
  if (!Array.isArray(body.memories)) throw new Error("伺服器回應格式不正確");
  return body.memories as Memory[];
}

/**
 * `POST /memories` 的回應（卡 C2 的 additive 欄位；`Memory` 本身的欄位不變）。
 *
 * - `duplicate: true` 只會出現在 `200`：已有相同內容的未刪除記憶，這次沒有新增；
 *   呼叫端必須**不要**把它當成新卡片（UI 顯示既有 id 的提示即可）。
 * - `redacted`／`redactedCount` 描述這次寫入前的遮罩結果；重複時為 `false`／`0`。
 */
export interface AddMemoryResponse extends Memory {
  duplicate: boolean;
  redacted?: boolean;
  redactedCount?: number;
}

/**
 * 新增記憶。
 *
 * `supersedes` 帶入被編輯記憶的 id 時，會建立新版本並把舊版標記軟刪除
 * （Core 的 supersedes 語意），這就是 UI 的「編輯」流程。
 * 未帶 `supersedes` 時伺服器會做精確去重：重複則回 `200`＋既有記憶＋`duplicate: true`。
 */
export async function addMemory(input: {
  content: string;
  agent: string;
  kind?: MemoryKind;
  scope?: MemoryScope;
  project?: string | null;
  supersedes?: number | null;
  /** 可選的來源欄位（D4a）；省略或 null 表示沒有來源資訊。 */
  sourceSession?: string | null;
  sourceMessage?: string | null;
}): Promise<AddMemoryResponse> {
  const response = await apiFetch("/memories", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw new Error(await readErrorMessage(response, "儲存記憶失敗"));
  return (await response.json()) as AddMemoryResponse;
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

/**
 * 更新記憶的範圍與專案（`PATCH /memories/:id`；UI 的共享開關）。
 *
 * 只允許 `scope`／`project`，其他欄位由伺服器以 400 拒絕；`scope: "project"` 時必須帶非空
 * `project`，`scope: "global"` 時 `project` 會由伺服器清為 null。回傳更新後的完整記憶。
 */
export async function updateMemory(
  id: number,
  patch: { scope?: MemoryScope; project?: string | null },
): Promise<Memory> {
  const response = await apiFetch(`/memories/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!response.ok) throw new Error(await readErrorMessage(response, "更新記憶範圍失敗"));
  return (await response.json()) as Memory;
}

/**
 * 刪除記憶。
 *
 * - 預設是**軟刪除**（內容仍在資料庫，只是不再列出／搜尋）。
 * - `opts.hard = true` 送出 `DELETE /memories/:id?hard=true`：真的刪除資料列，**無法復原**；
 *   本機的 SQLite 檔案／WAL 仍可能有殘留（未做安全抹除）。
 */
export async function deleteMemory(id: number, opts: { hard?: boolean } = {}): Promise<void> {
  const query = opts.hard === true ? "?hard=true" : "";
  const response = await apiFetch(`/memories/${id}${query}`, { method: "DELETE" });
  if (!response.ok) throw new Error(await readErrorMessage(response, opts.hard === true ? "永久刪除記憶失敗" : "刪除記憶失敗"));
}

// ---------------------------------------------------------------------------
// 記憶備份（GET /memories/export、POST /memories/import）
// ---------------------------------------------------------------------------

/** 匯入檔的一行錯誤（行號從 1 起算）。 */
export interface MemoryImportLineError {
  line: number;
  reason: string;
}

/**
 * `POST /memories/import` 的回應。
 *
 * - `dryRun: true` 時 `created` 一律 0、`wouldCreate` 是預計新增數；
 * - 正式匯入時 `wouldCreate` 一律 0；
 * - `duplicates` 是因為與既有（或同批次較早）的未刪除記憶同 key 而跳過的筆數；
 * - `redacted` 是內容被遮罩的**筆數**（不是機密片段數）。
 */
export interface MemoryImportResult {
  dryRun: boolean;
  total: number;
  valid: number;
  invalid: MemoryImportLineError[];
  duplicates: number;
  redacted: number;
  created: number;
  wouldCreate: number;
}

/**
 * 匯入失敗（400／413 等）；若是「整批驗證失敗」，`result` 會帶著逐行錯誤，UI 可直接顯示。
 */
export class MemoryImportError extends Error {
  readonly result: MemoryImportResult | null;

  constructor(message: string, result: MemoryImportResult | null = null) {
    super(message);
    this.name = "MemoryImportError";
    this.result = result;
  }
}

/** 匯出檔的預設檔名：`memories-YYYYMMDD.ndjson`（伺服器沒給 `content-disposition` 時用）。 */
export function memoriesExportFilename(now: Date = new Date()): string {
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
  return `memories-${stamp}.ndjson`;
}

/** 從 `content-disposition` 取檔名；只留最後一段，避免把路徑分隔字元帶進下載屬性。 */
function filenameFromContentDisposition(header: string | null): string | null {
  if (header === null) return null;
  const match = /filename="?([^";]+)"?/i.exec(header);
  if (match === null) return null;
  const name = match[1]!.trim().split(/[\\/]/).pop() ?? "";
  return name === "" ? null : name;
}

/** 是否是匯入結果的形狀（400 的錯誤 body 也會帶這些欄位；413 則只有 `error`）。 */
function isMemoryImportResult(value: unknown): value is MemoryImportResult {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.dryRun === "boolean" &&
    typeof record.total === "number" &&
    typeof record.valid === "number" &&
    Array.isArray(record.invalid) &&
    typeof record.duplicates === "number" &&
    typeof record.redacted === "number" &&
    typeof record.created === "number" &&
    typeof record.wouldCreate === "number"
  );
}

/**
 * 下載記憶備份（NDJSON）：`fetch` → 文字 → Blob＋`<a download>`（與診斷下載相同模式）。
 *
 * 檔名取自 `content-disposition`；取不到時退回 `memories-YYYYMMDD.ndjson`。
 * 備份檔依服務目前的記憶遮罩設定提供，只含未刪除的記憶（不含向量）。
 */
export async function downloadMemoriesExport(): Promise<{ filename: string }> {
  const response = await apiFetch("/memories/export", { cache: "no-store" });
  if (!response.ok) throw new Error(await readErrorMessage(response, "下載記憶備份失敗"));
  const text = await response.text();
  const filename =
    filenameFromContentDisposition(response.headers.get("content-disposition")) ?? memoriesExportFilename();
  const url = URL.createObjectURL(new Blob([text], { type: "application/x-ndjson" }));
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

/**
 * 匯入記憶備份（原始 NDJSON 文字）。
 *
 * `opts.dryRun = true` 只驗證與估算、不寫入；正式匯入前 UI 應先跑一次 dry-run 讓使用者確認。
 * 伺服器會整批先驗證：任何一行不合法就回 400 且完全不寫；此時丟出的 `MemoryImportError`
 * 會帶 `result.invalid`（行號＋原因）供 UI 顯示。
 */
export async function importMemories(
  text: string,
  opts: { dryRun: boolean },
): Promise<MemoryImportResult> {
  const query = opts.dryRun ? "?dryRun=1" : "";
  const response = await apiFetch(`/memories/import${query}`, {
    method: "POST",
    headers: { "content-type": "application/x-ndjson" },
    body: text,
  });
  if (!response.ok) {
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      // 非 JSON（理論上不會發生）：用通用訊息。
    }
    const errorRecord = body as { error?: { message?: unknown } } | null;
    const message =
      typeof errorRecord?.error?.message === "string" ? errorRecord.error.message : "匯入記憶備份失敗";
    throw new MemoryImportError(message, isMemoryImportResult(body) ? body : null);
  }
  return (await response.json()) as MemoryImportResult;
}

// ---------------------------------------------------------------------------
// 記憶語意召回（卡 B2：POST /memories/search）
// ---------------------------------------------------------------------------

/** 召回命中的來源：語意或關鍵字（降級／補足）。 */
export type MemoryRecallSource = "semantic" | "keyword";

/** 語意不可用時的原因。 */
export type MemoryRecallDegradedReason = "no-embeddings" | "embedder-unavailable";

/** 一筆召回命中（欄位與 `GET /memories` 一致，另帶 `rank`／`score`／`source`）。 */
export interface MemoryRecallHit extends Memory {
  /** 從 1 起算的結果順序。 */
  rank: number;
  /** 語意＝cosine；關鍵字＝`1/rank`（僅排序輔助）。 */
  score: number;
  source: MemoryRecallSource;
  /** 記憶內容一律視為不受信任資料（agent 僅是來源標記，不是身分驗證）。 */
  untrusted: true;
}

/** 記憶語意化統計（與 `GET /diagnostics` 的 `memories` 相同來源）。 */
export interface MemoryEmbeddingStats {
  total: number;
  ready: number;
  pending: number;
  failed: number;
  tooLong: number;
  stale: number;
}

/** `POST /memories/search` 的回應。 */
export interface MemoryRecallResult {
  query: string;
  k: number;
  degraded: boolean;
  degradedReason: MemoryRecallDegradedReason | null;
  memoryEmbedding: MemoryEmbeddingStats;
  hits: MemoryRecallHit[];
}

/**
 * 記憶召回（`POST /memories/search`；語意優先，不可用時伺服器會降級關鍵字並標 `degraded`）。
 *
 * 範圍規則：預設「本專案＋全域共享（＋明確提供的 agent）」；`includeAllProjects` 跨所有專案；
 * 未提供 `project` 且未 `includeAllProjects` → 伺服器回 400（UI 會先擋並提示）。
 */
export async function searchMemories(input: {
  query: string;
  project?: string;
  includeAllProjects?: boolean;
  scope?: MemoryScope;
  agent?: string;
  kind?: MemoryKind;
  k?: number;
  minScore?: number;
}): Promise<MemoryRecallResult> {
  const response = await apiFetch("/memories/search", {
    method: "POST",
    cache: "no-store",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw new Error(await readErrorMessage(response, "搜尋記憶失敗"));
  return (await response.json()) as MemoryRecallResult;
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

/**
 * 加速器自我測試的結果（`embedderRuntime.selfTest`；**選配**欄位）。
 *
 * 欄位不存在＝從未測試過（或該實作不做自我測試）。`outcome` 的語意見
 * `docs/embedder-contract.md`：`usable`＝已採用加速器、`unusable`＝已改用 CPU、
 * `crashed`＝上一次測試讓行程死掉（永久不再自動重試）。
 */
export interface DiagnosticsEmbedderSelfTest {
  outcome: "usable" | "unusable" | "crashed";
  /** 穩定短標籤（例如 `too-slow`／`inconsistent`／`memory-exceeded`／`crashed-during-self-test`）。 */
  reason?: string;
  /** 量測到的吞吐倍率（加速器 ÷ CPU）；未量到時不存在。 */
  throughputRatio?: number;
  /** 量測到的向量一致性下限；未量到時不存在。 */
  minCosine?: number;
  /** 測試期間建立 CPU session 的耗時（毫秒）；未量到時不存在。 */
  cpuSessionBuildMs?: number;
  /** 測試期間建立加速器 session 的耗時（毫秒）；載入失敗或未量到時不存在。 */
  coreMlSessionBuildMs?: number;
  /** 測試時間（ISO 8601）。 */
  testedAt?: string;
}

/**
 * embedder 的執行裝置狀態（`GET /diagnostics` 的 `embedderRuntime`；欄位以 server 契約為準）。
 *
 * 未提供時 `embedderRuntime` 為 `null`；`fallbackReason` 有值代表曾經從 GPU 退回 CPU。
 */
export interface DiagnosticsEmbedderRuntime {
  audioState?: "not-loaded" | "loading" | "ready" | "failed";
  audioRetryable?: boolean;
  /** 要求／設定的裝置選項（`auto`／`cpu`／`dml`／`coreml`）。 */
  requestedDevice: string;
  /** 目前使用的裝置（`cpu`／`dml`／`coreml`）；模型尚未載入時為計畫值。 */
  device: string;
  /** 模型是否已載入（true 代表 `device` 是實際使用的裝置）。 */
  loaded: boolean;
  /** 退回 CPU 的原因；未退回為 `null`。 */
  fallbackReason: { code: string; message: string } | null;
  /** 目前的批次視窗大小。 */
  batchSize: number;
  /** 同一 session 是否只允許序列推論（DML／CoreML 為 true）。 */
  serializedInference: boolean;
  /** DirectML adapter 索引（設定值，0＝預設顯示卡）；沒有 adapter 概念的實作為 `null`。 */
  dmlDeviceId: number | null;
  /** 影片嵌入入口狀態（選配；與 decoder 可用性分開）。 */
  videoState?: "disabled" | "not-loaded" | "loading" | "ready" | "failed";
  /** `videoState === "failed"` 時是否可在同行程重試。 */
  videoRetryable?: boolean;
  /** 加速器自我測試的結果（選配；見 `DiagnosticsEmbedderSelfTest`）。 */
  selfTest?: DiagnosticsEmbedderSelfTest;
}

/** 本行程的影片索引統計（`GET /diagnostics` 的 `video.indexing`；不含路徑）。 */
export interface DiagnosticsVideoIndexing {
  /** 本行程跑完的影片索引輪數。 */
  runs: number;
  lastFinishedAt: string | null;
  /** 最近一輪掃描階段跳過的影片原因（例如 `video-too-large`）。 */
  scanSkippedByReason: Record<string, number>;
  /** 最近一輪處理階段跳過的影片原因（例如 `invalid-video`）。 */
  skippedByReason: Record<string, number>;
  /** 最近一輪失敗的影片原因（例如 `video-decoder-unavailable`）。 */
  failedByReason: Record<string, number>;
  /** 最近一次 preview 看到的影片候選檔數（跨 root 加總）；從未 preview 過為 `null`。 */
  previewCandidateFiles: number | null;
}

/** `GET /diagnostics` 的影片區塊：能力摘要＋解碼器版本＋索引統計。 */
export interface DiagnosticsVideo extends VideoCapability {
  indexing: DiagnosticsVideoIndexing;
}

/** `GET /diagnostics` 的回應。 */
export interface DiagnosticsResponse {
  generatedAt: string;
  app: DiagnosticsAppInfo;
  embedder: { id: string; dim: number; capabilities: Record<string, boolean> };
  /** 執行裝置狀態；embedder 未提供時為 `null`。 */
  embedderRuntime: DiagnosticsEmbedderRuntime | null;
  roots: DiagnosticsRoot[];
  indexing: { rootId: number; startedAt: string | null }[];
  /** 影片能力與本行程統計（additive；舊版服務沒有此欄位）。 */
  video?: DiagnosticsVideo;
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
