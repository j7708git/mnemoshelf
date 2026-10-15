/**
 * `IndexStatusTracker` 的單元測試：狀態機（idle → running → completed／failed／cancelled）
 * 與 `cancel()` 的語意。
 *
 * 為什麼要單元測試：整輪索引只有在**行程級**錯誤（掃描／儲存層）時才會 `fail`，
 * 單檔失敗已改為記入 `failedFiles`（見 `http.test.ts`）；因此 `fail` 這條路徑用單元測試
 * 直接鎖住語意，不依賴難以穩定重現的整合情境。
 */
import { describe, expect, it } from "vitest";
import type { IndexProgress } from "@mnemoshelf/core";
import { IndexStatusTracker } from "../src/index.js";

const progress: IndexProgress = {
  processed: 1,
  total: 3,
  skippedUnchanged: 0,
  skipped: 0,
  failed: 0,
  processedChunks: 5,
  estimatedChunks: 5,
};

describe("IndexStatusTracker", () => {
  it("未開始過的 root 一律回 idle", () => {
    const tracker = new IndexStatusTracker();
    const status = tracker.status(7);
    expect(status).toMatchObject({ rootId: 7, state: "idle", progress: null, result: null, error: null });
  });

  it("begin → report → finish：完成狀態帶結果與耗時", () => {
    const tracker = new IndexStatusTracker();
    tracker.begin(1);
    expect(tracker.status(1)).toMatchObject({ state: "running", result: null, finishedAt: null });

    tracker.report(1, progress);
    expect(tracker.status(1).progress).toEqual(progress);

    tracker.finish(1, { total: 3, processed: 3, skippedUnchanged: 0, removedFiles: 0, skippedFiles: [], failedFiles: [] });
    const done = tracker.status(1);
    expect(done.state).toBe("completed");
    expect(done.error).toBeNull();
    expect(done.finishedAt).not.toBeNull();
    expect(done.durationMs).not.toBeNull();
    expect(done.result?.processed).toBe(3);
  });

  it("fail：記下錯誤名稱與訊息，不帶堆疊", () => {
    const tracker = new IndexStatusTracker();
    tracker.begin(2);
    const error = new Error("掃描失敗");
    error.name = "ScanError";
    tracker.fail(2, error);

    const status = tracker.status(2);
    expect(status.state).toBe("failed");
    expect(status.error).toEqual({ name: "ScanError", message: "掃描失敗" });
    expect(status.result).toBeNull();
  });

  it("cancel：狀態為 cancelled、error 為 null、result 為 null", () => {
    const tracker = new IndexStatusTracker();
    tracker.begin(3);
    tracker.report(3, progress);
    tracker.cancel(3);

    const status = tracker.status(3);
    expect(status.state).toBe("cancelled");
    expect(status.error).toBeNull();
    expect(status.result).toBeNull();
    expect(status.finishedAt).not.toBeNull();
    // 取消前的最後一次進度仍可讀（UI 可顯示「已取消時處理到哪裡」）。
    expect(status.progress).toEqual(progress);
  });

  it("running 之外的狀態不再接受進度回報；clear 後回 idle", () => {
    const tracker = new IndexStatusTracker();
    tracker.begin(4);
    tracker.report(4, progress);
    tracker.cancel(4);
    tracker.report(4, { ...progress, processed: 99 });
    expect(tracker.status(4).progress).toEqual(progress);

    tracker.clear(4);
    expect(tracker.status(4).state).toBe("idle");
  });
});
