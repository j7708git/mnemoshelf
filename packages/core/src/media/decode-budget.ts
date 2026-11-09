/**
 * D4 補修：影片解碼「程序生命週期」名額。
 *
 * 波次一把索引器的影片名額改成「每次 decoder next() 取放」，修好了長片在嵌入期間的片段公平，
 * 但 decoder 的 ffmpeg 程序在兩次 next() 之間（等待嵌入時）仍存活；四個 roots 同時索引時
 * 會有 4 個 ffmpeg。本模組是 decoder 自己擁有的第二層名額：跨所有 roots、固定容量 1
 * （server 只建一個 decoder 實例），持有到程序真的 close 才釋放。
 *
 * 契約（notes research/2026-11-09-video-d4-process-budget.md §3）：
 * 1. 容量固定 1；acquire 立即取得或 FIFO 排隊；排隊者 abort 以 AbortError 拒絕並移出佇列。
 * 2. 有等待者時呼叫目前持有者的 preempt handler（可多次、可重入）；handler 只負責請求，
 *    實際 release 仍由持有者在程序 close 後執行。
 * 3. release() 先 active-- 再喚醒下一位；重複呼叫無效。active 必須在程序真的 close 之後才下降
 *    （呼叫端責任）。
 * 4. 不得在 handler 內同步 re-enter acquire；handler 拋出的例外由本模組吞掉，等待者最終仍靠
 *    release 前進。
 * 5. stats() 供測試與診斷；所有路徑結束後 active=0、waiting=0。
 */

/** 程序名額租約；由 decoder 在 ffmpeg close 之後呼叫 release。 */
export interface DecodeProcessLease {
  /** 程序實際 close、資源回收後呼叫；idempotent（重複呼叫無效）。 */
  release(): void;
  /** 持有者註冊「有等待者，請有界讓出」回呼；可在 release 前更新。 */
  setPreemptHandler(handler: () => void): void;
}

/** 名額統計（測試與診斷用）。 */
export interface DecodeBudgetStats {
  readonly capacity: number;
  readonly active: number;
  readonly waiting: number;
  readonly granted: number;
  readonly preemptions: number;
}

interface Waiter {
  grant(): void;
  cancel(): void;
  readonly signal: AbortSignal | undefined;
  readonly cleanup: () => void;
}

/** 跨所有 roots 的解碼程序名額；容量固定 1（只給測試建構小容量）。 */
export class DecodeProcessBudget {
  private readonly capacityValue: number;
  private activeCount = 0;
  private readonly waiters: Waiter[] = [];
  private grantedCount = 0;
  private preemptionCount = 0;
  /** 目前持有中的 handler；lease 物件同時當 key。 */
  private readonly handlers = new Map<DecodeProcessLease, () => void>();

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) throw new RangeError("DecodeProcessBudget 容量必須是正整數");
    this.capacityValue = capacity;
  }

  /** 取得名額；排隊中被 abort 時以 signal.throwIfAborted() 的錯誤拒絕。 */
  acquire(signal?: AbortSignal): Promise<DecodeProcessLease> {
    if (signal?.aborted) {
      // 回傳 rejected promise（不要同步丟），讓呼叫端一律以 await 處理標準 AbortError。
      try {
        signal.throwIfAborted();
      } catch (error) {
        return Promise.reject(error);
      }
      return Promise.reject(new Error("AbortSignal 已取消"));
    }
    if (this.activeCount < this.capacityValue) {
      this.activeCount += 1;
      this.grantedCount += 1;
      return Promise.resolve(this.createLease());
    }
    return new Promise<DecodeProcessLease>((resolve, reject) => {
      const waiter: Waiter = {
        grant: () => {
          waiter.cleanup();
          this.activeCount += 1;
          this.grantedCount += 1;
          resolve(this.createLease());
        },
        cancel: () => {
          const index = this.waiters.indexOf(waiter);
          if (index < 0) return;
          this.waiters.splice(index, 1);
          waiter.cleanup();
          try {
            signal?.throwIfAborted();
          } catch (error) {
            reject(error);
            return;
          }
          // 沒有 signal 卻被 cancel 代表呼叫端邏輯錯誤；用固定錯誤避免卡住。
          reject(new Error("DecodeProcessBudget 等待者被取消"));
        },
        signal,
        cleanup: () => {
          if (signal !== undefined) signal.removeEventListener("abort", waiter.cancel);
        },
      };
      this.waiters.push(waiter);
      if (signal !== undefined) signal.addEventListener("abort", waiter.cancel, { once: true });
      // 有新的等待者：請求目前持有者讓出（handler 只負責請求，release 由持有者執行）。
      this.requestPreemption();
    });
  }

  stats(): DecodeBudgetStats {
    return {
      capacity: this.capacityValue,
      active: this.activeCount,
      waiting: this.waiters.length,
      granted: this.grantedCount,
      preemptions: this.preemptionCount,
    };
  }

  private createLease(): DecodeProcessLease {
    let released = false;
    const lease: DecodeProcessLease = {
      release: () => {
        if (released) return;
        released = true;
        this.handlers.delete(lease);
        // 契約：先 active-- 再喚醒下一位。
        this.activeCount -= 1;
        if (this.activeCount < this.capacityValue) {
          const next = this.waiters.shift();
          next?.grant();
        }
        // 讓出後若仍有等待者（多容量情境）且新持有者已註冊 handler，再請求一次。
        if (this.waiters.length > 0) this.requestPreemption();
      },
      setPreemptHandler: (handler: () => void) => {
        if (released) return;
        this.handlers.set(lease, handler);
        // handler 較晚註冊時，若已經有人在等，立即補一次請求（可重入）。
        if (this.waiters.length > 0) this.invokePreemptHandler(lease);
      },
    };
    return lease;
  }

  private requestPreemption(): void {
    if (this.waiters.length === 0) return;
    for (const lease of this.handlers.keys()) this.invokePreemptHandler(lease);
  }

  private invokePreemptHandler(lease: DecodeProcessLease): void {
    const handler = this.handlers.get(lease);
    if (handler === undefined) return;
    this.preemptionCount += 1;
    try {
      handler();
    } catch {
      // 契約：handler 不得讓等待者卡死；這裡吞掉，等待者仍靠下一次 release 前進。
    }
  }
}
