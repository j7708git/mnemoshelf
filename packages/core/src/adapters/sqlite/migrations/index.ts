import type { Migration } from "./0001_init.js";
import { migration0001Init } from "./0001_init.js";
import { migration0002MemoryPinned } from "./0002_memory_pinned.js";
import { migration0003MemoryEmbedding } from "./0003_memory_embedding.js";
import { migration0004MemoryContentHash } from "./0004_memory_content_hash.js";
import { migration0005MemoryProvenance } from "./0005_memory_provenance.js";
import { migration0006RawMemory } from "./0006_raw_memory.js";

/** 依序套用的遷移清單；只允許在尾端追加。 */
export const MIGRATIONS: readonly Migration[] = [
  migration0001Init,
  migration0002MemoryPinned,
  migration0003MemoryEmbedding,
  migration0004MemoryContentHash,
  migration0005MemoryProvenance,
  migration0006RawMemory,
];

export {
  migration0001Init,
  migration0002MemoryPinned,
  migration0003MemoryEmbedding,
  migration0004MemoryContentHash,
  migration0005MemoryProvenance,
  migration0006RawMemory,
};
export type { Migration };
