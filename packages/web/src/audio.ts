/** 音訊時間顯示只處理秒數，不推測音訊內容。 */
export function formatMediaTime(seconds: number): string {
  const value = Math.round(Math.max(0, Number.isFinite(seconds) ? seconds : 0) * 10) / 10;
  const minutes = Math.floor(value / 60);
  return `${minutes}:${(value % 60).toFixed(1).padStart(4, "0")}`;
}

/** 切換單一模態，保留使用者已設定的其他模態。 */
export function toggleModality(current: readonly string[], modality: string, enabled: boolean): string[] {
  const others = current.filter((value) => value !== modality);
  return enabled ? [...others, modality] : others;
}
