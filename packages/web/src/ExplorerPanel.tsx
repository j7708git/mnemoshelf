/**
 * 單一 root 的總管畫面：目錄樹（左）＋ 檔案預覽（右），並顯示索引进度狀態。
 *
 * 目錄樹資料來自 `GET /roots/:id/entries`（檔案系統，與索引狀態無關）；
 * 索引进度來自 `GET /roots/:id/index/status` 輪詢。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { cancelIndex, getIndexStatus, startIndex, type DirEntry, type IndexStatus, type Root } from "./api";
import { DirectoryTree } from "./DirectoryTree";
import { FilePreview } from "./FilePreview";
import { formatBytes } from "./format";

export interface ExplorerPanelProps {
  root: Root;
  /** 由外部遞增以強制重新載入目錄樹（例如索引完成後）。 */
  refreshKey: number;
}

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
  const [busy, setBusy] = useState(false);
  /**
   * 使用者剛按下「重新索引」：即使第一次輪詢還看到 `idle`（請求還在路上），也要持續輪詢，
   * 否則進度與「取消索引」按鈕不會出現（`startIndex` 要等整輪跑完才回應）。
   */
  const pollingRef = useRef(false);

  // 讀取／輪詢索引狀態：running（或剛啟動索引）時每 1.5 秒更新一次，其餘只讀一次。
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | undefined;

    const tick = async (): Promise<void> => {
      try {
        const current = await getIndexStatus(root.id);
        if (cancelled) return;
        setStatus(current);
        if (current.state === "completed" || current.state === "failed" || current.state === "cancelled") {
          pollingRef.current = false;
        }
        if (current.state === "running" || pollingRef.current) {
          if (timer === undefined) timer = setInterval(() => void tick(), 1500);
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

  const reindex = useCallback(async (): Promise<void> => {
    setBusy(true);
    pollingRef.current = true;
    // 遞增 treeKey 讓輪詢立刻重跑一次，不必等 startIndex 回應。
    setTreeKey((current) => current + 1);
    try {
      await startIndex(root.id);
      setTreeKey((current) => current + 1);
      setStatus(await getIndexStatus(root.id));
    } catch {
      // 失敗狀態由輪詢顯示；這裡不重複報錯。
    } finally {
      setBusy(false);
    }
  }, [root.id]);

  /** 取消進行中的索引；`startIndex` 的 promise 會隨後結束（伺服器回 200），由輪詢接手顯示。 */
  const stopIndex = useCallback(async (): Promise<void> => {
    setBusy(true);
    try {
      await cancelIndex(root.id);
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
              disabled={busy || running}
              className="rounded-md border border-line px-3 py-1.5 text-sm text-ink disabled:opacity-40"
            >
              {running ? "索引中…" : "重新索引"}
            </button>
          </div>
        )}
      </div>

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
