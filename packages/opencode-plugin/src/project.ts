/**
 * 專案名稱解析（mnemoshelf 的 `project` 欄位）與記憶範圍判定。
 *
 * 優先序：
 * 1. plugin option `project`
 * 2. 環境變數 `MNEMOSHELF_PROJECT`
 * 3. `path.basename(location.project.canonical || location.project.directory)`
 * 4. `path.basename(location.directory)`
 *
 * 解析不到就 **fail closed**（回 `null`）：不要送空字串，也不要送 `"global"`——
 * server 對 `project:"global"` 只會回 global scope，會悄悄縮小召回範圍。只有目錄名稱
 * 真的叫 `global` 時才會自然得到 `"global"`。
 *
 * **OpenChamber 聊天 session**（`…/openchamber/chats/<日期>/session-<uuid>/`）不屬於任何
 * 專案：`resolveProjectTarget` 回 `global-chat`，呼叫端據此使用 `scope:"global"`、不帶
 * `project`。這是唯一「不當成專案名」的情形；option／env 明確指定時仍以明確值為準。
 *
 * 不得由 repo 內容（例如 `.mnemoshelf.json`）決定：一個 clone 下來的 repo 不應該能改變
 * 記憶路由。
 */
import path from "node:path";

/** 專案名長度上限（與 server 的 metadata 上限一致）。 */
export const MAX_PROJECT_CHARS = 200;

/** NFKC、trim、把分隔符與空白換成 `-`、截到 200 字元；保留 CJK。 */
export function normalizeProjectName(raw: string | undefined): string | null {
  if (typeof raw !== "string") return null;
  const normalized = raw
    .normalize("NFKC")
    .trim()
    .replace(/[\\/\s]+/g, "-")
    .slice(0, MAX_PROJECT_CHARS);
  return normalized === "" ? null : normalized;
}

/** 跨平台 basename：在 Windows 上才讓 node:path 使用 win32 規則。 */
function basename(value: string | undefined, platform: NodeJS.Platform): string | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  return (platform === "win32" ? path.win32 : path.posix).basename(value.trim());
}

export interface ProjectNameInput {
  /** plugin options `project`。 */
  optionProject?: string;
  /** `MNEMOSHELF_PROJECT`。 */
  envProject?: string;
  /** `ctx.location.project.canonical`（main checkout 根）。 */
  canonical?: string;
  /** `ctx.location.project.directory`（worktree 根）。 */
  projectDirectory?: string;
  /** `ctx.location.directory`（可能是子目錄）。 */
  locationDirectory?: string;
  platform?: NodeJS.Platform;
}

/** 依優先序解析專案名；全部解析不到回 `null`（呼叫端 fail closed）。 */
export function resolveProjectName(input: ProjectNameInput): string | null {
  const platform = input.platform ?? process.platform;
  const candidates: (string | undefined)[] = [
    input.optionProject,
    input.envProject,
    basename(input.canonical, platform),
    basename(input.projectDirectory, platform),
    basename(input.locationDirectory, platform),
  ];
  for (const candidate of candidates) {
    const normalized = normalizeProjectName(candidate);
    if (normalized !== null) return normalized;
  }
  return null;
}

/** OpenChamber 聊天 session 目錄名：`session-<uuid>`（v4 UUID）。 */
const CHAT_SESSION_NAME = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 聊天日期目錄（`chats/2026-10-22/session-…`）；只用來確認中間那層的形狀。 */
const CHAT_DATE_NAME = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 這個目錄是不是 OpenChamber 的聊天 session 目錄。
 *
 * 判定以**路徑分段**為準（不用字串比對 `/`）：
 * - 分段中要有相鄰的 `openchamber` → `chats`；
 * - `chats` 之後最多一層日期目錄，最後一段必須是 `session-<uuid>`。
 *
 * 平台差異：`win32` 同時接受 `\` 與 `/` 分隔、比對不分大小寫；其他平台只認 `/`、
 * 大小寫敏感。純函式，不碰檔案系統。
 */
export function isChatDirectory(
  directory: string | undefined,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (typeof directory !== "string") return false;
  const trimmed = directory.trim();
  if (trimmed === "") return false;
  const impl = platform === "win32" ? path.win32 : path.posix;
  const normalized = impl.normalize(trimmed);
  const segments = normalized.split(platform === "win32" ? /[\\/]+/ : /\/+/).filter((s) => s !== "");
  const compare = platform === "win32" ? segments.map((s) => s.toLowerCase()) : segments;

  let chatsIndex = -1;
  for (let index = 0; index + 1 < compare.length; index += 1) {
    if (compare[index] === "openchamber" && compare[index + 1] === "chats") {
      chatsIndex = index;
      break;
    }
  }
  if (chatsIndex < 0) return false;

  const tail = segments.slice(chatsIndex + 2);
  if (tail.length === 0 || tail.length > 2) return false;
  const sessionName = tail[tail.length - 1] as string;
  if (!CHAT_SESSION_NAME.test(sessionName)) return false;
  if (tail.length === 2 && !CHAT_DATE_NAME.test(tail[0] as string)) return false;
  return true;
}

/**
 * 記憶路由的目標。
 *
 * - `project`：一般目錄，寫入／召回用 `scope:"project"` ＋ 專案名。
 * - `global-chat`：OpenChamber 聊天 session，寫入用 `scope:"global"`、不帶 `project`；
 *   召回只查 global。
 * - `unresolved`：解析不到且不是聊天目錄 → 呼叫端 fail closed。
 */
export type ProjectTarget =
  | { kind: "project"; project: string }
  | { kind: "global-chat" }
  | { kind: "unresolved" };

/**
 * 解析記憶路由目標。
 *
 * option／env 的明確專案名**優先於**聊天目錄判定（使用者明確指定時照舊走該專案）；
 * 沒有明確值時，只要 canonical／projectDirectory／locationDirectory 任一是聊天目錄，
 * 就回 `global-chat`。
 */
export function resolveProjectTarget(input: ProjectNameInput): ProjectTarget {
  const platform = input.platform ?? process.platform;
  const explicit =
    normalizeProjectName(input.optionProject) ?? normalizeProjectName(input.envProject);
  if (explicit !== null) return { kind: "project", project: explicit };
  const directories = [input.canonical, input.projectDirectory, input.locationDirectory];
  if (directories.some((directory) => isChatDirectory(directory, platform))) {
    return { kind: "global-chat" };
  }
  const project = resolveProjectName({ ...input, platform });
  return project === null ? { kind: "unresolved" } : { kind: "project", project };
}
