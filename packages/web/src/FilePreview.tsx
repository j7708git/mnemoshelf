/**
 * 檔案預覽：文字（`GET /roots/:id/file` 的 JSON）與圖片（fetch＋blob URL）。
 *
 * 圖片一律 `fetch`＋`URL.createObjectURL`（`<img src>` 帶不了 `Authorization`），
 * 且在不再使用時 `URL.revokeObjectURL`（否則 blob 會累積）。預設顯示縮圖端點的結果，
 * 需要時可切換成原始位元組。
 */
import { useEffect, useState } from "react";
import { fetchImageBlobUrl, readTextPreview, type DirEntry, type TextPreviewBody } from "./api";
import { formatBytes } from "./format";

/** 計算 UTF-8 位元組數用；模組層共用一個即可。 */
const utf8Encoder = new TextEncoder();

/** 檔案預覽的容器：依型別分派。`key` 由呼叫端以路徑設定，切換檔案時整個重掛載。 */
export function FilePreview({ rootId, entry }: { rootId: number; entry: DirEntry }) {
  if (entry.kind === "text" || entry.kind === "code") {
    return <TextFilePreview rootId={rootId} entry={entry} />;
  }
  if (entry.kind === "image") {
    return <ImageFilePreview rootId={rootId} entry={entry} />;
  }
  return (
    <div className="rounded-lg border border-line bg-white px-4 py-6 text-sm text-muted">
      <p className="font-medium text-ink">{entry.name}</p>
      <p className="mt-2">此型別（{entry.kind}）不支援預覽。</p>
      {entry.size !== null && <p className="mt-1">大小：{formatBytes(entry.size)}</p>}
    </div>
  );
}

type TextState = { kind: "loading" } | { kind: "ready"; body: TextPreviewBody } | { kind: "error"; message: string };

function TextFilePreview({ rootId, entry }: { rootId: number; entry: DirEntry }) {
  const [state, setState] = useState<TextState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    readTextPreview(rootId, entry.path)
      .then((body) => {
        if (!cancelled) setState({ kind: "ready", body });
      })
      .catch((error: unknown) => {
        if (!cancelled) setState({ kind: "error", message: error instanceof Error ? error.message : "讀取檔案失敗" });
      });
    return () => {
      cancelled = true;
    };
  }, [rootId, entry.path]);

  if (state.kind === "loading") return <p className="text-sm text-muted">正在載入檔案…</p>;
  if (state.kind === "error") {
    return (
      <p role="alert" className="text-sm text-red-600">
        {state.message}
      </p>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <p className="truncate font-medium text-ink" title={entry.path}>
          {entry.name}
        </p>
        <span className="shrink-0 text-xs text-muted">大小：{formatBytes(state.body.size)}</span>
      </div>
      {state.body.truncated && (
        <p className="rounded-md border border-line bg-surface px-3 py-2 text-xs text-muted">
          檔案過大，只顯示前 {formatBytes(utf8Encoder.encode(state.body.content).length)}（內容已截斷）。
        </p>
      )}
      <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-line bg-white p-3 text-xs leading-relaxed text-ink">
        {state.body.content}
      </pre>
    </div>
  );
}

type ImageState = { kind: "loading" } | { kind: "ready" } | { kind: "error"; message: string };

function ImageFilePreview({ rootId, entry }: { rootId: number; entry: DirEntry }) {
  const [variant, setVariant] = useState<"thumb" | "file">("thumb");
  const [url, setUrl] = useState<string | null>(null);
  const [state, setState] = useState<ImageState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    let created: string | null = null;
    setState({ kind: "loading" });
    setUrl(null);
    fetchImageBlobUrl(rootId, variant, entry.path)
      .then((objectUrl) => {
        if (cancelled) {
          URL.revokeObjectURL(objectUrl);
          return;
        }
        created = objectUrl;
        setUrl(objectUrl);
        setState({ kind: "ready" });
      })
      .catch((error: unknown) => {
        if (!cancelled) setState({ kind: "error", message: error instanceof Error ? error.message : "讀取圖片失敗" });
      });
    return () => {
      cancelled = true;
      if (created !== null) URL.revokeObjectURL(created);
    };
  }, [rootId, entry.path, variant]);

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="truncate font-medium text-ink" title={entry.path}>
          {entry.name}
        </p>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted">
            {entry.size === null ? "" : formatBytes(entry.size)}
            {entry.mimeType === null ? "" : `　${entry.mimeType}`}
          </span>
          <button
            type="button"
            onClick={() => setVariant((current) => (current === "thumb" ? "file" : "thumb"))}
            className="rounded-md border border-line px-2 py-1 text-xs text-ink"
          >
            {variant === "thumb" ? "載入原圖" : "顯示縮圖"}
          </button>
        </div>
      </div>

      {state.kind === "loading" && <p className="text-sm text-muted">正在載入圖片…</p>}
      {state.kind === "error" && (
        <p role="alert" className="text-sm text-red-600">
          {state.message}
        </p>
      )}
      {state.kind === "ready" && url !== null && (
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto rounded-lg border border-line bg-white p-3">
          <img src={url} alt={entry.name} className="max-h-[60vh] max-w-full object-contain" />
        </div>
      )}
    </div>
  );
}
