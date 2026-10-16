/**
 * Session options 的驗證（以 mock 取代 `@huggingface/transformers`，不載入模型、不連網）：
 *
 * 1. CPU 與 DirectML **兩條路徑**建立 session 時都帶 `enableCpuMemArena: false`
 *    （關閉 ORT 的 CPU arena：arena 擴張會產生 2 GiB 的單一配置，在 Electron 內會被
 *    Chromium 的 PartitionAlloc 直接終止行程）。
 * 2. DML 路徑另外帶 `executionProviders`（含 adapter 索引）。
 * 3. 診斷用的 `logSeverityLevel` 只在環境變數明確設定時才帶。
 * 4. 這一窗的 token 預算（`BATCH_TOKEN_BUDGET`）超過時會縮小視窗。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BATCH_TOKEN_BUDGET,
  CPU_BATCH_SIZE,
  InvalidEmbedderOptionError,
  TransformersEmbedder,
} from "../src/index.js";

/** mock 模組留下的呼叫記錄（`vi.hoisted` 讓 `vi.mock` 的工廠也能取用）。 */
const state = vi.hoisted(() => ({
  /** 每次 `AutoModel.from_pretrained` 的參數。 */
  modelOptions: [] as { device?: string; session_options?: Record<string, unknown> }[],
  /** processor 每次被呼叫時的輸入筆數（含縮窗前的試探）。 */
  processorWindows: [] as number[],
  /** **實際送進模型**的視窗大小（縮窗後）。 */
  ranWindows: [] as number[],
  /** processor 回傳的序列長度（模擬每個輸入的 token 數；同一窗 padding 後同值）。 */
  sequenceLength: 4,
  /** 解碼錯誤（供 `load_image` 拋出）。 */
  decodeError: null as Error | null,
  /** 讓 dml 上的推論失敗（驗證退回 CPU 後重載的 session 也帶同一組 options）。 */
  failInferenceOnDml: false,
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
          if (options?.device === "dml" && state.failInferenceOnDml) {
            throw new Error("模擬 DML 推論失敗");
          }
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
    load_image: async () => {
      if (state.decodeError !== null) throw state.decodeError;
      return {};
    },
  };
});

/** 測試會動到的環境變數（每個測試後清除，避免互相污染）。 */
const ENV_KEYS = ["MNEMOSHELF_EMBED_DEVICE", "MNEMOSHELF_EMBED_DML_DEVICE_ID", "MNEMOSHELF_EMBED_ORT_LOG"] as const;

afterEach(() => {
  state.modelOptions.length = 0;
  state.processorWindows.length = 0;
  state.ranWindows.length = 0;
  state.sequenceLength = 4;
  state.decodeError = null;
  state.failInferenceOnDml = false;
  for (const key of ENV_KEYS) delete process.env[key];
});

describe("session options（CPU 路徑）", () => {
  it("建立 session 時帶 enableCpuMemArena:false，且沒有 executionProviders", async () => {
    const embedder = new TransformersEmbedder({ platform: "linux", cacheDir: "unused" });
    await embedder.embedQuery("測試");

    expect(state.modelOptions).toHaveLength(1);
    const options = state.modelOptions[0]!;
    expect(options.device).toBe("cpu");
    expect(options.session_options).toMatchObject({ enableCpuMemArena: false });
    expect(options.session_options).not.toHaveProperty("executionProviders");
    // 診斷用的 log 等級預設不覆寫（由 transformers.js 依 env.logLevel 決定）。
    expect(options.session_options).not.toHaveProperty("logSeverityLevel");
  });
});

describe("session options（DirectML 路徑）", () => {
  it("建立 session 時同樣帶 enableCpuMemArena:false，並保留 DML 的 executionProviders", async () => {
    process.env.MNEMOSHELF_EMBED_DML_DEVICE_ID = "2";
    const embedder = new TransformersEmbedder({ platform: "win32", cacheDir: "unused" });
    await embedder.embedQuery("測試");

    expect(embedder.runtimeStatus.device).toBe("dml");
    expect(state.modelOptions).toHaveLength(1);
    const options = state.modelOptions[0]!;
    expect(options.device).toBe("dml");
    expect(options.session_options).toMatchObject({
      enableCpuMemArena: false,
      executionProviders: [{ name: "dml", deviceId: 2 }],
    });
  });

  it("從 dml 退回 CPU 後，重新建立的 session 也帶同一個開關", async () => {
    state.failInferenceOnDml = true;
    const embedder = new TransformersEmbedder({ platform: "win32", cacheDir: "unused" });
    await embedder.embedQuery("測試");

    expect(embedder.runtimeStatus.device).toBe("cpu");
    expect(embedder.runtimeStatus.fallbackReason?.code).toBe("inference-failed");
    // 兩次載入（dml 與退回後的 cpu）都必須帶 enableCpuMemArena:false。
    expect(state.modelOptions.map((option) => option.device)).toEqual(["dml", "cpu"]);
    for (const option of state.modelOptions) {
      expect(option.session_options).toMatchObject({ enableCpuMemArena: false });
    }
  });
});

describe("ORT log 等級（診斷開關）", () => {
  it("環境變數設定 0 時，session options 帶 logSeverityLevel:0", async () => {
    process.env.MNEMOSHELF_EMBED_ORT_LOG = "0";
    const embedder = new TransformersEmbedder({ platform: "linux", cacheDir: "unused" });
    await embedder.embedQuery("測試");

    expect(state.modelOptions[0]!.session_options).toMatchObject({
      enableCpuMemArena: false,
      logSeverityLevel: 0,
    });
  });

  it("非法值在建立 embedder 時就拋錯（不靜默回預設）", () => {
    process.env.MNEMOSHELF_EMBED_ORT_LOG = "verbose";
    expect(() => new TransformersEmbedder({ platform: "linux" })).toThrow(InvalidEmbedderOptionError);
  });
});

describe("單批 token 預算（BATCH_TOKEN_BUDGET）", () => {
  it("超過預算時縮小視窗；實際送進模型的每一窗都在預算內，且結果數量與輸入一致", async () => {
    state.sequenceLength = 4096; // 每個輸入 4096 token，遠超預算
    const embedder = new TransformersEmbedder({ platform: "linux", cacheDir: "unused" });
    const inputs = Array.from({ length: CPU_BATCH_SIZE }, (_, index) => ({
      text: `doc ${index}`,
      title: "t.md",
    }));
    const vectors = await embedder.embedDocuments(inputs);

    expect(vectors).toHaveLength(inputs.length);
    // 第一次以完整批次試探（超預算），隨後才縮到預算內。
    expect(state.processorWindows[0]).toBe(CPU_BATCH_SIZE);
    expect(state.ranWindows.length).toBeGreaterThan(1);
    for (const size of state.ranWindows) {
      expect(size * state.sequenceLength).toBeLessThanOrEqual(BATCH_TOKEN_BUDGET);
    }
    // 每個輸入恰好被嵌入一次（視窗不重疊、不遺漏）。
    expect(state.ranWindows.reduce((sum, size) => sum + size, 0)).toBe(inputs.length);
  });

  it("預算內的批次不會多切視窗", async () => {
    state.sequenceLength = 64; // 16 × 64 = 1024 ≪ 8192
    const embedder = new TransformersEmbedder({ platform: "linux", cacheDir: "unused" });
    const inputs = Array.from({ length: CPU_BATCH_SIZE }, (_, index) => ({ text: `doc ${index}` }));
    const vectors = await embedder.embedDocuments(inputs);

    expect(vectors).toHaveLength(inputs.length);
    expect(state.processorWindows).toEqual([CPU_BATCH_SIZE]);
    expect(state.ranWindows).toEqual([CPU_BATCH_SIZE]);
  });
});
