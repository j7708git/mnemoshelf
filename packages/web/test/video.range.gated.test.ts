/**
 * gated 整合測試：真 `GET /roots/:id/media` 的 Range 契約（桌面播放器用的同一條路徑）。
 *
 * **需要環境變數**（CI 與一般 `pnpm test` 不會跑，也不依賴 fixture）：
 * - `MNEMOSHELF_VIDEO_RANGE_URL`：完整 URL，例如
 *   `http://127.0.0.1:<port>/roots/1/media?path=clip.mp4`（只放測試機／本機位址）；
 * - `MNEMOSHELF_VIDEO_RANGE_TOKEN`：該服務的 Bearer token。
 *
 * 驗的是播放器實際依賴的語意：206＋Content-Range、416＋`Content-Range: bytes *／size`（全形斜線避免關閉註解）、無 token 401。
 * 真正的 `<video>` 解碼／seek 需要 Electron GUI，於 C3／D 的 packaged UI 驗收。
 */
import { describe, expect, it } from "vitest";

const mediaEndpoint = process.env.MNEMOSHELF_VIDEO_RANGE_URL;
const mediaToken = process.env.MNEMOSHELF_VIDEO_RANGE_TOKEN;
const configured = mediaEndpoint !== undefined && mediaEndpoint.trim() !== "" &&
  mediaToken !== undefined && mediaToken.trim() !== "";

describe.skipIf(!configured)("真 Range 端點（gated）", () => {
  it("206 單一範圍、416 越界、無 token 401（播放器契約）", async () => {
    const url = mediaEndpoint!;
    const authorization = { authorization: "Bearer " + mediaToken };

    const partial = await fetch(url, { headers: { ...authorization, range: "bytes=0-1023" } });
    expect(partial.status).toBe(206);
    expect(partial.headers.get("content-range")).toMatch(/^bytes 0-1023\/\d+$/);
    expect(partial.headers.get("accept-ranges")).toBe("bytes");
    await partial.body?.cancel();

    const beyond = await fetch(url, { headers: { ...authorization, range: "bytes=999999999999-" } });
    expect(beyond.status).toBe(416);
    expect(beyond.headers.get("content-range")).toMatch(/^bytes \*\/\d+$/);
    await beyond.body?.cancel();

    const anonymous = await fetch(url, { headers: { range: "bytes=0-1" } });
    expect(anonymous.status).toBe(401);
    await anonymous.body?.cancel();
  });
});
