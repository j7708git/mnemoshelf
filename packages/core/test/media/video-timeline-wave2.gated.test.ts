/** 波次二 CFR 真解碼回歸；僅使用合成小圖，不代表真模型或效能驗收。 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { FfmpegMediaDecoder } from "../../src/media/index.js";
import { indexRoot, openDatabase, SqliteMetadataStore, SqliteVectorIndex } from "../../src/index.js";
import { FakeEmbedder } from "../../src/testing/fake-embedder.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const dir = path.join(repo, ".tmp", "wave2", "fixtures");
const ffmpegPath = process.env.MNEMOSHELF_FFMPEG_PATH ?? "";
const ffprobePath = process.env.MNEMOSHELF_FFPROBE_PATH ?? "";
const gated = process.env.MNEMOSHELF_WAVE2 === "1";
if (gated && (!existsSync(ffmpegPath) || !existsSync(ffprobePath))) {
  throw new Error("已啟用波次二測試，必須提供有效的 MNEMOSHELF_FFMPEG_PATH 與 MNEMOSHELF_FFPROBE_PATH");
}
const slow = process.env.MNEMOSHELF_SLOW_GATED === "1";
const rates = ["30000-1001", "24000-1001", "24", "25", "30", "50", "60"];
const file = (rate: string, duration: string): string => path.join(dir, `${rate}-${duration}.mp4`);

/** 獨立以 ffprobe 的實際來源時間驗證，不依賴 decoder 的 layout。 */
function frameTimes(input: string): number[] {
  const result = spawnSync(ffprobePath, ["-v", "error", "-select_streams", "v:0", "-show_frames", "-show_entries", "frame=pts_time", "-of", "csv=p=0", input], { encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => /^\d+(?:\.\d+)?$/.test(line)).map(Number);
}

async function verify(rate: string, duration: string): Promise<void> {
  const input = file(rate, duration);
  expect(existsSync(input), `先執行 wave2 夾具生成器：${rate}-${duration}`).toBe(true);
  const times = frameTimes(input);
  expect(times.length).toBeGreaterThan(0);
  const bins = new Map<number, number[]>();
  for (const time of times) {
    const index = Math.floor((time + 1e-7) / 4);
    const values = bins.get(index) ?? [];
    values.push(time);
    bins.set(index, values);
  }
  const decoder = new FfmpegMediaDecoder({ ffmpegPath, ffprobePath });
  const probe = await decoder.probe({ path: input });
  const actual = [];
  for await (const segment of decoder.decodeVisualSegments({ path: input }, { probe })) actual.push(segment);
  expect(actual).toHaveLength(bins.size);
  for (const [index, segment] of actual.entries()) {
    const candidates = bins.get(index)!;
    expect(candidates?.length).toBeGreaterThan(0);
    expect(segment.startSeconds).toBeCloseTo(index * 4, 5);
    expect(segment.endSeconds).toBeCloseTo(Math.min(probe.durationSeconds, (index + 1) * 4), 5);
    if (index > 0) expect(segment.startSeconds).toBeCloseTo(actual[index - 1]!.endSeconds, 5);
    expect(segment.frames).toHaveLength(1);
    const stamp = segment.frames[0]!.timestampSeconds;
    expect(candidates.some((candidate) => Math.abs(candidate - stamp) < 0.001)).toBe(true);
    expect(stamp).toBeGreaterThanOrEqual(segment.startSeconds - 0.001);
    expect(stamp).toBeLessThanOrEqual(segment.endSeconds + 0.001);
    // 完整段選中點之後第一幀；最後短段選實際最後一幀。
    const tail = probe.durationSeconds - index * 4 < 4 - 1e-6;
    const expected = tail ? candidates.at(-1)! : candidates.find((t) => t >= index * 4 + 2 - 1e-6) ?? candidates.at(-1)!;
    expect(stamp).toBeCloseTo(expected, 3);
  }
}

describe.skipIf(!gated)("波次二 CFR 來源時間線（真 FFmpeg）", () => {
  it.each(rates)("%s fps 8 秒", async (rate) => verify(rate, "8"), 90_000);
  it.each(["12", "60"])("29.97 fps %s 秒", async (duration) => verify("30000-1001", duration), 90_000);
  it.each(["0.2", "4.2", "8.2"])("30 fps 短尾 %s 秒", async (duration) => verify("30", duration), 90_000);
  it.skipIf(!slow).each(rates)("%s fps 367 秒非格線長片（超過 90 段）", async (rate) => verify(rate, "367"), 300_000);
  it.skipIf(!slow).each(["599", "600"])("30 fps %s 秒", async (duration) => verify("30", duration), 300_000);

  it.skipIf(!slow)("29.97 非格線長片讓出後恢復：全部 PTS 與像素等於未讓出基準", async () => {
    const input = file("30000-1001", "367");
    const short = file("30", "8");
    const baselineDecoder = new FfmpegMediaDecoder({ ffmpegPath, ffprobePath });
    const baselineProbe = await baselineDecoder.probe({ path: input });
    const signature = (segment: { frames: readonly { timestampSeconds: number; pixels: Uint8Array }[] }): string => {
      const frame = segment.frames[0]!;
      return `${frame.timestampSeconds}:${createHash("sha256").update(frame.pixels).digest("hex")}`;
    };
    const baseline: string[] = [];
    for await (const segment of baselineDecoder.decodeVisualSegments({ path: input }, { probe: baselineProbe })) baseline.push(signature(segment));
    expect(baseline.length).toBe(92);
    expect(new Set(baseline.map((entry) => entry.split(":")[1])).size).toBeGreaterThan(80);
    const decoder = new FfmpegMediaDecoder({ ffmpegPath, ffprobePath });
    const probe = await decoder.probe({ path: input });
    const shortProbe = await decoder.probe({ path: short });
    const iterator = decoder.decodeVisualSegments({ path: input }, { probe });
    const first = await iterator.next();
    expect(first.done).toBe(false);
    const resumed = [signature(first.value!)];
    for await (const _ of decoder.decodeVisualSegments({ path: short }, { probe: shortProbe })) { /* 讓短片搶佔 */ }
    expect(decoder.budgetStats().granted).toBeGreaterThanOrEqual(2);
    for await (const segment of iterator) resumed.push(signature(segment));
    expect(resumed).toEqual(baseline);
    expect(decoder.budgetStats().granted).toBeGreaterThanOrEqual(3);
    expect(decoder.budgetStats().active).toBe(0);
  }, 300_000);
  async function verifyIncremental(rate: string, duration: string): Promise<void> {
    await fs.mkdir(path.join(repo, ".tmp", "wave2"), { recursive: true });
    const work = await fs.mkdtemp(path.join(repo, ".tmp", "wave2", "incremental-"));
    const db = openDatabase(":memory:");
    try {
      const source = file(rate, duration);
      await fs.copyFile(source, path.join(work, "clip.mp4"));
      const store = new SqliteMetadataStore(db); await store.migrate();
      const vec = new SqliteVectorIndex(db);
      const root = await store.addRoot({ path: work, mode: "index", modalities: ["video"], include: [], exclude: [], respectGitignore: false, watch: false });
      const decoder = new FfmpegMediaDecoder({ ffmpegPath, ffprobePath });
      const embedder = new FakeEmbedder({ video: true });
      const embeds = vi.spyOn(embedder, "embedVideo");
      const expected = new Set(frameTimes(source).map((t) => Math.floor((t + 1e-7) / 4))).size;
      const first = await indexRoot(root, { store, vec, decoder, embedder });
      expect(first.processed).toBe(1);
      expect(embeds).toHaveBeenCalledTimes(expected);
      const second = await indexRoot(root, { store, vec, decoder, embedder });
      expect(second.skippedUnchanged).toBe(1);
      expect(embeds).toHaveBeenCalledTimes(expected);
      expect(decoder.budgetStats().active).toBe(0);
    } finally { db.close(); await fs.rm(work, { recursive: true, force: true }); }
  }
  it.each(rates)("%s fps 短片真索引後增量零嵌入", async (rate) => verifyIncremental(rate, "8"), 120_000);
  it.skipIf(!slow).each(rates)("%s fps 長片真索引後增量零嵌入", async (rate) => verifyIncremental(rate, "367"), 300_000);
  it("真 indexRoot：增量零嵌入、decoder 版本改變重建", async () => {
    await fs.mkdir(path.join(repo, ".tmp", "wave2"), { recursive: true });
    const work = await fs.mkdtemp(path.join(repo, ".tmp", "wave2", "index-"));
    const db = openDatabase(":memory:");
    try {
      await fs.copyFile(file("30000-1001", "8"), path.join(work, "clip.mp4"));
      const store = new SqliteMetadataStore(db); await store.migrate();
      const vec = new SqliteVectorIndex(db);
      const root = await store.addRoot({ path: work, mode: "index", modalities: ["video"], include: [], exclude: [], respectGitignore: false, watch: false });
      const decoder = new FfmpegMediaDecoder({ ffmpegPath, ffprobePath });
      const embedder = new FakeEmbedder({ video: true });
      const embeds = vi.spyOn(embedder, "embedVideo");
      const first = await indexRoot(root, { store, vec, decoder, embedder });
      expect(first.processed).toBe(1);
      expect(embeds).toHaveBeenCalledTimes(2);
      const second = await indexRoot(root, { store, vec, decoder, embedder });
      expect(second.skippedUnchanged).toBe(1);
      expect(embeds).toHaveBeenCalledTimes(2);
      const priorRows = db.prepare("select media_json from chunks where kind = 'video'").all() as { media_json: string }[];
      expect(priorRows).toHaveLength(2);
      expect(priorRows.every((row) => JSON.parse(row.media_json).preprocessVersion.includes("mp4-h264-rgb24-v4"))).toBe(true);
      const downgrade = db.prepare("update chunks set media_json = json_set(media_json, '$.preprocessVersion', replace(replace(json_extract(media_json, '$.preprocessVersion'), 'mp4-h264-rgb24-v4', 'mp4-h264-rgb24-v2'), 'srcpts-v3', 'srcpts-v1')) where kind = 'video'").run();
      expect(downgrade.changes).toBe(2);
      const rebuild = await indexRoot(root, { store, vec, decoder, embedder });
      expect(rebuild.processed).toBe(1);
      expect(embeds).toHaveBeenCalledTimes(4);
      const availability = await decoder.checkAvailability();
      vi.spyOn(decoder, "checkAvailability").mockResolvedValue({ ...availability, ffmpegVersion: "ffmpeg version 99.0" });
      const third = await indexRoot(root, { store, vec, decoder, embedder });
      expect(third.processed).toBe(1);
      expect(embeds).toHaveBeenCalledTimes(6);
      expect(decoder.budgetStats().active).toBe(0);
    } finally { db.close(); await fs.rm(work, { recursive: true, force: true }); }
  }, 120_000);

  it("取消中途索引後預算歸零，重新索引可完整續跑", async () => {
    await fs.mkdir(path.join(repo, ".tmp", "wave2"), { recursive: true });
    const work = await fs.mkdtemp(path.join(repo, ".tmp", "wave2", "cancel-"));
    const db = openDatabase(":memory:");
    try {
      await fs.copyFile(file("30000-1001", "12"), path.join(work, "clip.mp4"));
      const store = new SqliteMetadataStore(db); await store.migrate();
      const vec = new SqliteVectorIndex(db);
      const root = await store.addRoot({ path: work, mode: "index", modalities: ["video"], include: [], exclude: [], respectGitignore: false, watch: false });
      const decoder = new FfmpegMediaDecoder({ ffmpegPath, ffprobePath });
      const embedder = new FakeEmbedder({ video: true });
      const original = embedder.embedVideo.bind(embedder);
      const controller = new AbortController();
      const spy = vi.spyOn(embedder, "embedVideo").mockImplementation(async (input, opts) => {
        controller.abort();
        return original(input, opts);
      });
      await expect(indexRoot(root, { store, vec, decoder, embedder, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
      expect(decoder.budgetStats().active).toBe(0);
      expect(decoder.budgetStats().waiting).toBe(0);
      spy.mockRestore();
      const embeds = vi.spyOn(embedder, "embedVideo");
      const result = await indexRoot(root, { store, vec, decoder, embedder });
      expect(result.processed).toBe(1);
      expect(embeds).toHaveBeenCalledTimes(3);
      expect(decoder.budgetStats().active).toBe(0);
    } finally { db.close(); await fs.rm(work, { recursive: true, force: true }); }
  }, 120_000);
});
