import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { classifyFile, matchesAnyGlob, matchesGlob, mimeTypeFor, walkRoot, type ScanRoot } from "../src/index.js";

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

  it("掃描結果不含任何檔案內容", async () => {
    const result = await walkRoot(baseRoot({ path: rootPath }));
    for (const file of result.files) {
      expect(file).not.toHaveProperty("text");
      expect(file).not.toHaveProperty("content");
    }
  });
});
