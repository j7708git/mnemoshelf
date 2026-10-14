/**
 * 統一搜尋畫面：模式選擇器（vector／hybrid／keyword，**UI 預設 hybrid**）＋查詢，
 * 結果區分「檔案塊」與「記憶」；點檔案結果在右側以既有 `FilePreview` 開預覽。
 *
 * 為什麼 UI 預設 `hybrid`（PM 裁示）：server 的 `/search` 預設仍是 `vector`，但記憶只進
 * keyword 那一路，預設 `vector` 不會有記憶命中；搜尋畫面要能同時看到記憶，因此預設 `hybrid`。
 * 三種模式都可以明確選取。
 */
import { useCallback, useState } from "react";
import { search, SEARCH_MODES, type ChunkSearchHit, type DirEntry, type Root, type SearchHit, type SearchMode } from "./api";
import { FilePreview } from "./FilePreview";
import { basename, MEMORY_KIND_LABEL, MEMORY_SCOPE_LABEL } from "./format";

/** 模式的中文標籤（附上英文名稱，與 API 的 `mode` 對應）。 */
const MODE_LABEL: Record<SearchMode, string> = {
  vector: "向量 vector",
  hybrid: "混合 hybrid",
  keyword: "關鍵字 keyword",
};

/** 模式的簡短說明（讓使用者知道哪種模式含記憶）。 */
const MODE_HINT: Record<SearchMode, string> = {
  vector: "只跑向量那一路，不含記憶命中。",
  hybrid: "向量＋關鍵字兩路以 RRF 合併，含記憶命中（預設）。",
  keyword: "只跑關鍵字那一路，含記憶命中。",
};

type SearchState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; hits: SearchHit[]; effectiveMode: SearchMode }
  | { kind: "error"; message: string };

/** 把檔案命中轉成 `FilePreview` 需要的 `DirEntry`（搜尋結果沒有大小與 MIME）。 */
function entryForChunk(hit: ChunkSearchHit): DirEntry {
  return { name: basename(hit.relPath), path: hit.relPath, kind: hit.kind, size: null, mimeType: null };
}

export interface SearchPanelProps {
  /** 已加入的 root（用來把 `rootId` 顯示成可讀的資料夾路徑）。 */
  roots: Root[];
  /** 記憶命中時可跳到記憶管理畫面。 */
  onOpenMemories?: () => void;
}

export function SearchPanel({ roots, onOpenMemories }: SearchPanelProps) {
  const [mode, setMode] = useState<SearchMode>("hybrid");
  const [query, setQuery] = useState("");
  const [state, setState] = useState<SearchState>({ kind: "idle" });
  const [selected, setSelected] = useState<{ entry: DirEntry; rootId: number } | null>(null);

  const rootPath = (rootId: number): string => roots.find((root) => root.id === rootId)?.path ?? `root ${rootId}`;

  const run = useCallback(async (queryText: string, modeValue: SearchMode): Promise<void> => {
    const trimmed = queryText.trim();
    if (trimmed === "") {
      setState({ kind: "error", message: "請先輸入查詢字串。" });
      return;
    }
    setSelected(null);
    setState({ kind: "loading" });
    try {
      const result = await search({ query: trimmed, mode: modeValue, k: 20 });
      setState({ kind: "ready", hits: result.hits, effectiveMode: result.mode });
    } catch (error) {
      setState({ kind: "error", message: error instanceof Error ? error.message : "搜尋失敗。" });
    }
  }, []);

  const submit = (event: React.FormEvent): void => {
    event.preventDefault();
    void run(query, mode);
  };

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-base font-medium text-ink">搜尋</h2>
        <p className="mt-0.5 text-xs text-muted">查詢已索引的檔案與共享記憶；記憶只會出現在含關鍵字的模式。</p>
      </div>

      <form onSubmit={submit} className="space-y-3 rounded-lg border border-line bg-white/70 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted">模式</span>
          <div role="group" aria-label="搜尋模式" className="inline-flex overflow-hidden rounded-md border border-line">
            {SEARCH_MODES.map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={mode === option}
                onClick={() => setMode(option)}
                className={`px-3 py-1.5 text-xs font-medium ${
                  mode === option ? "bg-ink text-white" : "bg-white text-ink"
                }`}
              >
                {MODE_LABEL[option]}
              </button>
            ))}
          </div>
        </div>
        <p className="text-xs text-muted">{MODE_HINT[mode]}</p>

        <div className="flex gap-2">
          <input
            id="mnemoshelf-search-query"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="輸入查詢字串，例如：儲存介面 的設計"
            className="min-w-0 flex-1 rounded-md border border-line bg-white px-3 py-2 text-sm text-ink outline-none focus:border-ink"
          />
          <button
            type="submit"
            disabled={state.kind === "loading"}
            className="shrink-0 rounded-md bg-ink px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
          >
            {state.kind === "loading" ? "搜尋中…" : "搜尋"}
          </button>
        </div>
      </form>

      {state.kind === "idle" && (
        <div className="flex h-[40vh] items-center justify-center rounded-lg border border-dashed border-line bg-white/60 px-6 text-center text-sm text-muted">
          輸入查詢字串後按「搜尋」。預設為混合模式（hybrid），會同時列出檔案與記憶。
        </div>
      )}

      {state.kind === "error" && (
        <p role="alert" className="rounded-lg border border-line bg-white px-4 py-3 text-sm text-red-600">
          {state.message}
        </p>
      )}

      {state.kind === "ready" && (
        <div className="grid min-h-0 gap-4 lg:grid-cols-2">
          <div className="space-y-2">
            <p className="text-xs text-muted">
              共 {state.hits.length} 筆結果（模式：{MODE_LABEL[state.effectiveMode]}）
            </p>
            {state.hits.length === 0 ? (
              <div className="flex h-[40vh] items-center justify-center rounded-lg border border-dashed border-line bg-white/60 px-6 text-center text-sm text-muted">
                找不到符合的結果。試試其他關鍵字，或換一種搜尋模式。
              </div>
            ) : (
              <ul className="space-y-2">
                {state.hits.map((hit) => (
                  <li key={hit.key}>
                    {hit.type === "chunk" ? (
                      <button
                        type="button"
                        onClick={() => setSelected({ entry: entryForChunk(hit), rootId: hit.rootId })}
                        aria-current={selected?.entry.path === hit.relPath ? "true" : undefined}
                        className={`w-full rounded-lg border px-3 py-2 text-left ${
                          selected?.entry.path === hit.relPath ? "border-ink bg-white" : "border-line bg-white/70"
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="rounded bg-surface px-1.5 py-0.5 text-[11px] font-medium text-muted">
                            檔案・{hit.kind}
                          </span>
                          <span className="shrink-0 text-[11px] text-muted">
                            #{hit.rank}・分數 {hit.score.toFixed(4)}
                          </span>
                        </div>
                        <p className="mt-1 break-all font-mono text-xs text-ink">
                          {rootPath(hit.rootId)}／{hit.relPath}
                        </p>
                        {hit.text !== null && (
                          <p className="mt-1 line-clamp-3 text-xs text-muted">
                            {hit.text}
                            {hit.textTruncated ? "…" : ""}
                          </p>
                        )}
                        <p className="mt-1 text-[11px] text-muted">點擊在右側預覽這個檔案</p>
                      </button>
                    ) : (
                      <div className="rounded-lg border border-line bg-white/70 px-3 py-2">
                        <div className="flex items-center justify-between gap-2">
                          <span className="rounded bg-surface px-1.5 py-0.5 text-[11px] font-medium text-muted">
                            記憶・{MEMORY_KIND_LABEL[hit.kind]}
                          </span>
                          <span className="shrink-0 text-[11px] text-muted">
                            #{hit.rank}・分數 {hit.score.toFixed(4)}
                          </span>
                        </div>
                        <p className="mt-1 text-xs text-ink">
                          {hit.text}
                          {hit.textTruncated ? "…" : ""}
                        </p>
                        <p className="mt-1 text-[11px] text-muted">
                          來源：{hit.agent}・範圍 {MEMORY_SCOPE_LABEL[hit.scope]}
                          {hit.project === null ? "" : `・${hit.project}`}
                        </p>
                        {onOpenMemories !== undefined && (
                          <button
                            type="button"
                            onClick={onOpenMemories}
                            className="mt-1 rounded-md border border-line px-2 py-0.5 text-[11px] text-ink"
                          >
                            到記憶管理檢視
                          </button>
                        )}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="h-[60vh] min-h-0 overflow-auto">
            {selected === null ? (
              <div className="flex h-full items-center justify-center rounded-lg border border-dashed border-line bg-white/60 px-6 text-center text-sm text-muted">
                點選左側的檔案結果即可在這裡預覽（支援文字與圖片）。
              </div>
            ) : (
              <FilePreview
                key={`${selected.rootId}:${selected.entry.path}`}
                rootId={selected.rootId}
                entry={selected.entry}
              />
            )}
          </div>
        </div>
      )}
    </section>
  );
}
