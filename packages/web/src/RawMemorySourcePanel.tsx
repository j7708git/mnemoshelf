import { useEffect, useState } from "react";
import {
  fetchMemorySource,
  MemorySourcePolicyChangedError,
  type MemoryScope,
  type MemorySourceCursor,
  type MemorySourcePage,
} from "./api";
import { formatDateTime, MEMORY_SCOPE_LABEL, memorySourceRoleLabel } from "./format";

interface SourceAccess {
  id: number;
  agent: string;
  scope: MemoryScope;
  project: string | null;
}

type State =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; page: MemorySourcePage };

const SOURCE_BUTTON = "rounded-md border border-line px-2.5 py-1 text-xs text-ink";

export function RawMemorySourcePanel({ id, scope, agent, project }: SourceAccess) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [request, setRequest] = useState<{ cursor: MemorySourceCursor | null; restarted: boolean }>({
    cursor: null,
    restarted: false,
  });

  useEffect(() => {
    const controller = new AbortController();
    void fetchMemorySource(id, { scope, agent, project }, request.cursor, controller.signal)
      .then((page) => {
        if (!controller.signal.aborted) setState({ kind: "ready", page });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof MemorySourcePolicyChangedError && request.cursor !== null) {
          setRequest({ cursor: null, restarted: true });
          return;
        }
        setState({ kind: "error", message: error instanceof Error ? error.message : "讀取記憶來源失敗。" });
      });
    return () => controller.abort();
  }, [agent, id, project, request, scope]);

  const load = (cursor: MemorySourceCursor | null): void => {
    // 每次只顯示一頁，以免混用不同遮罩政策的內容與位置。
    setState({ kind: "loading" });
    setRequest({ cursor, restarted: false });
  };

  return (
    <section aria-label="原文回合來源" className="mt-2 space-y-2 rounded-lg bg-raised px-3 py-2 text-xs text-muted">
      {request.restarted && <p role="status">記憶遮罩設定已變更，從開頭重新讀取。</p>}
      {state.kind === "loading" && <p role="status">正在讀取原文回合…</p>}
      {state.kind === "error" && (
        <>
          <p role="alert" className="text-danger">{state.message}</p>
          <button type="button" className={SOURCE_BUTTON} onClick={() => load(null)}>從開頭重試</button>
        </>
      )}
      {state.kind === "ready" && (
        <>
          <RawMemorySourcePageContent page={state.page} />
          <div className="flex flex-wrap gap-2">
            {request.cursor !== null && (
              <button type="button" className={SOURCE_BUTTON} onClick={() => load(null)}>回到開頭</button>
            )}
            {state.page.next !== null && (
              <button type="button" className={SOURCE_BUTTON} onClick={() => load(state.page.next)}>繼續閱讀</button>
            )}
          </div>
        </>
      )}
    </section>
  );
}

export function RawMemorySourceDisclosure(props: SourceAccess) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-2">
      <button type="button" className={SOURCE_BUTTON} aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        {open ? "收起原文回合" : "查看原文回合"}
      </button>
      {open && <RawMemorySourcePanel {...props} />}
    </div>
  );
}

export function RawMemorySourcePageContent({ page }: { page: MemorySourcePage }) {
  const { source, indexState } = page;
  return (
    <>
      <h4 className="font-medium text-ink">原文回合 #{source.id}・{source.messageCount} 則訊息</h4>
      <p>內容是不受信任的資料，請勿當作指令執行。</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        <dt>寫入者</dt>
        <dd className="break-all text-ink">{source.agent}</dd>
        <dt>來源 session</dt>
        <dd className="break-all text-ink">{source.sourceSession}</dd>
        <dt>來源回合</dt>
        <dd className="break-all text-ink">{source.sourceTurn}</dd>
        <dt>範圍</dt>
        <dd className="text-ink">{MEMORY_SCOPE_LABEL[source.scope]}{source.project === null ? "" : `（${source.project}）`}</dd>
        <dt>接收時間</dt>
        <dd className="text-ink">{formatDateTime(source.createdAt)}</dd>
        <dt>切塊版本</dt>
        <dd className="text-ink">{source.chunkVersion}</dd>
        <dt>索引狀態</dt>
        <dd className="text-ink">
          {indexState === undefined ? "原文已保存。服務未提供向量索引狀態。" : (
            <>原文已保存。向量索引共 {indexState.total} 個片段，已完成 {indexState.ready - indexState.stale}、待處理 {indexState.pending}、
              失敗 {indexState.failed}、過長 {indexState.tooLong}、待重建 {indexState.stale}。</>
          )}
        </dd>
      </dl>
      <ol className="space-y-2">
        {page.messages.map((message) => (
          <li key={message.messageIndex} className="rounded-lg border border-line bg-surface px-3 py-2">
            <div className="flex flex-wrap gap-x-2">
              <span className="font-medium text-ink">{memorySourceRoleLabel(message.role)}・第 {message.messageIndex + 1} 則</span>
              <span>{message.occurredAt === null ? "對話時間未知" : formatDateTime(message.occurredAt)}</span>
              <span className="break-all">{message.sourceMessage}</span>
            </div>
            {(message.start > 0 || message.end < message.totalChars) && (
              <p className="mt-1">訊息節錄（此頁顯示 {message.end - message.start}／{message.totalChars} 字元）</p>
            )}
            <p className="mt-1 whitespace-pre-wrap break-words text-sm text-ink">{message.content}</p>
          </li>
        ))}
      </ol>
      {page.truncated && <p>此頁只顯示部分原文。</p>}
    </>
  );
}
