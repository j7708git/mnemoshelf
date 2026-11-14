/** 記憶管理以完整回合／短記憶分頁；管理條件與語意召回情境各自保存。 */
import { useRef, useState, type ChangeEvent } from "react";
import { ConfirmDialog } from "./ConfirmDialog";
import { RawMemorySourcePanel } from "./RawMemorySourcePanel";
import {
  addMemory,
  deleteMemory,
  downloadMemoriesExport,
  importMemories,
  MemoryImportError,
  pinMemory,
  updateMemory,
  type Memory,
  type MemoryImportResult,
} from "./api";
import { formatDateTime, MEMORY_KIND_LABEL, MEMORY_SCOPE_LABEL, shortenSourceId } from "./format";
import { MemoryRecallPreview } from "./MemoryRecallPreview";
import { EMPTY_LIBRARY_FILTERS, memoryNameOption, memoryOptionNames, useMemoryLibrary, type MemoryLibraryFilters } from "./useMemoryLibrary";

/**
 * 目前開啟的確認對話框（一次只有一個）。
 *
 * 永久刪除刻意維持兩段：第一段按「繼續」只把狀態換成第二段，不呼叫後端；
 * 第二段才真的送 `DELETE /memories/:id?hard=true`。
 */
type PendingConfirm =
  | { kind: "remove"; memory: Memory }
  | { kind: "purge-first"; memory: Memory }
  | { kind: "purge-second"; memory: Memory };

export function MemoriesPanel() {
  const library = useMemoryLibrary();
  const { state, facets, filters, pageNumber, reload: load } = library;
  const availableProjects = facets.projects;
  const [tab, setTab] = useState<"library" | "recall">("library");
  const [recallRevision, setRecallRevision] = useState(0);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [sourceId, setSourceId] = useState<number | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  /** 舊版範圍設定暫放次要操作；不與管理篩選共用。 */
  const [shareTargets, setShareTargets] = useState<Record<number, string>>({});
  /** 備份匯出／匯入進行中（期間兩個按鈕都禁用，避免重複觸發）。 */
  const [backupBusy, setBackupBusy] = useState(false);
  /** 確認對話框（取代原生 confirm）與其送出中的狀態。 */
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  /** dry-run 後待確認的匯入（原始文字只留在這個 state，不寫 log／storage）。 */
  const [importPreview, setImportPreview] = useState<{
    text: string;
    fileName: string;
    result: MemoryImportResult;
  } | null>(null);
  const importInputRef = useRef<HTMLInputElement | null>(null);

  const clearRecall = (): void => setRecallRevision((previous) => previous + 1);

  const changeFilters = (patch: Partial<MemoryLibraryFilters>): void => {
    setSourceId(null);
    setEditingId(null);
    library.changeFilters(patch);
  };

  const run = async (id: number, action: () => Promise<void>, success: string): Promise<void> => {
    setBusyId(id);
    setActionError(null);
    setMessage(null);
    try {
      await action();
      clearRecall();
      setMessage(success);
      load();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "操作失敗。");
    } finally {
      setBusyId(null);
    }
  };

  const togglePin = (memory: Memory): void => {
    void run(
      memory.id,
      async () => {
        await pinMemory(memory.id, !memory.pinned);
      },
      memory.pinned
        ? (memory.sourceId == null ? "已取消釘選。" : "已取消釘選整個原文回合。")
        : (memory.sourceId == null ? "已釘選。" : "已釘選整個原文回合。"),
    );
  };

  /** 共享開關：專案記憶 → 全域共享（`PATCH {scope:"global"}`）。 */
  const shareGlobally = (memory: Memory): void => {
    void run(
      memory.id,
      async () => {
        await updateMemory(memory.id, { scope: "global" });
      },
      memory.sourceId == null ? "已設為全域共享。" : "已將整個原文回合設為全域共享。",
    );
  };

  /**
   * 共享開關：全域記憶 → 改回專案（`PATCH {scope:"project", project}`）。
   *
   * 目標專案以清單中出現過的專案名為選項；沒有可選專案時按鈕會停用，這裡再擋一次並提示。
   */
  const moveToProject = (memory: Memory): void => {
    const target = shareTargets[memory.id] ?? availableProjects[0];
    if (target === undefined) {
      setActionError("目前清單沒有可選的專案名稱，無法把這筆記憶改回專案範圍。");
      return;
    }
    void run(
      memory.id,
      async () => {
        await updateMemory(memory.id, { scope: "project", project: target });
      },
      `${memory.sourceId == null ? "已改回" : "已將整個原文回合改回"}專案「${target}」。`,
    );
  };

  const startEdit = (memory: Memory): void => {
    setEditingId(memory.id);
    setDraft(memory.content);
    setSourceId(null);
    setMessage(null);
    setActionError(null);
  };

  const saveEdit = async (memory: Memory): Promise<void> => {
    if (draft.trim() === "") {
      setActionError("記憶內容不得為空。");
      return;
    }
    setBusyId(memory.id);
    setActionError(null);
    setMessage(null);
    try {
      // supersedes 語意：建立新版本、舊版被標記取代（不再列出）。
      const saved = await addMemory({
        content: draft.trim(),
        agent: memory.agent,
        kind: memory.kind,
        scope: memory.scope,
        project: memory.project,
        supersedes: memory.id,
      });
      if (saved.duplicate) {
        // 防禦性處理：編輯流程帶 supersedes 時伺服器會跳過去重，正常不會走到這裡；
        // 若真的回 duplicate（例如未來規則調整），不假裝更新成功、也不新增卡片。
        setMessage(`已有完全相同內容的記憶（#${saved.id}），未新增卡片。`);
      } else {
        setMessage(`已更新：新版本已建立並取代舊版（#${memory.id}）。`);
      }
      setEditingId(null);
      setDraft("");
      clearRecall();
      load();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "儲存記憶失敗。");
    } finally {
      setBusyId(null);
    }
  };

  /**
   * 確認對話框按下確定後的共用流程：對話框保持開啟並顯示「處理中…」，
   * 成功才關閉並刷新；失敗先關閉，讓面板原本的錯誤橫幅（`actionError`）看得見。
   */
  const runConfirmed = async (action: () => Promise<void>, success: string): Promise<void> => {
    setConfirmBusy(true);
    setActionError(null);
    setMessage(null);
    try {
      await action();
      clearRecall();
      setMessage(success);
      setPendingConfirm(null);
      load();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "操作失敗。");
      setPendingConfirm(null);
    } finally {
      setConfirmBusy(false);
    }
  };

  /** 軟刪除：先開確認框，使用者按「刪除」才呼叫後端。 */
  const remove = (memory: Memory): void => {
    setPendingConfirm({ kind: "remove", memory });
  };

  /**
   * 永久刪除（硬刪除；卡 C2）：內容真的從資料庫移除、無法復原。
   *
   * 刻意做兩段確認（與軟刪除分開），文案必須誠實：不做安全抹除，本機檔案／WAL 可能仍有殘留。
   * 這裡只開第一段；第二段由對話框的「繼續」切換。
   */
  const purge = (memory: Memory): void => {
    setPendingConfirm({ kind: "purge-first", memory });
  };

  const confirmRemove = (memory: Memory): void => {
    void runConfirmed(async () => {
      await deleteMemory(memory.id);
    }, memory.sourceId == null ? "已刪除記憶。" : "已刪除整個原文回合。");
  };

  const confirmPurge = (memory: Memory): void => {
    void runConfirmed(async () => {
      await deleteMemory(memory.id, { hard: true });
    }, `${memory.sourceId == null ? "已永久刪除記憶" : "已永久刪除整個原文回合"}。本機檔案或 WAL 仍可能有殘留。`);
  };

  /** 把目前的 `pendingConfirm` 畫成對話框（文案照原本 `window.confirm` 的內容搬過來）。 */
  const renderConfirmDialog = (pending: PendingConfirm) => {
    const cancel = (): void => setPendingConfirm(null);
    const target = pending.memory.sourceId == null ? "這筆記憶" : "整個原文回合及其所有片段";
    if (pending.kind === "remove") {
      return (
        <ConfirmDialog
          key="remove"
          open
          title={`要刪除${target}嗎？`}
          description={`「${pending.memory.content.slice(0, 80)}」\n\n刪除後搜尋不到，資料仍保留在資料庫（軟刪除）。`}
          confirmLabel="刪除"
          busy={confirmBusy}
          onConfirm={() => confirmRemove(pending.memory)}
          onCancel={cancel}
        />
      );
    }
    if (pending.kind === "purge-first") {
      return (
        <ConfirmDialog
          key="purge-first"
          open
          title={`要永久刪除${target}嗎？`}
          description={
            `「${pending.memory.content.slice(0, 80)}」\n\n` +
            "內容會從資料庫刪除、無法復原；本機檔案／WAL 可能仍有殘留（未做安全抹除）。"
          }
          confirmLabel="繼續"
          variant="danger"
          busy={confirmBusy}
          onConfirm={() => setPendingConfirm({ kind: "purge-second", memory: pending.memory })}
          onCancel={cancel}
        />
      );
    }
    return (
      <ConfirmDialog
        key="purge-second"
        open
        title={pending.memory.sourceId == null ? `再次確認：永久刪除 #${pending.memory.id}` : `再次確認：永久刪除原文回合 #${pending.memory.sourceId}`}
        description="刪除後無法復原（沒有備份、也沒有垃圾桶）。真的要刪除嗎？"
        confirmLabel="永久刪除"
        variant="danger"
        busy={confirmBusy}
        onConfirm={() => confirmPurge(pending.memory)}
        onCancel={cancel}
      />
    );
  };

  /**
   * 匯出備份（NDJSON 下載）：依有效遮罩政策匯出未刪除的記憶。
   * 檔案由瀏覽器下載，不經過 log；失敗顯示在面板的錯誤區。
   */
  const exportBackup = async (): Promise<void> => {
    setBackupBusy(true);
    setActionError(null);
    setMessage(null);
    try {
      const { filename } = await downloadMemoriesExport();
      setMessage(`已下載備份 ${filename}。備份可能含敏感內容，請自行保管。`);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "下載記憶備份失敗。");
    } finally {
      setBackupBusy(false);
    }
  };

  /** 開檔：實際的讀取與 dry-run 在 `handleImportFile`（選同一個檔也要能重跑）。 */
  const chooseImportFile = (): void => {
    setActionError(null);
    setMessage(null);
    importInputRef.current?.click();
  };

  /**
   * 選檔後先跑 dry-run（不寫入），把摘要放進 `importPreview` 讓使用者確認。
   * 整批驗證失敗時伺服器回 400＋逐行錯誤；`MemoryImportError.result` 會帶回來顯示。
   * 檔案內容只存在記憶體 state，不寫 log、不進 sessionStorage。
   */
  const handleImportFile = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0];
    // 清掉 value，才能重新選同一個檔案。
    event.target.value = "";
    if (file === undefined) return;

    setBackupBusy(true);
    setActionError(null);
    setMessage(null);
    setImportPreview(null);
    let text = "";
    try {
      text = await file.text();
      if (text.trim() === "") {
        setActionError("匯入檔沒有任何內容。");
        return;
      }
      const result = await importMemories(text, { dryRun: true });
      setImportPreview({ text, fileName: file.name, result });
    } catch (error) {
      if (error instanceof MemoryImportError && error.result !== null) {
        setImportPreview({ text, fileName: file.name, result: error.result });
        setActionError(error.message);
      } else {
        setActionError(error instanceof Error ? error.message : "讀取匯入檔失敗。");
      }
    } finally {
      setBackupBusy(false);
    }
  };

  /** 使用者在 dry-run 摘要按下確認：才正式寫入並刷新列表。 */
  const confirmImport = async (): Promise<void> => {
    if (importPreview === null) return;
    setBackupBusy(true);
    setActionError(null);
    setMessage(null);
    try {
      const result = await importMemories(importPreview.text, { dryRun: false });
      setMessage(
        `已匯入備份：新增 ${result.created} 筆、重複跳過 ${result.duplicates} 筆、內容遮罩 ${result.redacted} 筆。`,
      );
      setImportPreview(null);
      clearRecall();
      load();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "匯入記憶備份失敗。");
    } finally {
      setBackupBusy(false);
    }
  };

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight text-ink">記憶管理</h2>
          <p className="mt-1 text-xs text-muted">整理保存的回合與短記憶，並以獨立情境預覽召回結果。</p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <input
            ref={importInputRef}
            type="file"
            accept=".ndjson,.jsonl,.txt,application/x-ndjson"
            aria-label="選擇記憶備份檔"
            className="hidden"
            onChange={(event) => void handleImportFile(event)}
          />
          <button
            type="button"
            disabled={backupBusy}
            onClick={() => void exportBackup()}
            className="rounded-lg border border-line bg-surface px-3 py-1.5 text-sm text-ink hover:bg-raised disabled:opacity-40"
          >
            匯出備份
          </button>
          <button
            type="button"
            disabled={backupBusy}
            onClick={chooseImportFile}
            className="rounded-lg border border-line bg-surface px-3 py-1.5 text-sm text-ink hover:bg-raised disabled:opacity-40"
          >
            {backupBusy ? "處理中…" : "匯入備份"}
          </button>
          <button
            type="button"
            disabled={backupBusy}
            onClick={() => { clearRecall(); setSourceId(null); load(); }}
            className="rounded-lg border border-line bg-surface px-3 py-1.5 text-sm text-ink hover:bg-raised disabled:opacity-40"
          >
            重新載入
          </button>
        </div>
      </div>

      {importPreview !== null && (
        <div className="space-y-2 rounded-[20px] border border-line bg-surface px-4 py-3">
          <div className="flex flex-wrap items-baseline gap-2">
            <h3 className="text-sm font-medium text-ink">匯入預覽（尚未寫入）</h3>
            <span className="break-all text-[11px] text-muted">{importPreview.fileName}</span>
          </div>
          <p className="text-xs text-ink">
            共 {importPreview.result.total} 行：有效 {importPreview.result.valid} 筆、預計新增{" "}
            {importPreview.result.wouldCreate} 筆、重複跳過 {importPreview.result.duplicates} 筆、內容遮罩{" "}
            {importPreview.result.redacted} 筆。
          </p>
          {importPreview.result.invalid.length > 0 ? (
            <div className="space-y-1">
              <p className="text-xs text-danger">
                有 {importPreview.result.invalid.length} 行不合法（整批不會寫入；最多顯示前 5 筆）：
              </p>
              <ul className="space-y-0.5 text-[11px] text-muted">
                {importPreview.result.invalid.slice(0, 5).map((item) => (
                  <li key={`${item.line}-${item.reason}`}>
                    第 {item.line} 行：{item.reason}
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="text-[11px] text-muted">
              確認後會依當下的記憶遮罩設定正式寫入，並保留釘選狀態。
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            {importPreview.result.invalid.length === 0 && (
              <button
                type="button"
                disabled={backupBusy}
                onClick={() => void confirmImport()}
                className="rounded-lg bg-brand px-3 py-1.5 text-sm font-medium text-on-brand disabled:opacity-40"
              >
                {backupBusy ? "匯入中…" : "確認匯入"}
              </button>
            )}
            <button
              type="button"
              disabled={backupBusy}
              onClick={() => {
                // 取消預覽時一起清掉錯誤與成功訊息：紅色錯誤只屬於這次預覽，不該殘留。
                setImportPreview(null);
                setActionError(null);
                setMessage(null);
              }}
              className="rounded-lg border border-line bg-surface px-3 py-1.5 text-sm text-ink hover:bg-raised disabled:opacity-40"
            >
              取消
            </button>
          </div>
        </div>
      )}

      <div role="tablist" aria-label="記憶管理頁面" className="flex gap-6 border-b border-line">
        {([{ id: "library", label: "記憶清單" }, { id: "recall", label: "召回預覽" }] as const).map((item) => (
          <button key={item.id} id={`memory-tab-${item.id}`} type="button" role="tab" aria-selected={tab === item.id}
            aria-controls={`memory-panel-${item.id}`} tabIndex={tab === item.id ? 0 : -1}
            onClick={() => setTab(item.id)}
            onKeyDown={(event) => {
              if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
              event.preventDefault();
              const next = tab === "library" ? "recall" : "library";
              setTab(next);
              document.getElementById(`memory-tab-${next}`)?.focus();
            }}
            className={`border-b-2 px-0 py-3 text-sm ${tab === item.id ? "border-brand font-medium text-brand" : "border-transparent text-muted hover:text-ink"}`}>
            {item.label}
          </button>
        ))}
      </div>

      <div id="memory-panel-recall" role="tabpanel" aria-labelledby="memory-tab-recall" hidden={tab !== "recall"}>
        <MemoryRecallPreview projects={availableProjects} writers={facets.writers} revision={recallRevision} />
      </div>

      {message !== null && (
        <p className="rounded-xl border border-line bg-surface px-4 py-2 text-sm text-ink">{message}</p>
      )}
      {actionError !== null && (
        <p role="alert" className="rounded-xl border border-danger/30 bg-danger-bg px-4 py-2 text-sm text-danger">
          {actionError}
        </p>
      )}

      <div id="memory-panel-library" role="tabpanel" aria-labelledby="memory-tab-library" hidden={tab !== "library"} className="space-y-4">
        <div className="space-y-4 rounded-2xl border border-line bg-surface p-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="space-y-1 text-xs text-muted">
              <span>歸屬專案</span>
              <select aria-label="依專案篩選" value={filters.project} onChange={(event) => changeFilters({ project: event.target.value })}
                className="w-full min-w-0 rounded-lg border border-line bg-bg px-3 py-2 text-sm text-ink">
                <option value="all">全部專案</option>
                {(facets.hasUnassigned || filters.project === "unassigned") && <option value="unassigned">未指定專案</option>}
                {memoryOptionNames(availableProjects, filters.project).map((project) => <option key={project} value={memoryNameOption(project)}>{project}</option>)}
              </select>
            </label>
            <label className="space-y-1 text-xs text-muted">
              <span>寫入者</span>
              <select aria-label="依寫入者篩選" value={filters.writer} onChange={(event) => changeFilters({ writer: event.target.value })}
                className="w-full min-w-0 rounded-lg border border-line bg-bg px-3 py-2 text-sm text-ink">
                <option value="all">全部寫入者</option>
                {memoryOptionNames(facets.writers, filters.writer).map((writer) => <option key={writer} value={memoryNameOption(writer)}>{writer}</option>)}
              </select>
            </label>
            <label className="space-y-1 text-xs text-muted">
              <span>記憶形式</span>
              <select aria-label="依記憶形式篩選" value={filters.type} onChange={(event) => changeFilters({ type: event.target.value as MemoryLibraryFilters["type"] })}
                className="w-full min-w-0 rounded-lg border border-line bg-bg px-3 py-2 text-sm text-ink">
                <option value="all">全部形式</option><option value="source">原文回合</option><option value="memory">短記憶</option>
              </select>
            </label>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <input type="search" aria-label="篩選記憶內容" value={filters.query} maxLength={2000} placeholder="包含文字…"
              onChange={(event) => changeFilters({ query: event.target.value })}
              className="min-w-0 flex-1 rounded-lg border border-line bg-bg px-3 py-2 text-sm text-ink outline-none focus:border-brand" />
            <button type="button" onClick={() => changeFilters(EMPTY_LIBRARY_FILTERS)}
              className="rounded-lg px-3 py-2 text-xs text-muted hover:bg-raised hover:text-ink">清除篩選</button>
          </div>
          <p className="text-[11px] text-muted">所有條件同時符合才顯示；選單涵蓋整個記憶庫。文字篩選比對實際內容，語意搜尋請使用「召回預覽」。</p>
        </div>

        {state.kind === "loading" && <p role="status" className="py-8 text-center text-sm text-muted">正在載入記憶清單…</p>}
        {state.kind === "error" && <div className="space-y-2">
          <p role="alert" className="rounded-xl border border-danger/30 bg-danger-bg px-4 py-3 text-sm text-danger">{state.message}</p>
          <button type="button" onClick={load} className="rounded-lg border border-line px-3 py-2 text-sm text-ink">重新載入第一頁</button>
        </div>}
        {state.kind === "ready" && <>
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted" aria-live="polite">
            <p>符合 {state.page.total} 項 · {state.page.counts.sources} 個回合、{state.page.counts.memories} 則短記憶</p>
            <p>釘選優先 · 由新到舊</p>
          </div>
          {state.page.entries.length === 0 ? (
            <div className="flex min-h-40 items-center justify-center rounded-2xl border border-dashed border-line bg-surface/70 px-6 text-center text-sm text-muted">
              沒有符合目前條件的記憶。可清除篩選，查看其他回合與短記憶。
            </div>
          ) : (
        <ul className="space-y-3">
          {state.page.entries.map((entry) => {
            const memory = entry.memory;
            const raw = entry.type === "source";
            const editing = !raw && editingId === memory.id;
            const showSource = sourceId === memory.id;
            const busy = busyId === memory.id;
            return (
              <li
                key={`${entry.type}:${entry.id}`}
                className={`rounded-2xl border px-4 py-4 ${
                  memory.pinned ? "border-brand bg-surface" : "border-line bg-surface"
                }`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  {memory.pinned && (
                    <span className="rounded bg-brand px-1.5 py-0.5 text-[11px] font-medium text-on-brand">已釘選</span>
                  )}
                  <span className="rounded bg-raised px-1.5 py-0.5 text-[11px] text-muted">
                    {raw ? `原文回合 · ${entry.chunkCount} 個檢索片段` : `短記憶 · ${MEMORY_KIND_LABEL[memory.kind]}`}
                  </span>
                  <span className="rounded bg-raised px-1.5 py-0.5 text-[11px] text-muted">
                    用途 {MEMORY_SCOPE_LABEL[memory.scope]}
                  </span>
                  <span className="rounded bg-raised px-1.5 py-0.5 text-[11px] text-muted">
                    歸屬專案 {memory.project ?? "未指定"}
                  </span>
                  <span
                    className="max-w-full break-all rounded bg-raised px-1.5 py-0.5 text-[11px] text-muted"
                    title={memory.agent}
                  >
                    寫入者 {memory.agent}
                  </span>
                  {memory.sourceSession !== null && (
                    <span
                      className="rounded bg-raised px-1.5 py-0.5 text-[11px] text-muted"
                      title={memory.sourceSession}
                    >
                      session {shortenSourceId(memory.sourceSession)}
                    </span>
                  )}
                  <span className="text-[11px] text-muted">{raw ? "回合" : "記憶"} #{entry.id}</span>
                  <span className="ml-auto text-[11px] text-muted">{formatDateTime(memory.createdAt)}</span>
                </div>

                {editing ? (
                  <div className="mt-2 space-y-2">
                    <textarea
                      value={draft}
                      onChange={(event) => setDraft(event.target.value)}
                      rows={3}
                      aria-label="編輯記憶內容"
                      className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink outline-none focus:border-brand"
                    />
                    <p className="text-[11px] text-muted">
                      儲存會建立新版本（agent／種類／範圍沿用）並把這一版標記為已取代。
                    </p>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void saveEdit(memory)}
                        className="rounded-lg bg-brand px-3 py-1.5 text-sm font-medium text-on-brand disabled:opacity-40"
                      >
                        儲存新版本
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setEditingId(null);
                          setDraft("");
                        }}
                        className="rounded-md border border-line px-3 py-1.5 text-sm text-ink"
                      >
                        取消
                      </button>
                    </div>
                  </div>
                ) : (
                  <p className={`mt-3 whitespace-pre-wrap break-words text-sm leading-relaxed text-ink ${raw ? "line-clamp-3" : ""}`}>{memory.content}</p>
                )}
                {raw && <p className="mt-2 text-[11px] text-muted">此處顯示回合節錄；釘選與刪除皆套用整個回合。</p>}

                <div className="mt-2 flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => togglePin(memory)}
                    className="rounded-md border border-line px-2.5 py-1 text-xs text-ink disabled:opacity-40"
                  >
                    {memory.pinned ? "取消釘選" : "釘選"}
                  </button>
                  {!raw && !editing && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => startEdit(memory)}
                      className="rounded-md border border-line px-2.5 py-1 text-xs text-ink disabled:opacity-40"
                    >
                      編輯
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setSourceId(showSource ? null : memory.id)}
                    aria-expanded={showSource}
                    className="rounded-md border border-line px-2.5 py-1 text-xs text-ink"
                  >
                    {showSource ? "收起來源" : raw ? "查看原文回合" : "看來源"}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => remove(memory)}
                    className="rounded-lg border border-line px-2.5 py-1 text-xs text-muted hover:text-danger disabled:opacity-40"
                  >
                    刪除
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => purge(memory)}
                    className="rounded-lg border border-line px-2.5 py-1 text-xs text-danger hover:bg-danger-bg disabled:opacity-40"
                    title="真的從資料庫刪除（無法復原；不做安全抹除）"
                  >
                    永久刪除
                  </button>
                </div>

                <details className="mt-3 text-xs text-muted">
                  <summary className="cursor-pointer">其他設定</summary>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                  {memory.scope === "agent" ? (
                    <span className="rounded-md border border-line px-2.5 py-1 text-xs text-muted">
                      agent 範圍
                    </span>
                  ) : memory.scope === "project" ? (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => shareGlobally(memory)}
                      className="rounded-md border border-line px-2.5 py-1 text-xs text-ink disabled:opacity-40"
                    >
                      設為全域共享
                    </button>
                  ) : (
                    <>
                      <select
                        aria-label={`選擇要改回的專案（記憶 #${memory.id}）`}
                        value={shareTargets[memory.id] ?? availableProjects[0] ?? ""}
                        onChange={(event) =>
                          setShareTargets((previous) => ({ ...previous, [memory.id]: event.target.value }))
                        }
                        disabled={busy || availableProjects.length === 0}
                        className="rounded-lg border border-line bg-surface px-2 py-1 text-xs text-ink disabled:opacity-40"
                      >
                        {availableProjects.length === 0 ? (
                          <option value="">沒有可選專案</option>
                        ) : (
                          availableProjects.map((project) => (
                            <option key={project} value={project}>
                              {project}
                            </option>
                          ))
                        )}
                      </select>
                      <button
                        type="button"
                        disabled={busy || availableProjects.length === 0}
                        onClick={() => moveToProject(memory)}
                        className="rounded-md border border-line px-2.5 py-1 text-xs text-ink disabled:opacity-40"
                      >
                        改回專案
                      </button>
                    </>
                  )}
                  </div>
                  <p className="mt-2 text-[11px]">舊版範圍設定會影響召回；原文回合的變更套用所有片段。</p>
                </details>

                {showSource && raw && (
                  <RawMemorySourcePanel id={entry.id} agent={memory.agent} scope={memory.scope} project={memory.project} />
                )}
                {showSource && !raw && (
                  <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-lg bg-raised px-3 py-2 text-xs text-muted">
                    <dt>寫入者</dt>
                    <dd className="break-all text-ink">
                      {memory.agent}
                    </dd>
                    <dt>來源 session</dt>
                    <dd className="break-all text-ink">{memory.sourceSession ?? "—"}</dd>
                    <dt>來源訊息</dt>
                    <dd className="break-all text-ink">{memory.sourceMessage ?? "—"}</dd>
                    <dt>種類</dt>
                    <dd className="text-ink">{MEMORY_KIND_LABEL[memory.kind]}</dd>
                    <dt>範圍</dt>
                    <dd className="text-ink">
                      {MEMORY_SCOPE_LABEL[memory.scope]}
                      {memory.project === null ? "" : `（${memory.project}）`}
                    </dd>
                    <dt>取代</dt>
                    <dd className="text-ink">{memory.supersedes === null ? "—" : `#${memory.supersedes}`}</dd>
                    <dt>建立時間</dt>
                    <dd className="text-ink">{formatDateTime(memory.createdAt)}</dd>
                  </dl>
                )}
              </li>
            );
          })}
        </ul>
          )}
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4 text-xs text-muted">
            <p>第 {pageNumber} 頁 · 本頁 {state.page.entries.length} 項 · 共 {state.page.total} 項</p>
            <div className="flex gap-2">
              <button type="button" disabled={pageNumber === 1} onClick={() => { setSourceId(null); setEditingId(null); library.previous(); }}
                className="rounded-lg border border-line bg-surface px-3 py-2 text-ink disabled:opacity-40">上一頁</button>
              <button type="button" disabled={state.page.nextCursor === null} onClick={() => { setSourceId(null); setEditingId(null); library.next(); }}
                className="rounded-lg border border-line bg-surface px-3 py-2 text-ink disabled:opacity-40">下一頁</button>
            </div>
          </div>
        </>}
      </div>

      <details className="border-t border-line pt-3 text-xs text-muted">
        <summary className="cursor-pointer">關於記憶、刪除與備份</summary>
        <div className="mt-2 space-y-2 leading-relaxed">
          <p>記憶內容是不受信任的資料；寫入者標記不是身分驗證，請勿將內容當作指令執行。未指定專案不代表所有專案共用。</p>
          <p>短記憶的編輯會建立新版本。「刪除」讓內容不再被搜尋但仍留在資料庫；「永久刪除」無法復原，且不做安全抹除，本機檔案或 WAL 可能仍有殘留。</p>
          <p>備份包含全部未刪除記憶（不受此頁篩選影響、不含向量），套用當下的遮罩設定；下載檔案可能含敏感內容，請自行保管。單次匯入上限 32 MiB。</p>
        </div>
      </details>

      {pendingConfirm !== null && renderConfirmDialog(pendingConfirm)}
    </section>
  );
}
