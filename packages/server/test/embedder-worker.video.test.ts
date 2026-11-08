/**
 * embedder worker 的**影片協定**測試（worker 側）。
 *
 * worker 端 `TransformersEmbedder` 以假類別替換（不載入模型），只驗證協定：
 * 已解碼幀有沒有原樣（含像素與 timestamp）送到 worker、取消 signal 有沒有轉發、
 * `videoState` 的 loading／ready 狀態有沒有回報、以及非法幀序列在 worker 端仍被拒絕。
 * 真實 adapter 的行為見 `@mnemoshelf/embedder-transformers` 的測試。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EmbedderRuntimeStatus } from "@mnemoshelf/core";
import type { VideoInput } from "@mnemoshelf/embedder-transformers";
import { startEmbedderWorker } from "../src/embedder-worker.js";

const state = vi.hoisted(() => ({
  received: null as VideoInput["frames"] | null,
  signal: null as AbortSignal | null,
  gate: null as Promise<void> | null,
  failure: null as Error | null,
  initialVideoState: "not-loaded" as NonNullable<EmbedderRuntimeStatus["videoState"]>,
}));

vi.mock("@mnemoshelf/embedder-transformers", async (importOriginal) => {
  // 真正的 `assertVideoInput` 留著用：worker 端的防禦性驗證也要跑同一組規則。
  const actual = await importOriginal<typeof import("@mnemoshelf/embedder-transformers")>();
  class FakeTransformersEmbedder {
    info = { id: "fake-video@test", dim: 2, capabilities: { text: true, image: true, audio: true, video: true } };
    runtimeStatus: EmbedderRuntimeStatus = {
      requestedDevice: "cpu",
      device: "cpu",
      loaded: false,
      fallbackReason: null,
      batchSize: 1,
      serializedInference: true,
      dmlDeviceId: 0,
      videoState: state.initialVideoState,
    };
    async embedVideo(video: VideoInput, opts: { signal?: AbortSignal }): Promise<Float32Array> {
      state.received = video.frames;
      state.signal = opts.signal ?? null;
      if (state.gate !== null) await state.gate;
      if (state.failure !== null) {
        this.runtimeStatus.videoState = "failed";
        throw state.failure;
      }
      opts.signal?.throwIfAborted();
      this.runtimeStatus.videoState = "ready";
      this.runtimeStatus.loaded = true;
      return Float32Array.of(1, 0);
    }
  }
  return { ...actual, TransformersEmbedder: FakeTransformersEmbedder };
});

/** 4×4 RGB 合成影格。 */
function videoFrame(index: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const pixels = new Uint8Array(4 * 4 * 3);
  for (let i = 0; i < pixels.length; i += 1) pixels[i] = (index * 7 + i) % 256;
  return { pixels, width: 4, height: 4, channels: 3, timestampSeconds: index * 0.25, ...overrides };
}

function portHarness() {
  let receive!: (message: unknown) => void;
  const posted: Array<{ message: Record<string, unknown>; transfer: readonly unknown[] }> = [];
  startEmbedderWorker({
    on: (_event, listener) => { receive = listener; },
    postMessage: (message, transfer = []) => {
      posted.push({ message: message as Record<string, unknown>, transfer });
    },
  });
  receive({ type: "init", options: {} });
  return { receive, posted };
}

beforeEach(() => {
  state.received = null;
  state.signal = null;
  state.gate = null;
  state.failure = null;
  state.initialVideoState = "not-loaded";
});

describe("embedder worker 影片協定", () => {
  it("傳入已解碼幀與取消 signal、回報 loading、transfer 向量並在成功後回報 ready", async () => {
    const { receive, posted } = portHarness();
    const frames = [videoFrame(0), videoFrame(1)];
    receive({ type: "request", id: 1, method: "embedVideo", params: { frames } });
    await vi.waitFor(() => expect(posted.some(({ message }) => message.type === "response")).toBe(true));

    expect(state.received).toHaveLength(2);
    expect(state.received![0]).toMatchObject({ width: 4, height: 4, channels: 3, timestampSeconds: 0 });
    expect(state.received![1]).toMatchObject({ timestampSeconds: 0.25 });
    expect(state.signal).toBeInstanceOf(AbortSignal);
    expect(
      posted.some(({ message }) =>
        message.type === "status" &&
        (message.runtimeStatus as EmbedderRuntimeStatus).videoState === "loading"),
    ).toBe(true);

    const response = posted.at(-1)!;
    expect(response.message).toMatchObject({
      type: "response",
      id: 1,
      ok: true,
      runtimeStatus: { videoState: "ready", loaded: true },
    });
    expect(response.transfer).toHaveLength(1);
    expect(response.transfer[0]).toBe((response.message.result as Float32Array).buffer);
  });

  it("在途 cancel 會傳到影片方法；native 邊界後以 AbortError 回應", async () => {
    let release!: () => void;
    state.gate = new Promise<void>((resolve) => { release = resolve; });
    const { receive, posted } = portHarness();
    receive({ type: "request", id: 2, method: "embedVideo", params: { frames: [videoFrame(0)] } });
    receive({ type: "cancel", id: 2 });
    expect(state.signal?.aborted).toBe(true);
    expect(posted.some(({ message }) => message.type === "response")).toBe(false);
    release();
    await vi.waitFor(() =>
      expect(posted.at(-1)!.message).toMatchObject({
        type: "response",
        id: 2,
        ok: false,
        error: { name: "AbortError" },
      }));
  });

  it("非法幀序列在 worker 端仍被拒；模型方法不被呼叫", async () => {
    const { receive, posted } = portHarness();
    const invalid = [
      // 通道數不合法
      { frames: [videoFrame(0, { channels: 2 })] },
      // 像素長度不符
      { frames: [videoFrame(0, { pixels: new Uint8Array(1) })] },
      // 超過 32 幀
      { frames: Array.from({ length: 33 }, (_, index) => videoFrame(index, { width: 1, height: 1, pixels: new Uint8Array(3) })) },
      // 缺少 frames
      {},
    ];
    for (const [index, params] of invalid.entries()) {
      receive({ type: "request", id: 10 + index, method: "embedVideo", params });
      await vi.waitFor(() => expect(posted.at(-1)!.message).toMatchObject({
        type: "response",
        id: 10 + index,
        ok: false,
        error: { name: "EmbedderInputError" },
      }));
    }
    expect(state.received).toBeNull();
  });

  it("videoState 已是 disabled 時不送 loading；具名 VideoUnsupportedError 保留名稱", async () => {
    state.initialVideoState = "disabled";
    const { receive, posted } = portHarness();
    state.failure = Object.assign(new Error("模型不支援影片"), {
      name: "VideoUnsupportedError",
      code: "video-unsupported",
    });
    receive({ type: "request", id: 3, method: "embedVideo", params: { frames: [videoFrame(0)] } });
    await vi.waitFor(() =>
      expect(posted.at(-1)!.message).toMatchObject({
        type: "response",
        id: 3,
        ok: false,
        error: { name: "VideoUnsupportedError", code: "video-unsupported" },
      }));
    expect(posted.some(({ message }) => message.type === "status")).toBe(false);
  });
});
