import { afterEach, describe, expect, it, vi } from "vitest";
import { TransformersEmbedder } from "../src/index.js";

const state = vi.hoisted(() => ({
  loads: [] as Array<{ config: { audio_config: unknown }; dtype: Record<string, string>; device: string; session_options: Record<string, unknown>; model_file_name?: string; local_files_only?: boolean }>,
  preflights: 0,
  inputs: [] as unknown[][],
  disposed: 0,
  failAudioLoad: false,
  failCombinedLoad: false,
  tokens: 254,
  runGate: null as Promise<void> | null,
  loadGate: null as Promise<void> | null,
  runs: 0,
  active: 0,
  disposedActive: false,
  inputError: null as Error | null,
}));

vi.mock("@huggingface/transformers", () => {
  const processor = Object.assign(async (...args: unknown[]) => {
    state.inputs.push(args);
    if (args[2] && state.inputError) throw state.inputError;
    return { input_ids: { dims: [1, state.tokens] } };
  }, { image_processor: { max_soft_tokens: 0 } });
  return {
    env: { cacheDir: "" },
    AutoConfig: { from_pretrained: async () => ({ audio_config: {} }) },
    AutoProcessor: { from_pretrained: async () => processor },
    AutoModel: { from_pretrained: async (_id: string, options: typeof state.loads[number]) => {
      if (options.model_file_name === "audio_encoder") {
        state.preflights++;
        if (state.loadGate) await state.loadGate;
        if (state.failAudioLoad) throw new Error("音訊資產不存在");
        return { dispose: async () => { state.disposed++; } };
      }
      state.loads.push(options);
      if (options.config.audio_config !== null) {
        if (state.failCombinedLoad) throw new Error("本機ONNX建置失敗");
      }
      return Object.assign(async () => {
        state.runs++;
        state.active++;
        if (state.runGate) await state.runGate;
        state.active--;
        return { sentence_embedding: { dims: [1, 768], tolist: async () => [Array.from({ length: 768 }, (_, i) => i === 0 ? 1 : 0)] } };
      }, { dispose: async () => {
        state.disposed++;
        if (state.active > 0) state.disposedActive = true;
      } });
    } },
    load_image: async () => ({}),
  };
});

const input = () => ({ samples: new Float32Array(16000).fill(0.25), sampleRate: 16000 as const });
const create = () => new TransformersEmbedder({ device: "cpu", cacheDir: "unused" });

afterEach(() => {
  state.loads.length = 0;
  state.preflights = 0;
  state.inputs.length = 0;
  state.disposed = 0;
  state.failAudioLoad = false;
  state.failCombinedLoad = false;
  state.tokens = 254;
  state.runGate = null;
  state.loadGate = null;
  state.runs = 0;
  state.active = 0;
  state.disposedActive = false;
  state.inputError = null;
});

describe("音訊 lazy backend 與輸入契約", () => {
  it("文字不載音訊；首次音訊安全升級且同空間維度、不重複載入", async () => {
    const embedder = create();
    const id = embedder.info.id;
    await embedder.embedQuery("查詢");
    expect(state.loads[0]!.config.audio_config).toBeNull();
    expect(embedder.runtimeStatus.audioState).toBe("not-loaded");
    const audio = input();
    const vector = await embedder.embedAudio(audio);
    expect(vector).toHaveLength(512);
    expect(vector[0]).toBe(1);
    expect(state.disposed).toBe(2);
    expect(state.loads).toHaveLength(2);
    expect(state.loads[1]!.config.audio_config).not.toBeNull();
    expect(state.loads[1]!.dtype.audio_encoder).toBe("q4");
    expect(state.loads[1]!.local_files_only).toBe(true);
    expect(state.preflights).toBe(1);
    expect(state.loads[1]!.session_options).toMatchObject({ enableCpuMemArena: false, enableMemPattern: false });
    expect(state.inputs.at(-1)!.slice(0, 2)).toEqual([null, null]);
    expect(state.inputs.at(-1)![2]).not.toBe(audio.samples);
    expect(embedder.runtimeStatus.audioState).toBe("ready");
    expect(embedder.info.id).toBe(id);
    await embedder.embedAudio(input());
    await embedder.embedQuery("後續查詢");
    expect(state.loads).toHaveLength(2);
    await embedder.dispose();
  });

  it("音訊首次使用先準備基礎與單session音訊資產；載入中狀態可觀察", async () => {
    let release!: () => void;
    state.loadGate = new Promise<void>((resolve) => { release = resolve; });
    const embedder = create();
    const pending = embedder.embedAudio(input());
    await vi.waitFor(() => expect(state.loads).toHaveLength(1));
    expect(embedder.runtimeStatus.audioState).toBe("loading");
    release();
    await pending;
    expect(state.loads.at(-1)!.config.audio_config).not.toBeNull();
    expect(embedder.runtimeStatus.audioState).toBe("ready");
    await embedder.dispose();
  });

  it("升級會等既有 CPU 推論收尾，新的查詢不能偷跑或使用已釋放 session", async () => {
    let release!: () => void;
    state.runGate = new Promise<void>((resolve) => { release = resolve; });
    const embedder = create();
    const first = embedder.embedQuery("先前查詢");
    await vi.waitFor(() => expect(state.active).toBe(1));
    const audio = embedder.embedAudio(input());
    const query = embedder.embedQuery("後續查詢");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(state.loads).toHaveLength(1);
    expect(state.disposed).toBe(0);
    state.runGate = null;
    release();
    await Promise.all([first, audio, query]);
    expect(state.disposedActive).toBe(false);
    expect(state.loads).toHaveLength(2);
    expect(state.runs).toBe(3);
    await embedder.dispose();
  });

  it("載入音訊失敗後文字仍可用；後續音訊可重試", async () => {
    const embedder = create();
    await embedder.embedQuery("先前查詢");
    state.failAudioLoad = true;
    await expect(embedder.embedAudio(input())).rejects.toMatchObject({ name: "ModelLoadError" });
    expect(embedder.runtimeStatus.audioState).toBe("failed");
    await expect(embedder.embedQuery("繼續查詢")).resolves.toHaveLength(512);
    expect(state.loads.at(-1)!.config.audio_config).toBeNull();
    state.failAudioLoad = false;
    await expect(embedder.embedAudio(input())).resolves.toHaveLength(512);
    expect(embedder.runtimeStatus.audioState).toBe("ready");
    await embedder.dispose();
  });

  it("非法PCM在載入前拒絕，480000樣本合法且480001不靜默截短", async () => {
    const embedder = create();
    for (const samples of [new Float32Array(0), Float32Array.of(NaN), Float32Array.of(Infinity), Float32Array.of(1.1), new Float32Array(480001)]) {
      await expect(embedder.embedAudio({ samples, sampleRate: 16000 })).rejects.toMatchObject({ name: "EmbedderInputError" });
    }
    await expect(embedder.embedAudio({ samples: new Float32Array(100), sampleRate: 8000 as never })).rejects.toMatchObject({ name: "EmbedderInputError" });
    expect(state.loads).toHaveLength(0);
    await expect(embedder.embedAudio({ samples: new Float32Array(480000), sampleRate: 16000 })).resolves.toHaveLength(512);
    await embedder.dispose();
  });

  it("極短尾段保留原始樣本並補零至160；既有長片段不改樣本數", async () => {
    const embedder = create();
    const source = Float32Array.of(0.25);
    await embedder.embedAudio({ samples: source, sampleRate: 16000 });
    const samples = state.inputs.at(-1)![2] as Float32Array;
    expect(samples).toHaveLength(160);
    expect(samples[0]).toBe(0.25);
    expect(samples.subarray(1).every((value) => value === 0)).toBe(true);
    expect(source).toHaveLength(1);
    await embedder.embedAudio(input());
    expect(state.inputs.at(-1)![2]).toHaveLength(16000);
    await embedder.dispose();
  });

  it("音訊採CPU且不外推DML能力；升級失敗復原原裝置，重試成功保留requestedDevice", async () => {
    const embedder = new TransformersEmbedder({ platform: "win32", device: "dml", cacheDir: "unused" });
    await embedder.embedQuery("先前查詢");
    expect(embedder.runtimeStatus.device).toBe("dml");
    state.failAudioLoad = true;
    await expect(embedder.embedAudio(input())).rejects.toMatchObject({ name: "ModelLoadError" });
    expect(embedder.runtimeStatus).toMatchObject({ device: "dml", loaded: true, fallbackReason: null, audioState: "failed", audioRetryable: true });
    await embedder.embedQuery("復原查詢");
    expect(state.loads.at(-1)!.device).toBe("dml");
    state.failAudioLoad = false;
    await embedder.embedAudio(input());
    expect(embedder.runtimeStatus).toMatchObject({ requestedDevice: "dml", device: "cpu", audioState: "ready", fallbackReason: { code: "audio-cpu" } });
    expect(state.loads.filter((options) => options.config.audio_config !== null).every((options) => options.device === "cpu")).toBe(true);
    await embedder.dispose();
  });

  it("實際token超限與前處理錯誤不進模型", async () => {
    const embedder = create();
    state.tokens = 8193;
    await expect(embedder.embedAudio(input())).rejects.toMatchObject({ code: "input-too-long" });
    expect(state.runs).toBe(0);
    state.tokens = 254;
    state.inputError = new Error("無法前處理");
    await expect(embedder.embedAudio(input())).rejects.toMatchObject({ code: "undecodable" });
    expect(state.runs).toBe(0);
    state.inputError = null;
    state.tokens = 8192;
    await expect(embedder.embedAudio(input())).resolves.toHaveLength(512);
    await embedder.dispose();
  });

  it("取消前不載模型；載入中取消等待載入完成但不推論", async () => {
    const embedder = create();
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(embedder.embedAudio(input(), { signal: cancelled.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(state.loads).toHaveLength(0);
    let release!: () => void;
    state.loadGate = new Promise<void>((resolve) => { release = resolve; });
    const controller = new AbortController();
    const pending = embedder.embedAudio(input(), { signal: controller.signal });
    const assertion = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(state.loads).toHaveLength(1));
    controller.abort();
    release();
    await assertion;
    expect(state.runs).toBe(0);
    expect(embedder.runtimeStatus.audioState).toBe("not-loaded");
    await embedder.dispose();
  });

  it.each(["loading", "inference"])("dispose會等待音訊%s並發階段，不復活或釋放在途session", async (phase) => {
    const embedder = create();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    if (phase === "loading") state.loadGate = gate;
    else state.runGate = gate;
    const audio = embedder.embedAudio(input());
    await vi.waitFor(() => expect(phase === "loading" ? state.loads.length : state.active).toBe(1));
    let done = false;
    const first = embedder.dispose();
    const second = embedder.dispose().then(() => { done = true; });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(done).toBe(false);
    expect(state.disposed).toBe(phase === "loading" ? 0 : 2);
    release();
    await Promise.all([audio, first, second]);
    expect(state.disposed).toBe(3);
    expect(state.disposedActive).toBe(false);
    expect(embedder.runtimeStatus).toMatchObject({ loaded: false, audioState: "not-loaded" });
    // 契約允許明確的後續呼叫重載；與在途載入晚到而復活不同。
    state.loadGate = null;
    state.runGate = null;
    await embedder.embedQuery("明確重載");
    expect(state.loads.at(-1)!.config.audio_config).toBeNull();
    await embedder.dispose();
  });

  it("完整本機session建置失敗後停止音訊重試，文字仍可恢復且dispose不清除terminal狀態", async () => {
    const embedder = create();
    await embedder.embedQuery("先前查詢");
    state.failCombinedLoad = true;
    await expect(embedder.embedAudio(input())).rejects.toMatchObject({ code: "EAUDIORESTART" });
    expect(embedder.runtimeStatus).toMatchObject({ audioState: "failed", audioRetryable: false, loaded: false });
    const attempts = state.loads.length;
    await expect(embedder.embedAudio(input())).rejects.toThrow("重新啟動");
    expect(state.loads).toHaveLength(attempts);
    expect(state.preflights).toBe(1);
    await expect(embedder.embedQuery("恢復文字")).resolves.toHaveLength(512);
    await embedder.dispose();
    expect(embedder.runtimeStatus).toMatchObject({ audioState: "failed", audioRetryable: false });
    await expect(embedder.embedAudio(input())).rejects.toMatchObject({ code: "EAUDIORESTART" });
    expect(state.preflights).toBe(1);
  });
});
