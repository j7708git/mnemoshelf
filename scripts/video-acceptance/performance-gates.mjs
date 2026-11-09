// 跨越觀測區間的門檻保留不確定；不可把未量測或不確定算通過。
export function evaluateBound(trials, limitMs) {
  if (trials.length !== 3 || trials.some((trial) => !trial.firstRelevantObservation)) return "unmeasured";
  if (trials.every((trial) => trial.firstRelevantObservation.byMs <= limitMs)) return "pass";
  if (trials.some((trial) => trial.firstRelevantObservation.afterMs > limitMs)) return "fail";
  return "inconclusive";
}
export function cancellationAcknowledged(record) {
  return Number.isInteger(record?.rootId) && record.rootId > 0 && record.response?.rootId === record.rootId && record.response?.cancelled === true && record.indexResult?.rootId === record.rootId && record.indexResult?.cancelled === true;
}
export function samplerClosedCleanly(observer, writeError) {
  return observer != null && observer.samplerError == null && observer.pendingSamples === 0 && writeError == null;
}

export function fairnessObserved(results) {
  if (!Array.isArray(results) || results.length !== 4) return false;
  const kinds = ["long-video", "short-video", "wav", "text"];
  if (new Set(results.map((item) => item.kind)).size !== 4 || kinds.some((kind) => !results.some((item) => item.kind === kind))) return false;
  return results.every((item) => item.valid === true && (item.kind === "long-video" || item.finishedBeforeLong === true));
}
