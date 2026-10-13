/**
 * 啟動常駐服務（手動執行）：
 *
 *   MNEMOSHELF_TOKEN=<token> pnpm --filter @mnemoshelf/server run serve
 *
 * 相關環境變數見 `src/config.ts`。服務只綁 127.0.0.1；`MNEMOSHELF_PORT=0`（預設）時
 * 會由 OS 指派隨機埠並印出實際網址（**不印 token**）。
 */
import { createServer } from "../index.js";

async function main(): Promise<void> {
  const instance = await createServer();
  console.error(`[mnemoshelf] 服務已啟動：${instance.url}（資料目錄：${instance.config.dataDir}）`);

  const shutdown = (signal: string): void => {
    console.error(`[mnemoshelf] 收到 ${signal}，正在關閉…`);
    void instance
      .close()
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        console.error("[mnemoshelf] 關閉時發生錯誤：", error);
        process.exit(1);
      });
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((error: unknown) => {
  console.error("[mnemoshelf] 啟動失敗：", error instanceof Error ? error.message : error);
  process.exit(1);
});
