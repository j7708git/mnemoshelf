/**
 * 檔案預覽：文字 JSON、圖片、音訊（fetch＋blob URL）與影片（同源 Range 播放）。
 *
 * 圖片與音訊一律 `fetch`＋`URL.createObjectURL`（`<img src>`／`<audio src>` 帶不了
 * `Authorization`），且在不再使用時 `URL.revokeObjectURL`（否則 blob 會累積）。
 * **影片不走 blob**：桌面版與瀏覽器都先取得短效同源授權，再以 HttpOnly cookie
 * 支援 Range 串流播放；token 不進 URL，也不整檔下載。
 */
import { useEffect, useState, useRef } from "react";
import {
  fetchAudioBlobUrl,
  fetchImageBlobUrl,
  createMediaPlaybackSession,
  revokeMediaPlaybackSession,
  probeMediaPlaybackSession,
  type MediaPlaybackSession,
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
} from "./media";

/** 計算 UTF-8 位元組數用；模組層共用一個即可。 */
const utf8Encoder = new TextEncoder();

/** 檔案預覽的容器：依型別分派。`key` 由呼叫端以路徑設定，切換檔案時整個重掛載。 */
export function FilePreview({ rootId, entry, media, sourceChunkId }: { rootId: number; entry: DirEntry; media?: ChunkMedia; sourceChunkId?: number }) {
  if (entry.kind === "text" || entry.kind === "code") {
    return <TextFilePreview rootId={rootId} entry={entry} />;
  }
  if (entry.kind === "image") {
    return <ImageFilePreview rootId={rootId} entry={entry} />;
  }
  // 影片音軌命中（kind:"audio"、track:"video-audio"）要開影片播放器並定位：
  // 來源是 .mp4，不能走 WAV 的 blob 端點（伺服器會以非 WAV 拒絕）。
  if (entry.kind === "video" || media?.track === "video" || media?.track === "video-audio") {
    return <VideoFilePreview rootId={rootId} entry={entry} media={media} sourceChunkId={sourceChunkId} />;
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
 * 影片預覽與播放（桌面版及 standalone 共用短效同源 Range 授權）。
 *
 * 設計要點：
 * - **不整檔下載**：`<video src>` 使用授權回傳的 locator，由瀏覽器自己發 Range 請求。
 * - **瀏覽器模式**：由精確 Path 的 HttpOnly cookie 授權，只有 locator 進 URL。
 * - **定位**：有命中片段時，載入 metadata 後 seek 到實際取樣幀時間（畫面）或片段起點（音軌），
 *   另提供「跳到命中片段」按鈕；只用伺服器回報的時間，不自行推算事件位置。
 * - **錯誤可讀**：`<video>` 的 error 事件拿不到 HTTP 狀態，失敗時以授權 HEAD 探測端點，
 *   區分 403（root／權限）、404、413（大小上限）、415（非 mp4）、416（Range）與解碼失敗。
 * - **時長**：預覽階段不假設時長；播放器載入後才顯示實際值（由檔案讀出，不是捏造）。
 */
function VideoFilePreview({ rootId, entry, media, sourceChunkId }: { rootId: number; entry: DirEntry; media?: ChunkMedia; sourceChunkId?: number }) {
  const player = useRef<HTMLVideoElement>(null);
  const playbackGeneration = useRef(0);
  const [session, setSession] = useState<MediaPlaybackSession | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [durationSeconds, setDurationSeconds] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [probing, setProbing] = useState(false);
  const trackLabel = media === undefined ? "影片" : mediaTrackLabel(media);
  const frameSeconds = mediaFrameSeconds(media);

  useEffect(() => {
    playbackGeneration.current++;
    let cancelled = false;
    let created: MediaPlaybackSession | null = null;
    let expiry: ReturnType<typeof setTimeout> | undefined;
    let monitor: ReturnType<typeof setInterval> | undefined;
    let checking = false;
    setSession(null);
    setError(null);
    setDurationSeconds(null);
    setProbing(false);
    // 舊服務或缺來源身分的命中不得偷偷退回「播放目前檔案」。
    if (media !== undefined && (!Number.isSafeInteger(sourceChunkId) || sourceChunkId! <= 0)) {
      setError("此命中缺少來源身分；請重新搜尋後播放。");
      return;
    }
    void createMediaPlaybackSession(rootId, entry.path, sourceChunkId).then((value) => {
      if (cancelled) { void revokeMediaPlaybackSession(value).catch(() => undefined); return; }
      created = value;
      setSession(value);
      expiry = setTimeout(() => {
        player.current?.pause();
        setSession(null);
        setError("播放授權已逾期，請重新授權播放。");
      }, Math.max(0, Date.parse(value.expiresAt) - Date.now()));
      // 即使短片已全部緩衝，來源變更／撤銷仍要提示，不能只等下一個 Range。
      monitor = setInterval(() => {
        if (checking) return;
        checking = true;
        void probeMediaPlaybackSession(value).then((probe) => {
          if (!cancelled && probe.kind === "error") {
            player.current?.pause();
            setError(probe.message);
            clearInterval(monitor);
          }
        }).catch(() => {
          if (!cancelled) { player.current?.pause(); setError("無法確認影片來源；請重新授權播放。"); clearInterval(monitor); }
        }).finally(() => { checking = false; });
      }, 5000);
    }).catch((reason: unknown) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : "建立播放授權失敗。");
    });
    return () => {
      playbackGeneration.current++;
      cancelled = true;
      clearTimeout(expiry);
      clearInterval(monitor);
      if (created !== null) void revokeMediaPlaybackSession(created).catch(() => undefined);
    };
  }, [rootId, entry.path, sourceChunkId, media, attempt]);

  const seek = (): void => {
    const element = player.current;
    if (element === null || media === undefined || session === null || error !== null) return;
    const target = mediaSeekSeconds(media);
    // 超過實際長度（例如檔案已變短）時夾到可播放範圍，避免 Range 416 迴圈。
    const limit = Number.isFinite(element.duration) && element.duration > 0 ? Math.max(0, element.duration - 0.25) : target;
    element.currentTime = Math.min(target, limit);
  };

  /** 播放失敗時用授權 HEAD 補上可讀原因（`<video>` 本身只有 error code）。 */
  const describePlaybackError = (): void => {
    if (session === null) return;
    const generation = playbackGeneration.current;
    setProbing(true);
    void probeMediaPlaybackSession(session)
      .then((probe) => {
        if (generation !== playbackGeneration.current) return;
        setError(probe.kind === "error"
          ? probe.message
          : "瀏覽器無法播放這個影片（可能是 H.264／AAC 以外的編碼或檔案損毀）。");
      })
      .catch((reason: unknown) => {
        if (generation !== playbackGeneration.current) return;
        setError(reason instanceof Error ? reason.message : "無法播放這個影片。");
      })
      .finally(() => { if (generation === playbackGeneration.current) setProbing(false); });
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

    {session === null && error === null && <p role="status">正在驗證影片來源與播放授權…</p>}
    {error !== null && <button type="button" onClick={() => {
      // 點擊時就使舊 HEAD 失效，不等下一次 effect cleanup 才擋掉延遲回應。
      playbackGeneration.current++;
      setAttempt((value) => value + 1);
    }} className="rounded border border-line px-3 py-1 text-sm">重新授權播放</button>}
    {session !== null && error === null && (
      <>
        <video
          ref={player}
          controls
          preload="metadata"
          src={session.url}
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
      短暫畫面可能被抽樣略過。播放綁定已驗證的來源版本；來源變更時，請重新索引並重新搜尋。
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
