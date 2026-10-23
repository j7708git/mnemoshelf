import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  isChatDirectory,
  normalizeProjectName,
  resolveProjectName,
  resolveProjectTarget,
} from "../src/project.js";

const CHAT_SESSION = "session-7a4cbf23-fe33-4fa1-8e10-f0be38497381";

describe("normalizeProjectName", () => {
  it("NFKC、trim、把分隔符與空白換成 -", () => {
    expect(normalizeProjectName("  Ｍnemoshelf / core\\sub  ")).toBe("Mnemoshelf-core-sub");
  });

  it("保留 CJK", () => {
    expect(normalizeProjectName("我的 專案")).toBe("我的-專案");
  });

  it("空字串與非字串回 null", () => {
    expect(normalizeProjectName("   ")).toBeNull();
    expect(normalizeProjectName(undefined)).toBeNull();
  });

  it("截到 200 字元", () => {
    const normalized = normalizeProjectName("a".repeat(300));
    expect(normalized).not.toBeNull();
    expect(normalized?.length).toBe(200);
  });
});

describe("resolveProjectName", () => {
  it("option 優先於其他來源", () => {
    expect(
      resolveProjectName({
        optionProject: "override",
        envProject: "env-name",
        canonical: path.join("work", "canonical"),
        locationDirectory: path.join("work", "canonical", "packages", "server"),
        platform: "linux",
      }),
    ).toBe("override");
  });

  it("env 次之", () => {
    expect(
      resolveProjectName({
        envProject: "env-name",
        canonical: path.join("work", "canonical"),
        platform: "linux",
      }),
    ).toBe("env-name");
  });

  it("canonical 是 main checkout 根，優先於子目錄", () => {
    expect(
      resolveProjectName({
        canonical: path.join("work", "mnemoshelf"),
        projectDirectory: path.join("work", "mnemoshelf"),
        locationDirectory: path.join("work", "mnemoshelf", "packages", "server"),
        platform: "linux",
      }),
    ).toBe("mnemoshelf");
  });

  it("沒有 canonical 時用 project.directory", () => {
    expect(
      resolveProjectName({
        projectDirectory: path.join("work", "wt", "feature"),
        locationDirectory: path.join("work", "wt", "feature", "packages"),
        platform: "linux",
      }),
    ).toBe("feature");
  });

  it("只剩 location.directory 時用它的 basename", () => {
    expect(
      resolveProjectName({ locationDirectory: path.join("work", "solo"), platform: "linux" }),
    ).toBe("solo");
  });

  it("目錄真的叫 global 才回 global", () => {
    expect(
      resolveProjectName({ locationDirectory: path.join("work", "global"), platform: "linux" }),
    ).toBe("global");
  });

  it("解析不到時 fail closed（不送 global、不送空字串）", () => {
    expect(resolveProjectName({ platform: "linux" })).toBeNull();
    expect(resolveProjectName({ canonical: "   ", locationDirectory: "", platform: "linux" })).toBeNull();
  });

  it("Windows 路徑用 win32 basename", () => {
    expect(
      resolveProjectName({
        canonical: "C:\\work\\mnemoshelf",
        locationDirectory: "C:\\work\\mnemoshelf\\packages",
        platform: "win32",
      }),
    ).toBe("mnemoshelf");
  });
});

describe("isChatDirectory", () => {
  it("posix：OpenChamber 聊天 session 目錄", () => {
    const directory = path.posix.join("work", ".config", "openchamber", "chats", "2026-10-22", CHAT_SESSION);
    expect(isChatDirectory(`/${directory}`, "linux")).toBe(true);
    // 結尾分隔符不影響判定。
    expect(isChatDirectory(`/${directory}/`, "linux")).toBe(true);
    // 沒有日期層也接受（`chats/session-<uuid>`）。
    expect(
      isChatDirectory(path.posix.join("/work/.config/openchamber/chats", CHAT_SESSION), "linux"),
    ).toBe(true);
  });

  it("win32：反斜線路徑與大小寫不敏感", () => {
    const directory = "C:\\work\\OpenChamber\\Chats\\2026-10-22\\" + CHAT_SESSION;
    expect(isChatDirectory(directory, "win32")).toBe(true);
    // 同一條字串在 posix 規則下不是聊天目錄（不假設 Windows 分隔符就是 `/`）。
    expect(isChatDirectory(directory, "linux")).toBe(false);
    // win32 也接受 `/`。
    expect(
      isChatDirectory(
        `C:/work/.config/openchamber/chats/2026-10-22/${CHAT_SESSION}`,
        "win32",
      ),
    ).toBe(true);
  });

  it("一般專案目錄與相近形狀都不是聊天目錄", () => {
    expect(isChatDirectory("/work/mnemoshelf", "linux")).toBe(false);
    expect(isChatDirectory("C:\\work\\mnemoshelf", "win32")).toBe(false);
    // 缺 `chats` 層。
    expect(isChatDirectory(`/work/.config/openchamber/${CHAT_SESSION}`, "linux")).toBe(false);
    // 最後一段不是 `session-<uuid>`。
    expect(isChatDirectory("/work/.config/openchamber/chats/2026-10-22/work", "linux")).toBe(false);
    // UUID 形狀不符。
    expect(isChatDirectory("/work/.config/openchamber/chats/2026-10-22/session-not-a-uuid", "linux")).toBe(
      false,
    );
    // 多了一層（不是日期目錄）。
    expect(
      isChatDirectory(`/work/.config/openchamber/chats/2026/10/22/${CHAT_SESSION}`, "linux"),
    ).toBe(false);
    expect(isChatDirectory(undefined, "linux")).toBe(false);
    expect(isChatDirectory("   ", "linux")).toBe(false);
  });
});

describe("resolveProjectTarget", () => {
  const chatDirectory = path.posix.join(
    "/work/.config/openchamber/chats/2026-10-22",
    CHAT_SESSION,
  );

  it("聊天目錄回 global-chat（不是專案名 global）", () => {
    expect(resolveProjectTarget({ locationDirectory: chatDirectory, platform: "linux" })).toEqual({
      kind: "global-chat",
    });
  });

  it("一般專案目錄行為不變", () => {
    expect(
      resolveProjectTarget({
        canonical: path.join("work", "mnemoshelf"),
        locationDirectory: path.join("work", "mnemoshelf", "packages"),
        platform: "linux",
      }),
    ).toEqual({ kind: "project", project: "mnemoshelf" });
  });

  it("解析不到且不是聊天目錄：unresolved（fail closed）", () => {
    expect(resolveProjectTarget({ platform: "linux" })).toEqual({ kind: "unresolved" });
    expect(resolveProjectTarget({ locationDirectory: "", platform: "linux" })).toEqual({
      kind: "unresolved",
    });
  });

  it("option／env 明確指定時優先於聊天目錄判定", () => {
    expect(
      resolveProjectTarget({ optionProject: "explicit", locationDirectory: chatDirectory, platform: "linux" }),
    ).toEqual({ kind: "project", project: "explicit" });
    expect(
      resolveProjectTarget({ envProject: "from-env", locationDirectory: chatDirectory, platform: "linux" }),
    ).toEqual({ kind: "project", project: "from-env" });
  });
});
