/**
 * 索引工作狀態（**行程內記憶體**，供 `GET /roots/:id/index/status` 輪詢）。
 *
 * 為什麼是記憶體：契約沒有工作佇列，索引本身也是「進行中再呼叫回 409」的單一工作模型；
 * 進度只在這個行程的生命週期內有意義。**服務重啟後一律回「閒置」**，不回殘留狀態
 * （資料庫不儲存工作狀態，這是刻意的：索引結果本身可由 DB 內容重建）。
 *
 * 不引入 SSE／WebSocket：前端以固定間隔輪詢這個端點即可。
 */
import type { IndexProgress, IndexRootResult } from "@mnemoshelf/core";

/** 一個 root 的索引工作狀態。 */
export type IndexState = "idle" | "running" | "completed" | "failed" | "cancelled";

/** 失敗時的錯誤摘要（只放名稱與訊息，不含堆疊與路徑）。 */
export interface IndexErrorInfo {
  name: string;
  message: string;
}

/** `GET /roots/:id/index/status` 的回應主體。 */
export interface IndexStatus {
  rootId: number;
  state: IndexState;
  /** 最近一次進度回報；從未回報時為 null。 */
  progress: IndexProgress | null;
  /** 本次索引開始時間（ISO 8601）；未開始過為 null。 */
  startedAt: string | null;
  /** 本次索引結束時間（ISO 8601）；尚未結束為 null。 */
  finishedAt: string | null;
  /** 本次索引耗時（毫秒）；尚未結束為 null。 */
  durationMs: number | null;
  /** 失敗時的錯誤摘要；其餘狀態為 null。 */
  error: IndexErrorInfo | null;
  /** 完成時的索引結果摘要；其餘狀態為 null。 */
  result: IndexRootResult | null;
}

interface TrackedEntry {
  state: IndexState;
  progress: IndexProgress | null;
  startedAt: string | null;
  startedAtMs: number | null;
  finishedAt: string | null;
  durationMs: number | null;
  error: IndexErrorInfo | null;
  result: IndexRootResult | null;
}

/** 尚未開始過（或已被清除）的 root 一律回這個狀態。 */
function idleStatus(rootId: number): IndexStatus {
  return {
    rootId,
    state: "idle",
    progress: null,
    startedAt: null,
    finishedAt: null,
    durationMs: null,
    error: null,
    result: null,
  };
}

/**
 * 追蹤每個 root 的索引工作狀態。
 *
 * 生命週期：`begin()` → 0..n 次 `report()` → `finish()` 或 `fail()`。
 * 同一 root 同時只會有一輪（由 `app.ts` 的 `indexing` map 保證），因此不需要鎖。
 */
export class IndexStatusTracker {
  private readonly entries = new Map<number, TrackedEntry>();

  /** 開始一輪索引：清除上一輪的結果，狀態為 `running`。 */
  begin(rootId: number): void {
    const now = Date.now();
    this.entries.set(rootId, {
      state: "running",
      progress: null,
      startedAt: new Date(now).toISOString(),
      startedAtMs: now,
      finishedAt: null,
      durationMs: null,
      error: null,
      result: null,
    });
  }

  /** 回報進度（`indexRoot` 的 `onProgress` 回呼）。 */
  report(rootId: number, progress: IndexProgress): void {
    const entry = this.entries.get(rootId);
    if (entry === undefined || entry.state !== "running") return;
    entry.progress = { ...progress };
  }

  /** 索引成功完成。 */
  finish(rootId: number, result: IndexRootResult): void {
    const entry = this.entries.get(rootId);
    if (entry === undefined) return;
    const now = Date.now();
    entry.state = "completed";
    entry.finishedAt = new Date(now).toISOString();
    entry.durationMs = entry.startedAtMs === null ? null : now - entry.startedAtMs;
    entry.result = result;
    entry.error = null;
  }

  /**
   * 索引被取消（`POST /roots/:id/index/cancel`）。
   *
   * 語意與 `failed` 不同：取消是**使用者要求**的結果，不是錯誤，因此 `error` 保持 null。
   * 已寫入的資料本來就按檔交易，維持一致；`result` 也保持 null（這一輪沒有完成）。
   */
  cancel(rootId: number): void {
    const entry = this.entries.get(rootId);
    if (entry === undefined) return;
    const now = Date.now();
    entry.state = "cancelled";
    entry.finishedAt = new Date(now).toISOString();
    entry.durationMs = entry.startedAtMs === null ? null : now - entry.startedAtMs;
    entry.error = null;
    entry.result = null;
  }

  /** 索引失敗：記下錯誤名稱與訊息（不含堆疊）。 */
  fail(rootId: number, error: unknown): void {
    const entry = this.entries.get(rootId);
    if (entry === undefined) return;
    const now = Date.now();
    entry.state = "failed";
    entry.finishedAt = new Date(now).toISOString();
    entry.durationMs = entry.startedAtMs === null ? null : now - entry.startedAtMs;
    entry.error = {
      name: error instanceof Error ? error.name : "Error",
      message: error instanceof Error ? error.message : "索引失敗",
    };
  }

  /** 讀取狀態；沒有紀錄時回「閒置」（服務重啟後即為此狀態）。 */
  status(rootId: number): IndexStatus {
    const entry = this.entries.get(rootId);
    if (entry === undefined) return idleStatus(rootId);
    return {
      rootId,
      state: entry.state,
      progress: entry.progress === null ? null : { ...entry.progress },
      startedAt: entry.startedAt,
      finishedAt: entry.finishedAt,
      durationMs: entry.durationMs,
      error: entry.error === null ? null : { ...entry.error },
      result: entry.result,
    };
  }

  /** 移除 root 時清掉它的狀態（避免留下孤兒紀錄）。 */
  clear(rootId: number): void {
    this.entries.delete(rootId);
  }
}
