/** 依情境判定產品實際執行狀態，不能只看請求裝置。 */
export function runtimeMatches(scenario, status) {
  if (!status?.loaded) return false;
  if (scenario === 'default') return status.requestedDevice === 'cpu' && status.device === 'cpu';
  if (scenario === 'fault') return status.requestedDevice === 'webgpu' && status.device === 'cpu' && status.fallbackReason?.code === 'load-failed' && status.webgpuProbe?.status === 'failed' && status.webgpuProbe?.reason === 'load-failed';
  return status.requestedDevice === 'webgpu' && status.device === 'webgpu' && status.webgpuProbe?.status === 'passed';
}

/** 新資料庫至少一個 chunk，且每個 chunk 有一個向量。 */
export function accountingMatches(chunks, vectors) {
  return Number.isInteger(chunks) && Number.isInteger(vectors) && chunks > 0 && chunks === vectors;
}
