/** 短效、單一來源的播放授權；locator 不是憑證，secret 只透過 HttpOnly cookie 傳送。 */
import { randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Readable } from "node:stream";
import { UnauthorizedError, ValidationError } from "../errors.js";
import { tokensMatch } from "./auth.js";

export const MEDIA_SESSION_TTL_MS = 15 * 60 * 1000;
export const MEDIA_SESSION_LIMIT = 128;
const COOKIE_NAME = "mnemoshelf_media";

export class MediaOriginError extends Error {
  constructor() { super("播放授權只接受同源請求。"); this.name = "MediaOriginError"; }
}

/** Cookie 不隔離 port；必須同時檢查瀏覽器不可由 JS 偽造的來源標頭。 */
export function requireMediaOrigin(request: IncomingMessage): string {
  const origin = `http://${request.headers.host}`;
  if (request.headers["sec-fetch-site"] !== "same-origin" ||
      (request.headers.origin !== undefined && request.headers.origin !== origin)) throw new MediaOriginError();
  return origin;
}

interface MediaSession {
  rootId: number;
  relPath: string;
  version: string;
  origin: string;
  expiresAt: number;
  secret: string;
  streams: Set<Readable>;
}

/** 每個 REST app 各自擁有；只留記憶體、容量有界、重啟即失效。 */
export class MediaSessions {
  private readonly sessions = new Map<string, MediaSession>();

  create(input: Pick<MediaSession, "rootId" | "relPath" | "version" | "origin">): { url: string; expiresAt: string; cookie: string } {
    for (const [id, session] of this.sessions) if (session.expiresAt <= Date.now()) this.revoke(id);
    if (this.sessions.size >= MEDIA_SESSION_LIMIT) throw new ValidationError("media", "播放授權數量已達上限，請關閉其他預覽或稍後再試。");
    const id = randomUUID();
    const secret = randomBytes(32).toString("base64url");
    const expiresAt = Date.now() + MEDIA_SESSION_TTL_MS;
    const url = `/roots/${input.rootId}/media-sessions/${id}`;
    this.sessions.set(id, { ...input, secret, expiresAt, streams: new Set() });
    return { url, expiresAt: new Date(expiresAt).toISOString(), cookie: `${COOKIE_NAME}=${secret}; HttpOnly; SameSite=Strict; Path=${url}; Max-Age=${MEDIA_SESSION_TTL_MS / 1000}` };
  }

  authorize(id: string, rootId: number, request: IncomingMessage): MediaSession {
    const origin = requireMediaOrigin(request);
    const session = this.sessions.get(id);
    if (session === undefined || session.rootId !== rootId || session.origin !== origin) throw new UnauthorizedError();
    if (session.expiresAt <= Date.now()) { this.revoke(id); throw new UnauthorizedError(); }
    const values = (request.headers.cookie ?? "").split(";").map((part) => part.trim()).filter((part) => part.startsWith(`${COOKIE_NAME}=`));
    if (values.length !== 1 || !tokensMatch(values[0]!.slice(COOKIE_NAME.length + 1), session.secret)) throw new UnauthorizedError();
    return session;
  }

  /** 在 await 檔案驗證之後再檢查，避免撤銷／逾期競態交出新串流。 */
  track(id: string, stream: Readable | null): void {
    const session = this.sessions.get(id);
    if (session === undefined || session.expiresAt <= Date.now()) {
      stream?.destroy();
      this.revoke(id);
      throw new UnauthorizedError();
    }
    if (stream === null) return;
    if (session.streams.size >= 4) { stream.destroy(); throw new ValidationError("media", "同一影片的播放連線過多。"); }
    session.streams.add(stream);
    const timer = setTimeout(() => this.revoke(id), session.expiresAt - Date.now());
    timer.unref();
    stream.once("close", () => { clearTimeout(timer); session.streams.delete(stream); });
  }

  revoke(id: string): void {
    const session = this.sessions.get(id);
    this.sessions.delete(id);
    for (const stream of session?.streams ?? []) stream.destroy();
  }

  /** root 移除或設定改動時，既有播放連線立即失效。 */
  revokeRoot(rootId: number): void {
    for (const [id, session] of this.sessions) if (session.rootId === rootId) this.revoke(id);
  }

  close(): void {
    for (const id of this.sessions.keys()) this.revoke(id);
  }
}
