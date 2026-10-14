/**
 * 檔案總管端點的實作：目錄子項列舉、文字預覽、圖片位元組與縮圖。
 *
 * **所有檔案存取一律經過 `resolveInsideRoot`**（`docs/roots-and-privacy.md` §路徑安全）：
 * realpath 解析（跟隨 symlink）＋必須落在 root 內＋黑名單（相對與絕對路徑都檢查）。
 * 本模組不自行拼路徑後直接讀檔，一律先過守衛。
 *
 * 大小上限（不得無限制讀檔）：
 * - 文字預覽：`MAX_TEXT_PREVIEW_BYTES`，超過只讀前段並以 `truncated` 標明；
 * - 原始圖片：`MAX_IMAGE_BYTES`，超過回 413；
 * - 縮圖輸入：`MAX_THUMBNAIL_INPUT_BYTES`，超過回 413。
 *
 * 縮圖用 `sharp`（server 的直接依賴）產生，**只放記憶體快取**（`ThumbnailCache`），不寫磁碟。
 */
import { promises as fs, type Stats } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import {
  classifyFile,
  mimeTypeFor,
  resolveInsideRoot,
  type ChunkKind,
  type Root,
} from "@mnemoshelf/core";
import { FileTooLargeError, NotFoundError, UnsupportedFileTypeError, ValidationError } from "../errors.js";

/** 文字預覽的位元組上限（超過即截斷）。 */
export const MAX_TEXT_PREVIEW_BYTES = 256 * 1024;
/** 原始圖片位元組的上限（超過回 413）。 */
export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
/** 縮圖輸入檔的上限（超過回 413；避免對巨大檔解碼）。 */
export const MAX_THUMBNAIL_INPUT_BYTES = 25 * 1024 * 1024;
/** 縮圖的寬度上限（像素）；較小的圖不放大。 */
export const THUMBNAIL_MAX_WIDTH = 320;
/** 縮圖快取的項目數上限（簡單 Map＋上限，超出時淘汰最舊的）。 */
export const THUMBNAIL_CACHE_LIMIT = 200;

/** 目錄子項的種類：目錄、可索引模態，或已知的二進位格式。 */
export type EntryKind = "dir" | ChunkKind | "binary";

/** 一個目錄子項（`GET /roots/:id/entries` 的回應元素）。 */
export interface DirEntry {
  /** 檔名（最後一段）。 */
  name: string;
  /** 相對 root 的路徑，一律 `/` 分隔。 */
  path: string;
  kind: EntryKind;
  /** 檔案大小（bytes）；目錄為 null。 */
  size: number | null;
  /** 圖片檔的 MIME 型別；其餘為 null。 */
  mimeType: string | null;
}

/** 文字預覽的回應主體。 */
export interface TextPreview {
  kind: "text";
  path: string;
  /** 完整檔案大小（bytes）。 */
  size: number;
  /** 是否因超過上限而截斷。 */
  truncated: boolean;
  content: string;
}

/** 圖片原始位元組（由端點直接以位元組回應，這裡只描述結果）。 */
export interface ImageBytes {
  kind: "image";
  path: string;
  size: number;
  contentType: string;
  bytes: Buffer;
}

export type FilePreview = TextPreview | ImageBytes;

/** 縮圖結果。 */
export interface ThumbnailResult {
  bytes: Buffer;
  contentType: string;
  /** 原始檔大小（bytes）。 */
  size: number;
}

/** 相對路徑一律轉成 `/` 分隔（跨平台一致；與 `ScanEntry.relPath` 相同慣例）。 */
function toPosix(relative: string): string {
  return relative.split(path.sep).join("/");
}

/** 絕對路徑樣式：POSIX 的開頭分隔符、Windows 磁碟機代號、UNC。 */
const ABSOLUTE_PATH_PATTERN = /^[\\/]|^[A-Za-z]:[\\/]/;

/**
 * 解析並驗證 `path` 查詢參數。
 *
 * - 缺漏（null）→ `ValidationError`（400）；
 * - 含 NUL 位元組（`\0`，例如查詢字串的 `a%00b`）→ `ValidationError`（400）——這是無效的
 *   檔案路徑，若不擋會讓 `fs`／`path` 丟出非具名例外而變成 500；
 * - 絕對路徑（POSIX／Windows／UNC）→ `ValidationError`（400）——這是相對路徑參數，
 *   而且 `path.join(root, 絕對路徑)` 會把絕對路徑當成片段接在後面（不會逃脫），
 *   必須先明確拒絕，不能讓它變成「root 內一個奇怪檔名」。
 *
 * 含 `..` 的路徑**不在此擋**：交由 `resolveInsideRoot` 以真實路徑判定（逃出 root 即
 * `PathOutsideRootError`，403），與既有守衛的行為一致。
 */
export function parseRelativePath(raw: string | null, options: { allowEmpty: boolean }): string {
  if (raw === null) throw new ValidationError("path", "缺少 path 參數");
  if (raw.includes("\0")) {
    throw new ValidationError("path", "不得包含 NUL 位元組");
  }
  if (ABSOLUTE_PATH_PATTERN.test(raw)) {
    throw new ValidationError("path", "必須是 root 內的相對路徑（不得為絕對路徑）");
  }
  if (raw === "" && !options.allowEmpty) {
    throw new ValidationError("path", "必須是非空的相對路徑");
  }
  return raw;
}

/** 解析後的目標（絕對路徑與相對 root 的 POSIX 路徑）。 */
export interface ResolvedTarget {
  abs: string;
  rel: string;
}

/**
 * 把相對路徑解析成 root 內的絕對路徑。**所有檔案端點的唯一入口**。
 *
 * 走 `resolveInsideRoot`：跟隨 symlink 後必須落在 root 內，且黑名單（含絕對路徑片段）一律拒絕。
 */
export async function resolveTarget(root: Root, relPath: string): Promise<ResolvedTarget> {
  const requested = path.join(root.path, relPath);
  const resolved = await resolveInsideRoot([root], requested);
  return { abs: resolved.abs, rel: toPosix(resolved.rel) };
}

/** `fs.stat`；ENOENT 轉成 404，其餘錯誤原樣拋出。 */
async function statOr404(abs: string): Promise<Stats> {
  try {
    return await fs.stat(abs);
  } catch (error) {
    if (typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT") {
      throw new NotFoundError("路徑");
    }
    throw error;
  }
}

/**
 * 列出某個相對路徑（目錄）下的直接子項。
 *
 * 每個子項都再過一次 `resolveInsideRoot`：指向 root 外或命中黑名單的項目**直接略過**
 * （不回報、不洩漏其存在）。排序：目錄在前，再依名稱（中文語系比較）。
 * 回傳的 `path` 是**正規化後**的相對路徑（`/` 分隔）。
 */
export async function listDirectoryEntries(root: Root, relPath: string): Promise<{ path: string; entries: DirEntry[] }> {
  const { abs, rel } = await resolveTarget(root, relPath);
  const stats = await statOr404(abs);
  if (!stats.isDirectory()) throw new ValidationError("path", "不是目錄");

  const dirents = await fs.readdir(abs, { withFileTypes: true });
  const entries: DirEntry[] = [];

  for (const dirent of dirents) {
    // 與掃描器一致：`.git` 一律不列出。
    if (dirent.name === ".git") continue;

    const childAbs = path.join(abs, dirent.name);
    const childRel = rel === "" ? dirent.name : `${rel}/${dirent.name}`;

    let guardedAbs: string;
    try {
      guardedAbs = (await resolveInsideRoot([root], childAbs)).abs;
    } catch {
      // root 外（symlink 逃脫）或黑名單：不列出。
      continue;
    }

    let childStats: Stats;
    try {
      childStats = await fs.stat(guardedAbs);
    } catch {
      continue;
    }

    if (childStats.isDirectory()) {
      entries.push({ name: dirent.name, path: childRel, kind: "dir", size: null, mimeType: null });
      continue;
    }
    const kind = classifyFile(dirent.name);
    entries.push({
      name: dirent.name,
      path: childRel,
      kind,
      size: childStats.size,
      mimeType: kind === "image" ? mimeTypeFor(dirent.name) : null,
    });
  }

  entries.sort((a, b) => {
    const aDir = a.kind === "dir" ? 0 : 1;
    const bDir = b.kind === "dir" ? 0 : 1;
    if (aDir !== bDir) return aDir - bDir;
    return a.name.localeCompare(b.name, "zh-Hant");
  });

  return { path: rel, entries };
}

/**
 * 解碼可能被截斷的 UTF-8 位元組前綴。
 *
 * 以 `fatal: true` 解碼，失敗時（尾端有多位元組字元被切斷）逐步往回退最多 3 個位元組，
 * 避免在預覽尾端留下 `U+FFFD`。真的解不開時才以寬鬆模式解碼。
 */
function decodeUtf8Prefix(bytes: Buffer): string {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let cut = 0; cut <= 3 && cut <= bytes.length; cut += 1) {
    try {
      return decoder.decode(bytes.subarray(0, bytes.length - cut));
    } catch {
      // 尾端多位元組序列被截斷：再退一個位元組。
    }
  }
  return bytes.toString("utf8");
}

/** 讀取檔案的前 `limit` 個位元組（不一次讀入整檔）。 */
async function readPrefix(abs: string, limit: number): Promise<Buffer> {
  const handle = await fs.open(abs, "r");
  try {
    const buffer = Buffer.alloc(limit);
    const { bytesRead } = await handle.read(buffer, 0, limit, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * 讀取檔案預覽。
 *
 * - 圖片 → 原始位元組＋正確 Content-Type（上限 `MAX_IMAGE_BYTES`）；
 * - 文字／程式碼 → JSON（上限 `MAX_TEXT_PREVIEW_BYTES`，超過截斷並標明）；
 * - 二進位與媒體（audio／video）→ `UnsupportedFileTypeError`（415），不回傳亂碼。
 */
export async function readFilePreview(root: Root, relPath: string): Promise<FilePreview> {
  const { abs, rel } = await resolveTarget(root, relPath);
  const stats = await statOr404(abs);
  if (!stats.isFile()) throw new ValidationError("path", "不是檔案");

  const kind = classifyFile(path.basename(abs));

  if (kind === "image") {
    if (stats.size > MAX_IMAGE_BYTES) throw new FileTooLargeError(rel, MAX_IMAGE_BYTES);
    const bytes = await fs.readFile(abs);
    return { kind: "image", path: rel, size: stats.size, contentType: mimeTypeFor(path.basename(abs)) ?? "application/octet-stream", bytes };
  }

  if (kind !== "text" && kind !== "code") {
    throw new UnsupportedFileTypeError(rel, "此型別不支援文字預覽（可能是二進位或媒體檔）");
  }

  const truncated = stats.size > MAX_TEXT_PREVIEW_BYTES;
  const bytes = await readPrefix(abs, truncated ? MAX_TEXT_PREVIEW_BYTES : stats.size);
  return { kind: "text", path: rel, size: stats.size, truncated, content: decodeUtf8Prefix(bytes) };
}

/**
 * 縮圖快取（行程內記憶體，不寫磁碟）。
 *
 * key 含 mtime 與大小，檔案變更即自然失效；項目數超過上限時淘汰最舊的（Map 的插入順序）。
 */
export class ThumbnailCache {
  private readonly items = new Map<string, ThumbnailResult>();

  constructor(private readonly limit: number = THUMBNAIL_CACHE_LIMIT) {}

  get(key: string): ThumbnailResult | undefined {
    return this.items.get(key);
  }

  set(key: string, value: ThumbnailResult): void {
    // 先刪再設，讓重複寫入的項目變成最新的（簡單 LRU 近似）。
    this.items.delete(key);
    this.items.set(key, value);
    while (this.items.size > this.limit) {
      const oldest = this.items.keys().next();
      if (oldest.done === true) break;
      this.items.delete(oldest.value);
    }
  }

  get size(): number {
    return this.items.size;
  }

  clear(): void {
    this.items.clear();
  }
}

/**
 * 產生圖片縮圖（寬度上限 `THUMBNAIL_MAX_WIDTH`，不放大）。
 *
 * 非圖片檔 → `UnsupportedFileTypeError`（415）；輸入過大 → `FileTooLargeError`（413）；
 * 解碼失敗 → `UnsupportedFileTypeError`（不回傳半成品）。輸出固定 PNG。
 */
export async function makeThumbnail(root: Root, relPath: string, cache: ThumbnailCache): Promise<ThumbnailResult> {
  const { abs, rel } = await resolveTarget(root, relPath);
  const stats = await statOr404(abs);
  if (!stats.isFile()) throw new ValidationError("path", "不是檔案");

  if (classifyFile(path.basename(abs)) !== "image") {
    throw new UnsupportedFileTypeError(rel, "此型別不支援縮圖（只支援圖片）");
  }
  if (stats.size > MAX_THUMBNAIL_INPUT_BYTES) throw new FileTooLargeError(rel, MAX_THUMBNAIL_INPUT_BYTES);

  const key = `${root.id}:${rel}:${stats.mtimeMs}:${stats.size}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  let bytes: Buffer;
  try {
    bytes = await sharp(abs, { failOn: "none" })
      .rotate() // 依 EXIF 自動轉正
      .resize({ width: THUMBNAIL_MAX_WIDTH, withoutEnlargement: true })
      .png()
      .toBuffer();
  } catch {
    throw new UnsupportedFileTypeError(rel, "無法解碼這個圖片檔");
  }

  const result: ThumbnailResult = { bytes, contentType: "image/png", size: stats.size };
  cache.set(key, result);
  return result;
}
