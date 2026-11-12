import { describe, expect, it } from "vitest";
import { describeEmbedderRuntime, selfTestSummary } from "../src/SettingsPanel";
import type { DiagnosticsEmbedderRuntime } from "../src/api";

const cpu: DiagnosticsEmbedderRuntime = {
  requestedDevice: "cpu", device: "cpu", loaded: false, fallbackReason: null,
  batchSize: 16, serializedInference: false, dmlDeviceId: null,
};
const webgpu: DiagnosticsEmbedderRuntime = {
  ...cpu, requestedDevice: "webgpu", device: "webgpu", batchSize: 8,
  batchTokenBudget: 2700, serializedInference: true,
};

describe("設定頁的執行裝置", () => {
  it("保留讀取中、缺少診斷與讀取失敗的區別", () => {
    expect(describeEmbedderRuntime(undefined)).toBe("讀取中…");
    expect(describeEmbedderRuntime(null)).toContain("未提供");
    expect(describeEmbedderRuntime(cpu, "連線失敗")).toBe("讀取裝置資訊失敗：連線失敗");
  });

  it("CPU 預設顯示計畫值，舊服務沒有選配欄位仍可顯示", () => {
    const text = describeEmbedderRuntime(cpu);
    expect(text).toContain("目前裝置：CPU");
    expect(text).toContain("設定裝置：CPU");
    expect(text).toContain("模型尚未載入");
    expect(text).not.toContain("WebGPU");
    expect(text).not.toContain("手動指定");
  });

  it("WebGPU 尚未探測與通過有不同說明，不挪用 CoreML 自測", () => {
    expect(describeEmbedderRuntime(webgpu)).toContain("WebGPU 探測：尚未完成");
    const text = describeEmbedderRuntime({
      ...webgpu, loaded: true, webgpuProbe: { status: "passed" }, selfTest: { outcome: "usable" },
    });
    expect(text).toContain("目前裝置：WebGPU（GPU）");
    expect(text).toContain("WebGPU 探測：通過");
    expect(text).toContain("8 筆、2700 tokens（含 padding）");
    expect(text).not.toContain("CoreML");
    expect(text).not.toContain("模型尚未載入");
  });

  it("退回時保留要求裝置、探測失敗代碼與實際 CPU 原因", () => {
    const text = describeEmbedderRuntime({
      ...webgpu, device: "cpu", loaded: true, webgpuProbe: { status: "failed", reason: "backend-unavailable" },
      fallbackReason: { code: "backend-unavailable", message: "原生 WebGPU 後端不可用，已改用 CPU。" },
    });
    expect(text).toContain("目前裝置：CPU");
    expect(text).toContain("要求裝置：WebGPU");
    expect(text).toContain("失敗（backend-unavailable）");
    expect(text).toContain("原生 WebGPU 後端不可用，已改用 CPU。");
  });

  it("音訊後的 CPU 政策保留已通過的 WebGPU 探測", () => {
    const text = describeEmbedderRuntime({
      ...webgpu, device: "cpu", loaded: true, webgpuProbe: { status: "passed" },
      fallbackReason: { code: "audio-cpu", message: "音訊使用 CPU，共享文字與圖片模型也改用 CPU。" },
    });
    expect(text).toContain("目前裝置：CPU");
    expect(text).toContain("WebGPU 探測：通過");
    expect(text).toContain("音訊使用 CPU");
  });

  it("保留既有明示裝置與 CoreML auto 自測說明", () => {
    expect(describeEmbedderRuntime({ ...cpu, requestedDevice: "auto", device: "coreml" })).toContain("自動偵測：未測試");
    expect(describeEmbedderRuntime({ ...cpu, requestedDevice: "dml", device: "dml" })).toContain("DirectML");
    expect(selfTestSummary({ outcome: "usable", throughputRatio: 2, minCosine: 0.999 })).toContain("吞吐 2.00×");
    expect(selfTestSummary({ outcome: "unusable" })).toContain("已改用 CPU");
    expect(selfTestSummary({ outcome: "crashed" })).toContain("曾造成行程結束");
  });
});
