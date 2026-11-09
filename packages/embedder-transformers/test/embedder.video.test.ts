/**
 * 影片幀序列（`embedVideo`）的 adapter 單元測試。
 *
 * 用 mock 的 `@huggingface/transformers`（不載入真模型、不連網）驗證：
 * - 走**上游的影片入口** `processor(null, null, null, [RawVideo])`，逐幀把已解碼像素與 timestamp
 *   交給 `RawVideoFrame`；輸出仍是產品維度（截斷＋L2）。
 * - 結構驗證在載入模型前完成；超過 32 幀不得默默抽樣。
 * - token 上限、前處理錯誤分類、取消語意、`videoState` 狀態機，以及自訂 modelId 的保守宣告。
 *
 * 真模型的 gated 測試見 `embedder.video.e2e.test.ts`。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_VIDEO_FRAME_EDGE, TransformersEmbedder } from "../src/index.js";

interface MockLoadOptions {
  config: { audio_config: unknown };
  dtype: Record<string, string>;
  device: string;
  session_options: Record<string, unknown>;
}
interface MockFrame {
  image: { data: Uint8Array; width: number; height: number; channels: number };
  timestamp: number;
}
interface MockVideo {
  frames: MockFrame[];
  duration: number;
}

const state = vi.hoisted(() => ({
  loads: [] as MockLoadOptions[],
  processorInputs: [] as unknown[][],
  runs: 0,
  disposed: 0,
  tokens: 494 as number | null,
  hasVideoProcessor: true,
  loadGate: null as Promise<void> | null,
  preprocessError: null as Error | null,
}));

vi.mock("@huggingface/transformers", () => {
  class MockRawImage {
    constructor(
      public data: Uint8Array,
      public width: number,
      public height: number,
      public channels: number,
    ) {}
    rgb(): this {
      return this;
    }
  }
  class MockRawVideoFrame {
    constructor(public image: MockRawImage, public timestamp: number) {}
  }
  class MockRawVideo {
    constructor(public frames: MockRawVideoFrame[], public duration: number) {}
  }
  const processor = Object.assign(
    async (...args: unknown[]) => {
      state.processorInputs.push(args);
      if (args[3] !== undefined && state.preprocessError !== null) throw state.preprocessError;
      return state.tokens === null
        ? {}
        : { input_ids: { dims: [1, state.tokens] } };
    },
    { image_processor: { max_soft_tokens: 0 } },
  );
  Object.defineProperty(processor, "video_processor", {
    get: () => (state.hasVideoProcessor ? { max_frames: 32 } : undefined),
    configurable: true,
  });
  return {
    env: { cacheDir: "" },
    AutoConfig: { from_pretrained: async () => ({ audio_config: {} }) },
    AutoProcessor: { from_pretrained: async () => processor },
    AutoModel: {
      from_pretrained: async (_id: string, options: MockLoadOptions) => {
        state.loads.push(options);
        if (state.loadGate !== null) await state.loadGate;
        return Object.assign(
          async () => {
            state.runs += 1;
            return {
              sentence_embedding: {
                dims: [1, 768],
                tolist: async () => [Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0))],
              },
            };
          },
          { dispose: async () => { state.disposed += 1; } },
        );
      },
    },
    load_image: async () => ({}),
    RawImage: MockRawImage,
    RawVideo: MockRawVideo,
    RawVideoFrame: MockRawVideoFrame,
  };
});

/** 合成影格（確定性圖樣；不含任何私人影像）。 */
function frame(
  index: number,
  options: { width?: number; height?: number; channels?: 3 | 4; timestampSeconds?: number } = {},
): { pixels: Uint8Array; width: number; height: number; channels: 3 | 4; timestampSeconds: number } {
  const width = options.width ?? 8;
  const height = options.height ?? 8;
  const channels = options.channels ?? 3;
  const pixels = new Uint8Array(width * height * channels);
  for (let i = 0; i < pixels.length; i += 1) pixels[i] = (index * 37 + i * 31) % 256;
  return { pixels, width, height, channels, timestampSeconds: options.timestampSeconds ?? index };
}

const create = (): TransformersEmbedder => new TransformersEmbedder({ device: "cpu", cacheDir: "unused" });

function norm(vector: Float32Array): number {
  let sum = 0;
  for (const value of vector) sum += value * value;
  return Math.sqrt(sum);
}

afterEach(() => {
  state.loads.length = 0;
  state.processorInputs.length = 0;
  state.runs = 0;
  state.disposed = 0;
  state.tokens = 494;
  state.hasVideoProcessor = true;
  state.loadGate = null;
  state.preprocessError = null;
});

describe("embedVideo：影片入口與輸出契約", () => {
  it("1 幀與 4 幀走 videos 入口、輸出 512 維 L2，且不額外載入權重", async () => {
    const embedder = create();
    expect(embedder.info.capabilities.video).toBe(true);
    expect(embedder.runtimeStatus.videoState).toBe("not-loaded");

    const singleInput = { frames: [frame(0)] };
    const single = await embedder.embedVideo(singleInput);
    expect(single).toHaveLength(512);
    expect(Number.isFinite(single[0])).toBe(true);
    expect(Math.abs(norm(single) - 1)).toBeLessThan(1e-6);
    expect(embedder.runtimeStatus).toMatchObject({ videoState: "ready", loaded: true });
    expect(state.loads).toHaveLength(1);
    expect(state.loads[0]!.config.audio_config).toBeNull();

    // 上游入口的第 4 個參數是「每個 sample 一份 RawVideo」的陣列；文字／圖片／音訊皆為 null。
    const args = state.processorInputs.at(-1)!;
    expect(args.slice(0, 3)).toEqual([null, null, null]);
    const videos = args[3] as MockVideo[];
    expect(videos).toHaveLength(1);
    expect(videos[0]!.frames).toHaveLength(1);
    expect(videos[0]!.frames[0]!.image).toMatchObject({ width: 8, height: 8, channels: 3 });
    expect(Array.from(videos[0]!.frames[0]!.image.data)).toEqual(Array.from(singleInput.frames[0]!.pixels));
    expect(videos[0]!.frames[0]!.timestamp).toBe(0);
    // 單幀的 duration 取極小正數（只給 fps getter；不影響模型輸入）。
    expect(videos[0]!.duration).toBeGreaterThan(0);

    const four = await embedder.embedVideo({ frames: [0, 1, 2, 3].map((index) => frame(index)) });
    expect(four).toHaveLength(512);
    expect(Math.abs(norm(four) - 1)).toBeLessThan(1e-6);

    const fourVideo = (state.processorInputs.at(-1)![3] as MockVideo[])[0]!;
    expect(fourVideo.frames.map((entry) => entry.timestamp)).toEqual([0, 1, 2, 3]);
    expect(fourVideo.duration).toBe(3);
    expect(state.runs).toBe(2);
    // 影片沿用既有 vision encoder，不會載入第二份模型或音訊權重。
    expect(state.loads).toHaveLength(1);
    await embedder.dispose();
    expect(embedder.runtimeStatus.videoState).toBe("not-loaded");
  });

  it("RGBA 幀以 4 通道像素交給上游（由上游 rgb() 轉 RGB）", async () => {
    const embedder = create();
    const input = frame(0, { channels: 4 });
    await expect(embedder.embedVideo({ frames: [input] })).resolves.toHaveLength(512);
    const image = (state.processorInputs.at(-1)![3] as MockVideo[])[0]!.frames[0]!.image;
    expect(image.channels).toBe(4);
    expect(image.data).toHaveLength(8 * 8 * 4);
    await embedder.dispose();
  });
});

describe("embedVideo：輸入驗證（載入模型前）", () => {
  it("空幀／超過 32 幀／通道／像素長度／尺寸／時間戳／尺寸不一致都被拒絕", async () => {
    const embedder = create();
    const valid = frame(0);
    const cases: unknown[] = [
      { frames: [] },
      { frames: Array.from({ length: 33 }, (_, index) => frame(index, { width: 1, height: 1 })) },
      { frames: [{ ...valid, channels: 2 }] },
      { frames: [{ ...valid, pixels: new Uint8Array(1) }] },
      { frames: [{ ...valid, width: 0 }] },
      {
        frames: [{
          ...valid,
          width: MAX_VIDEO_FRAME_EDGE + 1,
          pixels: new Uint8Array((MAX_VIDEO_FRAME_EDGE + 1) * 8 * 3),
        }],
      },
      { frames: [{ ...valid, timestampSeconds: Number.NaN }] },
      { frames: [{ ...valid, timestampSeconds: -1 }] },
      { frames: [frame(0, { timestampSeconds: 2 }), frame(1, { timestampSeconds: 1 })] },
      { frames: [valid, frame(1, { width: 9 })] },
    ];
    for (const video of cases) {
      await expect(embedder.embedVideo(video as never)).rejects.toMatchObject({
        name: "EmbedderInputError",
        code: "invalid-video-input",
      });
    }
    expect(state.loads).toHaveLength(0);
    expect(state.runs).toBe(0);
    expect(embedder.runtimeStatus.videoState).toBe("not-loaded");
  });

  it("像素總數超過上限（32 幀 512×513）也被拒絕", async () => {
    const embedder = create();
    const frames = Array.from({ length: 32 }, (_, index) => frame(index, { width: 512, height: 513 }));
    await expect(embedder.embedVideo({ frames })).rejects.toMatchObject({
      name: "EmbedderInputError",
      code: "invalid-video-input",
    });
    expect(state.loads).toHaveLength(0);
  });
});

describe("embedVideo：token 與錯誤分類", () => {
  it("實際 token 超限（8193）不進模型；8192 合法", async () => {
    const embedder = create();
    state.tokens = 8193;
    await expect(embedder.embedVideo({ frames: [frame(0)] })).rejects.toMatchObject({
      name: "EmbedderInputError",
      code: "input-too-long",
    });
    expect(state.runs).toBe(0);
    state.tokens = 8192;
    await expect(embedder.embedVideo({ frames: [frame(0)] })).resolves.toHaveLength(512);
    expect(state.runs).toBe(1);
    await embedder.dispose();
  });

  it("缺有效 token 形狀與前處理錯誤都歸類為 EmbedderInputError（undecodable），不推論", async () => {
    const embedder = create();
    state.tokens = null;
    await expect(embedder.embedVideo({ frames: [frame(0)] })).rejects.toMatchObject({
      name: "EmbedderInputError",
      code: "undecodable",
    });
    expect(state.runs).toBe(0);
    state.tokens = 494;
    state.preprocessError = new Error("上游影片前處理壞掉");
    await expect(embedder.embedVideo({ frames: [frame(0)] })).rejects.toMatchObject({
      name: "EmbedderInputError",
      code: "undecodable",
    });
    expect(state.runs).toBe(0);
    // 輸入類失敗不是資產失敗：狀態還原為 not-loaded（不冒充 ready、也不標 failed）。
    expect(embedder.runtimeStatus.videoState).toBe("not-loaded");
    await embedder.dispose();
  });

  it("processor 沒有 video_processor：disabled＋具名 VideoUnsupportedError，不推論", async () => {
    state.hasVideoProcessor = false;
    const embedder = create();
    await expect(embedder.embedVideo({ frames: [frame(0)] })).rejects.toMatchObject({
      name: "VideoUnsupportedError",
      code: "video-unsupported",
    });
    expect(state.runs).toBe(0);
    expect(embedder.runtimeStatus.videoState).toBe("disabled");
    expect(embedder.runtimeStatus.videoRetryable).toBeUndefined();
    await embedder.dispose();
  });

  it("取消優先：已取消不載模型；載入中取消回 AbortError 且不推論", async () => {
    const embedder = create();
    const aborted = new AbortController();
    aborted.abort();
    await expect(
      embedder.embedVideo({ frames: [frame(0)] }, { signal: aborted.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(state.loads).toHaveLength(0);

    let release!: () => void;
    state.loadGate = new Promise<void>((resolve) => { release = resolve; });
    const controller = new AbortController();
    const pending = embedder.embedVideo({ frames: [frame(0)] }, { signal: controller.signal });
    const assertion = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(embedder.runtimeStatus.videoState).toBe("loading"));
    controller.abort();
    release();
    await assertion;
    expect(state.runs).toBe(0);
    expect(embedder.runtimeStatus.videoState).toBe("not-loaded");
    await embedder.dispose();
  });

  it("自訂 modelId 保守宣告 video=false；呼叫具名失敗且不載模型，文字仍可用", async () => {
    const embedder = new TransformersEmbedder({ modelId: "org/custom-model", device: "cpu", cacheDir: "unused" });
    expect(embedder.info.capabilities.video).toBe(false);
    expect(embedder.runtimeStatus.videoState).toBe("disabled");
    await expect(embedder.embedVideo({ frames: [frame(0)] })).rejects.toMatchObject({
      name: "VideoUnsupportedError",
      code: "video-unsupported",
    });
    expect(state.loads).toHaveLength(0);
    await expect(embedder.embedQuery("文字查詢仍可運作")).resolves.toHaveLength(512);
    await embedder.dispose();
  });
});
