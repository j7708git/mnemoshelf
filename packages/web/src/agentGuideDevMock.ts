/**
 * **DEV-only** 的「連接 Agent」模擬（`?agentGuideMock=<情境>`）。
 *
 * 用途：在瀏覽器（沒有 Electron、沒有真的 main process）檢視頁面與截圖。
 *
 * 安全邊界：
 * - 只在 `import.meta.env.DEV` 時啟用；production build 中 `DEV` 是 `false`，
 *   `devAgentGuideMockScenario()`／`createDevAgentGuideMock()` 一律回 null，
 *   不讀 query、不建 timer、不掛任何東西。
 * - 這是 dev 工具，不是產品功能：預覽全部是明顯的合成文字，不含真實路徑、token 或
 *   任何使用者的設定內容。
 */
import type {
  AgentGuideBlockedReason,
  AgentGuideCopyKind,
  DesktopAgentGuideBridge,
  DesktopAgentGuideCopyResult,
  DesktopAgentGuideHarnessDetection,
  DesktopAgentGuideState,
} from "./desktop";

/** 支援的模擬情境（`?agentGuideMock=` 的值）。 */
export type AgentGuideMockScenario = "detected" | "not-detected" | "unknown" | "blocked-appimage";

const SCENARIOS: readonly AgentGuideMockScenario[] = [
  "detected",
  "not-detected",
  "unknown",
  "blocked-appimage",
];

/** 所有可複製的種類（與 main 的白名單一致）。 */
const COPY_KINDS: readonly AgentGuideCopyKind[] = [
  "opencode-plugins",
  "opencode-mcp",
  "mcp-generic",
  "codex-mcp",
  "dsh-profile",
  "install-card-opencode",
  "install-card-codex",
  "install-card-dsh",
  "install-card-generic",
];

/** 明顯合成的預覽：不長得像任何真實設定檔或路徑。 */
function previewFor(kind: AgentGuideCopyKind): string {
  return [
    "{",
    `  "//": "dev mock preview (${kind})",`,
    '  "value": "<合成資料，不是真實設定>"',
    "}",
  ].join("\n");
}

function buildPreviews(): Record<AgentGuideCopyKind, string> {
  return Object.fromEntries(COPY_KINDS.map((kind) => [kind, previewFor(kind)])) as Record<
    AgentGuideCopyKind,
    string
  >;
}

function detection(
  state: DesktopAgentGuideHarnessDetection["state"],
  reason: DesktopAgentGuideHarnessDetection["reason"],
  matches: string[] = [],
): DesktopAgentGuideHarnessDetection {
  return {
    state,
    reason,
    matches,
    mcpConfigured: state === "detected",
    hookConfigured: false,
    sourcesChecked: 2,
  };
}

/** 每個情境的初始狀態。 */
function initialState(scenario: AgentGuideMockScenario): DesktopAgentGuideState {
  const previews = buildPreviews();
  const base: DesktopAgentGuideState = {
    detectedAt: "2026-01-01T00:00:00.000Z",
    detection: {
      opencode: detection("not-detected", "file-missing"),
      codex: detection("not-detected", "file-missing"),
      dsh: detection("not-detected", "file-missing"),
    },
    // 只顯示用；刻意不是可用的真實路徑。
    runtimeFile: "（dev mock）runtime.json",
    entryPath: "（dev mock）mcp-entry.mjs",
    copy: { blocked: {} },
    previews,
  };

  switch (scenario) {
    case "detected":
      return {
        ...base,
        detection: {
          opencode: detection("detected", "ok", ["dev-mock-opencode-plugin"]),
          codex: detection("detected", "ok"),
          dsh: detection("detected", "ok", ["dev-mock-profile"]),
        },
      };
    case "unknown":
      return {
        ...base,
        detection: {
          opencode: detection("unknown", "read-error"),
          codex: detection("unknown", "too-large"),
          dsh: detection("unknown", "invalid-format"),
        },
      };
    case "blocked-appimage": {
      const blocked: Partial<Record<AgentGuideCopyKind, AgentGuideBlockedReason>> = {};
      for (const kind of COPY_KINDS) blocked[kind] = "appimage";
      return {
        ...base,
        detection: {
          opencode: detection("detected", "ok", ["dev-mock-opencode-plugin"]),
          codex: detection("detected", "ok"),
          dsh: detection("detected", "ok", ["dev-mock-profile"]),
        },
        copy: { blocked },
      };
    }
    case "not-detected":
    default:
      return base;
  }
}

/** 讀出 query 裡的模擬情境；非 DEV 或沒有參數時回 null。 */
export function devAgentGuideMockScenario(search?: string | null): string | null {
  if (!import.meta.env.DEV) return null;
  const raw =
    search === undefined ? (typeof window === "undefined" ? "" : window.location.search) : (search ?? "");
  if (raw === "") return null;
  const value = new URLSearchParams(raw).get("agentGuideMock");
  return value === null || value.trim() === "" ? null : value.trim();
}

/** 建立模擬 bridge；非 DEV 或情境不認識時回 null（production 沒有任何副作用）。 */
export function createDevAgentGuideMock(requestedScenario: string | null): DesktopAgentGuideBridge | null {
  if (!import.meta.env.DEV) return null;
  if (requestedScenario === null) return null;
  if (!SCENARIOS.includes(requestedScenario as AgentGuideMockScenario)) return null;

  const scenario = requestedScenario as AgentGuideMockScenario;
  const state = initialState(scenario);

  const clone = (): DesktopAgentGuideState => ({
    ...state,
    detection: {
      opencode: { ...state.detection.opencode, matches: [...state.detection.opencode.matches] },
      codex: { ...state.detection.codex, matches: [...state.detection.codex.matches] },
      dsh: { ...state.detection.dsh, matches: [...state.detection.dsh.matches] },
    },
    copy: { blocked: { ...state.copy.blocked } },
    previews: { ...state.previews },
  });

  return {
    getState: async () => clone(),
    copy: async (kind: string): Promise<DesktopAgentGuideCopyResult> => {
      if (!COPY_KINDS.includes(kind as AgentGuideCopyKind)) {
        return { copied: false, reason: "unknown-kind" };
      }
      const blocked = state.copy.blocked[kind as AgentGuideCopyKind];
      if (blocked !== undefined) return { copied: false, reason: blocked };
      return { copied: true, reason: null };
    },
  };
}
