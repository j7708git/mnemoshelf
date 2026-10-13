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
 * `unresolved-symlink`，另補三個由本實作決定的具名原因（見下方各處註解）。
 */
export type SkipReason =
  | "blocked"
  | "excluded"
  | "modality-off"
  | "too-large"
  | "unresolved-symlink"
  | "symlink-dir"
  | "unsupported-type"
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

/** 由檔名推導種類；未知副檔名一律當文字（契約未明定，由本實作決定，見回報）。 */
export function classifyFile(fileName: string): ChunkKind | "binary" {
  const lower = fileName.toLowerCase();
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

/** 讀取 root 內的 `.gitignore`；不存在或不可讀時回傳 null。 */
async function loadGitignore(rootAbs: string): Promise<ReturnType<typeof ignore> | null> {
  try {
    const content = await fs.readFile(path.join(rootAbs, ".gitignore"), "utf8");
    return ignore().add(content);
  } catch (error) {
    if (isEnoent(error) || isUnreadable(error)) return null;
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
