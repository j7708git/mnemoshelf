// 載入 EmbeddingGemma 2（ONNX / transformers.js）並提供 prefix、截斷、餘弦等共用工具。
import fs from "node:fs";
import os from "node:os";
import { AutoConfig, AutoModel, AutoProcessor, env, load_image } from "@huggingface/transformers";
import { cacheDirFor, ensureDir } from "./paths.mjs";

export const MODEL_ID = "onnx-community/embeddinggemma-2-ONNX";

export const queryPrefix = (q) => `task: search result | query: ${q}`;
export const documentPrefix = (text, title = "none") => `title: ${title} | text: ${text}`;

/**
 * 設定 HF 快取目錄（每個 dtype 一個），並回傳該目錄。
 * @param {string} dtype
 */
export function configureCache(dtype) {
  const dir = cacheDirFor(dtype);
  ensureDir(dir);
  env.cacheDir = dir;
  return dir;
}

/**
 * 載入 embedder。
 * @param {{dtype: string, modalities: "text"|"text+image"}} options
 * @returns {Promise<{processor: any, model: any, config: any, loadMs: number, components: string[], dtypeMap: any}>}
 */
export async function loadEmbedder({ dtype, modalities }) {
  const config = await AutoConfig.from_pretrained(MODEL_ID);
  // 選擇性載入：只保留需要的編碼器（官方模型卡 "Selective Encoder Loading"）
  config.audio_config = null;
  if (modalities === "text") config.vision_config = null;

  const dtypeMap = modalities === "text"
    ? { model: dtype }
    : { model: dtype, vision_encoder: dtype };

  const started = performance.now();
  const processor = await AutoProcessor.from_pretrained(MODEL_ID);
  const model = await AutoModel.from_pretrained(MODEL_ID, { config, device: "cpu", dtype: dtypeMap });
  const loadMs = performance.now() - started;

  return { processor, model, config, loadMs, dtypeMap, components: Object.keys(model.sessions ?? {}) };
}

/** Tensor → number[][]（保留 dims 資訊）。 */
export async function tensorToLists(tensor) {
  if (!tensor || typeof tensor.tolist !== "function") {
    throw new Error(
      `預期 Tensor，實際拿到 ${typeof tensor}${tensor ? `（keys: ${Object.keys(tensor).join(",")}）` : ""}`,
    );
  }
  return { dims: tensor.dims, data: await tensor.tolist() };
}

/**
 * 執行模型並取出 sentence_embedding。
 * 實測中偶爾會拿到沒有 `tolist` 的輸出物件（同一個呼叫形式重跑就正常），
 * 因此這裡統一把 tensor 取到區域變數，必要時重試一次，並在失敗時給出明確錯誤。
 */
export async function runModel(model, inputs, { retries = 1 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const out = await model(inputs);
    const tensor = out?.sentence_embedding;
    if (tensor && typeof tensor.tolist === "function") {
      return { tensor, dims: tensor.dims, data: await tensor.tolist(), attempts: attempt + 1 };
    }
    lastError = new Error(
      `model() 沒有回傳可用的 sentence_embedding（第 ${attempt + 1} 次；keys: ${
        tensor ? Object.keys(tensor).join(",") : Object.keys(out ?? {}).join(",")
      }）`,
    );
  }
  throw lastError;
}

/** 讀取本機圖片檔成 RawImage（傳路徑字串；transformers.js 的 load_image 在 Node 支援
 *  RawImage / string / URL / Blob，不支援 Uint8Array）。 */
export async function loadImageFile(file) {
  return load_image(file);
}

export function l2normalize(vector) {
  let sum = 0;
  for (const value of vector) sum += value * value;
  const norm = Math.sqrt(sum);
  if (!Number.isFinite(norm) || norm === 0) return vector.slice();
  return vector.map((value) => value / norm);
}

/** 取前 dim 維後重新 L2 正規化（契約要求，見 docs/embedder-contract.md）。 */
export function truncateAndNormalize(vector, dim) {
  return l2normalize(vector.slice(0, dim));
}

export function cosine(a, b) {
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

export function vectorStats(vector) {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let nan = 0;
  let zeros = 0;
  for (const value of vector) {
    if (Number.isNaN(value)) nan += 1;
    if (value === 0) zeros += 1;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return { dim: vector.length, min, max, nan, zeros, l2: Math.sqrt(vector.reduce((acc, v) => acc + v * v, 0)) };
}

/** 跨平台 CPU 概述（不寫入任何可識別個人的資訊）。 */
export function cpuSummary() {
  const cpus = os.cpus();
  const model = cpus[0]?.model ?? "unknown";
  return `${model} (${cpus.length} threads)`;
}
