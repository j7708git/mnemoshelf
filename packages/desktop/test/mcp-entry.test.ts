/**
 * MCP 入口路徑與設定片段的測試。
 *
 * 三件關鍵事：
 * 1. 打包版的入口必須落在 `app.asar.unpacked`（一般 `node` 讀不到 asar 內的檔案）。
 * 2. 設定片段**不得包含 token**——全權憑證不必經過剪貼簿與第三方的 MCP 設定檔；
 *    也不含服務網址（服務每次啟動可能換埠，入口自己讀 `runtime.json`）。
 * 3. 片段用**桌面版自己的 Electron 執行檔**當 `command`，並帶 `ELECTRON_RUN_AS_NODE=1`：
 *    使用者不必另外安裝 Node.js。
 */
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildMcpConfigSnippet,
  canCopyMcpConfig,
  DEFAULT_MCP_PROJECT,
  ELECTRON_RUN_AS_NODE,
  resolveMcpEntryPath,
} from "../src/mcp-entry.js";

/** 合成路徑，不含任何使用者真實路徑。 */
const RESOURCES = path.join("synthetic", "app", "resources");
const APP_PATH = path.join("synthetic", "repo", "packages", "desktop");
const RUNTIME_FILE = path.join("synthetic", "userdata", "data", "runtime.json");
/** 合成執行檔路徑（macOS 打包後的形狀；不是真實使用者路徑）。 */
const EXECUTABLE = path.join("synthetic", "app", "Mnemoshelf.app", "Contents", "MacOS", "Mnemoshelf");

describe("resolveMcpEntryPath", () => {
  it("打包版指向 app.asar.unpacked（一般 node 可直接執行）", () => {
    const entry = resolveMcpEntryPath({
      isPackaged: true,
      resourcesPath: RESOURCES,
      appPath: APP_PATH,
    });
    expect(entry).toBe(
      path.join(
        RESOURCES,
        "app.asar.unpacked",
        "node_modules",
        "@mnemoshelf",
        "server",
        "dist",
        "scripts",
        "mcp.js",
      ),
    );
    expect(entry).not.toContain("app.asar" + path.sep);
  });

  it("開發模式指向 monorepo 裡的 server 套件", () => {
    const entry = resolveMcpEntryPath({
      isPackaged: false,
      resourcesPath: RESOURCES,
      appPath: APP_PATH,
    });
    expect(entry).toBe(
      path.resolve(APP_PATH, "..", "server", "dist", "scripts", "mcp.js"),
    );
  });

  it("打包與開發模式不會指到同一個地方", () => {
    const packaged = resolveMcpEntryPath({ isPackaged: true, resourcesPath: RESOURCES, appPath: APP_PATH });
    const dev = resolveMcpEntryPath({ isPackaged: false, resourcesPath: RESOURCES, appPath: APP_PATH });
    expect(packaged).not.toBe(dev);
  });
});

describe("buildMcpConfigSnippet", () => {
  /** 產生片段並解析成可斷言的結構。 */
  function parseSnippet(overrides: { executablePath?: string; project?: string } = {}): {
    type: string;
    command: string;
    args: string[];
    env: Record<string, string>;
  } {
    const entry = resolveMcpEntryPath({ isPackaged: true, resourcesPath: RESOURCES, appPath: APP_PATH });
    const parsed = JSON.parse(
      buildMcpConfigSnippet({
        entryPath: entry,
        runtimeFile: RUNTIME_FILE,
        executablePath: overrides.executablePath ?? EXECUTABLE,
        ...(overrides.project === undefined ? {} : { project: overrides.project }),
      }),
    ) as { mcpServers: Record<string, { type: string; command: string; args: string[]; env: Record<string, string> }> };
    return parsed.mcpServers.mnemoshelf!;
  }

  it("產生可被 MCP client 直接使用的 mcpServers 結構，command 是傳入的執行檔", () => {
    const entry = resolveMcpEntryPath({ isPackaged: true, resourcesPath: RESOURCES, appPath: APP_PATH });
    const server = parseSnippet();
    expect(server.type).toBe("stdio");
    expect(server.command).toBe(EXECUTABLE);
    expect(server.args).toEqual([entry]);
    expect(server.env.MNEMOSHELF_RUNTIME_FILE).toBe(RUNTIME_FILE);
  });

  it("以 ELECTRON_RUN_AS_NODE=1 讓 Electron 執行檔當 Node.js 用（不必安裝 Node.js）", () => {
    const server = parseSnippet();
    expect(server.env.ELECTRON_RUN_AS_NODE).toBe("1");
    // command 不是寫死的 "node"：那會要求使用者機器上裝了 Node.js。
    expect(server.command).not.toBe("node");
  });

  it("帶預設專案名稱 MNEMOSHELF_PROJECT（預設 mnemoshelf）", () => {
    expect(DEFAULT_MCP_PROJECT).toBe("mnemoshelf");
    const server = parseSnippet();
    expect(server.env.MNEMOSHELF_PROJECT).toBe("mnemoshelf");
    expect(server.env.MNEMOSHELF_PROJECT).not.toBe("");
    expect(server.env.MNEMOSHELF_PROJECT).toBe(DEFAULT_MCP_PROJECT);
  });

  it("可覆寫專案名稱；空白視為未指定（退回預設值）", () => {
    expect(parseSnippet({ project: "my-shelf" }).env.MNEMOSHELF_PROJECT).toBe("my-shelf");
    expect(parseSnippet({ project: "   " }).env.MNEMOSHELF_PROJECT).toBe(DEFAULT_MCP_PROJECT);
  });

  it("不含 token，也不含服務網址（交給入口自己讀連線資訊檔）", () => {
    const server = parseSnippet();
    // 不用大小寫敏感的字串比對：直接斷言 env 的 key **恰好**是三個既定鍵。
    expect(Object.keys(server.env).sort()).toEqual(
      [ELECTRON_RUN_AS_NODE, "MNEMOSHELF_PROJECT", "MNEMOSHELF_RUNTIME_FILE"].sort(),
    );
    expect(server.env.MNEMOSHELF_TOKEN).toBeUndefined();
    expect(server.env.MNEMOSHELF_URL).toBeUndefined();
    // 也不含任何 http(s) 網址（網址由入口在執行時讀取；服務每次啟動可能換埠）。
    for (const value of Object.values(server.env)) {
      expect(value).not.toContain("http://");
      expect(value).not.toContain("https://");
    }
  });

  it("可自訂 server 名稱", () => {
    const snippet = buildMcpConfigSnippet({
      entryPath: path.join("synthetic", "mcp.js"),
      runtimeFile: RUNTIME_FILE,
      executablePath: EXECUTABLE,
      serverName: "my-shelf",
    });
    const parsed = JSON.parse(snippet) as { mcpServers: Record<string, unknown> };
    expect(Object.keys(parsed.mcpServers)).toEqual(["my-shelf"]);
  });

  it("輸出是合法 JSON（可直接貼進設定檔）", () => {
    const snippet = buildMcpConfigSnippet({
      entryPath: path.join("synthetic", "mcp.js"),
      runtimeFile: RUNTIME_FILE,
      executablePath: EXECUTABLE,
    });
    expect(() => JSON.parse(snippet)).not.toThrow();
  });
});

describe("canCopyMcpConfig", () => {
  const OK = { appImage: undefined, runtimeFileExists: true, entryPathExists: true } as const;

  it("兩個檔案都在、不是 AppImage → 可以複製", () => {
    expect(canCopyMcpConfig(OK)).toEqual({ allowed: true, reason: null, message: null });
  });

  it("連線資訊檔不存在 → 不複製（runtime-missing）", () => {
    const decision = canCopyMcpConfig({ ...OK, runtimeFileExists: false });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("runtime-missing");
    expect(decision.message).toContain("連線資訊檔");
    // 說明不含絕對路徑、不含 token。
    expect(decision.message).not.toContain(RUNTIME_FILE);
    expect(decision.message).not.toContain("token:");
  });

  it("入口腳本不存在 → 不複製（entry-missing）", () => {
    const decision = canCopyMcpConfig({ ...OK, entryPathExists: false });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("entry-missing");
    expect(decision.message).toContain("入口腳本");
    expect(decision.message).toContain("MNEMOSHELF_URL");
  });

  it("AppImage 環境 → 不複製（即使兩個檔案都在），並指向環境變數連線", () => {
    const decision = canCopyMcpConfig({
      ...OK,
      appImage: path.join("synthetic", "Mnemoshelf.AppImage"),
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("appimage");
    expect(decision.message).toContain("AppImage");
    expect(decision.message).toContain("MNEMOSHELF_URL");
    expect(decision.message).not.toContain("synthetic");
  });

  it("APPIMAGE 是空字串視為不在 AppImage 環境", () => {
    expect(canCopyMcpConfig({ ...OK, appImage: "   " }).allowed).toBe(true);
  });
});
