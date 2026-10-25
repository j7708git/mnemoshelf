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
 * 這是最容易與文件漂移的值：`docs/agent-integration.md` 的範例與設定頁文案是**人工同步**的，
 * 不會在測試裡自動對照（文件不是程式）。改這裡時請一併檢查那兩處；片段本身與測試則直接引用
 * 這個常數。
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

/** 不複製 MCP 設定片段的原因（穩定字串；IPC 只回 `copied: false`，原因寫 stderr）。 */
export type McpConfigCopyBlockedReason = "appimage" | "runtime-missing" | "entry-missing";

/** `canCopyMcpConfig` 的判斷結果。 */
export interface McpConfigCopyDecision {
  /** 是否可以複製片段。 */
  allowed: boolean;
  /** 不能複製時的原因；可以時為 `null`。 */
  reason: McpConfigCopyBlockedReason | null;
  /** 給 stderr／使用者看的說明（不含路徑、不含 token）；可以時為 `null`。 */
  message: string | null;
}

/**
 * 複製片段前的存在性與環境檢查（純函式；檔案系統的檢查由呼叫端做完再傳進來）。
 *
 * 三種情況不給片段：
 * - **Linux AppImage**（`process.env.APPIMAGE` 有值）：執行檔路徑每次啟動都不同，
 *   app 結束後掛載點就消失，貼進去的片段下一次必然失效；建議改用環境變數連線。
 * - **連線資訊檔不存在**：入口啟動時會找不到憑證（`runtime-missing`）。
 * - **入口腳本不存在**：建置不完整時片段只會讓 client 啟動失敗。
 *
 * 為什麼要抽成純函式：`main.ts` 的 IPC handler 難以在單元測試裡直接呼叫；這裡只做決策，
 * 測試傳入布林值即可，不需要真的開檔。
 */
export function canCopyMcpConfig(input: {
  /** `process.env.APPIMAGE`；AppImage 執行時有值。 */
  appImage: string | undefined;
  /** 連線資訊檔是否已存在且是一般檔案。 */
  runtimeFileExists: boolean;
  /** MCP 入口腳本是否存在且是一般檔案。 */
  entryPathExists: boolean;
}): McpConfigCopyDecision {
  if (input.appImage !== undefined && input.appImage.trim() !== "") {
    return {
      allowed: false,
      reason: "appimage",
      message:
        "AppImage 的執行檔路徑每次啟動都不同、結束後掛載點就消失，因此不提供可直接貼用的片段；" +
        "請改用環境變數 MNEMOSHELF_URL 與 MNEMOSHELF_TOKEN 連線（或使用解壓後的版本）。",
    };
  }
  if (!input.runtimeFileExists) {
    return {
      allowed: false,
      reason: "runtime-missing",
      message: "連線資訊檔尚未寫出；請在設定頁開啟「Agent 連線資訊」並重新啟動應用程式。",
    };
  }
  if (!input.entryPathExists) {
    return {
      allowed: false,
      reason: "entry-missing",
      message:
        "找不到 MCP 入口腳本（這個建置可能不完整）；請改用環境變數 MNEMOSHELF_URL 與 MNEMOSHELF_TOKEN 連線。",
    };
  }
  return { allowed: true, reason: null, message: null };
}
