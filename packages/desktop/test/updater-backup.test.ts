/**
 * 更新前備份（U4）：檔案備份、權限、原子性、保留策略，以及與安裝流程的整合。
 *
 * 全部使用暫存目錄與 fake updater，不啟動 Electron、不碰使用者的真實資料。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { backupBeforeUpdate, createFileBackup } from "../src/updater/backup.js";
import { createUpdater, type CreateUpdaterOptions, type UpdaterController } from "../src/updater/index.js";
import { FakeAutoUpdater } from "./fakes/updater.js";

const tempDirs: string[] = [];
const controllers: UpdaterController[] = [];

afterEach(async () => {
  for (const controller of controllers) controller.stop();
  controllers.length = 0;
  for (const dir of tempDirs) await fs.rm(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mnemoshelf-u4-"));
  tempDirs.push(dir);
  return dir;
}

async function writeDatabase(
  dataDir: string,
  options: { body?: string; wal?: boolean; shm?: boolean } = {},
): Promise<string> {
  const body = options.body ?? "SQLite format 3\u0000mnemoshelf-test-db";
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(path.join(dataDir, "mnemoshelf.db"), body);
  if (options.wal !== false) await fs.writeFile(path.join(dataDir, "mnemoshelf.db-wal"), `${body}-wal`);
  if (options.shm !== false) await fs.writeFile(path.join(dataDir, "mnemoshelf.db-shm"), `${body}-shm`);
  return body;
}

async function listOrEmpty(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch {
    return [];
  }
}

describe("備份檔案與權限", () => {
  it("複製 DB／WAL／SHM，保留原檔名、只含這三個檔，且不含 token 檔", async () => {
    const root = await tempDir();
    const dataDir = path.join(root, "data");
    const backupsRoot = path.join(root, "backups");
    const token = "test-token-must-not-be-copied";
    const body = await writeDatabase(dataDir);
    await fs.writeFile(path.join(dataDir, "runtime.json"), JSON.stringify({ url: "http://127.0.0.1:1", token }));

    const result = await backupBeforeUpdate({
      fromVersion: "0.4.1",
      toVersion: "0.5.1",
      dataDir,
      backupsRoot,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);

    const backupDir = result.path;
    expect(backupDir).not.toBeNull();
    if (backupDir === null) throw new Error("沒有備份路徑");
    expect(backupDir).toBe(path.join(backupsRoot, "pre-update-0.4.1-to-0.5.1"));

    const names = (await fs.readdir(backupDir)).sort();
    expect(names).toEqual(["mnemoshelf.db", "mnemoshelf.db-shm", "mnemoshelf.db-wal"]);

    const expectedBytes =
      Buffer.byteLength(body) + Buffer.byteLength(`${body}-wal`) + Buffer.byteLength(`${body}-shm`);
    expect(result.bytes).toBe(expectedBytes);

    for (const name of names) {
      const copied = await fs.readFile(path.join(backupDir, name), "utf8");
      expect(copied).toBe(await fs.readFile(path.join(dataDir, name), "utf8"));
      // 備份內容只有 DB 檔；token 不會被複製進來。
      expect(copied).not.toContain(token);
    }

    if (process.platform !== "win32") {
      expect((await fs.stat(backupsRoot)).mode & 0o777).toBe(0o700);
      expect((await fs.stat(backupDir)).mode & 0o777).toBe(0o700);
      for (const name of names) {
        expect((await fs.stat(path.join(backupDir, name))).mode & 0o777).toBe(0o600);
      }
    }
  });

  it("WAL／SHM 不存在時只複製主 DB（存在才複製）", async () => {
    const root = await tempDir();
    const dataDir = path.join(root, "data");
    const backupsRoot = path.join(root, "backups");
    await writeDatabase(dataDir, { wal: false, shm: false });

    const result = await backupBeforeUpdate({
      fromVersion: "0.4.1",
      toVersion: "0.5.1",
      dataDir,
      backupsRoot,
    });
    expect(result.ok).toBe(true);
    if (!result.ok || result.path === null) throw new Error("備份失敗");
    expect(await fs.readdir(result.path)).toEqual(["mnemoshelf.db"]);
  });

  it("沒有 DB → no-db，且不留下任何目錄", async () => {
    const root = await tempDir();
    const dataDir = path.join(root, "data");
    const backupsRoot = path.join(root, "backups");
    await fs.mkdir(dataDir, { recursive: true });

    const result = await backupBeforeUpdate({
      fromVersion: "0.4.1",
      toVersion: "0.5.1",
      dataDir,
      backupsRoot,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("不應成功");
    expect(result.code).toBe("no-db");
    expect(result.message).not.toContain(root);
    expect(await listOrEmpty(backupsRoot)).toEqual([]);
  });

  it("備份根目錄無法建立 → copy-failed，錯誤訊息不含路徑", async () => {
    const root = await tempDir();
    const dataDir = path.join(root, "data");
    const backupsRoot = path.join(root, "backups");
    await writeDatabase(dataDir);
    // 用一般檔案佔住備份根目錄的位置：mkdir 會失敗。
    await fs.writeFile(backupsRoot, "not a directory");

    const result = await backupBeforeUpdate({
      fromVersion: "0.4.1",
      toVersion: "0.5.1",
      dataDir,
      backupsRoot,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("不應成功");
    expect(result.code).toBe("copy-failed");
    expect(result.message).not.toContain(root);
  });

  it("複製到一半失敗 → 不留下 tmp 或正式備份目錄", async () => {
    const root = await tempDir();
    const dataDir = path.join(root, "data");
    const backupsRoot = path.join(root, "backups");
    await writeDatabase(dataDir);
    // WAL 是目錄而不是檔案：無法複製，必須整體失敗。
    await fs.rm(path.join(dataDir, "mnemoshelf.db-wal"));
    await fs.mkdir(path.join(dataDir, "mnemoshelf.db-wal"));

    const result = await backupBeforeUpdate({
      fromVersion: "0.4.1",
      toVersion: "0.5.1",
      dataDir,
      backupsRoot,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("不應成功");
    expect(result.code).toBe("copy-failed");
    const leftovers = await listOrEmpty(backupsRoot);
    expect(leftovers).toEqual([]);
  });

  it("同一版本區間重試會以最新內容取代，不會失敗", async () => {
    const root = await tempDir();
    const dataDir = path.join(root, "data");
    const backupsRoot = path.join(root, "backups");
    await writeDatabase(dataDir, { body: "first" });

    const first = await backupBeforeUpdate({
      fromVersion: "0.4.1",
      toVersion: "0.5.1",
      dataDir,
      backupsRoot,
    });
    expect(first.ok).toBe(true);
    if (!first.ok || first.path === null) throw new Error("第一次備份失敗");

    await writeDatabase(dataDir, { body: "second" });
    const second = await backupBeforeUpdate({
      fromVersion: "0.4.1",
      toVersion: "0.5.1",
      dataDir,
      backupsRoot,
    });
    expect(second.ok).toBe(true);
    if (!second.ok || second.path === null) throw new Error("第二次備份失敗");

    expect(second.path).toBe(first.path);
    expect(await fs.readFile(path.join(second.path, "mnemoshelf.db"), "utf8")).toBe("second");
    expect(await listOrEmpty(backupsRoot)).toEqual(["pre-update-0.4.1-to-0.5.1"]);
  });
});

describe("保留最近 3 份", () => {
  it("建 4 份舊備份後再備份一次 → 只留 3 份，最舊的被刪，非 pre-update-* 不動", async () => {
    const root = await tempDir();
    const dataDir = path.join(root, "data");
    const backupsRoot = path.join(root, "backups");
    await fs.mkdir(backupsRoot, { recursive: true });

    for (let index = 0; index < 4; index += 1) {
      const dir = path.join(backupsRoot, `pre-update-0.0.${index}-to-0.0.${index + 1}`);
      await fs.mkdir(dir);
      await fs.writeFile(path.join(dir, "mnemoshelf.db"), `old-${index}`);
      const stamp = new Date(Date.UTC(2026, 0, 1, 0, 0, index));
      await fs.utimes(dir, stamp, stamp);
    }
    // 非本實作建立的名稱：一律不能動。
    await fs.mkdir(path.join(backupsRoot, "unrelated-backup"));
    await fs.writeFile(path.join(backupsRoot, "pre-update-not-a-directory.txt"), "keep");

    await writeDatabase(dataDir);
    const result = await backupBeforeUpdate({
      fromVersion: "0.4.1",
      toVersion: "0.5.1",
      dataDir,
      backupsRoot,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.pruned).toBe(2);

    expect((await fs.readdir(backupsRoot)).sort()).toEqual([
      "pre-update-0.0.2-to-0.0.3",
      "pre-update-0.0.3-to-0.0.4",
      "pre-update-0.4.1-to-0.5.1",
      "pre-update-not-a-directory.txt",
      "unrelated-backup",
    ]);
  });
});

describe("安裝流程整合（真實備份實作）", () => {
  interface Harness {
    fake: FakeAutoUpdater;
    controller: UpdaterController;
    log: ReturnType<typeof vi.fn>;
  }

  function setup(options: Partial<CreateUpdaterOptions> = {}): Harness {
    const fake = new FakeAutoUpdater();
    const log = vi.fn();
    const controller = createUpdater({
      platform: "linux",
      currentVersion: "0.4.1",
      isPackaged: true,
      headless: false,
      env: { APPIMAGE: path.join(os.tmpdir(), "Mnemoshelf-0.4.1-linux-x86_64.AppImage") },
      argv: [],
      execPath: path.join(os.tmpdir(), "Mnemoshelf-0.4.1-linux-x86_64.AppImage"),
      loadAutoUpdater: vi.fn(async () => fake),
      closeServerOnly: vi.fn(async () => undefined),
      installWatchdogMs: 0,
      initialCheckDelayMs: -1,
      checkIntervalMs: 0,
      log,
      ...options,
    });
    controllers.push(controller);
    return { fake, controller, log };
  }

  async function reachDownloaded(fake: FakeAutoUpdater, controller: UpdaterController): Promise<void> {
    fake.checkForUpdates.mockImplementation(async () => {
      fake.emit("checking-for-update");
      fake.emit("update-available", { version: "0.5.1", releaseNotes: null });
      return null;
    });
    await controller.check({ manual: true });
    fake.downloadUpdate.mockImplementation(async () => {
      fake.emit("update-downloaded", { version: "0.5.1" });
      return null;
    });
    await controller.download();
  }

  it("備份失敗（no-db）→ 不呼叫 quitAndInstall、狀態 backup-failed、版本不變", async () => {
    const root = await tempDir();
    const dataDir = path.join(root, "data");
    const backupsRoot = path.join(root, "backups");
    await fs.mkdir(dataDir, { recursive: true });

    const { fake, controller, log } = setup({
      backup: createFileBackup({ dataDir, backupsRoot }),
    });
    await reachDownloaded(fake, controller);

    const state = await controller.install();
    expect(fake.quitAndInstall).not.toHaveBeenCalled();
    expect(state.state).toBe("error");
    expect(state.error?.code).toBe("backup-failed");
    expect(state.currentVersion).toBe("0.4.1");
    expect(state.availableVersion).toBe("0.5.1");
    // log 只寫固定文案與穩定代碼，不含資料目錄或備份目錄。
    const logLines = log.mock.calls.map((call) => String(call[0]));
    expect(logLines.join("\n")).toContain("no-db");
    for (const line of logLines) {
      expect(line).not.toContain(dataDir);
      expect(line).not.toContain(backupsRoot);
    }
  });

  it("備份失敗後 install({force:true}) 續裝 → 跳過備份、呼叫 quitAndInstall", async () => {
    const root = await tempDir();
    const dataDir = path.join(root, "data");
    const backupsRoot = path.join(root, "backups");
    await fs.mkdir(dataDir, { recursive: true });

    const { fake, controller } = setup({
      backup: createFileBackup({ dataDir, backupsRoot }),
    });
    await reachDownloaded(fake, controller);

    const first = await controller.install();
    expect(first.state).toBe("error");
    expect(first.error?.code).toBe("backup-failed");
    expect(fake.quitAndInstall).not.toHaveBeenCalled();

    const retried = await controller.install({ force: true });
    expect(retried.state).toBe("installing");
    expect(fake.quitAndInstall).toHaveBeenCalledTimes(1);
    // 重試路徑跳過備份：備份根目錄從頭到尾都沒有被建立。
    await expect(fs.readdir(backupsRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("備份 copy-failed → 不呼叫 quitAndInstall、狀態 backup-failed（UI 固定文案）", async () => {
    const root = await tempDir();
    const dataDir = path.join(root, "data");
    const backupsRoot = path.join(root, "backups");
    await writeDatabase(dataDir);
    await fs.writeFile(backupsRoot, "not a directory");

    const { fake, controller } = setup({
      backup: createFileBackup({ dataDir, backupsRoot }),
    });
    await reachDownloaded(fake, controller);

    const state = await controller.install();
    expect(fake.quitAndInstall).not.toHaveBeenCalled();
    expect(state.state).toBe("error");
    expect(state.error?.code).toBe("backup-failed");
    expect(state.error?.message).toBe("更新前備份失敗，已取消安裝。");
    expect(state.currentVersion).toBe("0.4.1");
  });

  it("使用者明確 force → 備份失敗仍安裝（log 不含路徑）", async () => {
    const root = await tempDir();
    const dataDir = path.join(root, "data");
    const backupsRoot = path.join(root, "backups");
    await fs.mkdir(dataDir, { recursive: true });

    const { fake, controller, log } = setup({
      backup: createFileBackup({ dataDir, backupsRoot }),
    });
    await reachDownloaded(fake, controller);

    const state = await controller.install({ force: true });
    expect(fake.quitAndInstall).toHaveBeenCalledTimes(1);
    expect(state.state).toBe("installing");
    for (const call of log.mock.calls) {
      expect(String(call[0])).not.toContain(dataDir);
      expect(String(call[0])).not.toContain(backupsRoot);
    }
  });

  it("備份成功後才呼叫 quitAndInstall，備份內容可直接讀回", async () => {
    const root = await tempDir();
    const dataDir = path.join(root, "data");
    const backupsRoot = path.join(root, "backups");
    await writeDatabase(dataDir);

    const { fake, controller } = setup({
      backup: createFileBackup({ dataDir, backupsRoot }),
    });
    await reachDownloaded(fake, controller);

    const state = await controller.install();
    expect(state.state).toBe("installing");
    expect(fake.quitAndInstall).toHaveBeenCalledTimes(1);
    expect(await fs.readFile(path.join(backupsRoot, "pre-update-0.4.1-to-0.5.1", "mnemoshelf.db"), "utf8")).toContain(
      "SQLite format 3",
    );
  });
});
