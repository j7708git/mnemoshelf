/**
 * 影片相關環境變數的單元測試（`config.ts`）。
 *
 * 邊界：`MNEMOSHELF_FFMPEG_PATH`／`MNEMOSHELF_FFPROBE_PATH` 必須成對、
 * `MNEMOSHELF_FFMPEG_DIR` 以平台檔名組路徑、`MNEMOSHELF_VIDEO_MAX_FILE_BYTES` 預設 512 MiB
 * 且非法值直接拒絕啟動。全部使用合成路徑；不讀取任何使用者檔案、不 spawn。
 */
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_VIDEO_MAX_FILE_BYTES as CORE_DEFAULT_VIDEO_MAX_FILE_BYTES } from "@mnemoshelf/core";
import {
  DEFAULT_VIDEO_MAX_FILE_BYTES,
  loadServerConfig,
  mediaDecoderBinaryName,
  resolveMediaDecoderBinaries,
  resolveVideoMaxFileBytes,
} from "../src/index.js";

const BASE = { MNEMOSHELF_TOKEN: "test-token" } satisfies NodeJS.ProcessEnv;

describe("resolveMediaDecoderBinaries", () => {
  it("未設定 → undefined（不啟用影片解碼）", () => {
    expect(resolveMediaDecoderBinaries({})).toBeUndefined();
    expect(resolveMediaDecoderBinaries({ MNEMOSHELF_FFMPEG_PATH: "", MNEMOSHELF_FFPROBE_PATH: "  " })).toBeUndefined();
  });

  it("明確路徑 → 解析成絕對路徑（相對路徑以 cwd 為基準）", () => {
    const binaries = resolveMediaDecoderBinaries({
      MNEMOSHELF_FFMPEG_PATH: path.join("tools", "ffmpeg"),
      MNEMOSHELF_FFPROBE_PATH: path.join("tools", "ffprobe"),
    });
    expect(binaries).toEqual({
      ffmpegPath: path.resolve("tools", "ffmpeg"),
      ffprobePath: path.resolve("tools", "ffprobe"),
    });
  });

  it("只設一個 → 拒絕啟動（ValidationError）", () => {
    expect(() => resolveMediaDecoderBinaries({ MNEMOSHELF_FFMPEG_PATH: "ffmpeg" })).toThrowError(/成對/);
    expect(() => resolveMediaDecoderBinaries({ MNEMOSHELF_FFPROBE_PATH: "ffprobe" })).toThrowError(/成對/);
  });

  it("只設目錄 → 以平台檔名組路徑（Windows 加 .exe）", () => {
    const binaries = resolveMediaDecoderBinaries({ MNEMOSHELF_FFMPEG_DIR: path.join("opt", "bin") });
    expect(binaries).toEqual({
      ffmpegPath: path.join(path.resolve("opt", "bin"), mediaDecoderBinaryName("ffmpeg")),
      ffprobePath: path.join(path.resolve("opt", "bin"), mediaDecoderBinaryName("ffprobe")),
    });
    expect(mediaDecoderBinaryName("ffmpeg", "win32")).toBe("ffmpeg.exe");
    expect(mediaDecoderBinaryName("ffmpeg", "linux")).toBe("ffmpeg");
  });

  it("明確路徑優先於目錄", () => {
    const binaries = resolveMediaDecoderBinaries({
      MNEMOSHELF_FFMPEG_PATH: path.join("a", "ffmpeg-custom"),
      MNEMOSHELF_FFPROBE_PATH: path.join("a", "ffprobe-custom"),
      MNEMOSHELF_FFMPEG_DIR: path.join("b"),
    });
    expect(binaries?.ffmpegPath).toBe(path.resolve("a", "ffmpeg-custom"));
    expect(binaries?.ffprobePath).toBe(path.resolve("a", "ffprobe-custom"));
  });
});

describe("resolveVideoMaxFileBytes", () => {
  it("預設 512 MiB，且與 core 的常數同值（兩份定義不得漂移）", () => {
    expect(DEFAULT_VIDEO_MAX_FILE_BYTES).toBe(512 * 1024 * 1024);
    // config.ts 刻意不 import core（避免 MCP 啟動路徑再多一條 SQLite 載入）：用測試鎖住兩邊同值。
    expect(DEFAULT_VIDEO_MAX_FILE_BYTES).toBe(CORE_DEFAULT_VIDEO_MAX_FILE_BYTES);
    expect(resolveVideoMaxFileBytes({})).toBe(DEFAULT_VIDEO_MAX_FILE_BYTES);
  });

  it("接受正整數字串；空白視為未設定", () => {
    expect(resolveVideoMaxFileBytes({ MNEMOSHELF_VIDEO_MAX_FILE_BYTES: "1048576" })).toBe(1_048_576);
    expect(resolveVideoMaxFileBytes({ MNEMOSHELF_VIDEO_MAX_FILE_BYTES: "  " })).toBe(DEFAULT_VIDEO_MAX_FILE_BYTES);
  });

  it("非法值（0／負數／小數／非數字）→ 拒絕啟動", () => {
    for (const value of ["0", "-1", "1.5", "abc", " 12px"]) {
      expect(() => resolveVideoMaxFileBytes({ MNEMOSHELF_VIDEO_MAX_FILE_BYTES: value }), value).toThrowError(
        /MNEMOSHELF_VIDEO_MAX_FILE_BYTES/,
      );
    }
  });
});

describe("loadServerConfig：影片欄位", () => {
  it("未設定 decoder → mediaDecoder 為 undefined；上限為 512 MiB", () => {
    const config = loadServerConfig({ ...BASE });
    expect(config.mediaDecoder).toBeUndefined();
    expect(config.videoMaxFileBytes).toBe(DEFAULT_VIDEO_MAX_FILE_BYTES);
  });

  it("完整設定 → 兩個欄位都進 config（路徑解析為絕對路徑）", () => {
    const config = loadServerConfig({
      ...BASE,
      MNEMOSHELF_FFMPEG_PATH: path.join("tools", "ffmpeg.exe"),
      MNEMOSHELF_FFPROBE_PATH: path.join("tools", "ffprobe.exe"),
      MNEMOSHELF_VIDEO_MAX_FILE_BYTES: "2048",
    });
    expect(config.mediaDecoder).toEqual({
      ffmpegPath: path.resolve("tools", "ffmpeg.exe"),
      ffprobePath: path.resolve("tools", "ffprobe.exe"),
    });
    expect(config.videoMaxFileBytes).toBe(2048);
  });
});
