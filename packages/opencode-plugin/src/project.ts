/**
 * 專案名稱解析（mnemoshelf 的 `project` 欄位）。
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
