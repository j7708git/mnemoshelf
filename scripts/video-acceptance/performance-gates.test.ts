import { describe, expect, it } from "vitest";
import { cancellationAcknowledged, evaluateBound, fairnessObserved, samplerClosedCleanly } from "./performance-gates.mjs";

describe("效能驗收判定", () => {
  it("三個相關命中區間須完全落在時限內；跨界不算通過", () => {
    const trials = (lower: number, upper: number) => Array.from({ length: 3 }, () => ({ firstRelevantObservation: { afterMs: lower, byMs: upper } }));
    expect(evaluateBound(trials(40, 59), 60)).toBe("pass");
    expect(evaluateBound(trials(59, 61), 60)).toBe("inconclusive");
    expect(evaluateBound(trials(61, 62), 60)).toBe("fail");
    expect(evaluateBound(trials(1, 2).slice(0, 2), 60)).toBe("unmeasured");
  });
  it("取消回應及索引結果都須對同一 root 確認取消", () => {
    const valid = { rootId: 3, response: { rootId: 3, cancelled: true }, indexResult: { rootId: 3, cancelled: true } };
    expect(cancellationAcknowledged(valid)).toBe(true);
    expect(cancellationAcknowledged({ ...valid, response: { rootId: 3, cancelled: false } })).toBe(false);
    expect(cancellationAcknowledged({ ...valid, indexResult: { rootId: 4, cancelled: true } })).toBe(false);
    expect(cancellationAcknowledged({ ...valid, indexResult: { rootId: 3, cancelled: false } })).toBe(false);
  });
  it("公平性必須觀測三種短工作皆在長片前完成", () => {
    const results = ["long-video", "short-video", "wav", "text"].map((kind) => ({ kind, valid: true, finishedBeforeLong: kind === "long-video" ? null : true }));
    expect(fairnessObserved(results)).toBe(true);
    expect(fairnessObserved(results.map((item) => item.kind === "wav" ? { ...item, finishedBeforeLong: false } : item))).toBe(false);
    expect(fairnessObserved(results.slice(0, 3))).toBe(false);
  });
  it("關閉後有錯誤、待處理樣本或寫檔錯誤均不能算完整", () => {
    const closed = { samplerError: null, pendingSamples: 0 };
    expect(samplerClosedCleanly(closed, null)).toBe(true);
    expect(samplerClosedCleanly({ ...closed, samplerError: "sampler-close-timeout" }, null)).toBe(false);
    expect(samplerClosedCleanly({ ...closed, pendingSamples: 1 }, null)).toBe(false);
    expect(samplerClosedCleanly(closed, "sample-log-write-failed")).toBe(false);
  });
});
