/**
 * 更新狀態的純邏輯：事件去重、進度顯示、錯誤文案與分類。
 *
 * 不碰 DOM、不啟動 React；這些函式決定設定頁會不會重複播報、進度怎麼顯示，
 * 以及錯誤代碼對應哪一句使用者看得到的文字。
 */
import { describe, expect, it } from "vitest";
import type { UpdaterErrorInfo, UpdaterProgress, UpdaterState } from "../src/desktop";
import {
  formatBytes,
  isUnsupportedInstallForm,
  isVerificationError,
  mergeUpdaterState,
  progressPercent,
  progressSummary,
  sameUpdaterError,
  sameUpdaterProgress,
  sameUpdaterState,
  updaterErrorMessage,
} from "../src/updaterState";

function baseState(overrides: Partial<UpdaterState> = {}): UpdaterState {
  return {
    state: "idle",
    mode: "auto",
    currentVersion: "0.5.0",
    availableVersion: null,
    releaseNotes: null,
    releaseUrl: null,
    progress: null,
    error: null,
    skippedVersion: null,
    checkedAt: null,
    notice: null,
    ...overrides,
  };
}

function progress(overrides: Partial<UpdaterProgress> = {}): UpdaterProgress {
  return { percent: 0, transferred: 0, total: 0, bytesPerSecond: 0, ...overrides };
}

describe("sameUpdaterError", () => {
  it("兩邊都沒有錯誤時視為相同", () => {
    expect(sameUpdaterError(null, null)).toBe(true);
  });

  it("只有一邊有錯誤時視為不同", () => {
    const error: UpdaterErrorInfo = { code: "offline", message: "沒有網路" };
    expect(sameUpdaterError(null, error)).toBe(false);
    expect(sameUpdaterError(error, null)).toBe(false);
  });

  it("代碼與訊息都一樣才算相同", () => {
    const error: UpdaterErrorInfo = { code: "offline", message: "沒有網路" };
    expect(sameUpdaterError(error, { ...error })).toBe(true);
    expect(sameUpdaterError(error, { ...error, code: "unexpected" })).toBe(false);
    expect(sameUpdaterError(error, { ...error, message: "其他訊息" })).toBe(false);
  });
});

describe("sameUpdaterProgress", () => {
  it("兩邊都沒有進度時視為相同", () => {
    expect(sameUpdaterProgress(null, null)).toBe(true);
    expect(sameUpdaterProgress(null, progress())).toBe(false);
    expect(sameUpdaterProgress(progress(), null)).toBe(false);
  });

  it("四個數字都一樣才算相同", () => {
    const value = progress({ percent: 42, transferred: 1024, total: 4096, bytesPerSecond: 512 });
    expect(sameUpdaterProgress(value, { ...value })).toBe(true);
    expect(sameUpdaterProgress(value, { ...value, percent: 43 })).toBe(false);
    expect(sameUpdaterProgress(value, { ...value, transferred: 2048 })).toBe(false);
    expect(sameUpdaterProgress(value, { ...value, total: 8192 })).toBe(false);
    expect(sameUpdaterProgress(value, { ...value, bytesPerSecond: 0 })).toBe(false);
  });
});

describe("sameUpdaterState", () => {
  it("還沒有目前狀態時一律視為不同（第一次事件一定要套用）", () => {
    expect(sameUpdaterState(null, baseState())).toBe(false);
    expect(sameUpdaterState(undefined, baseState())).toBe(false);
  });

  it("所有顯示欄位相同時視為相同", () => {
    const state = baseState({
      state: "available",
      availableVersion: "0.6.0",
      releaseNotes: "修正內容",
      releaseUrl: "https://example.com/releases/0.6.0",
      checkedAt: "2026-10-28T00:00:00.000Z",
      notice: "提示",
    });
    expect(sameUpdaterState(state, { ...state })).toBe(true);
  });

  it("任一顯示欄位不同就視為不同", () => {
    const state = baseState({ state: "available", availableVersion: "0.6.0" });
    expect(sameUpdaterState(state, { ...state, state: "downloading" })).toBe(false);
    expect(sameUpdaterState(state, { ...state, availableVersion: "0.7.0" })).toBe(false);
    expect(sameUpdaterState(state, { ...state, releaseNotes: "x" })).toBe(false);
    expect(sameUpdaterState(state, { ...state, releaseUrl: "https://example.com" })).toBe(false);
    expect(sameUpdaterState(state, { ...state, skippedVersion: "0.6.0" })).toBe(false);
    expect(sameUpdaterState(state, { ...state, checkedAt: "2026-10-28T01:00:00.000Z" })).toBe(false);
    expect(sameUpdaterState(state, { ...state, notice: "x" })).toBe(false);
    expect(sameUpdaterState(state, { ...state, mode: "manual" })).toBe(false);
    expect(sameUpdaterState(state, { ...state, currentVersion: "0.4.0" })).toBe(false);
  });

  it("巢狀的 error 與 progress 也要比對", () => {
    const state = baseState({
      state: "downloading",
      progress: progress({ percent: 10, transferred: 100, total: 1000 }),
    });
    expect(sameUpdaterState(state, { ...state })).toBe(true);
    expect(sameUpdaterState(state, { ...state, progress: progress({ percent: 11 }) })).toBe(false);

    const failed = baseState({ state: "error", error: { code: "offline", message: "沒有網路" } });
    expect(sameUpdaterState(failed, { ...failed })).toBe(true);
    expect(
      sameUpdaterState(failed, { ...failed, error: { code: "offline", message: "其他訊息" } }),
    ).toBe(false);
  });
});

describe("mergeUpdaterState", () => {
  it("第一次收到事件時直接採用", () => {
    const next = baseState({ state: "checking" });
    expect(mergeUpdaterState(null, next)).toBe(next);
    expect(mergeUpdaterState(undefined, next)).toBe(next);
  });

  it("重複事件回傳同一個參考（React 不重繪）", () => {
    const current = baseState({ state: "checking" });
    expect(mergeUpdaterState(current, { ...current })).toBe(current);
  });

  it("狀態有變時回傳新物件", () => {
    const current = baseState({ state: "checking" });
    const next = { ...current, state: "available" as const, availableVersion: "0.6.0" };
    const merged = mergeUpdaterState(current, next);
    expect(merged).toBe(next);
    expect(merged).not.toBe(current);
  });
});

describe("progressPercent", () => {
  it("沒有進度時是 0", () => {
    expect(progressPercent(null)).toBe(0);
  });

  it("夾在 0–100", () => {
    expect(progressPercent(progress({ percent: -5 }))).toBe(0);
    expect(progressPercent(progress({ percent: 150 }))).toBe(100);
  });

  it("四捨五入成整數", () => {
    expect(progressPercent(progress({ percent: 42.4 }))).toBe(42);
    expect(progressPercent(progress({ percent: 42.5 }))).toBe(43);
  });

  it("非有限數值視為 0", () => {
    expect(progressPercent(progress({ percent: Number.NaN }))).toBe(0);
  });
});

describe("formatBytes", () => {
  it("0 與非正數顯示 0 B", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(-1)).toBe("0 B");
    expect(formatBytes(Number.NaN)).toBe("0 B");
  });

  it("未滿 1024 以位元組顯示", () => {
    expect(formatBytes(1023)).toBe("1023 B");
  });

  it("1024 進位並保留一位小數", () => {
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
    expect(formatBytes(1024 * 1024 * 1.5)).toBe("1.5 MB");
  });
});

describe("progressSummary", () => {
  it("沒有進度時是空字串", () => {
    expect(progressSummary(null)).toBe("");
  });

  it("總大小未知時明說", () => {
    expect(progressSummary(progress({ percent: 12.6, transferred: 1024, total: 0 }))).toBe(
      "13%｜已下載 1.0 KB（總大小未知）",
    );
  });

  it("總大小已知時顯示已下載／總大小", () => {
    expect(progressSummary(progress({ percent: 50, transferred: 512, total: 1024 }))).toBe(
      "50%｜512 B／1.0 KB",
    );
  });
});

describe("updaterErrorMessage", () => {
  it("已知代碼使用固定文案", () => {
    expect(updaterErrorMessage("offline")).toBe("目前沒有網路，請確認連線後再試。");
    expect(updaterErrorMessage("backup-failed")).toContain("請重新啟動應用程式以恢復服務");
  });

  it("未知代碼優先使用 IPC 帶來的訊息", () => {
    expect(updaterErrorMessage("some-new-code", "主行程的訊息")).toBe("主行程的訊息");
  });

  it("未知代碼且沒有可用訊息時用通用句", () => {
    expect(updaterErrorMessage("some-new-code")).toBe("更新時發生錯誤，請稍後再試。");
    expect(updaterErrorMessage("some-new-code", "   ")).toBe("更新時發生錯誤，請稍後再試。");
  });

  it("已移除的 busy 代碼不再有固定文案", () => {
    expect(updaterErrorMessage("busy", "退回主行程訊息")).toBe("退回主行程訊息");
  });
});

describe("錯誤分類", () => {
  it("不支援的安裝形式需要手動更新說明", () => {
    expect(isUnsupportedInstallForm("unsupported-appimage")).toBe(true);
    expect(isUnsupportedInstallForm("unsupported-tarball")).toBe(true);
    expect(isUnsupportedInstallForm("read-only")).toBe(true);
    expect(isUnsupportedInstallForm("offline")).toBe(false);
    expect(isUnsupportedInstallForm("install-failed")).toBe(false);
  });

  it("簽章與完整性錯誤不可說成已是最新", () => {
    expect(isVerificationError("checksum")).toBe(true);
    expect(isVerificationError("invalid-signature")).toBe(true);
    expect(isVerificationError("download-failed")).toBe(false);
    expect(isVerificationError("offline")).toBe(false);
  });
});
