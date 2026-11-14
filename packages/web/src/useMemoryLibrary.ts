import { useCallback, useEffect, useRef, useState } from "react";
import { listMemoryLibrary, type MemoryLibraryPage, type MemoryLibraryQuery } from "./api";

export interface MemoryLibraryFilters {
  /** JSON 字串代表實際名稱；控制值不與名為 all 的專案混用。 */
  project: string;
  writer: string;
  type: "all" | "source" | "memory";
  query: string;
}

export const EMPTY_LIBRARY_FILTERS: MemoryLibraryFilters = { project: "all", writer: "all", type: "all", query: "" };

/** 選單名稱使用 JSON 編碼，與全部／未指定等控制選項分開。 */
export function memoryNameOption(name: string): string {
  return JSON.stringify(name);
}

/** 最後一筆被刪除時，仍顯示使用者目前選定的條件，避免選單假裝回到全部。 */
export function memoryOptionNames(names: string[], selected: string): string[] {
  if (!selected.startsWith('"')) return names;
  const name = JSON.parse(selected) as string;
  return names.includes(name) ? names : [...names, name];
}

/** 專案、寫入者、形式與文字是獨立的 AND 條件，不能以舊 scope 取代。 */
export function memoryLibraryQuery(filters: MemoryLibraryFilters, cursor: string | null): MemoryLibraryQuery {
  return {
    ...(filters.project === "unassigned" ? { unassigned: true } :
      filters.project === "all" ? {} : { project: JSON.parse(filters.project) as string }),
    ...(filters.writer === "all" ? {} : { writer: JSON.parse(filters.writer) as string }),
    ...(filters.type === "all" ? {} : { type: filters.type }),
    ...(filters.query.trim() === "" ? {} : { query: filters.query.trim() }),
    limit: 25,
    ...(cursor === null ? {} : { cursor }),
  };
}

type LibraryState =
  | { kind: "loading" }
  | { kind: "ready"; page: MemoryLibraryPage }
  | { kind: "error"; message: string };

/** 每次換條件立即作廢舊請求；游標只沿用同一組條件下的前後頁。 */
export function useMemoryLibrary() {
  const [filters, setFilters] = useState<MemoryLibraryFilters>(EMPTY_LIBRARY_FILTERS);
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<LibraryState>({ kind: "loading" });
  const [facets, setFacets] = useState<MemoryLibraryPage["facets"]>({ projects: [], writers: [], hasUnassigned: false });
  const requestId = useRef(0);
  const pending = useRef<AbortController | null>(null);

  const invalidate = useCallback(() => {
    requestId.current += 1;
    pending.current?.abort();
    setState({ kind: "loading" });
  }, []);

  const changeFilters = useCallback((patch: Partial<MemoryLibraryFilters>) => {
    invalidate();
    setFilters((previous) => ({ ...previous, ...patch }));
    setCursors([null]);
  }, [invalidate]);

  const reload = useCallback(() => {
    invalidate();
    setCursors([null]);
    setRevision((previous) => previous + 1);
  }, [invalidate]);

  const next = () => {
    if (state.kind !== "ready" || state.page.nextCursor === null) return;
    const cursor = state.page.nextCursor;
    invalidate();
    setCursors((previous) => [...previous, cursor]);
  };

  const previous = () => {
    if (cursors.length === 1 || state.kind === "loading") return;
    invalidate();
    setCursors((current) => current.slice(0, -1));
  };

  useEffect(() => {
    const id = ++requestId.current;
    const abort = new AbortController();
    pending.current = abort;
    setState({ kind: "loading" });
    void listMemoryLibrary(memoryLibraryQuery(filters, cursors.at(-1) ?? null), abort.signal).then((page) => {
      if (id !== requestId.current) return;
      setFacets(page.facets);
      setState({ kind: "ready", page });
    }).catch((error: unknown) => {
      if (id !== requestId.current) return;
      setState({ kind: "error", message: error instanceof Error ? error.message : "讀取記憶清單失敗。" });
    });
    return () => {
      requestId.current += 1;
      abort.abort();
    };
  }, [filters, cursors, revision]);

  return { state, facets, filters, pageNumber: cursors.length, changeFilters, reload, next, previous };
}
