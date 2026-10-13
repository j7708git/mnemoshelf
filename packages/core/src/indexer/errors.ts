import type { RootMode } from "../ports/types.js";

/**
 * indexer 專用的具名錯誤（沿用 `src/errors.ts` 的風格）。
 *
 * 放在 `src/indexer/` 而非 `src/errors.ts`，是因為本任務卡只允許寫入 `src/indexer/**`；
 * 之後若 PM 要集中管理，可直接搬進 `src/errors.ts`。
 */

/** 對 `mode:'browse'` 的 root 呼叫 indexRoot（只有 `index` 模式可建立索引）。 */
export class RootNotIndexableError extends Error {
  readonly rootId: number;
  readonly mode: RootMode;

  constructor(rootId: number, mode: RootMode) {
    super(`root ${rootId} 的模式為 ${mode}，只有 index 模式可以建立索引`);
    this.name = "RootNotIndexableError";
    this.rootId = rootId;
    this.mode = mode;
  }
}
