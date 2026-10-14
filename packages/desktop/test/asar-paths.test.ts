import path from "node:path";
import { describe, expect, it } from "vitest";
import { toUnpackedPath } from "../src/asar-paths.js";

const ASAR = ["opt", "app", "resources", "app.asar", "node_modules", "sqlite-vec-linux-x64", "vec0.so"].join(path.sep);
const UNPACKED = [
  "opt",
  "app",
  "resources",
  "app.asar.unpacked",
  "node_modules",
  "sqlite-vec-linux-x64",
  "vec0.so",
].join(path.sep);

describe("toUnpackedPath", () => {
  it("把 asar 內路徑改指到 app.asar.unpacked", () => {
    expect(toUnpackedPath(ASAR)).toBe(UNPACKED);
  });

  it("已經是 unpacked 的路徑不再改寫", () => {
    expect(toUnpackedPath(UNPACKED)).toBeNull();
  });

  it("一般開發目錄不需要改寫", () => {
    expect(toUnpackedPath(path.join("repo", "packages", "core", "dist", "index.js"))).toBeNull();
  });

  it("檔名裡剛好有 app.asar 但不在路徑片段上時不改寫", () => {
    expect(toUnpackedPath(path.join("tmp", "app.asar.backup"))).toBeNull();
  });
});
