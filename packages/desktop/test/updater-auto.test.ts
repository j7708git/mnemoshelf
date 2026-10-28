/**
 * Linux／Windows 更新流程（fake electron-updater；不啟動真 Electron）。
 *
 * 覆蓋驗收條件：旗標、狀態轉移、安裝順序、稍後、備份失敗、AppImage 改名、
 * 錯誤分類與跳過初始化。真正的安裝留 U5。
 */
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BackupPort } from "../src/updater/backup.js";
import { createMemorySkippedVersionStore, createUpdater, shouldEnableUpdater, type CreateUpdaterOptions, type UpdaterController } from "../src/updater/index.js";
import { createServerLifecycle } from "../src/updater/lifecycle.js";
import { FakeAutoUpdater } from "./fakes/updater.js";

const controllers: UpdaterController[] = [];

afterEach(() => {
  for (const controller of controllers) controller.stop();
  controllers.length = 0;
});

function appImagePath(version = "0.4.1"): string {
  return path.join(os.tmpdir(), `Mnemoshelf-${version}-linux-x86_64.AppImage`);
}

interface SetupResult {
  fake: FakeAutoUpdater;
  controller: UpdaterController;
  events: string[];
  closeServerOnly: ReturnType<typeof vi.fn>;
  backup: BackupPort & { beforeUpdate: ReturnType<typeof vi.fn> };
  onQuitting: ReturnType<typeof vi.fn>;
  onQuitAborted: ReturnType<typeof vi.fn>;
}

function setup(options: Partial<CreateUpdaterOptions> = {}): SetupResult {
  const fake = new FakeAutoUpdater();
  const events: string[] = [];
  const closeServerOnly = vi.fn(async () => {
    events.push("close");
  });
  const backup = {
    beforeUpdate: vi.fn(async () => {
      events.push("backup");
      return { ok: true as const, path: null, bytes: 0, skipped: true, detail: null };
    }),
  };
  const onQuitting = vi.fn(() => {
    events.push("quitting");
  });
  const onQuitAborted = vi.fn(() => {
    events.push("aborted");
  });

  const controller = createUpdater({
    platform: "linux",
    currentVersion: "0.4.1",
    isPackaged: true,
    headless: false,
    env: { APPIMAGE: appImagePath() },
    argv: [],
    execPath: appImagePath(),
    loadAutoUpdater: vi.fn(async () => fake),
    closeServerOnly,
    backup,
    onQuitting,
    onQuitAborted,
    installWatchdogMs: 0,
    initialCheckDelayMs: 60_000,
    checkIntervalMs: 60_000,
    ...options,
  });
  controllers.push(controller);
  return { fake, controller, events, closeServerOnly, backup, onQuitting, onQuitAborted };
}

function emitAvailable(fake: FakeAutoUpdater, version = "0.5.1"): void {
  fake.checkForUpdates.mockImplementation(async () => {
    fake.emit("checking-for-update");
    fake.emit("update-available", { version, releaseNotes: `Mnemoshelf ${version}` });
    return null;
  });
}

async function reachDownloaded(fake: FakeAutoUpdater, controller: UpdaterController): Promise<void> {
  emitAvailable(fake);
  await controller.check({ manual: true });
  fake.downloadUpdate.mockImplementation(async () => {
    fake.emit("download-progress", { percent: 50, transferred: 10, total: 20, bytesPerSecond: 2 });
    fake.emit("update-downloaded", { version: "0.5.1" });
    return null;
  });
  await controller.download();
}

describe("Linux／Windows 的旗標", () => {
  it("建立後端時明確設定 autoDownload=false、autoInstallOnAppQuit=false", async () => {
    const { fake, controller } = setup();
    await controller.start();
    expect(fake.autoDownload).toBe(false);
    expect(fake.autoInstallOnAppQuit).toBe(false);
    expect(fake.logger).toBeNull();
  });

  it("原始碼層級也看得到兩個旗標（避免被改回預設 true）", async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(new URL("../src/updater/linux-win.ts", import.meta.url), "utf8");
    expect(source).toContain("updater.autoDownload = false");
    expect(source).toContain("updater.autoInstallOnAppQuit = false");
    expect(source).toContain("updater.logger = null");
    expect(source).toContain('await import("electron-updater")');
  });
});

describe("狀態機（fake updater）", () => {
  it("idle → checking → available", async () => {
    const { fake, controller } = setup();
    emitAvailable(fake);
    expect(controller.getState().state).toBe("idle");
    const state = await controller.check({ manual: true });
    expect(state.state).toBe("available");
    expect(state.availableVersion).toBe("0.5.1");
    expect(state.currentVersion).toBe("0.4.1");
    expect(state.releaseNotes).toContain("0.5.1");
  });

  it("available → downloading → downloaded（含進度）", async () => {
    const { fake, controller } = setup();
    emitAvailable(fake);
    await controller.check({ manual: true });

    const progress: number[] = [];
    const original = controller.getState.bind(controller);
    fake.downloadUpdate.mockImplementation(async () => {
      fake.emit("download-progress", { percent: 25, transferred: 5, total: 20, bytesPerSecond: 1 });
      progress.push(original().progress?.percent ?? -1);
      fake.emit("download-progress", { percent: 80, transferred: 16, total: 20, bytesPerSecond: 1 });
      fake.emit("update-downloaded", { version: "0.5.1" });
      return null;
    });

    const state = await controller.download();
    expect(progress).toEqual([25]);
    expect(state.state).toBe("downloaded");
    expect(state.progress?.percent).toBe(100);
  });

  it("錯誤 → error（穩定代碼），之後可重試", async () => {
    const { fake, controller } = setup();
    fake.checkForUpdates.mockRejectedValue(
      Object.assign(new Error("net::ERR_INTERNET_DISCONNECTED"), { code: "ERR_INTERNET_DISCONNECTED" }),
    );
    const failed = await controller.check({ manual: true });
    expect(failed.state).toBe("error");
    expect(failed.error?.code).toBe("offline");

    emitAvailable(fake);
    const retried = await controller.check({ manual: true });
    expect(retried.state).toBe("available");
    expect(retried.error).toBeNull();
  });

  it("invalid version 事件 → invalid-version", async () => {
    const { fake, controller } = setup();
    fake.checkForUpdates.mockImplementation(async () => {
      fake.emit("checking-for-update");
      fake.emit("update-available", { version: "nightly" });
      return null;
    });
    const state = await controller.check({ manual: true });
    expect(state.state).toBe("error");
    expect(state.error?.code).toBe("invalid-version");
  });
});

describe("安裝流程", () => {
  it("順序是 quitting → closeServerOnly → backup → quitAndInstall", async () => {
    const { fake, controller, events } = setup();
    fake.quitAndInstall.mockImplementation(() => {
      events.push("quitAndInstall");
    });
    await reachDownloaded(fake, controller);

    const state = await controller.install();
    expect(events).toEqual(["quitting", "close", "backup", "quitAndInstall"]);
    expect(fake.quitAndInstall).toHaveBeenCalledWith();
    expect(state.state).toBe("installing");
  });

  it("備份失敗（未 force）→ 中止安裝、回到 error、不呼叫 quitAndInstall", async () => {
    const { fake, controller, backup, events, onQuitAborted, closeServerOnly } = setup();
    backup.beforeUpdate.mockImplementation(async () => {
      events.push("backup");
      return { ok: false, code: "copy-failed", message: "備份目錄無法寫入" };
    });
    await reachDownloaded(fake, controller);

    const state = await controller.install();
    expect(closeServerOnly).toHaveBeenCalledTimes(1);
    expect(fake.quitAndInstall).not.toHaveBeenCalled();
    expect(state.state).toBe("error");
    expect(state.error?.code).toBe("backup-failed");
    expect(state.error?.message).toBe("更新前備份失敗，已取消安裝。");
    expect(events).toEqual(["quitting", "close", "backup", "aborted"]);
    expect(onQuitAborted).toHaveBeenCalledTimes(1);
  });

  it("使用者明確 force → 備份失敗仍安裝", async () => {
    const { fake, controller, backup, events } = setup();
    backup.beforeUpdate.mockImplementation(async () => {
      events.push("backup");
      return { ok: false, code: "copy-failed", message: "略過" };
    });
    fake.quitAndInstall.mockImplementation(() => {
      events.push("quitAndInstall");
    });
    await reachDownloaded(fake, controller);

    const state = await controller.install({ force: true });
    expect(events).toEqual(["quitting", "close", "backup", "quitAndInstall"]);
    expect(state.state).toBe("installing");
  });

  it("closeServerOnly 失敗（經 lifecycle）→ install abort，不備份、不呼叫 quitAndInstall", async () => {
    const exit = vi.fn();
    const lifecycle = createServerLifecycle({
      closeServer: async () => {
        throw new Error("close failed");
      },
      exit,
    });
    const { fake, controller, backup, events } = setup({ closeServerOnly: () => lifecycle.closeServerOnly() });
    await reachDownloaded(fake, controller);

    const state = await controller.install();
    expect(state.state).toBe("error");
    expect(state.error?.code).toBe("install-failed");
    expect(state.currentVersion).toBe("0.4.1");
    expect(state.availableVersion).toBe("0.5.1");
    expect(backup.beforeUpdate).not.toHaveBeenCalled();
    expect(fake.quitAndInstall).not.toHaveBeenCalled();
    expect(events).toContain("aborted");
    expect(exit).not.toHaveBeenCalled();
  });

  it("備份失敗後 install({force:true}) 可續裝（跳過備份、closeServerOnly 可重入）", async () => {
    const closeServer = vi.fn(async () => undefined);
    const lifecycle = createServerLifecycle({ closeServer, exit: vi.fn() });
    const { fake, controller, backup, events } = setup({ closeServerOnly: () => lifecycle.closeServerOnly() });
    backup.beforeUpdate.mockImplementation(async () => {
      events.push("backup");
      return { ok: false, code: "copy-failed", message: "備份目錄無法寫入" };
    });
    fake.quitAndInstall.mockImplementation(() => {
      events.push("quitAndInstall");
    });
    await reachDownloaded(fake, controller);

    const first = await controller.install();
    expect(first.state).toBe("error");
    expect(first.error?.code).toBe("backup-failed");
    expect(first.currentVersion).toBe("0.4.1");
    expect(first.availableVersion).toBe("0.5.1");
    expect(fake.quitAndInstall).not.toHaveBeenCalled();

    // 沒有 force 的一般 install() 不能從 error 進入安裝。
    const withoutForce = await controller.install();
    expect(withoutForce.state).toBe("error");
    expect(withoutForce.error?.code).toBe("backup-failed");
    expect(fake.quitAndInstall).not.toHaveBeenCalled();

    // 使用者明確確認：跳過備份，直接續裝；closeServerOnly 重入但只真正關一次。
    const retried = await controller.install({ force: true });
    expect(retried.state).toBe("installing");
    expect(closeServer).toHaveBeenCalledTimes(1);
    expect(backup.beforeUpdate).toHaveBeenCalledTimes(1);
    expect(fake.quitAndInstall).toHaveBeenCalledTimes(1);
    expect(events.filter((event) => event === "quitAndInstall")).toEqual(["quitAndInstall"]);
  });

  it("安裝期間 updater 回報唯讀錯誤 → read-only，並還原 quitting", async () => {
    const { fake, controller, onQuitAborted } = setup();
    fake.quitAndInstall.mockImplementation(() => undefined);
    await reachDownloaded(fake, controller);
    await controller.install();
    expect(controller.getState().state).toBe("installing");

    fake.emit("error", Object.assign(new Error("EROFS: read-only file system"), { code: "EROFS" }));
    const state = controller.getState();
    expect(state.state).toBe("error");
    expect(state.error?.code).toBe("read-only");
    expect(onQuitAborted).toHaveBeenCalledTimes(1);
  });

  it("只有 downloaded 狀態才能安裝（available 直接呼叫是 no-op）", async () => {
    const { fake, controller } = setup();
    emitAvailable(fake);
    await controller.check({ manual: true });
    const state = await controller.install();
    expect(state.state).toBe("available");
    expect(fake.quitAndInstall).not.toHaveBeenCalled();
  });
});

describe("稍後（skipped version）", () => {
  it("本次不再自動提示；手動檢查仍會顯示；狀態回到 idle", async () => {
    const store = createMemorySkippedVersionStore();
    const { fake, controller } = setup({ skippedVersionStore: store });
    emitAvailable(fake);
    await controller.check({ manual: true });

    const later = await controller.later();
    expect(later.state).toBe("idle");
    expect(later.availableVersion).toBeNull();
    expect(later.skippedVersion).toBe("0.5.1");
    expect(await store.load()).toBe("0.5.1");

    const auto = await controller.check({ manual: false });
    expect(auto.state).toBe("idle");
    expect(auto.availableVersion).toBeNull();

    const manual = await controller.check({ manual: true });
    expect(manual.state).toBe("available");
    expect(manual.availableVersion).toBe("0.5.1");
  });

  it("下次啟動會再詢問（載入已存的 skipped version 後直接顯示 available）", async () => {
    const store = createMemorySkippedVersionStore("0.5.1");
    const { controller } = setup({ skippedVersionStore: store });
    await controller.start();
    const state = controller.getState();
    expect(state.state).toBe("available");
    expect(state.availableVersion).toBe("0.5.1");
  });

  it("已下載時清掉 skipped version（使用者已選擇安裝）", async () => {
    const store = createMemorySkippedVersionStore();
    const { fake, controller } = setup({ skippedVersionStore: store });
    emitAvailable(fake);
    await controller.check({ manual: true });
    await controller.later();
    expect(await store.load()).toBe("0.5.1");

    await controller.check({ manual: true });
    await reachDownloaded(fake, controller);
    await vi.waitFor(async () => expect(await store.load()).toBeNull());
  });
});

describe("跳過初始化", () => {
  it("!isPackaged 與 --headless 都不啟用", async () => {
    expect(shouldEnableUpdater({ platform: "linux", isPackaged: false, headless: false })).toBe(false);
    expect(shouldEnableUpdater({ platform: "linux", isPackaged: true, headless: true })).toBe(false);
    expect(shouldEnableUpdater({ platform: "darwin", isPackaged: true, headless: false })).toBe(true);

    const load = vi.fn(async () => new FakeAutoUpdater());
    for (const skipped of [{ isPackaged: false, headless: false }, { isPackaged: true, headless: true }]) {
      const controller = createUpdater({
        platform: "linux",
        currentVersion: "0.4.1",
        ...skipped,
        env: { APPIMAGE: appImagePath() },
        argv: [],
        execPath: appImagePath(),
        loadAutoUpdater: load,
        closeServerOnly: vi.fn(async () => undefined),
        initialCheckDelayMs: -1,
        checkIntervalMs: 0,
      });
      controllers.push(controller);
      await controller.start();
      expect(controller.mode).toBe("disabled");
      expect(controller.getState().mode).toBe("disabled");
      expect((await controller.check({ manual: true })).state).toBe("idle");
    }
    expect(load).not.toHaveBeenCalled();
  });

  it("Linux 沒有 APPIMAGE → error（unsupported-appimage），不載入 electron-updater", async () => {
    const load = vi.fn(async () => new FakeAutoUpdater());
    const controller = createUpdater({
      platform: "linux",
      currentVersion: "0.4.1",
      isPackaged: true,
      headless: false,
      env: {},
      argv: [],
      execPath: path.join(os.tmpdir(), "mnemoshelf"),
      loadAutoUpdater: load,
      closeServerOnly: vi.fn(async () => undefined),
      initialCheckDelayMs: -1,
      checkIntervalMs: 0,
    });
    controllers.push(controller);
    await controller.start();
    expect(controller.getState().state).toBe("error");
    expect(controller.getState().error?.code).toBe("unsupported-appimage");
    expect(load).not.toHaveBeenCalled();
  });
});

describe("AppImage 改名", () => {
  it("fake 事件會更新自啟項（回傳提示）並反映在狀態上", async () => {
    const onAppImageRenamed = vi.fn(() => "已更新開機自啟指向新檔名");
    const { fake, controller } = setup({ onAppImageRenamed });
    await controller.start();

    fake.emit("appimage-filename-updated", appImagePath("0.5.1"));
    expect(onAppImageRenamed).toHaveBeenCalledWith(appImagePath("0.5.1"));
    expect(controller.getState().notice).toBe("已更新開機自啟指向新檔名");
    // 狀態只帶提示，不帶路徑。
    expect(JSON.stringify(controller.getState())).not.toContain(appImagePath("0.5.1"));
  });

  it("處理失敗時回傳提示（不靜默）", async () => {
    const onAppImageRenamed = vi.fn(() => {
      throw new Error("disk full");
    });
    const { fake, controller } = setup({ onAppImageRenamed, log: () => undefined });
    await controller.start();
    fake.emit("appimage-filename-updated", appImagePath("0.5.1"));
    expect(controller.getState().notice).toBe("更新後請重新開啟開機自啟");
  });
});
