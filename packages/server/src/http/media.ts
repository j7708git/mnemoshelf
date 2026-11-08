/**
 * 影片播放端點（`GET /roots/:id/media?path=`）的 Range 讀取與串流。
 *
 * 設計依據（A1 播放 spike，13/13 通過）：
 * - **受 token 與 root 守衛保護的同源讀取**：本模組不自己驗 token／Host（由 `dispatch` 與
 *   `auth.ts` 負責），但所有檔案存取一律先過 `resolveTarget`（realpath＋root 前綴＋黑名單）。
 * - **handle 綁定（波次一 D5，修 STD-1）**：驗證後**不得**再依路徑開 stream。流程是
 *   `resolveTarget` → `fs.open` 取 handle → `handle.stat()` → 檔案／大小檢查 →
 *   重新解析 root 邊界並比對 handle 身分（dev／ino／size）→ 只用 `handle.createReadStream`。
 *   身分不可證明（dev／ino 皆 0）一律 fail closed；HEAD／416／0 byte／錯誤路徑都會關閉 handle。
 * - **單一 Range**：`bytes=a-b`／`bytes=a-`／`bytes=-n`；多段、畸形、越界一律 416
 *   （越界時回 `Content-Range` 的「星號＋斜線＋總長度」形式）。Chromium 對 206 續傳的行為已在 A1 實測。
 * - **單次上限 4 MiB**：開放式 Range 會合法地截短回應（client 可續要）；不把整檔讀進記憶體。
 * - **串流**：`createReadStream` 直接 pipe 回應，記憶體用量與檔案大小無關；client 中止時
 *   立刻 destroy 讀取串流，不再送完。
 * - **不快取**：`cache-control: no-store`。播放來源是「當下檔案」；原檔修改後由 UI 依
 *   索引狀態提示重建，不把舊位元組當成新內容（見 `docs/roots-and-privacy.md` §影片）。
 *
 * v1 只服務 `.mp4`（與索引白名單一致）；其他副檔名回 415，不讓這個端點變成任意檔案下載。
 */
import { promises as fs, type BigIntStats, type Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import path from "node:path";
import type { Readable } from "node:stream";
import { isSupportedVideoFileName, PathOutsideRootError, type Root } from "@mnemoshelf/core";
import { FileTooLargeError, NotFoundError, UnsupportedFileTypeError, ValidationError } from "../errors.js";
import { parseRelativePath, resolveTarget, type ResolvedTarget } from "./explorer.js";

/** 單次 Range 回應的位元組上限（4 MiB）：Chromium 會自動續要，對 1080p 播放足夠。 */
export const MEDIA_RANGE_MAX_BYTES = 4 * 1024 * 1024;

/** 影片播放的 Content-Type（v1 只有 `.mp4`）。 */
export const MEDIA_CONTENT_TYPE = "video/mp4";

/** 播放回應不快取：每次請求都反映當下檔案內容。 */
export const MEDIA_CACHE_CONTROL = "no-store";

/** 串流讀取的 chunk 大小（避免一次配置大緩衝）。 */
const MEDIA_STREAM_HIGH_WATER_MARK = 64 * 1024;

/**
 * 一次 Range 請求的判定結果。
 *
 * - `full`：沒有 Range header → 200 整檔（仍以串流送出）；
 * - `partial`：合法單一 Range → 206（可能被單次上限截短）；
 * - `unsatisfiable`：多段／畸形／越界 → 416。
 */
export type MediaRangeDecision =
  | { kind: "full"; totalBytes: number }
  | { kind: "partial"; start: number; end: number; totalBytes: number }
  | { kind: "unsatisfiable"; totalBytes: number };

/**
 * 解析 `Range` header。
 *
 * 刻意只接受**單一** `bytes` 範圍：
 * - `bytes=start-end`：start ≤ end 且 start < size；
 * - `bytes=start-`：到檔尾；
 * - `bytes=-suffix`：最後 suffix 個位元組（大於檔案大小時回整檔）；
 * - 多段（含逗號）、單位不是 `bytes`、數字格式壞掉 → `unsatisfiable`（416）。
 *
 * 合法範圍若超過 `maxBytes`，會把 `end` 截到 `start + maxBytes - 1`（仍是 206，
 * 帶正確的 `Content-Range`）；這是 A1 驗證過的「client 續傳」語意，不是錯誤。
 */
export function parseMediaRange(
  header: string | undefined,
  totalBytes: number,
  maxBytes: number = MEDIA_RANGE_MAX_BYTES,
): MediaRangeDecision {
  if (header === undefined || header.trim() === "") return { kind: "full", totalBytes };

  const value = header.trim();
  // 只接受單一範圍：逗號（多段）與其他單位一律不支援。
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (match === null) return { kind: "unsatisfiable", totalBytes };
  const rawStart = match[1]!;
  const rawEnd = match[2]!;
  if (rawStart === "" && rawEnd === "") return { kind: "unsatisfiable", totalBytes };
  // 空檔沒有可滿足的位元組範圍。
  if (totalBytes <= 0) return { kind: "unsatisfiable", totalBytes };

  let start: number;
  let end: number;
  if (rawStart === "") {
    const suffix = Number(rawEnd);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return { kind: "unsatisfiable", totalBytes };
    start = Math.max(0, totalBytes - suffix);
    end = totalBytes - 1;
  } else {
    start = Number(rawStart);
    if (!Number.isSafeInteger(start) || start < 0) return { kind: "unsatisfiable", totalBytes };
    if (start >= totalBytes) return { kind: "unsatisfiable", totalBytes };
    end = totalBytes - 1;
    if (rawEnd !== "") {
      const requestedEnd = Number(rawEnd);
      if (!Number.isSafeInteger(requestedEnd) || requestedEnd < start) {
        return { kind: "unsatisfiable", totalBytes };
      }
      end = Math.min(requestedEnd, totalBytes - 1);
    }
  }

  const limit = Number.isSafeInteger(maxBytes) && maxBytes > 0 ? maxBytes : MEDIA_RANGE_MAX_BYTES;
  if (end - start + 1 > limit) end = start + limit - 1;
  return { kind: "partial", start, end, totalBytes };
}

/** 串流路由結果（影片播放）：直接寫 header 並 pipe，不經 JSON／Buffer。 */
export interface StreamRouteResult {
  status: number;
  headers: Record<string, string>;
  /** `null` 表示沒有 body（HEAD、416、空檔）。 */
  stream: Readable | null;
}

/** 建立播放回應所需的輸入（全部來自已驗證的請求）。 */
export interface MediaRequestInput {
  /** `path` 查詢參數的原始值；缺漏交給 `parseRelativePath` 回 400。 */
  relPath: string | null;
  /** `Range` header 的原始值。 */
  rangeHeader: string | undefined;
  /** HEAD 只送 header。 */
  headOnly: boolean;
}

/** 建立播放回應的選項。 */
export interface MediaResponseOptions {
  /**
   * 影片單檔大小上限（bytes）：與掃描／有界快照**共用同一個值**（`videoMaxFileBytes`）。
   * 超過回 413（與 `/file` 對圖片／音訊的語意一致）。
   */
  maxFileBytes: number;
  /** 單次 Range 上限（bytes）；預設 4 MiB，測試可覆寫。 */
  rangeMaxBytes?: number;
}

function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";
}

/**
 * 來源在驗證期間變更，或無法證明 handle 身分（dev／ino 不可用）時拒絕。
 *
 * 繼承 `PathOutsideRootError` 以沿用既有 403 映射（`http/app.ts` 的 `toHttpError` 不必改）；
 * 訊息與欄位都不含路徑細節。這是**具名拒絕**，不是把失敗改記成功。
 */
class MediaSourceUnverifiableError extends PathOutsideRootError {
  constructor(requested: string) {
    super(requested);
    this.name = "MediaSourceUnverifiableError";
    this.message = "影片來源在驗證期間變更或無法證明身分，已拒絕讀取";
  }
}

/** 開啟 handle；ENOENT 轉 404，其餘錯誤原樣拋出（呼叫端負責在失敗時關閉 handle）。 */
async function openFileHandleOr404(abs: string): Promise<FileHandle> {
  try {
    return await fs.open(abs, "r");
  } catch (error) {
    if (isEnoent(error)) throw new NotFoundError("路徑");
    throw error;
  }
}

/**
 * 以 BigInt 取 **lstat**（dev／ino 精確比較；Windows 的 ino 可能超過 Number 安全整數）。
 *
 * 為什麼是 `lstat` 而不是 `stat`：這裡要比對的是「剛剛通過 root 驗證的那個目錄項目」，
 * 不是它可能再指向的目標。`resolveTarget` 回傳的 realpath 已不含任何 symlink 片段，
 * 因此 lstat 與 stat 對正常檔案等價；若最後一段在驗證後被換成 symlink，lstat 會看到
 * 連結本身（dev／ino 與 handle 不同）而拒絕，屬 fail closed。
 *
 * 另一個效果是流程裡**沒有任何「先 stat 路徑、再開檔」的順序**：開檔永遠在第一次路徑
 * stat 之前（D5）；獨立審查的原始反例（monkeypatch `fs.stat` 後換 junction）因此無法在
 * 驗證與讀取之間插入替換，只能讀到已驗證的 INSIDE 內容。
 */
async function lstatBigIntOr404(abs: string): Promise<BigIntStats> {
  try {
    return await fs.lstat(abs, { bigint: true });
  } catch (error) {
    if (isEnoent(error)) throw new NotFoundError("路徑");
    throw error;
  }
}

/** 兩條絕對路徑是否相同（Windows／macOS 大小寫不敏感，與 path-guard 一致）。 */
function samePath(left: string, right: string): boolean {
  const normalize = (value: string): string => {
    const resolved = path.resolve(value);
    return process.platform === "win32" || process.platform === "darwin" ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

/** dev／ino 是否可證明身分；兩者皆 0（部分檔案系統）時不可證明。 */
function identityProvable(stats: BigIntStats): boolean {
  return !(stats.dev === 0n && stats.ino === 0n);
}

/** handle 與路徑的 stat 是否指向同一個檔案版本（dev／ino／size）。 */
function sameFileIdentity(handleStats: BigIntStats, pathStats: BigIntStats): boolean {
  return (
    handleStats.dev === pathStats.dev &&
    handleStats.ino === pathStats.ino &&
    handleStats.size === pathStats.size
  );
}

/**
 * 重新解析 root 邊界並比對 handle 身分（D5 的關鍵步驟）。
 *
 * 為什麼不是「再 stat 一次路徑就好」：`resolveTarget` 會走 realpath＋root 前綴＋黑名單；
 * 若父目錄在初次驗證後被換成指向 root 外的 junction／symlink，這裡會拋
 * `PathOutsideRootError`（403）或身分不符（`MediaSourceUnverifiableError`，也是 403）。
 *
 * - realpath 必須與初次解析完全相同：父目錄被換成 root 內**另一個**目錄也算變更（拒絕）。
 * - 身分比對用 BigInt 的 dev／ino／size；不可證明（dev／ino 皆 0）一律 fail closed。
 * - 驗證後仍可能有極窄的「再替換」窗口，但**讀取只用 handle**：handle 指向的 inode 在
 *   open 當下已確定，之後替換路徑不會改變已開啟 handle 的內容（殘餘風險見 notes）。
 */
async function assertHandleInsideRoot(
  root: Root,
  target: ResolvedTarget,
  handleStats: BigIntStats,
): Promise<void> {
  if (!identityProvable(handleStats)) throw new MediaSourceUnverifiableError(target.abs);

  // 重新走一次 root 守衛（realpath＋root 前綴＋黑名單）。父目錄被換掉時這裡就會失敗。
  const revalidated = await resolveTarget(root, target.rel);
  if (!samePath(revalidated.abs, target.abs)) throw new MediaSourceUnverifiableError(target.abs);

  const pathStats = await lstatBigIntOr404(revalidated.abs);
  if (!identityProvable(pathStats) || !sameFileIdentity(handleStats, pathStats)) {
    throw new MediaSourceUnverifiableError(target.abs);
  }
}

/**
 * 建立影片播放回應：驗證 root 內路徑、套用大小上限、解析 Range，回傳串流結果。
 *
 * 波次一 D5 的流程（不得在驗證後再依路徑開 stream）：
 * 1. `resolveTarget`：realpath＋root 前綴＋黑名單（第一次）；
 * 2. `fs.open` 取 handle（之後**只用這個 handle**）；
 * 3. `handle.stat()`：檔案／大小檢查（不依路徑）；
 * 4. `assertHandleInsideRoot`：重新解析 root 邊界並比對 handle 身分（dev／ino／size）；
 * 5. 只用 `handle.createReadStream({start,end})` 讀取；HEAD／416／0 byte／錯誤路徑在
 *    `finally` 關閉 handle，串流交給 `autoClose`。
 *
 * 拋出的錯誤走 `toHttpError` 的既有映射（400／403／404／413／415）；
 * 成功時由 `sendStreamResult` 寫出（206／200／416 皆為成功路由結果）。
 */
export async function buildMediaResponse(
  root: Root,
  input: MediaRequestInput,
  options: MediaResponseOptions,
): Promise<StreamRouteResult> {
  const relPath = parseRelativePath(input.relPath, { allowEmpty: false });
  if (!isSupportedVideoFileName(relPath)) {
    throw new UnsupportedFileTypeError(relPath, "播放端點只支援本機 .mp4 影片（v1 範圍）");
  }
  const target = await resolveTarget(root, relPath);
  const handle = await openFileHandleOr404(target.abs);
  // 串流一旦交出所有權（createReadStream 成功），handle 由串流 autoClose 負責關閉；
  // 其餘所有路徑（HEAD／416／0 byte／錯誤）都在 finally 關閉 handle。
  let streamHandedOff = false;
  try {
    // 只信 handle 的 stat：不依路徑重新 stat（避免 stat→open 的 TOCTOU）。
    const handleStats = await handle.stat({ bigint: true });
    if (!handleStats.isFile()) throw new ValidationError("path", "不是檔案");
    const totalBytes = Number(handleStats.size);
    // 上限比較用 BigInt，避免 > 2^53 的畸形大小在轉換後失真。
    const limitBytes =
      Number.isFinite(options.maxFileBytes) && options.maxFileBytes > 0 ? Math.trunc(options.maxFileBytes) : 0;
    if (limitBytes > 0 && handleStats.size > BigInt(limitBytes)) {
      throw new FileTooLargeError(target.rel, options.maxFileBytes);
    }
    if (!Number.isSafeInteger(totalBytes) || totalBytes < 0) throw new MediaSourceUnverifiableError(target.abs);

    // 重新解析 root 邊界並比對 handle 身分；不可證明或已變更一律具名拒絕。
    await assertHandleInsideRoot(root, target, handleStats);

    const decision = parseMediaRange(input.rangeHeader, totalBytes, options.rangeMaxBytes);
    const baseHeaders: Record<string, string> = {
      "content-type": MEDIA_CONTENT_TYPE,
      "accept-ranges": "bytes",
      "cache-control": MEDIA_CACHE_CONTROL,
      "x-content-type-options": "nosniff",
    };

    if (decision.kind === "unsatisfiable") {
      return {
        status: 416,
        headers: { ...baseHeaders, "content-range": `bytes */${totalBytes}`, "content-length": "0" },
        stream: null,
      };
    }

    const start = decision.kind === "full" ? 0 : decision.start;
    const end = decision.kind === "full" ? totalBytes - 1 : decision.end;
    const length = totalBytes === 0 ? 0 : end - start + 1;
    const headers: Record<string, string> = { ...baseHeaders, "content-length": String(length) };
    if (decision.kind === "partial") headers["content-range"] = `bytes ${start}-${end}/${totalBytes}`;
    const status = decision.kind === "full" ? 200 : 206;

    if (input.headOnly || length === 0) return { status, headers, stream: null };
    // 只用**同一個已驗證的 handle** 讀取：驗證後不再依路徑開 stream（D5）。
    // autoClose=true：串流結束／錯誤／destroy 時由串流關閉 fd。
    const stream = handle.createReadStream({
      start,
      end,
      highWaterMark: MEDIA_STREAM_HIGH_WATER_MARK,
      autoClose: true,
    });
    streamHandedOff = true;
    return { status, headers, stream };
  } finally {
    if (!streamHandedOff) {
      // HEAD／416／0 byte／任何錯誤路徑：handle 必須關閉；關閉失敗不掩蓋原本的錯誤。
      await handle.close().catch(() => undefined);
    }
  }
}

/**
 * 寫出串流結果並等它結束（或 client 中止）。
 *
 * 中止語意：client 斷線（`response` 在寫完前 close）→ `stream.destroy()`，不再讀檔、
 * 不再送資料；讀取期間檔案被截斷／替換造成串流錯誤 → destroy 回應（client 會看到
 * 長度不符或連線中止，不會收到一個假裝完整的 200）。
 */
export async function sendStreamResult(response: ServerResponse, result: StreamRouteResult): Promise<void> {
  const stream = result.stream;
  try {
    response.writeHead(result.status, result.headers);
  } catch (error) {
    // header 都還沒送出就失敗（例如連線已斷）：先釋放 handle 再往上拋，不留下未關閉的 fd。
    stream?.destroy();
    throw error;
  }
  if (stream === null) {
    response.end();
    return;
  }

  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };
    stream.once("close", finish);
    stream.once("error", () => {
      // header 已送出，不能改狀態碼；destroy 讓 client 明確看到回應不完整。
      response.destroy();
      finish();
    });
    // 回應端錯誤（含 client 中止）時一併 destroy 串流；autoClose 會關閉 handle。
    response.once("error", () => {
      stream.destroy();
      finish();
    });
    response.once("close", () => {
      if (!response.writableFinished) stream.destroy();
      finish();
    });
    stream.pipe(response);
  });
}
