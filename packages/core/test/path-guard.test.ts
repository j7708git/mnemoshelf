import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PathBlockedError, PathOutsideRootError, RootTooBroadError } from "../src/errors.js";
import { assertRootAllowed, defaultCaseInsensitive, isInsideRoot, realpathAllowMissing, resolveInsideRoot } from "../src/roots/path-guard.js";
import type { Root } from "../src/ports/types.js";

function makeRoot(id: number, rootPath: string): Root {
  return {
    id,
    path: rootPath,
    mode: "index",
    modalities: ["text"],
    include: [],
    exclude: [],
    respectGitignore: true,
    watch: false,
    createdAt: new Date(0).toISOString(),
  };
}

let base = "";
let rootA = "";
let rootB = "";
let outside = "";
let sibling = "";
let realRootA = "";
let rootAFiles: Root[] = [];
let symlinkSupported = true;

beforeAll(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), "mnemoshelf-path-guard-"));
  rootA = path.join(base, "root-a");
  rootB = path.join(base, "root-b");
  outside = path.join(base, "outside");
  // 名稱以 rootA 為前綴的兄弟目錄：用來驗證「/a/b 不是 /a/bc 的上層」
  sibling = path.join(base, "root-a-extra");

  await fs.mkdir(path.join(rootA, "notes"), { recursive: true });
  await fs.mkdir(path.join(rootA, ".ssh"), { recursive: true });
  await fs.mkdir(path.join(rootA, ".password-store"), { recursive: true });
  await fs.mkdir(rootB, { recursive: true });
  await fs.mkdir(outside, { recursive: true });
  await fs.mkdir(sibling, { recursive: true });

  await fs.writeFile(path.join(rootA, "notes", "a.txt"), "alpha");
  await fs.writeFile(path.join(rootA, ".ssh", "id_rsa"), "private");
  await fs.writeFile(path.join(rootA, ".env"), "SECRET=1");
  await fs.writeFile(path.join(rootA, ".env.example"), "SECRET=");
  await fs.writeFile(path.join(rootA, ".environment.md"), "docs");
  await fs.writeFile(path.join(rootA, ".password-store", "x.gpg"), "private");
  await fs.writeFile(path.join(rootB, "b.txt"), "beta");
  await fs.writeFile(path.join(outside, "outside.txt"), "outside");
  await fs.writeFile(path.join(sibling, "sibling.txt"), "sibling");

  try {
    await fs.symlink(outside, path.join(rootA, "escape-link"), "dir");
  } catch {
    symlinkSupported = false;
  }

  realRootA = await fs.realpath(rootA);
  rootAFiles = [makeRoot(1, rootA)];
});

afterAll(async () => {
  await fs.rm(base, { recursive: true, force: true });
});

describe("resolveInsideRoot", () => {
  it("root 內的檔案：回傳 root、真實絕對路徑與相對路徑", async () => {
    const resolved = await resolveInsideRoot(rootAFiles, path.join(rootA, "notes", "a.txt"));
    expect(resolved.root.id).toBe(1);
    expect(resolved.abs).toBe(await fs.realpath(path.join(rootA, "notes", "a.txt")));
    expect(resolved.rel).toBe(path.join("notes", "a.txt"));
  });

  it("root 本身也視為在 root 內（rel 為空字串）", async () => {
    const resolved = await resolveInsideRoot(rootAFiles, rootA);
    expect(resolved.abs).toBe(realRootA);
    expect(resolved.rel).toBe("");
  });

  it("目標不存在時，解析最近的存在上層再接回剩餘片段", async () => {
    const resolved = await resolveInsideRoot(rootAFiles, path.join(rootA, "new", "deep", "b.txt"));
    expect(resolved.rel).toBe(path.join("new", "deep", "b.txt"));
    expect(resolved.abs).toBe(path.join(realRootA, "new", "deep", "b.txt"));
  });

  it("多個 root 時落在哪個 root 就回哪個", async () => {
    const roots = [makeRoot(1, rootA), makeRoot(2, rootB)];
    const resolved = await resolveInsideRoot(roots, path.join(rootB, "b.txt"));
    expect(resolved.root.id).toBe(2);
    expect(resolved.rel).toBe("b.txt");
  });

  it("以 `..` 逃出 root 會被拒", async () => {
    const escaped = path.join(rootA, "notes", "..", "..", "outside", "outside.txt");
    await expect(resolveInsideRoot(rootAFiles, escaped)).rejects.toBeInstanceOf(PathOutsideRootError);
  });

  it("直接指向 root 外的絕對路徑會被拒", async () => {
    await expect(resolveInsideRoot(rootAFiles, path.join(outside, "outside.txt"))).rejects.toBeInstanceOf(
      PathOutsideRootError,
    );
  });

  it("沒有加入任何 root 時一律拒絕", async () => {
    await expect(resolveInsideRoot([], path.join(rootA, "notes", "a.txt"))).rejects.toBeInstanceOf(
      PathOutsideRootError,
    );
  });

  it("路徑邊界：/a/b 不是 /a/bc 的上層（root-a 不含 root-a-extra）", async () => {
    // root-a-extra 的名稱以 root-a 為前綴，字串前綴比對會誤判，必須以路徑邊界判斷
    await expect(resolveInsideRoot(rootAFiles, path.join(sibling, "sibling.txt"))).rejects.toBeInstanceOf(
      PathOutsideRootError,
    );

    // 把兄弟目錄也加入成為 root 後就應該放行
    const roots = [makeRoot(1, rootA), makeRoot(2, sibling)];
    const resolved = await resolveInsideRoot(roots, path.join(sibling, "sibling.txt"));
    expect(resolved.root.id).toBe(2);
  });

  it("root 內名字以兩個點開頭的檔案（..foo）會被放行", async () => {
    const dotdotFile = path.join(rootA, "..foo");
    await fs.writeFile(dotdotFile, "name starts with two dots");

    const resolved = await resolveInsideRoot(rootAFiles, dotdotFile);
    expect(resolved.rel).toBe("..foo");
    expect(resolved.abs).toBe(path.join(realRootA, "..foo"));
  });

  it("指向 root 外的 symlink 逃脫會被拒（平台不支援 symlink 時以 ctx.skip() 略過）", async (ctx) => {
    // 帳號權限不足時（例如 Windows 未開開發者模式）fs.symlink 會失敗。
    // 注意：不能用 it.skipIf(!symlinkSupported)——skipIf 在收集階段求值，而 symlinkSupported
    // 是 beforeAll 才設定的，那時還來不及更新；改用測試內 ctx.skip()。
    if (!symlinkSupported) ctx.skip();
    await expect(resolveInsideRoot(rootAFiles, path.join(rootA, "escape-link", "outside.txt"))).rejects.toBeInstanceOf(
      PathOutsideRootError,
    );
  });

  it("指向 root 外的 dangling symlink（目標不存在）會被拒（平台不支援 symlink 時以 ctx.skip() 略過）", async (ctx) => {
    if (!symlinkSupported) ctx.skip();
    // 目標在 root 之外且不存在：舊實作把 realpath 的 ENOENT 當成「檔案不存在」，
    // 於是回頭解析父層，誤把 root/link 當成 root 內的新檔而放行。
    const link = path.join(rootA, "dangling-out");
    const ghostTarget = path.join(outside, "not-created.txt");
    await fs.symlink(ghostTarget, link, "file");

    await expect(resolveInsideRoot(rootAFiles, link)).rejects.toBeInstanceOf(PathOutsideRootError);
    // 我們只解析、不建立檔案
    await expect(fs.lstat(ghostTarget)).rejects.toThrow();
  });

  it("指向 root 內的 dangling symlink 會解析後放行（平台不支援 symlink 時以 ctx.skip() 略過）", async (ctx) => {
    // 選擇「解析 symlink」而非「一律拒絕 dangling symlink」：目標仍在 root 內，
    // 不構成逃脫，且與「root 內還不存在的路徑可放行」的既有語意一致。
    // 重點是回傳的 abs 必須是解析後的目標，而不是含 symlink 名稱的字面路徑。
    if (!symlinkSupported) ctx.skip();
    const link = path.join(rootA, "dangling-in");
    await fs.symlink(path.join(rootA, "ghost-dir", "ghost.txt"), link, "file");

    const resolved = await resolveInsideRoot(rootAFiles, link);
    expect(resolved.rel).toBe(path.join("ghost-dir", "ghost.txt"));
    expect(resolved.abs).toBe(path.join(realRootA, "ghost-dir", "ghost.txt"));
    expect(resolved.abs.includes("dangling-in")).toBe(false);
  });

  it("symlink 迴圈會被拒絕而不是無限追蹤（平台不支援 symlink 時以 ctx.skip() 略過）", async (ctx) => {
    if (!symlinkSupported) ctx.skip();
    await fs.symlink(path.join(rootA, "loop-b"), path.join(rootA, "loop-a"), "file");
    await fs.symlink(path.join(rootA, "loop-a"), path.join(rootA, "loop-b"), "file");

    await expect(resolveInsideRoot(rootAFiles, path.join(rootA, "loop-a"))).rejects.toThrow(/symlink/);
  });

  it.skipIf(process.platform === "win32")(
    "非 ENOENT 的檔案系統錯誤不會被當成缺檔（平台差異，於 Windows 略過）",
    async () => {
      // root-a/notes/a.txt 是檔案，不是目錄：解析 a.txt/child 會得到 ENOTDIR。
      // 這種錯誤必須直接拋出，不能像 ENOENT 一樣被當成「還不存在的路徑」而放行。
      await expect(resolveInsideRoot(rootAFiles, path.join(rootA, "notes", "a.txt", "child"))).rejects.toMatchObject(
        { code: "ENOTDIR" },
      );
    },
  );

  it("root 本身位於黑名單目錄下時，整個 root 都被擋（刻意行為）", async () => {
    // resolveInsideRoot 除了相對路徑，也會檢查整條絕對路徑（見函式 doc comment）：
    // root 選在敏感目錄（.mozilla／*.key）之下時，其下所有存取都回 PathBlockedError。
    const profileRoot = path.join(base, ".mozilla", "profile-root");
    await fs.mkdir(profileRoot, { recursive: true });
    await fs.writeFile(path.join(profileRoot, "notes.txt"), "x");
    await expect(
      resolveInsideRoot([makeRoot(9, profileRoot)], path.join(profileRoot, "notes.txt")),
    ).rejects.toBeInstanceOf(PathBlockedError);

    const keyDirRoot = path.join(base, "keys.key", "inner");
    await fs.mkdir(keyDirRoot, { recursive: true });
    await fs.writeFile(path.join(keyDirRoot, "data.txt"), "x");
    await expect(resolveInsideRoot([makeRoot(10, keyDirRoot)], path.join(keyDirRoot, "data.txt"))).rejects.toBeInstanceOf(
      PathBlockedError,
    );
  });

  it("命中黑名單的路徑（即使位於 root 內）會被拒", async () => {
    await expect(resolveInsideRoot(rootAFiles, path.join(rootA, ".ssh", "id_rsa"))).rejects.toBeInstanceOf(
      PathBlockedError,
    );
    await expect(resolveInsideRoot(rootAFiles, path.join(rootA, ".env"))).rejects.toBeInstanceOf(PathBlockedError);
    await expect(
      resolveInsideRoot(rootAFiles, path.join(rootA, ".password-store", "x.gpg")),
    ).rejects.toBeInstanceOf(PathBlockedError);
  });

  it("放行 .env.example 與 .environment.md", async () => {
    const example = await resolveInsideRoot(rootAFiles, path.join(rootA, ".env.example"));
    expect(example.rel).toBe(".env.example");

    const environment = await resolveInsideRoot(rootAFiles, path.join(rootA, ".environment.md"));
    expect(environment.rel).toBe(".environment.md");
  });
});

describe("assertRootAllowed", () => {
  it("拒絕檔案系統根目錄", () => {
    expect(() => assertRootAllowed(path.parse(rootA).root, { homeDir: base })).toThrow(RootTooBroadError);
  });

  it("拒絕家目錄本身", () => {
    expect(() => assertRootAllowed(base, { homeDir: base })).toThrow(RootTooBroadError);
  });

  it("接受具體的子目錄", () => {
    expect(() => assertRootAllowed(rootA, { homeDir: base })).not.toThrow();
    expect(() => assertRootAllowed(path.join(base, "root-a"), { homeDir: base })).not.toThrow();
  });
});

describe("realpathAllowMissing 與 defaultCaseInsensitive", () => {
  it("realpathAllowMissing 解析存在的路徑與還不存在的路徑", async () => {
    expect(await realpathAllowMissing(path.join(rootA, "notes", "a.txt"))).toBe(
      await fs.realpath(path.join(rootA, "notes", "a.txt")),
    );
    // 還不存在的深層路徑：接在最近的存在上層之後
    expect(await realpathAllowMissing(path.join(rootA, "notes", "later", "x.txt"))).toBe(
      path.join(realRootA, "notes", "later", "x.txt"),
    );
  });

  it("defaultCaseInsensitive 依平台判定（Windows／macOS 不敏感）", () => {
    expect(defaultCaseInsensitive("win32")).toBe(true);
    expect(defaultCaseInsensitive("darwin")).toBe(true);
    expect(defaultCaseInsensitive("linux")).toBe(false);
  });
});

describe("isInsideRoot", () => {
  it("以路徑邊界判斷（含相等）", () => {
    expect(isInsideRoot("/a/b", "/a/b", false)).toBe(true);
    expect(isInsideRoot("/a/b", "/a/b/c", false)).toBe(true);
    expect(isInsideRoot("/a/b", "/a/bc", false)).toBe(false);
    expect(isInsideRoot("/a/b", "/a", false)).toBe(false);
    expect(isInsideRoot("/a/b", "/a/b/../c", false)).toBe(false);
  });

  it("名字以兩個點開頭的檔案（..foo）仍在 root 內，只有真正的上層 `..` 在外", () => {
    // `/a/b/..foo` 的相對路徑是 `..foo`，不是上層 `..`；用 startsWith("..") 會誤判。
    expect(isInsideRoot("/a/b", "/a/b/..foo", false)).toBe(true);
    expect(isInsideRoot("/a/b", "/a/b/..foo/x.txt", false)).toBe(true);
    expect(isInsideRoot("/a/b", "/a/b/...", false)).toBe(true);
    // 真正的上層
    expect(isInsideRoot("/a/b", "/a/b/..", false)).toBe(false);
    expect(isInsideRoot("/a/b", "/a/b/../..", false)).toBe(false);
  });

  it("大小寫不敏感的檔案系統（Windows／macOS）以小寫比較", () => {
    // Windows 與 macOS 預設不敏感：實作在這些平台上以 toLowerCase 比較，
    // 因此同一條路徑的不同大小寫視為相同。這裡直接測比較函式（平台無關）。
    expect(isInsideRoot("/a/Project", "/a/project/file.txt", true)).toBe(true);
    expect(isInsideRoot("/a/Project", "/a/project/file.txt", false)).toBe(false);
    expect(isInsideRoot("/a/project", "/a/PROJECT", true)).toBe(true);
  });
});
