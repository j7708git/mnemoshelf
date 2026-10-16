/**
 * `downloadModelFiles()` 的 session options 驗證（以 mock 取代 `@huggingface/transformers`）。
 *
 * 這裡建的 session 會**真的跑一次推論**（下載後驗證模型可用），因此它與 embedder 的
 * `createBackend()` 必須帶同一組 ONNX Runtime options——尤其是
 * `enableCpuMemArena: false`：ORT 的 CPU arena 擴張會產生 ≥2 GiB 的單一配置，
 * 在 Electron 內會被 Chromium 的 PartitionAlloc 直接終止行程（整個 app 閃退）。
 * 少了它，全新安裝在 macOS 的「下載後驗證」階段就會踩到與索引時同一顆地雷。
 *
 * 測試不連網、不載入模型：只驗證傳給 `from_pretrained()` 的參數與收尾的 dispose。
 */
import { describe, expect, it, vi } from "vitest";
import { env } from "@huggingface/transformers";
import { MODEL_PROFILE } from "../src/model-profile.js";
import { MODEL_SESSION_OPTIONS, downloadModelFiles } from "../src/model-download.js";

/** mock 模組留下的呼叫記錄（`vi.hoisted` 讓 `vi.mock` 的工廠也能取用）。 */
const state = vi.hoisted(() => ({
  /** 每次 `AutoModel.from_pretrained()` 的參數（session_options 存複本，避免被下方突變影響）。 */
  modelOptions: [] as {
    modelId?: string;
    config?: unknown;
    device?: string;
    dtype?: unknown;
    session_options?: Record<string, unknown>;
    progress_callback?: unknown;
  }[],
  /** `AutoConfig.from_pretrained()` 回傳的 config（驗證 audio_config 是否被關掉）。 */
  configs: [] as { audio_config?: unknown }[],
  /** auto-config 被關掉的 audio_config 原值（用來確認真的有改到物件）。 */
  disposed: 0,
  /** 送進 `onProgress` 的訊息數（驗證回呼仍被轉送）。 */
  progressEvents: 0,
  /** 測試用：模擬 transformers.js 就地改動我們傳進去的 session_options 物件。 */
  mutateSessionOptions: false,
}));

vi.mock("@huggingface/transformers", () => ({
  // 產品碼會直接寫 `env.cacheDir`／`env.allowLocalModels` 等欄位，因此必須是可變物件。
  env: {} as Record<string, unknown>,
  AutoConfig: {
    from_pretrained: async () => {
      const config = { audio_config: { enabled: true } };
      state.configs.push(config);
      return config;
    },
  },
  AutoProcessor: { from_pretrained: async () => ({}) },
  AutoModel: {
    from_pretrained: async (modelId: string, options: Record<string, unknown>) => {
      state.modelOptions.push({
        modelId,
        config: options.config,
        device: options.device as string | undefined,
        dtype: options.dtype,
        session_options: { ...((options.session_options ?? {}) as Record<string, unknown>) },
        progress_callback: options.progress_callback,
      });
      // 模擬套件把進度訊息送回來（產品碼的橋接必須把它轉給呼叫端）。
      (options.progress_callback as ((info: unknown) => void) | undefined)?.({
        status: "progress",
        file: "onnx/model_q4.onnx",
        loaded: 1,
        total: 2,
      });
      if (state.mutateSessionOptions) {
        (options.session_options as Record<string, unknown>).enableCpuMemArena = true;
      }
      return { dispose: async () => void (state.disposed += 1) };
    },
  },
}));

describe("downloadModelFiles（下載後的驗證 session）", () => {
  it("建立 session 時帶 enableCpuMemArena:false，與 embedder 的 options 一致", async () => {
    await downloadModelFiles({
      profile: MODEL_PROFILE,
      modelDir: "cache-dir",
      onProgress: () => void (state.progressEvents += 1),
    });

    expect(state.modelOptions).toHaveLength(1);
    const options = state.modelOptions[0]!;
    expect(options.modelId).toBe(MODEL_PROFILE.modelId);
    expect(options.device).toBe("cpu");
    expect(options.dtype).toEqual(MODEL_PROFILE.dtype);
    // 精確比對：少了開關（或多了未預期的欄位）都要失敗。
    expect(options.session_options).toEqual({ enableCpuMemArena: false });
    expect(MODEL_SESSION_OPTIONS).toEqual({ enableCpuMemArena: false });
    // 進度回呼仍照原樣轉送。
    expect(state.progressEvents).toBe(1);
  });

  it("仍照 embedder 的載入順序：audio_config 關掉、只載文字＋圖片", async () => {
    state.configs.length = 0;
    await downloadModelFiles({ profile: MODEL_PROFILE, modelDir: "cache-dir", onProgress: () => {} });
    expect(state.configs).toHaveLength(1);
    expect(state.configs[0]!.audio_config).toBeNull();
  });

  it("快取位置與離線開關照舊設定，且下載完成後釋放模型", async () => {
    state.disposed = 0;
    await downloadModelFiles({ profile: MODEL_PROFILE, modelDir: "cache-dir", onProgress: () => {} });
    expect(env.cacheDir).toBe("cache-dir");
    expect(env.allowLocalModels).toBe(true);
    expect(env.allowRemoteModels).toBe(true);
    expect(state.disposed).toBe(1);
  });

  it("傳出去的是複本：套件就地改動 options 不會污染共用常數", async () => {
    state.mutateSessionOptions = true;
    try {
      await downloadModelFiles({ profile: MODEL_PROFILE, modelDir: "cache-dir", onProgress: () => {} });
      expect(MODEL_SESSION_OPTIONS).toEqual({ enableCpuMemArena: false });
    } finally {
      state.mutateSessionOptions = false;
    }
  });
});
