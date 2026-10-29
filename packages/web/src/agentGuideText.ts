/**
 * 「連接 Agent」頁面的文案與狀態映射（純函式）。
 *
 * 這個模組不碰 React、DOM、window 或 IPC：所有固定文字集中在這裡，頁面只負責排版，
 * 測試逐字比對。偵測與複製的實際行為在 main process，renderer 不讀檔案、不自己組片段。
 */
import type {
  AgentGuideBlockedReason,
  AgentGuideCopyKind,
  AgentGuideDetectReason,
  DesktopAgentGuideCopyResult,
  DesktopAgentGuideHarnessDetection,
} from "./desktop";

/** 頁面上的四個 tab。 */
export type AgentGuideTabId = "opencode" | "codex" | "dsh" | "other";

/** tab 的順序與標籤（顯示順序即這個陣列的順序）。 */
export const AGENT_GUIDE_TABS: readonly { id: AgentGuideTabId; label: string }[] = [
  { id: "opencode", label: "OpenCode／OpenChamber" },
  { id: "codex", label: "codex" },
  { id: "dsh", label: "dsh" },
  { id: "other", label: "其他 MCP client" },
];

/**
 * 七個偵測原因碼的完整對照（`Record` 讓 TypeScript 強制窮盡）。
 *
 * `detected` 時接 `matches`（以「、」連接）；`other` 不走這張表。
 */
export const DETECT_REASON_TEXT: Record<AgentGuideDetectReason, string> = {
  ok: "偵測到",
  "file-missing": "未偵測到（沒有找到設定檔）",
  "not-configured": "未偵測到（設定檔存在，但沒有 Mnemoshelf）",
  "read-error": "無法判讀（讀取失敗：權限或檔案被鎖住）",
  "too-large": "無法判讀（檔案超過 1 MiB，未讀取）",
  "invalid-format": "無法判讀（設定檔格式無法解析）",
  unsupported: "不偵測",
};

/**
 * 複製被擋的原因對照。
 *
 * `appimage` 刻意**不**提「請確認服務正在執行」：服務可能正常，擋住的是執行檔路徑。
 */
export const COPY_BLOCKED_TEXT: Record<AgentGuideBlockedReason, string> = {
  "runtime-missing": "尚未開啟 Agent 連線資訊：請到設定頁開啟並重新啟動 App",
  "entry-missing": "這個建置找不到 MCP 入口，請重新安裝完整版本",
  appimage:
    "AppImage 的執行檔路徑每次啟動都不同，不提供含執行檔的片段；請改用解壓版，或用環境變數連線",
  "clipboard-failed": "寫入剪貼簿失敗，請稍後再試",
  "unknown-kind": "不支援這個複製項目",
};

/** 「其他 MCP client」固定顯示的偵測說明。 */
const OTHER_DETECTION_TEXT = "不偵測：其他 MCP client 沒有固定設定位置";

/** 沒有桌面殼（或舊殼）時的偵測說明。 */
const NO_DESKTOP_DETECTION_TEXT = "需要桌面版 App 才能偵測";

/**
 * 三態＋原因碼 → 一行白話。
 *
 * `detection === null` 代表沒有桌面殼／舊殼；`other` 不論有沒有殼都固定「不偵測」。
 */
export function detectionLineText(input: {
  tab: AgentGuideTabId;
  detection: DesktopAgentGuideHarnessDetection | null;
}): string {
  if (input.tab === "other") return OTHER_DETECTION_TEXT;
  if (input.detection === null) return NO_DESKTOP_DETECTION_TEXT;
  if (input.detection.state === "detected") {
    const matches = input.detection.matches.filter((match) => match.trim() !== "");
    const head =
      matches.length === 0 ? DETECT_REASON_TEXT.ok : `${DETECT_REASON_TEXT.ok}：${matches.join("、")}`;
    // 只有 detected 才附加「哪一半設定了」；無法判讀時的旗標不可信，不加註記。
    switch (input.tab) {
      case "opencode": {
        const plugin = matches.length > 0 ? "外掛：已設定" : "外掛：未設定";
        const mcp = input.detection.mcpConfigured ? "MCP：已設定" : "MCP：未設定";
        return `${head}（${plugin}；${mcp}）`;
      }
      case "codex": {
        const mcp = input.detection.mcpConfigured ? "MCP：已設定" : "MCP：未設定";
        const hook = input.detection.hookConfigured ? "hook：已設定" : "hook：未設定";
        return `${head}（${mcp}；${hook}）`;
      }
      case "dsh":
        return head;
    }
  }
  return DETECT_REASON_TEXT[input.detection.reason];
}

/** 複製成功時顯示的種類名稱。 */
const COPY_KIND_LABEL: Record<AgentGuideCopyKind, string> = {
  "opencode-plugins": "外掛設定",
  "opencode-mcp": "MCP 設定",
  "mcp-generic": "MCP 設定",
  "codex-mcp": "MCP 設定",
  "dsh-profile": "profile 設定",
  "install-card-opencode": "安裝指令卡",
  "install-card-codex": "安裝指令卡",
  "install-card-dsh": "安裝指令卡",
  "install-card-generic": "安裝指令卡",
};

/**
 * 複製結果 → 一行提示。
 *
 * 成功與失敗都要講清楚原因；`reason` 為 null 但沒有成功時是無法分類的失敗（不假裝成功）。
 */
export function copyNoticeText(kind: AgentGuideCopyKind, result: DesktopAgentGuideCopyResult): string {
  if (result.copied) return `已複製${COPY_KIND_LABEL[kind]}到剪貼簿。`;
  if (result.reason !== null) return COPY_BLOCKED_TEXT[result.reason];
  return "複製失敗，請稍後再試";
}

/** 所有 tab 共用的第 1 步。 */
const STEP_RUNTIME =
  "確認連線資訊檔存在：到「設定」開啟「Agent 連線資訊」，重新啟動 App；檔案在設定頁會顯示路徑。";

const STEPS: Record<AgentGuideTabId, readonly string[]> = {
  opencode: [
    STEP_RUNTIME,
    "在 repo 目錄建置外掛：pnpm --filter @mnemoshelf/opencode-plugin build（未發佈 npm，必須自行 build）。",
    "把外掛設定併進 ~/.config/opencode/opencode.jsonc 的 plugins，重新啟動 OpenCode／OpenChamber；看到 [mnemoshelf] log 或 /memory 有連線即成功。",
  ],
  codex: [
    STEP_RUNTIME,
    "把 MCP 片段貼進 ~/.codex/config.toml，重新啟動 codex。",
    "codex mcp list 應看到 mnemoshelf；本版沒有自動召回 hook（repo 未附 recall.mjs），請在專案 AGENTS.md 指示模型主動呼叫工具。",
  ],
  dsh: [
    STEP_RUNTIME,
    "用 dsh plugin --profile <PROFILE> add <絕對路徑>/packages/dsh-plugin 安裝（給絕對路徑，不要用 ./），再跑 dsh plugin --profile <PROFILE> install。",
    "重新啟動 dsh web；stderr 出現 [mnemoshelf-dsh] connection 即成功。",
  ],
  other: [
    STEP_RUNTIME,
    "把 mcpServers 片段貼進你的 MCP client 設定檔（Claude Desktop／MiniMax 等位置見「完整說明」）。",
    "重新啟動 client；工具清單應出現 mnemoshelf 的六個工具。",
  ],
};

/** 每個 tab 固定 3 步（回傳唯讀陣列，呼叫端不得改動）。 */
export function stepsFor(tab: AgentGuideTabId): readonly string[] {
  return STEPS[tab];
}

/** 每個 tab 的「完整說明」網址。 */
export function docsUrl(tab: AgentGuideTabId): string {
  switch (tab) {
    case "opencode":
      return "https://github.com/j7708git/mnemoshelf/blob/main/docs/opencode-plugin.md";
    case "codex":
      return "https://github.com/j7708git/mnemoshelf/blob/main/docs/agent-integration.md";
    case "dsh":
      return "https://github.com/j7708git/mnemoshelf/blob/main/packages/dsh-plugin/README.md";
    case "other":
      return "https://github.com/j7708git/mnemoshelf/blob/main/docs/agent-integration.md";
  }
}

/** 這個 tab 要顯示哪些片段（順序即顯示順序）。 */
export function snippetsFor(tab: AgentGuideTabId): readonly { kind: AgentGuideCopyKind; label: string }[] {
  switch (tab) {
    case "opencode":
      return [
        { kind: "opencode-plugins", label: "外掛設定" },
        { kind: "opencode-mcp", label: "MCP 設定（選配）" },
      ];
    case "codex":
      return [{ kind: "codex-mcp", label: "MCP 設定" }];
    case "dsh":
      return [{ kind: "dsh-profile", label: "profile 設定" }];
    case "other":
      return [{ kind: "mcp-generic", label: "MCP 設定" }];
  }
}

/** 每個 tab 對應的「複製安裝指令卡」kind。 */
export function installCardKind(tab: AgentGuideTabId): AgentGuideCopyKind {
  switch (tab) {
    case "opencode":
      return "install-card-opencode";
    case "codex":
      return "install-card-codex";
    case "dsh":
      return "install-card-dsh";
    case "other":
      return "install-card-generic";
  }
}

/** 偵測範圍說明（每個 tab 一行；`other` 明示不偵測）。 */
export function scopeNote(tab: AgentGuideTabId): string {
  switch (tab) {
    case "opencode":
      return "只檢查使用者層 ~/.config/opencode/（含 Windows）；不含專案層 .opencode/。";
    case "codex":
      return "只檢查 ~/.codex/config.toml 與 ~/.codex/hooks.json。";
    case "dsh":
      return "只檢查 <DSH_HOME>/profiles/*/package.json（預設 ~/.dsh）。";
    case "other":
      return "不偵測：沒有固定的設定檔位置。";
  }
}
