/**
 * 桌面原生資料夾選擇器契約測試：
 * 1. `DESKTOP_CHANNELS.folderPickerChoose` 常數與 `preload.cts` 內宣告的 channel 字串一致。
 * 2. `preload.cts` 維持零外部相依（僅 require("electron")）且不暴露 token。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DESKTOP_CHANNELS } from "../src/desktop-api.js";

describe("desktop folderPicker 契約", () => {
  const preloadUrl = new URL("../src/preload.cts", import.meta.url);
  const preloadSource = readFileSync(preloadUrl, "utf8");

  it("channel 名稱與 preload 同步", () => {
    expect(DESKTOP_CHANNELS.folderPickerChoose).toBe("mnemoshelf:folder-picker:choose");
    expect(preloadSource).toContain(DESKTOP_CHANNELS.folderPickerChoose);
    expect(preloadSource).toContain("folderPicker:");
    expect(preloadSource).toContain("chooseDirectory:");
  });

  it("preload 只 require electron、維持零外部相依", () => {
    const requires = [...preloadSource.matchAll(/require\(([^)]+)\)/g)].map((m) => m[1]!.trim());
    expect(requires).toEqual(['"electron"']);
  });
});
