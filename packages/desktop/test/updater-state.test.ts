/**
 * 更新狀態機、錯誤分類、版本比較與 Linux 安裝形式判斷（純函式）。
 *
 * 不啟動 Electron；這些是 IPC 契約與 install 前置判斷的核心。
 */
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyHttpStatus,
  classifyUpdaterError,
  UpdaterFault,
  toUpdaterErrorInfo,
  updaterError,
} from "../src/updater/errors.js";
import { detectLinuxUpdatableForm } from "../src/updater/linux-win.js";
import { compareVersions, isValidVersion, normalizeVersion } from "../src/updater/semver.js";
import { canTransition, createInitialUpdaterState, updaterTrayTooltip } from "../src/updater/state.js";

describe("狀態機轉移", () => {
  it("允許計畫列出的路徑", () => {
    expect(canTransition("idle", "checking")).toBe(true);
    expect(canTransition("checking", "available")).toBe(true);
    expect(canTransition("checking", "idle")).toBe(true);
    expect(canTransition("checking", "error")).toBe(true);
    expect(canTransition("available", "downloading")).toBe(true);
    expect(canTransition("downloading", "downloaded")).toBe(true);
    expect(canTransition("downloaded", "installing")).toBe(true);
    expect(canTransition("available", "idle")).toBe(true);
    expect(canTransition("error", "idle")).toBe(true);
    expect(canTransition("error", "checking")).toBe(true);
    // 只有 backup-failed + force 的續裝會用到；一般 install() 不會從 error 進來。
    expect(canTransition("error", "installing")).toBe(true);
    // 重複事件（checking 收到兩次）不算錯誤。
    expect(canTransition("checking", "checking")).toBe(true);
  });

  it("拒絕跳過中間階段的轉移（例如下載中直接安裝）", () => {
    expect(canTransition("idle", "downloading")).toBe(false);
    expect(canTransition("downloading", "installing")).toBe(false);
    expect(canTransition("idle", "installing")).toBe(false);
    expect(canTransition("available", "installing")).toBe(false);
    expect(canTransition("installing", "downloaded")).toBe(false);
  });

  it("初始狀態是 idle，含目前版本且不含任何路徑", () => {
    const state = createInitialUpdaterState({ currentVersion: "0.4.1", mode: "auto" });
    expect(state).toMatchObject({
      state: "idle",
      mode: "auto",
      currentVersion: "0.4.1",
      availableVersion: null,
      progress: null,
      error: null,
    });
    expect(JSON.stringify(state)).not.toContain(path.sep === "\\" ? "C:\\" : "/tmp");
  });
});

describe("系統匣提示", () => {
  const base = createInitialUpdaterState({ currentVersion: "0.4.1", mode: "auto" });

  it("依狀態顯示版本或下載百分比", () => {
    expect(updaterTrayTooltip(base)).toBe("Mnemoshelf");
    expect(updaterTrayTooltip({ ...base, state: "available", availableVersion: "0.5.1" })).toContain("v0.5.1");
    expect(
      updaterTrayTooltip({
        ...base,
        state: "downloading",
        progress: { percent: 42.6, transferred: 10, total: 20, bytesPerSecond: 1 },
      }),
    ).toContain("43%");
    expect(updaterTrayTooltip({ ...base, state: "downloaded" })).toContain("可安裝");
    expect(updaterTrayTooltip({ ...base, state: "error" })).toContain("失敗");
  });
});

describe("版本比較（semver）", () => {
  it("接受 v 前綴並正規化", () => {
    expect(normalizeVersion("v0.5.1")).toBe("0.5.1");
    expect(normalizeVersion("0.5.1+build.7")).toBe("0.5.1");
    expect(normalizeVersion("v1.0.0-beta.2")).toBe("1.0.0-beta.2");
    expect(normalizeVersion("nightly")).toBeNull();
  });

  it("依 semver precedence 比較", () => {
    expect(compareVersions("v0.5.1", "0.4.1")).toBe(1);
    expect(compareVersions("0.4.1", "0.4.1")).toBe(0);
    expect(compareVersions("0.4.0", "0.4.1")).toBe(-1);
    expect(compareVersions("1.0.0", "1.0.0-beta.2")).toBe(1);
    expect(compareVersions("1.0.0-beta.2", "1.0.0-beta.11")).toBe(-1);
    expect(compareVersions("1.0.0-alpha", "1.0.0-alpha.1")).toBe(-1);
    expect(compareVersions("1.0.0-alpha.1", "1.0.0-alpha.beta")).toBe(-1);
    expect(compareVersions("bad", "1.0.0")).toBeNull();
  });

  it("isValidVersion 對非版本字串回 false", () => {
    expect(isValidVersion("v0.5.1")).toBe(true);
    expect(isValidVersion("0.5")).toBe(false);
  });
});

describe("錯誤分類", () => {
  it("離線類錯誤（Electron net／Node 網路）", () => {
    expect(
      classifyUpdaterError(Object.assign(new Error("net::ERR_INTERNET_DISCONNECTED"), { code: "ERR_INTERNET_DISCONNECTED" }))
        .code,
    ).toBe("offline");
    expect(classifyUpdaterError(new TypeError("fetch failed")).code).toBe("offline");
    expect(classifyUpdaterError(Object.assign(new Error("getaddrinfo ENOTFOUND example"), { code: "ENOTFOUND" })).code).toBe(
      "offline",
    );
  });

  it("404／checksum／簽章／唯讀／tar.gz 的穩定代碼", () => {
    expect(classifyUpdaterError(new Error("ERR_UPDATER_CHANNEL_FILE_NOT_FOUND")).code).toBe("not-found");
    expect(classifyUpdaterError(new Error("ERR_CHECKSUM_MISMATCH sha512")).code).toBe("checksum");
    expect(classifyUpdaterError(new Error("ERR_UPDATER_INVALID_SIGNATURE")).code).toBe("invalid-signature");
    expect(classifyUpdaterError(Object.assign(new Error("EROFS: read-only file system"), { code: "EROFS" })).code).toBe(
      "read-only",
    );
    expect(classifyUpdaterError(new Error("please use the tar.gz build")).code).toBe("unexpected");
  });

  it("未知錯誤用呼叫端給的 fallback，不洩漏原始訊息", () => {
    const info = classifyUpdaterError(new Error("C:\\Users\\someone\\secret\\path?token=abc"), "check-failed");
    expect(info.code).toBe("check-failed");
    expect(info.message).not.toContain("secret");
    expect(info.message).not.toContain("token");
  });

  it("UpdaterFault 保留自己的代碼與訊息", () => {
    const fault = new UpdaterFault("rate-limit");
    expect(toUpdaterErrorInfo(fault, "check-failed")).toEqual(updaterError("rate-limit"));
  });

  it("HTTP 狀態分類", () => {
    expect(classifyHttpStatus(403)?.code).toBe("rate-limit");
    expect(classifyHttpStatus(429)?.code).toBe("rate-limit");
    expect(classifyHttpStatus(404)?.code).toBe("not-found");
    expect(classifyHttpStatus(500)?.code).toBe("check-failed");
    expect(classifyHttpStatus(200)).toBeNull();
  });

  it("錯誤訊息不含路徑或 URL 查詢參數", () => {
    const info = updaterError("offline");
    expect(info.message).not.toMatch(/https?:\/\//);
    expect(info.message).not.toMatch(/[\\/]/);
  });
});

describe("Linux 安裝形式", () => {
  function form(overrides: Partial<Parameters<typeof detectLinuxUpdatableForm>[0]> = {}) {
    return detectLinuxUpdatableForm({
      env: {},
      argv: [],
      execPath: path.join(path.sep, "opt", "Mnemoshelf", "mnemoshelf"),
      ...overrides,
    });
  }

  it("有 APPIMAGE → 可更新", () => {
    expect(form({ env: { APPIMAGE: path.join(path.sep, "tmp", "Mnemoshelf-0.4.1-linux-x86_64.AppImage") } })).toEqual({
      supported: true,
    });
  });

  it("APPIMAGE 缺失 → unsupported-appimage", () => {
    const result = form();
    expect(result.supported).toBe(false);
    if (!result.supported) expect(result.error.code).toBe("unsupported-appimage");
  });

  it("--appimage-extract-and-run／APPIMAGE_EXTRACT_AND_RUN → 視為不支援", () => {
    for (const input of [
      { env: {}, argv: ["--appimage-extract-and-run"] },
      { env: { APPIMAGE_EXTRACT_AND_RUN: "1" }, argv: [] },
    ]) {
      const result = form(input);
      expect(result.supported).toBe(false);
      if (!result.supported) expect(result.error.code).toBe("unsupported-appimage");
    }
  });

  it("tar.gz 解壓目錄 → unsupported-tarball", () => {
    const result = form({
      execPath: path.join(path.sep, "home", "example", "Mnemoshelf-0.4.1-linux-x64", "mnemoshelf"),
    });
    expect(result.supported).toBe(false);
    if (!result.supported) expect(result.error.code).toBe("unsupported-tarball");
  });
});
