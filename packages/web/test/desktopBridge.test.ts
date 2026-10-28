/**
 * `getDesktopUpdater()` 的 v1／v2 相容判斷。
 *
 * 舊的 preload（v1）沒有 `updater` 成員；新 UI 不能因此拋錯，必須回 null 並顯示
 * 「僅桌面版可用」。這裡用假的 bridge 物件驗形狀檢查，不需要真的 window 或 Electron。
 */
import { describe, expect, it } from "vitest";
import type {
  DesktopBridge,
  DesktopBootstrapState,
  DesktopSettingsState,
  DesktopUpdaterBridge,
} from "../src/desktop";
import { getDesktopUpdater } from "../src/desktop";

function fakeUpdater(): DesktopUpdaterBridge {
  const notCalled = async (): Promise<never> => {
    throw new Error("測試不應呼叫 updater");
  };
  return {
    getState: notCalled,
    check: notCalled,
    download: notCalled,
    install: notCalled,
    later: notCalled,
    openReleasePage: async () => ({ opened: false }),
    restartApp: async () => undefined,
    onState: () => () => undefined,
  };
}

function fakeBridge(updater?: DesktopUpdaterBridge): DesktopBridge {
  return {
    kind: "mnemoshelf-desktop",
    apiVersion: 2,
    platform: "linux",
    bootstrap: {
      getState: async () => null as DesktopBootstrapState | null,
      retry: async () => null as DesktopBootstrapState | null,
      onUpdate: () => () => undefined,
    },
    settings: {
      get: async () => ({}) as DesktopSettingsState,
      setAutostart: async () => ({}) as DesktopSettingsState,
      setAgentDiscovery: async () => ({}) as DesktopSettingsState,
      copyConnectionInfo: async () => ({ copied: false, url: null }),
      copyMcpConfig: async () => ({ copied: false, url: null }),
    },
    ...(updater === undefined ? {} : { updater }),
  };
}

describe("getDesktopUpdater", () => {
  it("不在桌面殼裡時回 null", () => {
    expect(getDesktopUpdater(null)).toBeNull();
  });

  it("v1 殼（沒有 updater 成員）回 null", () => {
    expect(getDesktopUpdater(fakeBridge())).toBeNull();
  });

  it("完整 v2 bridge 回傳同一個 updater 物件", () => {
    const updater = fakeUpdater();
    expect(getDesktopUpdater(fakeBridge(updater))).toBe(updater);
  });

  it("updater 形狀不完整時視為不支援", () => {
    const updater = fakeUpdater();
    const broken = { ...updater, onState: undefined } as unknown as DesktopUpdaterBridge;
    expect(getDesktopUpdater(fakeBridge(broken))).toBeNull();
  });
});
