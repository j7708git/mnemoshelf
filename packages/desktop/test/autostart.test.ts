import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  autostartArgs,
  autostartFilePath,
  configHome,
  desktopEntryContent,
  openedAtLogin,
  quoteExecArgument,
  readAutostartState,
  rewriteAutostartExecPath,
  setAutostart,
  type AutostartOptions,
  type LoginItemApi,
} from "../src/autostart.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "mnemoshelf-autostart-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

/** 驗收用的設定：XDG_CONFIG_HOME 指到暫存目錄，不會動到使用者真正的 autostart。 */
function options(overrides: Partial<AutostartOptions> = {}): AutostartOptions {
  return {
    platform: "linux",
    env: { XDG_CONFIG_HOME: dir },
    home: path.join("home", "example"),
    execPath: path.join("opt", "Mnemoshelf", "mnemoshelf"),
    ...overrides,
  };
}

describe("configHome", () => {
  it("優先用 XDG_CONFIG_HOME，沒有時退回 ~/.config", () => {
    expect(configHome({ XDG_CONFIG_HOME: path.join("tmp", "cfg") }, path.join("home", "example"))).toBe(
      path.resolve(path.join("tmp", "cfg")),
    );
    expect(configHome({}, path.join("home", "example"))).toBe(path.join(path.join("home", "example"), ".config"));
    expect(configHome({ XDG_CONFIG_HOME: "  " }, path.join("home", "example"))).toBe(
      path.join(path.join("home", "example"), ".config"),
    );
  });
});

describe("desktop entry", () => {
  it("autostart 檔案路徑在 <config>/autostart 底下", () => {
    expect(autostartFilePath(options())).toBe(path.join(dir, "autostart", "mnemoshelf.desktop"));
  });

  it("Exec 會引用路徑並帶 --hidden（登入時直接進系統匣）", () => {
    expect(autostartArgs(options())).toEqual(["--hidden"]);
    const content = desktopEntryContent(options({ execPath: "mnemoshelf" }));
    expect(content).toContain(`Exec="mnemoshelf" "--hidden"`);
    expect(content).toContain("[Desktop Entry]");
    expect(content).toContain("X-GNOME-Autostart-enabled=true");
  });

  it("含空白與保留字元的路徑會被正確引用", () => {
    // freedesktop 規範：雙引號內要把 `"`、`` ` ``、`$`、`\` 以反斜線逃脫。
    expect(quoteExecArgument('a "b$c`d\\e')).toBe('"a \\"b\\$c\\`d\\\\e"');
  });
});

describe("Linux 的開機自啟", () => {
  it("預設是關閉的", async () => {
    const state = await readAutostartState(options());
    expect(state).toMatchObject({ enabled: false, supported: true });
    expect(state.location).toBe(path.join(dir, "autostart", "mnemoshelf.desktop"));
  });

  it("開啟後寫出 .desktop 檔，關閉後刪掉", async () => {
    const enabled = await setAutostart(options(), true);
    expect(enabled.enabled).toBe(true);
    const file = path.join(dir, "autostart", "mnemoshelf.desktop");
    expect((await fs.stat(file)).isFile()).toBe(true);

    const disabled = await setAutostart(options(), false);
    expect(disabled.enabled).toBe(false);
    await expect(fs.stat(file)).rejects.toThrow();
  });

  it("關閉時檔案不存在也不會出錯（冪等）", async () => {
    await expect(setAutostart(options(), false)).resolves.toMatchObject({ enabled: false });
  });
});

describe("macOS／Windows 的開機自啟", () => {
  function loginItems(initial = false): LoginItemApi & { calls: { openAtLogin: boolean; args?: string[] }[] } {
    let openAtLogin = initial;
    const calls: { openAtLogin: boolean; args?: string[] }[] = [];
    return {
      calls,
      getLoginItemSettings: () => ({ openAtLogin }),
      setLoginItemSettings: (settings) => {
        openAtLogin = settings.openAtLogin;
        calls.push({ openAtLogin: settings.openAtLogin, ...(settings.args === undefined ? {} : { args: [...settings.args] }) });
      },
    };
  }

  it("走系統 API，不落地檔案", async () => {
    const api = loginItems();
    const state = await setAutostart(options({ platform: "darwin", loginItems: api }), true);
    expect(state).toMatchObject({ enabled: true, supported: true, location: null });
    expect(api.calls).toEqual([{ openAtLogin: true, args: ["--hidden"] }]);
  });

  it("讀回狀態時帶同一組 path／args（Windows 逐字比對登錄值，只帶 path 會永遠讀成未啟用）", async () => {
    // 模擬 Windows 的行為：只有 path 與 args 都與註冊值相同才回報已啟用。
    const registered = { path: options().execPath, args: ["--hidden"] };
    const seen: { path?: string; args?: string[] }[] = [];
    const api: LoginItemApi = {
      getLoginItemSettings: (settings) => {
        seen.push({ ...(settings ?? {}) });
        return {
          openAtLogin:
            settings?.path === registered.path && JSON.stringify(settings.args) === JSON.stringify(registered.args),
        };
      },
      setLoginItemSettings: () => undefined,
    };

    const state = await readAutostartState(options({ platform: "win32", loginItems: api }));

    expect(seen).toEqual([{ path: registered.path, args: ["--hidden"] }]);
    expect(state).toMatchObject({ enabled: true, supported: true, location: null });
  });

  it("沒有系統 API 時回報不支援", async () => {
    const state = await readAutostartState(options({ platform: "win32", loginItems: null }));
    expect(state.supported).toBe(false);
    await expect(setAutostart(options({ platform: "win32", loginItems: null }), true)).rejects.toThrow();
  });
});

describe("登入時啟動的推導（macOS）", () => {
  function loginItems(settings: { openAtLogin: boolean; wasOpenedAtLogin?: boolean }): LoginItemApi {
    return {
      getLoginItemSettings: () => settings,
      setLoginItemSettings: () => undefined,
    };
  }

  it("darwin 以 wasOpenedAtLogin 推導（SMAppService 不吃 --hidden）", () => {
    const opened = loginItems({ openAtLogin: true, wasOpenedAtLogin: true });
    expect(openedAtLogin(options({ platform: "darwin", loginItems: opened }))).toBe(true);
    const notOpened = loginItems({ openAtLogin: true, wasOpenedAtLogin: false });
    expect(openedAtLogin(options({ platform: "darwin", loginItems: notOpened }))).toBe(false);
  });

  it("其他平台一律 false（Windows 的 --hidden 由參數傳遞）", () => {
    const opened = loginItems({ openAtLogin: true, wasOpenedAtLogin: true });
    expect(openedAtLogin(options({ platform: "win32", loginItems: opened }))).toBe(false);
    expect(openedAtLogin(options({ platform: "linux", loginItems: opened }))).toBe(false);
  });

  it("沒有登入項目 API 時為 false", () => {
    expect(openedAtLogin(options({ platform: "darwin", loginItems: null }))).toBe(false);
  });
});

describe("其他平台", () => {
  it("明確回報不支援", async () => {
    const state = await readAutostartState(options({ platform: "freebsd" }));
    expect(state.supported).toBe(false);
    expect(state.enabled).toBe(false);
    await expect(setAutostart(options({ platform: "freebsd" }), true)).rejects.toThrow();
  });
});

describe("AppImage 改名後更新自啟項（appimage-filename-updated）", () => {
  const appImage = (version: string): string => path.join(os.tmpdir(), `Mnemoshelf-${version}-linux-x86_64.AppImage`);

  it("只改 Exec 指向新檔案，保留 --hidden 與其他鍵", async () => {
    const original = appImage("0.4.1");
    const updated = appImage("0.5.1");
    await setAutostart(options({ execPath: original }), true);
    const file = path.join(dir, "autostart", "mnemoshelf.desktop");

    const result = rewriteAutostartExecPath(options({ execPath: original }), updated);
    expect(result).toEqual({ updated: true, file });

    const content = await fs.readFile(file, "utf8");
    expect(content).toContain(`Exec="${updated}" "--hidden"`);
    expect(content).not.toContain(original);
    expect(content).toContain("X-GNOME-Autostart-enabled=true");
  });

  it("沒有自啟項時不建立（not-configured）", async () => {
    const result = rewriteAutostartExecPath(options(), appImage("0.5.1"));
    expect(result).toEqual({ updated: false, reason: "not-configured" });
    await expect(fs.stat(path.join(dir, "autostart", "mnemoshelf.desktop"))).rejects.toThrow();
  });

  it("非 Linux 平台不處理", () => {
    const result = rewriteAutostartExecPath(options({ platform: "darwin" }), path.join(os.tmpdir(), "Mnemoshelf.app"));
    expect(result).toEqual({ updated: false, reason: "unsupported-platform" });
  });
});
