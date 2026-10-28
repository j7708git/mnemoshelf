/**
 * 測試用的 electron-updater 替身（不啟動 Electron）。
 *
 * 只實作 `ElectronUpdaterLike` 實際用到的成員；事件由測試主動 `emit()`，
 * 用來驗狀態機與安裝流程。
 */
import { vi } from "vitest";
import type { ElectronUpdaterLike } from "../../src/updater/linux-win.js";

type Listener = (...args: unknown[]) => void;

export class FakeAutoUpdater implements ElectronUpdaterLike {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  logger: unknown = undefined;

  checkForUpdates = vi.fn(async (): Promise<unknown> => {
    this.emit("checking-for-update");
    return null;
  });

  downloadUpdate = vi.fn(async (): Promise<unknown> => {
    this.emit("download-progress", { percent: 50, transferred: 5, total: 10, bytesPerSecond: 1 });
    return null;
  });

  quitAndInstall = vi.fn((_isSilent?: boolean, _isForceRunAfter?: boolean): void => undefined);

  private readonly listeners = new Map<string, Set<Listener>>();

  on(event: string, listener: Listener): this {
    const existing = this.listeners.get(event) ?? new Set<Listener>();
    existing.add(listener);
    this.listeners.set(event, existing);
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args);
  }

  listenerCount(event: string): number {
    return this.listeners.get(event)?.size ?? 0;
  }
}
