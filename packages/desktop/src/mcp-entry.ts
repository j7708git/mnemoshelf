/**
 * MCP 入口的路徑解析與設定片段（純函式，可單獨測試）。
 *
 * 為什麼放在桌面殼：使用者要設定 MCP client，必須知道「入口程式在哪」與「連線資訊檔在哪」。
 * 這兩個路徑只有桌面殼知道（打包後在 asar.unpacked 裡、開發時在 monorepo 裡）。
 *
 * **片段不含 token**：MCP 入口會自己讀 `runtime.json` 取得網址與 token
 * （見 `packages/server/src/mcp/runtime-connection.ts`），所以使用者只需要貼一段
 * 設定片段，不需要把全權憑證放進剪貼簿或設定檔。
 */
import path from "node:path";

/**
 * 打包版 MCP 入口在 `app.asar.unpacked` 下的相對路徑。
 *
 * 為什麼會在 unpacked：electron-builder 的 `asarUnpack: "**\/node_modules/**"`
 * 把所有 production 相依解包到 asar 之外（原生模組需要真實檔案；MCP 入口也要能
 * 被一般 `node` 執行，asar 內的虛擬檔案系統一般 node 讀不到）。
 */
export const PACKAGED_MCP_ENTRY_SEGMENTS = [
  "app.asar.unpacked",
  "node_modules",
  "@mnemoshelf",
  "server",
  "dist",
  "scripts",
  "mcp.js",
] as const;

/**
 * 解析 MCP 入口的可執行檔路徑。
 *
 * - 打包版：`<resourcesPath>/app.asar.unpacked/node_modules/@mnemoshelf/server/dist/scripts/mcp.js`
 * - 開發模式：`<repo>/packages/server/dist/scripts/mcp.js`
 *   （`app.getAppPath()` 是 `packages/desktop`，同層的 `packages/server` 就是來源）
 */
export function resolveMcpEntryPath(input: {
  isPackaged: boolean;
  resourcesPath: string;
  appPath: string;
}): string {
  if (input.isPackaged) {
    return path.join(input.resourcesPath, ...PACKAGED_MCP_ENTRY_SEGMENTS);
  }
  return path.resolve(input.appPath, "..", "server", "dist", "scripts", "mcp.js");
}

/**
 * 產生可直接貼進 MCP client 的設定片段（JSON）。
 *
 * 只帶 `MNEMOSHELF_RUNTIME_FILE`：MCP 入口據此找到連線資訊檔並自行讀取 token。
 * **不帶 token**——這是刻意的，避免全權憑證經過剪貼簿與第三方設定檔。
 */
export function buildMcpConfigSnippet(input: {
  /** MCP 入口的路徑（`resolveMcpEntryPath` 的結果）。 */
  entryPath: string;
  /** 連線資訊檔的路徑（`runtime.json`）。 */
  runtimeFile: string;
  /** MCP server 名稱；預設 `mnemoshelf`。 */
  serverName?: string;
}): string {
  const name = input.serverName ?? "mnemoshelf";
  return JSON.stringify(
    {
      mcpServers: {
        [name]: {
          type: "stdio",
          command: "node",
          args: [input.entryPath],
          env: {
            MNEMOSHELF_RUNTIME_FILE: input.runtimeFile,
          },
        },
      },
    },
    null,
    2,
  );
}
