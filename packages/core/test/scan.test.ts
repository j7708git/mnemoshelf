import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { classifyFile, isJunkFile, matchesAnyGlob, matchesGlob, mimeTypeFor, walkRoot, type ScanRoot } from "../src/index.js";
// 新增的影片常數／helper 尚未從公開入口 export（本輪禁改 index.ts，PM 之後統一 export）。
import { isSupportedVideoFileName } from "../src/indexer/scan.js";

function baseRoot(overrides: Partial<ScanRoot> = {}): ScanRoot {
  return {
    path: "",
    modalities: ["text", "code"],
    include: [],
    exclude: [],
    respectGitignore: true,
    ...overrides,
  };
}

function rels(entries: { relPath: string }[]): string[] {
  return entries.map((entry) => entry.relPath).sort();
}

describe("glob 比對", () => {
  it("`*` 只在單層內匹配", () => {
    expect(matchesGlob("b.md", "*.md")).toBe(true);
    expect(matchesGlob("a/b.md", "*.md")).toBe(false);
  });

  it("`**` 跨任意層（可為零層）", () => {
    expect(matchesGlob("b.md", "**/*.md")).toBe(true);
    expect(matchesGlob("a/b.md", "**/*.md")).toBe(true);
    expect(matchesGlob("a/b/c.md", "**/*.md")).toBe(true);
    expect(matchesGlob("node_modules/x/y.js", "**/node_modules/**")).toBe(true);
    expect(matchesGlob("node_modules", "**/node_modules/**")).toBe(false);
  });

  it("支援 `?` 與字元類別", () => {
    expect(matchesGlob("ab.md", "a?.md")).toBe(true);
    expect(matchesGlob("abc.md", "a?.md")).toBe(false);
    expect(matchesGlob("a1.md", "a[0-9].md")).toBe(true);
    expect(matchesGlob("ax.md", "a[!0-9].md")).toBe(true);
  });

  it("matchesAnyGlob 空清單回傳 false", () => {
    expect(matchesAnyGlob("a.md", [])).toBe(false);
    expect(matchesAnyGlob("a.md", ["*.txt", "*.md"])).toBe(true);
  });
});

describe("classifyFile 與 mimeTypeFor", () => {
  it("已知種類", () => {
    expect(classifyFile("a.md")).toBe("text");
    expect(classifyFile("a.ts")).toBe("code");
    expect(classifyFile("Dockerfile")).toBe("code");
    expect(classifyFile("a.png")).toBe("image");
    expect(classifyFile("a.mp3")).toBe("audio");
    expect(classifyFile("a.mp4")).toBe("video");
    expect(classifyFile("a.zip")).toBe("binary");
  });

  it("未知副檔名預設當文字", () => {
    expect(classifyFile("notes")).toBe("text");
    expect(classifyFile("a.weird")).toBe("text");
  });

  it("mimeTypeFor 只對已知圖片回傳型別", () => {
    expect(mimeTypeFor("a.PNG")).toBe("image/png");
    expect(mimeTypeFor("a.jpg")).toBe("image/jpeg");
    expect(mimeTypeFor("a.md")).toBeNull();
  });
});

describe("系統／垃圾檔排除", () => {
  it("classifyFile 把系統／垃圾檔歸為 binary", () => {
    expect(classifyFile(".DS_Store")).toBe("binary");
    expect(classifyFile(".localized")).toBe("binary");
    expect(classifyFile("._notes.md")).toBe("binary");
    expect(classifyFile("Thumbs.db")).toBe("binary");
    expect(classifyFile("desktop.ini")).toBe("binary");
    expect(classifyFile(".Spotlight-V100")).toBe("binary");
    expect(classifyFile(".Trashes")).toBe("binary");
    expect(classifyFile("x.crdownload")).toBe("binary");
    expect(classifyFile("x.part")).toBe("binary");
    expect(classifyFile("x.partial")).toBe("binary");
    expect(classifyFile("X.DOWNLOAD")).toBe("binary");
  });

  it("只有命中的檔名被排除，一般檔案不受影響", () => {
    expect(classifyFile("notes")).toBe("text");
    expect(classifyFile("a.ini")).toBe("text"); // desktop.ini 是具名例外，不是整個 .ini
    expect(classifyFile("a.db.txt")).toBe("text");
    expect(classifyFile("report.downloads")).toBe("text");
    expect(classifyFile("my.part.notes")).toBe("text");
  });

  it("isJunkFile 只看 basename", () => {
    expect(isJunkFile("notes/.DS_Store")).toBe(true);
    expect(isJunkFile("notes/sub/desktop.ini")).toBe(true);
    expect(isJunkFile("notes/readme.md")).toBe(false);
  });
});

describe("walkRoot", () => {
  let base = "";
  let rootPath = "";
  let symlinksSupported = true;

  beforeAll(async () => {
    base = await fs.mkdtemp(path.join(os.tmpdir(), "mnemoshelf-scan-"));
    rootPath = path.join(base, "root");
    await fs.mkdir(path.join(rootPath, "notes"), { recursive: true });
    await fs.mkdir(path.join(rootPath, "code"), { recursive: true });
    await fs.mkdir(path.join(rootPath, "secret"), { recursive: true });

    await fs.writeFile(path.join(rootPath, "notes", "a.md"), "# 標題\n\n內容");
    await fs.writeFile(path.join(rootPath, "code", "app.ts"), "const answer = 42;\n");
    await fs.writeFile(path.join(rootPath, "image.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await fs.writeFile(path.join(rootPath, ".env"), "SECRET=1");
    await fs.writeFile(path.join(rootPath, "notes", "ignored.log"), "log line");
    await fs.writeFile(path.join(rootPath, "secret", "hidden.md"), "# 機密");
    await fs.writeFile(path.join(rootPath, "big.txt"), "x".repeat(5000));
    await fs.writeFile(path.join(rootPath, ".gitignore"), "*.log\n");

    // 系統／垃圾檔（應一律以 unsupported-type 跳過）
    await fs.writeFile(path.join(rootPath, ".DS_Store"), Buffer.from([0x00, 0x01, 0x02, 0x03]));
    await fs.writeFile(path.join(rootPath, "._notes.md"), "AppleDouble 中繼資料");
    await fs.writeFile(path.join(rootPath, "Thumbs.db"), Buffer.from([0x00, 0x00, 0x01]));
    await fs.writeFile(path.join(rootPath, "desktop.ini"), "[.ShellClassInfo]\n");
    await fs.writeFile(path.join(rootPath, "download.crdownload"), "下載到一半");
    await fs.writeFile(path.join(rootPath, "notes", "draft.part"), "下載到一半");

    const outside = path.join(base, "outside.txt");
    await fs.writeFile(outside, "outside");
    try {
      await fs.symlink(outside, path.join(rootPath, "escape.md"), "file");
      await fs.symlink(path.join(base, "missing-target.md"), path.join(rootPath, "dangling.md"), "file");
      await fs.symlink(path.join(rootPath, "notes", "a.md"), path.join(rootPath, "inside-link.md"), "file");
    } catch {
      symlinksSupported = false;
    }
  });

  afterAll(async () => {
    await fs.rm(base, { recursive: true, force: true });
  });

  it("列出文字與程式碼，並把未開啟的模態記為 modality-off", async () => {
    const result = await walkRoot(baseRoot({ path: rootPath }));
    expect(rels(result.files)).toEqual(
      [
        ".gitignore",
        "big.txt",
        "code/app.ts",
        "notes/a.md",
        "secret/hidden.md",
        ...(symlinksSupported ? ["inside-link.md"] : []),
      ].sort(),
    );
    const png = result.skipped.find((entry) => entry.relPath === "image.png");
    expect(png?.reason).toBe("modality-off");
  });

  it("黑名單檔案記為 blocked", async () => {
    const result = await walkRoot(baseRoot({ path: rootPath, respectGitignore: false }));
    expect(result.skipped).toContainEqual({ relPath: ".env", reason: "blocked" });
    expect(rels(result.files)).not.toContain(".env");
  });

  it("respectGitignore=true 時套用 root 的 .gitignore", async () => {
    const withGitignore = await walkRoot(baseRoot({ path: rootPath }));
    expect(withGitignore.skipped).toContainEqual({ relPath: "notes/ignored.log", reason: "excluded" });

    const without = await walkRoot(baseRoot({ path: rootPath, respectGitignore: false }));
    expect(rels(without.files)).toContain("notes/ignored.log");
    expect(without.skipped.some((entry) => entry.relPath === "notes/ignored.log")).toBe(false);
  });

  it("exclude 規則排除符合的檔案", async () => {
    const result = await walkRoot(baseRoot({ path: rootPath, exclude: ["**/secret/**"] }));
    expect(result.skipped).toContainEqual({ relPath: "secret/hidden.md", reason: "excluded" });
    expect(rels(result.files)).not.toContain("secret/hidden.md");
  });

  it("include 規則只納入符合的檔案", async () => {
    const result = await walkRoot(baseRoot({ path: rootPath, include: ["notes/**"] }));
    expect(rels(result.files)).toEqual(["notes/a.md"]);
    expect(result.skipped).toContainEqual({ relPath: "code/app.ts", reason: "excluded" });
  });

  it("超過大小上限記為 too-large", async () => {
    const result = await walkRoot(baseRoot({ path: rootPath }), { maxFileBytes: 1000 });
    expect(result.skipped).toContainEqual({ relPath: "big.txt", reason: "too-large" });
    expect(rels(result.files)).not.toContain("big.txt");
  });

  it("modalities 未開啟的媒體檔不出現在 files", async () => {
    const result = await walkRoot(baseRoot({ path: rootPath, modalities: ["text", "code", "image"] }));
    expect(rels(result.files)).toContain("image.png");
    expect(result.files.find((file) => file.relPath === "image.png")?.mimeType).toBe("image/png");
  });

  it("指向 root 外（含 dangling）的 symlink 不被納入", async (ctx) => {
    if (!symlinksSupported) ctx.skip();
    const result = await walkRoot(baseRoot({ path: rootPath }));
    expect(rels(result.files)).not.toContain("escape.md");
    expect(rels(result.files)).not.toContain("dangling.md");
    expect(result.skipped).toContainEqual({ relPath: "escape.md", reason: "unresolved-symlink" });
    expect(result.skipped).toContainEqual({ relPath: "dangling.md", reason: "unresolved-symlink" });
  });

  it("指向 root 內的 symlink 檔案會被納入", async (ctx) => {
    if (!symlinksSupported) ctx.skip();
    const result = await walkRoot(baseRoot({ path: rootPath }));
    const entry = result.files.find((file) => file.relPath === "inside-link.md");
    expect(entry?.kind).toBe("text");
    // absPath 指向解析後的真實檔案
    expect(entry?.absPath).toBe(await fs.realpath(path.join(rootPath, "notes", "a.md")));
  });

  it("系統／垃圾檔記為 unsupported-type，不出現在 files", async () => {
    const result = await walkRoot(baseRoot({ path: rootPath, respectGitignore: false }));
    const junk = [
      ".DS_Store",
      "._notes.md",
      "Thumbs.db",
      "desktop.ini",
      "download.crdownload",
      "notes/draft.part",
    ];
    for (const rel of junk) {
      expect(result.skipped).toContainEqual({ relPath: rel, reason: "unsupported-type" });
      expect(rels(result.files)).not.toContain(rel);
    }
  });

  it("掃描結果不含任何檔案內容", async () => {
    const result = await walkRoot(baseRoot({ path: rootPath }));
    for (const file of result.files) {
      expect(file).not.toHaveProperty("text");
      expect(file).not.toHaveProperty("content");
    }
  });

  it("已中止的 signal：掃描一開始就拋 AbortError", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(walkRoot(baseRoot({ path: rootPath }), { signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  it("大樹中途取消：以 AbortError 結束，不留下部分結果（唯讀走訪）", async () => {
    const big = path.join(base, "big-tree");
    for (let i = 0; i < 50; i += 1) {
      const dir = path.join(big, `d${i}`);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, "f.txt"), "x");
    }

    // 控制組：不帶 signal 可完整走完（證明上面中止的失敗是「取消」，不是掃描本身壞掉）。
    const full = await walkRoot(baseRoot({ path: big }));
    expect(full.files).toHaveLength(50);

    // 前 5 次取消檢查放行、之後中止：走訪途中被取消（大樹下不必等整輪結束）。
    const abortAfterChecks = (limit: number): AbortSignal => {
      let checks = 0;
      return {
        aborted: false,
        throwIfAborted: (): void => {
          checks += 1;
          if (checks > limit) {
            const error = new Error("掃描已取消");
            error.name = "AbortError";
            throw error;
          }
        },
      } as unknown as AbortSignal;
    };

    await expect(walkRoot(baseRoot({ path: big }), { signal: abortAfterChecks(5) })).rejects.toMatchObject({
      name: "AbortError",
    });
    // 取消不會有副作用：再跑一次完整走訪仍得到全部檔案。
    expect((await walkRoot(baseRoot({ path: big }))).files).toHaveLength(50);
  });
});

describe("walkRoot：影片 v1（mp4 白名單與大小上限）", () => {
  let base = "";
  let videoRoot = "";

  beforeAll(async () => {
    base = await fs.mkdtemp(path.join(os.tmpdir(), "mnemoshelf-scan-video-"));
    videoRoot = path.join(base, "root");
    await fs.mkdir(videoRoot, { recursive: true });
    await fs.writeFile(path.join(videoRoot, "clip.mp4"), Buffer.alloc(100, 1));
    await fs.writeFile(path.join(videoRoot, "movie.mov"), Buffer.alloc(100, 2));
    await fs.writeFile(path.join(videoRoot, "big.mp4"), Buffer.alloc(2000, 3));
    await fs.writeFile(path.join(videoRoot, "notes.md"), "# 一般文字");
  });

  afterAll(async () => {
    await fs.rm(base, { recursive: true, force: true });
  });

  it("呼叫端未宣告支援 video 時，沿用既有 unsupported-modality（產品行為不變）", async () => {
    const result = await walkRoot(
      baseRoot({ path: videoRoot, modalities: ["text", "video"] }),
      { supportedModalities: ["text", "code", "image", "audio"] },
    );
    expect(rels(result.files)).toEqual(["notes.md"]);
    expect(result.skipped).toContainEqual({ relPath: "clip.mp4", reason: "unsupported-modality" });
    expect(result.skipped).toContainEqual({ relPath: "movie.mov", reason: "unsupported-modality" });
  });

  it("宣告支援 video 後，只納入 v1 白名單 `.mp4`；其他容器記 unsupported-video-format", async () => {
    const result = await walkRoot(
      baseRoot({ path: videoRoot, modalities: ["text", "video"] }),
      { supportedModalities: ["text", "code", "image", "audio", "video"], videoMaxFileBytes: 1_000_000 },
    );
    // `.mp4` 大小寫不敏感（副檔名一律小寫比對）。
    expect(rels(result.files)).toEqual(["big.mp4", "clip.mp4", "notes.md"]);
    expect(result.files.find((file) => file.relPath === "clip.mp4")?.kind).toBe("video");
    expect(result.skipped).toContainEqual({ relPath: "movie.mov", reason: "unsupported-video-format" });
  });

  it("影片套用 videoMaxFileBytes；通用 maxFileBytes 不套用影片", async () => {
    // 通用上限調到很小：只影響非影片檔案，100 bytes 的 mp4 仍納入。
    const genericTiny = await walkRoot(
      baseRoot({ path: videoRoot, modalities: ["text", "video"] }),
      { supportedModalities: ["text", "video"], maxFileBytes: 10, videoMaxFileBytes: 1_000_000 },
    );
    expect(rels(genericTiny.files)).toEqual(["big.mp4", "clip.mp4"]);
    expect(genericTiny.skipped).toContainEqual({ relPath: "notes.md", reason: "too-large" });

    // 影片專屬上限：超過者記 video-too-large（預覽看得到，才能提示調整上限）。
    const limited = await walkRoot(
      baseRoot({ path: videoRoot, modalities: ["text", "video"] }),
      { supportedModalities: ["text", "video"], videoMaxFileBytes: 1000 },
    );
    expect(rels(limited.files)).toEqual(["clip.mp4", "notes.md"]);
    expect(limited.skipped).toContainEqual({ relPath: "big.mp4", reason: "video-too-large" });
  });

  it("未提供 supportedModalities 的純列舉：影片仍套 videoMaxFileBytes、不做容器白名單", async () => {
    const result = await walkRoot(baseRoot({ path: videoRoot, modalities: ["text", "video"] }), { videoMaxFileBytes: 1000 });
    expect(rels(result.files)).toEqual(["clip.mp4", "movie.mov", "notes.md"]);
    expect(result.skipped).toContainEqual({ relPath: "big.mp4", reason: "video-too-large" });
  });

  it("isSupportedVideoFileName 只認 v1 容器副檔名（大小寫不敏感）", () => {
    expect(isSupportedVideoFileName("clip.mp4")).toBe(true);
    expect(isSupportedVideoFileName("CLIP.MP4")).toBe(true);
    expect(isSupportedVideoFileName("movie.mov")).toBe(false);
    expect(isSupportedVideoFileName("clip.mp4.txt")).toBe(false);
    expect(isSupportedVideoFileName("noext")).toBe(false);
  });
});
