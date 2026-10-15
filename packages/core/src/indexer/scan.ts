import { promises as fs } from "node:fs";
import type { Dirent, Stats } from "node:fs";
import path from "node:path";
import ignore from "ignore";
import { PathBlockedError, PathOutsideRootError } from "../errors.js";
import type { ChunkKind, Modality, Root } from "../ports/types.js";
import { resolveInsideRoot } from "../roots/path-guard.js";
import { matchesAnyGlob } from "./glob.js";

/** 預設單檔大小上限（bytes）：超過即跳過。 */
export const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024;

/**
 * 跳過的原因。除了任務卡明列的 `blocked`／`excluded`／`modality-off`／`too-large`／
 * `unresolved-symlink`，另補四個由本實作決定的具名原因（見下方各處註解）：
 * `symlink-dir`、`unsupported-type`（含系統／垃圾檔）、`binary-content`、`not-a-file`。
 *
 * `binary-content` 不由掃描產生：掃描**只列舉、不讀內容**，因此它是在索引階段
 * （`indexer.processFile`）讀入後才判定的（見 `docs/roots-and-privacy.md` 的兩道防線）。
 */
export type SkipReason =
  | "blocked"
  | "excluded"
  | "modality-off"
  | "too-large"
  | "unresolved-symlink"
  | "symlink-dir"
  | "unsupported-type"
  | "binary-content"
  | "not-a-file";

/** 一個會納入索引的檔案（不含內容）。 */
export interface ScanEntry {
  /** 相對 root 的路徑，一律以 `/` 分隔（POSIX 風格）。 */
  relPath: string;
  /** 解析 symlink 後的真實絕對路徑（供呼叫端讀取內容用）。 */
  absPath: string;
  kind: ChunkKind;
  size: number;
  /** 媒體檔的 MIME 型別（文字／程式碼為 null）。 */
  mimeType: string | null;
}

/** 被跳過的檔案與原因。 */
export interface SkippedEntry {
  relPath: string;
  reason: SkipReason;
}

/** 掃描所需的 root 欄位（`Root` 結構上相容）。 */
export interface ScanRoot {
  path: string;
  modalities: Modality[];
  include: string[];
  exclude: string[];
  respectGitignore: boolean;
}

export interface ScanOptions {
  /** 單檔大小上限，預設 `DEFAULT_MAX_FILE_BYTES`（10 MB）。 */
  maxFileBytes?: number;
  /**
   * 取消訊號（可選）。走訪期間在**每個目錄與每個檔案項目**迭代前檢查一次，
   * 中止時拋 `AbortError`（沿用 core 既有的 `throwIfAborted` 慣例）。
   *
   * 為什麼要傳進掃描層：`indexRoot` 先 `await walkRoot(...)` 才進入 worker 池的
   * `throwIfAborted`；大目錄下若不在此處檢查，取消得等整個走訪結束才生效。
   * 參數可選：另一呼叫端（`previewRoot`，由 server 的 preview 使用）沒有 signal，
   * 維持不傳，行為不變。
   */
  signal?: AbortSignal;
}

export interface ScanResult {
  files: ScanEntry[];
  skipped: SkippedEntry[];
}

/** 已知的文字／程式碼／媒體副檔名（一律小寫、含開頭的點）。 */
const TEXT_EXTS = new Set([
  ".md",
  ".markdown",
  ".mdx",
  ".txt",
  ".text",
  ".rst",
  ".org",
  ".adoc",
  ".log",
  ".csv",
  ".tsv",
  ".json",
  ".jsonl",
  ".ndjson",
  ".yaml",
  ".yml",
  ".toml",
  ".ini",
  ".cfg",
  ".conf",
  ".properties",
  ".example",
]);

const CODE_EXTS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".rb",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".kts",
  ".scala",
  ".c",
  ".h",
  ".cc",
  ".cpp",
  ".cxx",
  ".hpp",
  ".hh",
  ".cs",
  ".php",
  ".swift",
  ".m",
  ".mm",
  ".sh",
  ".bash",
  ".zsh",
  ".fish",
  ".ps1",
  ".bat",
  ".cmd",
  ".sql",
  ".css",
  ".scss",
  ".less",
  ".sass",
  ".html",
  ".htm",
  ".xml",
  ".vue",
  ".svelte",
  ".lua",
  ".pl",
  ".r",
  ".dart",
  ".ex",
  ".exs",
  ".erl",
  ".hs",
  ".clj",
  ".cljs",
  ".nim",
  ".zig",
  ".asm",
  ".s",
  ".gradle",
  ".tf",
  ".proto",
  ".graphql",
  ".gql",
]);

/** 沒有副檔名但視為程式碼的檔名（小寫）。 */
const CODE_FILENAMES = new Set(["dockerfile", "makefile", "cmakelists.txt", "gemfile", "rakefile", "justfile", "procfile"]);

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tif", ".tiff", ".avif", ".heic", ".ico"]);
const AUDIO_EXTS = new Set([".mp3", ".wav", ".flac", ".ogg", ".oga", ".m4a", ".aac", ".opus", ".wma"]);
const VIDEO_EXTS = new Set([".mp4", ".mov", ".webm", ".mkv", ".avi", ".m4v", ".wmv", ".flv"]);

/** 已知的二進位格式（非文字／程式碼／媒體）：跳過，不當文字硬讀。 */
const BINARY_EXTS = new Set([
  ".zip",
  ".gz",
  ".tgz",
  ".bz2",
  ".xz",
  ".7z",
  ".rar",
  ".tar",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".bin",
  ".o",
  ".a",
  ".lib",
  ".class",
  ".jar",
  ".war",
  ".wasm",
  ".pdf",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".odt",
  ".ods",
  ".odp",
  ".db",
  ".sqlite",
  ".sqlite3",
  ".mdb",
  ".iso",
  ".dmg",
  ".img",
  ".vmdk",
  ".psd",
  ".ai",
  ".ttf",
  ".otf",
  ".woff",
  ".woff2",
  ".eot",
]);

/**
 * 系統／垃圾檔的**檔名**（一律小寫，比對時用 basename）：一律不索引。
 *
 * 這些不是機密（機密走 `roots/blacklist.ts` 的 `blocked`），而是沒有檢索價值的
 * 系統中繼資料；把它們當文字嵌入只會產生亂碼搜尋結果（例如 `.DS_Store`）。
 */
const JUNK_FILENAMES = new Set([
  ".ds_store",
  ".localized",
  ".spotlight-v100",
  ".trashes",
  "thumbs.db",
  "desktop.ini",
]);

/** 未完成下載的**副檔名**（一律小寫）：內容還不完整，跳過。 */
const JUNK_EXTS = new Set([".crdownload", ".part", ".partial", ".download"]);

/** AppleDouble 前綴（macOS 在非 HFS 卷上產生的中繼資料檔，例如 `._photo.jpg`）。 */
const APPLEDOUBLE_PREFIX = "._";

/**
 * 是否為系統／垃圾檔（檔名或副檔名層；**不讀內容**）。
 *
 * 這是第一道防線，供 `classifyFile` 使用；第二道是索引階段的前段內容偵測
 * （`indexer.looksBinary`），用來接住未來才出現、還沒列進清單的格式。
 */
export function isJunkFile(fileName: string): boolean {
  const lower = path.basename(fileName).toLowerCase();
  if (JUNK_FILENAMES.has(lower)) return true;
  if (lower.startsWith(APPLEDOUBLE_PREFIX)) return true;
  return JUNK_EXTS.has(path.extname(lower));
}

const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".avif": "image/avif",
  ".heic": "image/heic",
  ".ico": "image/x-icon",
};

/**
 * 由檔名推導種類；未知副檔名一律當文字（契約未明定，由本實作決定，見回報）。
 *
 * 系統／垃圾檔（`isJunkFile`）一律回 `binary`：呼叫端沿用既有的
 * `skipped: "unsupported-type"` 路徑，預覽與索引的行為因此一致。
 */
export function classifyFile(fileName: string): ChunkKind | "binary" {
  const lower = fileName.toLowerCase();
  if (isJunkFile(lower)) return "binary";
  const ext = path.extname(lower);
  if (IMAGE_EXTS.has(ext)) return "image";
  if (AUDIO_EXTS.has(ext)) return "audio";
  if (VIDEO_EXTS.has(ext)) return "video";
  if (BINARY_EXTS.has(ext)) return "binary";
  if (CODE_EXTS.has(ext)) return "code";
  if (TEXT_EXTS.has(ext)) return "text";
  if (CODE_FILENAMES.has(lower)) return "code";
  return "text";
}

/** 媒體檔的 MIME 型別；未知回傳 null。 */
export function mimeTypeFor(fileName: string): string | null {
  return IMAGE_MIME[path.extname(fileName.toLowerCase())] ?? null;
}

/** 相對路徑一律轉成 `/` 分隔。 */
function toPosix(relative: string): string {
  return relative.split(path.sep).join("/");
}

function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";
}

function isUnreadable(error: unknown): boolean {
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  return code === "EACCES" || code === "EPERM";
}

/**
 * `.gitignore` 路徑存在、但本身是目錄時，`fs.readFile` 會回 `EISDIR`。
 * 與 `isUnreadable`（權限問題）語意不同，故獨立判斷。
 */
function isEisdir(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "EISDIR";
}

/**
 * 取消檢查（沿用 `@mnemoshelf/core` indexer 的 `throwIfAborted` 慣例）。
 *
 * 優先使用 `AbortSignal.throwIfAborted()`；執行環境沒有時退回手動判斷。
 */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal === undefined) return;
  if (typeof signal.throwIfAborted === "function") {
    signal.throwIfAborted();
    return;
  }
  if (signal.aborted) {
    const reason = signal.reason;
    if (reason instanceof Error) throw reason;
    const error = new Error("掃描已取消");
    error.name = "AbortError";
    throw error;
  }
}

/**
 * 讀取 root 內的 `.gitignore`；不存在、不可讀，或本身是目錄時回傳 null。
 *
 * `.gitignore` 只是輔助檔，讀不到不該讓整個預覽失敗，因此下列情況一律視為
 * 「沒有可讀的 .gitignore」（空規則集）：不存在（`ENOENT`）、權限不足
 * （`EACCES`／`EPERM`）、同名項目是目錄（`EISDIR`）。其他錯誤維持拋出。
 */
async function loadGitignore(rootAbs: string): Promise<ReturnType<typeof ignore> | null> {
  try {
    const content = await fs.readFile(path.join(rootAbs, ".gitignore"), "utf8");
    return ignore().add(content);
  } catch (error) {
    if (isEnoent(error) || isUnreadable(error) || isEisdir(error)) return null;
    throw error;
  }
}

interface GuardOutcome {
  ok: boolean;
  abs: string;
  rel: string;
  reason: SkipReason | null;
}

/**
 * 每個檔案／目錄都經過 `resolveInsideRoot`：
 * 指向 root 外或 dangling 的 symlink 會拋 `PathOutsideRootError`（記 `unresolved-symlink`），
 * 命中黑名單會拋 `PathBlockedError`（記 `blocked`）。
 */
async function guardedResolve(guardRoot: Root, abs: string): Promise<GuardOutcome> {
  try {
    const resolved = await resolveInsideRoot([guardRoot], abs);
    return { ok: true, abs: resolved.abs, rel: resolved.rel, reason: null };
  } catch (error) {
    if (error instanceof PathOutsideRootError) {
      return { ok: false, abs, rel: "", reason: "unresolved-symlink" };
    }
    if (error instanceof PathBlockedError) {
      return { ok: false, abs, rel: "", reason: "blocked" };
    }
    throw error;
  }
}

/**
 * 走訪 root 內的檔案。
 *
 * 只列舉、不讀取任何檔案內容（`.gitignore` 除外），因此預覽可安全共用。
 * 不跟隨任何 symlink 目錄（避免迴圈）；symlink 指向的檔案若仍在 root 內則納入。
 */
export async function walkRoot(root: ScanRoot, options: ScanOptions = {}): Promise<ScanResult> {
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const signal = options.signal;
  const rootAbs = path.resolve(root.path);
  const guardRoot: Root = {
    id: 0,
    path: root.path,
    mode: "index",
    modalities: root.modalities,
    include: root.include,
    exclude: root.exclude,
    respectGitignore: root.respectGitignore,
    watch: false,
    createdAt: "",
  };
  const gitignore = root.respectGitignore ? await loadGitignore(rootAbs) : null;

  const files: ScanEntry[] = [];
  const skipped: SkippedEntry[] = [];

  const isIgnoredDir = (rel: string): boolean => {
    if (matchesAnyGlob(rel, root.exclude)) return true;
    return gitignore?.ignores(`${rel}/`) ?? false;
  };

  const recordFile = (rel: string, abs: string, size: number): void => {
    const kind = classifyFile(path.posix.basename(rel));
    if (kind === "binary") {
      skipped.push({ relPath: rel, reason: "unsupported-type" });
      return;
    }
    if (root.include.length > 0 && !matchesAnyGlob(rel, root.include)) {
      skipped.push({ relPath: rel, reason: "excluded" });
      return;
    }
    if (matchesAnyGlob(rel, root.exclude)) {
      skipped.push({ relPath: rel, reason: "excluded" });
      return;
    }
    if (gitignore?.ignores(rel)) {
      skipped.push({ relPath: rel, reason: "excluded" });
      return;
    }
    if (!root.modalities.includes(kind)) {
      skipped.push({ relPath: rel, reason: "modality-off" });
      return;
    }
    if (size > maxFileBytes) {
      skipped.push({ relPath: rel, reason: "too-large" });
      return;
    }
    files.push({ relPath: rel, absPath: abs, kind, size, mimeType: kind === "image" ? mimeTypeFor(rel) : null });
  };

  const visit = async (absDir: string): Promise<void> => {
    // 每個目錄進入時檢查一次：大樹下取消才能即時生效，不必等整輪走訪結束。
    throwIfAborted(signal);
    let entries: Dirent[];
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true });
    } catch (error) {
      // 無法讀取的目錄直接略過，不讓單一目錄中斷整個掃描。
      if (isEnoent(error) || isUnreadable(error)) return;
      throw error;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    for (const entry of entries) {
      // 每個檔案／子目錄項目迭代前檢查一次（含遞迴進入子目錄前）。
      throwIfAborted(signal);
      const abs = path.join(absDir, entry.name);
      const rel = toPosix(path.relative(rootAbs, abs));

      // `.git` 一律不掃（與一般工具一致），目錄本身不記入 skipped。
      if (entry.isDirectory() && entry.name === ".git") continue;

      if (entry.isDirectory()) {
        const guard = await guardedResolve(guardRoot, abs);
        if (!guard.ok) {
          skipped.push({ relPath: rel, reason: guard.reason ?? "blocked" });
          continue;
        }
        if (isIgnoredDir(rel)) continue;
        await visit(abs);
        continue;
      }

      if (entry.isSymbolicLink()) {
        const guard = await guardedResolve(guardRoot, abs);
        if (!guard.ok) {
          skipped.push({ relPath: rel, reason: guard.reason ?? "unresolved-symlink" });
          continue;
        }
        let stats: Stats;
        try {
          stats = await fs.stat(guard.abs);
        } catch (error) {
          if (isEnoent(error)) {
            // 指向 root 內但目標不存在的 dangling symlink。
            skipped.push({ relPath: rel, reason: "unresolved-symlink" });
            continue;
          }
          if (isUnreadable(error)) {
            skipped.push({ relPath: rel, reason: "unresolved-symlink" });
            continue;
          }
          throw error;
        }
        if (stats.isDirectory()) {
          // 不跟隨 symlink 目錄（避免 symlink 迴圈）。
          skipped.push({ relPath: rel, reason: "symlink-dir" });
          continue;
        }
        if (!stats.isFile()) {
          skipped.push({ relPath: rel, reason: "not-a-file" });
          continue;
        }
        recordFile(rel, guard.abs, stats.size);
        continue;
      }

      if (!entry.isFile()) {
        // FIFO、socket、裝置檔等。
        skipped.push({ relPath: rel, reason: "not-a-file" });
        continue;
      }

      const guard = await guardedResolve(guardRoot, abs);
      if (!guard.ok) {
        skipped.push({ relPath: rel, reason: guard.reason ?? "blocked" });
        continue;
      }
      let stats: Stats;
      try {
        stats = await fs.stat(abs);
      } catch (error) {
        if (isEnoent(error) || isUnreadable(error)) {
          skipped.push({ relPath: rel, reason: "unresolved-symlink" });
          continue;
        }
        throw error;
      }
      recordFile(rel, guard.abs, stats.size);
    }
  };

  await visit(rootAbs);
  return { files, skipped };
}
