import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AudioInput, EmbedderRuntimeStatus } from "@mnemoshelf/core";
import { startEmbedderWorker } from "../src/embedder-worker.js";

const state = vi.hoisted(() => ({
  received: null as AudioInput | null,
  signal: null as AbortSignal | null,
  gate: null as Promise<void> | null,
  failure: null as Error | null,
}));

vi.mock("@mnemoshelf/embedder-transformers", () => ({
  TransformersEmbedder: class {
    info = { id: "fake-audio@test", dim: 2, capabilities: { text: true, image: true, audio: true, video: false } };
    runtimeStatus: EmbedderRuntimeStatus = {
      requestedDevice: "cpu", device: "cpu", loaded: false, fallbackReason: null,
      batchSize: 1, serializedInference: true, dmlDeviceId: 0, audioState: "not-loaded",
    };
    async embedAudio(input: AudioInput, opts: { signal?: AbortSignal }): Promise<Float32Array> {
      state.received = input;
      state.signal = opts.signal ?? null;
      if (state.gate) await state.gate;
      if (state.failure) {
        this.runtimeStatus.audioState = "failed";
        throw state.failure;
      }
      opts.signal?.throwIfAborted();
      this.runtimeStatus.audioState = "ready";
      this.runtimeStatus.loaded = true;
      return Float32Array.of(1, 0);
    }
  },
}));

function portHarness() {
  let receive!: (message: unknown) => void;
  const posted: Array<{ message: Record<string, unknown>; transfer: readonly unknown[] }> = [];
  startEmbedderWorker({
    on: (_event, listener) => { receive = listener; },
    postMessage: (message, transfer = []) => { posted.push({ message: message as Record<string, unknown>, transfer }); },
  });
  receive({ type: "init", options: {} });
  return { receive, posted };
}

beforeEach(() => {
  state.received = null;
  state.signal = null;
  state.gate = null;
  state.failure = null;
});

describe("embedder worker 音訊協定", () => {
  it("傳PCM與取消signal、送出準備狀態、transfer向量並回報ready", async () => {
    const { receive, posted } = portHarness();
    const samples = Float32Array.of(0.25, -0.25);
    receive({ type: "request", id: 1, method: "embedAudio", params: { samples, sampleRate: 16000 } });
    await vi.waitFor(() => expect(posted.some(({ message }) => message.type === "response")).toBe(true));
    expect(state.received).toEqual({ samples, sampleRate: 16000 });
    expect(state.signal).toBeInstanceOf(AbortSignal);
    expect(posted[1]!.message).toMatchObject({ type: "status", runtimeStatus: { audioState: "loading" } });
    const response = posted.at(-1)!;
    expect(response.message).toMatchObject({ type: "response", id: 1, ok: true, runtimeStatus: { audioState: "ready" } });
    expect(response.transfer).toHaveLength(1);
    expect(response.transfer[0]).toBe((response.message.result as Float32Array).buffer);
  });

  it("在途cancel傳到音訊方法；收尾後回AbortError而非成功", async () => {
    let release!: () => void;
    state.gate = new Promise<void>((resolve) => { release = resolve; });
    const { receive, posted } = portHarness();
    receive({ type: "request", id: 2, method: "embedAudio", params: { samples: Float32Array.of(0), sampleRate: 16000 } });
    receive({ type: "cancel", id: 2 });
    expect(state.signal?.aborted).toBe(true);
    expect(posted.some(({ message }) => message.type === "response")).toBe(false);
    release();
    await vi.waitFor(() => expect(posted.at(-1)!.message).toMatchObject({ type: "response", id: 2, ok: false, error: { name: "AbortError" } }));
  });

  it("錯誤取樣率不交模型；資產錯誤保留名稱與failed狀態", async () => {
    const { receive, posted } = portHarness();
    receive({ type: "request", id: 3, method: "embedAudio", params: { samples: Float32Array.of(0), sampleRate: 8000 } });
    await vi.waitFor(() => expect(posted.at(-1)!.message).toMatchObject({ type: "response", id: 3, ok: false }));
    expect(state.received).toBeNull();
    state.failure = Object.assign(new Error("資產下載失敗"), { name: "ModelLoadError" });
    receive({ type: "request", id: 4, method: "embedAudio", params: { samples: Float32Array.of(0), sampleRate: 16000 } });
    await vi.waitFor(() => expect(posted.at(-1)!.message).toMatchObject({ type: "response", id: 4, ok: false, error: { name: "ModelLoadError" }, runtimeStatus: { audioState: "failed" } }));
  });
});
