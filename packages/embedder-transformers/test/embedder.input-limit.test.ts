/**
 * 單筆輸入硬上限（`MAX_INPUT_TOKENS`）的驗證（mock 取代 `@huggingface/transformers`，不載模型）。
 *
 * 背景：一窗的 token 預算只在視窗內**有多筆**時能靠縮窗生效，因此 `embedDocuments` 的單筆
 * 視窗與單筆文字入口（`embedQuery`／`embedDocument`）先前完全沒有上限。生產路徑目前是
 * `/search` 的查詢與 desktop 啟動時的模型驗證短字串（`embedDocument` 是介面方法、非熱路徑；
 * 記憶寫入 `POST /memories` 不經 embedder，不受這條上限保護）。這一組測試釘住補上的破口：
 *
 * 1. 超過上限的單筆輸入 → 拋 `EmbedderInputError`，`code === "input-too-long"`，
 *    **且不會呼叫模型**。
 * 2. 上限內（含剛好等於上限）→ 正常回傳向量。
 * 3. 多筆視窗一路縮到單筆後仍超限 → 同樣拒絕（破口在批次路徑上也可達）。
 * 4. session options 同時關閉 CPU arena 與 memory pattern（`enableCpuMemArena`／
 *    `enableMemPattern` 皆為 `false`），避免日後被改回去。
 * 5. 超限是**輸入類**失敗：在 `dml`（win32）與 `coreml`（darwin）上也不觸發 GPU→CPU 退回
 *    （`runtimeStatus.device` 不變、`fallbackReason` 為 `null`）。這一案是必要的：cpu 下
 *    `shouldFallBack` 本來就回 `false`，只有加速器裝置才驗得到「不看錯誤類別」的破口。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  COREML_MLPROGRAM_FLAG,
  DEFAULT_MODEL_ID,
  DEVICE_DECISION_SCHEMA,
  EmbedderInputError,
  MAX_INPUT_TOKENS,
  TransformersEmbedder,
  writeDecisionRecord,
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
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

/** 測試用暫存目錄（macOS 的決定快取檔放這裡；絕不碰使用者的家目錄或真實快取）。 */
const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mnemoshelf-input-limit-"));
  tempDirs.push(dir);
  return dir;
}

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

  it("embedDocument（介面方法，目前非熱路徑）超過上限：同樣拒絕且不呼叫模型", async () => {
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

describe("超限屬輸入類失敗：加速器裝置（dml／coreml）不觸發 GPU→CPU 退回", () => {
  /**
   * 為什麼要這兩個案子：現有超限測試都用 `platform:"linux"`（device＝`cpu`），而
   * `shouldFallBack` 在 cpu 下**本來就回 `false`**（與錯誤類別無關）。因此把
   * `instanceof EmbedderInputError` 的判斷收窄成「只認 `undecodable`」時，那些測試
   * **不會紅**。只有在 `dml`／`coreml`（會退回的裝置）上才驗得到這條契約承諾。
   */
  it("win32／auto（device＝dml）單筆超限：仍拋 input-too-long，device 不變且不退回 CPU", async () => {
    state.sequenceLength = MAX_INPUT_TOKENS + 1;
    const embedder = new TransformersEmbedder({ platform: "win32", cacheDir: "unused" });
    expect(embedder.runtimeStatus.device).toBe("dml");

    const error = await embedder.embedQuery("長文").catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(EmbedderInputError);
    expect((error as EmbedderInputError).code).toBe("input-too-long");
    // 護欄擋在推論之前：模型一次都不該被呼叫。
    expect(state.ranWindows).toEqual([]);
    // 輸入類失敗與裝置無關：不得退回 CPU（否則 `fallBackToCpu` 會改掉 device／fallbackReason
    // 並重新載入 CPU session）。
    expect(embedder.runtimeStatus.device).toBe("dml");
    expect(embedder.runtimeStatus.fallbackReason).toBeNull();
    expect(state.modelOptions.map((options) => options.device)).toEqual(["dml"]);
  });

  it("darwin／auto（device＝coreml）單筆超限：仍拋 input-too-long，device 不變且不退回 CPU", async () => {
    state.sequenceLength = MAX_INPUT_TOKENS * 2;
    // 播一份「上一次啟動已判定 CoreML 可用」的決定記錄，讓 auto 直接沿用 coreml：
    // mock 沒有真實計時差異，跑自我測試必然判 too-slow（那與本測試無關）。
    const decisionPath = join(tempDir(), "device-decision.json");
    writeDecisionRecord(decisionPath, {
      schema: DEVICE_DECISION_SCHEMA,
      outcome: "usable",
      testedAt: "2026-10-17T00:00:00.000Z",
      appVersion: "unknown",
      modelId: DEFAULT_MODEL_ID,
      dtype: "q4",
      platform: "darwin",
      arch: process.arch,
      coreMlFlags: COREML_MLPROGRAM_FLAG,
    });
    const embedder = new TransformersEmbedder({
      platform: "darwin",
      device: "auto",
      cacheDir: "unused",
      deviceDecisionPath: decisionPath,
    });
    expect(embedder.runtimeStatus.device).toBe("coreml");

    const error = await embedder.embedQuery("長文").catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(EmbedderInputError);
    expect((error as EmbedderInputError).code).toBe("input-too-long");
    expect(state.ranWindows).toEqual([]);
    expect(embedder.runtimeStatus.device).toBe("coreml");
    expect(embedder.runtimeStatus.fallbackReason).toBeNull();
    expect(state.modelOptions.map((options) => options.device)).toEqual(["coreml"]);
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
