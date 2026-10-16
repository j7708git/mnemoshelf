/**
 * 執行裝置（device）解析與「DML 失敗自動退回 CPU」的單元測試。
 *
 * 全部在**開發機**（非 Windows）也能跑：`@huggingface/transformers` 以 `vi.mock` 注入，
 * 用行為開關模擬「DML 載入失敗」「DML 推論失敗」「DML 取消」；平台以建構子選項
 * `platform` 覆寫。不載入真實模型、不連網。
 *
 * 覆蓋情境：
 *   1. `auto` 在 Windows → 走 `dml`（含 EP 與 adapter 設定）；非 Windows → 維持 `cpu`。
 *   2. `dml` 載入／推論／探測失敗 → 自動退回 `cpu`（含原因）且不中斷；取消不觸發退回。
 *   3. 裝置覆寫（選項優先於環境變數；非法值拋錯）與 `dml` 的序列推論互斥。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EmbedderRuntimeStatus } from "@mnemoshelf/core";
import {
  DEFAULT_DML_DEVICE_ID,
  DML_BATCH_SIZE,
  EMBED_DEVICE_ENV,
  EMBED_DML_DEVICE_ID_ENV,
  InvalidEmbedderOptionError,
  MAX_BATCH_SIZE,
  TransformersEmbedder,
  CPU_BATCH_SIZE,
  deviceBatchSize,
  isDmlPlatform,
  parseDmlDeviceId,
  parseEmbedDeviceOption,
  requiresSerializedInference,
  resolveEmbedDevice,
  summarizeFailure,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// 模型 mock（記錄呼叫、可注入失敗）——不碰真實 transformers.js
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  /** 模擬的失敗模式。 */
  behavior: {
    loadFailsOnDml: false,
    inferenceFailsOnDml: false,
    inferenceAbortsOnDml: false,
  },
  /** `AutoModel.from_pretrained` 收到的選項（逐次）。 */
  modelOptions: [] as { device?: unknown; session_options?: unknown }[],
  /** 每次 `processor(...)` 收到的輸入數（＝視窗大小）。 */
  windows: [] as number[],
  /** 同時在 `model(...)` 內的呼叫數與其峰值（驗證序列化：峰值必須是 1）。 */
  inflight: 0,
  maxInflight: 0,
  /**
   * 測試閘門：非 null 時 `model(...)` 會等到它 resolve 才回傳。
   * 用來把「某一路推論正在跑」的狀態固定住，才能穩定觀察佇列行為。
   */
  gate: null as Promise<void> | null,
}));

vi.mock("@huggingface/transformers", () => {
  /** 768 維的合成輸出列（第一維為 1 → 截斷正規化後模長仍是 1）。 */
  const row = (): number[] => Array.from({ length: 768 }, (_, index) => (index === 0 ? 1 : 0));

  const processor = Object.assign(
    async (texts: unknown): Promise<{ batch: number }> => {
      const count = Array.isArray(texts) ? texts.length : 1;
      mocks.windows.push(count);
      return { batch: count };
    },
    { image_processor: { max_soft_tokens: 0 } },
  );

  return {
    env: { cacheDir: "" },
    AutoConfig: { from_pretrained: async () => ({ audio_config: {} }) },
    AutoProcessor: { from_pretrained: async () => processor },
    AutoModel: {
      from_pretrained: async (_id: string, options?: { device?: unknown; session_options?: unknown }) => {
        mocks.modelOptions.push({ device: options?.device, session_options: options?.session_options });
        if (mocks.behavior.loadFailsOnDml && options?.device === "dml") {
          throw new Error("DirectML 載入失敗（模擬）");
        }
        const model = async (inputs: { batch?: number }): Promise<unknown> => {
          const count = inputs?.batch ?? 1;
          mocks.inflight += 1;
          mocks.maxInflight = Math.max(mocks.maxInflight, mocks.inflight);
          try {
            if (mocks.gate !== null) await mocks.gate;
            if (options?.device === "dml") {
              if (mocks.behavior.inferenceAbortsOnDml) {
                throw Object.assign(new Error("嵌入已取消（模擬）"), { name: "AbortError" });
              }
              if (mocks.behavior.inferenceFailsOnDml) throw new Error("DML 推論失敗（模擬）");
            }
            return {
              sentence_embedding: {
                dims: [count, 768],
                tolist: async () => Array.from({ length: count }, row),
              },
            };
          } finally {
            mocks.inflight -= 1;
          }
        };
        return Object.assign(model, { dispose: async () => undefined });
      },
    },
    load_image: async () => ({}),
  };
});

/** 測試用快取目錄名（mock 不碰檔案系統，只需一個非空字串）。 */
const CACHE_DIR = "test-cache";

function resetMocks(): void {
  mocks.behavior.loadFailsOnDml = false;
  mocks.behavior.inferenceFailsOnDml = false;
  mocks.behavior.inferenceAbortsOnDml = false;
  mocks.modelOptions.length = 0;
  mocks.windows.length = 0;
  mocks.inflight = 0;
  mocks.maxInflight = 0;
  mocks.gate = null;
}

/** 等到 `model(...)` 內的呼叫數達到 `count`（最多等 1 秒，逾時就讓斷言自己失敗）。 */
async function waitForInflight(count: number): Promise<void> {
  const deadline = Date.now() + 1000;
  while (mocks.inflight < count && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** 讓事件迴圈轉一圈（給「應該還在排隊」的斷言用）。 */
async function tick(ms = 20): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** 關上閘門：之後進入 `model(...)` 的呼叫都會停住，直到回傳的函式被呼叫。 */
function holdModel(): () => void {
  let release!: () => void;
  mocks.gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return () => {
    mocks.gate = null;
    release();
  };
}

/** 合成文件輸入（不含任何個人資訊）。 */
function documents(count: number): { text: string; title: string }[] {
  return Array.from({ length: count }, (_, index) => ({
    text: `合成文件第 ${index} 段`,
    title: `corpus/doc-${index}.md`,
  }));
}

/** 模長（向量必須已 L2 正規化）。 */
function norm(vec: Float32Array): number {
  let sum = 0;
  for (const value of vec) sum += value * value;
  return Math.sqrt(sum);
}

const originalDeviceEnv = process.env[EMBED_DEVICE_ENV];
const originalDmlDeviceIdEnv = process.env[EMBED_DML_DEVICE_ID_ENV];

afterEach(() => {
  resetMocks();
  restoreEnv(EMBED_DEVICE_ENV, originalDeviceEnv);
  restoreEnv(EMBED_DML_DEVICE_ID_ENV, originalDmlDeviceIdEnv);
});

/** 還原環境變數（原本不存在就刪掉）。 */
function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

// ---------------------------------------------------------------------------
// 純函式：選項解析、平台解析、批次視窗
// ---------------------------------------------------------------------------

describe("裝置選項解析（parseEmbedDeviceOption）", () => {
  it("未設定、空字串或空白 → auto", () => {
    expect(parseEmbedDeviceOption(undefined)).toBe("auto");
    expect(parseEmbedDeviceOption("")).toBe("auto");
    expect(parseEmbedDeviceOption("   ")).toBe("auto");
  });

  it("cpu／dml／auto 都接受（去空白、不分大小寫）", () => {
    expect(parseEmbedDeviceOption("cpu")).toBe("cpu");
    expect(parseEmbedDeviceOption("dml")).toBe("dml");
    expect(parseEmbedDeviceOption(" DML ")).toBe("dml");
    expect(parseEmbedDeviceOption("Auto")).toBe("auto");
  });

  it("不認識的值拋 InvalidEmbedderOptionError，訊息說明可用的值與環境變數", () => {
    try {
      parseEmbedDeviceOption("gpu");
      throw new Error("應該要拋錯");
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidEmbedderOptionError);
      const typed = error as InvalidEmbedderOptionError;
      expect(typed.option).toBe("device");
      expect(typed.message).toContain("auto");
      expect(typed.message).toContain(EMBED_DEVICE_ENV);
    }
  });
});

describe("平台解析（resolveEmbedDevice）", () => {
  it("auto：只在 Windows 解析為 dml，其他平台維持 cpu（不算退回）", () => {
    expect(resolveEmbedDevice("auto", "win32")).toEqual({ device: "dml", fallbackReason: null });
    expect(resolveEmbedDevice("auto", "linux")).toEqual({ device: "cpu", fallbackReason: null });
    expect(resolveEmbedDevice("auto", "darwin")).toEqual({ device: "cpu", fallbackReason: null });
  });

  it("cpu：任何平台都是 cpu", () => {
    for (const platform of ["win32", "linux", "darwin"]) {
      expect(resolveEmbedDevice("cpu", platform)).toEqual({ device: "cpu", fallbackReason: null });
    }
  });

  it("dml：Windows 嘗試 dml；非 Windows 直接 cpu 並註明原因", () => {
    expect(resolveEmbedDevice("dml", "win32")).toEqual({ device: "dml", fallbackReason: null });
    const plan = resolveEmbedDevice("dml", "linux");
    expect(plan.device).toBe("cpu");
    expect(plan.fallbackReason?.code).toBe("unsupported-platform");
    expect(plan.fallbackReason?.message).toContain("DirectML");
  });

  it("isDmlPlatform 只認 Windows", () => {
    expect(isDmlPlatform("win32")).toBe(true);
    expect(isDmlPlatform("linux")).toBe(false);
    expect(isDmlPlatform("darwin")).toBe(false);
  });
});

describe("DirectML adapter 索引解析（parseDmlDeviceId）", () => {
  it("未設定、空字串或空白 → 0（預設顯示卡）", () => {
    expect(DEFAULT_DML_DEVICE_ID).toBe(0);
    expect(parseDmlDeviceId(undefined)).toBe(0);
    expect(parseDmlDeviceId("")).toBe(0);
    expect(parseDmlDeviceId("   ")).toBe(0);
  });

  it("接受十進位非負整數（含前後空白）", () => {
    expect(parseDmlDeviceId("0")).toBe(0);
    expect(parseDmlDeviceId("1")).toBe(1);
    expect(parseDmlDeviceId(" 2 ")).toBe(2);
    expect(parseDmlDeviceId("7")).toBe(7);
  });

  it("非法值一律拋錯（不靜默回預設）：負數、小數、非十進位、超範圍", () => {
    for (const value of ["-1", "1.5", "0x1", "1e2", "abc", "1.0", "3,5", "+1"]) {
      expect(() => parseDmlDeviceId(value)).toThrow(InvalidEmbedderOptionError);
    }
    expect(() => parseDmlDeviceId("9007199254740993")).toThrow(InvalidEmbedderOptionError);
  });

  it("錯誤訊息指出環境變數名與值域", () => {
    try {
      parseDmlDeviceId("abc");
      throw new Error("應該要拋錯");
    } catch (error) {
      const typed = error as InvalidEmbedderOptionError;
      expect(typed.option).toBe("dmlDeviceId");
      expect(typed.message).toContain(EMBED_DML_DEVICE_ID_ENV);
      expect(typed.message).toContain("非負整數");
    }
  });
});

describe("批次視窗與序列推論", () => {  it("dml 用 32、cpu 用 16；MAX_BATCH_SIZE 仍是 CPU 的 16（既有常數不變）", () => {
    expect(deviceBatchSize("dml")).toBe(DML_BATCH_SIZE);
    expect(deviceBatchSize("cpu")).toBe(CPU_BATCH_SIZE);
    expect(DML_BATCH_SIZE).toBe(32);
    expect(CPU_BATCH_SIZE).toBe(16);
    expect(MAX_BATCH_SIZE).toBe(CPU_BATCH_SIZE);
  });

  it("只有 dml 需要序列推論（同 session 不可並發 Run）", () => {
    expect(requiresSerializedInference("dml")).toBe(true);
    expect(requiresSerializedInference("cpu")).toBe(false);
  });
});

describe("退回原因訊息（summarizeFailure）", () => {
  it("取錯誤名稱與訊息首行、遮掉家目錄前綴、限制長度", () => {
    const message = summarizeFailure(new Error("first line\nsecond line"), "/home/example");
    expect(message).toBe("Error: first line");

    const masked = summarizeFailure(new Error("載入 /home/example/models/model.onnx 失敗"), "/home/example");
    expect(masked).toContain("~/models/model.onnx");
    expect(masked).not.toContain("/home/example");

    const long = summarizeFailure(new Error("x".repeat(500)), "/home/example");
    expect(long.length).toBeLessThan(300);
  });

  it("非 Error 值也能處理", () => {
    expect(summarizeFailure("boom", "/home/example")).toBe("Error: boom");
  });
});

// ---------------------------------------------------------------------------
// 類別層級：自動退回 CPU
// ---------------------------------------------------------------------------

describe("TransformersEmbedder 裝置選擇與自動退回（mock 模型）", () => {
  it("auto 在 Windows：以 dml 載入（帶 dml EP），runtimeStatus 反映裝置與視窗", async () => {
    const embedder = new TransformersEmbedder({ platform: "win32", cacheDir: CACHE_DIR });

    // 載入前：計畫裝置即可讀取。
    const before: EmbedderRuntimeStatus = embedder.runtimeStatus;
    expect(before).toEqual({
      requestedDevice: "auto",
      device: "dml",
      loaded: false,
      fallbackReason: null,
      batchSize: DML_BATCH_SIZE,
      serializedInference: true,
      dmlDeviceId: DEFAULT_DML_DEVICE_ID,
    });

    const vectors = await embedder.embedDocuments(documents(3));
    expect(vectors).toHaveLength(3);
    for (const vec of vectors) {
      expect(vec).toHaveLength(embedder.info.dim);
      expect(Math.abs(norm(vec) - 1)).toBeLessThan(1e-3);
    }

    // 只嘗試 dml 一次，且帶 dml 的 executionProviders 設定（照 spikes/dml-bench 的作法）。
    expect(mocks.modelOptions).toHaveLength(1);
    expect(mocks.modelOptions[0]!.device).toBe("dml");
    expect(mocks.modelOptions[0]!.session_options).toEqual({
      executionProviders: [{ name: "dml", deviceId: 0 }],
    });

    expect(embedder.runtimeStatus.device).toBe("dml");
    expect(embedder.runtimeStatus.loaded).toBe(true);
    expect(embedder.runtimeStatus.fallbackReason).toBeNull();

    await embedder.dispose();
  });

  it("dml 載入失敗：自動退回 cpu、記錄原因、嵌入照常完成（不中斷）", async () => {
    mocks.behavior.loadFailsOnDml = true;
    const embedder = new TransformersEmbedder({ platform: "win32", cacheDir: CACHE_DIR });

    const vectors = await embedder.embedDocuments(documents(3));

    expect(vectors).toHaveLength(3);
    expect(mocks.modelOptions.map((options) => options.device)).toEqual(["dml", "cpu"]);

    const status = embedder.runtimeStatus;
    expect(status.device).toBe("cpu");
    expect(status.loaded).toBe(true);
    expect(status.batchSize).toBe(CPU_BATCH_SIZE);
    expect(status.serializedInference).toBe(false);
    expect(status.fallbackReason?.code).toBe("load-failed");
    expect(status.fallbackReason?.message).toContain("ModelLoadError");
    expect(status.fallbackReason?.message).toContain("DirectML 載入失敗（模擬）");
    // 退回後不再嘗試 dml。
    await embedder.embedDocuments(documents(1));
    expect(mocks.modelOptions.map((options) => options.device)).toEqual(["dml", "cpu"]);

    await embedder.dispose();
  });

  it("dml 首次使用（推論）失敗：退回 cpu 並重試同一視窗", async () => {
    mocks.behavior.inferenceFailsOnDml = true;
    const embedder = new TransformersEmbedder({ platform: "win32", cacheDir: CACHE_DIR });

    const vectors = await embedder.embedDocuments(documents(4));

    expect(vectors).toHaveLength(4);
    expect(mocks.modelOptions.map((options) => options.device)).toEqual(["dml", "cpu"]);
    expect(embedder.runtimeStatus.device).toBe("cpu");
    expect(embedder.runtimeStatus.fallbackReason?.code).toBe("inference-failed");
    expect(embedder.runtimeStatus.fallbackReason?.message).toContain("DML 推論失敗（模擬）");

    await embedder.dispose();
  });

  it("取消（AbortError）不算裝置失敗：不退回、原樣拋出", async () => {
    mocks.behavior.inferenceAbortsOnDml = true;
    const embedder = new TransformersEmbedder({ platform: "win32", cacheDir: CACHE_DIR });

    await expect(embedder.embedDocuments(documents(2))).rejects.toThrow("嵌入已取消（模擬）");

    expect(embedder.runtimeStatus.device).toBe("dml");
    expect(embedder.runtimeStatus.fallbackReason).toBeNull();
    // 只有一次 dml 嘗試（沒有因為取消而多載一次）。
    expect(mocks.modelOptions.map((options) => options.device)).toEqual(["dml"]);

    await embedder.dispose();
  });

  it("已中止的 signal：在載入模型前就拋出，不算退回", async () => {
    const embedder = new TransformersEmbedder({ platform: "win32", cacheDir: CACHE_DIR });
    const controller = new AbortController();
    controller.abort(new Error("索引已取消"));

    await expect(embedder.embedDocuments(documents(2), { signal: controller.signal })).rejects.toThrow(
      "索引已取消",
    );
    expect(mocks.modelOptions).toEqual([]);
    expect(embedder.runtimeStatus.device).toBe("dml");
    expect(embedder.runtimeStatus.fallbackReason).toBeNull();
  });

  it("非 Windows（auto 預設）：完全不嘗試 dml，理由不記成退回", async () => {
    const embedder = new TransformersEmbedder({ platform: "linux", cacheDir: CACHE_DIR });

    expect(embedder.runtimeStatus.device).toBe("cpu");
    expect(embedder.runtimeStatus.fallbackReason).toBeNull();

    await embedder.embedDocuments(documents(2));
    expect(mocks.modelOptions).toHaveLength(1);
    expect(mocks.modelOptions[0]!.device).toBe("cpu");
    expect(mocks.modelOptions[0]!.session_options).toBeUndefined();
    expect(embedder.runtimeStatus.serializedInference).toBe(false);

    await embedder.dispose();
  });

  it("明確要求 dml 但平台不支援：直接以 cpu 開始，並記 unsupported-platform", async () => {
    const embedder = new TransformersEmbedder({ platform: "darwin", device: "dml", cacheDir: CACHE_DIR });

    expect(embedder.runtimeStatus.device).toBe("cpu");
    expect(embedder.runtimeStatus.fallbackReason?.code).toBe("unsupported-platform");

    await embedder.embedDocuments(documents(1));
    expect(mocks.modelOptions.map((options) => options.device)).toEqual(["cpu"]);

    await embedder.dispose();
  });

  it("覆寫生效：環境變數可選 dml／cpu，且建構子選項優先於環境變數", async () => {
    // 環境變數 = dml（Windows）→ 走 dml。
    process.env[EMBED_DEVICE_ENV] = "dml";
    const fromEnv = new TransformersEmbedder({ platform: "win32", cacheDir: CACHE_DIR });
    expect(fromEnv.runtimeStatus).toMatchObject({ requestedDevice: "dml", device: "dml" });
    await fromEnv.dispose();

    // 環境變數 = cpu（Windows）→ 即使 auto 會選 dml，仍維持 cpu。
    process.env[EMBED_DEVICE_ENV] = "cpu";
    const explicitCpu = new TransformersEmbedder({ platform: "win32", cacheDir: CACHE_DIR });
    expect(explicitCpu.runtimeStatus).toMatchObject({ requestedDevice: "cpu", device: "cpu" });
    await explicitCpu.embedDocuments(documents(1));
    expect(mocks.modelOptions.map((options) => options.device)).toEqual(["cpu"]);
    await explicitCpu.dispose();

    // 選項優先於環境變數：環境說 dml、選項說 cpu → cpu，且不嘗試 dml。
    resetMocks();
    process.env[EMBED_DEVICE_ENV] = "dml";
    const optionWins = new TransformersEmbedder({ platform: "win32", device: "cpu", cacheDir: CACHE_DIR });
    expect(optionWins.runtimeStatus).toMatchObject({ requestedDevice: "cpu", device: "cpu" });
    await optionWins.embedDocuments(documents(1));
    expect(mocks.modelOptions.map((options) => options.device)).toEqual(["cpu"]);
    await optionWins.dispose();

    // 環境變數值無效 → 建構子直接失敗（不靜默回 auto）。
    process.env[EMBED_DEVICE_ENV] = "gpu";
    expect(() => new TransformersEmbedder({ platform: "win32", cacheDir: CACHE_DIR })).toThrow(
      InvalidEmbedderOptionError,
    );
  });

  it("批次視窗依裝置：dml 32（32＋8）、cpu 16（16＋16＋8）", async () => {
    const dml = new TransformersEmbedder({ platform: "win32", cacheDir: CACHE_DIR });
    const dmlVectors = await dml.embedDocuments(documents(40));
    expect(dmlVectors).toHaveLength(40);
    expect(mocks.windows).toEqual([32, 8]);
    await dml.dispose();

    resetMocks();
    const cpu = new TransformersEmbedder({ platform: "linux", cacheDir: CACHE_DIR });
    const cpuVectors = await cpu.embedDocuments(documents(40));
    expect(cpuVectors).toHaveLength(40);
    expect(mocks.windows).toEqual([16, 16, 8]);
    await cpu.dispose();
  });

  it("MNEMOSHELF_EMBED_DML_DEVICE_ID：指定獨顯時帶進 dml EP，且診斷欄位看得到", async () => {
    process.env[EMBED_DML_DEVICE_ID_ENV] = "1";
    const embedder = new TransformersEmbedder({ platform: "win32", cacheDir: CACHE_DIR });

    // 載入前就能從 runtimeStatus 讀出設定值（診斷用）。
    expect(embedder.runtimeStatus.dmlDeviceId).toBe(1);

    await embedder.embedDocuments(documents(2));
    expect(mocks.modelOptions[0]!.device).toBe("dml");
    expect(mocks.modelOptions[0]!.session_options).toEqual({
      executionProviders: [{ name: "dml", deviceId: 1 }],
    });
    expect(embedder.runtimeStatus.dmlDeviceId).toBe(1);

    await embedder.dispose();
  });

  it("MNEMOSHELF_EMBED_DML_DEVICE_ID：未設定時為 0，且預設值進 dml EP", async () => {
    const embedder = new TransformersEmbedder({ platform: "win32", cacheDir: CACHE_DIR });
    await embedder.embedDocuments(documents(1));
    expect(embedder.runtimeStatus.dmlDeviceId).toBe(DEFAULT_DML_DEVICE_ID);
    expect(mocks.modelOptions[0]!.session_options).toEqual({
      executionProviders: [{ name: "dml", deviceId: 0 }],
    });
    await embedder.dispose();
  });

  it("MNEMOSHELF_EMBED_DML_DEVICE_ID：非法值在**建構子**就拋錯（即使該平台不會用到 dml）", () => {
    process.env[EMBED_DML_DEVICE_ID_ENV] = "abc";
    // Windows 的 dml 路徑
    expect(() => new TransformersEmbedder({ platform: "win32", cacheDir: CACHE_DIR })).toThrow(
      InvalidEmbedderOptionError,
    );
    // 非 Windows 且明確選 cpu：仍先驗證（不靜默忽略設定錯誤）
    expect(() =>
      new TransformersEmbedder({ platform: "linux", device: "cpu", cacheDir: CACHE_DIR }),
    ).toThrow(InvalidEmbedderOptionError);
  });

  it("退回 CPU 後 dmlDeviceId 仍是設定值（診斷看得出原本要用的卡）", async () => {
    mocks.behavior.loadFailsOnDml = true;
    process.env[EMBED_DML_DEVICE_ID_ENV] = "2";
    const embedder = new TransformersEmbedder({ platform: "win32", cacheDir: CACHE_DIR });

    await embedder.embedDocuments(documents(1));

    expect(embedder.runtimeStatus.device).toBe("cpu");
    expect(embedder.runtimeStatus.fallbackReason?.code).toBe("load-failed");
    expect(embedder.runtimeStatus.dmlDeviceId).toBe(2);

    await embedder.dispose();
  });

  it("dmlDeviceId 語意：真實實作在 Linux／cpu 路徑仍回報設定值（0），不是 null", async () => {
    // 假物件（server 測試）用 null 表示「沒有 adapter 概念」；真實實作一律有設定值。
    const linux = new TransformersEmbedder({ platform: "linux", cacheDir: CACHE_DIR });
    expect(linux.runtimeStatus.device).toBe("cpu");
    expect(linux.runtimeStatus.dmlDeviceId).toBe(0);

    process.env[EMBED_DML_DEVICE_ID_ENV] = "3";
    const linuxExplicit = new TransformersEmbedder({ platform: "linux", device: "cpu", cacheDir: CACHE_DIR });
    expect(linuxExplicit.runtimeStatus.dmlDeviceId).toBe(3);
  });

  it("dml 推論失敗若發生在查詢／探測路徑，也會退回 CPU 且不中斷", async () => {
    mocks.behavior.inferenceFailsOnDml = true;
    const embedder = new TransformersEmbedder({ platform: "win32", cacheDir: CACHE_DIR });

    // 查詢路徑（embedQuery → embedText）：退回後仍回得出向量。
    const vector = await embedder.embedQuery("查詢文字");
    expect(vector).toHaveLength(embedder.info.dim);
    expect(embedder.runtimeStatus.device).toBe("cpu");
    expect(embedder.runtimeStatus.fallbackReason?.code).toBe("inference-failed");

    // 探測路徑（probe → embedImage／embedQuery）：同樣不再拋錯（合成測試圖語意不足只會回 ok:false）。
    const probe = await embedder.probe();
    expect(typeof probe.ok).toBe("boolean");
    expect(embedder.runtimeStatus.device).toBe("cpu");

    await embedder.dispose();
  });

  it("退回後的重試會以 CPU 的視窗大小重新切窗（窗序列不含退回後的 32）", async () => {
    mocks.behavior.inferenceFailsOnDml = true;
    const embedder = new TransformersEmbedder({ platform: "win32", cacheDir: CACHE_DIR });

    const vectors = await embedder.embedDocuments(documents(40));

    expect(vectors).toHaveLength(40);
    // 第一窗是 DML 的 32（失敗的那一次），退回後的每一窗都改用 CPU 的 16 重新切。
    expect(mocks.windows).toEqual([32, 16, 16, 8]);
    expect(mocks.windows.slice(1).every((size) => size <= CPU_BATCH_SIZE)).toBe(true);
    expect(embedder.runtimeStatus.batchSize).toBe(CPU_BATCH_SIZE);

    await embedder.dispose();
  });
});

/**
 * 序列推論的內部互斥：DirectML 的同一 session 不可並發 `Run`，
 * 而並發來源不只索引器（多個 root、索引＋搜尋、查詢＋探測）→ 實例本身必須互斥。
 */
describe("serializedInference 的內部互斥（同一實例的推論不重疊）", () => {
  it("兩路併發 embedDocuments → maxInflight = 1，且先到先跑（FIFO）", async () => {
    const embedder = new TransformersEmbedder({ platform: "win32", cacheDir: CACHE_DIR });
    const release = holdModel();

    const first = embedder.embedDocuments(documents(2));
    await waitForInflight(1);
    const second = embedder.embedDocuments(documents(3));
    await tick();

    // 第二路還在等鎖：處理器只被第一路用過。
    expect(mocks.windows).toEqual([2]);

    release();
    const [firstVectors, secondVectors] = await Promise.all([first, second]);
    expect(firstVectors).toHaveLength(2);
    expect(secondVectors).toHaveLength(3);
    expect(mocks.maxInflight).toBe(1);
    // 先到先跑：第二路的視窗在第一路跑完之後才出現。
    expect(mocks.windows).toEqual([2, 3]);

    await embedder.dispose();
  });

  it("等待中被 abort → 直接拒絕、不執行，且不卡住後面的呼叫", async () => {
    const embedder = new TransformersEmbedder({ platform: "win32", cacheDir: CACHE_DIR });
    const release = holdModel();

    const first = embedder.embedDocuments(documents(1));
    await waitForInflight(1);

    const controller = new AbortController();
    const waiting = embedder.embedDocuments(documents(5), { signal: controller.signal });
    await tick();
    controller.abort(new Error("索引已取消"));

    await expect(waiting).rejects.toThrow("索引已取消");
    // 被取消者完全沒有執行（處理器沒被它用過）。
    expect(mocks.windows).toEqual([1]);

    // 佇列沒有卡住：後面的呼叫照樣跑，且仍與第一路互斥。
    const third = embedder.embedDocuments(documents(4));
    release();
    const [firstVectors, thirdVectors] = await Promise.all([first, third]);
    expect(firstVectors).toHaveLength(1);
    expect(thirdVectors).toHaveLength(4);
    expect(mocks.windows).toEqual([1, 4]);
    expect(mocks.maxInflight).toBe(1);

    await embedder.dispose();
  });

  it("執行中的呼叫不受影響：它跑到一半才被 abort 的是等待者", async () => {
    const embedder = new TransformersEmbedder({ platform: "win32", cacheDir: CACHE_DIR });
    const release = holdModel();

    // 執行中的這一路自帶 signal（但不 abort），等待者才是被 abort 的那一個。
    const controller = new AbortController();
    const runner = embedder.embedDocuments(documents(2), { signal: controller.signal });
    await waitForInflight(1);

    const waiter = embedder.embedDocuments(documents(1));
    await tick();
    controller.abort(new Error("與等待者無關的取消"));

    // 等待者不受執行中那一路的取消影響，它照樣跑完。
    release();
    const [, waiterVectors] = await Promise.all([runner.catch(() => []), waiter]);
    expect(waiterVectors).toHaveLength(1);
    expect(mocks.maxInflight).toBe(1);

    await embedder.dispose();
  });

  it("CPU（未序列化）對照組：兩路併發會重疊（maxInflight = 2）", async () => {
    const embedder = new TransformersEmbedder({ platform: "linux", cacheDir: CACHE_DIR });
    const release = holdModel();

    const first = embedder.embedDocuments(documents(1));
    await waitForInflight(1);
    const second = embedder.embedDocuments(documents(1));
    await waitForInflight(2);

    expect(mocks.maxInflight).toBe(2);

    release();
    await Promise.all([first, second]);
    await embedder.dispose();
  });

  it("embedImage 也走同一把鎖（與 embedDocuments 不重疊）", async () => {
    const embedder = new TransformersEmbedder({ platform: "win32", cacheDir: CACHE_DIR });
    const release = holdModel();

    const first = embedder.embedDocuments(documents(1));
    await waitForInflight(1);
    const image = embedder.embedImage({ bytes: Uint8Array.from([1, 2, 3]) });
    await tick();

    // 圖片推論也還沒開始（處理器的 windows 只記了一次）。
    expect(mocks.windows).toEqual([1]);

    release();
    const [, imageVector] = await Promise.all([first, image]);
    expect(imageVector).toHaveLength(embedder.info.dim);
    expect(mocks.maxInflight).toBe(1);

    await embedder.dispose();
  });
});
