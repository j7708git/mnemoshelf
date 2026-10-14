/**
 * Mnemoshelf 桌面殼：Electron main process（M4 spike 版）。
 *
 * 本輪只做「證明打包後能完整運作」的最小殼：
 *   1. 在 **main process 內**以程式方式啟動 Core 服務（`createServer()`；隨機埠、token、只綁 127.0.0.1）；
 *   2. 把模型快取指到 `app.getPath("userData")/models`（transformers.js 的預設會落在唯讀的 `app.asar` 內）；
 *   3. 開一個視窗載入 Core 服務同源提供的 Web UI（靜態檔在 `resources/web`，asar 之外）；
 *   4. 啟動失敗時顯示可讀的錯誤頁，不留白屏。
 *
 * 刻意**不做**（屬 M4 後續卡片）：系統匣／關窗縮匣／單一實例鎖、`safeStorage` token 管理與
 * `webRequest` 注入、開機自啟、headless 模式、模型下載進度 UI、安裝檔與 CI。
 *
 * 起始條件（M4 打包研究結論，2026-10 查證）：四個原生模組（better-sqlite3／sqlite-vec／
 * onnxruntime-node／sharp）都是 N-API／Node-API，不需 `@electron/rebuild`；真正要處理的是
 * asar 解包（見 `electron-builder.yml` 的 `asarUnpack`）與 sharp 在 Linux 的 glib 風險。
 */
import { BrowserWindow, app } from "electron";
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createServer, type MnemoshelfServer } from "@mnemoshelf/server";
import { installLoadExtensionAsarShim } from "./asar-paths.js";
import { formatProbe, probeNativeModules } from "./native-probe.js";
import { buildServerEnv, decideToken, resolveDesktopPaths, type DesktopPaths } from "./paths.js";

/** 統一的啟動 log 前綴（`scripts/smoke.mjs` 會擷取）。 */
function log(message: string): void {
  console.log(`[mnemoshelf-desktop] ${message}`);
}

let server: MnemoshelfServer | null = null;
let mainWindow: BrowserWindow | null = null;
let quitting = false;

/** renderer 的 console 訊息（含 sharp 之類原生模組的警告），啟動 log 會一併印出。 */
const rendererMessages: string[] = [];

// 應用名稱決定 `app.getPath("userData")` 的預設位置。打包後的 package.json 只有 scoped
// name（`@mnemoshelf/desktop`，且不含 productName），直接沿用會變成奇怪的路徑，因此在
// 任何 getPath("userData") 之前先固定成 Mnemoshelf。
app.setName("Mnemoshelf");

// userData 可在啟動前覆寫（spike 驗收用：讓每次跑都用乾淨的目錄，確認模型真的下載到 userData）。
const userDataOverride = process.env.MNEMOSHELF_DESKTOP_USER_DATA;
if (userDataOverride !== undefined && userDataOverride.trim() !== "") {
  app.setPath("userData", path.resolve(userDataOverride));
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

/** 啟動失敗時顯示的錯誤頁（不讓使用者看到白屏）。 */
function errorPageUrl(title: string, detail: string): string {
  const escape = (value: string): string =>
    value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
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
    <h1>${escape(title)}</h1>
    <pre>${escape(detail)}</pre>
    <p>這是桌面殼的 spike 版本：沒有自動重試。請關閉視窗後重新啟動；若持續失敗，請把上面的訊息保留下來。</p>
  </body>
</html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

/** 開一個視窗載入 Core 服務的網址；失敗時載入錯誤頁。 */
function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1360,
    height: 900,
    show: false,
    title: "Mnemoshelf",
    // 安全預設：不開 nodeIntegration、contextIsolation 與 sandbox 維持預設開啟、不載入遠端內容。
    webPreferences: {},
  });
  window.once("ready-to-show", () => window.show());
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

/** 收掉服務後結束行程（資料庫是單一寫入者，先收乾淨再離開）。 */
async function shutdown(code: number): Promise<void> {
  const closing = server;
  server = null;
  if (closing !== null) {
    await closing
      .close()
      .catch((error: unknown) => log(`關閉服務時發生錯誤：${error instanceof Error ? error.message : String(error)}`));
  }
  app.exit(code);
}

/** 顯示錯誤頁並等視窗就緒（用於啟動失敗）。 */
async function showFatal(title: string, detail: string): Promise<void> {
  const window = createWindow();
  mainWindow = window;
  await window.loadURL(errorPageUrl(title, detail));
  window.show();
}

/** 啟動流程。 */
async function main(): Promise<void> {
  const appPath = app.getAppPath();
  const paths: DesktopPaths = resolveDesktopPaths({
    userData: app.getPath("userData"),
    resourcesPath: process.resourcesPath,
    ...(process.env.MNEMOSHELF_WEB_DIR === undefined ? {} : { webDir: process.env.MNEMOSHELF_WEB_DIR }),
  });
  const webDir = await resolveWebDir(paths.webDir, appPath);

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

  const decision = decideToken(process.env, () => randomBytes(32).toString("hex"));
  if (decision.source === "generated") {
    // spike 限定的 token 落地方式（正式的 safeStorage 管理是下一張卡）。
    await fs.mkdir(paths.userData, { recursive: true });
    await fs.writeFile(paths.tokenFile, `${decision.token}\n`, { mode: 0o600 });
    log(`已產生 token 並寫入 ${paths.tokenFile}（啟動後貼進視窗即可）`);
  } else {
    log("使用環境變數 MNEMOSHELF_TOKEN 帶入的 token");
  }

  try {
    server = await createServer({
      env: buildServerEnv({
        base: process.env,
        token: decision.token,
        dataDir: paths.dataDir,
        modelDir: paths.modelDir,
        webDir,
      }),
    });
  } catch (error) {
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    log(`Core 服務啟動失敗：${detail}`);
    await showFatal("Core 服務啟動失敗", detail);
    return;
  }

  log(`Core 服務已啟動：${server.url}（只綁 127.0.0.1；token 不寫進 log）`);

  const window = createWindow();
  mainWindow = window;
  try {
    await window.loadURL(server.url);
  } catch (error) {
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    log(`載入 UI 失敗：${detail}`);
    await showFatal("載入介面失敗", `${detail}\n\n服務網址：${server.url}`);
    return;
  }
  window.show();

  const sampleRoot = process.env.MNEMOSHELF_SPIKE_AUTOTEST;
  if (sampleRoot === undefined || sampleRoot.trim() === "") return;

  // spike 自動驗收：在真實視窗內把「貼 token → 加入資料夾 → 索引 → 搜尋 → 預覽」跑一遍。
  const outputDir =
    process.env.MNEMOSHELF_SPIKE_AUTOTEST_OUT ?? path.join(app.getPath("temp"), "mnemoshelf-spike-report");
  const { runSpikeAutotest } = await import("./spike-autotest.js");
  const tokenForUi = (await fs.readFile(paths.tokenFile, "utf8").catch(() => "")).trim() || decision.token;

  log(`自動驗收啟動：樣本目錄=${sampleRoot}；產物目錄=${outputDir}`);
  const result = await runSpikeAutotest({
    window,
    token: tokenForUi,
    sampleRoot: path.resolve(sampleRoot),
    sampleTextName: process.env.MNEMOSHELF_SPIKE_TEXT ?? "hello.txt",
    sampleImageName: process.env.MNEMOSHELF_SPIKE_IMAGE ?? "picture.png",
    searchQuery: process.env.MNEMOSHELF_SPIKE_QUERY ?? "儲存介面 設計",
    outputDir,
    stepTimeoutMs: Number(process.env.MNEMOSHELF_SPIKE_STEP_TIMEOUT_MS ?? 60_000),
    indexTimeoutMs: Number(process.env.MNEMOSHELF_SPIKE_INDEX_TIMEOUT_MS ?? 1_800_000),
    modelDir: paths.modelDir,
    environment: {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      isPackaged: app.isPackaged,
      appPath,
      resourcesPath: process.resourcesPath,
      userData: paths.userData,
      dataDir: paths.dataDir,
      modelDir: paths.modelDir,
      webDir,
      tokenSource: decision.source,
      tokenFile: paths.tokenFile,
      serverUrl: server.url,
      loadExtensionShim: shim,
      nativeProbe: moduleProbes.map((report) => formatProbe(report)),
    },
    rendererMessages,
  });
  log(`自動驗收結果：${result.ok ? "全部步驟通過" : `失敗（${result.failure}）`}；報告：${result.reportPath}`);
  if (rendererMessages.some((message) => /glib/i.test(message))) {
    log("注意：renderer console 出現 glib 相關訊息（見上方 log）");
  }
  await shutdown(result.ok ? 0 : 1);
}

app.whenReady().then(main).catch(async (error: unknown) => {
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  log(`未預期的啟動錯誤：${detail}`);
  try {
    await showFatal("啟動時發生未預期的錯誤", detail);
  } catch {
    app.exit(1);
  }
});

app.on("window-all-closed", () => {
  app.quit();
});

// 先讓服務把資料庫收乾淨再離開（單一寫入者契約：只有本行程開資料庫）。
app.on("before-quit", (event) => {
  if (quitting || server === null) return;
  event.preventDefault();
  quitting = true;
  void shutdown(0);
});
