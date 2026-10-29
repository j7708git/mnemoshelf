/**
 * 「連接 Agent」文案純函式與 bridge 守衛的測試。
 *
 * 這裡只測純邏輯（不引入 jsdom）：頁面行為交給真實瀏覽器的 smoke 驗證。
 * `getDesktopAgentGuide` 的守衛測試放在這裡，是因為本卡只允許新增這一個測試檔。
 */
import { describe, expect, it } from "vitest";
import {
  AGENT_GUIDE_TABS,
  COPY_BLOCKED_TEXT,
  DETECT_REASON_TEXT,
  copyNoticeText,
  detectionLineText,
  docsUrl,
  installCardKind,
  scopeNote,
  snippetsFor,
  stepsFor,
} from "../src/agentGuideText";
import type {
  DesktopAgentGuideBridge,
  DesktopAgentGuideHarnessDetection,
  DesktopAgentGuideState,
  DesktopBridge,
  DesktopBootstrapState,
  DesktopSettingsState,
} from "../src/desktop";
import { getDesktopAgentGuide } from "../src/desktop";

function detection(
  overrides: Partial<DesktopAgentGuideHarnessDetection> = {},
): DesktopAgentGuideHarnessDetection {
  return {
    state: "detected",
    reason: "ok",
    matches: [],
    mcpConfigured: true,
    hookConfigured: false,
    sourcesChecked: 1,
    ...overrides,
  };
}

describe("AGENT_GUIDE_TABS", () => {
  it("四個 tab 的 id 與順序固定", () => {
    expect(AGENT_GUIDE_TABS.map((tab) => tab.id)).toEqual(["opencode", "codex", "dsh", "other"]);
  });

  it("標籤逐字固定", () => {
    expect(AGENT_GUIDE_TABS.map((tab) => tab.label)).toEqual([
      "OpenCode／OpenChamber",
      "codex",
      "dsh",
      "其他 MCP client",
    ]);
  });
});

describe("detectionLineText", () => {
  it("detected 有 matches 時以「、」連接", () => {
    expect(
      detectionLineText({
        tab: "opencode",
        detection: detection({ matches: ["plugin-a", "plugin-b"] }),
      }),
    ).toBe("偵測到：plugin-a、plugin-b");
  });

  it("detected 但 matches 為空時不接冒號", () => {
    expect(detectionLineText({ tab: "codex", detection: detection({ matches: [] }) })).toBe("偵測到");
  });

  it("not-detected + file-missing 逐字", () => {
    expect(
      detectionLineText({
        tab: "opencode",
        detection: detection({ state: "not-detected", reason: "file-missing" }),
      }),
    ).toBe("未偵測到（沒有找到設定檔）");
  });

  it("not-detected + not-configured 逐字", () => {
    expect(
      detectionLineText({
        tab: "opencode",
        detection: detection({ state: "not-detected", reason: "not-configured" }),
      }),
    ).toBe("未偵測到（設定檔存在，但沒有 Mnemoshelf）");
  });

  it("unknown + read-error 逐字", () => {
    expect(
      detectionLineText({
        tab: "codex",
        detection: detection({ state: "unknown", reason: "read-error" }),
      }),
    ).toBe("無法判讀（讀取失敗：權限或檔案被鎖住）");
  });

  it("unknown + too-large 逐字", () => {
    expect(
      detectionLineText({
        tab: "codex",
        detection: detection({ state: "unknown", reason: "too-large" }),
      }),
    ).toBe("無法判讀（檔案超過 1 MiB，未讀取）");
  });

  it("unknown + invalid-format 逐字", () => {
    expect(
      detectionLineText({
        tab: "dsh",
        detection: detection({ state: "unknown", reason: "invalid-format" }),
      }),
    ).toBe("無法判讀（設定檔格式無法解析）");
  });

  it("unknown + unsupported 逐字", () => {
    expect(
      detectionLineText({
        tab: "dsh",
        detection: detection({ state: "unknown", reason: "unsupported" }),
      }),
    ).toBe("不偵測");
  });

  it("沒有桌面殼時明示需要桌面版", () => {
    expect(detectionLineText({ tab: "opencode", detection: null })).toBe("需要桌面版 App 才能偵測");
    expect(detectionLineText({ tab: "codex", detection: null })).toBe("需要桌面版 App 才能偵測");
    expect(detectionLineText({ tab: "dsh", detection: null })).toBe("需要桌面版 App 才能偵測");
  });

  it("other 一律不偵測，即使有偵測資料", () => {
    expect(detectionLineText({ tab: "other", detection: null })).toBe(
      "不偵測：其他 MCP client 沒有固定設定位置",
    );
    expect(detectionLineText({ tab: "other", detection: detection() })).toBe(
      "不偵測：其他 MCP client 沒有固定設定位置",
    );
  });
});

describe("原因碼對照表", () => {
  it("DETECT_REASON_TEXT 的鍵集合等於原因碼 union", () => {
    expect(Object.keys(DETECT_REASON_TEXT).sort()).toEqual([
      "file-missing",
      "invalid-format",
      "not-configured",
      "ok",
      "read-error",
      "too-large",
      "unsupported",
    ]);
  });

  it("COPY_BLOCKED_TEXT 的鍵集合等於被擋原因 union", () => {
    expect(Object.keys(COPY_BLOCKED_TEXT).sort()).toEqual([
      "appimage",
      "clipboard-failed",
      "entry-missing",
      "runtime-missing",
      "unknown-kind",
    ]);
  });

  it("AppImage 文案不含舊的誤導訊息，且點出每次啟動都不同", () => {
    expect(COPY_BLOCKED_TEXT.appimage).not.toContain("請確認服務正在執行");
    expect(COPY_BLOCKED_TEXT.appimage).toContain("每次啟動都不同");
  });
});

describe("copyNoticeText", () => {
  it("成功時說明複製了什麼", () => {
    expect(copyNoticeText("opencode-plugins", { copied: true, reason: null })).toBe(
      "已複製外掛設定到剪貼簿。",
    );
    expect(copyNoticeText("install-card-dsh", { copied: true, reason: null })).toBe(
      "已複製安裝指令卡到剪貼簿。",
    );
  });

  it("每個被擋原因都回對應的固定文案", () => {
    expect(copyNoticeText("codex-mcp", { copied: false, reason: "runtime-missing" })).toBe(
      "尚未開啟 Agent 連線資訊：請到設定頁開啟並重新啟動 App",
    );
    expect(copyNoticeText("codex-mcp", { copied: false, reason: "entry-missing" })).toBe(
      "這個建置找不到 MCP 入口，請重新安裝完整版本",
    );
    expect(copyNoticeText("codex-mcp", { copied: false, reason: "appimage" })).toBe(
      COPY_BLOCKED_TEXT.appimage,
    );
    expect(copyNoticeText("codex-mcp", { copied: false, reason: "clipboard-failed" })).toBe(
      "寫入剪貼簿失敗，請稍後再試",
    );
    expect(copyNoticeText("codex-mcp", { copied: false, reason: "unknown-kind" })).toBe(
      "不支援這個複製項目",
    );
  });

  it("沒有成功也沒有原因時不假裝成功", () => {
    expect(copyNoticeText("codex-mcp", { copied: false, reason: null })).toBe("複製失敗，請稍後再試");
  });
});

describe("stepsFor", () => {
  const firstSteps = [
    "確認連線資訊檔存在：到「設定」開啟「Agent 連線資訊」，重新啟動 App；檔案在設定頁會顯示路徑。",
  ];

  it("四個 tab 都回 3 步，第一步相同且提到連線資訊", () => {
    for (const tab of ["opencode", "codex", "dsh", "other"] as const) {
      const steps = stepsFor(tab);
      expect(steps).toHaveLength(3);
      expect(steps[0]).toBe(firstSteps[0]);
      expect(steps[0]).toContain("連線資訊");
    }
  });

  it("opencode 的其餘兩步逐字固定", () => {
    expect(stepsFor("opencode").slice(1)).toEqual([
      "在 repo 目錄建置外掛：pnpm --filter @mnemoshelf/opencode-plugin build（未發佈 npm，必須自行 build）。",
      "把外掛設定併進 ~/.config/opencode/opencode.jsonc 的 plugins，重新啟動 OpenCode／OpenChamber；看到 [mnemoshelf] log 或 /memory 有連線即成功。",
    ]);
  });

  it("codex／dsh／other 的其餘兩步逐字固定", () => {
    expect(stepsFor("codex").slice(1)).toEqual([
      "把 MCP 片段貼進 ~/.codex/config.toml，重新啟動 codex。",
      "codex mcp list 應看到 mnemoshelf；本版沒有自動召回 hook（repo 未附 recall.mjs），請在專案 AGENTS.md 指示模型主動呼叫工具。",
    ]);
    expect(stepsFor("dsh").slice(1)).toEqual([
      "用 dsh plugin --profile <PROFILE> add <絕對路徑>/packages/dsh-plugin 安裝（給絕對路徑，不要用 ./），再跑 dsh plugin --profile <PROFILE> install。",
      "重新啟動 dsh web；stderr 出現 [mnemoshelf-dsh] connection 即成功。",
    ]);
    expect(stepsFor("other").slice(1)).toEqual([
      "把 mcpServers 片段貼進你的 MCP client 設定檔（Claude Desktop／MiniMax 等位置見「完整說明」）。",
      "重新啟動 client；工具清單應出現 mnemoshelf 的六個工具。",
    ]);
  });
});

describe("docsUrl", () => {
  const prefix = "https://github.com/j7708git/mnemoshelf/blob/main/";

  it("四個網址逐字固定", () => {
    expect(docsUrl("opencode")).toBe(`${prefix}docs/opencode-plugin.md`);
    expect(docsUrl("codex")).toBe(`${prefix}docs/agent-integration.md`);
    expect(docsUrl("dsh")).toBe(`${prefix}packages/dsh-plugin/README.md`);
    expect(docsUrl("other")).toBe(`${prefix}docs/agent-integration.md`);
  });

  it("都以公開 repo 的 blob 網址開頭", () => {
    for (const tab of ["opencode", "codex", "dsh", "other"] as const) {
      expect(docsUrl(tab).startsWith(prefix)).toBe(true);
    }
  });
});

describe("snippetsFor 與 installCardKind", () => {
  it("opencode 有外掛設定與 MCP 設定兩個片段，順序固定", () => {
    expect(snippetsFor("opencode")).toEqual([
      { kind: "opencode-plugins", label: "外掛設定" },
      { kind: "opencode-mcp", label: "MCP 設定（選配）" },
    ]);
  });

  it("其他 tab 各一個片段", () => {
    expect(snippetsFor("codex")).toEqual([{ kind: "codex-mcp", label: "MCP 設定" }]);
    expect(snippetsFor("dsh")).toEqual([{ kind: "dsh-profile", label: "profile 設定" }]);
    expect(snippetsFor("other")).toEqual([{ kind: "mcp-generic", label: "MCP 設定" }]);
  });

  it("安裝指令卡的 kind 對照固定", () => {
    expect(installCardKind("opencode")).toBe("install-card-opencode");
    expect(installCardKind("codex")).toBe("install-card-codex");
    expect(installCardKind("dsh")).toBe("install-card-dsh");
    expect(installCardKind("other")).toBe("install-card-generic");
  });
});

describe("scopeNote", () => {
  it("四個範圍說明逐字固定", () => {
    expect(scopeNote("opencode")).toBe(
      "只檢查使用者層 ~/.config/opencode/（含 Windows）；不含專案層 .opencode/。",
    );
    expect(scopeNote("codex")).toBe("只檢查 ~/.codex/config.toml 與 ~/.codex/hooks.json。");
    expect(scopeNote("dsh")).toBe("只檢查 <DSH_HOME>/profiles/*/package.json（預設 ~/.dsh）。");
    expect(scopeNote("other")).toBe("不偵測：沒有固定的設定檔位置。");
  });
});

// ---- bridge 守衛（卡 2 的 agentGuide 是選擇性成員） ----

function fakeAgentGuide(): DesktopAgentGuideBridge {
  return {
    getState: async () => ({}) as DesktopAgentGuideState,
    copy: async () => ({ copied: false, reason: null }),
  };
}

function fakeBridge(agentGuide?: DesktopAgentGuideBridge): DesktopBridge {
  return {
    kind: "mnemoshelf-desktop",
    apiVersion: 3,
    platform: "linux",
    bootstrap: {
      getState: async () => null as DesktopBootstrapState | null,
      retry: async () => null as DesktopBootstrapState | null,
      onUpdate: () => () => undefined,
    },
    settings: {
      get: async () => ({}) as DesktopSettingsState,
      setAutostart: async () => ({}) as DesktopSettingsState,
      setAgentDiscovery: async () => ({}) as DesktopSettingsState,
      copyConnectionInfo: async () => ({ copied: false, url: null }),
      copyMcpConfig: async () => ({ copied: false, url: null, reason: null }),
    },
    ...(agentGuide === undefined ? {} : { agentGuide }),
  };
}

describe("getDesktopAgentGuide", () => {
  it("不在桌面殼裡時回 null", () => {
    expect(getDesktopAgentGuide(null)).toBeNull();
  });

  it("舊殼（沒有 agentGuide 成員）回 null", () => {
    expect(getDesktopAgentGuide(fakeBridge())).toBeNull();
  });

  it("agentGuide 形狀不完整時視為不支援", () => {
    const agentGuide = fakeAgentGuide();
    const broken = { ...agentGuide, copy: undefined } as unknown as DesktopAgentGuideBridge;
    expect(getDesktopAgentGuide(fakeBridge(broken))).toBeNull();
  });

  it("完整時回傳同一個 agentGuide 物件", () => {
    const agentGuide = fakeAgentGuide();
    expect(getDesktopAgentGuide(fakeBridge(agentGuide))).toBe(agentGuide);
  });
});
