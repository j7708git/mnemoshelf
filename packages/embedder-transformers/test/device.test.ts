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
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isMediaDecodeError, type EmbedderRuntimeStatus } from "@mnemoshelf/core";
import {
  COREML_MLPROGRAM_FLAG,
  DEFAULT_DML_DEVICE_ID,
  DEFAULT_MODEL_ID,
  DEVICE_DECISION_SCHEMA,
  DML_BATCH_SIZE,
  EmbedderInputError,
  EMBED_DEVICE_ENV,
  EMBED_DML_DEVICE_ID_ENV,
  InvalidEmbedderOptionError,
  MAX_BATCH_SIZE,
  SELF_TEST_REASONS,
  TransformersEmbedder,
  CPU_BATCH_SIZE,
  deviceBatchSize,
  isCoreMlPlatform,
  isDmlPlatform,
  parseDmlDeviceId,
  parseEmbedDeviceOption,
  requiresSerializedInference,
  resolveEmbedDevice,
  summarizeFailure,
  writeDecisionRecord,
  type DeviceDecisionRecord,
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
    /** `load_image`（解碼階段）失敗：模擬解不開的圖。訊息刻意**不含** core 認得的措辭。 */
    imageDecodeFails: false,
    /** `load_image` 拋 `AbortError`：模擬解碼階段被取消（必須原樣拋出、不算輸入錯誤）。 */
    imageDecodeAborts: false,
    /** 建 CoreML session 失敗（自我測試的「載入錯」）。 */
    loadFailsOnCoreml: false,
    /**
     * CoreML 在第 N 次推論之後開始失敗（`null`＝不失敗）。
     * 自我測試本身會用掉 2 次（暖機＋計時），因此 2 代表「測試通過、真推論才壞」。
     */
    coremlInferenceFailsAfter: null as number | null,
    /** CoreML 的向量偏移（加在第二維）：0＝與 CPU 完全一致，0.05 會讓餘弦掉到 0.99875。 */
    coremlVectorDrift: 0,
    /** 每個裝置的單次推論延遲（毫秒）：用來控制自我測試量到的吞吐倍率。 */
    delayMs: { cpu: 0, dml: 0, coreml: 0 } as Record<string, number>,
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
  /**
   * 768 維的合成輸出列（第一維為 1 → 截斷正規化後模長仍是 1）。
   * `drift` 加在第二維：與 CPU 的餘弦會變成 `1 / sqrt(1 + drift²)`，用來模擬精度差異。
   */
  const row = (drift = 0): number[] => {
    const values: number[] = Array.from({ length: 768 }, (_, index) => (index === 0 ? 1 : 0));
    if (drift !== 0) values[1] = drift;
    return values;
  };

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
        const device = options?.device as string;
        if (mocks.behavior.loadFailsOnDml && device === "dml") {
          throw new Error("DirectML 載入失敗（模擬）");
        }
        if (mocks.behavior.loadFailsOnCoreml && device === "coreml") {
          throw new Error("CoreML 載入失敗（模擬）");
        }
        /** 這個 session 已被推論幾次（CoreML 的失敗開關用）。 */
        let calls = 0;
        const model = async (inputs: { batch?: number }): Promise<unknown> => {
          const count = inputs?.batch ?? 1;
          calls += 1;
          mocks.inflight += 1;
          mocks.maxInflight = Math.max(mocks.maxInflight, mocks.inflight);
          try {
            if (mocks.gate !== null) await mocks.gate;
            const delay = mocks.behavior.delayMs[device] ?? 0;
            if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
            if (device === "dml") {
              if (mocks.behavior.inferenceAbortsOnDml) {
                throw Object.assign(new Error("嵌入已取消（模擬）"), { name: "AbortError" });
              }
              if (mocks.behavior.inferenceFailsOnDml) throw new Error("DML 推論失敗（模擬）");
            }
            if (
              device === "coreml" &&
              mocks.behavior.coremlInferenceFailsAfter !== null &&
              calls > mocks.behavior.coremlInferenceFailsAfter
            ) {
              throw new Error("CoreML 推論失敗（模擬）");
            }
            const drift = device === "coreml" ? mocks.behavior.coremlVectorDrift : 0;
            return {
              sentence_embedding: {
                dims: [count, 768],
                tolist: async () => Array.from({ length: count }, () => row(drift)),
              },
            };
          } finally {
            mocks.inflight -= 1;
          }
        };
        return Object.assign(model, { dispose: async () => undefined });
      },
    },
    load_image: async () => {
      if (mocks.behavior.imageDecodeAborts) {
        throw Object.assign(new Error("解碼已取消（模擬）"), { name: "AbortError" });
      }
      if (mocks.behavior.imageDecodeFails) {
        // 刻意用一句 core 的訊息清單**認不得**的措辭：分類只能靠 EmbedderInputError 標記。
        throw new Error("圖片位元組解不開（模擬，措辭不在 core 的清單內）");
      }
      return {};
    },
  };
});

/** 測試用快取目錄名（mock 不碰檔案系統，只需一個非空字串）。 */
const CACHE_DIR = "test-cache";

function resetMocks(): void {
  mocks.behavior.loadFailsOnDml = false;
  mocks.behavior.inferenceFailsOnDml = false;
  mocks.behavior.inferenceAbortsOnDml = false;
  mocks.behavior.imageDecodeFails = false;
  mocks.behavior.imageDecodeAborts = false;
  mocks.behavior.loadFailsOnCoreml = false;
  mocks.behavior.coremlInferenceFailsAfter = null;
  mocks.behavior.coremlVectorDrift = 0;
  mocks.behavior.delayMs = { cpu: 0, dml: 0, coreml: 0 };
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

/** 測試用的暫存目錄（裝置決定快取檔放在裡面；絕不碰使用者的家目錄或真實快取）。 */
const tempDirs: string[] = [];

/** 建一個暫存目錄（macOS 分支的測試一律把 `deviceDecisionPath` 指進來）。 */
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mnemoshelf-embedder-test-"));
  tempDirs.push(dir);
  return dir;
}

/** 寫一份決定記錄（模擬「上一次啟動留下的決定」）。 */
function writeRecord(path: string, overrides: Partial<DeviceDecisionRecord> = {}): void {
  const record: DeviceDecisionRecord = {
    schema: DEVICE_DECISION_SCHEMA,
    outcome: "usable",
    testedAt: "2026-10-15T00:00:00.000Z",
    appVersion: "1.0.0",
    modelId: DEFAULT_MODEL_ID,
    dtype: "q4",
    platform: "darwin",
    arch: process.arch,
    coreMlFlags: COREML_MLPROGRAM_FLAG,
    ...overrides,
  };
  writeDecisionRecord(path, record);
}

/** 讀回決定記錄的原始欄位（測試斷言檔案內容用）。 */
function readRecord(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

/** 建立一個 macOS＋auto 的 embedder（暫存快取路徑），回傳它與快取檔路徑。 */
function darwinEmbedder(options: { appVersion?: string; device?: "auto" | "coreml" } = {}): {
  embedder: TransformersEmbedder;
  decisionPath: string;
} {
  const dir = tempDir();
  const decisionPath = join(dir, "device-decision.json");
  const embedder = new TransformersEmbedder({
    platform: "darwin",
    cacheDir: CACHE_DIR,
    deviceDecisionPath: decisionPath,
    ...(options.appVersion === undefined ? {} : { appVersion: options.appVersion }),
    ...(options.device === undefined ? {} : { device: options.device }),
  });
  return { embedder, decisionPath };
}

afterEach(() => {
  resetMocks();
  restoreEnv(EMBED_DEVICE_ENV, originalDeviceEnv);
  restoreEnv(EMBED_DML_DEVICE_ID_ENV, originalDmlDeviceIdEnv);
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
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

  it("cpu／dml／coreml／auto 都接受（去空白、不分大小寫）", () => {
    expect(parseEmbedDeviceOption("cpu")).toBe("cpu");
    expect(parseEmbedDeviceOption("dml")).toBe("dml");
    expect(parseEmbedDeviceOption("coreml")).toBe("coreml");
    expect(parseEmbedDeviceOption(" DML ")).toBe("dml");
    expect(parseEmbedDeviceOption(" CoreML ")).toBe("coreml");
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
  it("auto：Windows → dml（既有行為不動）、macOS → coreml（新）、其他 → cpu（不算退回）", () => {
    expect(resolveEmbedDevice("auto", "win32")).toEqual({ device: "dml", fallbackReason: null });
    expect(resolveEmbedDevice("auto", "darwin")).toEqual({ device: "coreml", fallbackReason: null });
    expect(resolveEmbedDevice("auto", "linux")).toEqual({ device: "cpu", fallbackReason: null });
    expect(resolveEmbedDevice("auto", "freebsd")).toEqual({ device: "cpu", fallbackReason: null });
  });

  it("auto 不得在非 macOS 平台解析出 coreml（Linux／Windows 不觸 CoreML）", () => {
    for (const platform of ["linux", "win32", "freebsd", "android"]) {
      expect(resolveEmbedDevice("auto", platform).device).not.toBe("coreml");
    }
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

  it("coreml：macOS 嘗試 coreml；其他平台直接 cpu 並註明原因", () => {
    expect(resolveEmbedDevice("coreml", "darwin")).toEqual({ device: "coreml", fallbackReason: null });
    for (const platform of ["linux", "win32"]) {
      const plan = resolveEmbedDevice("coreml", platform);
      expect(plan.device).toBe("cpu");
      expect(plan.fallbackReason?.code).toBe("unsupported-platform");
      expect(plan.fallbackReason?.message).toContain("CoreML");
    }
  });

  it("isDmlPlatform 只認 Windows；isCoreMlPlatform 只認 macOS", () => {
    expect(isDmlPlatform("win32")).toBe(true);
    expect(isDmlPlatform("linux")).toBe(false);
    expect(isDmlPlatform("darwin")).toBe(false);
    expect(isCoreMlPlatform("darwin")).toBe(true);
    expect(isCoreMlPlatform("win32")).toBe(false);
    expect(isCoreMlPlatform("linux")).toBe(false);
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

describe("批次視窗與序列推論", () => {  it("dml 用 32、cpu／coreml 用 16；MAX_BATCH_SIZE 仍是 CPU 的 16（既有常數不變）", () => {
    expect(deviceBatchSize("dml")).toBe(DML_BATCH_SIZE);
    expect(deviceBatchSize("cpu")).toBe(CPU_BATCH_SIZE);
    expect(deviceBatchSize("coreml")).toBe(CPU_BATCH_SIZE);
    expect(DML_BATCH_SIZE).toBe(32);
    expect(CPU_BATCH_SIZE).toBe(16);
    expect(MAX_BATCH_SIZE).toBe(CPU_BATCH_SIZE);
  });

  it("dml 與 coreml 都需要序列推論（同 session 不可並發 Run）", () => {
    expect(requiresSerializedInference("dml")).toBe(true);
    expect(requiresSerializedInference("coreml")).toBe(true);
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
      // 所有裝置路徑都關閉 CPU arena（單一配置不得逼近 2 GiB；見 createBackend 的說明）。
      enableCpuMemArena: false,
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
    // CPU 路徑也帶 CPU arena 開關（不再是 undefined：那正是原本只加在 dml 分支的落差）。
    expect(mocks.modelOptions[0]!.session_options).toEqual({ enableCpuMemArena: false });
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
      enableCpuMemArena: false,
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
      // 所有裝置路徑都關閉 CPU arena（單一配置不得逼近 2 GiB；見 createBackend 的說明）。
      enableCpuMemArena: false,
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
 * 圖片解碼／輸入類錯誤**不**觸發裝置退回（修復輪：一張壞圖不該讓整場永久退回 CPU）。
 *
 * 判別力：`imageDecodeFails` 的訊息刻意不在 core 的措辭清單內，因此「被分類」只可能來自
 * `EmbedderInputError` 標記；若把 `shouldFallBack` 的輸入類例外拿掉，第一條測試會看到
 * `device` 變成 cpu、`fallbackReason` 非 null、且模型被重新載入成 cpu → 失敗。
 */
describe("圖片解碼／輸入類失敗：不退回 CPU（mock 模型）", () => {
  it("dml 下的解碼失敗：不退回、以 EmbedderInputError 分類、core 認得", async () => {
    mocks.behavior.imageDecodeFails = true;
    const embedder = new TransformersEmbedder({ platform: "win32", cacheDir: CACHE_DIR });

    const error = await embedder.embedImage({ bytes: Uint8Array.from([1, 2, 3]) }).then(
      () => null,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(EmbedderInputError);
    expect((error as EmbedderInputError).code).toBe("undecodable");
    // 跨套件契約：core 以穩定標記（而非訊息措辭）判成「解不開」→ 會被記成 skipped。
    expect(isMediaDecodeError(error)).toBe(true);

    const status = embedder.runtimeStatus;
    expect(status.device).toBe("dml");
    expect(status.fallbackReason).toBeNull();
    // 沒有退回＝沒有第二次載入（更沒有 CPU 的載入）。
    expect(mocks.modelOptions.map((options) => options.device)).toEqual(["dml"]);

    await embedder.dispose();
  });

  it("對照組：dml 下的**推論**錯誤（圖片路徑）仍會退回 CPU 並重試", async () => {
    mocks.behavior.inferenceFailsOnDml = true;
    const embedder = new TransformersEmbedder({ platform: "win32", cacheDir: CACHE_DIR });

    const vector = await embedder.embedImage({ bytes: Uint8Array.from([1, 2, 3]) });

    expect(vector).toHaveLength(embedder.info.dim);
    expect(embedder.runtimeStatus.device).toBe("cpu");
    expect(embedder.runtimeStatus.fallbackReason?.code).toBe("inference-failed");
    expect(mocks.modelOptions.map((options) => options.device)).toEqual(["dml", "cpu"]);

    await embedder.dispose();
  });

  it("cpu 下的解碼失敗：同樣以 EmbedderInputError 分類（indexer 才記得到 skipped 而非 failed）", async () => {
    mocks.behavior.imageDecodeFails = true;
    const embedder = new TransformersEmbedder({ platform: "linux", cacheDir: CACHE_DIR });

    const error = await embedder.embedImage({ bytes: Uint8Array.from([1, 2, 3]) }).then(
      () => null,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(EmbedderInputError);
    expect(isMediaDecodeError(error)).toBe(true);
    expect(embedder.runtimeStatus.device).toBe("cpu");

    await embedder.dispose();
  });

  it("解碼階段被取消（AbortError）：原樣拋出、不算輸入錯誤、也不退回", async () => {
    mocks.behavior.imageDecodeAborts = true;
    const embedder = new TransformersEmbedder({ platform: "win32", cacheDir: CACHE_DIR });

    const error = await embedder.embedImage({ bytes: Uint8Array.from([1, 2, 3]) }).then(
      () => null,
      (caught: unknown) => caught,
    );

    expect((error as Error).name).toBe("AbortError");
    expect(error).not.toBeInstanceOf(EmbedderInputError);
    expect(embedder.runtimeStatus.device).toBe("dml");
    expect(embedder.runtimeStatus.fallbackReason).toBeNull();

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

// ---------------------------------------------------------------------------
// CoreML（macOS）：自我測試、決定快取與退回
//
// 這些測試全在**非 macOS** 的開發機上跑：`@huggingface/transformers` 以 `vi.mock` 注入，
// 平台以建構子選項覆寫成 `darwin`，決定快取檔指向暫存目錄（絕不寫入使用者的家目錄）。
// 量到的「吞吐倍率」以 mock 的推論延遲控制：`delayMs.cpu / delayMs.coreml` 就是倍率。
// ---------------------------------------------------------------------------

describe("auto 在 macOS：CoreML 自我測試與決定快取（mock 模型）", () => {
  it("沒有快取：先量 CPU、再量 CoreML，通過後採用 coreml（並保留測試時建好的 session）", async () => {
    mocks.behavior.delayMs = { cpu: 30, dml: 0, coreml: 5 };
    const { embedder, decisionPath } = darwinEmbedder({ appVersion: "1.2.3" });

    // 載入前：計畫裝置就是 coreml（尚未測試 → 沒有 selfTest）。
    const before: EmbedderRuntimeStatus = embedder.runtimeStatus;
    expect(before).toMatchObject({
      requestedDevice: "auto",
      device: "coreml",
      loaded: false,
      fallbackReason: null,
      batchSize: CPU_BATCH_SIZE,
      serializedInference: true,
    });
    expect(before.selfTest).toBeUndefined();

    const vectors = await embedder.embedDocuments(documents(3));
    expect(vectors).toHaveLength(3);

    // 自我測試的順序：CPU 基準 → CoreML（各兩次推論：暖機＋計時）。
    expect(mocks.modelOptions.map((options) => options.device)).toEqual(["cpu", "coreml"]);
    expect(mocks.modelOptions[1]!.session_options).toEqual({
      enableCpuMemArena: false,
      executionProviders: [{ name: "coreml", coreMlFlags: COREML_MLPROGRAM_FLAG }],
    });

    const status = embedder.runtimeStatus;
    expect(status.device).toBe("coreml");
    expect(status.loaded).toBe(true);
    expect(status.fallbackReason).toBeNull();
    expect(status.selfTest?.outcome).toBe("usable");
    expect(status.selfTest?.throughputRatio).toBeGreaterThanOrEqual(1.3);
    expect(status.selfTest?.minCosine).toBeCloseTo(1, 6);
    expect(status.selfTest?.testedAt).toBeTypeOf("string");
    // 建置耗時（純診斷數據）：兩邊都有值且是有限數字（真實時鐘；不設門檻）。
    expect(status.selfTest?.cpuSessionBuildMs).toBeTypeOf("number");
    expect(Number.isFinite(status.selfTest?.cpuSessionBuildMs)).toBe(true);
    expect(status.selfTest?.coreMlSessionBuildMs).toBeTypeOf("number");
    expect(Number.isFinite(status.selfTest?.coreMlSessionBuildMs)).toBe(true);

    // 決定落地：檔案裡的欄位足以說明「是誰、什麼時候、量到多少」。
    const record = readRecord(decisionPath);
    expect(record["outcome"]).toBe("usable");
    expect(record["appVersion"]).toBe("1.2.3");
    expect(record["modelId"]).toBe(DEFAULT_MODEL_ID);
    expect(record["dtype"]).toBe("q4");
    expect(record["platform"]).toBe("darwin");
    expect(record["arch"]).toBe(process.arch);
    expect(record["coreMlFlags"]).toBe(COREML_MLPROGRAM_FLAG);
    expect(record["schema"]).toBe(DEVICE_DECISION_SCHEMA);
    expect(record["throughputRatio"]).toBeGreaterThanOrEqual(1.3);
    expect(record["cpuSessionBuildMs"]).toBe(status.selfTest?.cpuSessionBuildMs);
    expect(record["coreMlSessionBuildMs"]).toBe(status.selfTest?.coreMlSessionBuildMs);

    // 沿用的是測試中建好的 session：再嵌入一次不會多載模型（CoreML 編譯很貴）。
    await embedder.embedDocuments(documents(2));
    expect(mocks.modelOptions.map((options) => options.device)).toEqual(["cpu", "coreml"]);

    await embedder.dispose();
  });

  it("沒有快取且 CoreML 較慢：退回 cpu、記 accel-slow、寫下 unusable", async () => {
    mocks.behavior.delayMs = { cpu: 5, dml: 0, coreml: 40 };
    const { embedder, decisionPath } = darwinEmbedder({ appVersion: "1.0.0" });

    const vectors = await embedder.embedDocuments(documents(2));
    expect(vectors).toHaveLength(2);

    const status = embedder.runtimeStatus;
    expect(status.device).toBe("cpu");
    expect(status.batchSize).toBe(CPU_BATCH_SIZE);
    expect(status.serializedInference).toBe(false);
    expect(status.fallbackReason?.code).toBe("accel-slow");
    expect(status.fallbackReason?.message).toContain("1.3");
    expect(status.selfTest?.outcome).toBe("unusable");
    expect(status.selfTest?.reason).toBe(SELF_TEST_REASONS.tooSlow);

    // 測試的 CPU → coreml，之後正式用 CPU 重載一次。
    expect(mocks.modelOptions.map((options) => options.device)).toEqual(["cpu", "coreml", "cpu"]);
    const record = readRecord(decisionPath);
    expect(record["outcome"]).toBe("unusable");
    expect(record["reason"]).toBe(SELF_TEST_REASONS.tooSlow);
    expect(record["throughputRatio"]).toBeLessThan(1.3);

    await embedder.dispose();
  });

  it("沒有快取且向量不一致：退回 cpu、記 accel-inconsistent（餘弦 0.99875 < 0.999）", async () => {
    mocks.behavior.delayMs = { cpu: 20, dml: 0, coreml: 5 };
    mocks.behavior.coremlVectorDrift = 0.05;
    const { embedder, decisionPath } = darwinEmbedder({ appVersion: "1.0.0" });

    await embedder.embedDocuments(documents(1));

    expect(embedder.runtimeStatus.device).toBe("cpu");
    expect(embedder.runtimeStatus.fallbackReason?.code).toBe("accel-inconsistent");
    expect(embedder.runtimeStatus.selfTest?.reason).toBe(SELF_TEST_REASONS.inconsistent);
    const record = readRecord(decisionPath);
    expect(record["reason"]).toBe(SELF_TEST_REASONS.inconsistent);
    expect(record["minCosine"]).toBeLessThan(0.999);

    await embedder.dispose();
  });

  it("沒有快取且 CoreML 載入失敗：退回 cpu、記 load-failed，並把結果寫進快取", async () => {
    mocks.behavior.loadFailsOnCoreml = true;
    const { embedder, decisionPath } = darwinEmbedder({ appVersion: "1.0.0" });

    const vectors = await embedder.embedDocuments(documents(1));
    expect(vectors).toHaveLength(1);

    const status = embedder.runtimeStatus;
    expect(status.device).toBe("cpu");
    expect(status.fallbackReason?.code).toBe("load-failed");
    expect(status.fallbackReason?.message).toContain("ModelLoadError");
    expect(status.fallbackReason?.message).toContain("CoreML 載入失敗（模擬）");
    expect(status.selfTest?.outcome).toBe("unusable");
    expect(status.selfTest?.reason).toBe(SELF_TEST_REASONS.loadFailed);
    expect(mocks.modelOptions.map((options) => options.device)).toEqual(["cpu", "coreml", "cpu"]);

    const record = readRecord(decisionPath);
    expect(record["outcome"]).toBe("unusable");
    expect(record["reason"]).toBe(SELF_TEST_REASONS.loadFailed);

    await embedder.dispose();
  });

  it("快取記 crashed：完全不嘗試 coreml（永久用 cpu），並保留原記錄", async () => {
    const { embedder, decisionPath } = darwinEmbedder({ appVersion: "1.0.0" });
    writeRecord(decisionPath, { outcome: "crashed", reason: SELF_TEST_REASONS.crashed });
    mocks.behavior.inferenceFailsOnDml = false;

    // 需要「重新建構」才能讀到剛寫下的記錄（建構子同步讀快取）。
    const second = new TransformersEmbedder({
      platform: "darwin",
      cacheDir: CACHE_DIR,
      deviceDecisionPath: decisionPath,
      appVersion: "1.0.0",
    });

    const status = second.runtimeStatus;
    expect(status.device).toBe("cpu");
    expect(status.fallbackReason?.code).toBe("accel-crashed");
    expect(status.selfTest?.outcome).toBe("crashed");

    await second.embedDocuments(documents(1));
    // 連一次 coreml 都沒試（崩潰是機器層級的事實，重試只會再死一次）。
    expect(mocks.modelOptions.map((options) => options.device)).toEqual(["cpu"]);
    expect(readRecord(decisionPath)["outcome"]).toBe("crashed");

    await second.dispose();
    await embedder.dispose();
  });

  it("快取是 pending（上次測試中行程死掉）：推導成 crashed、改寫檔案、永久用 cpu", async () => {
    const dir = tempDir();
    const decisionPath = join(dir, "device-decision.json");
    writeRecord(decisionPath, {
      outcome: "pending",
      reason: undefined,
      throughputRatio: undefined,
      minCosine: undefined,
    });
    // pending 是「有人在測試中」的標記，不該有結論欄位。
    expect(readRecord(decisionPath)["outcome"]).toBe("pending");

    const embedder = new TransformersEmbedder({
      platform: "darwin",
      cacheDir: CACHE_DIR,
      deviceDecisionPath: decisionPath,
      appVersion: "1.0.0",
    });

    const status = embedder.runtimeStatus;
    expect(status.device).toBe("cpu");
    expect(status.batchSize).toBe(CPU_BATCH_SIZE);
    expect(status.fallbackReason?.code).toBe("accel-crashed");
    expect(status.selfTest?.outcome).toBe("crashed");
    expect(status.selfTest?.reason).toBe(SELF_TEST_REASONS.crashed);

    // 檔案被補成 crashed（下一次啟動不必再判讀 pending）。
    const rewritten = readRecord(decisionPath);
    expect(rewritten["outcome"]).toBe("crashed");
    expect(rewritten["reason"]).toBe(SELF_TEST_REASONS.crashed);
    expect(rewritten["testedAt"]).toBe("2026-10-15T00:00:00.000Z");

    await embedder.embedDocuments(documents(1));
    expect(mocks.modelOptions.map((options) => options.device)).toEqual(["cpu"]);

    await embedder.dispose();
  });

  it("快取記 usable（同版本）：直接載 coreml、不跑自我測試、不改寫檔案", async () => {
    const dir = tempDir();
    const decisionPath = join(dir, "device-decision.json");
    writeRecord(decisionPath, {
      outcome: "usable",
      appVersion: "1.0.0",
      throughputRatio: 2.5,
      cpuSessionBuildMs: 380,
      coreMlSessionBuildMs: 11_500,
    });
    const before = readFileSync(decisionPath, "utf8");

    const embedder = new TransformersEmbedder({
      platform: "darwin",
      cacheDir: CACHE_DIR,
      deviceDecisionPath: decisionPath,
      appVersion: "1.0.0",
    });

    expect(embedder.runtimeStatus.device).toBe("coreml");
    // 上一次量到的建置耗時也要從快取讀回來（診斷看得到「上次啟動花了多久編譯」）。
    expect(embedder.runtimeStatus.selfTest).toMatchObject({
      outcome: "usable",
      throughputRatio: 2.5,
      cpuSessionBuildMs: 380,
      coreMlSessionBuildMs: 11_500,
    });

    await embedder.embedDocuments(documents(1));
    // 只有一次載入，而且是 coreml（沒有為了量測而載 CPU）。
    expect(mocks.modelOptions.map((options) => options.device)).toEqual(["coreml"]);
    expect(embedder.runtimeStatus.device).toBe("coreml");
    expect(readFileSync(decisionPath, "utf8")).toBe(before);

    await embedder.dispose();
  });

  it("快取記 unusable（同版本）：直接 cpu、不跑自我測試", async () => {
    const dir = tempDir();
    const decisionPath = join(dir, "device-decision.json");
    writeRecord(decisionPath, {
      outcome: "unusable",
      reason: SELF_TEST_REASONS.tooSlow,
      appVersion: "1.0.0",
      throughputRatio: 0.9,
    });

    const embedder = new TransformersEmbedder({
      platform: "darwin",
      cacheDir: CACHE_DIR,
      deviceDecisionPath: decisionPath,
      appVersion: "1.0.0",
    });

    const status = embedder.runtimeStatus;
    expect(status.device).toBe("cpu");
    expect(status.fallbackReason?.code).toBe("accel-slow");
    expect(status.selfTest).toMatchObject({ outcome: "unusable", reason: SELF_TEST_REASONS.tooSlow });

    await embedder.embedDocuments(documents(1));
    expect(mocks.modelOptions.map((options) => options.device)).toEqual(["cpu"]);

    await embedder.dispose();
  });

  it("appVersion 變更：重測一次並改寫記錄（即使是 usable 也重測）", async () => {
    mocks.behavior.delayMs = { cpu: 15, dml: 0, coreml: 3 };
    const dir = tempDir();
    const decisionPath = join(dir, "device-decision.json");
    writeRecord(decisionPath, { outcome: "usable", appVersion: "0.9.0", throughputRatio: 9 });

    const embedder = new TransformersEmbedder({
      platform: "darwin",
      cacheDir: CACHE_DIR,
      deviceDecisionPath: decisionPath,
      appVersion: "1.0.0",
    });

    // 版本不符＝沒有可用的決定 → 載入時重測。
    expect(embedder.runtimeStatus.selfTest).toBeUndefined();
    await embedder.embedDocuments(documents(1));
    expect(mocks.modelOptions.map((options) => options.device)).toEqual(["cpu", "coreml"]);

    const record = readRecord(decisionPath);
    expect(record["appVersion"]).toBe("1.0.0");
    expect(record["outcome"]).toBe("usable");
    expect(record["throughputRatio"]).not.toBe(9);

    await embedder.dispose();
  });

  it("dtype 不同：快取決定不適用（重測），不會被舊量測誤導", async () => {
    mocks.behavior.delayMs = { cpu: 15, dml: 0, coreml: 3 };
    const dir = tempDir();
    const decisionPath = join(dir, "device-decision.json");
    writeRecord(decisionPath, { outcome: "unusable", reason: SELF_TEST_REASONS.tooSlow, dtype: "q8" });

    const embedder = new TransformersEmbedder({
      platform: "darwin",
      cacheDir: CACHE_DIR,
      deviceDecisionPath: decisionPath,
      appVersion: "1.0.0",
    });
    expect(embedder.runtimeStatus.device).toBe("coreml");

    await embedder.embedDocuments(documents(1));
    expect(mocks.modelOptions.map((options) => options.device)).toEqual(["cpu", "coreml"]);
    expect(readRecord(decisionPath)["dtype"]).toBe("q4");

    await embedder.dispose();
  });

  it("CoreML 建得起來但推論失敗：退回 cpu、記 inference-failed，並更新快取", async () => {
    mocks.behavior.delayMs = { cpu: 10, dml: 0, coreml: 3 };
    // 自我測試用掉 2 次推論（暖機＋計時），第 3 次（真正的嵌入）才失敗。
    mocks.behavior.coremlInferenceFailsAfter = 2;
    const { embedder, decisionPath } = darwinEmbedder({ appVersion: "1.0.0" });

    const vectors = await embedder.embedDocuments(documents(2));
    expect(vectors).toHaveLength(2);

    const status = embedder.runtimeStatus;
    expect(status.device).toBe("cpu");
    expect(status.fallbackReason?.code).toBe("inference-failed");
    expect(status.fallbackReason?.message).toContain("CoreML 推論失敗（模擬）");
    expect(status.selfTest).toMatchObject({ outcome: "unusable", reason: SELF_TEST_REASONS.inferenceFailed });
    expect(mocks.modelOptions.map((options) => options.device)).toEqual(["cpu", "coreml", "cpu"]);

    // 失敗的結果也寫進快取：下次啟動不必再用一次壞掉的裝置。
    const record = readRecord(decisionPath);
    expect(record["outcome"]).toBe("unusable");
    expect(record["reason"]).toBe(SELF_TEST_REASONS.inferenceFailed);

    await embedder.dispose();
  });

  it("明示 coreml（darwin）：強制嘗試、不跑自我測試、不讀也不寫快取", async () => {
    mocks.behavior.delayMs = { cpu: 30, dml: 0, coreml: 5 };
    const dir = tempDir();
    const decisionPath = join(dir, "device-decision.json");
    // 即使有一份「崩潰」的記錄（auto 會永久退回 CPU），明示 coreml 仍然照試。
    writeRecord(decisionPath, { outcome: "crashed" });
    const before = readFileSync(decisionPath, "utf8");

    const embedder = new TransformersEmbedder({
      platform: "darwin",
      device: "coreml",
      cacheDir: CACHE_DIR,
      deviceDecisionPath: decisionPath,
      appVersion: "1.0.0",
    });

    expect(embedder.runtimeStatus).toMatchObject({ requestedDevice: "coreml", device: "coreml" });
    expect(embedder.runtimeStatus.selfTest).toBeUndefined();

    await embedder.embedDocuments(documents(1));
    // 沒有 CPU 基準、沒有自我測試：只有一次 coreml 載入。
    expect(mocks.modelOptions.map((options) => options.device)).toEqual(["coreml"]);
    expect(embedder.runtimeStatus.device).toBe("coreml");
    expect(embedder.runtimeStatus.fallbackReason).toBeNull();
    expect(embedder.runtimeStatus.selfTest).toBeUndefined();
    // 快取檔原封不動（不讀、不寫）。
    expect(readFileSync(decisionPath, "utf8")).toBe(before);

    await embedder.dispose();
  });

  it("coreml 的序列推論互斥：兩路併發不重疊（沿用 dml 的骨架）", async () => {
    const dir = tempDir();
    const decisionPath = join(dir, "device-decision.json");
    writeRecord(decisionPath, { outcome: "usable", appVersion: "1.0.0" });

    const embedder = new TransformersEmbedder({
      platform: "darwin",
      cacheDir: CACHE_DIR,
      deviceDecisionPath: decisionPath,
      appVersion: "1.0.0",
    });
    const release = holdModel();

    const first = embedder.embedDocuments(documents(1));
    await waitForInflight(1);
    const second = embedder.embedDocuments(documents(2));
    await tick();

    expect(mocks.maxInflight).toBe(1);
    expect(mocks.windows).toEqual([1]);

    release();
    await Promise.all([first, second]);
    expect(mocks.maxInflight).toBe(1);
    expect(mocks.windows).toEqual([1, 2]);

    await embedder.dispose();
  });
});

describe("非 macOS／非 Windows 平台：不碰 CoreML，也不碰裝置決定快取", () => {
  it("auto（linux）：全程 cpu，暫存目錄不會出現任何檔案", async () => {
    const dir = tempDir();
    const decisionPath = join(dir, "device-decision.json");
    const embedder = new TransformersEmbedder({
      platform: "linux",
      cacheDir: CACHE_DIR,
      deviceDecisionPath: decisionPath,
    });

    expect(embedder.runtimeStatus).toMatchObject({ requestedDevice: "auto", device: "cpu" });
    expect(embedder.runtimeStatus.selfTest).toBeUndefined();

    await embedder.embedDocuments(documents(2));
    expect(mocks.modelOptions.map((options) => options.device)).toEqual(["cpu"]);
    expect(readdirSync(dir)).toEqual([]);

    await embedder.dispose();
  });

  it("明示 coreml（linux）：以 cpu 開始、記 unsupported-platform、不載入 coreml", async () => {
    const dir = tempDir();
    const decisionPath = join(dir, "device-decision.json");
    const embedder = new TransformersEmbedder({
      platform: "linux",
      device: "coreml",
      cacheDir: CACHE_DIR,
      deviceDecisionPath: decisionPath,
    });

    expect(embedder.runtimeStatus.device).toBe("cpu");
    expect(embedder.runtimeStatus.fallbackReason?.code).toBe("unsupported-platform");
    expect(embedder.runtimeStatus.fallbackReason?.message).toContain("CoreML");

    await embedder.embedDocuments(documents(1));
    expect(mocks.modelOptions.map((options) => options.device)).toEqual(["cpu"]);
    expect(readdirSync(dir)).toEqual([]);

    await embedder.dispose();
  });

  it("auto（win32）：行為不變（dml），且完全不碰裝置決定快取", async () => {
    const dir = tempDir();
    const decisionPath = join(dir, "device-decision.json");
    const embedder = new TransformersEmbedder({
      platform: "win32",
      cacheDir: CACHE_DIR,
      deviceDecisionPath: decisionPath,
    });

    expect(embedder.runtimeStatus).toMatchObject({ requestedDevice: "auto", device: "dml" });
    expect(embedder.runtimeStatus.selfTest).toBeUndefined();

    await embedder.embedDocuments(documents(2));
    expect(mocks.modelOptions.map((options) => options.device)).toEqual(["dml"]);
    expect(mocks.modelOptions[0]!.session_options).toEqual({
      enableCpuMemArena: false,
      executionProviders: [{ name: "dml", deviceId: DEFAULT_DML_DEVICE_ID }],
    });
    expect(readdirSync(dir)).toEqual([]);

    await embedder.dispose();
  });
});
