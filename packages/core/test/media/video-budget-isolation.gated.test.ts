/** D4：不同 embedder／decoder 交錯及取消後同實例重用；需明確設定真解碼器路徑。 */
import { spawnSync } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { indexRoot, openDatabase, SqliteMetadataStore, SqliteVectorIndex } from "../../src/index.js";
import { FfmpegMediaDecoder } from "../../src/media/index.js";
import { FakeEmbedder } from "../../src/testing/fake-embedder.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const tmp = path.join(repoRoot, ".tmp");
const ffmpegPath = process.env.MNEMOSHELF_FFMPEG_PATH ?? "";
const ffprobePath = process.env.MNEMOSHELF_FFPROBE_PATH ?? "";
const enabled = ffmpegPath.length > 0 || ffprobePath.length > 0;

function generateFixture(dir: string): string {
  if (![ffmpegPath, ffprobePath].every((item) => item.length > 0 && existsSync(item))) throw new Error("需設定有效的 FFmpeg 與 FFprobe 路徑");
  const fixture = path.join(dir, "fixture.mp4");
  const result = spawnSync(ffmpegPath, ["-y", "-v", "error", "-f", "lavfi", "-i", "color=c=red:s=64x64:r=30:d=16.2", "-c:v", "libopenh264", fixture], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(`合成 fixture 失敗：${result.stderr}`);
  return fixture;
}

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

async function bounded<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("等待逾時")), ms); })]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

describe.skipIf(!enabled)("D4 decoder 隔離（真 FFmpeg）", () => {
  it("不同 embedder 與 decoder 可在第一個嵌入停住時各自完成", async () => {
    await fs.mkdir(tmp, { recursive: true });
    const dir = await fs.mkdtemp(path.join(tmp, "d4-isolation-"));
    const db = openDatabase(":memory:");
    const store = new SqliteMetadataStore(db);
    const vec = new SqliteVectorIndex(db);
    const entered = gate();
    const hold = gate();
    const controller = new AbortController();
    let first: ReturnType<typeof indexRoot> | undefined;
    let secondRun: ReturnType<typeof indexRoot> | undefined;
    try {
      await store.migrate();
      const fixture = generateFixture(dir);
      const roots = [];
      for (const name of ["first", "second"]) {
        const rootPath = path.join(dir, name);
        await fs.mkdir(rootPath);
        await fs.copyFile(fixture, path.join(rootPath, "clip.mp4"));
        roots.push(await store.addRoot({ path: rootPath, mode: "index", modalities: ["video"], include: [], exclude: [], respectGitignore: false, watch: false }));
      }
      const decoderA = new FfmpegMediaDecoder({ ffmpegPath, ffprobePath });
      const decoderB = new FfmpegMediaDecoder({ ffmpegPath, ffprobePath });
      let peakA = 0;
      let peakB = 0;
      for (const [decoder, record] of [[decoderA, (n: number) => { peakA = Math.max(peakA, n); }], [decoderB, (n: number) => { peakB = Math.max(peakB, n); }]] as const) {
        const acquire = decoder.decodeBudget.acquire.bind(decoder.decodeBudget);
        decoder.decodeBudget.acquire = async (signal) => {
          const lease = await acquire(signal);
          record(decoder.budgetStats().active);
          return lease;
        };
      }
      const embedderA = new FakeEmbedder({ video: true });
      const embedderB = new FakeEmbedder({ video: true });
      const original = embedderA.embedVideo!.bind(embedderA);
      let blocked = false;
      embedderA.embedVideo = async (input, opts) => {
        if (!blocked) { blocked = true; entered.release(); await hold.promise; }
        return original(input, opts);
      };
      let settled = false;
      first = indexRoot(roots[0]!, { store, vec, decoder: decoderA, embedder: embedderA, signal: controller.signal }).finally(() => { settled = true; });
      await bounded(entered.promise, 20_000);
      secondRun = indexRoot(roots[1]!, { store, vec, decoder: decoderB, embedder: embedderB, signal: controller.signal });
      const second = await bounded(secondRun, 30_000);
      expect(settled).toBe(false);
      expect(second.processed).toBe(1);
      expect(second.failedFiles).toEqual([]);
      expect(second.skippedFiles).toEqual([]);
      hold.release();
      const result = await bounded(first, 30_000);
      expect(result.processed).toBe(1);
      expect(result.failedFiles).toEqual([]);
      expect(result.skippedFiles).toEqual([]);
      expect((await store.listChunksByPath(roots[0]!.id, "clip.mp4")).length).toBeGreaterThan(0);
      expect((await store.listChunksByPath(roots[1]!.id, "clip.mp4")).length).toBeGreaterThan(0);
      expect(peakA).toBe(1);
      expect(peakB).toBe(1);
      expect(decoderA.budgetStats()).toMatchObject({ active: 0, waiting: 0 });
      expect(decoderB.budgetStats()).toMatchObject({ active: 0, waiting: 0 });
    } finally {
      controller.abort();
      hold.release();
      if (first !== undefined) await first.catch(() => undefined);
      if (secondRun !== undefined) await secondRun.catch(() => undefined);
      db.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  }, 90_000);

  it("取消嵌入後原 decoder 名額歸零且同實例可重新索引", async () => {
    await fs.mkdir(tmp, { recursive: true });
    const dir = await fs.mkdtemp(path.join(tmp, "d4-reuse-"));
    const db = openDatabase(":memory:");
    const store = new SqliteMetadataStore(db);
    const vec = new SqliteVectorIndex(db);
    const controller = new AbortController();
    const entered = gate();
    const hold = gate();
    let run: ReturnType<typeof indexRoot> | undefined;
    try {
      await store.migrate();
      const fixture = generateFixture(dir);
      const rootPath = path.join(dir, "root");
      await fs.mkdir(rootPath);
      await fs.copyFile(fixture, path.join(rootPath, "clip.mp4"));
      const root = await store.addRoot({ path: rootPath, mode: "index", modalities: ["video"], include: [], exclude: [], respectGitignore: false, watch: false });
      const decoder = new FfmpegMediaDecoder({ ffmpegPath, ffprobePath });
      const embedder = new FakeEmbedder({ video: true });
      embedder.embedVideo = async () => { entered.release(); await hold.promise; const error = new Error("已取消"); error.name = "AbortError"; throw error; };
      run = indexRoot(root, { store, vec, decoder, embedder, signal: controller.signal });
      await bounded(entered.promise, 20_000);
      controller.abort();
      hold.release();
      await expect(run).rejects.toMatchObject({ name: "AbortError" });
      expect(await store.listChunksByPath(root.id, "clip.mp4")).toEqual([]);
      expect(decoder.budgetStats()).toMatchObject({ active: 0, waiting: 0 });
      const rerun = await bounded(indexRoot(root, { store, vec, decoder, embedder: new FakeEmbedder({ video: true }) }), 30_000);
      expect(rerun.processed).toBe(1);
      expect(rerun.failedFiles).toEqual([]);
      expect(rerun.skippedFiles).toEqual([]);
      expect((await store.listChunksByPath(root.id, "clip.mp4")).length).toBeGreaterThan(0);
      expect(decoder.budgetStats()).toMatchObject({ active: 0, waiting: 0 });
    } finally {
      controller.abort();
      hold.release();
      if (run !== undefined) await run.catch(() => undefined);
      db.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
