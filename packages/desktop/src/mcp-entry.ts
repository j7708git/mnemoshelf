/**
 * MCP 入口的路徑解析與設定片段（純函式，可單獨測試）。
 *
 * 為什麼放在桌面殼：使用者要設定 MCP client，必須知道「入口程式在哪」與「連線資訊檔在哪」。
 * 這兩個路徑只有桌面殼知道（打包後在 asar.unpacked 裡、開發時在 monorepo 裡）。
 *
 * **片段不含 token**：MCP 入口會自己讀 `runtime.json` 取得網址與 token
 * （見 `packages/server/src/mcp/runtime-connection.ts`），所以使用者只需要貼一段
 * 設定片段，不需要把全權憑證放進剪貼簿或設定檔。
 *
 * **片段不必安裝 Node.js**：`command` 是桌面版自己的 Electron 執行檔，並帶
 * `ELECTRON_RUN_AS_NODE=1`，Electron 會以一般 Node.js 的身分執行入口腳本
 * （需要 `RunAsNode` fuse 未被關閉；本專案的打包設定沒有關閉它）。
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
 * 設定片段預設的專案名稱（`MNEMOSHELF_PROJECT`）。
 *
 * 集中成常數：文件、設定頁文案與測試都引用同一個值，避免三處各寫一份而漂移。
 * 使用者可在自己的 MCP 設定檔改成別的專案名稱。
 */
export const DEFAULT_MCP_PROJECT = "mnemoshelf";

/**
 * 讓 Electron 執行檔以一般 Node.js 身分啟動的環境變數。
 *
 * 片段一定要帶這個（值 `"1"`），否則 MCP client 啟動的是第二個桌面應用程式實例，
 * 不是 stdio 的 MCP 入口。
 */
export const ELECTRON_RUN_AS_NODE = "ELECTRON_RUN_AS_NODE";

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
 * 只帶三個環境變數：
 * - `MNEMOSHELF_RUNTIME_FILE`：入口據此找到連線資訊檔並自行讀取網址與 token；
 * - `MNEMOSHELF_PROJECT`：`remember` 的預設專案名稱（預設 `DEFAULT_MCP_PROJECT`）；
 * - `ELECTRON_RUN_AS_NODE=1`：讓 Electron 執行檔以 Node.js 身分執行入口腳本。
 *
 * **不帶 token、也不帶網址**——這是刻意的，避免全權憑證經過剪貼簿與第三方設定檔；
 * 網址由入口在執行時從 `runtime.json` 讀取（服務每次啟動可能換埠）。
 *
 * `executablePath` 由呼叫端傳入（正式路徑是 `process.execPath`）。刻意不在函式內直接讀
 * `process.execPath`：這樣才能在不啟動 Electron 的情況下單元測試輸出。
 */
export function buildMcpConfigSnippet(input: {
  /** MCP 入口的路徑（`resolveMcpEntryPath` 的結果）。 */
  entryPath: string;
  /** 連線資訊檔的路徑（`runtime.json`）。 */
  runtimeFile: string;
  /**
   * 桌面版自己的執行檔（正式呼叫端傳 `process.execPath`）。
   * 打包後是 `<App>.app/Contents/MacOS/<名稱>`（macOS）或安裝目錄下的應用程式執行檔。
   */
  executablePath: string;
  /** 預設專案名稱；空白視為未指定，退回 `DEFAULT_MCP_PROJECT`。 */
  project?: string;
  /** MCP server 名稱；預設 `mnemoshelf`。 */
  serverName?: string;
}): string {
  const name = input.serverName ?? "mnemoshelf";
  const requestedProject = input.project?.trim();
  const project = requestedProject === undefined || requestedProject === "" ? DEFAULT_MCP_PROJECT : requestedProject;
  return JSON.stringify(
    {
      mcpServers: {
        [name]: {
          type: "stdio",
          command: input.executablePath,
          args: [input.entryPath],
          env: {
            MNEMOSHELF_RUNTIME_FILE: input.runtimeFile,
            MNEMOSHELF_PROJECT: project,
            [ELECTRON_RUN_AS_NODE]: "1",
          },
        },
      },
    },
    null,
    2,
  );
}
