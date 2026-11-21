/** 自動注入模式：`all` 全部記憶、`refined-only` 僅精煉記憶（排除原始對話）、`off` 關閉。 */
export type AutoInjectMode = "all" | "refined-only" | "off";

export const AUTO_INJECT_MODES: readonly AutoInjectMode[] = ["all", "refined-only", "off"];

/** 全域預設模式與逐專案覆寫；`revision` 供樂觀並發（CAS）使用。 */
export interface MemoryAutoInjectSettings {
  revision: number;
  defaultMode: AutoInjectMode;
  projects: Record<string, AutoInjectMode>;
}

/**
 * 更新自動注入設定的 patch。
 *
 * `projects` 的值為 `null` 表示刪除該專案覆寫；未列出的專案鍵維持不變。
 */
export interface MemoryAutoInjectPatch {
  expectedRevision: number;
  defaultMode?: AutoInjectMode;
  projects?: Record<string, AutoInjectMode | null>;
}

const PROJECT_KEY_MAX_LENGTH = 200;

function assertRevision(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new TypeError("revision 必須是正整數");
}

function assertMode(value: unknown, label: string): asserts value is AutoInjectMode {
  if (typeof value !== "string" || !(AUTO_INJECT_MODES as readonly string[]).includes(value)) {
    throw new TypeError(`${label} 必須是 ${AUTO_INJECT_MODES.join("/")}`);
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** 專案鍵 trim 後必須非空、不超過 200 字元且不含 NUL。 */
function projectKey(key: string): string {
  const trimmed = key.trim();
  if (trimmed === "" || trimmed.length > PROJECT_KEY_MAX_LENGTH || trimmed.includes("\0")) {
    throw new TypeError("專案名稱必須是非空文字（最長 200 字元、不得含 NUL）");
  }
  return trimmed;
}

/** 驗證並正規化設定：專案鍵 trim、依鍵排序（輸出可重現）；重複鍵或非法值拋 `TypeError`。 */
export function normalizeAutoInjectSettings(value: MemoryAutoInjectSettings): MemoryAutoInjectSettings {
  if (!isPlainRecord(value)) throw new TypeError("自動注入設定必須是物件");
  assertRevision(value.revision);
  assertMode(value.defaultMode, "defaultMode");
  if (!isPlainRecord(value.projects)) throw new TypeError("projects 必須是物件");
  const entries = new Map<string, AutoInjectMode>();
  for (const [rawKey, mode] of Object.entries(value.projects)) {
    const key = projectKey(rawKey);
    if (entries.has(key)) throw new TypeError(`專案名稱重複：${key}`);
    assertMode(mode, `projects[${key}]`);
    entries.set(key, mode);
  }
  return {
    revision: value.revision,
    defaultMode: value.defaultMode,
    projects: Object.fromEntries([...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
  };
}

/** 由資料庫列（`revision`、`default_mode`、`projects_json`）讀出設定；資料損毀時拋 `TypeError`。 */
export function readMemoryAutoInjectSettings(row: Record<string, unknown>): MemoryAutoInjectSettings {
  if (!isPlainRecord(row)) throw new TypeError("自動注入設定列不存在");
  let projects: unknown;
  try {
    projects = JSON.parse(String(row.projects_json));
  } catch {
    throw new TypeError("projects_json 不是合法 JSON");
  }
  return normalizeAutoInjectSettings({
    revision: Number(row.revision),
    defaultMode: row.default_mode as AutoInjectMode,
    projects: projects as Record<string, AutoInjectMode>,
  });
}

/**
 * 把 patch 套用到目前設定並回傳下一版（`revision = current.revision + 1`）。
 *
 * 只驗證 patch 形狀；`expectedRevision` 與目前 revision 是否相符屬於 store 的 CAS，
 * 不符時由 store 拋 `MemoryRecallConflictError`。合併語意只更動 patch 列出的專案鍵。
 */
export function applyAutoInjectPatch(current: MemoryAutoInjectSettings, patch: MemoryAutoInjectPatch): MemoryAutoInjectSettings {
  if (!isPlainRecord(patch)) throw new TypeError("patch 必須是物件");
  assertRevision(patch.expectedRevision);
  const base = normalizeAutoInjectSettings(current);
  if (patch.defaultMode !== undefined) assertMode(patch.defaultMode, "defaultMode");
  let changes: Map<string, AutoInjectMode | null> | undefined;
  if (patch.projects !== undefined) {
    if (!isPlainRecord(patch.projects)) throw new TypeError("projects 必須是物件");
    changes = new Map();
    for (const [rawKey, mode] of Object.entries(patch.projects)) {
      const key = projectKey(rawKey);
      if (changes.has(key)) throw new TypeError(`專案名稱重複：${key}`);
      if (mode !== null) assertMode(mode, `projects[${key}]`);
      changes.set(key, mode);
    }
  }
  if (patch.defaultMode === undefined && (changes === undefined || changes.size === 0)) {
    throw new TypeError("至少提供 defaultMode 或非空 projects");
  }
  const projects = new Map(Object.entries(base.projects));
  for (const [key, mode] of changes ?? []) {
    if (mode === null) projects.delete(key);
    else projects.set(key, mode);
  }
  return normalizeAutoInjectSettings({
    revision: base.revision + 1,
    defaultMode: patch.defaultMode ?? base.defaultMode,
    projects: Object.fromEntries(projects),
  });
}

/** 解析某專案的生效模式：命中專案覆寫回該模式，否則回全域預設。 */
export function resolveAutoInjectMode(
  settings: Pick<MemoryAutoInjectSettings, "defaultMode" | "projects">,
  project?: string | null,
): AutoInjectMode {
  if (typeof project === "string") {
    const key = project.trim();
    if (key !== "" && Object.hasOwn(settings.projects, key)) return settings.projects[key]!;
  }
  return settings.defaultMode;
}
