/**
 * 啟動探測（probe）：docs/embedder-contract.md §啟動探測。
 *
 * 註冊 embedder 後、建立任何索引前必須先通過探測，避免用壞掉的模型建出整批無效索引。
 * 以兩張內容明顯不同的合成測試圖與它們的描述文字，檢查：
 *   1. 向量維度等於 info.dim，且沒有 NaN／Infinity。
 *   2. 向量已 L2 正規化。
 *   3. 「圖片 vs 自己的描述」的相似度高於「他人最佳描述」，且差距達門檻。
 *
 * 門檻來源：M0 可行性 spike 的本機實測（q4／q8、768/512/256 維、圖片 70 token 的所有組合中，
 * 實測最小邊界為 0.132（q8、768 維、budget 70）。取此值為最小門檻，低於它視為模型不具可用的跨模態對齊。
 */
import type { ImageInput, ProbeResult } from "@mnemoshelf/core";
import { createProbeImages, type SyntheticProbeImage } from "./test-images.js";

/**
 * 探測要求的最小邊界：「圖 vs 自己的描述」相似度減去「他人最佳描述」相似度。
 * 來源：M0 spike 實測最小邊界 0.132（見檔頭說明）。
 */
export const PROBE_MARGIN_THRESHOLD = 0.132;

/** 正規化容差（契約：模長與 1 的差距須小於 1e-3）。 */
const NORMALIZATION_TOLERANCE = 1e-3;

/** 探測的輸入：文字與圖片的嵌入函式、預期維度、可選的測試圖。 */
export interface ProbeOptions {
  /** 預期維度（`info.dim`）。 */
  dim: number;
  /** 嵌入一段文字（實作已套用查詢 prefix）。 */
  embedText: (text: string) => Promise<Float32Array>;
  /** 嵌入一張圖片。 */
  embedImage: (image: ImageInput) => Promise<Float32Array>;
  /** 自訂測試圖（預設為程式生成的兩張合成圖）。 */
  images?: SyntheticProbeImage[];
}

function norm(vec: Float32Array): number {
  let sum = 0;
  for (const value of vec) sum += value * value;
  return Math.sqrt(sum);
}

/** 兩單位向量的餘弦相似度（點積）。向量已正規化，但這裡仍以模長防禦。 */
function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? Number.NaN : dot / denom;
}

/** 檢查單一向量：維度、有限值、正規化。失敗時回傳訊息，成功回傳 null。 */
function checkVector(label: string, vec: Float32Array, dim: number): string | null {
  if (vec.length !== dim) {
    return `${label} 維度不符：${vec.length} != ${dim}`;
  }
  for (const value of vec) {
    if (!Number.isFinite(value)) return `${label} 含非有限值（NaN／Infinity）`;
  }
  const length = norm(vec);
  if (Math.abs(length - 1) > NORMALIZATION_TOLERANCE) {
    return `${label} 未 L2 正規化（模長 ${length.toFixed(6)}）`;
  }
  return null;
}

/**
 * 執行語意探測。任何一步失敗都回傳 `{ ok:false, message }`，訊息只含數值與標籤。
 */
export async function runProbe(options: ProbeOptions): Promise<ProbeResult> {
  const { dim, embedText, embedImage } = options;
  const images = options.images ?? createProbeImages();

  if (images.length < 2) {
    return { ok: false, message: `探測需要至少兩張測試圖，實際 ${images.length} 張` };
  }

  const imageVectors = new Map<string, Float32Array>();
  for (const sample of images) {
    const vec = await embedImage(sample.image);
    const problem = checkVector(`圖片 ${sample.id}`, vec, dim);
    if (problem) return { ok: false, message: problem };
    imageVectors.set(sample.id, vec);
  }

  const textVectors = new Map<string, Float32Array>();
  for (const sample of images) {
    for (let i = 0; i < sample.descriptions.length; i += 1) {
      const key = `${sample.id}#${i}`;
      const vec = await embedText(sample.descriptions[i]);
      const problem = checkVector(`描述 ${key}`, vec, dim);
      if (problem) return { ok: false, message: problem };
      textVectors.set(key, vec);
    }
  }

  let minMargin = Number.POSITIVE_INFINITY;
  let weakest = "";
  for (const sample of images) {
    const imageVec = imageVectors.get(sample.id)!;

    // 自己的最佳相似度：取自己所有描述中最高者。
    let ownMax = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < sample.descriptions.length; i += 1) {
      const sim = cosine(imageVec, textVectors.get(`${sample.id}#${i}`)!);
      if (sim > ownMax) ownMax = sim;
    }

    // 他人最佳相似度：其他圖片的任何描述中最高者。
    let otherMax = Number.NEGATIVE_INFINITY;
    for (const other of images) {
      if (other.id === sample.id) continue;
      for (let i = 0; i < other.descriptions.length; i += 1) {
        const sim = cosine(imageVec, textVectors.get(`${other.id}#${i}`)!);
        if (sim > otherMax) otherMax = sim;
      }
    }

    const margin = ownMax - otherMax;
    if (margin < minMargin) {
      minMargin = margin;
      weakest = sample.id;
    }
    if (!(margin >= PROBE_MARGIN_THRESHOLD)) {
      return {
        ok: false,
        message:
          `圖片 ${sample.id} 的語意邊界不足：自己的描述 ${ownMax.toFixed(3)} − 他人最佳 ${otherMax.toFixed(3)} ` +
          `= ${margin.toFixed(3)} < 門檻 ${PROBE_MARGIN_THRESHOLD}`,
      };
    }
  }

  return {
    ok: true,
    message:
      `探測通過：${images.length} 張圖、最小邊界 ${minMargin.toFixed(3)}（${weakest}）` +
      `，門檻 ${PROBE_MARGIN_THRESHOLD}，維度 ${dim}`,
  };
}
