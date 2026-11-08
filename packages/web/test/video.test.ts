/**
 * 影片 UI 純邏輯與 SSR 狀態測試（C2）。
 *
 * 播放本身需要 Electron（`webRequest` 注入授權＋Chromium 解碼），因此這裡只驗：
 * - 同源媒體網址、軌道標籤、時間與 seek 目標（只用伺服器回報的資料，不猜時長）；
 * - 能力三態 → 開關停用與可讀原因；
 * - 播放失敗的 HTTP 狀態對照（403／404／413／415／416）；
 * - SSR 下各元件的可見狀態（桌面／瀏覽器分流、影片命中標示、開關 disabled）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ChunkMedia, VideoCapability } from "../src/api";
import { fetchRoots, isVideoCapability, mediaPlaybackErrorMessage, mediaUrl, probeMedia } from "../src/api";
import { FilePreview } from "../src/FilePreview";
import { AddRootFlow } from "../src/AddRootFlow";
import { RootsList } from "../src/RootsList";
import {
  DESKTOP_ONLY_PLAYBACK_MESSAGE,
  describeMediaHit,
  describeVideoEntries,
  isVideoReason,
  mediaFrameSeconds,
  mediaSeekSeconds,
  mediaTrackLabel,
  videoPlaybackSupport,
  videoReasonLabel,
  videoToggleState,
  videoUnavailableReason,
} from "../src/media";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** 一個可用的能力摘要（測試預設值；只改需要的欄位）。 */
function capability(overrides: Partial<VideoCapability> = {}): VideoCapability {
  return {
    available: true,
    state: "available",
    reason: null,
    embedderVideo: true,
    maxFileBytes: 512 * 1024 * 1024,
    durationLimitSeconds: 600,
    ffmpegVersion: "n9.0.2",
    ffprobeVersion: "n9.0.2",
    ...overrides,
  };
}

/** 影片畫面命中（每 4 秒一段、每段 1 幀：4–8 秒片段、取樣幀 6 秒）。 */
function videoHit(overrides: Partial<ChunkMedia> = {}): ChunkMedia {
  return {
    startSeconds: 4,
    endSeconds: 8,
    track: "video",
    container: "mp4",
    frameTimesSeconds: [6],
    preprocessVersion: "video-1fps-4s-384-v1",
    embedderId: "fake-video",
    embeddingDim: 8,
    ...overrides,
  };
}

describe("影片播放路徑與時間", () => {
  it("媒體網址是同源端點且路徑參數有編碼（token 不進 URL）", () => {
    expect(mediaUrl(7, "clips/生日 & 派對.mp4")).toBe(
      "/roots/7/media?path=clips%2F%E7%94%9F%E6%97%A5%20%26%20%E6%B4%BE%E5%B0%8D.mp4",
    );
  });

  it("桌面版可播；瀏覽器版明確顯示需桌面版（不提供 token query）", () => {
    expect(videoPlaybackSupport(true)).toEqual({ kind: "available" });
    const browser = videoPlaybackSupport(false);
    expect(browser.kind).toBe("desktop-only");
    if (browser.kind === "desktop-only") {
      expect(browser.message).toBe(DESKTOP_ONLY_PLAYBACK_MESSAGE);
      expect(browser.message).toContain("桌面版");
      expect(browser.message).toContain("token 不會放進網址");
    }
  });

  it("畫面與音軌用 media.track 分辨（不是看 kind）", () => {
    expect(mediaTrackLabel(videoHit())).toBe("影片畫面");
    expect(mediaTrackLabel(videoHit({ track: "video-audio", frameTimesSeconds: undefined, streamIndex: 1 }))).toBe("影片音軌");
    expect(mediaTrackLabel(videoHit({ track: "audio", container: "wav", frameTimesSeconds: undefined }))).toBe("音訊片段");
    expect(mediaTrackLabel(undefined)).toBe("檔案");
  });

  it("命中描述含區間時間；畫面另有取樣幀時間", () => {
    expect(describeMediaHit(videoHit())).toBe("影片畫面 0:04.0–0:08.0（取樣幀 0:06.0）");
    expect(describeMediaHit(videoHit({ track: "video-audio", frameTimesSeconds: undefined, streamIndex: 1 }))).toBe(
      "影片音軌 0:04.0–0:08.0",
    );
  });

  it("seek 目標優先用取樣幀時間，其次片段起點；非法值不產生 NaN", () => {
    expect(mediaSeekSeconds(videoHit())).toBe(6);
    expect(mediaSeekSeconds(videoHit({ frameTimesSeconds: undefined }))).toBe(4);
    expect(mediaFrameSeconds(videoHit({ frameTimesSeconds: [] }))).toBeNull();
    expect(mediaSeekSeconds(videoHit({ frameTimesSeconds: undefined, startSeconds: -1 }))).toBe(0);
  });

  it("播放失敗的 HTTP 狀態有可讀訊息（403／404／413／415／416）", () => {
    expect(mediaPlaybackErrorMessage(403, "x")).toContain("沒有權限");
    expect(mediaPlaybackErrorMessage(404, "x")).toContain("不存在");
    expect(mediaPlaybackErrorMessage(413, "x", 512 * 1024 * 1024)).toBe(
      "影片超過單檔大小上限（目前上限 512 MiB），不支援播放。",
    );
    expect(mediaPlaybackErrorMessage(415, "x")).toContain(".mp4");
    expect(mediaPlaybackErrorMessage(416, "x")).toContain("位元組範圍");
    expect(mediaPlaybackErrorMessage(400, "x")).toContain("路徑不合法");
  });
});

describe("影片能力與開關狀態", () => {
  it("available 時可開，摘要含上限與解碼器版本", () => {
    const state = videoToggleState(capability());
    expect(state.enabled).toBe(true);
    expect(state.reason).toBeNull();
    expect(state.summary).toContain("n9.0.2");
    expect(state.summary).toContain("600");
    expect(state.summary).toContain("512 MiB");
  });

  it("disabled（沒設定 decoder）與 unavailable（壞掉／embedder 不支援）分開說明", () => {
    const disabled = videoToggleState(capability({ available: false, state: "disabled", ffmpegVersion: null, ffprobeVersion: null }));
    expect(disabled.enabled).toBe(false);
    expect(disabled.reason).toContain("沒有設定影片解碼器");

    const missing = videoToggleState(capability({ available: false, state: "unavailable", reason: "missing-ffmpeg", ffmpegVersion: null }));
    expect(missing.enabled).toBe(false);
    expect(missing.reason).toContain("ffmpeg");

    const embedder = videoToggleState(capability({ available: false, state: "unavailable", reason: "embedder-video-unsupported" }));
    expect(embedder.reason).toContain("嵌入模型不支援影片");
  });

  it("舊版服務沒回報能力時停用並說明（不假設可用）", () => {
    const state = videoToggleState(null);
    expect(state.enabled).toBe(false);
    expect(state.reason).toContain("沒有回報影片能力");
    expect(videoUnavailableReason(null)).toBe(state.reason);
  });

  it("影片原因碼有中文說明且可辨識", () => {
    expect(isVideoReason("video-too-large")).toBe(true);
    expect(isVideoReason("modality-off")).toBe(false);
    expect(videoReasonLabel("unsupported-video-codec")).toContain("H.264");
    expect(videoReasonLabel("custom-code")).toBe("custom-code");
  });

  it("索引結果的影片失敗／跳過清單只列影片原因並附中文說明", () => {
    expect(describeVideoEntries([
      { relPath: "a.mp4", reason: "video-duration-exceeded" },
      { relPath: "b.txt", reason: "binary-content" },
      { relPath: "c.mp4", reason: "unsupported-video-audio-track" },
    ])).toBe("a.mp4（超過影片時長上限（600 秒））、c.mp4（影片音軌不支援（已開啟音軌時整檔跳過））");
    expect(describeVideoEntries([])).toBe("");
  });
});

describe("API 層：影片能力與 HEAD 探測", () => {
  it("fetchRoots 解析 additive video 欄位；不符合形狀時視為 null", async () => {
    vi.stubGlobal("sessionStorage", { getItem: () => "fixture" });
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ roots: [], video: capability() }))
      .mockResolvedValueOnce(Response.json({ roots: [], video: { available: "yes" } }));
    vi.stubGlobal("fetch", fetch);
    expect((await fetchRoots()).video?.state).toBe("available");
    expect((await fetchRoots()).video).toBeNull();
    expect(isVideoCapability(undefined)).toBe(false);
  });

  it("probeMedia 用 HEAD＋授權標頭，回報大小與 Accept-Ranges", async () => {
    vi.stubGlobal("sessionStorage", { getItem: () => "fixture" });
    const fetch = vi.fn().mockResolvedValue(new Response(null, {
      status: 200,
      headers: { "content-length": "1048576", "accept-ranges": "bytes" },
    }));
    vi.stubGlobal("fetch", fetch);
    const probe = await probeMedia(3, "a b.mp4");
    expect(probe).toEqual({ kind: "ok", contentLength: 1048576, acceptRanges: true });
    expect(fetch.mock.calls[0][0]).toBe("/roots/3/media?path=a%20b.mp4");
    expect(fetch.mock.calls[0][1].method).toBe("HEAD");
    expect(fetch.mock.calls[0][1].headers.get("authorization")).toBe("Bearer fixture");
  });

  it("probeMedia 把 416／413 轉成可讀錯誤（播放器 error 事件補救）", async () => {
    vi.stubGlobal("sessionStorage", { getItem: () => "fixture" });
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: { message: "range" } }, { status: 416 }))
      .mockResolvedValueOnce(Response.json({ error: { message: "too large" } }, { status: 413 }));
    vi.stubGlobal("fetch", fetch);
    const range = await probeMedia(1, "x.mp4");
    expect(range.kind).toBe("error");
    if (range.kind === "error") expect(range.message).toContain("位元組範圍");
    const large = await probeMedia(1, "x.mp4");
    if (large.kind === "error") expect(large.message).toContain("上限");
  });
});

describe("SSR：影片預覽與開關狀態", () => {
  it("瀏覽器模式顯示需桌面版，不渲染播放器；仍顯示命中時間", () => {
    const html = renderToStaticMarkup(createElement(FilePreview, {
      rootId: 1,
      entry: { kind: "video", name: "clip.mp4", path: "clip.mp4", size: null, mimeType: null },
      media: videoHit(),
    }));
    expect(html).toContain("影片播放需要桌面版 App");
    expect(html).toContain("0:04.0–0:08.0");
    expect(html).toContain("取樣幀 0:06.0");
    expect(html).not.toContain("<video");
    expect(html).not.toContain("token=");
  });

  it("影片音軌命中（kind audio）走影片預覽而不是 WAV blob 錯誤", () => {
    const html = renderToStaticMarkup(createElement(FilePreview, {
      rootId: 1,
      entry: { kind: "audio", name: "clip.mp4", path: "clip.mp4", size: null, mimeType: null },
      media: videoHit({ track: "video-audio", frameTimesSeconds: undefined, streamIndex: 2 }),
    }));
    expect(html).toContain("影片音軌");
    expect(html).toContain("stream 2");
    expect(html).not.toContain("音訊語意索引不產生逐字稿");
  });

  it("既有 root 的影片開關：已開啟時勾選，能力不可用時停用並顯示原因", () => {
    const root = { id: 1, path: "fixture", mode: "index" as const, modalities: ["text", "video"], include: [], exclude: [], respectGitignore: true, watch: false, createdAt: "2026-11-08" };
    const html = renderToStaticMarkup(createElement(RootsList, {
      roots: [root],
      selectedRootId: 1,
      onSelect: () => {},
      onRemove: () => {},
      onToggleVideo: () => {},
      videoCapability: capability({ available: false, state: "unavailable", reason: "missing-ffmpeg" }),
      imagesBusyRootId: null,
    }));
    expect(html).toContain("含影片 .mp4");
    expect(html).toContain("ffmpeg");
    expect(html).toContain('disabled=""');
    expect(html).toContain('checked=""');
  });

  it("加入資料夾流程：能力 unavailable 時影片開關停用並顯示原因", () => {
    const html = renderToStaticMarkup(createElement(AddRootFlow, {
      onCancel: () => {},
      onDone: () => {},
      videoCapability: capability({ available: false, state: "unavailable", reason: "ffprobe-failed" }),
    }));
    expect(html).toContain("含影片");
    expect(html).toContain("影片解碼器無法執行");
    expect(html).toContain('disabled=""');
  });
});
