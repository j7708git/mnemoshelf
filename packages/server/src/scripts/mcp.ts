/**
 * MCP stdio 入口（手動執行；通常由 MCP 客戶端以子程序啟動）：
 *
 *   MNEMOSHELF_URL=http://127.0.0.1:<port> MNEMOSHELF_TOKEN=<token> \
 *     pnpm --filter @mnemoshelf/server run mcp
 *
 * stdout 是 MCP 協定通道，因此所有訊息一律寫 stderr。
 */
import { runStdio } from "../mcp/stdio.js";

runStdio().catch((error: unknown) => {
  console.error("[mnemoshelf-mcp] 啟動失敗：", error instanceof Error ? error.message : error);
  process.exit(1);
});
