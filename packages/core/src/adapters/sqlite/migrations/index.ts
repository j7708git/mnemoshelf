import type { Migration } from "./0001_init.js";
import { migration0001Init } from "./0001_init.js";
import { migration0002MemoryPinned } from "./0002_memory_pinned.js";

/** 依序套用的遷移清單；只允許在尾端追加。 */
export const MIGRATIONS: readonly Migration[] = [migration0001Init, migration0002MemoryPinned];

export { migration0001Init, migration0002MemoryPinned };
export type { Migration };
