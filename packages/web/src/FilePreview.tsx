/**
 * 檔案預覽：文字 JSON、圖片、音訊（fetch＋blob URL）與影片（同源 Range 播放）。
 *
 * 圖片與音訊一律 `fetch`＋`URL.createObjectURL`（`<img src>`／`<audio src>` 帶不了
 * `Authorization`），且在不再使用時 `URL.revokeObjectURL`（否則 blob 會累積）。
 * **影片不走 blob**：桌面版由 Electron 的 `webRequest` 對同源 `<video src>` 注入授權並以
 * Range 串流播放；瀏覽器模式明確顯示「需桌面版」，不把 token 放進 URL、也不整檔下載。
 */
import { useEffect, useState, useRef } from "react";
import {
  fetchAudioBlobUrl,
  fetchImageBlobUrl,
  mediaUrl,
  probeMedia,
  readTextPreview,
  type ChunkMedia,
  type DirEntry,
  type TextPreviewBody,
} from "./api";
import { formatBytes } from "./format";
import { formatMediaTime } from "./audio";
import {
  formatMediaSpan,
  mediaFrameSeconds,
  mediaSeekSeconds,
  mediaTrackLabel,
  VIDEO_SEGMENT_SECONDS,
  videoPlaybackSupport,
} from "./media";

/** 計算 UTF-8 位元組數用；模組層共用一個即可。 */
const utf8Encoder = new TextEncoder();

/** 檔案預覽的容器：依型別分派。`key` 由呼叫端以路徑設定，切換檔案時整個重掛載。 */
export function FilePreview({ rootId, entry, media }: { rootId: number; entry: DirEntry; media?: ChunkMedia }) {
  if (entry.kind === "text" || entry.kind === "code") {
    return <TextFilePreview rootId={rootId} entry={entry} />;
  }
  if (entry.kind === "image") {
    return <ImageFilePreview rootId={rootId} entry={entry} />;
  }
  // 影片音軌命中（kind:"audio"、track:"video-audio"）要開影片播放器並定位：
  // 來源是 .mp4，不能走 WAV 的 blob 端點（伺服器會以非 WAV 拒絕）。
  if (entry.kind === "video" || media?.track === "video" || media?.track === "video-audio") {
    return <VideoFilePreview rootId={rootId} entry={entry} media={media} />;
  }
  if (entry.kind === "audio") return <AudioFilePreview rootId={rootId} entry={entry} media={media} />;
  return (
    <div className="rounded-lg border border-line bg-white px-4 py-6 text-sm text-muted">
      <p className="font-medium text-ink">{entry.name}</p>
      <p className="mt-2">此型別（{entry.kind}）不支援預覽。</p>
      {entry.size !== null && <p className="mt-1">大小：{formatBytes(entry.size)}</p>}
    </div>
  );
}

function AudioFilePreview({ rootId, entry, media }: { rootId: number; entry: DirEntry; media?: ChunkMedia }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const player = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    let cancelled = false;
    let created: string | null = null;
    setUrl(null);
    setError(null);
    void fetchAudioBlobUrl(rootId, entry.path).then((value) => {
      if (cancelled) URL.revokeObjectURL(value);
      else { created = value; setUrl(value); }
    }).catch((reason: unknown) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : "讀取音訊失敗");
    });
    return () => { cancelled = true; if (created !== null) URL.revokeObjectURL(created); };
  }, [rootId, entry.path]);
  const seek = (): void => {
    if (player.current !== null && media !== undefined) player.current.currentTime = media.startSeconds;
  };
  return <div className="space-y-3 rounded-lg border border-line bg-white p-4">
    <p className="break-all font-medium text-ink">{entry.path}</p>
    {media !== undefined && <p className="text-sm text-muted">命中片段：{formatMediaSpan(media.startSeconds, media.endSeconds)}</p>}
    {error !== null && <p role="alert" className="text-sm text-red-600">{error}</p>}
    {url === null && error === null && <p className="text-sm text-muted">正在載入音訊…</p>}
    {url !== null && <>
      <audio ref={player} controls preload="metadata" src={url} onLoadedMetadata={seek}
        onError={() => setError("瀏覽器無法播放這個音訊檔案。")}
        className="w-full" aria-label={entry.name} />
      {media !== undefined && <button type="button" onClick={seek} className="rounded border border-line px-3 py-1 text-sm">定位到命中片段</button>}
    </>}
    <p className="text-xs text-muted">音訊語意索引不產生逐字稿；播放的是來源檔案目前的內容。</p>
  </div>;
}

/**
 * 影片預覽與播放（桌面版同源 Range；瀏覽器版明確限制）。
 *
 * 設計要點：
 * - **不整檔下載**：`<video src="/roots/:id/media?path=…">` 由 Chromium 自己發 Range 請求；
 *   桌面版的 `Authorization` 由 main process 的 `webRequest` 注入（token 不進 URL）。
 * - **瀏覽器模式**：`<video>` 帶不了標頭 → 顯示「需桌面版 App」，不偷偷把 token 拼進 query。
 * - **定位**：有命中片段時，載入 metadata 後 seek 到實際取樣幀時間（畫面）或片段起點（音軌），
 *   另提供「跳到命中片段」按鈕；只用伺服器回報的時間，不自行推算事件位置。
 * - **錯誤可讀**：`<video>` 的 error 事件拿不到 HTTP 狀態，失敗時以授權 HEAD 探測端點，
 *   區分 403（root／權限）、404、413（大小上限）、415（非 mp4）、416（Range）與解碼失敗。
 * - **時長**：預覽階段不假設時長；播放器載入後才顯示實際值（由檔案讀出，不是捏造）。
 */
function VideoFilePreview({ rootId, entry, media }: { rootId: number; entry: DirEntry; media?: ChunkMedia }) {
  const support = videoPlaybackSupport();
  const player = useRef<HTMLVideoElement>(null);
  const [durationSeconds, setDurationSeconds] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [probing, setProbing] = useState(false);
  const trackLabel = media === undefined ? "影片" : mediaTrackLabel(media);
  const frameSeconds = mediaFrameSeconds(media);

  const seek = (): void => {
    const element = player.current;
    if (element === null || media === undefined) return;
    const target = mediaSeekSeconds(media);
    // 超過實際長度（例如檔案已變短）時夾到可播放範圍，避免 Range 416 迴圈。
    const limit = Number.isFinite(element.duration) && element.duration > 0 ? Math.max(0, element.duration - 0.25) : target;
    element.currentTime = Math.min(target, limit);
  };

  /** 播放失敗時用授權 HEAD 補上可讀原因（`<video>` 本身只有 error code）。 */
  const describePlaybackError = (): void => {
    setProbing(true);
    void probeMedia(rootId, entry.path)
      .then((probe) => {
        setError(probe.kind === "error"
          ? probe.message
          : "瀏覽器無法播放這個影片（可能是 H.264／AAC 以外的編碼或檔案損毀）。");
      })
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : "無法播放這個影片。");
      })
      .finally(() => setProbing(false));
  };

  return <div className="space-y-3 rounded-lg border border-line bg-white p-4">
    <p className="break-all font-medium text-ink">{entry.path}</p>
    {media !== undefined && (
      <p className="text-sm text-ink">
        命中片段：{trackLabel}　{formatMediaSpan(media.startSeconds, media.endSeconds)}
        {frameSeconds !== null ? `（取樣幀 ${formatMediaTime(frameSeconds)}）` : ""}
      </p>
    )}
    {media?.track === "video-audio" && (
      <p className="text-xs text-muted">這個命中的是影片的選定音軌（{media.streamIndex === undefined ? "stream 未知" : `stream ${media.streamIndex}`}）。</p>
    )}
    {error !== null && <p role="alert" className="text-sm text-red-600">{error}</p>}
    {probing && <p role="status" className="text-sm text-muted">正在確認播放失敗的原因…</p>}

    {support.kind === "desktop-only" ? (
      <div role="status" className="space-y-1 rounded-md border border-line bg-surface px-3 py-2 text-sm text-muted">
        <p className="font-medium text-ink">影片播放需要桌面版 App</p>
        <p>{support.message}</p>
      </div>
    ) : (
      <>
        <video
          ref={player}
          controls
          preload="metadata"
          src={mediaUrl(rootId, entry.path)}
          onLoadedMetadata={() => {
            const element = player.current;
            setDurationSeconds(element !== null && Number.isFinite(element.duration) ? element.duration : null);
            seek();
          }}
          onError={describePlaybackError}
          className="max-h-[50vh] w-full rounded-md bg-black"
          aria-label={entry.name}
        />
        {media !== undefined && (
          <button type="button" onClick={seek} className="rounded border border-line px-3 py-1 text-sm">
            跳到命中片段
          </button>
        )}
        <p className="text-xs text-muted">
          時長：{durationSeconds === null ? "待確認（播放器載入後顯示）" : `${formatMediaTime(durationSeconds)}（由播放器讀取）`}
        </p>
      </>
    )}

    <p className="text-xs text-muted">
      影片索引每 {VIDEO_SEGMENT_SECONDS} 秒抽 1 幀，命中時間代表片段時間，可能不是精確的事件位置；
      短暫畫面可能被抽樣略過。播放的是磁碟上目前的檔案，若檔案被修改，請重新索引後再對照命中。
    </p>
  </div>;
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
