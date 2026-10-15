/**
 * 單一 root 的總管畫面：目錄樹（左）＋ 檔案預覽（右），並顯示索引进度狀態。
 *
 * 目錄樹資料來自 `GET /roots/:id/entries`（檔案系統，與索引狀態無關）；
 * 索引进度來自 `GET /roots/:id/index/status` 輪詢。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  cancelIndexWithRetry,
  getIndexStatus,
  IndexPollGate,
  startIndex,
  type DirEntry,
  type IndexStatus,
  type Root,
} from "./api";
import { DirectoryTree } from "./DirectoryTree";
import { FilePreview } from "./FilePreview";
import { formatBytes } from "./format";

export interface ExplorerPanelProps {
  root: Root;
  /** 由外部遞增以強制重新載入目錄樹（例如索引完成後）。 */
  refreshKey: number;
}

/** 索引进度輪詢間隔（毫秒）；同時用來把 `INDEX_POLL_GRACE_MS` 換算成寬限 tick 數。 */
const POLL_INTERVAL_MS = 1500;

/** chunk 級進度的補充說明；掃描階段（預估 0 塊）為空字串。 */
function chunkNote(status: IndexStatus | null): string {
  const progress = status?.progress ?? null;
  if (progress === null || progress.estimatedChunks === 0) return "";
  return `；已嵌入 ${progress.processedChunks}／預估 ${progress.estimatedChunks} 塊`;
}

/** 索引进度狀態 → 中文說明。 */
function describeStatus(status: IndexStatus | null): string {
  if (status === null) return "讀取索引狀態中…";
  switch (status.state) {
    case "idle":
      return "尚未索引（目錄樹仍可瀏覽）";
    case "running": {
      const progress = status.progress;
      if (progress === null || progress.total === 0) return "索引中：正在掃描檔案…";
      return `索引中：已處理 ${progress.processed}／${progress.total} 個檔案${chunkNote(status)}`;
    }
    case "completed":
      return status.result === null
        ? "索引完成"
        : `索引完成：處理 ${status.result.processed} 個、跳過未變更 ${status.result.skippedUnchanged} 個${
            status.result.failedFiles.length > 0 ? `、失敗 ${status.result.failedFiles.length} 個` : ""
          }`;
    case "cancelled":
      return "索引已取消（已完成的檔案仍保留在索引中）";
    case "failed":
      return `索引失敗：${status.error?.message ?? "未知錯誤"}`;
  }
}

export function ExplorerPanel({ root, refreshKey }: ExplorerPanelProps) {
  const [selectedEntry, setSelectedEntry] = useState<DirEntry | null>(null);
  const [status, setStatus] = useState<IndexStatus | null>(null);
  const [treeKey, setTreeKey] = useState(refreshKey);
  /** 取消請求進行中（`stopIndex`）：避免重複送出取消；**不**涵蓋整輪索引。 */
  const [busy, setBusy] = useState(false);
  /**
   * 已按下「重新索引」、但輪詢還沒觀察到本輪（`running`）或本輪結束。
   *
   * 為什麼與 `busy` 分開：`reindex` **不 await** `startIndex`（它要等整輪跑完才回應），
   * 改由輪詢接手；`starting` 只負責在「請求已送出、本輪尚未被觀察到」的窗口停用
   * 「重新索引」按鈕、避免重複送出。它**不**鎖「取消索引」——否則又會整輪停用取消鈕。
   */
  const [starting, setStarting] = useState(false);
  /**
   * 使用者剛按下「重新索引」：即使第一次輪詢還看到 `idle`（請求還在路上），也要持續輪詢，
   * 否則進度與「取消索引」按鈕不會出現（`startIndex` 要等整輪跑完才回應）。
   */
  const pollingRef = useRef(false);
  /**
   * 本輪的輪詢判準（見 `IndexPollGate`）。
   *
   * 為什麼需要：按下「重新索引」後立刻輪詢時，`POST /index` 可能還沒到伺服器，第一次輪詢會
   * 看到**上一輪**的 `completed`／`failed`／`cancelled`；若據此停止輪詢，新一輪的進度與取消鈕
   * 就會整輪隱藏。`reindex` 以「舊輪的 runSeq」重建這個 gate，只有終態且 runSeq 改變才算本輪結束。
   */
  const pollGateRef = useRef<IndexPollGate>(new IndexPollGate(null, POLL_INTERVAL_MS));
  /**
   * 寬限用盡仍沒觀察到本輪（`stalled`）：以可見提示告知使用者，不靜默。
   *
   * 與 `AddRootFlow` 對稱：兩邊都不把「無法確認索引是否啟動」直接當成失敗，只顯示可恢復提示。
   */
  const [pollStalled, setPollStalled] = useState(false);

  // 讀取／輪詢索引狀態：running（或剛啟動索引）時每 1.5 秒更新一次，其餘只讀一次。
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | undefined;

    const tick = async (): Promise<void> => {
      try {
        const current = await getIndexStatus(root.id);
        if (cancelled) return;
        setStatus(current);
        const outcome = pollGateRef.current.observe(current);
        if (outcome.kind !== "continue") {
          // 本輪終止（terminal），或寬限用盡仍未觀察到本輪（stalled）：停止輪詢。
          pollingRef.current = false;
        }
        if (outcome.kind === "stalled") {
          // 不靜默：以可見提示告知「無法確認本輪是否啟動」，面板維持可操作（可再按「重新索引」）。
          setPollStalled(true);
        } else if (outcome.kind === "terminal") {
          // 確實觀察到本輪終止：清除先前的 stalled 提示。
          setPollStalled(false);
        }
        if (outcome.kind !== "continue" || current.state === "running") {
          // 已觀察到本輪（running）或本輪已結束：解除「重新索引請求中」的鎖。
          // 這裡刻意不碰 `busy`——取消請求進行中時，取消鈕要維持停用（見 `stopIndex`）。
          setStarting(false);
        }
        if (outcome.kind === "continue" && (current.state === "running" || pollingRef.current)) {
          if (timer === undefined) timer = setInterval(() => void tick(), POLL_INTERVAL_MS);
        } else if (timer !== undefined) {
          clearInterval(timer);
          timer = undefined;
        }
      } catch {
        // 狀態讀取失敗不影響瀏覽；下一次 refreshKey 會再試。
      }
    };

    void tick();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearInterval(timer);
    };
  }, [root.id, refreshKey, treeKey]);

  /**
   * 觸發一輪重新索引。
   *
   * **不 await `startIndex`**：`POST /index` 會等整輪索引跑完才回應；若在等待期間持鎖，
   * 會讓「取消索引」按鈕整輪停用，使用者無法取消剛發起的那一輪。這裡只負責「發出請求＋
   * 建立輪詢門控」，狀態一律由輪詢接手（與 `AddRootFlow.beginIndex` 同一語意）。
   *
   * 重複點擊防護：`starting` 會持續到輪詢觀察到本輪（`running`）或本輪結束；即使有漏網的
   * 第二次請求，伺服器對同一 root 的進行中索引仍回 409（既有行為不變）。
   */
  const reindex = useCallback(async (): Promise<void> => {
    setStarting(true);
    setPollStalled(false);
    // W1：baseline 必須在發 POST **之前**以一次同步 GET 取得「本輪之前的 runSeq」。
    // 若沿用 React state 的 `status?.runSeq`，狀態尚未載入時為 null；而 root 可能已有
    // 舊輪 runSeq=1，gate 會把舊輪終態誤判成本輪結束而停止輪詢（窄窗競態）。
    // 這個 GET 在 POST 之前完成，順序確定、無競態；失敗時退回 null（等同「無舊輪」）。
    const baseline = await getIndexStatus(root.id).catch(() => null);
    pollGateRef.current = new IndexPollGate(baseline?.runSeq ?? null, POLL_INTERVAL_MS);
    pollingRef.current = true;
    // 遞增 treeKey 讓輪詢立刻重跑一次（此時 gate 已是正確 baseline），不必等 startIndex 回應。
    setTreeKey((current) => current + 1);
    // 不 await：失敗狀態由輪詢顯示；同時解除「請求中」以免按鈕卡住、並停止「期待新輪」。
    void startIndex(root.id)
      .then(() => {
        // 索引結束（完成或取消，伺服器都在跑完後才回應 200）：刷新目錄樹，與原本
        // 「等整輪跑完後重新載入」的行為一致。
        setTreeKey((current) => current + 1);
      })
      .catch(() => {
        pollingRef.current = false;
        setStarting(false);
      });
  }, [root.id]);

  /** 取消進行中的索引；`startIndex` 的 promise 會隨後結束（伺服器回 200），由輪詢接手顯示。 */
  const stopIndex = useCallback(async (): Promise<void> => {
    setBusy(true);
    try {
      // 走重試窗口版本：與 AddRootFlow 共用同一套「404 不當成已取消」的語意。
      await cancelIndexWithRetry(root.id);
    } catch {
      // 取消失敗（例如連線中斷）：輪詢會在下一次 tick 反映實際狀態。
    } finally {
      setBusy(false);
    }
  }, [root.id]);

  const running = status?.state === "running";

  return (
    <section className="flex min-h-0 flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="min-w-0">
          <h2 className="truncate text-base font-medium text-ink" title={root.path}>
            {root.path}
          </h2>
          <p className="text-xs text-muted">{describeStatus(status)}</p>
        </div>
        {root.mode === "index" && (
          <div className="flex gap-2">
            {running && (
              <button
                type="button"
                onClick={() => void stopIndex()}
                disabled={busy}
                className="rounded-md border border-line px-3 py-1.5 text-sm text-ink disabled:opacity-40"
              >
                取消索引
              </button>
            )}
            <button
              type="button"
              onClick={() => void reindex()}
              disabled={busy || starting || running}
              className="rounded-md border border-line px-3 py-1.5 text-sm text-ink disabled:opacity-40"
            >
              {running ? "索引中…" : "重新索引"}
            </button>
          </div>
        )}
      </div>

      {pollStalled && (
        <p role="status" className="text-xs text-amber-700">
          無法確認本輪索引是否啟動（上方顯示的可能是上一輪結果），請稍後再試或再按「重新索引」。
        </p>
      )}

      <div className="grid min-h-0 gap-4 lg:grid-cols-2">
        <div className="h-[60vh] min-h-0">
          <DirectoryTree
            rootId={root.id}
            refreshKey={treeKey}
            selectedPath={selectedEntry?.path ?? null}
            onSelectFile={setSelectedEntry}
          />
        </div>

        <div className="h-[60vh] min-h-0 overflow-auto">
          {selectedEntry === null ? (
            <div className="flex h-full items-center justify-center rounded-lg border border-dashed border-line bg-white/60 px-6 text-center text-sm text-muted">
              從左側目錄樹選擇一個檔案來預覽（支援文字與圖片）。
            </div>
          ) : (
            <FilePreview key={selectedEntry.path} rootId={root.id} entry={selectedEntry} />
          )}
        </div>
      </div>

      {status?.state === "completed" && status.result !== null && status.result.removedFiles > 0 && (
        <p className="text-xs text-muted">本次索引清除了 {status.result.removedFiles} 個已不存在檔案的索引資料。</p>
      )}
      {status?.state === "completed" && status.result !== null && status.result.failedFiles.length > 0 && (
        <p className="text-xs text-amber-700">
          有 {status.result.failedFiles.length} 個檔案處理失敗（其餘檔案已完成）：
          {status.result.failedFiles.map((file) => file.relPath).join("、")}
        </p>
      )}
      {selectedEntry !== null && selectedEntry.size !== null && (
        <p className="text-xs text-muted">
          目前選取：{selectedEntry.path}（{formatBytes(selectedEntry.size)}）
        </p>
      )}
    </section>
  );
}
