/**
 * `scripts/smoke.mjs` 的未封裝產物目錄解析（純邏輯，不啟動 Electron、不跑煙霧測試）。
 *
 * 為什麼要測：electron-builder 的 `--dir` 輸出目錄名前綴隨架構變動——x64 是 `linux-unpacked`，
 * 非 x64 會多一段架構後綴（arm64 runner 上是 `linux-arm64-unpacked`）。寫死 `linux-unpacked`
 * 會讓 CI 的 arm64 leg 找不到產物（ENOENT）而必紅，release job 因此永遠不會執行。
 *
 * 腳本是沒有型別宣告的 ESM（`.mjs`），因此用**非字面值**的動態 import 取得（TypeScript 對
 * 非字面值的 specifier 不做模組解析，執行時才是真的載入）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

interface SmokeModule {
  findUnpackedDir(distApp: string, arch?: string): Promise<string>;
  findExecutable(dir: string): Promise<string>;
}

let dir: string;
let distApp: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "mnemoshelf-smoke-"));
  distApp = path.join(dir, "dist-app");
  await fs.mkdir(distApp, { recursive: true });
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function loadSmoke(): Promise<SmokeModule> {
  const url = new URL("../scripts/smoke.mjs", import.meta.url).href;
  return (await import(url)) as SmokeModule;
}

/** 造一個假的未封裝產物目錄：含應用程式執行檔與一個不該被選到的 helper。 */
async function fakeUnpacked(name: string): Promise<string> {
  const full = path.join(distApp, name);
  await fs.mkdir(full, { recursive: true });
  await fs.writeFile(path.join(full, "mnemoshelf"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await fs.writeFile(path.join(full, "chrome-sandbox"), "", { mode: 0o755 });
  await fs.writeFile(path.join(full, "resources.pak"), "", { mode: 0o644 });
  return full;
}

describe("findUnpackedDir", () => {
  it("x64 的目錄名（linux-unpacked）", async () => {
    const { findUnpackedDir } = await loadSmoke();
    const expected = await fakeUnpacked("linux-unpacked");
    expect(await findUnpackedDir(distApp, "x64")).toBe(expected);
  });

  it("非 x64 的目錄名帶架構後綴（linux-arm64-unpacked）也找得到", async () => {
    const { findUnpackedDir } = await loadSmoke();
    const expected = await fakeUnpacked("linux-arm64-unpacked");
    // arm64 runner 上是 process.arch === "arm64"；這裡也確認在不符的 arch 下仍會取到唯一候選。
    expect(await findUnpackedDir(distApp, "arm64")).toBe(expected);
    expect(await findUnpackedDir(distApp, "x64")).toBe(expected);
  });

  it("多個候選時優先取檔名含目前架構的那個", async () => {
    const { findUnpackedDir } = await loadSmoke();
    const arm64 = await fakeUnpacked("linux-arm64-unpacked");
    const x64 = await fakeUnpacked("linux-unpacked");
    expect(await findUnpackedDir(distApp, "arm64")).toBe(arm64);
    // x64 的目錄名不帶 `x64`（沒有架構後綴＝建置機器的預設架構），仍應避開 arm64 那份。
    expect(await findUnpackedDir(distApp, "x64")).toBe(x64);
  });

  it("找不到任何 *-unpacked 目錄時丟出可讀的錯誤", async () => {
    const { findUnpackedDir } = await loadSmoke();
    await expect(findUnpackedDir(distApp, "x64")).rejects.toThrowError(/找不到未封裝產物目錄/);
    await expect(findUnpackedDir(distApp, "x64")).rejects.toThrowError(/dist/);
  });
});

describe("findExecutable", () => {
  it("取應用程式執行檔，跳過 chrome-sandbox 與帶副檔名的檔案", async () => {
    const { findExecutable } = await loadSmoke();
    const unpacked = await fakeUnpacked("linux-unpacked");
    expect(await findExecutable(unpacked)).toBe(path.join(unpacked, "mnemoshelf"));
  });

  it("目錄裡沒有執行檔時丟出可讀的錯誤", async () => {
    const { findExecutable } = await loadSmoke();
    const empty = path.join(distApp, "linux-unpacked");
    await fs.mkdir(empty, { recursive: true });
    await expect(findExecutable(empty)).rejects.toThrowError(/找不到執行檔/);
  });
});
