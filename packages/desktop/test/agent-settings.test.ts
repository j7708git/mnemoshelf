/**
 * 桌面版 `agentSettings.json` 的持久化與「關閉即刪 runtime 檔」。
 *
 * 全部使用暫存目錄與合成資料；不讀取使用者檔案。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  defaultAgentSettings,
  readAgentSettings,
  resolveStartupDiscovery,
  runtimeFileExists,
  setAgentDiscovery,
  setSkippedUpdateVersion,
  writeAgentSettings,
} from "../src/agent-settings.js";

async function makeDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "mnemoshelf-agent-settings-"));
}

async function exists(file: string): Promise<boolean> {
  return fs
    .stat(file)
    .then(() => true)
    .catch(() => false);
}

const silent = (): void => undefined;

describe("agentSettings.json", () => {
  it("不存在時預設 agentDiscovery=on（桌面版預設開啟）", async () => {
    const dir = await makeDir();
    try {
      const settings = await readAgentSettings(path.join(dir, "agentSettings.json"), silent);
      expect(settings).toEqual({ schemaVersion: 1, agentDiscovery: true });
      expect(defaultAgentSettings()).toEqual({ schemaVersion: 1, agentDiscovery: true });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("寫出後可以讀回，權限 0600（POSIX）", async () => {
    const dir = await makeDir();
    const file = path.join(dir, "agentSettings.json");
    try {
      await writeAgentSettings(file, { schemaVersion: 1, agentDiscovery: false });
      expect(await readAgentSettings(file, silent)).toEqual({ schemaVersion: 1, agentDiscovery: false });
      if (process.platform !== "win32") {
        expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("格式不合法時回預設值（不讓應用起不來）", async () => {
    const dir = await makeDir();
    const file = path.join(dir, "agentSettings.json");
    try {
      await fs.writeFile(file, "not-json", "utf8");
      expect(await readAgentSettings(file, silent)).toEqual(defaultAgentSettings());

      await fs.writeFile(file, '{"schemaVersion":1}', "utf8");
      expect(await readAgentSettings(file, silent)).toEqual(defaultAgentSettings());
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("skippedUpdateVersion（稍後的更新版本）", () => {
  it("與 agentDiscovery 存在同一個檔，讀寫可往返（舊檔沒有這個欄位也相容）", async () => {
    const dir = await makeDir();
    const file = path.join(dir, "agentSettings.json");
    try {
      // 舊格式（沒有 skippedUpdateVersion）→ 讀得到原本的兩個欄位。
      await fs.writeFile(file, '{"schemaVersion":1,"agentDiscovery":false}\n', "utf8");
      expect(await readAgentSettings(file, silent)).toEqual({ schemaVersion: 1, agentDiscovery: false });

      const next = await setSkippedUpdateVersion(file, { schemaVersion: 1, agentDiscovery: false }, "0.5.1");
      expect(next).toEqual({ schemaVersion: 1, agentDiscovery: false, skippedUpdateVersion: "0.5.1" });
      expect(await readAgentSettings(file, silent)).toEqual({
        schemaVersion: 1,
        agentDiscovery: false,
        skippedUpdateVersion: "0.5.1",
      });

      // 清除時把欄位移除，不留下舊值。
      const cleared = await setSkippedUpdateVersion(file, next, null);
      expect(cleared).toEqual({ schemaVersion: 1, agentDiscovery: false });
      expect(await readAgentSettings(file, silent)).toEqual({ schemaVersion: 1, agentDiscovery: false });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("切換 agentDiscovery 不會清掉已記錄的 skipped 版本", async () => {
    const dir = await makeDir();
    const settingsFile = path.join(dir, "agentSettings.json");
    const runtimeFile = path.join(dir, "runtime.json");
    try {
      await setSkippedUpdateVersion(settingsFile, { schemaVersion: 1, agentDiscovery: true }, "0.5.1");
      await setAgentDiscovery({
        settingsFile,
        runtimeFile,
        enabled: false,
        skippedUpdateVersion: "0.5.1",
        log: silent,
      });
      expect(await readAgentSettings(settingsFile, silent)).toEqual({
        schemaVersion: 1,
        agentDiscovery: false,
        skippedUpdateVersion: "0.5.1",
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("runtimeFileExists", () => {
  it("只有一般檔案才算可用：目錄、symlink 指向目錄、不存在的路徑都回 false", async () => {
    const dir = await makeDir();
    const runtimeFile = path.join(dir, "runtime.json");
    const link = path.join(dir, "runtime-link.json");
    try {
      // 目錄佔用 runtime 路徑（模擬寫檔失敗後留下的非檔案）→ 不可用。
      await fs.mkdir(runtimeFile);
      expect(await runtimeFileExists(runtimeFile)).toBe(false);

      // symlink 指向目錄（stat 會跟隨 symlink）→ 不可用；Windows 建 symlink 需要額外權限，跳過。
      if (process.platform !== "win32") {
        await fs.symlink(runtimeFile, link, "dir");
        expect(await runtimeFileExists(link)).toBe(false);
      }

      // 一般檔案 → 可用。
      await fs.rm(runtimeFile, { recursive: true, force: true });
      await fs.writeFile(runtimeFile, '{"schemaVersion":1}\n', { mode: 0o600 });
      expect(await runtimeFileExists(runtimeFile)).toBe(true);

      // 不存在 → 不可用。
      expect(await runtimeFileExists(path.join(dir, "missing.json"))).toBe(false);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("resolveStartupDiscovery", () => {
  it("啟動前後設定一致：啟動值就是這次執行的 active 狀態", () => {
    expect(resolveStartupDiscovery({ startup: true, current: true })).toEqual({
      active: true,
      verifyFile: true,
    });
    expect(resolveStartupDiscovery({ startup: false, current: false })).toEqual({
      active: false,
      verifyFile: false,
    });
  });

  it("啟動期間被切換：active=false 且不檢查寫檔（真正原因是「要重啟」）", () => {
    // 啟動時 on、期間被關掉：server 仍以 on 跑著，但設定頁要說「重新啟動後生效」。
    expect(resolveStartupDiscovery({ startup: true, current: false })).toEqual({
      active: false,
      verifyFile: false,
    });
    // 啟動時 off、期間被打開：檔案還沒寫，不能宣稱 active，也不能報寫檔失敗。
    expect(resolveStartupDiscovery({ startup: false, current: true })).toEqual({
      active: false,
      verifyFile: false,
    });
  });
});

describe("setAgentDiscovery", () => {
  it("關閉時立即刪除 runtime 檔並持久化設定", async () => {
    const dir = await makeDir();
    const settingsFile = path.join(dir, "agentSettings.json");
    const runtimeFile = path.join(dir, "data", "runtime.json");
    try {
      await fs.mkdir(path.dirname(runtimeFile), { recursive: true });
      await fs.writeFile(runtimeFile, '{"schemaVersion":1,"token":"synthetic"}\n', { mode: 0o600 });
      expect(await runtimeFileExists(runtimeFile)).toBe(true);

      const result = await setAgentDiscovery({ settingsFile, runtimeFile, enabled: false, log: silent });
      expect(result.error).toBeNull();
      expect(result.runtimeFileRemoved).toBe(true);
      expect(await exists(runtimeFile)).toBe(false);
      expect(await readAgentSettings(settingsFile, silent)).toEqual({ schemaVersion: 1, agentDiscovery: false });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("重新開啟只寫設定（檔案由下次啟動的 server 寫出）", async () => {
    const dir = await makeDir();
    const settingsFile = path.join(dir, "agentSettings.json");
    const runtimeFile = path.join(dir, "data", "runtime.json");
    try {
      await setAgentDiscovery({ settingsFile, runtimeFile, enabled: false, log: silent });
      const result = await setAgentDiscovery({ settingsFile, runtimeFile, enabled: true, log: silent });
      expect(result.error).toBeNull();
      expect(await readAgentSettings(settingsFile, silent)).toEqual({ schemaVersion: 1, agentDiscovery: true });
      expect(await exists(runtimeFile)).toBe(false);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("刪檔失敗時持久化仍成功，但回報「連線資訊檔未清除」", async () => {
    const dir = await makeDir();
    const settingsFile = path.join(dir, "agentSettings.json");
    const runtimeFile = path.join(dir, "runtime.json");
    try {
      // 用非空目錄佔住 runtime 檔路徑：fs.rm(force) 不帶 recursive 會失敗。
      await fs.mkdir(runtimeFile);
      await fs.writeFile(path.join(runtimeFile, "occupied"), "x", "utf8");

      const result = await setAgentDiscovery({ settingsFile, runtimeFile, enabled: false, log: silent });
      expect(result.runtimeFileRemoved).toBe(false);
      expect(result.error).toBe("連線資訊檔未清除");
      expect(await readAgentSettings(settingsFile, silent)).toEqual({ schemaVersion: 1, agentDiscovery: false });
      expect(await exists(runtimeFile)).toBe(true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
