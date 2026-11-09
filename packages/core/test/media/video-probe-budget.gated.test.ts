/** 合成 600 秒 1080p：完整 PTS 不變、產品預設 probe 預算及取消／逾期回收。 */
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FfmpegMediaDecoder } from "../../src/media/index.js";
import * as mediaProcess from "../../src/media/process.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const ffmpegPath = process.env.MNEMOSHELF_FFMPEG_PATH ?? "";
const ffprobePath = process.env.MNEMOSHELF_FFPROBE_PATH ?? "";
const enabled = process.env.MNEMOSHELF_VIDEO_PROBE_BUDGET === "1";
const file = path.join(repo, ".tmp", "video-acceptance", "performance", "perf600-wave2-1", "1080p-600.mp4");
if (enabled && ![file, ffmpegPath, ffprobePath].every((value) => value !== "" && existsSync(value))) {
  throw new Error("probe 預算回歸需指定真 decoder 並先產生 perf600-wave2-1 合成素材。");
}
const decoder = () => new FfmpegMediaDecoder({ ffmpegPath, ffprobePath });
afterEach(() => { vi.restoreAllMocks(); });

describe.skipIf(!enabled)("600 秒完整 frame scan 預算", () => {
  it("使用產品預設期限完成 150 段，不覆寫 probeTimeoutMs", async () => {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    expect(hash.digest("hex")).toBe("cbb5a5fee2c962c74761def6250b82b1b1ec2eef4542ed556d149d199be8f378");
    const launch = vi.spyOn(mediaProcess, "runProcess");
    const probe = await decoder().probe({ path: file });
    const frameCall = launch.mock.calls.find(([, args]) => args.includes("-show_frames"));
    expect(frameCall).toBeDefined();
    const args = frameCall![1];
    for (const [option, value] of [["-threads", "4"], ["-f", "mov"], ["-protocol_whitelist", "file"]]) {
      const position = args.indexOf(option!);
      expect(position).toBeGreaterThanOrEqual(0);
      expect(args[position + 1]).toBe(value);
      expect(position + 1).toBeLessThan(args.indexOf(file));
    }
    expect(frameCall![2]?.timeoutMs).toBe(15_000);
    expect(probe.durationSeconds).toBe(600);
    expect(probe.visualTimeline).toHaveLength(150);
    expect(probe.visualTimeline![0]!.frameTimeSeconds).toBeGreaterThanOrEqual(2);
    expect(probe.visualTimeline!.at(-1)!.frameTimeSeconds).toBeGreaterThanOrEqual(598);
  }, 45_000);

  it("固定四執行緒保留原始全部 PTS/duration；輸出與未指定 threads 完全相同", async () => {
    const args = ["-v", "error", "-hide_banner", "-select_streams", "v:0", "-show_frames", "-show_entries", "frame=pts_time,duration_time", "-of", "compact=p=1:nk=0", "-f", "mov", "-protocol_whitelist", "file", file];
    // oracle 用較長期限取得原始完整清單；產品期限仍是 15 秒，上一例直接驗證。
    const baseline = await mediaProcess.runProcess(ffprobePath, args, { timeoutMs: 45_000, maxStdoutBytes: 4 * 1024 * 1024 });
    const bounded = await mediaProcess.runProcess(ffprobePath, ["-threads", "4", ...args], { timeoutMs: 15_000, maxStdoutBytes: 4 * 1024 * 1024 });
    for (const result of [baseline, bounded]) {
      expect(result.code, result.stderr).toBe(0);
      expect(result.killed).toEqual({ deadline: false, abort: false, outputCap: false });
      expect(result.stdoutTruncated).toBe(false);
    }
    expect(baseline.stdout.toString().split(/\r?\n/).filter((line) => line.startsWith("frame|")).length).toBe(14392);
    expect(bounded.stdout.equals(baseline.stdout)).toBe(true);
    expect(createHash("sha256").update(bounded.stdout).digest("hex")).toBe(createHash("sha256").update(baseline.stdout).digest("hex"));
  }, 75_000);

  it.each(["deadline", "abort"] as const)("frame scan 的 %s 仍拒絕，直到實際程序 close 才回傳", async (reason) => {
    const instance = decoder();
    expect((await instance.checkAvailability()).available).toBe(true);
    const run = mediaProcess.runProcess;
    const completed: mediaProcess.ProcessResult[] = [];
    const controller = new AbortController();
    let abortTimer: ReturnType<typeof setTimeout> | undefined;
    vi.spyOn(mediaProcess, "runProcess").mockImplementation(async (command, args, options) => {
      if (args.includes("-show_frames") && reason === "abort") abortTimer = setTimeout(() => controller.abort(), 100);
      const result = await run(command, args, options);
      if (args.includes("-show_frames")) completed.push(result);
      return result;
    });
    try {
      await expect(instance.probe({ path: file }, { signal: controller.signal, ...(reason === "deadline" ? { timeoutMs: 1000 } : {}) }))
        .rejects.toMatchObject({ code: reason === "deadline" ? "video-decode-timeout" : "video-decode-cancelled" });
      // runProcess 只在 child close 後完成；不可只發出 kill 就提早視為回收。
      expect(completed).toHaveLength(1);
      expect(completed[0]!.killed[reason]).toBe(true);
      expect(completed[0]!.spawnError).toBeNull();
      // killed 旗標只代表發出請求；自然 exit=0 不能冒充實際取消成功。
      expect(completed[0]!.code).not.toBe(0);
    } finally { clearTimeout(abortTimer); }
  }, 20_000);
});
