/**
 * 桌面殼的影片解碼器（ffmpeg／ffprobe）binary 定位（純函式，可單獨測試）。
 *
 * 為什麼需要這一層：Core 服務只認得環境變數（`MNEMOSHELF_FFMPEG_DIR` 或成對的
 * `MNEMOSHELF_FFMPEG_PATH`／`MNEMOSHELF_FFPROBE_PATH`），而打包版把 binary 放在
 * `resources/bin`（asar 之外，見 C3／A1 的 spawn 限制）。主程序在 `createServer()` 前
 * 解析一次並以環境變數交給服務；**不改 electron-builder 或發版流程**（C3 決定配送方式）。
 *
 * 順序（明確、可預測）：
 * 1. 環境變數已設定 → **不覆寫**（使用者／CI 明確指定優先；配對錯誤由 server 拒絕啟動）。
 * 2. 打包版 → `<resourcesPath>/bin/ffmpeg(.exe)` 與 `ffprobe(.exe)` 都存在才採用。
 * 3. 開發版 → 呼叫端提供的候選目錄（例如 code repo `.tmp/video-a/decoder/...`）；
 *    **只在兩支檔案都存在時**才採用，不寫死任何本機路徑或版本目錄。
 * 4. 都沒有 → `null`（不設定環境變數；服務照常啟動，影片能力回 disabled）。
 */
import path from "node:path";

/** 一對解碼器執行檔（絕對路徑）。 */
export interface MediaDecoderBinaries {
  ffmpegPath: string;
  ffprobePath: string;
}

/** 解碼器來源（log／診斷用；不含使用者資料）。 */
export type MediaDecoderSource = "packaged" | "dev-candidate";

/** 解析結果：來源、所在目錄（要交給服務的 `MNEMOSHELF_FFMPEG_DIR`）與兩支執行檔。 */
export interface ResolvedMediaDecoder {
  source: MediaDecoderSource;
  /** 內含 `ffmpeg`／`ffprobe`（平台檔名）的目錄（絕對路徑）。 */
  directory: string;
  binaries: MediaDecoderBinaries;
}

export interface ResolveMediaDecoderInput {
  isPackaged: boolean;
  /** `process.resourcesPath`（打包版）。 */
  resourcesPath: string;
  /** 目前環境變數（只用來判斷「是否已明確設定」，不會被本函式修改）。 */
  env: NodeJS.ProcessEnv;
  /** 檔案存在判斷（測試注入用；正式流程用 `fs.existsSync`）。 */
  exists: (file: string) => boolean;
  /** 開發模式的候選目錄（依序嘗試；不存在或缺少任一執行檔就跳過）。 */
  devCandidates?: readonly string[];
  /** 平台（測試注入用；預設 `process.platform`）。 */
  platform?: NodeJS.Platform;
}

/** 平台上的解碼器執行檔檔名（Windows 需要 `.exe`）；與 server 的 `mediaDecoderBinaryName` 一致。 */
export function mediaDecoderBinaryName(base: "ffmpeg" | "ffprobe", platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? `${base}.exe` : base;
}

/** 某個環境變數是否「有設定」（空字串與全空白視為未設定，與 server 的慣例一致）。 */
function hasSetting(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== "";
}

/**
 * 環境變數是否已明確指定影片解碼器？
 *
 * 任一相關變數有值就回 true：已設定時桌面**不覆寫**，讓使用者／CI 的設定優先
 * （配對錯誤由 server 的 `resolveMediaDecoderBinaries` 以清楚的啟動錯誤拒絕）。
 */
export function hasConfiguredMediaDecoderEnv(env: NodeJS.ProcessEnv): boolean {
  return hasSetting(env.MNEMOSHELF_FFMPEG_PATH) ||
    hasSetting(env.MNEMOSHELF_FFPROBE_PATH) ||
    hasSetting(env.MNEMOSHELF_FFMPEG_DIR);
}

/** 目錄裡兩支執行檔都存在時回傳解碼器路徑；否則回 null。 */
function binariesIn(directory: string, platform: NodeJS.Platform, exists: (file: string) => boolean): MediaDecoderBinaries | null {
  const resolved = path.resolve(directory);
  const ffmpegPath = path.join(resolved, mediaDecoderBinaryName("ffmpeg", platform));
  const ffprobePath = path.join(resolved, mediaDecoderBinaryName("ffprobe", platform));
  return exists(ffmpegPath) && exists(ffprobePath) ? { ffmpegPath, ffprobePath } : null;
}

/**
 * 解析桌面版要交給 Core 服務的解碼器目錄。
 *
 * 回傳 `null` 代表「桌面不設定」：可能是環境變數已設定（交由 server 解析），
 * 也可能是找不到任何可用的 binary（影片能力 disabled，服務照常啟動）。
 */
export function resolveMediaDecoder(input: ResolveMediaDecoderInput): ResolvedMediaDecoder | null {
  if (hasConfiguredMediaDecoderEnv(input.env)) return null;

  const platform = input.platform ?? process.platform;
  if (input.isPackaged) {
    const directory = path.resolve(input.resourcesPath, "bin");
    const binaries = binariesIn(directory, platform, input.exists);
    if (binaries !== null) return { source: "packaged", directory, binaries };
    // staging 不完整（只有一支）：仍把目錄交給 server，讓它回 missing-ffmpeg／missing-ffprobe
    // 的具名 unavailable（比「未設定」更能說明問題）；兩支都沒有才視為未設定（影片 disabled）。
    const partial = path.join(directory, mediaDecoderBinaryName("ffmpeg", platform));
    const partialProbe = path.join(directory, mediaDecoderBinaryName("ffprobe", platform));
    if (!input.exists(partial) && !input.exists(partialProbe)) return null;
    return {
      source: "packaged",
      directory,
      binaries: { ffmpegPath: partial, ffprobePath: partialProbe },
    };
  }

  for (const candidate of input.devCandidates ?? []) {
    const binaries = binariesIn(candidate, platform, input.exists);
    if (binaries !== null) {
      return { source: "dev-candidate", directory: path.resolve(candidate), binaries };
    }
  }
  return null;
}
