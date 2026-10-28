/**
 * macOS B 案：GitHub API 比版本、只回版本與下載頁；不得載入 electron-updater。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createUpdater, type CreateUpdaterOptions, type UpdaterController } from "../src/updater/index.js";
import { isAllowedReleaseUrl } from "../src/updater/mac.js";
import { FakeAutoUpdater } from "./fakes/updater.js";

const controllers: UpdaterController[] = [];

afterEach(() => {
  for (const controller of controllers) controller.stop();
  controllers.length = 0;
});

function response(status: number, body: unknown): {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
} {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
  };
}

function setup(options: Partial<CreateUpdaterOptions> = {}): {
  controller: UpdaterController;
  loadAutoUpdater: ReturnType<typeof vi.fn>;
  openExternal: ReturnType<typeof vi.fn>;
  fetchImpl: ReturnType<typeof vi.fn>;
} {
  const loadAutoUpdater = vi.fn(async () => {
    throw new Error("macOS 不應載入 electron-updater");
  });
  const openExternal = vi.fn(async () => undefined);
  const fetchImpl = vi.fn(async () =>
    response(200, {
      tag_name: "v0.5.1",
      html_url: "https://github.com/j7708git/mnemoshelf/releases/tag/v0.5.1",
      body: "修正項目",
      draft: false,
      prerelease: false,
    }),
  );
  const controller = createUpdater({
    platform: "darwin",
    currentVersion: "0.4.1",
    isPackaged: true,
    headless: false,
    loadAutoUpdater,
    fetchImpl,
    openExternal,
    closeServerOnly: async () => undefined,
    initialCheckDelayMs: -1,
    checkIntervalMs: 0,
    ...options,
  });
  controllers.push(controller);
  return { controller, loadAutoUpdater, openExternal, fetchImpl };
}

describe("macOS 檢查更新", () => {
  it("GitHub 回 v0.5.1 → available，且不載入 electron-updater", async () => {
    const { controller, loadAutoUpdater, fetchImpl } = setup();
    const state = await controller.check({ manual: true });

    expect(state.state).toBe("available");
    expect(state.mode).toBe("manual");
    expect(state.currentVersion).toBe("0.4.1");
    expect(state.availableVersion).toBe("0.5.1");
    expect(state.releaseUrl).toBe("https://github.com/j7708git/mnemoshelf/releases/tag/v0.5.1");
    expect(state.releaseNotes).toBe("修正項目");
    expect(loadAutoUpdater).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledWith("https://api.github.com/repos/j7708git/mnemoshelf/releases/latest");
  });

  it("openReleasePage 才呼叫 shell.openExternal（由 UI 觸發）", async () => {
    const { controller, openExternal } = setup();
    await controller.check({ manual: true });
    expect(openExternal).not.toHaveBeenCalled();

    const result = await controller.openReleasePage();
    expect(result).toEqual({ opened: true });
    expect(openExternal).toHaveBeenCalledWith("https://github.com/j7708git/mnemoshelf/releases/tag/v0.5.1");
  });

  it("版本相同或較新 → idle（不誤報更新）", async () => {
    const { controller } = setup({
      fetchImpl: vi.fn(async () => response(200, { tag_name: "v0.4.1", html_url: "https://github.com/x/y" })),
    });
    const state = await controller.check({ manual: true });
    expect(state.state).toBe("idle");
    expect(state.availableVersion).toBeNull();
  });

  it("rate limit（403／429）→ rate-limit", async () => {
    for (const status of [403, 429]) {
      const { controller } = setup({ fetchImpl: vi.fn(async () => response(status, { message: "rate limit" })) });
      const state = await controller.check({ manual: true });
      expect(state.state).toBe("error");
      expect(state.error?.code).toBe("rate-limit");
    }
  });

  it("離線（fetch 丟錯）→ offline", async () => {
    const { controller } = setup({
      fetchImpl: vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    });
    const state = await controller.check({ manual: true });
    expect(state.state).toBe("error");
    expect(state.error?.code).toBe("offline");
  });

  it("404 → not-found；非合法 tag → invalid-version", async () => {
    const notFound = setup({ fetchImpl: vi.fn(async () => response(404, { message: "Not Found" })) });
    expect((await notFound.controller.check({ manual: true })).error?.code).toBe("not-found");

    const invalid = setup({ fetchImpl: vi.fn(async () => response(200, { tag_name: "nightly" })) });
    expect((await invalid.controller.check({ manual: true })).error?.code).toBe("invalid-version");
  });

  it("draft／prerelease 不建議安裝", async () => {
    const { controller } = setup({
      fetchImpl: vi.fn(async () =>
        response(200, {
          tag_name: "v0.5.1",
          html_url: "https://github.com/j7708git/mnemoshelf/releases/tag/v0.5.1",
          prerelease: true,
        }),
      ),
    });
    expect((await controller.check({ manual: true })).state).toBe("idle");
  });

  it("html_url 不是 GitHub https 頁面時，改用由版本組出的下載頁", async () => {
    const { controller } = setup({
      fetchImpl: vi.fn(async () =>
        response(200, {
          tag_name: "v0.5.1",
          html_url: "javascript:alert(1)",
          body: "",
        }),
      ),
    });
    const state = await controller.check({ manual: true });
    expect(state.releaseUrl).toBe("https://github.com/j7708git/mnemoshelf/releases/tag/v0.5.1");
  });

  it("mac.ts 原始碼沒有載入／實例化 electron-updater（靜態檢查）", async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(new URL("../src/updater/mac.ts", import.meta.url), "utf8");
    expect(source).not.toContain("electron-updater");
    expect(source).not.toContain("MacUpdater");
    expect(source).not.toMatch(/from\s+["']electron["']/);
  });

  it("安裝／下載在 macOS 是 no-op（不誤觸 electron-updater）", async () => {
    const { controller, loadAutoUpdater } = setup();
    await controller.check({ manual: true });
    await controller.download();
    await controller.install();
    expect(controller.getState().state).toBe("available");
    expect(loadAutoUpdater).not.toHaveBeenCalled();
  });
});

describe("Release URL 白名單", () => {
  it("只接受 https 的 github.com 頁面", () => {
    expect(isAllowedReleaseUrl("https://github.com/j7708git/mnemoshelf/releases/tag/v0.5.1")).toBe(true);
    expect(isAllowedReleaseUrl("http://github.com/j7708git/mnemoshelf")).toBe(false);
    expect(isAllowedReleaseUrl("https://evil.example/releases")).toBe(false);
    expect(isAllowedReleaseUrl("https://github.com.evil.example/x")).toBe(false);
    expect(isAllowedReleaseUrl("javascript:alert(1)")).toBe(false);
  });
});

describe("fake updater 在 macOS 完全不被使用", () => {
  it("start() 不會建立 electron-updater（即使注入 fake）", async () => {
    const fake = new FakeAutoUpdater();
    const loadAutoUpdater = vi.fn(async () => fake);
    const { controller } = setup({ loadAutoUpdater });
    await controller.start();
    expect(loadAutoUpdater).not.toHaveBeenCalled();
    expect(fake.listenerCount("update-available")).toBe(0);
  });
});
