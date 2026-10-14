/**
 * REST 的授權與來源檢查。
 *
 * - 服務只綁 `127.0.0.1`（`config.LOOPBACK_HOST`；不接受設定成外部位址）。
 * - 所有寫入與讀取端點（`/health` 除外）都要帶 `Authorization: Bearer <MNEMOSHELF_TOKEN>`。
 * - token 比對用 `crypto.timingSafeEqual` 比對 SHA-256 摘要，長度不固定也不會洩漏長度。
 * - `Host` header 只接受本機位址（DNS rebinding 的緩解；見 `docs/roots-and-privacy.md`）。
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { InvalidHostError, NonLoopbackRequestError, UnauthorizedError } from "../errors.js";

/** 不需要 token 的端點（探活用）。 */
export const PUBLIC_PATHS = ["/health"] as const;

/** 取出 `Authorization: Bearer <token>` 的 token；沒有或格式不符時回傳 null。 */
export function parseBearerToken(header: string | string[] | undefined): string | null {
  const raw = Array.isArray(header) ? header[0] : header;
  if (raw === undefined) return null;
  const match = /^Bearer[ ]+(.+)$/i.exec(raw.trim());
  if (match === null) return null;
  const token = match[1]!.trim();
  return token.length === 0 ? null : token;
}

/** 固定時間比對兩個 token（先各自 SHA-256，長度即固定）。 */
export function tokensMatch(provided: string, expected: string): boolean {
  const a = createHash("sha256").update(provided, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

/** 檢查請求帶的 token；不符時丟 `UnauthorizedError`。 */
export function requireToken(request: IncomingMessage, expected: string): void {
  const provided = parseBearerToken(request.headers.authorization);
  if (provided === null || !tokensMatch(provided, expected)) throw new UnauthorizedError();
}

/** 位址是否為 loopback（IPv4／IPv6／IPv4-mapped）。 */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined) return false;
  const normalized = address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;
  return normalized === "127.0.0.1" || normalized === "::1" || normalized.startsWith("127.");
}

/**
 * 服務只綁 loopback，這裡再檢查一次連線來源（縱深防禦：萬一被反代或轉發進來）。
 * 非 loopback 丟 `NonLoopbackRequestError`。
 */
export function requireLoopback(request: IncomingMessage): void {
  if (!isLoopbackAddress(request.socket.remoteAddress)) throw new NonLoopbackRequestError();
}

/**
 * `Host` header 是否是本機位址。
 *
 * 只接受 `127.0.0.1`／`localhost`／`[::1]`，可帶埠號（例如 `127.0.0.1:8787`）。
 * 為什麼需要：服務綁在 loopback 仍會被使用者瀏覽到的惡意網頁以 **DNS rebinding** 打進來，
 * 標準緩解是驗證 `Host`（`requireLoopback` 只看連線來源 IP，擋不住）。
 */
export function isLocalHostHeader(host: string | undefined): boolean {
  if (typeof host !== "string") return false;
  const value = host.trim().toLowerCase();
  if (value === "") return false;

  // IPv6 字面值：`[::1]` 或 `[::1]:port`。
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    if (end === -1) return false;
    if (value.slice(1, end) !== "::1") return false;
    const rest = value.slice(end + 1);
    return rest === "" || /^:\d+$/.test(rest);
  }

  // 主機名稱或 IPv4：`host` 或 `host:port`。
  const colon = value.indexOf(":");
  const name = colon === -1 ? value : value.slice(0, colon);
  const port = colon === -1 ? "" : value.slice(colon + 1);
  if (port !== "" && !/^\d+$/.test(port)) return false;
  return name === "127.0.0.1" || name === "localhost";
}

/** 檢查 `Host` header；不是本機位址時丟 `InvalidHostError`（403）。 */
export function requireLocalHost(request: IncomingMessage): void {
  if (!isLocalHostHeader(request.headers.host)) throw new InvalidHostError();
}
