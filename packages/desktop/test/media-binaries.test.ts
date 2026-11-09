/**
 * 桌面版影片解碼器定位（`media-binaries.ts`）的單元測試。
 *
 * 只驗純解析規則：環境變數優先、打包版 `resources/bin`、開發候選只在檔案存在時採用。
 * 真正的 spawn／播放由 packaged smoke 與 gated 驗收負責（不在這裡模擬 Electron／binary）。
 */
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  hasConfiguredMediaDecoderEnv,
  mediaDecoderBinaryName,
  resolveMediaDecoder,
} from "../src/media-binaries.js";

const RESOURCES = path.join("tmp", "example-resources");
const DEV_A = path.join("tmp", "example-tmp", "decoder", "bin", "ffmpeg-version-a", "bin");
const DEV_B = path.join("tmp", "example-tmp", "decoder", "bin", "ffmpeg-version-b", "bin");

/** 以「檔案是否在這個清單」模擬 `fs.existsSync`（全部先解析成絕對路徑）。 */
function existsOnly(files: readonly string[]): (file: string) => boolean {
  const allowed = new Set(files.map((file) => path.resolve(file)));
  return (file) => allowed.has(path.resolve(file));
}

/** 某個目錄下的兩支執行檔（依平台檔名）。 */
function binaries(directory: string, platform: NodeJS.Platform): string[] {
  return [
    path.join(path.resolve(directory), mediaDecoderBinaryName("ffmpeg", platform)),
    path.join(path.resolve(directory), mediaDecoderBinaryName("ffprobe", platform)),
  ];
}

describe("mediaDecoderBinaryName", () => {
  it("Windows 加 .exe，其他平台不加", () => {
    expect(mediaDecoderBinaryName("ffmpeg", "win32")).toBe("ffmpeg.exe");
    expect(mediaDecoderBinaryName("ffprobe", "win32")).toBe("ffprobe.exe");
    expect(mediaDecoderBinaryName("ffmpeg", "darwin")).toBe("ffmpeg");
    expect(mediaDecoderBinaryName("ffprobe", "linux")).toBe("ffprobe");
  });
});

describe("hasConfiguredMediaDecoderEnv", () => {
  it("任一相關變數有值就算已設定；空字串與全空白視為未設定", () => {
    expect(hasConfiguredMediaDecoderEnv({})).toBe(false);
    expect(hasConfiguredMediaDecoderEnv({ MNEMOSHELF_FFMPEG_PATH: "  " })).toBe(false);
    expect(hasConfiguredMediaDecoderEnv({ MNEMOSHELF_FFMPEG_PATH: "/opt/ffmpeg" })).toBe(true);
    expect(hasConfiguredMediaDecoderEnv({ MNEMOSHELF_FFPROBE_PATH: "/opt/ffprobe" })).toBe(true);
    expect(hasConfiguredMediaDecoderEnv({ MNEMOSHELF_FFMPEG_DIR: "/opt/bin" })).toBe(true);
  });
});

describe("resolveMediaDecoder", () => {
  it("環境變數已設定時不覆寫（回 null，交由 server 解析）", () => {
    const resolved = resolveMediaDecoder({
      isPackaged: true,
      resourcesPath: RESOURCES,
      env: { MNEMOSHELF_FFMPEG_DIR: path.join("tmp", "custom-bin") },
      exists: existsOnly(binaries(path.join(RESOURCES, "bin"), "win32")),
      platform: "win32",
    });
    expect(resolved).toBeNull();
  });

  it("打包版採用 resources/bin（兩支都在）", () => {
    const platform: NodeJS.Platform = "win32";
    const binDir = path.join(RESOURCES, "bin");
    const resolved = resolveMediaDecoder({
      isPackaged: true,
      resourcesPath: RESOURCES,
      env: {},
      exists: existsOnly(binaries(binDir, platform)),
      platform,
    });
    expect(resolved).not.toBeNull();
    expect(resolved?.source).toBe("packaged");
    expect(resolved?.directory).toBe(path.resolve(binDir));
    expect(resolved?.binaries.ffmpegPath).toBe(path.join(path.resolve(binDir), "ffmpeg.exe"));
    expect(resolved?.binaries.ffprobePath).toBe(path.join(path.resolve(binDir), "ffprobe.exe"));
  });

  it("打包版只有一支（staging 不完整）仍交目錄，讓 server 回 missing-ffprobe 類的具名狀態", () => {
    const platform: NodeJS.Platform = "linux";
    const binDir = path.join(RESOURCES, "bin");
    const [ffmpegPath] = binaries(binDir, platform);
    const resolved = resolveMediaDecoder({
      isPackaged: true,
      resourcesPath: RESOURCES,
      env: {},
      exists: existsOnly([ffmpegPath!]),
      platform,
    });
    expect(resolved?.source).toBe("packaged");
    expect(resolved?.directory).toBe(path.resolve(binDir));
    expect(resolved?.binaries.ffprobePath).toBe(path.join(path.resolve(binDir), "ffprobe"));
  });

  it("打包版兩支都沒有就不設定（服務照常啟動、影片 disabled）", () => {
    const resolved = resolveMediaDecoder({
      isPackaged: true,
      resourcesPath: RESOURCES,
      env: {},
      exists: () => false,
      platform: "linux",
    });
    expect(resolved).toBeNull();
  });

  it("開發模式只在候選檔案存在時採用，並依序跳過不完整目錄", () => {
    const platform: NodeJS.Platform = "linux";
    const resolved = resolveMediaDecoder({
      isPackaged: false,
      resourcesPath: RESOURCES,
      env: {},
      exists: existsOnly(binaries(DEV_B, platform)),
      devCandidates: [DEV_A, DEV_B],
      platform,
    });
    expect(resolved?.source).toBe("dev-candidate");
    expect(resolved?.directory).toBe(path.resolve(DEV_B));
  });

  it("開發模式沒有候選就回 null（不寫死本機路徑）", () => {
    expect(
      resolveMediaDecoder({
        isPackaged: false,
        resourcesPath: RESOURCES,
        env: {},
        exists: () => false,
        devCandidates: [DEV_A, DEV_B],
        platform: "linux",
      }),
    ).toBeNull();
  });

  it("打包版優先於開發候選（避免 dev 的 .tmp 汙染成品）", () => {
    const platform: NodeJS.Platform = "win32";
    const binDir = path.join(RESOURCES, "bin");
    const resolved = resolveMediaDecoder({
      isPackaged: true,
      resourcesPath: RESOURCES,
      env: {},
      exists: existsOnly([...binaries(binDir, platform), ...binaries(DEV_A, platform)]),
      devCandidates: [DEV_A],
      platform,
    });
    expect(resolved?.source).toBe("packaged");
    expect(resolved?.directory).toBe(path.resolve(binDir));
  });
});
