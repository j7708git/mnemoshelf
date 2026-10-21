import path from "node:path";
import { describe, expect, it } from "vitest";

import { normalizeProjectName, resolveProjectName } from "../src/project.js";

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
