import { promises as fs, type Stats } from "node:fs";
import path from "node:path";
import { PathBlockedError, PathOutsideRootError, RootTooBroadError } from "../errors.js";
import { blockedReason, isBlocked } from "./blacklist.js";
import type { Root } from "../ports/types.js";

export interface ResolvedPath {
  root: Root;
  /** 解析後（跟隨所有 symlink）的絕對路徑。 */
  abs: string;
  /** 相對 root 的路徑。 */
  rel: string;
}

/** symlink 解析層數上限（對齊 Linux 的 ELOOP 上限 40），用來自行偵測 symlink 迴圈。 */
export const MAX_SYMLINK_DEPTH = 40;

/**
 * 檔案系統是否大小寫不敏感。
 * Windows 與 macOS 預設不敏感；Linux 敏感。比較時據此決定是否轉小寫。
 */
export function defaultCaseInsensitive(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32" || platform === "darwin";
}

/**
 * 判斷 targetAbs 是否落在 rootAbs 之內（含 rootAbs 本身）。
 * 以路徑邊界判斷：`/a/b` 不是 `/a/bc` 的上層；`..foo` 只是名字以兩個點開頭的一般檔案，
 * 仍在 root 內（只有真正的上層 `..` 才算外面）。
 */
export function isInsideRoot(rootAbs: string, targetAbs: string, caseInsensitive = defaultCaseInsensitive()): boolean {
  const root = caseInsensitive ? rootAbs.toLowerCase() : rootAbs;
  const target = caseInsensitive ? targetAbs.toLowerCase() : targetAbs;
  if (target === root) return true;

  const rel = path.relative(root, target);
  if (rel === "") return true;
  if (path.isAbsolute(rel)) return false; // 不同磁碟機代號等情形
  return rel !== ".." && !rel.startsWith(`..${path.sep}`);
}

function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";
}

/** lstat；**只有 ENOENT 代表「還不存在」而回傳 null**，其餘錯誤（EACCES、ELOOP、ENOTDIR…）一律拋出。 */
async function lstatIfExists(target: string): Promise<Stats | null> {
  try {
    return await fs.lstat(target);
  } catch (error) {
    if (isEnoent(error)) return null;
    throw error;
  }
}

/** realpath；只在 ENOENT 時退回原路徑（用於「已確認存在」的前綴，屬競態下的保險）。 */
async function realpathOrSelf(target: string): Promise<string> {
  try {
    return await fs.realpath(target);
  } catch (error) {
    if (isEnoent(error)) return target;
    throw error;
  }
}

/**
 * 逐段解析路徑。
 *
 * 每一段都先 `lstat`：
 * - 是 symlink → `readlink` 取得目標後**繼續解析該目標**（含目標本身的 symlink），再接回剩餘片段；
 * - 不存在（ENOENT）→ 把剩下的片段接在「已完整解析的真實前綴」之後回傳；
 * - 其他錯誤 → 往上拋（不當成缺檔）。
 *
 * 因為每一段都被跟隨，回傳的路徑不含任何未解析的 symlink 片段；其中「指向 root 外、
 * 但目標尚不存在」的 dangling symlink 會解析成 root 外的路徑，交由呼叫端拒絕。
 */
async function resolveSegments(absolute: string, depth: number): Promise<string> {
  const root = path.parse(absolute).root;
  const segments = absolute.slice(root.length).split(path.sep).filter((segment) => segment.length > 0);
  let resolved = root;

  for (let index = 0; index < segments.length; index += 1) {
    const candidate = path.join(resolved, segments[index]);
    const stats = await lstatIfExists(candidate);

    if (stats === null) {
      // 這一段（含之後）都還不存在：接在已解析的真實前綴之後。
      const base = await realpathOrSelf(resolved);
      return path.join(base, ...segments.slice(index));
    }

    if (stats.isSymbolicLink()) {
      if (depth >= MAX_SYMLINK_DEPTH) {
        throw new Error(`symlink 解析層數超過上限（${MAX_SYMLINK_DEPTH}），可能有 symlink 迴圈`);
      }
      const link = await fs.readlink(candidate);
      // readlink 的目標若是相對路徑，是相對於 symlink 所在的目錄。
      const linkTarget = path.resolve(resolved, link);
      const rest = segments.slice(index + 1);
      return resolveSegments(path.join(linkTarget, ...rest), depth + 1);
    }

    resolved = candidate;
  }

  return realpathOrSelf(resolved);
}

/**
 * 解析路徑的真實位置（跟隨 symlink）。目標不存在時，解析其最近的存在上層，
 * 再把剩下的片段接回去（新檔案在 root 內時不會因為還不存在就被拒）。
 *
 * 只有 ENOENT 才算「不存在」：EACCES、ENOTDIR、自身的 symlink 迴圈等都會拋出，
 * 不會被誤當成缺檔。
 */
export async function realpathAllowMissing(target: string): Promise<string> {
  return resolveSegments(path.resolve(target), 0);
}

/** root 的真實路徑；root 已不存在時退回儲存的路徑（僅供比對，不會被誤判為逃脫）。 */
async function rootRealpath(root: Root): Promise<string> {
  try {
    return await fs.realpath(path.resolve(root.path));
  } catch {
    return path.resolve(root.path);
  }
}

/**
 * 把請求的路徑解析成 root 內的絕對路徑。
 *
 * 依序檢查：
 * 1. 逐段解析（跟隨 symlink；目標不存在時解析最近存在上層再接回剩下片段）。
 * 2. 結果必須落在某個 root 內（路徑邊界比較；Windows／macOS 以小寫比較）。
 * 3. 黑名單：**相對路徑與整條絕對路徑都會檢查**。
 *
 * 第 3 點的絕對路徑檢查是刻意行為：若 root 本身位於黑名單目錄之下（例如 root 選在
 * `.mozilla/`、`*.key/` 這類敏感目錄內），則整個 root 下的存取都會被擋（PathBlockedError）。
 * 敏感目錄底下的資料本來就不該被索引或回傳，因此不做例外放行。
 *
 * 失敗時拋出 PathOutsideRootError 或 PathBlockedError。
 */
export async function resolveInsideRoot(roots: Root[], requested: string): Promise<ResolvedPath> {
  if (roots.length === 0) throw new PathOutsideRootError(requested);

  const abs = await realpathAllowMissing(requested);
  const caseInsensitive = defaultCaseInsensitive();

  for (const root of roots) {
    const rootAbs = await rootRealpath(root);
    if (!isInsideRoot(rootAbs, abs, caseInsensitive)) continue;

    const rel = path.relative(rootAbs, abs);
    if (isBlocked(rel) || isBlocked(abs)) {
      const reason = blockedReason(rel) ?? blockedReason(abs) ?? "黑名單";
      throw new PathBlockedError(rel === "" ? path.basename(abs) : rel, reason);
    }
    return { root, abs, rel };
  }

  throw new PathOutsideRootError(requested);
}

/**
 * root 加入前的寬度檢查：拒絕檔案系統根目錄與家目錄本身。
 * 只做拒絕，不做使用者互動（提示與引導由 UI 負責）。
 */
export function assertRootAllowed(candidate: string, opts: { homeDir: string }): void {
  const resolved = path.resolve(candidate);
  const rootOfCandidate = path.parse(resolved).root;

  if (resolved === rootOfCandidate) {
    throw new RootTooBroadError(resolved);
  }

  const caseInsensitive = defaultCaseInsensitive();
  const home = path.resolve(opts.homeDir);
  const normalize = (p: string): string => (caseInsensitive ? p.toLowerCase() : p);

  if (normalize(resolved) === normalize(home)) {
    throw new RootTooBroadError(resolved);
  }
}
