/**
 * 契約守門測試：模組匯出、常數、re-export 單一實作，以及外掛套件的存在性。
 *
 * 這裡刻意讀**真實**的 `packages/opencode-plugin/package.json` 與目錄：
 * 外掛是「連接 Agent」頁承諾的產物，缺檔要讓測試失敗，不能 skip 或條件跳過。
 */
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as agentGuide from "../src/agent-guide.js";
import * as mcpEntry from "../src/mcp-entry.js";
import { AGENT_GUIDE_COPY_KINDS, MAX_AGENT_GUIDE_CONFIG_BYTES } from "../src/agent-guide.js";

describe("契約常數", () => {
  it("MAX_AGENT_GUIDE_CONFIG_BYTES 是 1 MiB（1048576）", () => {
    expect(MAX_AGENT_GUIDE_CONFIG_BYTES).toBe(1048576);
    expect(MAX_AGENT_GUIDE_CONFIG_BYTES).toBe(1024 * 1024);
  });

  it("DEFAULT_MCP_PROJECT 與 ELECTRON_RUN_AS_NODE 是凍結字串", () => {
    expect(agentGuide.DEFAULT_MCP_PROJECT).toBe("mnemoshelf");
    expect(agentGuide.ELECTRON_RUN_AS_NODE).toBe("ELECTRON_RUN_AS_NODE");
  });

  it("AGENT_GUIDE_COPY_KINDS 覆蓋五種片段＋四張安裝卡，且沒有重複", () => {
    expect(AGENT_GUIDE_COPY_KINDS).toHaveLength(9);
    expect(new Set(AGENT_GUIDE_COPY_KINDS).size).toBe(9);
    expect([...AGENT_GUIDE_COPY_KINDS].sort()).toEqual(
      [
        "codex-mcp",
        "dsh-profile",
        "install-card-codex",
        "install-card-dsh",
        "install-card-generic",
        "install-card-opencode",
        "mcp-generic",
        "opencode-mcp",
        "opencode-plugins",
      ].sort(),
    );
  });
});

describe("mcp-entry 只做 re-export（沒有第二份組裝實作）", () => {
  it("三個函式與兩個常數是同一個物件參考", () => {
    expect(mcpEntry.buildMcpConfigSnippet).toBe(agentGuide.buildMcpConfigSnippet);
    expect(mcpEntry.resolveMcpEntryPath).toBe(agentGuide.resolveMcpEntryPath);
    expect(mcpEntry.canCopyMcpConfig).toBe(agentGuide.canCopyMcpConfig);
    expect(mcpEntry.DEFAULT_MCP_PROJECT).toBe(agentGuide.DEFAULT_MCP_PROJECT);
    expect(mcpEntry.ELECTRON_RUN_AS_NODE).toBe(agentGuide.ELECTRON_RUN_AS_NODE);
    expect(mcpEntry.PACKAGED_MCP_ENTRY_SEGMENTS).toBe(agentGuide.PACKAGED_MCP_ENTRY_SEGMENTS);
  });

  it("PACKAGED_MCP_ENTRY_SEGMENTS 指向 app.asar.unpacked 的 server 入口", () => {
    expect(agentGuide.PACKAGED_MCP_ENTRY_SEGMENTS).toEqual([
      "app.asar.unpacked",
      "node_modules",
      "@mnemoshelf",
      "server",
      "dist",
      "scripts",
      "mcp.js",
    ]);
  });
});

describe("守門：packages/opencode-plugin 真的存在且可載入", () => {
  const packageJsonUrl = new URL("../../opencode-plugin/package.json", import.meta.url);
  const entryUrl = new URL("../../opencode-plugin/index.js", import.meta.url);
  const distEntryUrl = new URL("../../opencode-plugin/dist/index.js", import.meta.url);

  it("package.json 的 name 是 @mnemoshelf/opencode-plugin 且 private: true", () => {
    const manifest = JSON.parse(readFileSync(packageJsonUrl, "utf8")) as {
      name?: string;
      private?: boolean;
    };
    expect(manifest.name).toBe("@mnemoshelf/opencode-plugin");
    expect(manifest.private).toBe(true);
  });

  it("外掛載入器需要的入口檔至少存在一個（index.js 或 dist/index.js）", () => {
    const hasEntry = existsSync(entryUrl) || existsSync(distEntryUrl);
    // 缺檔就不能 skip：這裡直接斷言 true，讓測試失敗。
    expect(hasEntry).toBe(true);
  });
});
