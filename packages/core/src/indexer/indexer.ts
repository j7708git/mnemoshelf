import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import type { Embedder, ImageInput } from "../ports/embedder.js";
import type { MetadataStore } from "../ports/metadata-store.js";
import type { Chunk, NewChunk, Root } from "../ports/types.js";
import type { VectorIndex, VectorItem } from "../ports/vector-index.js";
import { chunkCode, chunkText } from "./chunk-text.js";
import { RootNotIndexableError } from "./errors.js";
import { walkRoot, type ScanEntry, type ScanOptions } from "./scan.js";

/** 每次索引的進度回報。`processed + skippedUnchanged` 最終等於 `total`。 */
export interface IndexProgress {
  /** 已重新處理（重新切塊並嵌入）的檔案數。 */
  processed: number;
  /** 本次掃描應處理的檔案總數。 */
  total: number;
  /** 因內容未變更而整檔跳過的檔案數。 */
  skippedUnchanged: number;
}

export interface IndexRootOptions {
  embedder: Embedder;
  store: MetadataStore;
  vec: VectorIndex;
  /** 同時處理的檔案數上限（預設 2）。 */
  concurrency?: number;
  signal?: AbortSignal;
  onProgress?: (progress: IndexProgress) => void;
  /** 單檔大小上限，預設 10 MB（見 scan.walkRoot）。 */
  maxFileBytes?: number;
}

export interface IndexRootResult {
  total: number;
  processed: number;
  skippedUnchanged: number;
  /** 從磁碟消失、已清除資料的檔案數。 */
  removedFiles: number;
}

/** 檔案位元組的 sha256（十六進位）。做為增量比對的檔案級內容 hash。 */
export function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal === undefined) return;
  if (typeof signal.throwIfAborted === "function") {
    signal.throwIfAborted();
    return;
  }
  if (signal.aborted) {
    const reason = signal.reason;
    if (reason instanceof Error) throw reason;
    const error = new Error("索引已取消");
    error.name = "AbortError";
    throw error;
  }
}

/** 依種類把檔案內容切成要寫入的 chunk 輸入。 */
function buildChunkInputs(file: ScanEntry, fileHash: string, bytes: Buffer): Omit<NewChunk, "rootId" | "relPath">[] {
  // 媒體檔每檔一個 chunk（text: null）；文字／程式碼依內容切塊。
  if (file.kind !== "text" && file.kind !== "code") {
    return [{ seq: 0, kind: file.kind, text: null, contentHash: fileHash }];
  }

  const content = bytes.toString("utf8");
  const pieces = file.kind === "code" ? chunkCode(content) : chunkText(content);
  return pieces.map((piece, index) => ({
    seq: index,
    kind: file.kind,
    text: piece.text,
    // 檔案級 hash（同一檔案的所有 chunk 相同）；chunk 級 hash 為後續加分項。
    contentHash: fileHash,
  }));
}

/** 對剛寫入的 chunk 產生向量並寫入 VectorIndex。 */
async function embedChunks(chunkRows: Chunk[], file: ScanEntry, bytes: Buffer, embedder: Embedder, vec: VectorIndex): Promise<void> {
  const items: VectorItem[] = [];
  for (const chunk of chunkRows) {
    let vector: Float32Array;
    if (file.kind === "text" || file.kind === "code") {
      // title 用相對路徑：spike 顯示帶 title 對檢索顯著有利。
      vector = await embedder.embedDocument(chunk.text ?? "", file.relPath);
    } else {
      const image: ImageInput = file.mimeType === null ? { bytes } : { bytes, mimeType: file.mimeType };
      vector = await embedder.embedImage(image);
    }
    items.push({ key: `c:${chunk.id}`, rootId: chunk.rootId, embedderId: embedder.info.id, vec: vector });
  }
  await vec.upsert(items);
}

interface ProcessDeps {
  embedder: Embedder;
  store: MetadataStore;
  vec: VectorIndex;
}

/** 處理單一檔案；回傳 true 表示有重新嵌入（processed），false 表示未變更而跳過。 */
async function processFile(root: Root, file: ScanEntry, deps: ProcessDeps): Promise<boolean> {
  const bytes = await fs.readFile(file.absPath);
  const fileHash = hashBytes(bytes);

  const existing = await deps.store.listChunksByPath(root.id, file.relPath);
  if (existing.length > 0 && existing.every((chunk) => chunk.contentHash === fileHash)) {
    return false;
  }

  const inputs = buildChunkInputs(file, fileHash, bytes);
  const written = await deps.store.replaceChunks(root.id, file.relPath, inputs);
  await embedChunks(written, file, bytes, deps.embedder, deps.vec);
  return true;
}

/**
 * 掃描並索引一個 `mode:'index'` 的 root。
 *
 * - 增量：以檔案 sha256 與 DB 內既有 chunk 的 `contentHash` 比對，未變更者整檔跳過。
 * - 已從磁碟消失的檔案，會清除其 chunk（`deleteChunksByPath`）與向量（`vec.deleteByKeys`）。
 * - 可取消（`signal`，於每個檔案開始前檢查）與限併發（`concurrency`，預設 2）。
 * - 全程唯讀使用者檔案。
 */
export async function indexRoot(root: Root, options: IndexRootOptions): Promise<IndexRootResult> {
  if (root.mode !== "index") {
    throw new RootNotIndexableError(root.id, root.mode);
  }

  const { embedder, store, vec, signal } = options;
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? 2));
  const scanOptions: ScanOptions = {};
  if (options.maxFileBytes !== undefined) scanOptions.maxFileBytes = options.maxFileBytes;

  const scan = await walkRoot(root, scanOptions);
  const files = scan.files;
  const total = files.length;

  // 清除磁碟上已消失的檔案。
  const onDisk = new Set(files.map((file) => file.relPath));
  let removedFiles = 0;
  for (const relPath of await store.listRelPaths(root.id)) {
    if (onDisk.has(relPath)) continue;
    throwIfAborted(signal);
    const removedChunkIds = await store.deleteChunksByPath(root.id, relPath);
    if (removedChunkIds.length > 0) {
      await vec.deleteByKeys(removedChunkIds.map((id) => `c:${id}`));
    }
    removedFiles += 1;
  }

  let processed = 0;
  let skippedUnchanged = 0;
  const report = (): void => options.onProgress?.({ processed, total, skippedUnchanged });

  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= files.length) return;
      throwIfAborted(signal);
      const changed = await processFile(root, files[index]!, { embedder, store, vec });
      if (changed) processed += 1;
      else skippedUnchanged += 1;
      report();
    }
  };

  const workerCount = Math.min(concurrency, files.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return { total, processed, skippedUnchanged, removedFiles };
}
