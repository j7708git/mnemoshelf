import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildServerEnv, decideToken, resolveDesktopPaths } from "../src/paths.js";

/** 測試用的相對目錄（交給受測程式 path.resolve，不假設平台分隔符）。 */
const USER_DATA = path.join("tmp", "example-user-data");
const RESOURCES = path.join("tmp", "example-resources");

describe("resolveDesktopPaths", () => {
  it("把資料、模型與 token 檔放在 userData 底下（模型不得落在安裝目錄）", () => {
    const paths = resolveDesktopPaths({ userData: USER_DATA, resourcesPath: RESOURCES });
    expect(paths.userData).toBe(path.resolve(USER_DATA));
    expect(paths.modelDir).toBe(path.join(path.resolve(USER_DATA), "models"));
    expect(paths.dataDir).toBe(path.join(path.resolve(USER_DATA), "data"));
    expect(paths.tokenFile).toBe(path.join(path.resolve(USER_DATA), "spike-token.txt"));
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

describe("decideToken", () => {
  it("環境變數有值時沿用（與 pnpm serve 的用法一致）", () => {
    expect(decideToken({ MNEMOSHELF_TOKEN: "from-env" }, () => "generated")).toEqual({
      token: "from-env",
      source: "env",
    });
  });

  it("空字串或不存在的環境變數會產生新 token", () => {
    expect(decideToken({ MNEMOSHELF_TOKEN: "   " }, () => "generated").source).toBe("generated");
    expect(decideToken({}, () => "generated")).toEqual({ token: "generated", source: "generated" });
  });
});

describe("buildServerEnv", () => {
  it("覆寫四個路徑變數與埠，其餘環境變數保留", () => {
    const env = buildServerEnv({
      base: { PATH: "/usr/bin", MNEMOSHELF_PORT: "9999" },
      token: "tok",
      dataDir: "/data",
      modelDir: "/models",
      webDir: "/web",
    });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.MNEMOSHELF_TOKEN).toBe("tok");
    expect(env.MNEMOSHELF_DATA_DIR).toBe("/data");
    expect(env.MNEMOSHELF_MODEL_DIR).toBe("/models");
    expect(env.MNEMOSHELF_WEB_DIR).toBe("/web");
    // 一律用 OS 指派的隨機埠，不沿用外部帶進來的埠。
    expect(env.MNEMOSHELF_PORT).toBe("0");
  });
});
