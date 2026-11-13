import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  collectFormatStats,
  formatStatsMarkdown,
  probeMediaWithFfprobe,
  type MediaContainerProbe,
} from "../src/index.js";

const execFileAsync = promisify(execFile);

async function resolveBinary(name: string): Promise<string | null> {
  for (const candidate of [`/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`, `/usr/bin/${name}`]) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // 繼續找下一個候選路徑
    }
  }
  return null;
}

describe("Stage 2 format-stats", () => {
  let tmpRoot: string;

  beforeAll(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mnemoshelf-format-stats-"));
    const write = (rel: string, content: Buffer | string) => fs.writeFile(path.join(tmpRoot, rel), content);

    await write("secret-note-alpha.md", "# Title\n\nhello world\n");
    await write("secret-code-beta.ts", "export const x = 1;\n");
    await write("secret-img-gamma.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    await write("secret-heic-delta.heic", Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63]));
    await write("secret-doc-epsilon.pdf", Buffer.from("%PDF-1.7\n%synthetic\n"));
    await write("secret-word-zeta.docx", Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]));
    await write("secret-sheet-eta.xlsx", Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]));
    await write("secret-slide-theta.pptx", Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]));
    await write("secret-archive-iota.zip", Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]));
    await write("secret-dmg-kappa.dmg", Buffer.from([0x78, 0x01, 0x73, 0x0d]));
    await write(".DS_Store", Buffer.from([0x00, 0x00, 0x00, 0x01, 0x42, 0x75, 0x64, 0x31]));
    await write("._secret-img-gamma.png", Buffer.from([0x00, 0x05, 0x16, 0x07]));
    await write("secret-pages-lambda.pages", Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]));
    await write("secret-rtf-mu.rtf", "{\\rtf1\\ansi\\deff0 synthetic}");
    await write("secret-caf-nu.caf", Buffer.from("caff\x00\x01\x00\x00desc"));
    await write("secret-svg-xi.svg", '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    await write("secret-wav-omicron.wav", Buffer.from("RIFF\x24\x00\x00\x00WAVEfmt "));
    await write("secret-m4a-pi.m4a", Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20]));
    await write("secret-mp3-rho.mp3", Buffer.from("ID3\x04\x00\x00"));
    await write("secret-mp4-sigma.mp4", Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]));
    await write("secret-mov-tau.mov", Buffer.from([0x00, 0x00, 0x00, 0x14, 0x66, 0x74, 0x79, 0x70, 0x71, 0x74, 0x20, 0x20]));
  });

  afterAll(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("統計各類 SkipReason、sharp 圖片缺口、未知副檔名標頭與匿名化輸出", async () => {
    const fakeProbe = async (absPath: string): Promise<MediaContainerProbe> => {
      const ext = path.extname(absPath).toLowerCase();
      if (ext === ".mov") {
        return {
          ok: true, error: null, formatName: "mov,mp4,m4a,3gp,3g2,mj2", durationSeconds: 12,
          videoCodec: "hevc", pixFmt: "yuv420p10le", width: 1920, height: 1080,
          audioCodec: "aac", audioChannels: 2, audioSampleRate: 48000,
        };
      }
      if (ext === ".mp4") {
        return {
          ok: true, error: null, formatName: "mov,mp4,m4a,3gp,3g2,mj2", durationSeconds: 8,
          videoCodec: "h264", pixFmt: "yuv420p", width: 1280, height: 720,
          audioCodec: "aac", audioChannels: 2, audioSampleRate: 44100,
        };
      }
      if (ext === ".m4a") {
        return {
          ok: true, error: null, formatName: "mov,mp4,m4a,3gp,3g2,mj2", durationSeconds: 30,
          videoCodec: null, pixFmt: null, width: null, height: null,
          audioCodec: "aac", audioChannels: 2, audioSampleRate: 44100,
        };
      }
      if (ext === ".mp3") {
        return {
          ok: true, error: null, formatName: "mp3", durationSeconds: 45,
          videoCodec: null, pixFmt: null, width: null, height: null,
          audioCodec: "mp3", audioChannels: 2, audioSampleRate: 44100,
        };
      }
      if (ext === ".wav") {
        return {
          ok: true, error: null, formatName: "wav", durationSeconds: 5,
          videoCodec: null, pixFmt: null, width: null, height: null,
          audioCodec: "pcm_s16le", audioChannels: 1, audioSampleRate: 16000,
        };
      }
      return {
        ok: true, error: null, formatName: "caf", durationSeconds: 10,
        videoCodec: null, pixFmt: null, width: null, height: null,
        audioCodec: "alac", audioChannels: 2, audioSampleRate: 48000,
      };
    };

    const report = await collectFormatStats(
      { label: "synthetic-unit", path: tmpRoot },
      { probeUnknownHeaders: true, probeMedia: fakeProbe },
    );

    expect(report.totals.scannedFiles).toBe(21);
    expect(report.totals.acceptedFiles).toBe(10); // md, ts, png, heic, pages, rtf, caf, svg, wav, mp4
    expect(report.totals.skippedFiles).toBe(11);
    expect(report.totals.sharpUnsupportedImageCount).toBe(1);
    expect(report.totals.unknownDefaultTextCount).toBe(4); // pages, rtf, caf, svg

    const skipByReason = new Map(report.skipReasons.map((r) => [r.reason, r.count]));
    expect(skipByReason.get("unsupported-type")).toBe(8); // pdf, docx, xlsx, pptx, zip, dmg, .DS_Store, ._
    expect(skipByReason.get("unsupported-audio-format")).toBe(2); // m4a, mp3
    expect(skipByReason.get("unsupported-video-format")).toBe(1); // mov

    const pagesStat = report.extensions.find((e) => e.ext === ".pages");
    expect(pagesStat?.unknownHeaderCounts["zip-container"]).toBe(1);
    const rtfStat = report.extensions.find((e) => e.ext === ".rtf");
    expect(rtfStat?.unknownHeaderCounts["rtf-markup"]).toBe(1);
    const cafStat = report.extensions.find((e) => e.ext === ".caf");
    expect(cafStat?.unknownHeaderCounts["caf-audio"]).toBe(1);
    const svgStat = report.extensions.find((e) => e.ext === ".svg");
    expect(svgStat?.unknownHeaderCounts["svg-xml"]).toBe(1);

    const movProfile = report.mediaProfiles.find((p) => p.ext === ".mov");
    expect(movProfile?.v1Compatible).toBe(false);
    expect(movProfile?.incompatibilityReasons).toEqual(["container:.mov", "video-codec:hevc", "pix-fmt:yuv420p10le"]);

    const mp4Profile = report.mediaProfiles.find((p) => p.ext === ".mp4");
    expect(mp4Profile?.v1Compatible).toBe(true);

    const serialized = JSON.stringify(report) + "\n" + formatStatsMarkdown(report);
    expect(serialized).not.toContain(tmpRoot);
    expect(serialized).not.toContain("secret-note-alpha");
    expect(serialized).not.toContain("secret-mov-tau");
  });

  it("真實 ffprobe 可正確解析合成 .mp4 與 .m4a 容器編碼", async () => {
    const ffmpeg = await resolveBinary("ffmpeg");
    const ffprobe = await resolveBinary("ffprobe");
    if (!ffmpeg || !ffprobe) return;

    const mediaDir = await fs.mkdtemp(path.join(os.tmpdir(), "mnemoshelf-ffprobe-stats-"));
    try {
      const mp4Path = path.join(mediaDir, "clip.mp4");
      const m4aPath = path.join(mediaDir, "voice.m4a");
      await execFileAsync(ffmpeg, [
        "-y", "-f", "lavfi", "-i", "color=c=black:s=64x64:d=0.5",
        "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono",
        "-t", "0.5", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", mp4Path,
      ]);
      await execFileAsync(ffmpeg, [
        "-y", "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono",
        "-t", "0.5", "-c:a", "aac", m4aPath,
      ]);

      const mp4Probe = await probeMediaWithFfprobe(mp4Path, ffprobe);
      expect(mp4Probe.ok).toBe(true);
      expect(mp4Probe.videoCodec).toBe("h264");
      expect(mp4Probe.pixFmt).toBe("yuv420p");
      expect(mp4Probe.audioCodec).toBe("aac");

      const m4aProbe = await probeMediaWithFfprobe(m4aPath, ffprobe);
      expect(m4aProbe.ok).toBe(true);
      expect(m4aProbe.videoCodec).toBeNull();
      expect(m4aProbe.audioCodec).toBe("aac");
    } finally {
      await fs.rm(mediaDir, { recursive: true, force: true });
    }
  });
});
