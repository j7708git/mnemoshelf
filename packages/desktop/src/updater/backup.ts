/**
 * 更新前備份：在 `closeServerOnly()` 之後、`quitAndInstall()` 之前，把 SQLite 資料庫
 * （含 WAL／SHM）複製到 `<backupsRoot>/pre-update-<from>-to-<to>/`。
 *
 * 設計取捨：
 * - **先寫 tmp 目錄再 rename**：正式目錄只會是「全部複製成功」的結果，不會留下半套備份。
 * - **只複製白名單檔案**：`mnemoshelf.db`、`mnemoshelf.db-wal`、`mnemoshelf.db-shm`
 *   （存在才複製）。`runtime.json`（含 token）等其他檔案一律不進備份。
 * - **不回傳／不記錄敏感內容**：結果只帶路徑、bytes 與穩定錯誤代碼；錯誤訊息不含
 *   使用者目錄、DB 內容或 token。呼叫端的 log 也只能寫固定文案。
 * - **只清理自己建立的備份**：保留最近 3 個 `pre-update-*` 目錄；其他名稱、檔案與
 *   symlink 一律不動。
 *
 * 這個模組不 import electron，也不拋錯到呼叫端（`beforeUpdate()` 永遠回傳結果物件）。
 */
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import type { Dirent, Stats } from "node:fs";
import path from "node:path";

/** 備份失敗的穩定代碼（IPC 狀態只帶代碼與固定訊息）。 */
export type BackupErrorCode = "no-db" | "copy-failed" | "permission";

/**
 * 備份結果。
 *
 * 成功：`{ ok: true, path, bytes }`。`skipped` 只會出現在「呼叫端明確設定不備份」的
 * no-op 實作；真正的檔案備份成功時 `skipped` 不存在。
 */
export type BackupResult =
  | {
      ok: true;
      /** 備份目錄（絕對路徑）；略過時為 null。呼叫端不得把它寫進 log 或 IPC 狀態。 */
      path: string | null;
      /** 這次複製的位元組數。 */
      bytes: number;
      skipped?: boolean;
      /** 給使用者看的短說明（不含路徑）。 */
      detail?: string | null;
      /** 這次清理掉的舊備份數量。 */
      pruned?: number;
    }
  | {
      ok: false;
      code: BackupErrorCode;
      message: string;
    };

/** 安裝流程傳給備份實作的版本資訊。 */
export interface BackupRequest {
  /** 目前版本（`app.getVersion()`）。 */
  fromVersion: string;
  /** 已下載、即將安裝的版本。 */
  toVersion: string;
}

/** 更新前備份的介面（`index.ts` 的安裝流程只認識這個介面）。 */
export interface BackupPort {
  /**
   * 在關閉 server 之後、安裝之前呼叫。
   *
   * 實作不得拋錯：失敗一律用 `{ ok: false, code, message }` 回報。實作也不得在這裡
   * 重新啟動 server 或改動 `quitting`。
   */
  beforeUpdate(request: BackupRequest): Promise<BackupResult>;
}

/** 建立真正的檔案備份實作所需的固定路徑。 */
export interface FileBackupOptions {
  /** SQLite 資料目錄（桌面版為 `<userData>/data`）。 */
  dataDir: string;
  /** 備份根目錄（桌面版為 `<userData>/backups`）。 */
  backupsRoot: string;
}

export interface BackupBeforeUpdateInput extends FileBackupOptions, BackupRequest {}

/** SQLite 主檔名；WAL／SHM 由後綴決定。 */
const DB_FILE = "mnemoshelf.db";
const DB_SUFFIXES = ["", "-wal", "-shm"] as const;

/** 只有這個前綴的目錄是「我們建立的備份」。 */
const BACKUP_PREFIX = "pre-update-";

/** 暫存目錄前綴：不匹配 `pre-update-*`，不會被保留策略誤刪。 */
const TEMP_PREFIX = ".tmp-pre-update-";

/** 保留最近幾份備份。 */
const RETAIN_BACKUPS = 3;

/** 穩定錯誤訊息（不含路徑、DB 內容或 token）。 */
const MESSAGES: Record<BackupErrorCode, string> = {
  "no-db": "找不到資料庫，未建立更新前備份。",
  "copy-failed": "複製資料庫檔案時發生錯誤，未建立更新前備份。",
  permission: "沒有權限建立更新前備份。",
};

/** 內部用：帶穩定代碼的失敗，交給最外層轉成 `BackupResult`。 */
class BackupFault extends Error {
  readonly code: BackupErrorCode;

  constructor(code: BackupErrorCode) {
    super(MESSAGES[code]);
    this.name = "BackupFault";
    this.code = code;
  }
}

/**
 * 更新前備份（主要入口）。
 *
 * 任何失敗都不會拋到安裝流程外；暫存目錄會在失敗時清掉。成功後才做保留清理，
 * 清理失敗不影響本次備份的成功結果。
 */
export async function backupBeforeUpdate(input: BackupBeforeUpdateInput): Promise<BackupResult> {
  const dataDir = path.resolve(input.dataDir);
  const backupsRoot = path.resolve(input.backupsRoot);
  const dbFile = path.join(dataDir, DB_FILE);

  // 版本只用來組目錄名：先收斂成安全字元，避免路徑分隔、空白或過長名稱。
  const versionPart = `${versionSegment(input.fromVersion)}-to-${versionSegment(input.toVersion)}`;
  const finalDir = path.join(backupsRoot, `${BACKUP_PREFIX}${versionPart}`);
  const tmpDir = path.join(
    backupsRoot,
    `${TEMP_PREFIX}${versionPart}-${process.pid}-${randomBytes(4).toString("hex")}`,
  );

  try {
    const dbStat = await statDatabase(dbFile);
    if (!dbStat.isFile()) throw new BackupFault("no-db");

    await fs.mkdir(backupsRoot, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") await fs.chmod(backupsRoot, 0o700);
    await fs.mkdir(tmpDir, { recursive: false, mode: 0o700 });

    let bytes = 0;
    for (const suffix of DB_SUFFIXES) {
      const source = `${dbFile}${suffix}`;
      const stat = await statOptional(source, suffix === "");
      if (stat === null) continue;
      if (!stat.isFile()) {
        // 主檔不是檔案 → 沒有可用的 DB；WAL／SHM 不是檔案則代表無法完整備份。
        throw new BackupFault(suffix === "" ? "no-db" : "copy-failed");
      }
      const destination = path.join(tmpDir, `${DB_FILE}${suffix}`);
      await fs.copyFile(source, destination);
      if (process.platform !== "win32") await fs.chmod(destination, 0o600);
      bytes += (await fs.stat(destination)).size;
    }

    await replaceBackupDirectory(finalDir, tmpDir);
    // rename 之後就不能再走「失敗清 tmp」的路徑；保留清理本身是 best-effort。
    const pruned = await pruneOldBackups(backupsRoot, finalDir);
    return { ok: true, path: finalDir, bytes, pruned };
  } catch (error) {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    const code = error instanceof BackupFault ? error.code : classifyFsError(error);
    return { ok: false, code, message: MESSAGES[code] };
  }
}

/**
 * 建立給 `index.ts` 安裝流程使用的 `BackupPort`。
 *
 * 路徑在建立時固定；每次安裝才把版本傳進來（版本會隨下載到的更新而變）。
 */
export function createFileBackup(options: FileBackupOptions): BackupPort {
  return {
    beforeUpdate: (request) =>
      backupBeforeUpdate({
        fromVersion: request.fromVersion,
        toVersion: request.toVersion,
        dataDir: options.dataDir,
        backupsRoot: options.backupsRoot,
      }),
  };
}

/**
 * 預設的 no-op 實作：只在呼叫端沒有提供備份實作時使用（測試或未來其他平台）。
 *
 * 不回報「已備份」：`skipped: true` 讓呼叫端知道這次沒有產生備份。
 */
export function createNoopBackup(): BackupPort {
  return {
    beforeUpdate: async () => ({
      ok: true,
      path: null,
      bytes: 0,
      skipped: true,
      detail: "未設定更新前備份（這次不會建立備份）",
    }),
  };
}

/** 版本字串轉成安全的單一目錄名（不含分隔符、不以 `..` 結尾）。 */
function versionSegment(version: string): string {
  const safe = version
    .trim()
    .replace(/[^0-9A-Za-z._+-]/g, "_")
    .slice(0, 64);
  if (safe === "" || safe === "." || safe === "..") return "unknown";
  return safe;
}

/** 主 DB 不存在 → `no-db`；其他錯誤交給外層分類。 */
async function statDatabase(target: string): Promise<Stats> {
  try {
    return await fs.stat(target);
  } catch (error) {
    const code = fsErrorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") throw new BackupFault("no-db");
    throw error;
  }
}

/** WAL／SHM 可不存在；只有「不存在」會被略過，權限等其他錯誤照常往上拋。 */
async function statOptional(target: string, required: boolean): Promise<Stats | null> {
  try {
    return await fs.stat(target);
  } catch (error) {
    const code = fsErrorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") {
      if (required) throw new BackupFault("no-db");
      return null;
    }
    throw error;
  }
}

/**
 * 把 tmp 目錄換成正式名稱。
 *
 * 同名目錄只會是「同一個版本區間的重試」——以這次的內容為準，先移除舊的再 rename；
 * 這不是使用者資料，且 tmp 已經完整複製完成。
 */
async function replaceBackupDirectory(finalDir: string, tmpDir: string): Promise<void> {
  let existing = false;
  try {
    const stat = await fs.lstat(finalDir);
    existing = stat.isDirectory() && !stat.isSymbolicLink();
  } catch (error) {
    const code = fsErrorCode(error);
    if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
  }
  if (existing) await fs.rm(finalDir, { recursive: true, force: true });
  await fs.rename(tmpDir, finalDir);
}

/**
 * 只保留最近 `RETAIN_BACKUPS` 份 `pre-update-*` 目錄。
 *
 * 判定「最近」用目錄 mtime（本次備份剛 rename 完成，時間最新），mtime 相同時用
 * 名稱排序。symlink、一般檔案與其他名稱一律不動；單一刪除失敗只跳過該筆，
 * 不讓清理影響本次備份結果。
 */
async function pruneOldBackups(backupsRoot: string, keep: string): Promise<number> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(backupsRoot, { withFileTypes: true });
  } catch {
    return 0;
  }

  const candidates: Array<{ dir: string; mtimeMs: number }> = [];
  for (const entry of entries) {
    if (!entry.name.startsWith(BACKUP_PREFIX) || !entry.isDirectory()) continue;
    const dir = path.join(backupsRoot, entry.name);
    try {
      const stat = await fs.lstat(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
      candidates.push({ dir, mtimeMs: stat.mtimeMs });
    } catch {
      // 期間被其他行程移走：沒有東西可清理。
    }
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs || b.dir.localeCompare(a.dir));

  const keepPath = path.resolve(keep);
  let kept = 1;
  let pruned = 0;
  for (const candidate of candidates) {
    if (path.resolve(candidate.dir) === keepPath) continue;
    if (kept < RETAIN_BACKUPS) {
      kept += 1;
      continue;
    }
    try {
      await fs.rm(candidate.dir, { recursive: true, force: true });
      pruned += 1;
    } catch {
      // 清理舊備份失敗不影響本次備份；下次更新會再試。
    }
  }
  return pruned;
}

/** 檔案系統錯誤 → 備份錯誤代碼。 */
function classifyFsError(error: unknown): BackupErrorCode {
  const code = fsErrorCode(error);
  if (code === "EACCES" || code === "EPERM" || code === "EROFS") return "permission";
  return "copy-failed";
}

function fsErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}
