import { promises as fs } from "node:fs";
import path from "node:path";
import { PathBlockedError, PathOutsideRootError, RootTooBroadError } from "../errors.js";
import { blockedReason, isBlocked } from "./blacklist.js";
import type { Root } from "../ports/types.js";

export interface ResolvedPath {
  root: Root;
  /** 解析後（跟隨 symlink）的絕對路徑。 */
  abs: string;
  /** 相對 root 的路徑。 */
  rel: string;
}

/**
 * 檔案系統是否大小寫不敏感。
 * Windows 與 macOS 預設不敏感；Linux 敏感。比較時據此決定是否轉小寫。
 */
export function defaultCaseInsensitive(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32" || platform === "darwin";
}

/**
 * 判斷 targetAbs 是否落在 rootAbs 之內（含 rootAbs 本身）。
 * 以路徑邊界判斷：`/a/b` 不是 `/a/bc` 的上層。
 */
export function isInsideRoot(rootAbs: string, targetAbs: string, caseInsensitive = defaultCaseInsensitive()): boolean {
  const root = caseInsensitive ? rootAbs.toLowerCase() : rootAbs;
  const target = caseInsensitive ? targetAbs.toLowerCase() : targetAbs;
  if (target === root) return true;
  const rel = path.relative(root, target);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * 解析路徑的真實位置（跟隨 symlink）。目標不存在時，解析其最近的存在上層，
 * 再把剩下的片段接回去（新檔案在 root 內時不會因為還不存在就被拒）。
 */
export async function realpathAllowMissing(target: string): Promise<string> {
  let current = path.resolve(target);
  const missing: string[] = [];

  for (;;) {
    try {
      const real = await fs.realpath(current);
      return missing.length > 0 ? path.join(real, ...missing) : real;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        // 已到檔案系統根目錄仍不存在（實務上不會發生）
        return path.join(current, ...missing);
      }
      missing.unshift(path.basename(current));
      current = parent;
    }
  }
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
 * 1. 以 realpath 解析（目標不存在時解析最近存在上層再接回剩下片段）。
 * 2. 結果必須落在某個 root 內（路徑邊界比較；Windows／macOS 以小寫比較）。
 * 3. 相對路徑不得命中黑名單。
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
      throw new PathBlockedError(rel === "" ? path.basename(abs) : rel, blockedReason(rel) ?? "黑名單");
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
