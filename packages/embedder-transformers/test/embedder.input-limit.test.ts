/**
 * 單筆輸入硬上限（`MAX_INPUT_TOKENS`）的驗證（mock 取代 `@huggingface/transformers`，不載模型）。
 *
 * 背景：一窗的 token 預算只在視窗內**有多筆**時能靠縮窗生效，因此 `embedDocuments` 的單筆
 * 視窗與單筆文字入口（`embedQuery`／`embedDocument`，記憶寫入也走這條）先前完全沒有上限。
 * 這一組測試釘住補上的破口：
 *
 * 1. 超過上限的單筆輸入 → 拋 `EmbedderInputError`，`code === "input-too-long"`，
 *    **且不會呼叫模型**。
 * 2. 上限內（含剛好等於上限）→ 正常回傳向量。
 * 3. 多筆視窗一路縮到單筆後仍超限 → 同樣拒絕（破口在批次路徑上也可達）。
 * 4. session options 同時關閉 CPU arena 與 memory pattern（`enableCpuMemArena`／
 *    `enableMemPattern` 皆為 `false`），避免日後被改回去。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EmbedderInputError,
  MAX_INPUT_TOKENS,
  TransformersEmbedder,
} from "../src/index.js";

/** mock 模組留下的呼叫記錄（`vi.hoisted` 讓 `vi.mock` 的工廠也能取用）。 */
const state = vi.hoisted(() => ({
  /** 每次 `AutoModel.from_pretrained` 的參數（釘住 session options）。 */
  modelOptions: [] as { device?: string; session_options?: Record<string, unknown> }[],
  /** processor 每次被呼叫時的輸入筆數（含縮窗前的試探）。 */
  processorWindows: [] as number[],
  /** **實際送進模型**的視窗大小；空陣列＝一次都沒有呼叫模型。 */
  ranWindows: [] as number[],
  /** processor 回傳的序列長度（模擬每一筆的實際 token 數）。 */
  sequenceLength: 8,
}));

vi.mock("@huggingface/transformers", () => {
  const row = (): number[] => Array.from({ length: 768 }, (_, index) => (index === 0 ? 1 : 0));
  const processor = Object.assign(
    async (texts: unknown) => {
      const count = Array.isArray(texts) ? texts.length : 1;
      state.processorWindows.push(count);
      return { input_ids: { dims: [count, state.sequenceLength] }, batch: count };
    },
    { image_processor: { max_soft_tokens: 0 } },
  );
  return {
    env: { cacheDir: "" },
    AutoConfig: { from_pretrained: async () => ({ audio_config: {} }) },
    AutoProcessor: { from_pretrained: async () => processor },
    AutoModel: {
      from_pretrained: async (
        _id: string,
        options: { device?: string; session_options?: Record<string, unknown> },
      ) => {
        state.modelOptions.push({ device: options?.device, session_options: options?.session_options });
        const model = async (inputs: { batch?: number }) => {
          const count = inputs?.batch ?? 1;
          state.ranWindows.push(count);
          return {
            sentence_embedding: {
              dims: [count, 768],
              tolist: async () => Array.from({ length: count }, row),
            },
          };
        };
        return Object.assign(model, { dispose: async () => undefined });
      },
    },
  };
});

afterEach(() => {
  state.modelOptions.length = 0;
  state.processorWindows.length = 0;
  state.ranWindows.length = 0;
  state.sequenceLength = 8;
});

/** 建一個不碰真模型、不連網的 embedder。 */
function makeEmbedder(): TransformersEmbedder {
  return new TransformersEmbedder({ platform: "linux", cacheDir: "unused" });
}

describe("單筆輸入硬上限（MAX_INPUT_TOKENS）", () => {
  it("embedQuery 超過上限：拋 EmbedderInputError 且帶穩定錯誤碼，不呼叫模型", async () => {
    state.sequenceLength = MAX_INPUT_TOKENS + 1;
    const embedder = makeEmbedder();

    const error = await embedder.embedQuery("長文").catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(EmbedderInputError);
    expect((error as EmbedderInputError).name).toBe("EmbedderInputError");
    expect((error as EmbedderInputError).code).toBe("input-too-long");
    expect((error as Error).message).toContain(String(MAX_INPUT_TOKENS));
    // 護欄必須擋在推論之前：模型一次都不該被呼叫。
    expect(state.ranWindows).toEqual([]);
  });

  it("embedDocument（記憶寫入走這條）超過上限：同樣拒絕且不呼叫模型", async () => {
    state.sequenceLength = MAX_INPUT_TOKENS * 2;
    const embedder = makeEmbedder();

    const error = await embedder.embedDocument("長文", "note.md").catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(EmbedderInputError);
    expect((error as EmbedderInputError).code).toBe("input-too-long");
    expect(state.ranWindows).toEqual([]);
  });

  it("embedDocuments 的單筆視窗超過上限：拒絕且不呼叫模型", async () => {
    state.sequenceLength = MAX_INPUT_TOKENS + 1;
    const embedder = makeEmbedder();

    const error = await embedder
      .embedDocuments([{ text: "長文", title: "a.md" }])
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(EmbedderInputError);
    expect((error as EmbedderInputError).code).toBe("input-too-long");
    expect(state.ranWindows).toEqual([]);
  });

  it("多筆視窗縮到單筆後仍超限：一樣拒絕（破口在批次路徑上可達）", async () => {
    state.sequenceLength = MAX_INPUT_TOKENS + 10;
    const embedder = makeEmbedder();
    const inputs = Array.from({ length: 4 }, (_, index) => ({ text: `doc ${index}` }));

    const error = await embedder.embedDocuments(inputs).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(EmbedderInputError);
    expect((error as EmbedderInputError).code).toBe("input-too-long");
    // 先以完整批次試探、縮到單筆後才判定超限。
    expect(state.processorWindows).toEqual([4, 1]);
    expect(state.ranWindows).toEqual([]);
  });

  it("上限內（含剛好等於上限）：照常回傳向量，且只呼叫模型一次", async () => {
    state.sequenceLength = MAX_INPUT_TOKENS;
    const embedder = makeEmbedder();

    const vector = await embedder.embedQuery("長度剛好在上限");

    expect(vector).toHaveLength(embedder.info.dim);
    expect(Math.abs(Math.hypot(...vector) - 1)).toBeLessThan(1e-3);
    expect(state.ranWindows).toEqual([1]);

    // 批次中的單筆也一樣（上限是「不超過即放行」）。
    state.ranWindows.length = 0;
    const vectors = await embedder.embedDocuments([{ text: "上限內", title: "b.md" }]);
    expect(vectors).toHaveLength(1);
    expect(state.ranWindows).toEqual([1]);
  });
});

describe("session options（關閉配置的釘子）", () => {
  it("建立 session 時 enableCpuMemArena 與 enableMemPattern 皆為 false", async () => {
    const embedder = makeEmbedder();
    await embedder.embedQuery("測試");

    expect(state.modelOptions).toHaveLength(1);
    expect(state.modelOptions[0]!.session_options).toEqual({
      enableCpuMemArena: false,
      enableMemPattern: false,
    });
  });
});
