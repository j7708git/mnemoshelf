/**
 * Mnemoshelf 桌面殼：Electron main process。
 *
 * 這個殼負責把 Core 服務包成一個「桌面應用程式該有的樣子」：
 *   1. 在 **main process 內**啟動 Core 服務（`createServer()`；隨機埠、token、只綁 127.0.0.1）；
 *   2. **token 由應用自己管**：`safeStorage` 加密保存在 userData，之後每次啟動沿用；
 *      所有 API 請求由 `webRequest` 注入 `Authorization`，renderer 看不到 token、使用者不必手動貼；
 *   3. 開一個視窗載入 Core 服務同源提供的 Web UI（靜態檔在 `resources/web`，asar 之外）；
 *   4. 系統匣 ＋「關窗縮到匣」＋單一實例鎖；
 *   5. 首次啟動預先下載模型並顯示進度（可重試）；
 *   6. 開機自啟開關（Linux 走 XDG autostart；macOS／Windows 走 `setLoginItemSettings`）；
 *   7. `--headless`：不開視窗、只跑服務（仍需要 GUI session 才能啟動 Electron）。
 *
 * 失敗一律有可讀狀態：服務起不來 → 錯誤頁；模型下載失敗 → UI 的錯誤與重試；
 * 沒有可用的加密後端 → 本次執行限定的 token ＋ UI 說明（不寫明碼）。
 *
 * 起始條件（M4 打包研究結論，2026-10 查證）：四個原生模組（better-sqlite3／sqlite-vec／
 * onnxruntime-node／sharp）都是 N-API／Node-API，不需 `@electron/rebuild`；真正要處理的是
 * asar 解包（見 `electron-builder.yml` 的 `asarUnpack`）與 sharp 在 Linux 的 glib 風險。
 */
import { BrowserWindow, Menu, Tray, app, clipboard, ipcMain, net, safeStorage, session, shell, type IpcMainInvokeEvent } from "electron";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type MnemoshelfServer } from "@mnemoshelf/server";
import { installLoadExtensionAsarShim } from "./asar-paths.js";
import {
  defaultAgentSettings,
  readAgentSettings,
  resolveStartupDiscovery,
  runtimeFileExists,
  setAgentDiscovery,
  setSkippedUpdateVersion,
  type AgentSettings,
} from "./agent-settings.js";
import { autostartFilePath, openedAtLogin, readAutostartState, rewriteAutostartExecPath, setAutostart, type AutostartOptions, type AutostartState } from "./autostart.js";
import {
  DESKTOP_API_VERSION,
  DESKTOP_BRIDGE_NAME,
  DESKTOP_CHANNELS,
  type DesktopAgentGuideCopyResult,
  type DesktopAgentGuideState,
  type DesktopAppInfo,
  type DesktopSettingsState,
} from "./desktop-api.js";
import {
  AGENT_GUIDE_COPY_KINDS,
  buildCopyText,
  buildHarnessConfig,
  copyGate,
  type AgentGuideBlockedReason,
  type AgentGuideCopyKind,
} from "./agent-guide.js";
import { readAgentGuideState } from "./agent-guide-reader.js";
import { ModelBootstrap, type BootstrapState } from "./model-bootstrap.js";
import { downloadModelFiles } from "./model-download.js";
import { MODEL_PROFILE } from "./model-profile.js";
import { formatProbe, probeNativeModules } from "./native-probe.js";
import { buildServerEnv, parseCliArgs, resolveDesktopPaths, type DesktopPaths } from "./paths.js";
import { resolveMcpEntryPath } from "./mcp-entry.js";
import { loadOrCreateToken, toTokenInfo, type TokenInfo } from "./token-store.js";
import { createTrayImage } from "./tray-icon.js";
import { createFileBackup } from "./updater/backup.js";
import { createUpdater, shouldEnableUpdater, type UpdaterController } from "./updater/index.js";
import { createServerLifecycle } from "./updater/lifecycle.js";
import { createInitialUpdaterState, updaterTrayTooltip, type UpdaterState } from "./updater/state.js";

/** 統一的啟動 log 前綴（`scripts/smoke.mjs` 會擷取）。 */
function log(message: string): void {
  console.log(`[mnemoshelf-desktop] ${message}`);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = parseCliArgs(process.argv.slice(1));

let server: MnemoshelfServer | null = null;
let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let bootstrap: ModelBootstrap | null = null;
let tokenInfo: TokenInfo | null = null;
/** 目前的存取 token（只在 main process；複製連線資訊時直接寫剪貼簿，不經過 renderer）。 */
let tokenValue: string | null = null;
/** 本次啟動解析出的路徑（`settingsState()` 與 IPC 會用到）。 */
let desktopPaths: DesktopPaths | null = null;
/** Agent 連線發現的持久化設定（`agentSettings.json`）。 */
let agentSettings: AgentSettings = defaultAgentSettings();
/** 這次執行的 server 是否以 discovery=on 啟動（變更設定要重啟才生效）。 */
let agentDiscoveryActive = false;
/** 寫檔失敗／刪檔失敗的說明（設定頁顯示）。 */
let agentDiscoveryWriteError: string | null = null;
let agentDiscoveryDeleteError: string | null = null;
let quitting = false;
let allowWindowClose = false;
/** 更新控制器（開發模式／headless 為 null；IPC 一律回 disabled 狀態）。 */
let updater: UpdaterController | null = null;
/** `--hidden`（登入時自啟）時不要主動顯示視窗；macOS 另由 `wasOpenedAtLogin` 推導（見 main()）。 */
let startHidden = cli.hidden;

/**
 * 主視窗第一次 `ready-to-show` 的訊號。
 *
 * 自動驗收的 `hidden` 情境要等這個訊號之後才斷言「視窗仍不可見」：否則可能只是
 * 「還沒走到顯示那一步」而被誤判成通過（真正的 bug 是顯示路徑把 `startHidden` 蓋掉）。
 */
let notifyWindowReadyToShow: () => void = () => undefined;
const windowReadyToShow = new Promise<void>((resolve) => {
  notifyWindowReadyToShow = resolve;
});

/** 這一輪的授權統計（驗收證據：注入幾次、有沒有 401）。 */
const authCounters = { injected: 0, requests: 0, unauthorized: 0 };

/** renderer 的 console 訊息（含 sharp 之類原生模組的警告），啟動 log 會一併印出。 */
const rendererMessages: string[] = [];

// 應用名稱決定 `app.getPath("userData")` 的預設位置。打包後的 package.json 只有 scoped
// name（`@mnemoshelf/desktop`，且不含 productName），直接沿用會變成奇怪的路徑，因此在
// 任何 getPath("userData") 之前先固定成 Mnemoshelf。
app.setName("Mnemoshelf");

// userData 可在啟動前覆寫（驗收用：讓每次跑都用乾淨的目錄）。
const userDataOverride = process.env.MNEMOSHELF_DESKTOP_USER_DATA;
if (userDataOverride !== undefined && userDataOverride.trim() !== "") {
  app.setPath("userData", path.resolve(userDataOverride));
}

/**
 * 沒有桌面環境變數時（例如從 tty／systemd 直接啟動），Chromium 認不出桌面環境，
 * `safeStorage` 會退到 `basic_text` 後端而完全不能用。這時明確指定 libsecret，
 * 讓它去找系統的 secret service（GNOME Keyring 等）。
 *
 * 一般桌面環境（GNOME／KDE／XFCE…）都會設定 `XDG_CURRENT_DESKTOP`，因此不受影響；
 * 使用者若自己帶了 `--password-store` 也一律尊重。
 */
function hasDesktopEnvironment(env: NodeJS.ProcessEnv): boolean {
  for (const key of ["XDG_CURRENT_DESKTOP", "XDG_SESSION_DESKTOP", "DESKTOP_SESSION"]) {
    const value = env[key];
    if (value !== undefined && value.trim() !== "") return true;
  }
  return false;
}

if (process.platform === "linux" && !hasDesktopEnvironment(process.env) && !app.commandLine.hasSwitch("password-store")) {
  app.commandLine.appendSwitch("password-store", "gnome-libsecret");
}

async function exists(target: string): Promise<boolean> {
  return fs
    .stat(target)
    .then(() => true)
    .catch(() => false);
}

/**
 * 找出實際要服務的 Web UI 目錄。
 *
 * 打包後是 `resources/web`（`extraResources`）；開發模式（`electron .`）沒有 resources 內容，
 * 退回 repo 內的 `packages/web/dist`。以「有沒有 index.html」判定，避免佈局細節猜錯。
 */
async function resolveWebDir(candidate: string, appPath: string): Promise<string> {
  const candidates = [candidate, path.join(process.resourcesPath, "web"), path.join(process.resourcesPath, "web", "dist"), path.resolve(appPath, "..", "web", "dist")];
  for (const dir of candidates) {
    if (await exists(path.join(dir, "index.html"))) return dir;
  }
  log(`警告：找不到 Web UI（嘗試過：${candidates.join("、")}）；靜態路徑會回 404。`);
  return candidate;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** 啟動失敗時顯示的錯誤頁（不讓使用者看到白屏）。 */
function errorPageUrl(title: string, detail: string, hint: string): string {
  const html = `<!doctype html>
<html lang="zh-Hant">
  <head>
    <meta charset="utf-8" />
    <title>Mnemoshelf — 啟動失敗</title>
    <style>
      body { font-family: system-ui, sans-serif; margin: 0; padding: 3rem; background: #f6f7f9; color: #1f2430; }
      h1 { font-size: 1.35rem; }
      pre { white-space: pre-wrap; word-break: break-word; background: #fff; border: 1px solid #d8dbe2; border-radius: 8px; padding: 1rem; }
      p { color: #4b5364; }
    </style>
  </head>
  <body>
    <h1>${escapeHtml(title)}</h1>
    <pre>${escapeHtml(detail)}</pre>
    <p>${escapeHtml(hint)}</p>
  </body>
</html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

/** 開一個視窗；關閉時縮到系統匣（除非正在結束）。 */
function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1360,
    height: 900,
    show: false,
    title: "Mnemoshelf",
    // 安全預設：不開 nodeIntegration、contextIsolation 與 sandbox 維持預設開啟、不載入遠端內容；
    // preload 只暴露狀態（見 src/preload.cts），token 不會進 renderer。
    webPreferences: {
      preload: path.join(here, "preload.cjs"),
    },
  });
  window.once("ready-to-show", () => {
    if (!startHidden) window.show();
    notifyWindowReadyToShow();
  });
  window.on("close", (event) => {
    // 「關窗縮到系統匣」：服務繼續跑，之後可從匣選單把視窗叫回來。
    if (allowWindowClose || quitting || tray === null) return;
    event.preventDefault();
    window.hide();
    log("視窗已隱藏，服務仍在背景執行（可從系統匣圖示的選單開啟）");
  });
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
  });
  // renderer 的 console（含原生模組的警告）轉到啟動 log，方便驗收時直接看。
  window.webContents.on("console-message", (...args: unknown[]) => {
    const first = args[0] as { message?: unknown } | undefined;
    const message =
      first !== null && typeof first === "object" && typeof first.message === "string"
        ? first.message
        : typeof args[2] === "string"
          ? (args[2] as string)
          : "";
    if (message.trim() === "") return;
    rendererMessages.push(message);
    log(`[renderer] ${message}`);
  });
  return window;
}

/** 從系統匣（或 second-instance）把主視窗叫回來。 */
export function showMainWindow(reason: string): void {
  const window = mainWindow;
  if (window === null) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
  log(`已顯示主視窗（${reason}）`);
}

/** 系統匣選單的項目（驗收報告與斷言用；順序即實際選單順序）。 */
const TRAY_MENU_ITEMS = ["開啟主視窗", "離開"] as const;

/** 建立系統匣圖示與選單；失敗時回傳 null（不讓整支程式起不來）。 */
function createTray(): Tray | null {
  try {
    const image = createTrayImage({ platform: process.platform });
    const created = new Tray(image);
    created.setToolTip("Mnemoshelf");
    created.setContextMenu(
      Menu.buildFromTemplate([
        { label: TRAY_MENU_ITEMS[0], click: () => showMainWindow("系統匣") },
        { type: "separator" },
        { label: TRAY_MENU_ITEMS[1], click: () => exitFromTray() },
      ]),
    );
    created.on("click", () => showMainWindow("系統匣點擊"));
    log(`系統匣圖示已建立（選單：${TRAY_MENU_ITEMS.join("／")}）`);
    return created;
  } catch (error) {
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    log(`系統匣建立失敗（改為不隱藏視窗）：${detail}`);
    return null;
  }
}

/**
 * 系統匣「離開」：正常關閉（先收服務再結束）。
 *
 * 與 `scripts/smoke.mjs` 的驗收共用同一個入口，因此自動流程測到的就是使用者按的那條路徑。
 */
export function exitFromTray(): void {
  log("從系統匣選單結束應用程式");
  quitting = true;
  app.quit();
}

/**
 * 只關 server、不結束行程（更新安裝流程用）。
 *
 * 不得呼叫 `app.exit`、不得設定 `quitting`、不得刪 `runtime.json`（server 的 close
 * 自己處理）；可重入，重複呼叫只會關一次。關閉失敗時會 reject（共用同一個失敗），
 * 讓安裝流程取消備份與 `quitAndInstall`；一般的 `shutdown()` 會 catch 後照樣結束。
 */
const serverLifecycle = createServerLifecycle({
  closeServer: async () => {
    const closing = server;
    server = null;
    allowWindowClose = true;
    if (closing !== null) await closing.close();
  },
  exit: (code) => app.exit(code),
  beforeExit: () => {
    log(`授權統計：注入 Authorization 的請求 ${authCounters.injected}／${authCounters.requests}，401 回應 ${authCounters.unauthorized}`);
  },
  log,
});

/** 只收服務；不結束行程（更新安裝會先呼叫這個，再備份、安裝）。 */
async function closeServerOnly(): Promise<void> {
  await serverLifecycle.closeServerOnly();
}

/** 收掉服務後結束行程（資料庫是單一寫入者，先收乾淨再離開）。 */
async function shutdown(code: number): Promise<void> {
  await serverLifecycle.shutdown(code);
}

/** 顯示錯誤頁並等視窗就緒（用於啟動失敗）。 */
async function showFatal(title: string, detail: string, hint: string): Promise<void> {
  const window = createWindow();
  mainWindow = window;
  await window.loadURL(errorPageUrl(title, detail, hint));
  window.show();
}

/**
 * 只對本機服務的請求注入 `Authorization`：renderer 完全看不到 token。
 *
 * `onHeadersReceived` 只做統計（驗收要看「401 為零」）。
 */
function installTokenInjection(origin: string, token: string): void {
  const filter = { urls: [`${origin}/*`] };
  session.defaultSession.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
    const headers = details.requestHeaders;
    authCounters.requests += 1;
    if (headers["Authorization"] === undefined && headers["authorization"] === undefined) {
      headers["Authorization"] = `Bearer ${token}`;
      authCounters.injected += 1;
    }
    callback({ requestHeaders: headers });
  });
  session.defaultSession.webRequest.onHeadersReceived(filter, (details, callback) => {
    if (details.statusCode === 401) authCounters.unauthorized += 1;
    callback({ responseHeaders: details.responseHeaders });
  });
  // service worker 發出的請求攔不到（Electron 已知限制）；本 UI 不註冊 service worker。
  log(`已安裝 token 注入（只對 ${origin}；renderer 看不到 token）`);
}

/** 應用與環境資訊（給 UI 顯示）。 */
function appInfo(): DesktopAppInfo {
  return {
    name: app.getName(),
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    headless: cli.headless,
    isPackaged: app.isPackaged,
  };
}

function autostartOptions(): AutostartOptions {
  return {
    platform: process.platform,
    env: process.env,
    home: homedir(),
    execPath: process.execPath,
    // macOS／Windows 由系統管理登入項目；Linux 不需要這個 API。
    loginItems: process.platform === "linux" ? null : app,
  };
}

async function settingsState(): Promise<DesktopSettingsState> {
  const autostart: AutostartState = await readAutostartState(autostartOptions());
  const runtimeFile = desktopPaths?.runtimeFile ?? "";
  const present = runtimeFile === "" ? false : await runtimeFileExists(runtimeFile);
  return {
    app: appInfo(),
    token:
      tokenInfo ?? {
        source: "session",
        persisted: false,
        encryptionAvailable: false,
        location: "",
        notice: "尚未初始化 token。",
      },
    autostart,
    agentDiscovery: {
      enabled: agentSettings.agentDiscovery,
      active: agentDiscoveryActive,
      file: runtimeFile,
      present,
      error: agentDiscoveryDeleteError ?? agentDiscoveryWriteError,
    },
  };
}

/** 只有主視窗可以呼叫這些 IPC（其他 renderer 一律拒絕）。 */
function assertTrustedSender(event: IpcMainInvokeEvent): void {
  if (mainWindow !== null && event.sender === mainWindow.webContents) return;
  throw new Error("拒絕來自非主視窗的請求");
}

/** 檔案是否存在且是一般檔案（片段只指向真的存在的檔案）。 */
async function fileExists(file: string): Promise<boolean> {
  try {
    return (await fs.stat(file)).isFile();
  } catch {
    return false;
  }
}

function sendToRenderer(channel: string, payload: unknown): void {
  const window = mainWindow;
  if (window === null || window.isDestroyed()) return;
  window.webContents.send(channel, payload);
}

/** 目前更新狀態（未初始化時回 disabled；不含路徑或 token）。 */
function currentUpdaterState(): UpdaterState {
  return (
    updater?.getState() ??
    createInitialUpdaterState({ currentVersion: app.getVersion(), mode: "disabled" })
  );
}

/** 系統匣的提示文字跟著更新狀態走（選單維持既有兩項，不影響自動驗收）。 */
function updateTrayForUpdater(state: UpdaterState): void {
  if (tray === null || tray.isDestroyed()) return;
  tray.setToolTip(updaterTrayTooltip(state));
}

function registerIpcHandlers(): void {
  ipcMain.handle(DESKTOP_CHANNELS.bootstrapGet, (event): BootstrapState | null => {
    assertTrustedSender(event);
    return bootstrap?.getState() ?? null;
  });
  ipcMain.handle(DESKTOP_CHANNELS.bootstrapRetry, async (event): Promise<BootstrapState | null> => {
    assertTrustedSender(event);
    if (bootstrap === null) return null;
    return bootstrap.start();
  });
  ipcMain.handle(DESKTOP_CHANNELS.settingsGet, async (event): Promise<DesktopSettingsState> => {
    assertTrustedSender(event);
    return settingsState();
  });
  ipcMain.handle(DESKTOP_CHANNELS.settingsSetAutostart, async (event, enabled: unknown): Promise<DesktopSettingsState> => {
    assertTrustedSender(event);
    const next = await setAutostart(autostartOptions(), enabled === true);
    log(`開機自啟${next.enabled ? "已開啟" : "已關閉"}${next.location === null ? "" : `：${next.location}`}`);
    return settingsState();
  });
  ipcMain.handle(
    DESKTOP_CHANNELS.settingsSetAgentDiscovery,
    async (event, enabled: unknown): Promise<DesktopSettingsState> => {
      assertTrustedSender(event);
      const paths = desktopPaths;
      if (paths === null) throw new Error("桌面設定尚未初始化");
      const value = enabled === true;
      const result = await setAgentDiscovery({
        settingsFile: paths.settingsFile,
        runtimeFile: paths.runtimeFile,
        enabled: value,
        skippedUpdateVersion: agentSettings.skippedUpdateVersion ?? null,
        log,
      });
      agentSettings = result.settings;
      // 執行中的 server 不會因為這個開關而改變行為：任何變更都要重啟才生效，
      // 因此 active=false 讓設定頁顯示「重新啟動後生效」（關閉時檔案已立即刪除）。
      agentDiscoveryActive = false;
      // 關閉時：刪檔失敗的訊息要留著；開啟時清掉舊錯誤（重啟後才會重新寫檔）。
      agentDiscoveryDeleteError = result.error;
      agentDiscoveryWriteError = null;
      log(
        value
          ? "Agent 連線發現已開啟（重新啟動後才會寫出連線資訊檔）"
          : `Agent 連線發現已關閉（連線資訊檔${result.runtimeFileRemoved ? "已刪除" : "未清除"}）`,
      );
      return settingsState();
    },
  );
  ipcMain.handle(
    DESKTOP_CHANNELS.settingsCopyConnectionInfo,
    async (event): Promise<{ copied: boolean; url: string | null }> => {
      assertTrustedSender(event);
      if (server === null || tokenValue === null) return { copied: false, url: null };
      // 只有使用者按下按鈕才會走到這裡；內容含 token（設定頁文案已明示）。
      // Electron 44 的 clipboard 是 Promise API：要等寫入完成才回報成功。
      await clipboard.writeText(JSON.stringify({ url: server.url, token: tokenValue }));
      log("已將連線資訊複製到剪貼簿（含 token；不寫進 log）");
      return { copied: true, url: server.url };
    },
  );
  ipcMain.handle(
    DESKTOP_CHANNELS.settingsCopyMcpConfig,
    async (event): Promise<{ copied: boolean; url: string | null; reason: AgentGuideBlockedReason | null }> => {
      assertTrustedSender(event);
      if (server === null || desktopPaths === null) return { copied: false, url: null, reason: null };
      // 片段**不含 token**：MCP 入口會自己讀 runtime.json 取得連線資訊。
      // 這是刻意的——全權憑證不必經過剪貼簿與第三方的 MCP 設定檔。
      const entryPath = resolveMcpEntryPath({
        isPackaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
        appPath: app.getAppPath(),
      });
      // 貼上前先確認兩個路徑真的存在：片段指向不存在的檔案，client 只會啟動失敗。
      // AppImage 的掛載點每次啟動都不同，直接不給片段（改用環境變數連線）。
      // 閘門與「連接 Agent」頁共用同一支 `copyGate`，不要在這裡另寫一份判斷。
      const decision = copyGate({
        kind: "mcp-generic",
        appImage: process.env.APPIMAGE,
        runtimeFileExists: await runtimeFileExists(desktopPaths.runtimeFile),
        entryPathExists: await fileExists(entryPath),
      });
      if (!decision.allowed) {
        // 診斷輸出走 stderr；只記原因碼，不含 token、不含路徑。
        console.error(`[mnemoshelf-desktop] 未複製 MCP 設定片段：${decision.reason ?? "原因不明"}`);
        return { copied: false, url: null, reason: decision.reason };
      }
      // 片段文字只有一個來源（卡 1 的 `buildHarnessConfig`）；不在 handler 另組字串。
      const snippet = buildHarnessConfig("mcp-generic", {
        executablePath: process.execPath,
        entryPath,
        runtimeFile: desktopPaths.runtimeFile,
      });
      try {
        await clipboard.writeText(snippet);
      } catch {
        console.error("[mnemoshelf-desktop] 寫入剪貼簿失敗（MCP 設定片段）");
        return { copied: false, url: null, reason: "clipboard-failed" };
      }
      log("已將 MCP 設定片段複製到剪貼簿（不含 token；不寫進 log）");
      return { copied: true, url: server.url, reason: null };
    },
  );
  ipcMain.handle(DESKTOP_CHANNELS.agentGuideGetState, async (event): Promise<DesktopAgentGuideState> => {
    assertTrustedSender(event);
    if (desktopPaths === null) throw new Error("桌面設定尚未初始化");
    // 讀檔、判斷與預覽都在 main：renderer 只拿到狀態與原因碼，拿不到 token。
    return readAgentGuideState({
      home: homedir(),
      env: { DSH_HOME: process.env.DSH_HOME },
      appImage: process.env.APPIMAGE,
      runtimeFile: desktopPaths.runtimeFile,
      entryPath: resolveMcpEntryPath({
        isPackaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
        appPath: app.getAppPath(),
      }),
    });
  });
  ipcMain.handle(
    DESKTOP_CHANNELS.agentGuideCopy,
    async (event, kind: unknown): Promise<DesktopAgentGuideCopyResult> => {
      assertTrustedSender(event);
      // IPC 參數不信任型別：先用執行期白名單擋掉非字串與未知種類。
      if (typeof kind !== "string" || !AGENT_GUIDE_COPY_KINDS.includes(kind as AgentGuideCopyKind)) {
        return { copied: false, reason: "unknown-kind" };
      }
      const copyKind = kind as AgentGuideCopyKind;
      if (desktopPaths === null) throw new Error("桌面設定尚未初始化");
      const entryPath = resolveMcpEntryPath({
        isPackaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
        appPath: app.getAppPath(),
      });
      const decision = copyGate({
        kind: copyKind,
        appImage: process.env.APPIMAGE,
        runtimeFileExists: await runtimeFileExists(desktopPaths.runtimeFile),
        entryPathExists: await fileExists(entryPath),
      });
      if (!decision.allowed) {
        console.error(`[mnemoshelf-desktop] 未複製 Agent 片段（${copyKind}）：${decision.reason ?? "原因不明"}`);
        return { copied: false, reason: decision.reason };
      }
      // 複製文字只有一個來源：卡 1 的 `buildCopyText`（預覽也用它，兩者逐字相同）。
      const text = buildCopyText(copyKind, {
        executablePath: process.execPath,
        entryPath,
        runtimeFile: desktopPaths.runtimeFile,
      });
      try {
        await clipboard.writeText(text);
      } catch {
        console.error(`[mnemoshelf-desktop] 寫入剪貼簿失敗（${copyKind}）`);
        return { copied: false, reason: "clipboard-failed" };
      }
      log(`已複製連接 Agent 片段（${copyKind}；不含 token）`);
      return { copied: true, reason: null };
    },
  );
  ipcMain.handle(DESKTOP_CHANNELS.updaterGetState, (event): UpdaterState => {
    assertTrustedSender(event);
    return currentUpdaterState();
  });
  ipcMain.handle(DESKTOP_CHANNELS.updaterCheck, async (event): Promise<UpdaterState> => {
    assertTrustedSender(event);
    if (updater === null) return currentUpdaterState();
    return updater.check({ manual: true });
  });
  ipcMain.handle(DESKTOP_CHANNELS.updaterDownload, async (event): Promise<UpdaterState> => {
    assertTrustedSender(event);
    if (updater === null) return currentUpdaterState();
    return updater.download();
  });
  ipcMain.handle(DESKTOP_CHANNELS.updaterInstall, async (event, force: unknown): Promise<UpdaterState> => {
    assertTrustedSender(event);
    if (updater === null) return currentUpdaterState();
    // `force` 只在使用者已確認「備份失敗仍要安裝」時由 UI 傳 true。
    return updater.install({ force: force === true });
  });
  ipcMain.handle(DESKTOP_CHANNELS.updaterLater, async (event): Promise<UpdaterState> => {
    assertTrustedSender(event);
    if (updater === null) return currentUpdaterState();
    return updater.later();
  });
  ipcMain.handle(DESKTOP_CHANNELS.updaterOpenReleasePage, async (event): Promise<{ opened: boolean }> => {
    assertTrustedSender(event);
    if (updater === null) return { opened: false };
    return updater.openReleasePage();
  });
  ipcMain.handle(DESKTOP_CHANNELS.updaterRestartApp, (event): void => {
    assertTrustedSender(event);
    // 更新流程失敗時 Core 服務已經關閉；重新啟動是目前唯一能恢復服務的動作。
    app.relaunch();
    app.exit(0);
  });
  log(`已註冊 desktop shell API v${DESKTOP_API_VERSION}（bridge：window.${DESKTOP_BRIDGE_NAME}）`);
}

/**
 * 初始化更新器（在 server 起來之後、開視窗前）。
 *
 * - `--headless`／`!app.isPackaged`／其他平台：`shouldEnableUpdater()` 直接跳過。
 * - Linux／Windows：`createUpdater()` 會 lazy 載入 electron-updater 並設定
 *   `autoDownload=false`、`autoInstallOnAppQuit=false`。
 * - macOS：只建立 GitHub API 檢查器，不載入 electron-updater。
 * - 延遲 30 秒做第一次檢查，之後每 6 小時；手動 IPC 不受計時器限制。
 */
async function initializeUpdater(paths: DesktopPaths): Promise<void> {
  if (!shouldEnableUpdater({ platform: process.platform, isPackaged: app.isPackaged, headless: cli.headless })) {
    log("更新功能未啟用（開發模式、headless 或未支援的平台）");
    return;
  }

  updater = createUpdater({
    platform: process.platform,
    currentVersion: app.getVersion(),
    isPackaged: app.isPackaged,
    headless: cli.headless,
    github: { owner: "j7708git", repo: "mnemoshelf" },
    closeServerOnly,
    // 更新前備份：server 關閉後把 SQLite 檔複製到 <userData>/backups；
    // 備份失敗預設取消安裝（見 updater/index.ts）。
    backup: createFileBackup({ dataDir: paths.dataDir, backupsRoot: path.join(paths.userData, "backups") }),
    onQuitting: () => {
      quitting = true;
    },
    onQuitAborted: () => {
      quitting = false;
    },
    onStateChange: (state) => {
      sendToRenderer(DESKTOP_CHANNELS.updaterState, state);
      updateTrayForUpdater(state);
    },
    onAppImageRenamed: (newPath) => {
      const result = rewriteAutostartExecPath(autostartOptions(), newPath);
      if (result.updated) {
        log("AppImage 檔名已更新；開機自啟項目已改指新檔名");
        return "已更新開機自啟指向新檔名";
      }
      if (result.reason === "not-configured") return null;
      log(`AppImage 檔名已更新，但無法改寫開機自啟項目（${result.reason}）`);
      return "更新後請重新開啟開機自啟";
    },
    skippedVersionStore: {
      load: async () => agentSettings.skippedUpdateVersion ?? null,
      save: async (version) => {
        agentSettings = await setSkippedUpdateVersion(paths.settingsFile, agentSettings, version);
      },
    },
    // macOS 的 GitHub API 走 Electron net（沿用系統 proxy／憑證設定）。
    fetchImpl: (url) =>
      net.fetch(url, {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "Mnemoshelf-Desktop",
        },
      }),
    openExternal: (url) => shell.openExternal(url),
    installWatchdogMs: 30_000,
    log,
  });

  await updater.start();
  log(`更新功能已初始化（模式：${updater.mode}；目前版本 ${app.getVersion()}）`);
}

/** 啟動流程。 */
async function main(): Promise<void> {
  const appPath = app.getAppPath();
  const paths: DesktopPaths = resolveDesktopPaths({
    userData: app.getPath("userData"),
    resourcesPath: process.resourcesPath,
    ...(process.env.MNEMOSHELF_WEB_DIR === undefined ? {} : { webDir: process.env.MNEMOSHELF_WEB_DIR }),
  });
  desktopPaths = paths;
  // Agent 連線發現的桌面設定（預設 on；桌面值優先於 shell 的 MNEMOSHELF_AGENT_DISCOVERY）。
  agentSettings = await readAgentSettings(paths.settingsFile, log);
  log(`Agent 連線發現設定：${agentSettings.agentDiscovery ? "on" : "off"}（${paths.settingsFile}）`);
  const webDir = await resolveWebDir(paths.webDir, appPath);

  // macOS 的自啟走 SMAppService，`path`／`args` 是 Windows-only，登入時收不到 `--hidden`：
  // 改由 `wasOpenedAtLogin` 推導「這次是登入時啟動」，視同 `--hidden`（不彈視窗）並隱藏 Dock 圖示。
  if (openedAtLogin(autostartOptions())) {
    startHidden = true;
    app.dock?.hide();
    log("偵測到由登入項目啟動（wasOpenedAtLogin）：不主動顯示視窗");
  }

  log(`模式：headless=${String(cli.headless)}；hidden=${String(startHidden)}`);
  log(`Electron ${process.versions.electron}／Chromium ${process.versions.chrome}／Node ${process.versions.node}`);
  log(`isPackaged=${String(app.isPackaged)}；appPath=${appPath}；resourcesPath=${process.resourcesPath}`);
  log(`userData=${paths.userData}`);
  log(`dataDir=${paths.dataDir}；modelDir=${paths.modelDir}；webDir=${webDir}`);

  log("原生模組探測：");
  const moduleProbes = probeNativeModules();
  for (const report of moduleProbes) log(formatProbe(report));

  // sqlite-vec 的 loadExtension 需要真實檔案路徑（asar 內的 .so 開不起來）：
  // 必須在 createServer() 開啟資料庫之前包好 loadExtension。
  const shim = installLoadExtensionAsarShim();
  log(`loadExtension asar 路徑修正：${shim.installed ? "已安裝" : "未安裝"}（${shim.reason}）`);

  const tokenState = await loadOrCreateToken({
    tokenFile: paths.tokenFile,
    storage: {
      isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
      encryptString: (plain) => safeStorage.encryptString(plain),
      decryptString: (encrypted) => safeStorage.decryptString(encrypted),
    },
    generate: () => randomBytes(32).toString("hex"),
    ...(process.env.MNEMOSHELF_TOKEN === undefined ? {} : { env: process.env }),
    log,
  });
  tokenInfo = toTokenInfo(tokenState);
  tokenValue = tokenState.token;
  if (tokenInfo.notice !== null) log(`token 注意事項：${tokenInfo.notice}`);

  // 啟動期間 IPC 可能改掉 `agentSettings`：這裡先把「這次 server 實際用的值」固定下來，
  // 後面才不會用新值覆寫 active／誤報寫檔失敗（真正原因是「要重啟」）。
  const startupAgentDiscovery = agentSettings.agentDiscovery;
  try {
    server = await createServer({
      env: buildServerEnv({
        base: process.env,
        token: tokenState.token,
        dataDir: paths.dataDir,
        modelDir: paths.modelDir,
        webDir,
        // 桌面設定優先：這裡一律覆寫 shell 環境變數（含 runtime 檔路徑，設定頁才能刪同一個檔）。
        agentDiscovery: startupAgentDiscovery,
        runtimeFile: paths.runtimeFile,
      }),
    });
  } catch (error) {
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    log(`Core 服務啟動失敗：${detail}`);
    await showFatal("Core 服務啟動失敗", detail, "請關閉這個視窗後重新啟動應用程式；若持續失敗，請保留上面的訊息。");
    return;
  }

  log(`Core 服務已啟動：${server.url}（只綁 127.0.0.1；token 不寫進 log）`);
  const discoveryDecision = resolveStartupDiscovery({
    startup: startupAgentDiscovery,
    current: agentSettings.agentDiscovery,
  });
  agentDiscoveryActive = discoveryDecision.active;
  if (discoveryDecision.verifyFile) {
    // 寫檔失敗不會阻止 server 啟動（server 只記 warning）：這裡確認一下，設定頁才能明示。
    const written = await runtimeFileExists(paths.runtimeFile);
    agentDiscoveryWriteError = written ? null : "無法寫出連線資訊（可能是權限或磁碟問題）";
    log(
      written
        ? `Agent 連線資訊檔已寫出：${paths.runtimeFile}（內容含 token，不寫進 log）`
        : `Agent 連線資訊檔未寫出：${paths.runtimeFile}（服務照常執行）`,
    );
  } else {
    // 啟動時關閉，或啟動期間改過設定：這次執行沒有可檢查的寫檔結果（要重啟才生效）。
    agentDiscoveryWriteError = null;
    if (agentSettings.agentDiscovery !== startupAgentDiscovery) {
      log("Agent 連線發現設定在啟動期間被變更：重新啟動後生效");
    }
  }
  installTokenInjection(server.url, tokenState.token);
  registerIpcHandlers();

  if (cli.headless) {
    log("headless：不開視窗、不建立系統匣；只跑 Core 服務（收到 SIGINT／SIGTERM 會收乾淨後結束）");
    log(`headless：視窗數=${BrowserWindow.getAllWindows().length}；系統匣=未建立；略過模型預先下載（第一次索引時才會下載）`);
    await runAutotestIfRequested({ paths, webDir, moduleProbes, shim, tokenStateSource: tokenState.source, token: tokenState.token });
    return;
  }

  // 更新器在 server 起來、IPC 註冊之後初始化（不阻擋啟動；第一次檢查延遲 30 秒）。
  // 更新功能的任何失敗都不應讓應用起不來：狀態會停在 error，UI 仍可正常使用。
  try {
    await initializeUpdater(paths);
  } catch {
    log("更新功能初始化失敗（不影響應用啟動）");
  }

  const window = createWindow();
  mainWindow = window;
  try {
    await window.loadURL(server.url);
  } catch (error) {
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    log(`載入 UI 失敗：${detail}`);
    await showFatal("載入介面失敗", `${detail}\n\n服務網址：${server.url}`, "請關閉這個視窗後重新啟動應用程式。");
    return;
  }
  // 載入完成後只有在「不是 --hidden 啟動」時才顯示：開機自啟（登入時）不該彈出視窗。
  if (!startHidden) window.show();

  tray = createTray();
  // 更新器可能在 tray 建立前就先還原「稍後」的版本或進入錯誤狀態；補上目前 tooltip。
  updateTrayForUpdater(currentUpdaterState());

  bootstrap = new ModelBootstrap({
    profile: MODEL_PROFILE,
    modelDir: paths.modelDir,
    download: (context) => downloadModelFiles(context),
    // 下載完請 embedder 真的載入一次：通過才叫「可用」（順便暖機，之後第一次索引不必再等）。
    verify: async () => {
      if (server === null) throw new Error("Core 服務不在執行中，無法驗證模型");
      await server.embedder.embedQuery("Mnemoshelf 桌面殼的模型驗證查詢");
    },
    onUpdate: (state) => sendToRenderer(DESKTOP_CHANNELS.bootstrapUpdate, state),
    log,
  });
  log("開始檢查模型是否就緒…");
  void bootstrap.start();

  await runAutotestIfRequested({ paths, webDir, moduleProbes, shim, tokenStateSource: tokenState.source, token: tokenState.token });
}

/** 自動驗收（只有設了 `MNEMOSHELF_AUTOTEST` 才會載入；不是產品功能）。 */
async function runAutotestIfRequested(context: {
  paths: DesktopPaths;
  webDir: string;
  moduleProbes: ReturnType<typeof probeNativeModules>;
  shim: ReturnType<typeof installLoadExtensionAsarShim>;
  tokenStateSource: string;
  /** 目前的存取 token（只用於 browser 情境；不寫進報告）。 */
  token: string;
}): Promise<void> {
  const scenarios = process.env.MNEMOSHELF_AUTOTEST;
  if (scenarios === undefined || scenarios.trim() === "") return;
  if (server === null) return;

  const { runAutotest } = await import("./autotest.js");
  const result = await runAutotest({
    scenarios: scenarios.trim(),
    window: mainWindow,
    serverUrl: server.url,
    bootstrap: () => bootstrap?.getState() ?? null,
    modelDir: context.paths.modelDir,
    tray,
    trayMenuItems: TRAY_MENU_ITEMS,
    autostartFile: process.platform === "linux" ? autostartFilePath(autostartOptions()) : null,
    runtimeFile: context.paths.runtimeFile,
    outputDir: process.env.MNEMOSHELF_AUTOTEST_OUT ?? path.join(app.getPath("temp"), "mnemoshelf-desktop-autotest"),
    sampleRoot: process.env.MNEMOSHELF_AUTOTEST_SAMPLE_ROOT ?? "",
    sampleTextName: process.env.MNEMOSHELF_AUTOTEST_TEXT ?? "hello.txt",
    sampleImageName: process.env.MNEMOSHELF_AUTOTEST_IMAGE ?? "picture.png",
    searchQuery: process.env.MNEMOSHELF_AUTOTEST_QUERY ?? "桌面殼 系統匣",
    stepTimeoutMs: Number(process.env.MNEMOSHELF_AUTOTEST_STEP_TIMEOUT_MS ?? 60_000),
    indexTimeoutMs: Number(process.env.MNEMOSHELF_AUTOTEST_INDEX_TIMEOUT_MS ?? 1_800_000),
    bootstrapTimeoutMs: Number(process.env.MNEMOSHELF_AUTOTEST_BOOTSTRAP_TIMEOUT_MS ?? 1_800_000),
    killAfterProgress: process.env.MNEMOSHELF_AUTOTEST_KILL_AFTER_PROGRESS === "1",
    /** `hidden` 情境要在「第一次 ready-to-show 之後」斷言視窗仍不可見。 */
    startHidden,
    windowReadyToShow,
    environment: {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      isPackaged: app.isPackaged,
      appPath: app.getAppPath(),
      resourcesPath: process.resourcesPath,
      userData: context.paths.userData,
      dataDir: context.paths.dataDir,
      modelDir: context.paths.modelDir,
      webDir: context.webDir,
      tokenSource: context.tokenStateSource,
      serverUrl: server.url,
      serverStarted: server !== null,
      loadExtensionShim: context.shim,
      nativeProbe: context.moduleProbes.map((report) => formatProbe(report)),
      autostartFile: autostartFilePath(autostartOptions()),
      authCounters,
      trayCreated: tray !== null,
      trayMenuItems: TRAY_MENU_ITEMS,
    },
    rendererMessages,
    showMainWindow,
    exitFromTray,
    // 只在自動驗收裡模擬「使用者手動貼 token」；不會寫進報告或 log。
    browserToken: context.token,
    spawnSecondInstance: () =>
      new Promise((resolve) => {
        // 第二個實例要「同一個 userData」才會撞到同一個單一實例鎖；也刻意不帶自動驗收的環境變數。
        const env: NodeJS.ProcessEnv = { ...process.env };
        delete env.MNEMOSHELF_AUTOTEST;
        delete env.MNEMOSHELF_AUTOTEST_OUT;
        delete env.MNEMOSHELF_AUTOTEST_KILL_AFTER_PROGRESS;
        const child = spawn(process.execPath, [], { env, stdio: ["ignore", "pipe", "pipe"] });
        let output = "";
        log(`已啟動第二個實例：pid=${String(child.pid)}`);
        child.stdout.on("data", (chunk: Buffer) => {
          output += String(chunk);
        });
        child.stderr.on("data", (chunk: Buffer) => {
          output += String(chunk);
        });
        // 保險：萬一子行程沒有在時限內結束，也不要讓驗收卡住。
        const watchdog = setTimeout(() => {
          log("第二個實例沒有在時限內結束");
          resolve({ code: null, signal: "timeout" });
        }, 30_000);
        child.on("error", (error: Error) => {
          log(`第二個實例啟動失敗：${error.message}`);
        });
        // 用 'exit' 而不是 'close'：'close' 要等所有 pipe 都關閉，而 Chromium 的 helper 行程
        // 可能短暫持有那些 pipe（會讓等待多拖好幾秒）。
        child.on("exit", (code, signal) => {
          clearTimeout(watchdog);
          // 給 stdout 一點時間把最後幾行送完，再挑出第二個實例自己的訊息。
          setTimeout(() => {
            const line = output.split("\n").find((item) => item.includes("已有另一個 Mnemoshelf 在執行"));
            log(`第二個實例：code=${String(code)} signal=${String(signal)}${line === undefined ? "" : `；log：${line.trim()}`}`);
            resolve({ code, signal });
          }, 300);
        });
      }),
  });
  log(`自動驗收結果：${result.ok ? "全部步驟通過" : `失敗（${result.failure}）`}；報告：${result.reportPath}`);
  if (rendererMessages.some((message) => /glib/i.test(message))) {
    log("注意：renderer console 出現 glib 相關訊息（見上方 log）");
  }
  if (result.exitCode !== null) {
    quitting = true;
    await shutdown(result.exitCode);
  }
}

// 單一實例：兩個行程搶同一個 SQLite／同一個埠會壞掉。第二個實例把既有視窗帶到前景後結束。
if (!app.requestSingleInstanceLock()) {
  log("已有另一個 Mnemoshelf 在執行：這個行程直接結束");
  app.exit(0);
} else {
  app.on("second-instance", () => {
    showMainWindow("第二次啟動");
  });

  app.whenReady().then(main).catch(async (error: unknown) => {
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    log(`未預期的啟動錯誤：${detail}`);
    try {
      await showFatal("啟動時發生未預期的錯誤", detail, "請關閉這個視窗後重新啟動應用程式。");
    } catch {
      app.exit(1);
    }
  });

  // 關窗不結束：服務留在背景（系統匣）。真正結束只有兩條路：系統匣的「離開」或訊號。
  app.on("window-all-closed", () => {
    log("所有視窗都已關閉；服務仍在背景執行");
  });

  // 先讓服務把資料庫收乾淨再離開（單一寫入者契約：只有本行程開資料庫）。
  app.on("before-quit", (event) => {
    if (quitting || server === null) return;
    event.preventDefault();
    quitting = true;
    void shutdown(0);
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      log(`收到 ${signal}：關閉服務後結束`);
      quitting = true;
      void shutdown(0);
    });
  }
}
