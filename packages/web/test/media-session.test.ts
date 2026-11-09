import { afterEach, describe, expect, it, vi } from "vitest";
import { clearToken, createMediaPlaybackSession, mediaPlaybackErrorMessage, probeMediaPlaybackSession, revokeMediaPlaybackSession } from "../src/api";

const session = { url: "/roots/3/media-sessions/00000000-0000-4000-8000-000000000000", expiresAt: "2026-11-09T12:00:00Z" };
afterEach(() => { vi.unstubAllGlobals(); });

describe("播放器短效授權 API", () => {
  it("登出時以原授權撤銷活動 session，再移除登入憑證", async () => {
    const removeItem = vi.fn();
    vi.stubGlobal("sessionStorage", { getItem: () => "synthetic-fixture", removeItem });
    const fetch = vi.fn().mockResolvedValueOnce(Response.json(session, { status: 201 })).mockResolvedValue(new Response(null));
    vi.stubGlobal("fetch", fetch);
    await createMediaPlaybackSession(3, "clip.mp4");
    clearToken();
    expect(fetch.mock.calls[1]![0]).toBe(session.url);
    expect(fetch.mock.calls[1]![1].headers.authorization).toBe("Bearer synthetic-fixture");
    expect(removeItem).toHaveBeenCalled();
  });
  it("Bearer 只放 header，chunk 身分只放 body，播放器取得同源 locator", async () => {
    vi.stubGlobal("sessionStorage", { getItem: () => "synthetic-fixture" });
    const fetch = vi.fn().mockResolvedValue(Response.json(session, { status: 201 }));
    vi.stubGlobal("fetch", fetch);
    expect(await createMediaPlaybackSession(3, "clip.mp4", 17)).toEqual(session);
    expect(fetch.mock.calls[0]![0]).toBe("/roots/3/media-sessions");
    const options = fetch.mock.calls[0]![1] as RequestInit;
    expect(new Headers(options.headers).get("authorization")).toBe("Bearer synthetic-fixture");
    expect(JSON.parse(options.body as string)).toEqual({ path: "clip.mp4", chunkId: 17 });
    expect(options.credentials).toBe("same-origin");
    await revokeMediaPlaybackSession(session);
    expect(fetch.mock.calls[1]![0]).toBe(session.url);
    expect(fetch.mock.calls[1]![1].method).toBe("DELETE");
  });

  it("不接受跨來源 locator；409 提示重建，不悄悄改播當下內容", async () => {
    vi.stubGlobal("sessionStorage", { getItem: () => "synthetic-fixture" });
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ ...session, url: "https://example.invalid/clip" }))
      .mockResolvedValueOnce(Response.json({ error: { message: "source changed" } }, { status: 409 }));
    vi.stubGlobal("fetch", fetch);
    await expect(createMediaPlaybackSession(3, "clip.mp4")).rejects.toThrow("不合法");
    await expect(createMediaPlaybackSession(3, "clip.mp4", 17)).rejects.toThrow("重新索引");
    expect(mediaPlaybackErrorMessage(409, "fallback")).toContain("重新搜尋");
  });

  it("session 401 只提示重授權，不清除全域 Bearer；HEAD 成功可取得 Range 支援", async () => {
    const removeItem = vi.fn();
    vi.stubGlobal("sessionStorage", { getItem: () => "synthetic-fixture", removeItem });
    const fetch = vi.fn().mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(null, { headers: { "content-length": "32", "accept-ranges": "bytes" } }));
    vi.stubGlobal("fetch", fetch);
    expect(await probeMediaPlaybackSession(session)).toMatchObject({ kind: "error", status: 401, message: expect.stringContaining("逾期或撤銷") });
    expect(removeItem).not.toHaveBeenCalled();
    expect(await probeMediaPlaybackSession(session)).toEqual({ kind: "ok", contentLength: 32, acceptRanges: true });
    expect(fetch.mock.calls[0]![1].headers).toBeUndefined();
  });
});
