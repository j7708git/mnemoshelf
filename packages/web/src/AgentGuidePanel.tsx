/**
 * 「連接 Agent」頁面：四個 tab（OpenCode／OpenChamber、codex、dsh、其他 MCP client）。
 *
 * 每個 tab 顯示：偵測結果一行、3 個步驟、片段預覽與複製、連到 GitHub 文件的「完整說明」。
 * 所有需要 Electron 的能力都走 `window.mnemoshelfDesktop.agentGuide`（v3 新增，選擇性）：
 * - 進入頁面只呼叫一次 `getState()`，**不輪詢**；「重新偵測」再呼叫一次。
 * - 複製一律走 main process；renderer 不讀檔案、不自己組片段、也不顯示 token。
 * - 沒有桌面殼（或舊殼）時頁面照樣可看：tab 可切、步驟可讀，偵測與複製明示需要桌面版。
 * - DEV 模擬（`?agentGuideMock=<情境>`）優先於 bridge 判斷，只在 dev build 生效。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  getDesktopAgentGuide,
  useDesktopBridge,
  type AgentGuideCopyKind,
  type DesktopAgentGuideState,
} from "./desktop";
import {
  AGENT_GUIDE_TABS,
  COPY_BLOCKED_TEXT,
  copyNoticeText,
  detectionLineText,
  docsUrl,
  installCardKind,
  scopeNote,
  snippetsFor,
  stepsFor,
  type AgentGuideTabId,
} from "./agentGuideText";
import { createDevAgentGuideMock, devAgentGuideMockScenario } from "./agentGuideDevMock";

/** 偵測狀態的載入情形（`unavailable`＝沒有任何桌面能力，不發請求）。 */
type LoadState =
  | { kind: "unavailable" }
  | { kind: "loading" }
  | { kind: "ready"; state: DesktopAgentGuideState }
  | { kind: "error"; message: string };

const TAB_CLASS =
  "rounded-md border px-3 py-1.5 text-sm font-medium disabled:opacity-40";
const SECONDARY_BUTTON_CLASS =
  "rounded-md border border-line px-3 py-1.5 text-sm text-ink disabled:opacity-40";

/** 沒有桌面殼時的片段預覽提示（頁面其餘部分仍可讀）。 */
const NO_DESKTOP_PREVIEW = "（桌面版才能產生片段）";

export function AgentGuidePanel() {
  const bridge = useDesktopBridge();
  // DEV 模擬必須優先於 bridge：即使在桌面殼裡開 `?agentGuideMock=` 也以 mock 為準。
  // 兩者都是穩定值（不隨 render 改變），effect 不會因此重跑。
  const scenario = useMemo(() => devAgentGuideMockScenario(), []);
  const mock = useMemo(() => createDevAgentGuideMock(scenario), [scenario]);
  const agentGuide = mock ?? getDesktopAgentGuide(bridge);

  const [tab, setTab] = useState<AgentGuideTabId>("opencode");
  const [load, setLoad] = useState<LoadState>(() => (agentGuide === null ? { kind: "unavailable" } : { kind: "loading" }));
  const [pendingKind, setPendingKind] = useState<AgentGuideCopyKind | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  /** 問一次 main 的偵測狀態；不輪詢。 */
  const loadState = useCallback(async (): Promise<void> => {
    if (agentGuide === null) return;
    setLoad({ kind: "loading" });
    setNotice(null);
    try {
      setLoad({ kind: "ready", state: await agentGuide.getState() });
    } catch (error) {
      setLoad({ kind: "error", message: error instanceof Error ? error.message : "未知的錯誤" });
    }
  }, [agentGuide]);

  // 進入頁面時呼叫一次；之後只有「重新偵測」會再呼叫。
  useEffect(() => {
    void loadState();
  }, [loadState]);

  const copy = useCallback(
    async (kind: AgentGuideCopyKind): Promise<void> => {
      if (agentGuide === null) return;
      setPendingKind(kind);
      setNotice(null);
      try {
        const result = await agentGuide.copy(kind);
        setNotice(copyNoticeText(kind, result));
      } catch (error) {
        setNotice(error instanceof Error ? error.message : "複製失敗，請稍後再試");
      } finally {
        setPendingKind(null);
      }
    },
    [agentGuide],
  );

  const detectionLine = ((): string => {
    if (tab === "other") return detectionLineText({ tab, detection: null });
    if (agentGuide === null) return detectionLineText({ tab, detection: null });
    if (load.kind === "ready") return detectionLineText({ tab, detection: load.state.detection[tab] });
    if (load.kind === "error") return `讀取偵測結果失敗：${load.message}`;
    return "正在偵測…";
  })();

  /** 片段預覽：只有 main 給的 `previews`，renderer 不自己組。 */
  const previewFor = (kind: AgentGuideCopyKind): string => {
    if (agentGuide === null) return NO_DESKTOP_PREVIEW;
    if (load.kind === "ready") return load.state.previews[kind] ?? "（沒有可預覽的內容）";
    if (load.kind === "error") return "無法取得片段預覽，請按「重新偵測」再試。";
    return "讀取中…";
  };

  const copyDisabled = agentGuide === null || load.kind !== "ready" || pendingKind !== null;
  const redetectDisabled = agentGuide === null || load.kind === "loading";

  return (
    <section id="mnemoshelf-agent-guide" aria-label="連接 Agent" className="space-y-4">
      <div>
        <h2 className="text-base font-medium text-ink">連接 Agent</h2>
        <p className="mt-0.5 text-xs text-muted">
          這一頁只告訴你缺什麼、怎麼補；
          <strong className="font-medium text-ink">不會</strong>
          修改任何設定檔、也不會執行指令。
        </p>
      </div>

      <div
        id="mnemoshelf-agent-guide-tabs"
        role="tablist"
        aria-label="Agent 類型"
        className="flex flex-wrap gap-2"
      >
        {AGENT_GUIDE_TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            data-tab={item.id}
            aria-selected={tab === item.id}
            onClick={() => {
              setTab(item.id);
              // 上一個 tab 的複製結果不屬於新 tab，切換時清掉。
              setNotice(null);
            }}
            className={`${TAB_CLASS} ${
              tab === item.id ? "border-ink bg-ink text-white" : "border-line bg-white text-ink"
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div role="tabpanel" className="space-y-4">
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-line bg-white px-3 py-2">
          <p id="mnemoshelf-agent-guide-detection" role="status" className="text-sm text-ink">
            {detectionLine}
          </p>
          <button
            id="mnemoshelf-agent-guide-redetect"
            type="button"
            onClick={() => void loadState()}
            disabled={redetectDisabled}
            className={`${SECONDARY_BUTTON_CLASS} ml-auto`}
          >
            {load.kind === "loading" ? "偵測中…" : "重新偵測"}
          </button>
        </div>

        <p className="text-xs text-muted">偵測範圍：{scopeNote(tab)}</p>
        {load.kind === "ready" && load.state.runtimeFile !== null && (
          <p className="break-all text-xs text-muted">
            連線資訊檔：<code>{load.state.runtimeFile}</code>
          </p>
        )}
        {agentGuide === null && (
          <p className="text-xs text-muted">複製與片段預覽需要桌面版 App。</p>
        )}

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
          <div className="min-w-0 space-y-2 rounded-lg border border-line bg-white p-4">
            <h3 className="text-sm font-medium text-ink">步驟</h3>
            <ol className="list-decimal space-y-2 pl-5 text-sm text-ink">
              {stepsFor(tab).map((step, index) => (
                <li key={index}>{step}</li>
              ))}
            </ol>
          </div>

          <div className="min-w-0 space-y-3">
            <div className="flex flex-wrap items-center gap-3">
              <button
                id="mnemoshelf-agent-guide-copy-card"
                type="button"
                onClick={() => void copy(installCardKind(tab))}
                disabled={copyDisabled}
                className="rounded-md bg-ink px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40"
              >
                {pendingKind === installCardKind(tab) ? "複製中…" : "複製安裝指令卡"}
              </button>
              <a
                href={docsUrl(tab)}
                target="_blank"
                rel="noreferrer"
                className="text-sm text-muted underline"
              >
                完整說明（GitHub）
              </a>
            </div>

            {snippetsFor(tab).map((snippet, index) => {
              const blocked = load.kind === "ready" ? load.state.copy.blocked[snippet.kind] : undefined;
              return (
                <div key={snippet.kind} className="min-w-0 space-y-2 rounded-lg border border-line bg-white p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="text-sm font-medium text-ink">{snippet.label}</h3>
                    <button
                      id={
                        index === 0
                          ? "mnemoshelf-agent-guide-copy-snippet"
                          : `mnemoshelf-agent-guide-copy-snippet-${snippet.kind}`
                      }
                      type="button"
                      onClick={() => void copy(snippet.kind)}
                      disabled={copyDisabled}
                      className={SECONDARY_BUTTON_CLASS}
                    >
                      {pendingKind === snippet.kind ? "複製中…" : "複製片段"}
                    </button>
                  </div>
                  {blocked !== undefined && (
                    <p className="text-xs text-muted">{COPY_BLOCKED_TEXT[blocked]}</p>
                  )}
                  <pre
                    id={
                      index === 0
                        ? "mnemoshelf-agent-guide-preview"
                        : `mnemoshelf-agent-guide-preview-${snippet.kind}`
                    }
                    className="max-h-72 overflow-auto whitespace-pre rounded-md bg-surface p-3 text-xs text-ink"
                  >
                    {previewFor(snippet.kind)}
                  </pre>
                </div>
              );
            })}

            <p
              id="mnemoshelf-agent-guide-notice"
              role="status"
              aria-live="polite"
              className="min-h-5 text-xs text-muted"
            >
              {notice ?? ""}
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
