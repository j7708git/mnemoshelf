/**
 * 記憶管理畫面：列表（釘選標示、釘選優先排序）、釘選／取消、編輯（走 supersedes 語意——
 * 產生新版本並取代舊版）、刪除（軟刪除，需確認）、永久刪除（硬刪除，二次確認）、看來源，
 * 以及專案／範圍篩選與共享開關。
 *
 * 記憶由 AI agent 透過 `remember` 寫入，這個畫面是管理面：不直接改動既有列，
 * 「編輯」一律建立新版本並把舊版標記軟刪除（`POST /memories` 帶 `supersedes`）。
 * 共享開關只允許 `project` ↔ `global`（`PATCH /memories/:id`）；此 UI 不提供 `agent` 範圍切換，
 * REST `PATCH` 仍可設定。
 *
 * 寫入去重（卡 C2）：若 `POST /memories` 回 `200`＋`duplicate: true`，代表已有完全相同內容的
 * 記憶；這裡只提示既有 id，**不新增卡片**。
 */
import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";
import {
  addMemory,
  deleteMemory,
  downloadMemoriesExport,
  importMemories,
  listMemories,
  MemoryImportError,
  pinMemory,
  searchMemories,
  updateMemory,
  type Memory,
  type MemoryImportResult,
  type MemoryRecallResult,
  type MemoryScope,
} from "./api";
import { formatDateTime, MEMORY_KIND_LABEL, MEMORY_SCOPE_LABEL, shortenSourceId } from "./format";

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; memories: Memory[] }
  | { kind: "error"; message: string };

/** 記憶搜尋的狀態（與列表的載入狀態分開，搜尋失敗不影響列表）。 */
type RecallState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; result: MemoryRecallResult };

/** 篩選值：`"all"` 表示不過濾。 */
type ScopeFilter = MemoryScope | "all";
const ALL_PROJECTS = "all";

/**
 * 來源篩選（D4a）：`all`＝全部、`auto`＝只看自動寫入。
 *
 * 判準是 `agent` 以 `opencode-plugin` 開頭（v1 自動寫入者的標記，例如
 * `opencode-plugin`、`opencode-plugin@0.x`）。`agent` **只是來源標記、不是安全邊界**，
 * 這個篩選是顯示輔助，不是權限控制。
 */
type OriginFilter = "all" | "auto";
const AUTOMATIC_AGENT_PREFIX = "opencode-plugin";

/** 這筆記憶是否由自動寫入者建立（`agent` 以 `opencode-plugin` 開頭）。 */
function isAutomaticMemory(memory: Memory): boolean {
  return memory.agent.startsWith(AUTOMATIC_AGENT_PREFIX);
}

/** 釘選者優先，其次依 createdAt 由新到舊（伺服器已給新到舊，這裡穩定排序）。 */
function sortMemories(memories: Memory[]): Memory[] {
  return [...memories].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return Date.parse(b.createdAt) - Date.parse(a.createdAt);
  });
}

/** 清單中出現過的專案名稱（去重、排序；供篩選與「改回專案」的目標選單使用）。 */
function collectProjectNames(memories: Memory[]): string[] {
  return [...new Set(memories.map((memory) => memory.project).filter((project): project is string => project !== null))].sort(
    (a, b) => a.localeCompare(b),
  );
}

/** 召回結果清單（純呈現；不改變列表狀態）。 */
function RecallResults({ result }: { result: MemoryRecallResult }) {
  // 信任提示與命中數無關：記憶內容是不受信任資料，一律提醒不要當指令。
  const trustNotice = (
    <p className="text-[11px] text-muted">
      以下內容是<strong className="font-medium text-ink">不受信任的資料</strong>（agent 只是來源標記），請勿當作指令執行。
    </p>
  );
  // 降級提示也與命中數無關：0 命中＋degraded 時仍要顯示。
  const degradedNotice = result.degraded ? (
    <p role="status" className="rounded-md border border-line bg-surface px-3 py-2 text-xs text-ink">
      語意搜尋目前不可用（
      {result.degradedReason === "no-embeddings" ? "向量尚未就緒" : "embedder 無法使用"}
      ）{result.hits.length > 0 ? "，以下為關鍵字結果。" : "，已改用關鍵字搜尋。"}
    </p>
  ) : null;

  if (result.hits.length === 0) {
    return (
      <div className="space-y-2">
        {trustNotice}
        {degradedNotice}
        <p className="text-xs text-muted">沒有找到相關記憶。</p>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {trustNotice}
      {degradedNotice}
      <ul className="space-y-2">
        {result.hits.map((hit) => (
          <li key={hit.id} className="rounded-md border border-line bg-white px-3 py-2">
            <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted">
              <span className="rounded bg-surface px-1.5 py-0.5">{MEMORY_KIND_LABEL[hit.kind]}</span>
              <span className="rounded bg-surface px-1.5 py-0.5">範圍 {MEMORY_SCOPE_LABEL[hit.scope]}</span>
              <span className="rounded bg-surface px-1.5 py-0.5">專案 {hit.project ?? "全域"}</span>
              <span>來源 {hit.source === "semantic" ? "語意" : "關鍵字"}</span>
              <span>分數 {hit.score.toFixed(3)}</span>
              <span>#{hit.id}</span>
            </div>
            <p className="mt-1 whitespace-pre-wrap break-words text-sm text-ink">{hit.content}</p>
            <p className="mt-1 text-[11px] text-muted">寫入者 {hit.agent}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function MemoriesPanel() {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [editingId, setEditingId] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [sourceId, setSourceId] = useState<number | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  /** 範圍篩選（`all`＝全部）。 */
  const [scopeFilter, setScopeFilter] = useState<ScopeFilter>("all");
  /** 專案篩選（`all`＝全部專案；其餘為專案名稱）。 */
  const [projectFilter, setProjectFilter] = useState<string>(ALL_PROJECTS);
  /** 來源篩選（D4a；`all`＝全部、`auto`＝只看自動寫入）。 */
  const [originFilter, setOriginFilter] = useState<OriginFilter>("all");
  /** 每筆「改回專案」目前選定的目標專案（未選時用清單第一個可選專案）。 */
  const [shareTargets, setShareTargets] = useState<Record<number, string>>({});
  /** 記憶搜尋（卡 B2）：查詢字串、「找全部專案」與結果狀態。 */
  const [recallQuery, setRecallQuery] = useState("");
  const [recallAllProjects, setRecallAllProjects] = useState(false);
  const [recallState, setRecallState] = useState<RecallState>({ kind: "idle" });
  /** 備份匯出／匯入進行中（期間兩個按鈕都禁用，避免重複觸發）。 */
  const [backupBusy, setBackupBusy] = useState(false);
  /** dry-run 後待確認的匯入（原始文字只留在這個 state，不寫 log／storage）。 */
  const [importPreview, setImportPreview] = useState<{
    text: string;
    fileName: string;
    result: MemoryImportResult;
  } | null>(null);
  const importInputRef = useRef<HTMLInputElement | null>(null);

  /** 清單中出現過的專案名稱（供篩選與共享開關的目標選單）。 */
  const availableProjects = state.kind === "ready" ? collectProjectNames(state.memories) : [];

  const load = useCallback(async (): Promise<void> => {
    setState({ kind: "loading" });
    try {
      setState({ kind: "ready", memories: sortMemories(await listMemories()) });
    } catch (error) {
      setState({ kind: "error", message: error instanceof Error ? error.message : "讀取記憶清單失敗。" });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (id: number, action: () => Promise<void>, success: string): Promise<void> => {
    setBusyId(id);
    setActionError(null);
    setMessage(null);
    try {
      await action();
      setMessage(success);
      await load();
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
      memory.pinned ? "已取消釘選。" : "已釘選。",
    );
  };

  /** 共享開關：專案記憶 → 全域共享（`PATCH {scope:"global"}`）。 */
  const shareGlobally = (memory: Memory): void => {
    void run(
      memory.id,
      async () => {
        await updateMemory(memory.id, { scope: "global" });
      },
      "已設為全域共享。",
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
      `已改回專案「${target}」。`,
    );
  };

  /**
   * 執行記憶搜尋（沿用列表的專案／範圍篩選值＋「找全部專案」勾選）。
   *
   * 範圍不明確時（沒選專案、沒勾找全部、範圍又不是全域）先在前端提示，
   * 不送出伺服器必定 400 的請求；`agent` 範圍在 UI 沒有身分可用，故不支援（直接提示）。
   */
  const runRecall = async (): Promise<void> => {
    const query = recallQuery.trim();
    if (query === "") {
      setRecallState({ kind: "error", message: "請輸入查詢字串。" });
      return;
    }
    if (scopeFilter === "agent") {
      setRecallState({ kind: "error", message: "UI 搜尋不支援 agent 範圍（agent 範圍需由 agent 明確指定）。" });
      return;
    }
    if (!recallAllProjects && projectFilter === ALL_PROJECTS && scopeFilter !== "global") {
      setRecallState({ kind: "error", message: "請選擇專案、勾選「找全部專案」，或把範圍設為全域。" });
      return;
    }
    setRecallState({ kind: "loading" });
    try {
      const result = await searchMemories({
        query,
        ...(recallAllProjects ? { includeAllProjects: true } : {}),
        ...(!recallAllProjects && projectFilter !== ALL_PROJECTS ? { project: projectFilter } : {}),
        ...(scopeFilter !== "all" ? { scope: scopeFilter } : {}),
        k: 10,
      });
      setRecallState({ kind: "ready", result });
    } catch (error) {
      setRecallState({ kind: "error", message: error instanceof Error ? error.message : "搜尋記憶失敗。" });
    }
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
      await load();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "儲存記憶失敗。");
    } finally {
      setBusyId(null);
    }
  };

  const remove = (memory: Memory): void => {
    const confirmed = window.confirm(
      `要刪除這筆記憶嗎？\n\n「${memory.content.slice(0, 80)}」\n\n刪除後搜尋不到，資料仍保留在資料庫（軟刪除）。`,
    );
    if (!confirmed) return;
    void run(
      memory.id,
      async () => {
        await deleteMemory(memory.id);
      },
      "已刪除記憶。",
    );
  };

  /**
   * 永久刪除（硬刪除；卡 C2）：內容真的從資料庫移除、無法復原。
   *
   * 刻意做兩段確認（與軟刪除分開），文案必須誠實：不做安全抹除，本機檔案／WAL 可能仍有殘留。
   */
  const purge = (memory: Memory): void => {
    const first = window.confirm(
      `要永久刪除這筆記憶嗎？\n\n「${memory.content.slice(0, 80)}」\n\n` +
        "內容會從資料庫刪除、無法復原；本機檔案／WAL 可能仍有殘留（未做安全抹除）。",
    );
    if (!first) return;
    const second = window.confirm(
      `再次確認：永久刪除 #${memory.id} 後無法復原（沒有備份、也沒有垃圾桶）。真的要刪除嗎？`,
    );
    if (!second) return;
    void run(
      memory.id,
      async () => {
        await deleteMemory(memory.id, { hard: true });
      },
      "已永久刪除（資料列已移除；本機檔案／WAL 仍可能有殘留，未做安全抹除）。",
    );
  };

  /**
   * 匯出備份（NDJSON 下載）：只含未刪除的記憶、內容是遮罩後視圖。
   * 檔案由瀏覽器下載，不經過 log；失敗顯示在面板的錯誤區。
   */
  const exportBackup = async (): Promise<void> => {
    setBackupBusy(true);
    setActionError(null);
    setMessage(null);
    try {
      const { filename } = await downloadMemoriesExport();
      setMessage(`已下載備份 ${filename}（遮罩後內容、只含未刪除的記憶；檔案請自行保管）。`);
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
      await load();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "匯入記憶備份失敗。");
    } finally {
      setBackupBusy(false);
    }
  };

  if (state.kind === "loading") {
    return <p className="text-sm text-muted">正在載入記憶清單…</p>;
  }
  if (state.kind === "error") {
    return (
      <div className="space-y-3">
        <p role="alert" className="rounded-lg border border-line bg-white px-4 py-3 text-sm text-red-600">
          {state.message}
        </p>
        <button
          type="button"
          onClick={() => void load()}
          className="rounded-md border border-line px-3 py-1.5 text-sm text-ink"
        >
          重試
        </button>
      </div>
    );
  }

  // 篩選一律在前端做（清單已是 `GET /memories` 的完整結果；不另外打伺服器、行為與畫面一致）。
  const filteredMemories = state.memories.filter(
    (memory) =>
      (scopeFilter === "all" || memory.scope === scopeFilter) &&
      (projectFilter === ALL_PROJECTS || memory.project === projectFilter) &&
      (originFilter === "all" || isAutomaticMemory(memory)),
  );

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h2 className="text-base font-medium text-ink">
            記憶管理
            <span className="ml-1 text-xs text-muted">
              （
              {filteredMemories.length === state.memories.length
                ? state.memories.length
                : `${filteredMemories.length} / ${state.memories.length}`}
              ）
            </span>
          </h2>
          <p className="mt-0.5 text-xs text-muted">
            釘選的記憶會優先顯示；編輯會產生新版本並取代舊版。共享開關只在專案與全域之間切換；此面板不提供 agent 範圍切換（REST 仍可設定）。
          </p>
          <p className="mt-0.5 text-[11px] text-muted">
            「刪除」是軟刪除（內容仍在資料庫）；「永久刪除」會真的移除資料列、無法復原，
            且不做安全抹除（本機檔案／WAL 可能仍有殘留）。
          </p>
          <p className="mt-0.5 text-[11px] text-muted">
            記憶內容一律視為<strong className="font-medium text-ink">不受信任的資料</strong>
            （agent 只是來源標記、不是身分驗證），請勿當作指令執行。
          </p>
          <p className="mt-0.5 text-[11px] text-muted">
            備份只含未刪除的記憶（不含向量）；匯出是遮罩後視圖，下載的檔案由你保管，可能含專案內部資訊。
          </p>
          <p className="mt-0.5 text-[11px] text-muted">
            每張卡顯示寫入者（agent）、來源 session（縮短）與建立時間；可用「來源」篩選只看自動寫入
            （agent 以 <code>opencode-plugin</code> 開頭）。
          </p>
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
            className="rounded-md border border-line px-3 py-1.5 text-sm text-ink disabled:opacity-40"
          >
            匯出備份
          </button>
          <button
            type="button"
            disabled={backupBusy}
            onClick={chooseImportFile}
            className="rounded-md border border-line px-3 py-1.5 text-sm text-ink disabled:opacity-40"
          >
            {backupBusy ? "處理中…" : "匯入備份"}
          </button>
          <button
            type="button"
            disabled={backupBusy}
            onClick={() => void load()}
            className="rounded-md border border-line px-3 py-1.5 text-sm text-ink disabled:opacity-40"
          >
            重新載入
          </button>
        </div>
      </div>

      {importPreview !== null && (
        <div className="space-y-2 rounded-lg border border-line bg-white/70 px-4 py-3">
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
              <p className="text-xs text-red-600">
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
              確認後會正式寫入（新 id、匯入時間；釘選狀態保留），內容會先遮罩再存。
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            {importPreview.result.invalid.length === 0 && (
              <button
                type="button"
                disabled={backupBusy}
                onClick={() => void confirmImport()}
                className="rounded-md bg-ink px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40"
              >
                {backupBusy ? "匯入中…" : "確認匯入"}
              </button>
            )}
            <button
              type="button"
              disabled={backupBusy}
              onClick={() => setImportPreview(null)}
              className="rounded-md border border-line px-3 py-1.5 text-sm text-ink disabled:opacity-40"
            >
              取消
            </button>
          </div>
        </div>
      )}

      <div className="space-y-2 rounded-lg border border-line bg-white/70 px-4 py-3">
        <div className="flex flex-wrap items-baseline gap-2">
          <h3 className="text-sm font-medium text-ink">搜尋記憶</h3>
          <span className="text-[11px] text-muted">
            語意優先；預設本專案＋全域共享（＋自己的 agent 範圍），可用下方篩選與「找全部專案」
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="search"
            value={recallQuery}
            onChange={(event) => setRecallQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void runRecall();
            }}
            aria-label="搜尋記憶"
            placeholder="用自然語言找記憶…"
            maxLength={2000}
            className="min-w-[14rem] flex-1 rounded-md border border-line bg-white px-3 py-1.5 text-sm text-ink outline-none focus:border-ink"
          />
          <label className="flex items-center gap-1.5 text-xs text-muted">
            <input
              type="checkbox"
              checked={recallAllProjects}
              onChange={(event) => setRecallAllProjects(event.target.checked)}
            />
            找全部專案
          </label>
          <button
            type="button"
            disabled={recallState.kind === "loading"}
            onClick={() => void runRecall()}
            className="rounded-md bg-ink px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40"
          >
            {recallState.kind === "loading" ? "搜尋中…" : "搜尋"}
          </button>
        </div>
        {recallState.kind === "error" && (
          <p role="alert" className="text-xs text-red-600">
            {recallState.message}
          </p>
        )}
        {recallState.kind === "ready" && <RecallResults result={recallState.result} />}
      </div>

      {state.memories.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 text-xs text-muted">
          <label className="flex items-center gap-1.5">
            專案
            <select
              aria-label="依專案篩選"
              value={projectFilter}
              onChange={(event) => setProjectFilter(event.target.value)}
              className="rounded-md border border-line bg-white px-2 py-1 text-xs text-ink"
            >
              <option value={ALL_PROJECTS}>全部專案</option>
              {availableProjects.map((project) => (
                <option key={project} value={project}>
                  {project}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1.5">
            來源
            <select
              aria-label="依來源篩選"
              value={originFilter}
              onChange={(event) => setOriginFilter(event.target.value as OriginFilter)}
              className="rounded-md border border-line bg-white px-2 py-1 text-xs text-ink"
            >
              <option value="all">全部</option>
              <option value="auto">只看自動寫入</option>
            </select>
          </label>
          <label className="flex items-center gap-1.5">
            範圍
            <select
              aria-label="依範圍篩選"
              value={scopeFilter}
              onChange={(event) => setScopeFilter(event.target.value as ScopeFilter)}
              className="rounded-md border border-line bg-white px-2 py-1 text-xs text-ink"
            >
              <option value="all">全部範圍</option>
              <option value="global">全域</option>
              <option value="project">專案</option>
              <option value="agent">agent</option>
            </select>
          </label>
          {(scopeFilter !== "all" || projectFilter !== ALL_PROJECTS || originFilter !== "all") && (
            <button
              type="button"
              onClick={() => {
                setScopeFilter("all");
                setProjectFilter(ALL_PROJECTS);
                setOriginFilter("all");
              }}
              className="rounded-md border border-line px-2 py-1 text-xs text-ink"
            >
              清除篩選
            </button>
          )}
        </div>
      )}

      {message !== null && (
        <p className="rounded-lg border border-line bg-white px-4 py-2 text-sm text-ink">{message}</p>
      )}
      {actionError !== null && (
        <p role="alert" className="rounded-lg border border-line bg-white px-4 py-2 text-sm text-red-600">
          {actionError}
        </p>
      )}

      {state.memories.length === 0 ? (
        <div className="flex h-[40vh] items-center justify-center rounded-lg border border-dashed border-line bg-white/60 px-6 text-center text-sm text-muted">
          尚無記憶。AI agent 透過 remember 寫入的共享記憶會出現在這裡。
        </div>
      ) : filteredMemories.length === 0 ? (
        <div className="flex h-[30vh] items-center justify-center rounded-lg border border-dashed border-line bg-white/60 px-6 text-center text-sm text-muted">
          沒有符合目前篩選條件的記憶。
        </div>
      ) : (
        <ul className="space-y-3">
          {filteredMemories.map((memory) => {
            const editing = editingId === memory.id;
            const showSource = sourceId === memory.id;
            const busy = busyId === memory.id;
            return (
              <li
                key={memory.id}
                className={`rounded-lg border px-4 py-3 ${
                  memory.pinned ? "border-ink bg-white" : "border-line bg-white/70"
                }`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  {memory.pinned && (
                    <span className="rounded bg-ink px-1.5 py-0.5 text-[11px] font-medium text-white">已釘選</span>
                  )}
                  <span className="rounded bg-surface px-1.5 py-0.5 text-[11px] text-muted">
                    {MEMORY_KIND_LABEL[memory.kind]}
                  </span>
                  <span className="rounded bg-surface px-1.5 py-0.5 text-[11px] text-muted">
                    範圍 {MEMORY_SCOPE_LABEL[memory.scope]}
                  </span>
                  <span className="rounded bg-surface px-1.5 py-0.5 text-[11px] text-muted">
                    專案 {memory.project ?? "全域"}
                  </span>
                  <span
                    className="max-w-full break-all rounded bg-surface px-1.5 py-0.5 text-[11px] text-muted"
                    title={memory.agent}
                  >
                    寫入者 {memory.agent}
                    {isAutomaticMemory(memory) ? "（自動）" : ""}
                  </span>
                  {memory.sourceSession !== null && (
                    <span
                      className="rounded bg-surface px-1.5 py-0.5 text-[11px] text-muted"
                      title={memory.sourceSession}
                    >
                      session {shortenSourceId(memory.sourceSession)}
                    </span>
                  )}
                  <span className="text-[11px] text-muted">#{memory.id}</span>
                  <span className="ml-auto text-[11px] text-muted">{formatDateTime(memory.createdAt)}</span>
                </div>

                {editing ? (
                  <div className="mt-2 space-y-2">
                    <textarea
                      value={draft}
                      onChange={(event) => setDraft(event.target.value)}
                      rows={3}
                      aria-label="編輯記憶內容"
                      className="w-full rounded-md border border-line bg-white px-3 py-2 text-sm text-ink outline-none focus:border-ink"
                    />
                    <p className="text-[11px] text-muted">
                      儲存會建立新版本（agent／種類／範圍沿用）並把這一版標記為已取代。
                    </p>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void saveEdit(memory)}
                        className="rounded-md bg-ink px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40"
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
                  <p className="mt-2 whitespace-pre-wrap break-words text-sm text-ink">{memory.content}</p>
                )}

                <div className="mt-2 flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => togglePin(memory)}
                    className="rounded-md border border-line px-2.5 py-1 text-xs text-ink disabled:opacity-40"
                  >
                    {memory.pinned ? "取消釘選" : "釘選"}
                  </button>
                  {!editing && (
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
                    className="rounded-md border border-line px-2.5 py-1 text-xs text-ink"
                  >
                    {showSource ? "收起來源" : "看來源"}
                  </button>
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
                        className="rounded-md border border-line bg-white px-2 py-1 text-xs text-ink disabled:opacity-40"
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
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => remove(memory)}
                    className="rounded-md border border-line px-2.5 py-1 text-xs text-muted hover:text-red-600 disabled:opacity-40"
                  >
                    刪除
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => purge(memory)}
                    className="rounded-md border border-line px-2.5 py-1 text-xs text-red-600 hover:bg-red-50 disabled:opacity-40"
                    title="真的從資料庫刪除（無法復原；不做安全抹除）"
                  >
                    永久刪除
                  </button>
                </div>

                {showSource && (
                  <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-md bg-surface px-3 py-2 text-xs text-muted">
                    <dt>寫入者</dt>
                    <dd className="break-all text-ink">
                      {memory.agent}
                      {isAutomaticMemory(memory) ? "（自動寫入）" : ""}
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
    </section>
  );
}
