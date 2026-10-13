/**
 * TransformersEmbedder：以 `@huggingface/transformers`（ONNX）實作多模態 Embedder。
 *
 * 基線（M0 spike，project-notes/projects/mnemoshelf/research/spike-embed-runtime.md）：
 *   - 模型 `onnx-community/embeddinggemma-2-ONNX`，`device:"cpu"`。
 *   - dtype 逐元件 `{ model:"q4", vision_encoder:"q4" }`（q4 最快、最小；q8／fp32 可設定）。
 *   - 原生 768 維；輸出截斷成 512 維後**重新 L2 正規化**。
 *   - 圖片 `max_soft_tokens = 70`（延遲約 1/4，檢索品質不變）。
 *   - 只載文字＋圖片：`config.audio_config = null`。**不用** `pipeline("feature-extraction")`（會載入全部編碼器）。
 *
 * 文字 prefix：查詢 `task: search result | query: {q}`；文件 `title: {title} | text: {content}`
 * （無標題用 `title: none`）。**圖片不加 prefix**。
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { AutoConfig, AutoModel, AutoProcessor, env, load_image } from "@huggingface/transformers";
import type { Embedder, EmbedderInfo, ImageInput, ProbeResult } from "@mnemoshelf/core";
import {
  EmptyImageInputError,
  InvalidEmbedderOptionError,
  ModelInferenceError,
  ModelLoadError,
  UnsupportedDtypeError,
} from "./errors.js";
import { runProbe } from "./probe.js";
import { assertMrlDimension, truncateAndNormalize } from "./vector.js";

/** 預設模型 id。 */
export const DEFAULT_MODEL_ID = "onnx-community/embeddinggemma-2-ONNX";
/** 預設輸出維度（截斷後）。 */
export const DEFAULT_DIM = 512;
/** 預設圖片 soft token 預算。 */
export const DEFAULT_MAX_SOFT_TOKENS = 70;

/** 本套件允許的 dtype（官方模型卡有 fp16，但契約明示不可用 fp16）。 */
export const SUPPORTED_DTYPES = ["fp32", "q8", "q4", "q4f16"] as const;
export type TransformersDtype = (typeof SUPPORTED_DTYPES)[number];

/** 逐元件的 dtype 設定（`model` 是文字模型）。用 type alias 才能相容於 transformers 的 `Record<string, DataType>`。 */
export type PerComponentDtype = {
  model: TransformersDtype;
  vision_encoder: TransformersDtype;
};

/** dtype 選項：單一字串（同時套用到文字與視覺）或逐元件指定。 */
export type DtypeOption = TransformersDtype | PerComponentDtype;

/** TransformersEmbedder 的建構子選項。 */
export interface TransformersEmbedderOptions {
  /** 模型 id，預設 `onnx-community/embeddinggemma-2-ONNX`。 */
  modelId?: string;
  /** dtype，預設 q4（逐元件 `{model:"q4", vision_encoder:"q4"}`）。 */
  dtype?: DtypeOption;
  /** 輸出維度，預設 512。僅允許 128／256／512／768。 */
  dim?: number;
  /** 模型快取目錄；預設環境變數 `MNEMOSHELF_MODEL_DIR`，再預設 OS 使用者資料目錄下的 `mnemoshelf/models`。 */
  cacheDir?: string;
  /** 圖片 soft token 預算，預設 70。 */
  maxSoftTokens?: number;
}

/** 已載入的模型資源。 */
interface LoadedModel {
  processor: GemmaProcessor;
  model: GemmaModel;
}

/** transformers.js processor 的最小介面（避免相依其龐大的型別）。 */
interface GemmaProcessor {
  (text: string[] | string | null, images?: unknown): Promise<Record<string, unknown>>;
  image_processor: { max_soft_tokens: number };
}

/** Tensor 的最小介面。 */
interface GemmaTensor {
  dims: number[];
  tolist(): Promise<number[][]>;
}

/** model 輸出與可呼叫簽章的最小介面（含 dispose／sessions）。 */
interface GemmaModel {
  (inputs: unknown): Promise<{ sentence_embedding?: GemmaTensor }>;
  dispose?: () => Promise<unknown>;
  sessions?: Record<string, unknown>;
}

const DEFAULT_DTYPE: TransformersDtype = "q4";

/** 解析並驗證 dtype 選項，一律回傳逐元件形式。 */
function resolveDtype(option: DtypeOption): PerComponentDtype {
  if (typeof option === "string") {
    assertDtype(option);
    return { model: option, vision_encoder: option };
  }
  assertDtype(option.model);
  assertDtype(option.vision_encoder);
  return { model: option.model, vision_encoder: option.vision_encoder };
}

function assertDtype(value: string): asserts value is TransformersDtype {
  if ((SUPPORTED_DTYPES as readonly string[]).includes(value)) return;
  const reason =
    value === "fp16" || value === "bfloat16"
      ? "契約明示不可使用 float16（會出現 NaN 或靜默劣化）"
      : "不在此套件允許的 dtype 清單";
  throw new UnsupportedDtypeError(value, SUPPORTED_DTYPES, reason);
}

/** dtype 標籤，用於 `info.id`。 */
function dtypeLabel(dtype: PerComponentDtype): string {
  if (dtype.model === dtype.vision_encoder) return dtype.model;
  return `model-${dtype.model}-vision-${dtype.vision_encoder}`;
}

/** 由模型 id 與 dtype 標籤組出穩定識別（`-ONNX` 後綴不進 id）。 */
function buildEmbedderId(modelId: string, label: string): string {
  const lastSegment = modelId.split("/").pop() ?? modelId;
  const base = lastSegment.replace(/-ONNX$/i, "");
  return `${base}@onnx-${label}`;
}

/** OS 使用者資料目錄（跨平台，不硬寫分隔符）。 */
function osUserDataDir(home: string): string {
  if (process.platform === "win32") {
    return process.env.APPDATA && process.env.APPDATA.trim() !== ""
      ? process.env.APPDATA
      : join(home, "AppData", "Roaming");
  }
  if (process.platform === "darwin") {
    return join(home, "Library", "Application Support");
  }
  return process.env.XDG_DATA_HOME && process.env.XDG_DATA_HOME.trim() !== ""
    ? process.env.XDG_DATA_HOME
    : join(home, ".local", "share");
}

/** 模型快取的預設目錄。 */
export function defaultModelCacheDir(): string {
  const fromEnv = process.env.MNEMOSHELF_MODEL_DIR;
  if (fromEnv && fromEnv.trim() !== "") return fromEnv;
  return join(osUserDataDir(homedir()), "mnemoshelf", "models");
}

/** 非同步取回 `sentence_embedding`，偶發取不到時重試一次（見 M0 spike「實作踩雷」）。 */
async function runModel(modelId: string, model: GemmaModel, inputs: unknown): Promise<number[][]> {
  let lastMessage = "未取得輸出";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const out = await model(inputs);
    const tensor = out?.sentence_embedding;
    if (tensor && typeof tensor.tolist === "function") {
      return tensor.tolist();
    }
    lastMessage = `模型輸出缺少可用的 sentence_embedding（第 ${attempt + 1} 次嘗試）`;
  }
  throw new ModelInferenceError(modelId, lastMessage);
}

/**
 * 多模態 embedder（真實模型）。
 *
 * lazy 載入：建構子不載模型；第一次 `embed*`／`probe()` 才載。`info` 不依賴模型，建構後即可同步讀取。
 * `dispose()` 後再呼叫 `embed*` 會**自動重新載入**（本實作選擇「自動重新載入」，見測試與註解）。
 */
export class TransformersEmbedder implements Embedder {
  readonly info: EmbedderInfo;

  private readonly modelId: string;
  private readonly dim: number;
  private readonly dtype: PerComponentDtype;
  private readonly cacheDir: string;
  private readonly maxSoftTokens: number;

  private loaded: LoadedModel | null = null;
  private loading: Promise<LoadedModel> | null = null;

  constructor(options: TransformersEmbedderOptions = {}) {
    this.modelId = options.modelId ?? DEFAULT_MODEL_ID;
    this.dim = options.dim ?? DEFAULT_DIM;
    assertMrlDimension(this.dim);

    this.dtype = resolveDtype(options.dtype ?? DEFAULT_DTYPE);

    const maxSoftTokens = options.maxSoftTokens ?? DEFAULT_MAX_SOFT_TOKENS;
    if (!Number.isInteger(maxSoftTokens) || maxSoftTokens <= 0) {
      throw new InvalidEmbedderOptionError("maxSoftTokens", maxSoftTokens, "必須是正整數");
    }
    this.maxSoftTokens = maxSoftTokens;

    this.cacheDir = options.cacheDir ?? defaultModelCacheDir();

    this.info = {
      id: buildEmbedderId(this.modelId, dtypeLabel(this.dtype)),
      dim: this.dim,
      // audio_config 已設為 null，故 audio 為 false；本套件不做影片。
      capabilities: { text: true, image: true, audio: false, video: false },
    };
  }

  async embedQuery(text: string): Promise<Float32Array> {
    return this.embedText(`task: search result | query: ${text}`);
  }

  async embedDocument(text: string, title?: string): Promise<Float32Array> {
    return this.embedText(`title: ${title ?? "none"} | text: ${text}`);
  }

  async embedImage(image: ImageInput): Promise<Float32Array> {
    if (image.bytes.length === 0) throw new EmptyImageInputError();
    const { processor, model } = await this.ensureLoaded();

    // transformers.js 在 Node 以 sharp 解碼；load_image 接受 Blob。先複製成
    // ArrayBuffer-backed 的 Uint8Array，避免與呼叫端共用緩衝。
    const bytes = new Uint8Array(image.bytes);
    const blob = new Blob([bytes], { type: image.mimeType ?? "application/octet-stream" });
    const rawImage = await load_image(blob);

    const inputs = await processor(null, [[rawImage]]);
    return this.toVector(await runModel(this.modelId, model, inputs));
  }

  async probe(): Promise<ProbeResult> {
    return runProbe({
      dim: this.dim,
      embedText: (text) => this.embedQuery(text),
      embedImage: (image) => this.embedImage(image),
    });
  }

  /**
   * 釋放模型 session。可安全重複呼叫（冪等）；未載入時為無害的 no-op。
   * 釋放後再呼叫 `embed*`／`probe()` 會自動重新載入模型。
   */
  async dispose(): Promise<void> {
    const loaded = this.loaded;
    this.loaded = null;
    this.loading = null;
    if (loaded?.model.dispose) {
      await loaded.model.dispose();
    }
  }

  private async embedText(prefixed: string): Promise<Float32Array> {
    const { processor, model } = await this.ensureLoaded();
    const inputs = await processor([prefixed]);
    return this.toVector(await runModel(this.modelId, model, inputs));
  }

  /** 取第一筆並依 `info.dim` 截斷＋重新 L2 正規化。 */
  private toVector(data: number[][]): Float32Array {
    const row = data[0];
    if (!row) {
      throw new ModelInferenceError(this.modelId, "模型回傳空的 embedding 批次");
    }
    return truncateAndNormalize(Float32Array.from(row), this.dim);
  }

  private async ensureLoaded(): Promise<LoadedModel> {
    if (this.loaded) return this.loaded;
    if (!this.loading) {
      this.loading = this.loadModel();
    }
    try {
      const loaded = await this.loading;
      this.loaded = loaded;
      return loaded;
    } finally {
      this.loading = null;
    }
  }

  private async loadModel(): Promise<LoadedModel> {
    try {
      // 讓 HF 下載的快取落在指定目錄（全域設定；與 M0 spike 相同做法）。
      env.cacheDir = this.cacheDir;

      const config = await AutoConfig.from_pretrained(this.modelId);
      // 只載文字＋圖片：不要載入音訊編碼器（官方模型卡 Selective Encoder Loading）。
      (config as unknown as { audio_config: unknown }).audio_config = null;

      const processor = (await AutoProcessor.from_pretrained(this.modelId)) as unknown as GemmaProcessor;
      processor.image_processor.max_soft_tokens = this.maxSoftTokens;

      const model = (await AutoModel.from_pretrained(this.modelId, {
        config,
        device: "cpu",
        dtype: this.dtype,
      })) as unknown as GemmaModel;

      return { processor, model };
    } catch (error) {
      if (error instanceof ModelInferenceError) throw error;
      throw new ModelLoadError(this.modelId, error);
    }
  }
}
