/**
 * D4 補修：DecodeProcessBudget 單元測試（不需要真 ffmpeg）。
 *
 * 契約：notes research/2026-11-09-video-d4-process-budget.md §3／§8。
 * 名額跨所有 roots、容量固定 1；acquire FIFO、等待者可 abort；有等待者時呼叫持有者
 * 的 preempt handler（只請求，release 仍由持有者在程序 close 後執行）；stats 供測試與診斷。
 */
import { describe, expect, it } from "vitest";
import { DecodeProcessBudget, type DecodeProcessLease } from "../../src/media/decode-budget.js";

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** 建立一個「持有者忽略 preempt」的情境；回傳租約與等待 promise。 */
async function holdFirst(budget: DecodeProcessBudget): Promise<DecodeProcessLease> {
  return budget.acquire();
}

describe("DecodeProcessBudget", () => {
  it("容量 1：第一個立即取得，第二個排隊直到 release", async () => {
    const budget = new DecodeProcessBudget(1);
    const first = await budget.acquire();
    let second: DecodeProcessLease | undefined;
    let secondResolved = false;
    const secondPromise = budget.acquire().then((lease) => { second = lease; secondResolved = true; });
    await flush();
    expect(secondResolved).toBe(false);
    expect(budget.stats()).toMatchObject({ capacity: 1, active: 1, waiting: 1, granted: 1 });
    first.release();
    await secondPromise;
    expect(secondResolved).toBe(true);
    expect(budget.stats()).toMatchObject({ active: 1, waiting: 0, granted: 2 });
    second!.release();
    expect(budget.stats()).toMatchObject({ active: 0, waiting: 0 });
  });

  it("FIFO：等待者依取得順序被喚醒", async () => {
    const budget = new DecodeProcessBudget(1);
    const first = await budget.acquire();
    const order: number[] = [];
    const p2 = budget.acquire().then((lease) => { order.push(2); return lease; });
    const p3 = budget.acquire().then((lease) => { order.push(3); return lease; });
    first.release();
    const second = await p2;
    second.release();
    const third = await p3;
    third.release();
    expect(order).toEqual([2, 3]);
    expect(budget.stats()).toMatchObject({ active: 0, waiting: 0, granted: 3 });
  });

  it("等待者 abort：以 AbortError 拒絕、移出佇列，不影響其他人", async () => {
    const budget = new DecodeProcessBudget(1);
    const first = await budget.acquire();
    const controller = new AbortController();
    const aborted = budget.acquire(controller.signal);
    controller.abort();
    await expect(aborted).rejects.toMatchObject({ name: "AbortError" });
    expect(budget.stats()).toMatchObject({ active: 1, waiting: 0 });
    const next = budget.acquire();
    first.release();
    const lease = await next;
    expect(lease).toBeDefined();
    lease.release();
    expect(budget.stats()).toMatchObject({ active: 0, waiting: 0 });
  });

  it("已 abort 的 signal 立即拒絕（不進佇列）", async () => {
    const budget = new DecodeProcessBudget(1);
    const controller = new AbortController();
    controller.abort();
    await expect(budget.acquire(controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(budget.stats()).toMatchObject({ active: 0, waiting: 0, granted: 0 });
  });

  it("有等待者時呼叫目前持有者的 preempt handler（可多次），release 仍由持有者執行", async () => {
    const budget = new DecodeProcessBudget(1);
    const first = await budget.acquire();
    let preempts = 0;
    first.setPreemptHandler(() => { preempts += 1; });
    const p2 = budget.acquire();
    await flush();
    expect(preempts).toBe(1);
    expect(budget.stats().preemptions).toBe(1);
    const p3 = budget.acquire();
    await flush();
    expect(preempts).toBe(2);
    // handler 只請求；持有者仍要自己 release 才會讓等待者前進。
    expect(budget.stats()).toMatchObject({ active: 1, waiting: 2 });
    first.release();
    const second = await p2;
    second.release();
    const third = await p3;
    third.release();
    expect(budget.stats()).toMatchObject({ active: 0, waiting: 0 });
  });

  it("handler 較晚註冊且已有等待者：立即補一次請求", async () => {
    const budget = new DecodeProcessBudget(1);
    const first = await budget.acquire();
    const p2 = budget.acquire();
    let preempts = 0;
    first.setPreemptHandler(() => { preempts += 1; });
    await flush();
    expect(preempts).toBe(1);
    first.release();
    const second = await p2;
    second.release();
  });

  it("handler 拋錯不會卡死等待者（例外被吞掉，靠 release 前進）", async () => {
    const budget = new DecodeProcessBudget(1);
    const first = await budget.acquire();
    first.setPreemptHandler(() => { throw new Error("boom"); });
    const p2 = budget.acquire();
    await flush();
    expect(budget.stats().preemptions).toBe(1);
    first.release();
    const second = await p2;
    second.release();
    expect(budget.stats()).toMatchObject({ active: 0, waiting: 0, granted: 2 });
  });

  it("重複 release 無效（active 不會變負、不會重複喚醒）", async () => {
    const budget = new DecodeProcessBudget(1);
    const first = await budget.acquire();
    const p2 = budget.acquire();
    first.release();
    first.release();
    first.release();
    const second = await p2;
    expect(budget.stats()).toMatchObject({ active: 1, waiting: 0, granted: 2 });
    second.release();
    second.release();
    expect(budget.stats()).toMatchObject({ active: 0, waiting: 0, granted: 2 });
  });

  it("capacity > 1（僅測試用）：第三個才排隊，多個持有者都可收到 preempt 請求", async () => {
    const budget = new DecodeProcessBudget(2);
    const first = await budget.acquire();
    const second = await budget.acquire();
    let firstPreempts = 0;
    let secondPreempts = 0;
    first.setPreemptHandler(() => { firstPreempts += 1; });
    second.setPreemptHandler(() => { secondPreempts += 1; });
    const thirdPromise = budget.acquire();
    await flush();
    expect(firstPreempts).toBe(1);
    expect(secondPreempts).toBe(1);
    first.release();
    const third = await thirdPromise;
    expect(budget.stats()).toMatchObject({ capacity: 2, active: 2, waiting: 0, granted: 3 });
    second.release();
    third.release();
    expect(budget.stats()).toMatchObject({ active: 0, waiting: 0 });
  });

  it("非法容量直接拒絕", () => {
    expect(() => new DecodeProcessBudget(0)).toThrow(RangeError);
    expect(() => new DecodeProcessBudget(-1)).toThrow(RangeError);
    expect(() => new DecodeProcessBudget(1.5)).toThrow(RangeError);
  });

  it("stats 是快照：外部持有不影響內部狀態", async () => {
    const budget = new DecodeProcessBudget(1);
    const first = await budget.acquire();
    const snapshot = budget.stats();
    first.release();
    expect(snapshot).toMatchObject({ active: 1, granted: 1 });
    expect(budget.stats()).toMatchObject({ active: 0, granted: 1 });
  });
});
