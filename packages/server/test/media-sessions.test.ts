import type { IncomingMessage } from "node:http";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MEDIA_SESSION_LIMIT, MEDIA_SESSION_TTL_MS, MediaSessions, requireMediaOrigin } from "../src/http/media-sessions.js";

const input = { rootId: 7, relPath: "clip.mp4", version: "fixture-version", origin: "http://localhost:8787" };
function request(cookie: string, headers: Record<string, string> = {}): IncomingMessage {
  return { headers: { host: "localhost:8787", "sec-fetch-site": "same-origin", cookie, ...headers } } as IncomingMessage;
}
function issued(sessions: MediaSessions) {
  const grant = sessions.create(input);
  return { ...grant, id: grant.url.split("/").at(-1)!, cookie: grant.cookie.split(";")[0]! };
}
afterEach(() => { vi.useRealTimers(); });

describe("短效播放授權", () => {
  it("locator 不是 secret；cookie 及同源來源缺一不可，root/port 不可跨用", () => {
    const sessions = new MediaSessions();
    const grant = issued(sessions);
    expect(grant.url).not.toContain(grant.cookie.split("=")[1]!);
    expect(sessions.authorize(grant.id, 7, request(grant.cookie)).relPath).toBe("clip.mp4");
    expect(() => sessions.authorize(grant.id, 7, request(""))).toThrow();
    expect(() => sessions.authorize(grant.id, 8, request(grant.cookie))).toThrow();
    expect(() => sessions.authorize(grant.id, 7, request(grant.cookie, { host: "localhost:8788" }))).toThrow();
    for (const site of ["cross-site", "same-site", "none", ""]) {
      expect(() => requireMediaOrigin(request(grant.cookie, { "sec-fetch-site": site }))).toThrow();
    }
    expect(() => requireMediaOrigin(request(grant.cookie, { origin: "http://localhost:8788" }))).toThrow();
    expect(requireMediaOrigin(request(grant.cookie, { origin: input.origin }))).toBe(input.origin);
    expect(() => sessions.authorize(grant.id, 7, request(`${grant.cookie}; ${grant.cookie}`))).toThrow();
    sessions.close();
  });

  it("root 撤銷中止該 root 的連線，不影響其他 root", () => {
    const sessions = new MediaSessions();
    const first = issued(sessions);
    const second = sessions.create({ ...input, rootId: 8 });
    const stream = new PassThrough();
    sessions.track(first.id, stream);
    sessions.revokeRoot(7);
    expect(stream.destroyed).toBe(true);
    expect(() => sessions.authorize(first.id, 7, request(first.cookie))).toThrow();
    expect(sessions.authorize(second.url.split("/").at(-1)!, 8, request(second.cookie.split(";")[0]!)).rootId).toBe(8);
    sessions.close();
  });

  it("撤銷及 TTL 會拒絕續傳並終止活動串流，驗證期間逾期也不交出串流", async () => {
    vi.useFakeTimers();
    const sessions = new MediaSessions();
    const revoked = issued(sessions);
    const stream = new PassThrough();
    sessions.track(revoked.id, stream);
    sessions.revoke(revoked.id);
    expect(stream.destroyed).toBe(true);
    expect(() => sessions.authorize(revoked.id, 7, request(revoked.cookie))).toThrow();
    const expired = issued(sessions);
    const active = new PassThrough();
    sessions.track(expired.id, active);
    await vi.advanceTimersByTimeAsync(MEDIA_SESSION_TTL_MS);
    expect(active.destroyed).toBe(true);
    expect(() => sessions.authorize(expired.id, 7, request(expired.cookie))).toThrow();
    const late = new PassThrough();
    expect(() => sessions.track(expired.id, late)).toThrow();
    expect(late.destroyed).toBe(true);
    sessions.close();
  });

  it("session/活動串流有界；close 回收全部，過期空 session 可重新取得容量", async () => {
    vi.useFakeTimers();
    const sessions = new MediaSessions();
    const first = issued(sessions);
    const streams = Array.from({ length: 4 }, () => new PassThrough());
    streams.forEach((stream) => sessions.track(first.id, stream));
    const extra = new PassThrough();
    expect(() => sessions.track(first.id, extra)).toThrow();
    expect(extra.destroyed).toBe(true);
    sessions.track(first.id, null);
    for (let i = 1; i < MEDIA_SESSION_LIMIT; i++) sessions.create(input);
    expect(() => sessions.create(input)).toThrow();
    sessions.close();
    expect(streams.every((stream) => stream.destroyed)).toBe(true);
    for (let i = 0; i < MEDIA_SESSION_LIMIT; i++) sessions.create(input);
    await vi.advanceTimersByTimeAsync(MEDIA_SESSION_TTL_MS);
    expect(() => sessions.create(input)).not.toThrow();
    sessions.close();
  });
});
