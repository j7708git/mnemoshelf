/**
 * 開機自啟（三平台）：
 *
 * - **Linux**：Electron 的 `app.setLoginItemSettings()` 不支援（官方文件標題即寫 macOS／Windows），
 *   因此直接寫 XDG autostart 檔 `<XDG_CONFIG_HOME|~/.config>/autostart/mnemoshelf.desktop`；
 *   停用時把該檔刪除。
 * - **macOS／Windows**：交給 `app.setLoginItemSettings({ openAtLogin })`（由系統管理，
 *   因此沒有「落地檔案」可列）。
 *   - Windows：`path`／`args` 會被寫進登錄值，而 `getLoginItemSettings` 也會拿同一組
 *     `path`＋`args` 逐字比對，所以**讀回狀態時必須帶同一組 args**，否則永遠讀成「未啟用」，
 *     設定畫面的開關會立刻跳回未勾選。
 *   - macOS：自啟走 SMAppService，**不吃 `path`／`args`**，登入時收不到 `--hidden`；
 *     改由 `wasOpenedAtLogin` 推導「這次是登入時啟動」（見 `openedAtLogin()`）。
 *
 * 目錄一律取 `XDG_CONFIG_HOME`，讓驗收可以在暫存目錄裡測，不會動到使用者真正的
 * `~/.config/autostart`。本檔不碰 electron，平台 API 由呼叫端注入，方便單元測試。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

/** `app` 上與登入項目有關的兩個方法（注入以便測試）。 */
export interface LoginItemApi {
  getLoginItemSettings(options?: { path?: string; args?: string[] }): {
    openAtLogin: boolean;
    /** macOS：這次是不是由登入項目帶起來的（其他平台為 undefined）。 */
    wasOpenedAtLogin?: boolean;
  };
  setLoginItemSettings(settings: { openAtLogin: boolean; path?: string; args?: string[] }): void;
}

export interface AutostartState {
  /** 目前是否已設定開機自啟。 */
  enabled: boolean;
  /** 這個平台是否支援（第一版：linux／darwin／win32）。 */
  supported: boolean;
  /** 設定落地位置（Linux 的 .desktop 檔）；由系統管理的平台為 null。 */
  location: string | null;
  /** 給使用者看的短說明。 */
  detail: string;
}

export interface AutostartOptions {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  /** 家目錄（只用來組 `~/.config`，呼叫端傳 `os.homedir()`）。 */
  home: string;
  /** 應用程式執行檔（打包後是 `process.execPath`）。 */
  execPath: string;
  /** 自啟時帶的參數（預設 `--hidden`：登入後直接進系統匣，不彈視窗）。 */
  args?: readonly string[];
  /** macOS／Windows 用的 electron `app`；Linux 不需要。 */
  loginItems?: LoginItemApi | null;
}

/** autostart 檔的檔名（appId 相同，不隨版本變動）。 */
export const AUTOSTART_FILE_NAME = "mnemoshelf.desktop";

/** Linux 的設定根目錄：`XDG_CONFIG_HOME` 優先，否則 `~/.config`。 */
export function configHome(env: NodeJS.ProcessEnv, home: string): string {
  const xdg = env.XDG_CONFIG_HOME;
  if (xdg !== undefined && xdg.trim() !== "") return path.resolve(xdg);
  return path.join(home, ".config");
}

/** Linux 的 autostart 檔路徑。 */
export function autostartFilePath(options: AutostartOptions): string {
  return path.join(configHome(options.env, options.home), "autostart", AUTOSTART_FILE_NAME);
}

/** 自啟時實際帶的參數。 */
export function autostartArgs(options: AutostartOptions): string[] {
  return [...(options.args ?? ["--hidden"])];
}

/**
 * 這次啟動是不是「登入時由系統的登入項目帶起來的」（macOS 限定）。
 *
 * 為什麼需要：`setLoginItemSettings` 的 `path`／`args` 是 **Windows-only**，macOS 走
 * SMAppService，登入時拿不到 `--hidden`，因此不能靠命令列參數判斷要不要隱藏視窗。
 * macOS 的 `getLoginItemSettings()` 另外提供 `wasOpenedAtLogin`，用它推導同一件事
 * （`main.ts` 據此視同 `--hidden`）。其他平台一律回 false：Windows 的 `--hidden`
 * 是經由參數傳遞的，不需要（也不該）從這裡推導。
 */
export function openedAtLogin(options: AutostartOptions): boolean {
  if (options.platform !== "darwin") return false;
  const loginItems = options.loginItems;
  if (loginItems === null || loginItems === undefined) return false;
  // macOS 的 getLoginItemSettings 不吃 path／args（Windows-only），因此不傳選項。
  return loginItems.getLoginItemSettings().wasOpenedAtLogin === true;
}

/**
 * `.desktop` 檔的 `Exec` 值：桌面環境會自己解析這行，因此含空白或保留字元時要加引號
 * （freedesktop 規範：雙引號內以反斜線逃脫 `"`、`` ` ``、`$`、`\`）。
 */
export function quoteExecArgument(value: string): string {
  return `"${value.replace(/(["`$\\])/g, "\\$1")}"`;
}

/** autostart 的 `.desktop` 檔內容。 */
export function desktopEntryContent(options: AutostartOptions): string {
  const exec = [options.execPath, ...autostartArgs(options)].map(quoteExecArgument).join(" ");
  return [
    "[Desktop Entry]",
    "Type=Application",
    "Name=Mnemoshelf",
    "Comment=本機記憶與檔案搜尋（常駐服務；啟動後縮到系統匣）",
    `Exec=${exec}`,
    "Terminal=false",
    "NoDisplay=false",
    "X-GNOME-Autostart-enabled=true",
    "",
  ].join("\n");
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.stat(file);
    return true;
  } catch {
    return false;
  }
}

/** 讀出目前的開機自啟狀態。 */
export async function readAutostartState(options: AutostartOptions): Promise<AutostartState> {
  if (options.platform === "darwin" || options.platform === "win32") {
    const loginItems = options.loginItems;
    if (loginItems === null || loginItems === undefined) {
      return {
        enabled: false,
        supported: false,
        location: null,
        detail: "這個環境沒有提供系統的登入項目 API，無法讀取開機自啟狀態。",
      };
    }
    // Windows 的 `getLoginItemSettings` 會把登錄值與 `FormatCommandLineString(path, args)` 逐字比對
    // （`args` 的預設值是空陣列），因此讀回時必須帶**同一組** args（`setAutostart` 寫入時帶了
    // `--hidden`）；只帶 path 會永遠讀成 false，設定畫面的開關會立刻跳回未勾選。
    // `path`／`args` 是 Windows-only 的選項（Electron 型別標註 @platform win32），macOS 依
    // 文件是被忽略的：那裡的登入啟動改用 `wasOpenedAtLogin` 推導（見 `openedAtLogin()`）。
    const enabled = loginItems.getLoginItemSettings({
      path: options.execPath,
      args: autostartArgs(options),
    }).openAtLogin;
    return {
      enabled,
      supported: true,
      location: null,
      detail: "由作業系統的登入項目管理（沒有落地檔案可列）。",
    };
  }

  if (options.platform !== "linux") {
    return {
      enabled: false,
      supported: false,
      location: null,
      detail: `這個平台（${options.platform}）尚未支援開機自啟。`,
    };
  }

  const file = autostartFilePath(options);
  const enabled = await exists(file);
  return {
    enabled,
    supported: true,
    location: file,
    detail: enabled ? "已在 autostart 目錄建立啟動項目。" : "autostart 目錄沒有 Mnemoshelf 的啟動項目。",
  };
}

/** 開啟或關閉開機自啟；回傳更新後的狀態。 */
export async function setAutostart(options: AutostartOptions, enabled: boolean): Promise<AutostartState> {
  if (options.platform === "darwin" || options.platform === "win32") {
    const loginItems = options.loginItems;
    if (loginItems === null || loginItems === undefined) {
      throw new Error("這個環境沒有提供系統的登入項目 API，無法設定開機自啟。");
    }
    loginItems.setLoginItemSettings({
      openAtLogin: enabled,
      path: options.execPath,
      args: autostartArgs(options),
    });
    return readAutostartState(options);
  }

  if (options.platform !== "linux") {
    throw new Error(`這個平台（${options.platform}）尚未支援開機自啟。`);
  }

  const file = autostartFilePath(options);
  if (enabled) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, desktopEntryContent(options), { mode: 0o644 });
  } else {
    await fs.rm(file, { force: true });
  }
  return readAutostartState(options);
}
