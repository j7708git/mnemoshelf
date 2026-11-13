import { describe, expect, it } from "vitest";
import { hasNativeWebGpu } from "../src/webgpu.js";

describe("原生 WebGPU 後端列舉", () => {
  it("只有 bundled WebGPU 才通過", () => {
    expect(hasNativeWebGpu(() => [{name:"webgpu", bundled:true}])).toBe(true);
    expect(hasNativeWebGpu(() => [{name:"webgpu", bundled:false}, {name:"cpu", bundled:true}])).toBe(false);
    expect(hasNativeWebGpu(() => [])).toBe(false);
  });
  it("列舉例外交由呼叫端決定退回", () => {
    expect(() => hasNativeWebGpu(() => { throw new Error("unavailable"); })).toThrow("unavailable");
  });
});
