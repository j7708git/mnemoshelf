import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { PathBlockedError, PathOutsideRootError } from "../errors.js";
import type { DocumentInput, Embedder, ImageInput } from "../ports/embedder.js";
import type { MetadataStore } from "../ports/metadata-store.js";
import type { NewChunk, Root } from "../ports/types.js";
import type { VectorIndex, VectorItem } from "../ports/vector-index.js";
import { resolveInsideRoot } from "../roots/path-guard.js";
import { chunkCode, chunkText } from "./chunk-text.js";
import { RootNotIndexableError } from "./errors.js";
import { walkRoot, type ScanEntry, type ScanOptions, type SkipReason, type SkippedEntry } from "./scan.js";

/** 每個 chunk 的輸入（rootId 與 relPath 由 replaceChunks 補上）。 */
type ChunkInput = Omit<NewChunk, "rootId" | "relPath">;

/** 每次索引的進度回報。 */
export interface IndexProgress {
  /** 已重新處理（重新切塊並嵌入）的檔案數。 */
  processed: number;
  /** 本次掃描應處理的檔案總數。 */
  total: number;
  /** 因內容未變更、且向量齊全而整檔跳過的檔案數。 */
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
  /** 從磁碟消失、或不再納入而清除資料的檔案數。 */
  removedFiles: number;
  /**
   * 掃描時納入、但**讀取前守衛再檢查**失敗（例如掃描後路徑被換成 root 外 symlink）而跳過的檔案。
   * 正常情況為空；計數上 `processed + skippedUnchanged + skippedFiles.length === total`。
   */
  skippedFiles: SkippedEntry[];
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
function buildChunkInputs(file: ScanEntry, fileHash: string, bytes: Buffer): ChunkInput[] {
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

/**
 * 對切塊結果產生向量（尚未寫入任何儲存）。
 *
 * 文字／程式碼：**每檔一次批次呼叫** `embedDocuments`（檔案內不再逐塊 await）。
 * 媒體檔每檔固定一塊，批次化沒有換到任何東西，維持單筆 `embedImage`。
 * `signal` 在批次前檢查，並一路傳給 embedder（沿用 `throwIfAborted` 慣例）：
 * 中止時直接拋出，呼叫端因此不會動到 DB。
 */
async function embedInputs(
  inputs: readonly ChunkInput[],
  file: ScanEntry,
  bytes: Buffer,
  embedder: Embedder,
  signal: AbortSignal | undefined,
): Promise<Float32Array[]> {
  if (inputs.length === 0) return [];

  if (file.kind !== "text" && file.kind !== "code") {
    throwIfAborted(signal);
    const image: ImageInput = file.mimeType === null ? { bytes } : { bytes, mimeType: file.mimeType };
    return [await embedder.embedImage(image)];
  }

  // title 用相對路徑：spike 顯示帶 title 對檢索顯著有利。
  const documents: DocumentInput[] = inputs.map((input) => ({ text: input.text ?? "", title: file.relPath }));
  throwIfAborted(signal);
  return embedder.embedDocuments(documents, { signal });
}

interface ProcessDeps {
  embedder: Embedder;
  store: MetadataStore;
  vec: VectorIndex;
}

type FileOutcome =
  | { status: "processed" }
  | { status: "unchanged" }
  | { status: "skipped"; reason: SkipReason };

/**
 * 讀取前對「掃描時解析好的路徑」再過一次守衛（TOCTOU 防護）。
 *
 * 掃描與讀取之間，該路徑可能被換成指向 root 外的 symlink；直接用掃描結果讀取會繞過守衛。
 * 因此讀取前用 `resolveInsideRoot` 重新解析並確認邊界與黑名單，失敗就以 skipped 跳過，
 * 不中斷整輪。回傳的 `abs` 是重新解析後的真實路徑。
 */
async function revalidateReadPath(
  root: Root,
  file: ScanEntry,
): Promise<{ ok: true; abs: string } | { ok: false; reason: SkipReason }> {
  try {
    const resolved = await resolveInsideRoot([root], file.absPath);
    return { ok: true, abs: resolved.abs };
  } catch (error) {
    if (error instanceof PathOutsideRootError) return { ok: false, reason: "unresolved-symlink" };
    if (error instanceof PathBlockedError) return { ok: false, reason: "blocked" };
    throw error;
  }
}

/**
 * 處理單一檔案。
 *
 * 順序（資料完整性優先）：
 * 1. 讀取前守衛再檢查（TOCTOU）。
 * 2. 讀檔、算檔案級 sha256。
 * 3. 增量判斷：hash 未變**且**該檔所有 `c:<id>` 向量都還在，才跳過；否則整檔重做。
 * 4. **先嵌入**（全部成功才動 DB）：embed 失敗或中止時 DB 完全不動，下一輪自動重做。
 * 5. **先刪舊向量**再 `replaceChunks`（見下方註解），最後 `vec.upsert` 新向量。
 *
 * 第 5 步刻意「先刪舊向量」而不是「寫入後才刪」：如此任一中途失敗點都能在下輪自癒——
 * 若在刪除與寫入之間失敗，DB 仍是舊 hash 但向量已缺，下輪的增量判斷（第 3 步）會發現
 * 「hash 未變但向量不齊」而重做；若反過來「寫入後才刪」，在 `replaceChunks`→`upsert`
 * 之間失敗會讓舊向量成為永遠不會再被回收的孤兒（下輪只看到新 hash 的新向量齊全而跳過）。
 */
async function processFile(
  root: Root,
  file: ScanEntry,
  deps: ProcessDeps,
  signal: AbortSignal | undefined,
): Promise<FileOutcome> {
  const target = await revalidateReadPath(root, file);
  if (!target.ok) return { status: "skipped", reason: target.reason };

  const bytes = await fs.readFile(target.abs);
  const fileHash = hashBytes(bytes);

  const existing = await deps.store.listChunksByPath(root.id, file.relPath);
  if (existing.length > 0 && existing.every((chunk) => chunk.contentHash === fileHash)) {
    const keys = existing.map((chunk) => `c:${chunk.id}`);
    const present = await deps.vec.existingKeys(keys);
    if (keys.every((key) => present.has(key))) return { status: "unchanged" };
  }

  const inputs = buildChunkInputs(file, fileHash, bytes);
  const vectors = await embedInputs(inputs, file, bytes, deps.embedder, signal);
  throwIfAborted(signal);

  // 舊 chunk 的向量先回收（replaceChunks 會換成新的 autoincrement id）。
  if (existing.length > 0) {
    await deps.vec.deleteByKeys(existing.map((chunk) => `c:${chunk.id}`));
  }

  const written = await deps.store.replaceChunks(root.id, file.relPath, inputs);
  const items: VectorItem[] = written.map((chunk, index) => ({
    key: `c:${chunk.id}`,
    rootId: chunk.rootId,
    embedderId: deps.embedder.info.id,
    vec: vectors[index]!,
  }));
  await deps.vec.upsert(items);
  return { status: "processed" };
}

/**
 * 掃描並索引一個 `mode:'index'` 的 root。
 *
 * - 增量：以檔案 sha256 與 DB 內既有 chunk 的 `contentHash` 比對；hash 未變**且**該檔向量齊全
 *   才整檔跳過，否則重做（可自癒「DB 有 hash 但缺向量」的狀態）。
 * - 清理：以 `listRelPaths(rootId)` 減去**本次將納入的 `files`** 為準。磁碟上已消失、或本次
 *   被跳過（排除規則、`.gitignore`、黑名單、關模態、超過大小上限等）的檔案，其 chunk 與向量
 *   一律清除——不得因為出現在 skipped 就保留索引（隱私契約：不索引、不回傳）。
 * - 可取消（`signal`，於每個檔案開始前與嵌入前檢查）與限併發（`concurrency`，預設 2）。
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

  // 清理：本次將納入的檔案清單（skipped 中的檔案不在此集合内，因此會被清除）。
  const retained = new Set(files.map((file) => file.relPath));
  let removedFiles = 0;
  for (const relPath of await store.listRelPaths(root.id)) {
    if (retained.has(relPath)) continue;
    throwIfAborted(signal);
    const removedChunkIds = await store.deleteChunksByPath(root.id, relPath);
    if (removedChunkIds.length > 0) {
      await vec.deleteByKeys(removedChunkIds.map((id) => `c:${id}`));
    }
    removedFiles += 1;
  }

  let processed = 0;
  let skippedUnchanged = 0;
  const skippedFiles: SkippedEntry[] = [];
  const report = (): void => options.onProgress?.({ processed, total, skippedUnchanged });

  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= files.length) return;
      throwIfAborted(signal);
      const file = files[index]!;
      const outcome = await processFile(root, file, { embedder, store, vec }, signal);
      if (outcome.status === "processed") processed += 1;
      else if (outcome.status === "unchanged") skippedUnchanged += 1;
      else skippedFiles.push({ relPath: file.relPath, reason: outcome.reason });
      report();
    }
  };

  const workerCount = Math.min(concurrency, files.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return { total, processed, skippedUnchanged, removedFiles, skippedFiles };
}
