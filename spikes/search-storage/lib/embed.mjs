// 對本機純文字 embedding 服務（OpenAI 相容 POST /v1/embeddings）取向量。
// 只讀使用；不修改、不重啟該服務。取前 DIM 維後重新 L2 正規化。
const EMB_URL = process.env.EMB_URL || "http://127.0.0.1:8181";
export const DIM = 512; // 768 → 取前 512（MRL），再重新 L2 正規化
const MAX_INPUT_CHARS = 1100; // 單次輸入控制在 ~1500 token 內

export const QUERY_PREFIX = (q) => `task: search result | query: ${q}`;
export const DOC_PREFIX_WITH_TITLE = (t, c) => `title: ${t} | text: ${c}`;
export const DOC_PREFIX_NO_TITLE = (c) => `title: none | text: ${c}`;

function truncate(text) {
  return text.length > MAX_INPUT_CHARS ? text.slice(0, MAX_INPUT_CHARS) : text;
}

/** 單一批次（≤batch 筆）請求；失敗重試 ≤3 次。 */
async function embedRequest(texts, tries = 3) {
  let lastErr;
  for (let attempt = 1; attempt <= tries; attempt += 1) {
    try {
      const res = await fetch(`${EMB_URL}/v1/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: texts }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (!Array.isArray(json.data) || json.data.length !== texts.length) {
        throw new Error(`unexpected response shape (data length ${json.data?.length})`);
      }
      return json.data.map((d) => {
        const v = new Float32Array(DIM);
        for (let i = 0; i < DIM; i += 1) v[i] = d.embedding[i];
        let norm = 0;
        for (let i = 0; i < DIM; i += 1) norm += v[i] * v[i];
        norm = Math.sqrt(norm) || 1;
        for (let i = 0; i < DIM; i += 1) v[i] /= norm;
        return v;
      });
    } catch (err) {
      lastErr = err;
      if (attempt < tries) await new Promise((r) => setTimeout(r, 300 * attempt));
    }
  }
  throw lastErr;
}

/**
 * 批次嵌入（每批 16）。`onProgress(done, total)` 可選。
 * 回傳 Float32Array[]（順序對應輸入）。
 */
export async function embedAll(texts, { batch = 16, onProgress } = {}) {
  const out = [];
  for (let i = 0; i < texts.length; i += batch) {
    const slice = texts.slice(i, i + batch).map(truncate);
    const vecs = await embedRequest(slice);
    out.push(...vecs);
    if (onProgress) onProgress(out.length, texts.length);
  }
  return out;
}

/** 健康檢查（用於記錄服務前後狀態）。 */
export async function health() {
  try {
    const res = await fetch(`${EMB_URL}/health`);
    return { ok: res.ok, status: res.status, body: (await res.text()).trim() };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}

export function embedderInfo() {
  return { url: EMB_URL, dim: DIM, maxInputChars: MAX_INPUT_CHARS };
}
