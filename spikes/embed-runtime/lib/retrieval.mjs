// 檢索探測（對應 docs/embedder-contract.md 的 probe）：圖片 × 描述文字相似度矩陣與 Top-1 判定。
import { cosine } from "./embedder.mjs";

/**
 * @param {Array<{id: string, embedding: number[]}>} images
 * @param {Array<{id: string, imageId: string, lang: "en"|"zh", text: string, embedding: number[]}>} queries
 */
export function retrievalReport(images, queries) {
  const matrix = [];
  const perImage = [];
  for (const image of images) {
    const row = {};
    let ownBest = Number.NEGATIVE_INFINITY;
    let foreignBest = Number.NEGATIVE_INFINITY;
    let top1 = null;
    for (const query of queries) {
      const score = cosine(image.embedding, query.embedding);
      row[query.id] = score;
      if (!top1 || score > top1.score) top1 = { id: query.id, score, imageId: query.imageId, lang: query.lang };
      if (query.imageId === image.id) ownBest = Math.max(ownBest, score);
      else foreignBest = Math.max(foreignBest, score);
    }
    matrix.push({ imageId: image.id, scores: row });
    perImage.push({
      imageId: image.id,
      top1: top1.id,
      top1Score: top1.score,
      top1IsOwn: top1.imageId === image.id,
      ownBest,
      foreignBest,
      margin: ownBest - foreignBest,
    });
  }

  // 每句查詢的 Top-1 圖片（含 z-score 正規化，用來抵消 embedding 各向異性）
  const because = (value) => value;
  const queryTop1 = [];
  for (const query of queries) {
    const scores = images.map((image) => ({ imageId: image.id, score: cosine(image.embedding, query.embedding) }));
    const mean = scores.reduce((acc, s) => acc + s.score, 0) / scores.length;
    const std = Math.sqrt(scores.reduce((acc, s) => acc + (s.score - mean) ** 2, 0) / scores.length);
    const withZ = scores.map(({ imageId, score }) => ({ imageId, score, z: std === 0 ? 0 : (score - mean) / std }));
    const raw = [...withZ].sort((a, b) => because(b.score - a.score));
    const zscored = [...withZ].sort((a, b) => because(b.z - a.z));
    const expectedScore = withZ.find((s) => s.imageId === query.imageId).score;
    queryTop1.push({
      queryId: query.id,
      lang: query.lang,
      expectedImageId: query.imageId,
      rawTop1: raw[0].imageId,
      rawTop1Score: raw[0].score,
      rawCorrect: raw[0].imageId === query.imageId,
      // Top-1 與亞軍的分數差；Top-1 正確時即領先幅度，錯誤時為落後幅度（負值）
      rawMargin: raw[0].score - (raw[1]?.score ?? 0),
      rawGapToExpected: raw[0].score - expectedScore,
      zTop1: zscored[0].imageId,
      zTop1Z: zscored[0].z,
      zCorrect: zscored[0].imageId === query.imageId,
      zMargin: zscored[0].z - (zscored[1]?.z ?? 0),
    });
  }

  const accuracy = (rows) => (rows.length === 0 ? null : rows.filter((row) => row.correct).length / rows.length);
  const summary = {
    imageTop1Accuracy: perImage.filter((row) => row.top1IsOwn).length / perImage.length,
    queryTop1RawAccuracy: accuracy(queryTop1.map((row) => ({ correct: row.rawCorrect }))),
    queryTop1ZAccuracy: accuracy(queryTop1.map((row) => ({ correct: row.zCorrect }))),
    queryTop1RawAccuracyZh: accuracy(queryTop1.filter((row) => row.lang === "zh").map((row) => ({ correct: row.rawCorrect }))),
    queryTop1ZAccuracyZh: accuracy(queryTop1.filter((row) => row.lang === "zh").map((row) => ({ correct: row.zCorrect }))),
    minMargin: Math.min(...perImage.map((row) => row.margin)),
    meanMargin: perImage.reduce((acc, row) => acc + row.margin, 0) / perImage.length,
  };

  return { matrix, perImage, queryTop1, summary };
}

/** 文字 ↔ 文字 檢索（查詢 i 是否找到文件 i）。 */
export function textRetrievalReport(queries, documents) {
  const rows = queries.map((query) => {
    const scores = documents.map((document) => ({ documentId: document.id, score: cosine(query.embedding, document.embedding) }));
    const sorted = [...scores].sort((a, b) => b.score - a.score);
    const expected = documents.find((document) => document.id === query.id.replace(/^q_/, "d_"));
    return {
      queryId: query.id,
      expectedDocumentId: expected?.id ?? null,
      top1: sorted[0].documentId,
      top1Score: sorted[0].score,
      correct: expected ? sorted[0].documentId === expected.id : null,
      margin: sorted[0].score - (sorted[1]?.score ?? 0),
      gapToExpected: expected ? sorted[0].score - (sorted.find((s) => s.documentId === expected.id)?.score ?? Number.NaN) : null,
    };
  });
  return { rows };
}
