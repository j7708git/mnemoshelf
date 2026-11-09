/**
 * 外部程序結果 → 具名錯誤碼（純函式；供 adapter 與單元測試共用）。
 * 訊息一律由 MediaDecoderError 的固定文字提供，不帶 stderr 原文或本機路徑。
 */
import type { ProcessResult } from "./process.js";
import type { MediaDecoderErrorCode } from "./types.js";

/** spawn 失敗字串（Node 的 error.code）→ 錯誤碼。 */
export function classifySpawnError(spawnError: string | null): MediaDecoderErrorCode | null {
  if (!spawnError) return null;
  if (/ENOENT|EFTYPE|EACCES|EPERM|UNKNOWN/i.test(spawnError)) return "video-decoder-unavailable";
  return "video-decoder-unavailable";
}

/**
 * 依「被殺原因 → spawn 失敗 → 退出碼／stderr」順序分類。
 * 取消優先於 deadline 與 output-cap；deadline 優先於 output-cap。
 */
export function classifyProcessFailure(result: Pick<ProcessResult, "killed" | "spawnError" | "code" | "signal" | "stdoutTruncated" | "stderrTruncated" | "stderr">): MediaDecoderErrorCode {
  if (result.killed.abort) return "video-decode-cancelled";
  if (result.killed.deadline) return "video-decode-timeout";
  if (result.killed.outputCap || result.stdoutTruncated || result.stderrTruncated) return "video-output-limit-exceeded";
  const spawnCode = classifySpawnError(result.spawnError);
  if (spawnCode) return spawnCode;
  if (result.code === 0 && result.signal === null) return "invalid-video";
  const stderr = result.stderr;
  if (/No such file or directory|The system cannot find the file|cannot find the file/i.test(stderr)) return "video-not-found";
  return "invalid-video";
}

/** ffprobe 的 JSON 輸出被截斷或無法解析時的分類（不是程序失敗）。 */
export function classifyProbeJsonProblem(stdoutTruncated: boolean): MediaDecoderErrorCode {
  return stdoutTruncated ? "video-output-limit-exceeded" : "invalid-video";
}
