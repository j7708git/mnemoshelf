/**
 * 記憶語意化的背景 worker（卡 B1；`docs/storage-ports.md` §記憶的語意化）。
 *
 * 職責：把未刪除的記憶內容經 **同一個 embedder 的文件路徑** 產生向量，寫回 `memories` 的
 * 向量欄位。刻意獨立於 `VectorIndex`／`/search`（設計提案 §10）：記憶向量存自己的欄位，
 * 卡 B2 的召回才能在同一個 SQL 先依 scope／project 精確過濾再排名。
 *
 * 生命週期：
 * - `start()` 非阻塞地啟動：先回填 DB 內需要（重新）嵌入的記憶，之後等待 `enqueue()`。
 * - `enqueue(id)` 由 `POST /memories` 呼叫；同一 id 在佇列或處理中時忽略（去重）。
 * - 處理**併發 1**（與 embedder 的 DML 序列化一致）；`close()` 停止拉新工作、取消重試等待、
 *   等目前處理中的那一筆結束後清空佇列——已排隊但未處理者留在 `pending`，下次 start 會回填。
 *
 * 失敗語意：
 * - `input-too-long`（embedder 契約的穩定錯誤碼）→ `too-long`（永久跳過，重試也不會成功）。
 * - 其他錯誤重試至多 `retryAttempts` 次（不含第一次），仍失敗 → `failed`（下次 start 會再試）。
 *
 * 為什麼 `close()` 要能即時結束：服務關閉時若 worker 還握著 timer 或永遠 pending 的 promise，
 * 行程會關不掉。這裡的重試等待用可取消的 `setTimeout`，`close()` 會立刻喚醒等待中的 loop。
 */
import type { Embedder, Memory, MetadataStore } from "@mnemoshelf/core";

/** 本次執行累計的 worker 統計（`GET /diagnostics` 的 `memories.worker`）。 */
export interface MemoryEmbeddingWorkerStats {
  /** 目前佇列中尚未處理的筆數。 */
  queued: number;
  /** 目前正在處理的筆數（併發 1，因此只會是 0 或 1）。 */
  processing: number;
  /** 本次執行成功嵌入的筆數。 */
  embedded: number;
  /** 本次執行重試後仍失敗的筆數（狀態 `failed`）。 */
  failed: number;
  /** 本次執行因單筆輸入過長而永久跳過的筆數（狀態 `too-long`）。 */
  tooLong: number;
}

/** `MemoryEmbeddingWorker` 的建構選項。 */
export interface MemoryEmbeddingWorkerOptions {
  store: MetadataStore;
  embedder: Embedder;
  /** 回填每次抓取的筆數；預設 100（沿用 `normalizeMemoryLimit` 的上限 500）。 */
  batchSize?: number;
  /** 單筆失敗的重試次數（不含第一次）；預設 3。 */
  retryAttempts?: number;
  /** 重試之間的延遲毫秒；預設 200。測試可設 0。 */
  retryDelayMs?: number;
  /**
   * 啟動時是否回填既有記憶（預設 `true`）。`false` 只停**啟動回填**——`enqueue()` 進來的新寫入
   * 仍會正常嵌入；既有 pending／failed／stale 留待下次以 `true` 啟動（`MNEMOSHELF_MEMORY_BACKFILL`）。
   */
  backfillOnStart?: boolean;
}

/** 回填預設每批筆數。 */
export const MEMORY_EMBEDDING_DEFAULT_BATCH_SIZE = 100;
/** 預設重試次數（不含第一次）。 */
export const MEMORY_EMBEDDING_DEFAULT_RETRY_ATTEMPTS = 3;
/** 預設重試延遲（毫秒）。 */
export const MEMORY_EMBEDDING_DEFAULT_RETRY_DELAY_MS = 200;

/**
 * 是否為 embedder 的「單筆輸入過長」錯誤。
 *
 * server **不得** import embedder 套件（依賴方向相反），因此以**穩定錯誤碼**判定
 * （`code === "input-too-long"`，見 `docs/embedder-contract.md`／`packages/embedder-transformers`）。
 * core 的 `FakeEmbedder` 也刻意複製同一個錯誤結構，測試不必依賴真實模型。
 */
function isInputTooLongError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  return (error as { code?: unknown }).code === "input-too-long";
}

/** 把外部設定夾成合法值（0 或負數的 batch 會讓回填永遠沒有進展）。 */
function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isInteger(value) && value > 0 ? value : fallback;
}

/** 非負整數（`retryAttempts = 0` 合法＝不重試）。 */
function nonNegativeInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isInteger(value) && value >= 0 ? value : fallback;
}

/**
 * 記憶向量背景 worker。建立後以 `start()` 啟動；`close()` 之後實例不可再用。
 *
 * 不是 EventEmitter：對外只需要 `start`／`enqueue`／`stats`／`close`。狀態與計數都只由
 * 單一 loop 修改（併發 1），因此不需要鎖。
 */
export class MemoryEmbeddingWorker {
  private readonly store: MetadataStore;
  private readonly embedder: Embedder;
  private readonly batchSize: number;
  private readonly retryAttempts: number;
  private readonly retryDelayMs: number;
  private readonly backfillOnStart: boolean;

  /** FIFO 佇列（元素是記憶 id）。 */
  private readonly queue: number[] = [];
  /** 佇列中或處理中的 id（去重）。 */
  private readonly queuedIds = new Set<number>();
  /** 本次 start 內回填已嘗試過的 id：避免同一輪反覆抓回 failed 的記憶造成無限迴圈。 */
  private readonly backfillAttempted = new Set<number>();

  private started = false;
  private closed = false;
  private processing = false;
  private loopPromise: Promise<void> | null = null;
  /** 佇列空、等待新工作時的 resolver；`enqueue()`／`close()` 會喚醒它。 */
  private wakeLoop: (() => void) | null = null;
  /** 可取消的重試等待（`close()` 會立刻釋放，不留 timer）。 */
  private sleepTimer: ReturnType<typeof setTimeout> | null = null;
  private sleepResolve: (() => void) | null = null;

  private embedded = 0;
  private failed = 0;
  private tooLong = 0;

  constructor(options: MemoryEmbeddingWorkerOptions) {
    this.store = options.store;
    this.embedder = options.embedder;
    this.batchSize = positiveInteger(options.batchSize, MEMORY_EMBEDDING_DEFAULT_BATCH_SIZE);
    this.retryAttempts = nonNegativeInteger(options.retryAttempts, MEMORY_EMBEDDING_DEFAULT_RETRY_ATTEMPTS);
    this.retryDelayMs = nonNegativeInteger(options.retryDelayMs, MEMORY_EMBEDDING_DEFAULT_RETRY_DELAY_MS);
    this.backfillOnStart = options.backfillOnStart !== false;
  }

  /** 啟動背景回填（非阻塞）。重複呼叫是 no-op；`close()` 之後不會再啟動。 */
  start(): void {
    if (this.started || this.closed) return;
    this.started = true;
    this.loopPromise = this.loop().catch((error: unknown) => {
      // 背景工作不能留下未處理的 rejection（Node 22 預設會終止行程）；記錄到 stderr 供診斷。
      console.error("[mnemoshelf] 記憶嵌入 worker 發生未預期的錯誤：", error);
    });
  }

  /** 把一筆記憶加入佇列（同一 id 已在佇列／處理中則忽略）。 */
  enqueue(id: number): void {
    if (this.closed) return;
    if (!Number.isInteger(id) || id <= 0) return;
    if (this.queuedIds.has(id)) return;
    this.queuedIds.add(id);
    this.queue.push(id);
    this.wake();
  }

  /** 本次執行的統計快照（供 `GET /diagnostics`）。 */
  stats(): MemoryEmbeddingWorkerStats {
    return {
      queued: this.queue.length,
      processing: this.processing ? 1 : 0,
      embedded: this.embedded,
      failed: this.failed,
      tooLong: this.tooLong,
    };
  }

  /**
   * 關閉：停止拉新工作、取消重試等待、清空佇列，並等目前處理中的那一筆結束。
   *
   * 冪等；未 `start()` 過也能安全呼叫。**不會**留下 timer 或 pending 的 loop promise。
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.queue.length = 0;
    this.queuedIds.clear();
    this.cancelSleep();
    this.wake();
    const pending = this.loopPromise;
    this.loopPromise = null;
    await pending;
  }

  /**
   * 主迴圈：有工作就處理；佇列空了就（在 `backfillOnStart` 時）補一批回填；沒得補就等
   * `enqueue()`／`close()`。關閉啟動回填時，`POST /memories` 的 enqueue 仍照常被處理。
   */
  private async loop(): Promise<void> {
    try {
      while (!this.closed) {
        const id = this.queue.shift();
        if (id !== undefined) {
          // 任何被處理過的 id 都算「本次執行已嘗試」：失敗後不要立刻被回填同一輪重抓，
          // 否則一次 start 內會無限重試同一批 failed 記憶（卡 B1 的「避免無限迴圈」）。
          this.backfillAttempted.add(id);
          try {
            await this.processOne(id);
          } finally {
            // 去重必須保留到「處理完成」為止：處理中重複 enqueue 同一 id 要被忽略
            // （卡 B1 §3「已在佇列／處理中則忽略」；驗收 F1）。`close()` 會清空集合，
            // 這裡對已關閉的實例刪除也無害。
            this.queuedIds.delete(id);
          }
          continue;
        }
        // 佇列空了：若啟用啟動回填，從 DB 補一批（新到舊）；否則只等 enqueue 的新工作。
        if (this.backfillOnStart && (await this.enqueueBackfillBatch())) continue;
        // `enqueue()` 可能在回填查詢期間到達（當下 `wakeLoop` 還是 null，喚醒會是 no-op）：
        // 先再確認佇列，否則會帶著新工作去睡，直到下一次 enqueue／close 才醒（生產環境會卡住）。
        if (this.queue.length > 0) continue;
        await this.waitForWork();
      }
    } finally {
      this.processing = false;
    }
  }

  /**
   * 從 DB 撈一批需要嵌入的記憶加入佇列；回傳「是否有加入新工作」。
   *
   * 以 `backfillAttempted` 去重：失敗（`failed`）的記憶在**同一次執行**內不再重抓，
   * 否則 `listMemoriesNeedingEmbedding` 會一直回傳它，迴圈永遠不停。
   */
  private async enqueueBackfillBatch(): Promise<boolean> {
    if (this.closed) return false;
    const memories = await this.store.listMemoriesNeedingEmbedding(this.embedder.info.id, this.batchSize);
    let added = false;
    for (const memory of memories) {
      if (this.backfillAttempted.has(memory.id)) continue;
      this.backfillAttempted.add(memory.id);
      this.enqueue(memory.id);
      added = true;
    }
    return added;
  }

  /** 處理單筆：成功 → ready；`input-too-long` → too-long；其他錯誤重試後 → failed。 */
  private async processOne(id: number): Promise<void> {
    const memory: Memory | null = await this.store.getMemory(id);
    // 記憶不存在或已刪除：跳過並清除佇列項（呼叫端只會 enqueue 剛建立的記憶，這是防禦）。
    if (memory === null || memory.deletedAt !== null) return;

    this.processing = true;
    try {
      for (let attempt = 0; attempt <= this.retryAttempts; attempt += 1) {
        // 關閉中：不再嘗試；保持原狀態（多半是 pending），下次 start 會回填。
        if (this.closed) return;
        try {
          const vector = await this.embedder.embedDocument(memory.content);
          await this.store.markMemoryEmbedded(id, this.embedder.info.id, vector);
          this.embedded += 1;
          return;
        } catch (error) {
          if (isInputTooLongError(error)) {
            // 單筆輸入過長是永久性失敗：重試也不會成功，直接標 too-long。
            await this.store.markMemoryEmbeddingFailed(id, "too-long");
            this.tooLong += 1;
            return;
          }
          // 最後一次嘗試仍失敗 → 跳出迴圈標 failed（可重試）。
          if (attempt >= this.retryAttempts) break;
          await this.sleep(this.retryDelayMs);
        }
      }
      await this.store.markMemoryEmbeddingFailed(id, "failed");
      this.failed += 1;
    } finally {
      this.processing = false;
    }
  }

  /** 等待新工作（佇列空時）；`enqueue()`／`close()` 會呼叫 `wake()`。 */
  private waitForWork(): Promise<void> {
    if (this.closed) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.wakeLoop = resolve;
    });
  }

  /** 喚醒等待中的 loop（沒有在等就是 no-op）。 */
  private wake(): void {
    const resolve = this.wakeLoop;
    this.wakeLoop = null;
    resolve?.();
  }

  /** 可被 `close()` 取消的重試等待（不留 timer）。 */
  private async sleep(ms: number): Promise<void> {
    if (ms <= 0 || this.closed) return;
    await new Promise<void>((resolve) => {
      this.sleepResolve = resolve;
      this.sleepTimer = setTimeout(() => {
        this.sleepTimer = null;
        this.sleepResolve = null;
        resolve();
      }, ms);
    });
  }

  /** 立刻結束重試等待（`close()` 用）。 */
  private cancelSleep(): void {
    if (this.sleepTimer !== null) {
      clearTimeout(this.sleepTimer);
      this.sleepTimer = null;
    }
    const resolve = this.sleepResolve;
    this.sleepResolve = null;
    resolve?.();
  }
}
