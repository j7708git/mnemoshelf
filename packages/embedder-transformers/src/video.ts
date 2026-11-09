/**
 * 影片幀序列（`embedVideo`）的上限常數、結構驗證與 worker 計費輔助。
 *
 * **型別是 core 契約**：正式定義在 `@mnemoshelf/core` 的
 * `packages/core/src/ports/embedder.ts`（`VideoInput`／`VideoFrameInput`），由 core 的根
 * `index.ts` re-export（PM owner）。這裡以 **type-only** 方式引用並轉出，執行期**不會**
 * 載入 core 的根 entry——那會把 SQLite 等原生依賴拉進 embedder worker。
 *
 * **為什麼上限常數在兩邊各有一份**：core 也定義了 `MAX_VIDEO_FRAMES`／
 * `MAX_VIDEO_FRAME_EDGE`／`MAX_VIDEO_PIXELS`，但同樣的「不要 runtime import core 根 entry」
 * 理由讓本套件必須自行宣告數值；三者的數值**必須與 core 相同**。共用的 embedder 契約測試
 * 會要求 FakeEmbedder（用 core 常數）與本實作（用這裡的常數）拒絕同一組非法輸入，
 * 數值一漂移測試就會失敗。驗證邏輯（`assertVideoInput`）只有這一價，server worker 直接重用。
 */
import type { VideoFrameInput, VideoInput } from "@mnemoshelf/core";
import { EmbedderInputError } from "./errors.js";

export type { VideoFrameInput, VideoInput } from "@mnemoshelf/core";

/** 每段影片的影格數上限（與 core 的 `MAX_VIDEO_FRAMES` 相同；超過不得默默抽樣）。 */
export const MAX_VIDEO_FRAMES = 32;

/** 單一影格的邊長上限（與 core 的 `MAX_VIDEO_FRAME_EDGE` 相同；保護前處理與記憶體）。 */
export const MAX_VIDEO_FRAME_EDGE = 2048;

/** 一段影片所有影格的像素總數上限（與 core 的 `MAX_VIDEO_PIXELS` 相同；RGBA 最壞 32 MiB）。 */
export const MAX_VIDEO_PIXELS = 8_388_608;

/** 產生輸入類的「影片輸入不合法」錯誤（穩定錯誤碼見 docs/embedder-contract.md）。 */
function invalidVideoInput(message: string): EmbedderInputError {
  return new EmbedderInputError(message, { code: "invalid-video-input" });
}

/**
 * 驗證影片幀序列的結構（**在載入模型前**執行）。
 *
 * 規則（超出即拒絕，不截短、不抽樣、不補幀）：
 * - `frames` 必須是 1–32 幀；上游 processor 對超過 32 幀會**默默均勻抽樣**，
 *   本專案要求由呼叫端切段，因此這裡必須先擋下來。
 * - 每幀 `channels` 只能是 3（RGB）或 4（RGBA）；`pixels.length` 必須等於
 *   `width × height × channels`。
 * - `width`／`height` 是 1–2048 的整數；全部幀的像素總數 ≤ 8,388,608。
 * - `timestampSeconds` 是有限、非負秒數，且同一片段內**非遞減**（重複時間允許；
 *   VFR 或重複時間由解碼層負責，embedder 只驗證不矛盾）。
 * - 同一片段內所有幀的寬、高、通道數必須一致（一段影片就是一種影格尺寸）。
 *
 * 這一類失敗**與執行裝置無關**（重試同一份幀結果相同），以 `EmbedderInputError`、
 * 穩定錯誤碼 `invalid-video-input` 回報；core 會把它當成媒體輸入類失敗處理。
 */
export function assertVideoInput(video: VideoInput): void {
  const frames = video?.frames;
  if (!Array.isArray(frames) || frames.length === 0) throw invalidVideoInput("影片必須提供至少 1 幀");
  if (frames.length > MAX_VIDEO_FRAMES) {
    throw invalidVideoInput(`影片片段 ${frames.length} 幀超過上限 ${MAX_VIDEO_FRAMES}（不得默默抽樣）`);
  }
  const first = frames[0]!;
  let totalPixels = 0;
  let previousTimestamp = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index] as VideoFrameInput | null | undefined;
    if (frame === null || typeof frame !== "object") throw invalidVideoInput(`影片第 ${index} 幀不是物件`);
    const { pixels, width, height, channels, timestampSeconds } = frame;
    if (!Number.isInteger(width) || width < 1 || width > MAX_VIDEO_FRAME_EDGE ||
        !Number.isInteger(height) || height < 1 || height > MAX_VIDEO_FRAME_EDGE) {
      throw invalidVideoInput(`影片第 ${index} 幀尺寸 ${String(width)}×${String(height)} 不合法`);
    }
    if (channels !== 3 && channels !== 4) {
      throw invalidVideoInput(`影片第 ${index} 幀通道數 ${String(channels)} 不合法（只接受 RGB／RGBA）`);
    }
    if (!(pixels instanceof Uint8Array) || pixels.length !== width * height * channels) {
      throw invalidVideoInput(
        `影片第 ${index} 幀像素長度不符（期望 ${width * height * channels}，實際 ${String((pixels as Uint8Array | undefined)?.length)}）`,
      );
    }
    totalPixels += width * height;
    if (totalPixels > MAX_VIDEO_PIXELS) {
      throw invalidVideoInput(`影片片段像素總數超過上限 ${MAX_VIDEO_PIXELS}`);
    }
    if (typeof timestampSeconds !== "number" || !Number.isFinite(timestampSeconds) || timestampSeconds < 0) {
      throw invalidVideoInput(`影片第 ${index} 幀時間戳必須是有限非負秒數`);
    }
    if (timestampSeconds < previousTimestamp) {
      throw invalidVideoInput(`影片第 ${index} 幀時間戳遞減（同一片段內必須非遞減）`);
    }
    previousTimestamp = timestampSeconds;
    if (index > 0 && (width !== first.width || height !== first.height || channels !== first.channels)) {
      throw invalidVideoInput("同一影片片段內所有幀的寬、高與通道數必須一致");
    }
  }
}

/** 一段影片的像素位元組總數（worker 准入與 transfer 計費用；呼叫前必須先 `assertVideoInput`）。 */
export function videoInputBytes(video: VideoInput): number {
  let bytes = 0;
  for (const frame of video.frames) bytes += frame.pixels.byteLength;
  return bytes;
}
