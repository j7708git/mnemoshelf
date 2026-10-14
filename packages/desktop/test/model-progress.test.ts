import { describe, expect, it } from "vitest";
import { ModelProgressTracker } from "../src/model-progress.js";

describe("ModelProgressTracker", () => {
  it("把 progress_total 的檔案清單當成正確的分母", () => {
    const tracker = new ModelProgressTracker();
    const snapshot = tracker.handle({
      status: "progress_total",
      files: { "a.bin": { loaded: 0, total: 100 }, "b.bin": { loaded: 0, total: 300 } },
    });
    expect(snapshot).toMatchObject({ loaded: 0, total: 400, percent: 0, filesKnown: 2 });
  });

  it("累積多個檔案的位元組並算出百分比", () => {
    const tracker = new ModelProgressTracker();
    tracker.handle({ status: "progress_total", files: { "a.bin": { loaded: 0, total: 100 }, "b.bin": { loaded: 0, total: 100 } } });
    tracker.handle({ status: "download", file: "a.bin" });
    const half = tracker.handle({ status: "progress", file: "a.bin", loaded: 50, total: 100 });
    expect(half).toMatchObject({ loaded: 50, total: 200, percent: 25, currentFile: "a.bin", downloadedBytes: 50 });

    const done = tracker.handle({ status: "progress", file: "b.bin", loaded: 100, total: 100 });
    expect(done).toMatchObject({ loaded: 150, total: 200, percent: 75, filesDone: 1, filesKnown: 2 });
  });

  it("沿用磁碟上已完成的檔案：重試時進度不會從 0 開始", () => {
    const tracker = new ModelProgressTracker({ preloaded: { "a.bin": 100 } });
    const snapshot = tracker.handle({ status: "progress_total", files: { "a.bin": { loaded: 0, total: 100 }, "b.bin": { loaded: 0, total: 100 } } });
    expect(snapshot).toMatchObject({ loaded: 100, total: 200, percent: 50, reusedBytes: 100, downloadedBytes: 0 });

    const after = tracker.handle({ status: "progress", file: "b.bin", loaded: 100, total: 100 });
    expect(after).toMatchObject({ loaded: 200, total: 200, percent: 100, reusedBytes: 100, downloadedBytes: 100, filesDone: 2 });
  });

  it("沒有 progress_total 時用看過的檔案自己當分母（processor 階段）", () => {
    const tracker = new ModelProgressTracker();
    tracker.handle({ status: "progress", file: "tokenizer.json", loaded: 30, total: 60 });
    const snapshot = tracker.handle({ status: "progress", file: "processor_config.json", loaded: 10, total: 40 });
    expect(snapshot).toMatchObject({ loaded: 40, total: 100, percent: 40, filesKnown: 2 });
  });

  it("同一檔案的回報不會倒退（後續較小的數值被忽略）", () => {
    const tracker = new ModelProgressTracker();
    tracker.handle({ status: "progress", file: "a.bin", loaded: 80, total: 100 });
    const snapshot = tracker.handle({ status: "progress", file: "a.bin", loaded: 10, total: 100 });
    expect(snapshot.loaded).toBe(80);
  });

  it("Windows 風格的檔案 key 會與 POSIX 風格的預載資料對上", () => {
    const tracker = new ModelProgressTracker({ preloaded: { "onnx/model_q4.onnx_data": 100 } });
    const snapshot = tracker.handle({
      status: "progress_total",
      files: { "onnx\\model_q4.onnx_data": { loaded: 0, total: 100 } },
    });
    expect(snapshot).toMatchObject({ loaded: 100, total: 100, percent: 100, reusedBytes: 100 });
  });

  it("未知形狀的訊息只回傳現況", () => {
    const tracker = new ModelProgressTracker();
    expect(tracker.handle(null)).toMatchObject({ loaded: 0, total: 0, percent: 0 });
    expect(tracker.handle({ status: "ready" })).toMatchObject({ percent: 0 });
  });
});
