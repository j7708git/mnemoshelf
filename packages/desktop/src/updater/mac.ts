/**
 * macOS 的更新檢查（B 案）：**不載入第三方自動更新套件、不實例化 macOS 更新器**。
 *
 * 原因：macOS 的自動更新（Squirrel.Mac）要求 App 有有效的 Developer ID 簽章與
 * notarize；本專案只有 ad-hoc 簽章（見 `electron-builder.yml`）。因此 macOS 只做
 * 「用 GitHub API 查最新 Release → 告訴 UI 有新版本與下載頁」，
 * 由使用者按按鈕後以 `shell.openExternal` 開啟下載頁。
 *
 * 這個模組不 import electron：`net.fetch` 由 `main.ts` 注入（測試用 fake fetch）。
 */
import {
  classifyHttpStatus,
  classifyUpdaterError,
  UpdaterFault,
  type UpdaterErrorInfo,
} from "./errors.js";
import { compareVersions, normalizeVersion } from "./semver.js";

/** fetch 回應的最小介面（Electron `net.fetch` 與測試 fake 都符合）。 */
export interface FetchResponseLike {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}

/** 注入的 fetch（main 傳 `net.fetch` 的包裝）。 */
export type FetchLike = (url: string) => Promise<FetchResponseLike>;

export interface MacCheckOptions {
  currentVersion: string;
  owner: string;
  repo: string;
  fetchImpl: FetchLike;
}

export interface MacReleaseInfo {
  /** 正規化版本（不含 `v`）。 */
  version: string;
  /** 公開的 Release 頁面（`html_url` 或由 tag 組出）。 */
  releaseUrl: string;
  releaseNotes: string | null;
}

export interface MacCheckResult {
  /** 有新版本時才有值。 */
  release: MacReleaseInfo | null;
}

const MAX_RELEASE_NOTES_LENGTH = 4_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeReleaseNotes(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  return trimmed.length > MAX_RELEASE_NOTES_LENGTH ? `${trimmed.slice(0, MAX_RELEASE_NOTES_LENGTH)}…` : trimmed;
}

/**
 * 只接受 https 的 GitHub Release 頁面。
 *
 * `html_url` 來自 GitHub API，但 IPC 狀態最終會進 renderer；在呼叫
 * `shell.openExternal` 前仍要確認協議與主機，避免被導到其他位置。
 */
export function isAllowedReleaseUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  if (parsed.hostname !== "github.com" && parsed.hostname !== "www.github.com") return false;
  if (parsed.username !== "" || parsed.password !== "") return false;
  return parsed.pathname.startsWith("/");
}

/** 由 owner／repo／版本組出 Release 頁（`html_url` 缺失時使用）。 */
export function releasePageUrl(owner: string, repo: string, version: string): string {
  return `https://github.com/${owner}/${repo}/releases/tag/v${version}`;
}

/**
 * 查詢 GitHub 最新 Release 並比較版本。
 *
 * 只回「有新版本」與下載頁；不做下載、不驗簽章（B 案）。
 * 錯誤一律是 `UpdaterFault`（穩定代碼）：rate limit、not-found、offline、invalid-version。
 */
export async function checkMacRelease(options: MacCheckOptions): Promise<MacCheckResult> {
  const current = normalizeVersion(options.currentVersion);
  if (current === null) {
    throw new UpdaterFault("invalid-version", "目前應用程式版本格式無法比較。");
  }

  const url = `https://api.github.com/repos/${encodeURIComponent(options.owner)}/${encodeURIComponent(options.repo)}/releases/latest`;
  let response: FetchResponseLike;
  try {
    response = await options.fetchImpl(url);
  } catch (error) {
    if (error instanceof UpdaterFault) throw error;
    const info = classifyUpdaterError(error, "offline");
    throw new UpdaterFault(info.code, info.message);
  }

  const statusError: UpdaterErrorInfo | null = classifyHttpStatus(response.status);
  if (statusError !== null) throw new UpdaterFault(statusError.code, statusError.message);
  if (!response.ok) throw new UpdaterFault("check-failed");

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new UpdaterFault("check-failed", "GitHub 回應不是合法的 JSON。");
  }
  if (!isRecord(body)) throw new UpdaterFault("check-failed");

  // `/releases/latest` 理論上不會回 draft／prerelease，但 API 形狀仍明示這些欄位；
  // 若真的拿到，寧可當成「沒有更新」也不要建議使用者安裝非正式版。
  if (body.draft === true || body.prerelease === true) return { release: null };

  const tag = typeof body.tag_name === "string" ? body.tag_name : null;
  const version = tag === null ? null : normalizeVersion(tag);
  if (version === null) throw new UpdaterFault("invalid-version");

  const comparison = compareVersions(version, current);
  if (comparison === null) throw new UpdaterFault("invalid-version");
  if (comparison <= 0) return { release: null };

  const htmlUrl = typeof body.html_url === "string" ? body.html_url : null;
  const releaseUrl =
    htmlUrl !== null && isAllowedReleaseUrl(htmlUrl)
      ? htmlUrl
      : releasePageUrl(options.owner, options.repo, version);

  return {
    release: {
      version,
      releaseUrl,
      releaseNotes: normalizeReleaseNotes(body.body),
    },
  };
}
