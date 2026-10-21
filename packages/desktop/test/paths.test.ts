import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildServerEnv, parseCliArgs, resolveDesktopPaths } from "../src/paths.js";

/** 測試用的相對目錄（交給受測程式 path.resolve，不假設平台分隔符）。 */
const USER_DATA = path.join("tmp", "example-user-data");
const RESOURCES = path.join("tmp", "example-resources");

describe("resolveDesktopPaths", () => {
  it("把資料、模型與 token 檔放在 userData 底下（模型不得落在安裝目錄）", () => {
    const paths = resolveDesktopPaths({ userData: USER_DATA, resourcesPath: RESOURCES });
    expect(paths.userData).toBe(path.resolve(USER_DATA));
    expect(paths.modelDir).toBe(path.join(path.resolve(USER_DATA), "models"));
    expect(paths.dataDir).toBe(path.join(path.resolve(USER_DATA), "data"));
    expect(paths.tokenFile).toBe(path.join(path.resolve(USER_DATA), "token.bin"));
    expect(paths.settingsFile).toBe(path.join(path.resolve(USER_DATA), "agentSettings.json"));
    expect(paths.runtimeFile).toBe(path.join(path.resolve(USER_DATA), "data", "runtime.json"));
  });

  it("Web UI 預設在 resources/web（asar 之外）", () => {
    const paths = resolveDesktopPaths({ userData: USER_DATA, resourcesPath: RESOURCES });
    expect(paths.webDir).toBe(path.join(path.resolve(RESOURCES), "web"));
  });

  it("可以用 webDir 覆寫 Web UI 目錄", () => {
    const custom = path.join("tmp", "example-web");
    const paths = resolveDesktopPaths({ userData: USER_DATA, resourcesPath: RESOURCES, webDir: custom });
    expect(paths.webDir).toBe(path.resolve(custom));
  });
});

describe("parseCliArgs", () => {
  it("認得 --headless 與 --hidden", () => {
    expect(parseCliArgs([])).toEqual({ headless: false, hidden: false });
    expect(parseCliArgs(["--headless"])).toEqual({ headless: true, hidden: false });
    expect(parseCliArgs(["--hidden"])).toEqual({ headless: false, hidden: true });
    expect(parseCliArgs(["--hidden", "--headless"])).toEqual({ headless: true, hidden: true });
  });

  it("忽略 Electron／Chromium 自己的參數", () => {
    const argv = ["--no-sandbox", "--inspect", "--headless", "some-file"];
    expect(parseCliArgs(argv)).toEqual({ headless: true, hidden: false });
  });
});

describe("buildServerEnv", () => {
  it("覆寫四個路徑變數與埠，其餘環境變數保留", () => {
    const env = buildServerEnv({
      base: { PATH: "/usr/bin" },
      token: "tok",
      dataDir: "/data",
      modelDir: "/models",
      webDir: "/web",
      agentDiscovery: true,
      runtimeFile: "/data/runtime.json",
    });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.MNEMOSHELF_TOKEN).toBe("tok");
    expect(env.MNEMOSHELF_DATA_DIR).toBe("/data");
    expect(env.MNEMOSHELF_MODEL_DIR).toBe("/models");
    expect(env.MNEMOSHELF_WEB_DIR).toBe("/web");
    expect(env.MNEMOSHELF_AGENT_DISCOVERY).toBe("on");
    expect(env.MNEMOSHELF_RUNTIME_FILE).toBe("/data/runtime.json");
    // 預設由 OS 指派隨機埠（只綁 127.0.0.1），不沿用外部帶進來的埠。
    expect(env.MNEMOSHELF_PORT).toBe("0");
  });

  it("外部明確指定埠時沿用（headless 用固定埠驗收）", () => {
    const env = buildServerEnv({
      base: { MNEMOSHELF_PORT: "8799" },
      token: "tok",
      dataDir: "/data",
      modelDir: "/models",
      webDir: "/web",
      agentDiscovery: false,
      runtimeFile: "/data/runtime.json",
    });
    expect(env.MNEMOSHELF_PORT).toBe("8799");
    expect(env.MNEMOSHELF_AGENT_DISCOVERY).toBe("off");
  });

  it("埠變數是空字串時回到隨機埠", () => {
    const env = buildServerEnv({
      base: { MNEMOSHELF_PORT: "   " },
      token: "tok",
      dataDir: "/data",
      modelDir: "/models",
      webDir: "/web",
      agentDiscovery: true,
      runtimeFile: "/data/runtime.json",
    });
    expect(env.MNEMOSHELF_PORT).toBe("0");
  });

  it("桌面設定優先於 shell 環境變數（agentDiscovery 與 runtime 檔）", () => {
    const env = buildServerEnv({
      base: { MNEMOSHELF_AGENT_DISCOVERY: "on", MNEMOSHELF_RUNTIME_FILE: "/elsewhere/runtime.json" },
      token: "tok",
      dataDir: "/data",
      modelDir: "/models",
      webDir: "/web",
      agentDiscovery: false,
      runtimeFile: "/data/runtime.json",
    });
    expect(env.MNEMOSHELF_AGENT_DISCOVERY).toBe("off");
    expect(env.MNEMOSHELF_RUNTIME_FILE).toBe("/data/runtime.json");
  });
});
