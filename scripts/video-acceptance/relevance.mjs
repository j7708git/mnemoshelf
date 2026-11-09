// 以來源容器 36 秒為週期重複原始 V01 標註；尾段裁切至目標時長。
export function repeatedIntervals(durationSeconds) {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new RangeError("時長必須為正數");
  const intervals = [];
  for (let start = 0; start < durationSeconds; start += 36) intervals.push([start, Math.min(start + 8, durationSeconds)]);
  return intervals;
}
export function matchesRelevantHit(hit, file, intervals) {
  return hit?.type === "chunk" && hit.relPath === file && hit.kind === "video" && hit.media?.track === "video" &&
    intervals.some(([start, end]) => Math.min(hit.media.endSeconds, end) - Math.max(hit.media.startSeconds, start) > 0.001);
}
