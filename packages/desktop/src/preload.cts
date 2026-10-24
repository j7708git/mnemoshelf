/**
 * Preload：把桌面殼的窄介面掛到 renderer 的 `window.mnemoshelfDesktop`（desktop shell API v1）。
 *
 * 為什麼是 CJS（`.cts` → `dist/preload.cjs`）：Electron 的 sandbox preload 只支援 CommonJS；
 * 本檔同時負責「**只暴露狀態、不暴露 token**」這條界線——renderer 拿不到 token，
 * 所有 API 請求的 `Authorization` 由 main process 以 `webRequest` 注入。
 *
 * 契約（通道名稱與狀態形狀）與 `src/desktop-api.ts` 及 `packages/web/src/desktop.ts` 三處一致；
 * 這裡刻意不 import 型別，維持 preload 零相依（sandbox 內只有 `electron` 可用）。
 */
const { contextBridge, ipcRenderer } = require("electron");

const BRIDGE_NAME = "mnemoshelfDesktop";
const API_VERSION = 1;

const CHANNELS = {
  bootstrapGet: "mnemoshelf:bootstrap:get",
  bootstrapRetry: "mnemoshelf:bootstrap:retry",
  bootstrapUpdate: "mnemoshelf:bootstrap:update",
  settingsGet: "mnemoshelf:settings:get",
  settingsSetAutostart: "mnemoshelf:settings:set-autostart",
  settingsSetAgentDiscovery: "mnemoshelf:settings:set-agent-discovery",
  settingsCopyConnectionInfo: "mnemoshelf:settings:copy-connection-info",
  settingsCopyMcpConfig: "mnemoshelf:settings:copy-mcp-config",
};

const api = {
  kind: "mnemoshelf-desktop",
  apiVersion: API_VERSION,
  platform: process.platform,
  bootstrap: {
    getState: () => ipcRenderer.invoke(CHANNELS.bootstrapGet),
    retry: () => ipcRenderer.invoke(CHANNELS.bootstrapRetry),
    onUpdate: (listener: (state: unknown) => void) => {
      const handler = (_event: unknown, state: unknown): void => {
        listener(state);
      };
      ipcRenderer.on(CHANNELS.bootstrapUpdate, handler);
      return () => {
        ipcRenderer.removeListener(CHANNELS.bootstrapUpdate, handler);
      };
    },
  },
  settings: {
    get: () => ipcRenderer.invoke(CHANNELS.settingsGet),
    setAutostart: (enabled: unknown) => ipcRenderer.invoke(CHANNELS.settingsSetAutostart, enabled === true),
    setAgentDiscovery: (enabled: unknown) => ipcRenderer.invoke(CHANNELS.settingsSetAgentDiscovery, enabled === true),
    copyConnectionInfo: () => ipcRenderer.invoke(CHANNELS.settingsCopyConnectionInfo),
    copyMcpConfig: () => ipcRenderer.invoke(CHANNELS.settingsCopyMcpConfig),
  },
};

contextBridge.exposeInMainWorld(BRIDGE_NAME, api);
