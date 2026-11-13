/**
 * 唯讀資料夾瀏覽服務（供瀏覽器版「瀏覽…」資料夾選擇器使用）。
 *
 * 安全界線：
 * - **只列子資料夾名稱與路徑**，絕不回傳檔案項目、絕不讀取檔案內容、絕不寫入磁碟或記錄瀏覽歷史。
 * - 預設限縮在 `homeDir` 範圍內並套用 `@mnemoshelf/core` 的敏感路徑黑名單與 `realpath` symlink 守衛。
 * - 使用者可透過設定（`MNEMOSHELF_BROWSE_SCOPE`／`MNEMOSHELF_BROWSE_ROOTS`／
 *   `MNEMOSHELF_BROWSE_RESPECT_BLACKLIST`／`MNEMOSHELF_HOST`／`MNEMOSHELF_ALLOW_ANONYMOUS`）
 *   覆寫預設限制，風險由使用者自行承擔；回應會附上 `policy` 摘要供 UI 顯示風險提示。
 */
import { promises as fs, type Dirent } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  blockedReason,
  defaultCaseInsensitive,
  isBlocked,
  isInsideRoot,
  PathBlockedError,
  PathOutsideRootError,
  realpathAllowMissing,
} from "@mnemoshelf/core";
import { isLoopbackBindHost, type BrowseScope } from "../config.js";
import { NotFoundError, ValidationError } from "../errors.js";

/** 資料夾清單項目（僅含目錄，不含檔案）。 */
export interface BrowseDirectoryItem {
  name: string;
  path: string;
}

/** 側欄快速位置項目。 */
export interface BrowseQuickLocation {
  id: string;
  label: string;
  path: string;
}

/** 麵包屑片段。 */
export interface BrowseBreadcrumbSegment {
  label: string;
  path: string;
}

/** 生效中的存取與瀏覽策略摘要（不含 token 或敏感路徑）。 */
export interface BrowseAccessPolicy {
  host: string;
  nonLoopbackBind: boolean;
  allowAnonymous: boolean;
  browseScope: BrowseScope;
  respectBlacklist: boolean;
  /** 只要任一策略放寬於安全預設（loopback + token + home + blacklist）即為 true。 */
  relaxed: boolean;
}

/** `GET /fs/browse` 的回應。 */
export interface BrowseDirectoriesResponse {
  currentPath: string;
  parentPath: string | null;
  breadcrumbs: BrowseBreadcrumbSegment[];
  directories: BrowseDirectoryItem[];
  quickLocations: BrowseQuickLocation[];
  policy: BrowseAccessPolicy;
}

/** 瀏覽資料夾設定（可由 `createRestApp` 與環境變數注入）。 */
export interface FolderBrowseOptions {
  homeDir?: string;
  host: string;
  allowAnonymous: boolean;
  browseScope: BrowseScope;
  browseRoots: readonly string[];
  browseRespectBlacklist: boolean;
}

/** 計算供 UI 顯示風險標示的策略摘要。 */
export function summarizeAccessPolicy(options: Omit<FolderBrowseOptions, "homeDir" | "browseRoots">): BrowseAccessPolicy {
  const nonLoopbackBind = !isLoopbackBindHost(options.host);
  const relaxed =
    nonLoopbackBind ||
    options.allowAnonymous ||
    options.browseScope !== "home" ||
    !options.browseRespectBlacklist;
  return {
    host: options.host,
    nonLoopbackBind,
    allowAnonymous: options.allowAnonymous,
    browseScope: options.browseScope,
    respectBlacklist: options.browseRespectBlacklist,
    relaxed,
  };
}

/** 驗證目錄是否位於允許的根目錄清單內；回傳命中的根（`unrestricted` 為 `null`）。 */
function findMatchingAllowedRoot(
  targetAbs: string,
  allowedRootsAbs: readonly string[],
  caseInsensitive: boolean,
): string | null {
  let best: string | null = null;
  for (const rootAbs of allowedRootsAbs) {
    if (isInsideRoot(rootAbs, targetAbs, caseInsensitive)) {
      if (best === null || rootAbs.length > best.length) {
        best = rootAbs;
      }
    }
  }
  return best;
}

/** 判斷 `dirent` 是否為目錄（含指向目錄的 symlink；壞掉的連結或無權限回 false）。 */
async function isDirectoryEntry(entry: Dirent, absPath: string): Promise<boolean> {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  try {
    const stats = await fs.stat(absPath);
    return stats.isDirectory();
  } catch {
    return false;
  }
}

/** 檢查目錄是否存在、可讀取且為目錄；轉換成具名 HTTP 錯誤。 */
async function assertAccessibleDirectory(absPath: string): Promise<void> {
  let stats;
  try {
    stats = await fs.stat(absPath);
  } catch (error) {
    const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
    if (code === "ENOENT" || code === "ENOTDIR") throw new NotFoundError("路徑");
    if (code === "EACCES" || code === "EPERM") {
      throw new PathBlockedError(path.basename(absPath) || "目錄", "目前帳戶沒有權限讀取此目錄");
    }
    throw error;
  }
  if (!stats.isDirectory()) {
    throw new ValidationError("path", "指定的路徑不是資料夾");
  }
}

/** 依允許的錨點切出麵包屑（純路徑運算，使用 `node:path` 不硬寫分隔符）。 */
function buildBreadcrumbs(currentAbs: string, anchorRootAbs: string | null): BrowseBreadcrumbSegment[] {
  const rootAnchor = anchorRootAbs ?? path.parse(currentAbs).root;
  const rel = path.relative(rootAnchor, currentAbs);
  const rootLabel = path.basename(rootAnchor) || rootAnchor;
  const segments: BrowseBreadcrumbSegment[] = [{ label: rootLabel, path: rootAnchor }];
  if (rel === "" || rel === ".") return segments;

  const parts = rel.split(path.sep).filter((part) => part !== "" && part !== ".");
  let cursor = rootAnchor;
  for (const part of parts) {
    cursor = path.join(cursor, part);
    segments.push({ label: part, path: cursor });
  }
  return segments;
}

/** 建立符合現行範圍與黑名單策略的側欄快速位置清單。 */
async function buildQuickLocations(
  homeAbs: string,
  allowedRootsAbs: readonly string[],
  options: FolderBrowseOptions,
  currentAbs: string,
  caseInsensitive: boolean,
): Promise<BrowseQuickLocation[]> {
  const candidates: BrowseQuickLocation[] = [
    { id: "home", label: "家目錄", path: homeAbs },
    { id: "desktop", label: "桌面", path: path.join(homeAbs, "Desktop") },
    { id: "documents", label: "文件", path: path.join(homeAbs, "Documents") },
    { id: "downloads", label: "下載", path: path.join(homeAbs, "Downloads") },
  ];

  if (options.browseScope === "custom") {
    for (const [idx, root] of options.browseRoots.entries()) {
      const resolved = await realpathAllowMissing(path.resolve(root));
      candidates.push({
        id: `custom-${idx}`,
        label: path.basename(resolved) || resolved,
        path: resolved,
      });
    }
  } else if (options.browseScope === "unrestricted") {
    const fsRoot = path.parse(currentAbs).root;
    candidates.push({ id: "fs-root", label: fsRoot, path: fsRoot });
  }

  const seen = new Set<string>();
  const valid: BrowseQuickLocation[] = [];
  for (const item of candidates) {
    const resolved = await realpathAllowMissing(path.resolve(item.path));
    const dedupeKey = caseInsensitive ? resolved.toLowerCase() : resolved;
    if (seen.has(dedupeKey)) continue;
    if (allowedRootsAbs.length > 0 && findMatchingAllowedRoot(resolved, allowedRootsAbs, caseInsensitive) === null) {
      continue;
    }
    if (options.browseRespectBlacklist && (isBlocked(item.path) || isBlocked(resolved))) {
      continue;
    }
    try {
      const stats = await fs.stat(resolved);
      if (!stats.isDirectory()) continue;
    } catch {
      continue;
    }
    seen.add(dedupeKey);
    valid.push({ ...item, path: resolved });
  }
  return valid;
}

/**
 * 列出指定目錄的**直接子資料夾名稱**（不讀檔內容、不列檔案、不記錄歷史）。
 *
 * `requestedPath` 為 `null` 或空字串時，從目前範圍的起點目錄開始。
 */
export async function browseDirectories(
  requestedPath: string | null,
  options: FolderBrowseOptions,
): Promise<BrowseDirectoriesResponse> {
  const caseInsensitive = defaultCaseInsensitive();
  const homeRaw = path.resolve(options.homeDir ?? os.homedir());
  const homeAbs = await realpathAllowMissing(homeRaw);

  const allowedRootsAbs: string[] = [];
  if (options.browseScope === "home") {
    allowedRootsAbs.push(homeAbs);
  } else if (options.browseScope === "custom") {
    for (const r of options.browseRoots) {
      allowedRootsAbs.push(await realpathAllowMissing(path.resolve(r)));
    }
  }

  if (requestedPath !== null && requestedPath.includes("\0")) {
    throw new ValidationError("path", "不得包含 NUL 位元組");
  }

  const trimmed = requestedPath === null ? "" : requestedPath.trim();
  let candidateRaw: string;
  if (trimmed === "") {
    candidateRaw = allowedRootsAbs.length > 0 ? allowedRootsAbs[0]! : homeAbs;
  } else {
    if (!path.isAbsolute(trimmed)) {
      throw new ValidationError("path", "必須是絕對路徑");
    }
    candidateRaw = path.resolve(trimmed);
  }

  const resolvedAbs = await realpathAllowMissing(candidateRaw);

  // 先驗證存取範圍，再碰檔案系統，避免透過 404 探測允許範圍外路徑是否存在。
  let anchorRoot: string | null = null;
  if (allowedRootsAbs.length > 0) {
    anchorRoot = findMatchingAllowedRoot(resolvedAbs, allowedRootsAbs, caseInsensitive);
    if (anchorRoot === null) {
      throw new PathOutsideRootError("此路徑超出目前允許瀏覽的資料夾範圍");
    }
  }

  if (options.browseRespectBlacklist && (isBlocked(candidateRaw) || isBlocked(resolvedAbs))) {
    const reason = blockedReason(candidateRaw) ?? blockedReason(resolvedAbs) ?? "敏感路徑黑名單";
    throw new PathBlockedError(path.basename(resolvedAbs) || "目錄", reason);
  }

  await assertAccessibleDirectory(resolvedAbs);

  let dirents: Dirent[];
  try {
    dirents = await fs.readdir(resolvedAbs, { withFileTypes: true });
  } catch (error) {
    const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
    if (code === "EACCES" || code === "EPERM") {
      throw new PathBlockedError(path.basename(resolvedAbs) || "目錄", "目前帳戶沒有權限讀取此目錄");
    }
    throw error;
  }

  const directories: BrowseDirectoryItem[] = [];
  for (const dirent of dirents) {
    if (dirent.name === ".git") continue;
    const childAbs = path.join(resolvedAbs, dirent.name);
    if (!(await isDirectoryEntry(dirent, childAbs))) continue;

    const childReal = await realpathAllowMissing(childAbs);
    if (
      allowedRootsAbs.length > 0 &&
      findMatchingAllowedRoot(childReal, allowedRootsAbs, caseInsensitive) === null
    ) {
      continue;
    }
    if (options.browseRespectBlacklist && (isBlocked(childAbs) || isBlocked(childReal))) {
      continue;
    }
    directories.push({ name: dirent.name, path: childReal });
  }

  directories.sort((a, b) => a.name.localeCompare(b.name, "zh-Hant"));

  // 計算合法的上一層：不能退到允許範圍外或命中黑名單的目錄。
  const candidateParent = path.dirname(resolvedAbs);
  let parentPath: string | null = null;
  if (candidateParent !== resolvedAbs) {
    const parentInScope =
      allowedRootsAbs.length === 0 ||
      findMatchingAllowedRoot(candidateParent, allowedRootsAbs, caseInsensitive) !== null;
    const parentAllowed = !options.browseRespectBlacklist || !isBlocked(candidateParent);
    if (parentInScope && parentAllowed) {
      parentPath = candidateParent;
    }
  }

  const quickLocations = await buildQuickLocations(
    homeAbs,
    allowedRootsAbs,
    options,
    resolvedAbs,
    caseInsensitive,
  );

  return {
    currentPath: resolvedAbs,
    parentPath,
    breadcrumbs: buildBreadcrumbs(resolvedAbs, anchorRoot),
    directories,
    quickLocations,
    policy: summarizeAccessPolicy(options),
  };
}
