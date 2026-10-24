/**
 * MCP 入口路徑與設定片段的測試。
 *
 * 兩件關鍵事：
 * 1. 打包版的入口必須落在 `app.asar.unpacked`（一般 `node` 讀不到 asar 內的檔案）。
 * 2. 設定片段**不得包含 token**——全權憑證不必經過剪貼簿與第三方的 MCP 設定檔。
 */
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildMcpConfigSnippet, resolveMcpEntryPath } from "../src/mcp-entry.js";

/** 合成路徑，不含任何使用者真實路徑。 */
const RESOURCES = path.join("synthetic", "app", "resources");
const APP_PATH = path.join("synthetic", "repo", "packages", "desktop");
const RUNTIME_FILE = path.join("synthetic", "userdata", "data", "runtime.json");

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
  it("產生可被 MCP client 直接使用的 mcpServers 結構", () => {
    const entry = resolveMcpEntryPath({ isPackaged: true, resourcesPath: RESOURCES, appPath: APP_PATH });
    const parsed = JSON.parse(buildMcpConfigSnippet({ entryPath: entry, runtimeFile: RUNTIME_FILE })) as {
      mcpServers: Record<string, { type: string; command: string; args: string[]; env: Record<string, string> }>;
    };
    const server = parsed.mcpServers.mnemoshelf;
    expect(server.type).toBe("stdio");
    expect(server.command).toBe("node");
    expect(server.args).toEqual([entry]);
    expect(server.env.MNEMOSHELF_RUNTIME_FILE).toBe(RUNTIME_FILE);
  });

  it("不含 token，也不含服務網址（交給入口自己讀連線資訊檔）", () => {
    const entry = resolveMcpEntryPath({ isPackaged: true, resourcesPath: RESOURCES, appPath: APP_PATH });
    const snippet = buildMcpConfigSnippet({ entryPath: entry, runtimeFile: RUNTIME_FILE });
    expect(snippet).not.toContain("token");
    expect(snippet).not.toContain("127.0.0.1");
    expect(snippet).not.toContain("http://");
  });

  it("可自訂 server 名稱", () => {
    const snippet = buildMcpConfigSnippet({
      entryPath: path.join("synthetic", "mcp.js"),
      runtimeFile: RUNTIME_FILE,
      serverName: "my-shelf",
    });
    const parsed = JSON.parse(snippet) as { mcpServers: Record<string, unknown> };
    expect(Object.keys(parsed.mcpServers)).toEqual(["my-shelf"]);
  });

  it("輸出是合法 JSON（可直接貼進設定檔）", () => {
    const snippet = buildMcpConfigSnippet({
      entryPath: path.join("synthetic", "mcp.js"),
      runtimeFile: RUNTIME_FILE,
    });
    expect(() => JSON.parse(snippet)).not.toThrow();
  });
});
