import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  available: true, failLoad: false, failRun: false, failCpu: false, invalidShape: false,
  gate: null as Promise<void> | null, entered: null as (() => void) | null,
  processorGate: null as Promise<void> | null, processorEntered: null as (() => void) | null,
  length: 100, runs: [] as { device: string; batch: number; tokens: number }[], loads: [] as string[], disposed: [] as string[],
}));
vi.mock("../src/webgpu.js", () => ({ hasNativeWebGpu: () => state.available }));
vi.mock("@huggingface/transformers", () => ({
  env: {}, RawImage: class {}, RawVideo: class {}, RawVideoFrame: class {},
  load_image: async () => ({}),
  AutoConfig: { from_pretrained: async () => ({}) },
  AutoProcessor: { from_pretrained: async () => {
    const processor = async (texts: string[] | null) => {
      state.processorEntered?.(); if (state.processorGate) await state.processorGate;
      const batch = texts?.length ?? 1;
      return { texts, input_ids: { dims: state.invalidShape ? [] : [batch, state.length] } };
    };
    return Object.assign(processor, { image_processor: {}, video_processor: {} });
  } },
  AutoModel: { from_pretrained: async (_id: string, opts: { device: string }) => {
    const device = opts.device; state.loads.push(device);
    if (device === "webgpu" && state.failLoad) throw new Error("private path");
    const model = async (inputs: { texts: string[] | null; input_ids: { dims: number[] } }) => {
      const [batch = 1, length = 1] = inputs.input_ids.dims;
      state.runs.push({ device, batch, tokens: batch * length });
      state.entered?.(); if (state.gate) await state.gate;
      if ((device === "webgpu" && state.failRun) || (device === "cpu" && state.failCpu)) throw new Error("run failed");
      return { sentence_embedding: { dims: [batch, 768], tolist: async () => Array.from({length: batch}, (_, index) => { const id = Number(inputs.texts?.[index]?.match(/text: (\d+)$/)?.[1] ?? 0); return [id + 1, 1, ...Array(766).fill(0)]; }) } };
    };
    return Object.assign(model, { dispose: async () => { state.disposed.push(device); } });
  } },
}));
import { TransformersEmbedder } from "../src/embedder.js";
import { resolveEmbedDevice, parseEmbedDeviceOption } from "../src/device.js";

const gpu = () => new TransformersEmbedder({ device: "webgpu", platform: "darwin", arch: "arm64", cacheDir: "unused" });
beforeEach(() => { state.available = true; state.failLoad = false; state.failRun = false; state.failCpu = false; state.invalidShape = false; state.gate = null; state.entered = null; state.processorGate = null; state.processorEntered = null; state.length = 100; state.runs = []; state.loads = []; state.disposed = []; });
describe("WebGPU 裝置與預算", () => {
  it("預設 CPU、auto 沿用舊政策、WebGPU 只在 macOS arm64 啟用", () => {
    expect(parseEmbedDeviceOption(undefined)).toBe("cpu");
    expect(resolveEmbedDevice("auto", "darwin", "arm64").device).toBe("coreml");
    expect(resolveEmbedDevice("webgpu", "darwin", "arm64").device).toBe("webgpu");
    expect(resolveEmbedDevice("webgpu", "darwin", "x64").fallbackReason?.code).toBe("unsupported-platform");
  });
  it("實際探測文字與圖片，再依含 padding 的預算縮窗", async () => {
    const e = gpu(); expect(e.runtimeStatus.webgpuProbe?.status).toBe("pending");
    await e.embedQuery("warmup");
    expect(e.runtimeStatus.webgpuProbe?.status).toBe("passed");
    state.runs = []; state.length = 800;
    const result = await e.embedDocuments(Array.from({length: 9}, (_, i) => ({text: String(i)})));
    expect(result).toHaveLength(9);
    expect(result.map(v => Math.round(v[0]! / v[1]!))).toEqual([1,2,3,4,5,6,7,8,9]);
    expect(state.runs.map(r => r.batch)).toEqual([3, 3, 3]);
    expect(state.runs.every(r => r.tokens <= 2700)).toBe(true);
    await e.dispose();
  });
  it("2700 邊界送 GPU；2701 完整退 CPU", async () => {
    const e = gpu(); await e.embedQuery("warmup"); state.runs = [];
    state.length = 2700; await e.embedQuery("edge");
    state.length = 2701; await e.embedQuery("over");
    expect(state.runs).toEqual([{device:"webgpu", batch:1, tokens:2700}, {device:"cpu", batch:1, tokens:2701}]);
    await e.dispose();
  });
  it("合法單筆超過預算時永久退回 CPU，完整處理", async () => {
    const e = gpu(); await e.embedQuery("warmup"); state.runs = []; state.length = 3000;
    await e.embedQuery("large");
    expect(e.runtimeStatus.fallbackReason?.code).toBe("token-budget");
    expect(state.runs).toEqual([{device:"cpu", batch:1, tokens:3000}]);
    expect(state.disposed).toContain("webgpu"); await e.dispose();
  });
  it("探測推論失敗時記錄 probe-failed，釋放後改用 CPU", async () => {
    state.failRun = true; const e = gpu(); await e.embedQuery("x");
    expect(e.runtimeStatus.webgpuProbe).toEqual({status:"failed", reason:"probe-failed"});
    expect(e.runtimeStatus.fallbackReason?.code).toBe("probe-failed");
    expect(state.disposed).toContain("webgpu"); expect(state.loads).toEqual(["webgpu", "cpu"]); await e.dispose();
  });
  it("輸入錯誤和超過模型上限不觸發 GPU 退回", async () => {
    const e = gpu(); await e.embedQuery("warmup"); state.length = 8193; state.runs = [];
    await expect(e.embedQuery("too long")).rejects.toMatchObject({code:"input-too-long"});
    await expect(e.embedImage({bytes: new Uint8Array()})).rejects.toThrow();
    expect(e.runtimeStatus.device).toBe("webgpu"); expect(e.runtimeStatus.fallbackReason).toBeNull();
    expect(state.runs).toEqual([]); await e.dispose();
  });
  it("後端不可用及載入失敗各只退一次", async () => {
    state.available = false; const a = gpu(); await a.embedQuery("x"); await a.embedQuery("y");
    expect(a.runtimeStatus.webgpuProbe).toEqual({status:"failed", reason:"backend-unavailable"});
    expect(state.loads).toEqual(["cpu"]); await a.dispose();
    state.available = true; state.failLoad = true; state.loads = []; const b = gpu(); await b.embedQuery("x");
    expect(b.runtimeStatus.fallbackReason?.code).toBe("load-failed"); expect(state.loads).toEqual(["webgpu", "cpu"]); await b.dispose();
  });
  it("推論失敗只退一次；CPU 失敗向外拋", async () => {
    const e = gpu(); await e.embedQuery("warmup"); state.failRun = true; state.failCpu = true;
    await expect(e.embedQuery("x")).rejects.toThrow();
    expect(e.runtimeStatus.fallbackReason?.code).toBe("inference-failed");
    expect(state.loads).toEqual(["webgpu", "cpu"]); await e.dispose();
  });
  it("圖片與影片實際 token 超過預算時由 CPU 完整處理", async () => {
    for (const modality of ["image", "video"] as const) {
      state.length = 100; const e = gpu(); await e.embedQuery("warmup"); state.runs = []; state.length = 3000;
      if (modality === "image") await e.embedImage({bytes: new Uint8Array([1])});
      else await e.embedVideo({frames:[{pixels: new Uint8Array(3), width:1, height:1, channels:3, timestampSeconds:0}]});
      expect(state.runs).toEqual([{device:"cpu", batch:1, tokens:3000}]);
      expect(e.runtimeStatus.fallbackReason?.code).toBe("token-budget"); await e.dispose();
    }
  });
  it("批次前處理期間取消不啟動模型，也不退回 CPU", async () => {
    const e = gpu(); await e.embedQuery("warmup"); state.runs = [];
    const controller = new AbortController();
    let release!: () => void; state.processorGate = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; }); state.processorEntered = entered;
    const op = e.embedDocuments([{text:"x"}], {signal:controller.signal}); await started; controller.abort(); release();
    await expect(op).rejects.toMatchObject({name:"AbortError"});
    expect(state.runs).toEqual([]); expect(e.runtimeStatus.device).toBe("webgpu");
    expect(e.runtimeStatus.fallbackReason).toBeNull(); await e.dispose();
  });
  it("探測文字前處理期間取消不啟動模型，狀態保持 pending", async () => {
    const e = gpu(); const controller = new AbortController();
    let release!: () => void; state.processorGate = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; }); state.processorEntered = entered;
    const op = e.embedDocuments([{text:"x"}], {signal:controller.signal}); await started; controller.abort(); release();
    await expect(op).rejects.toMatchObject({name:"AbortError"});
    expect(state.runs).toEqual([]); expect(e.runtimeStatus.webgpuProbe?.status).toBe("pending");
    expect(e.runtimeStatus.device).toBe("webgpu"); expect(e.runtimeStatus.fallbackReason).toBeNull(); await e.dispose();
  });
  it("探測圖片前處理期間取消不啟動圖片推論", async () => {
    const e = gpu(); const controller = new AbortController(); let count = 0;
    let release!: () => void; let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    state.processorEntered = () => { if (++count === 2) { state.processorGate = new Promise<void>(resolve => { release = resolve; }); entered(); } };
    const op = e.embedDocuments([{text:"x"}], {signal:controller.signal}); await started; controller.abort(); release();
    await expect(op).rejects.toMatchObject({name:"AbortError"});
    expect(state.runs).toHaveLength(1); expect(e.runtimeStatus.webgpuProbe?.status).toBe("pending");
    expect(e.runtimeStatus.device).toBe("webgpu"); expect(e.runtimeStatus.fallbackReason).toBeNull(); await e.dispose();
  });
  it("探測期間取消會釋放模型並保留待探測狀態", async () => {
    const e = gpu(); const controller = new AbortController();
    let release!: () => void; state.gate = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; }); state.entered = entered;
    const op = e.embedDocuments([{text:"x"}], {signal:controller.signal}); await started; controller.abort(); release();
    await expect(op).rejects.toMatchObject({name:"AbortError"});
    expect(e.runtimeStatus.webgpuProbe?.status).toBe("pending"); expect(e.runtimeStatus.device).toBe("webgpu");
    expect(state.disposed).toEqual(["webgpu"]); state.gate = null; state.entered = null;
    await e.embedQuery("again"); expect(e.runtimeStatus.webgpuProbe?.status).toBe("passed"); await e.dispose();
  });
  it("推論錯誤退回與佇列操作及 dispose 不重疊", async () => {
    const e = gpu(); await e.embedQuery("warmup"); state.failRun = true;
    let release!: () => void; state.gate = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; }); state.entered = entered;
    const first = e.embedQuery("one"); await started;
    const second = e.embedQuery("two"); const closing = e.dispose();
    expect(state.disposed).toEqual([]); state.gate = null; state.entered = null; release();
    await Promise.all([first, second, closing]);
    expect(state.loads).toEqual(["webgpu", "cpu"]); expect(state.disposed).toEqual(["webgpu", "cpu"]);
  });
  it("缺少 token 形狀不把負載送進 GPU", async () => {
    const e = gpu(); await e.embedQuery("warmup"); state.runs = []; state.invalidShape = true;
    await e.embedQuery("x"); expect(state.runs.every(r => r.device === "cpu")).toBe(true);
    expect(e.runtimeStatus.fallbackReason?.code).toBe("token-budget"); await e.dispose();
  });
});
