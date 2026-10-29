/**
 * MCP 入口的路徑解析與設定片段（**只做 re-export**）。
 *
 * 實作已搬到 `agent-guide.ts`：那裡同時有「連接 Agent」頁需要的五種片段、安裝卡、
 * harness 偵測與複製閘門。這個檔案保留原本的匯出名字，讓 `main.ts` 與既有測試
 * （`packages/desktop/test/mcp-entry.test.ts`）不必改動；**不要在這裡再寫一份組裝邏輯**。
 */
export { DEFAULT_MCP_PROJECT, ELECTRON_RUN_AS_NODE, buildMcpConfigSnippet } from "./agent-guide.js";
export { PACKAGED_MCP_ENTRY_SEGMENTS, resolveMcpEntryPath, canCopyMcpConfig } from "./agent-guide.js";
export type { McpConfigCopyBlockedReason, McpConfigCopyDecision } from "./agent-guide.js";
