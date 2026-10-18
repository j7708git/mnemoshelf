import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { PathBlockedError, PathOutsideRootError } from "../errors.js";
import type { DocumentInput, Embedder, ImageInput } from "../ports/embedder.js";
import type { MetadataStore } from "../ports/metadata-store.js";
import type { ChunkKind, NewChunk, Root } from "../ports/types.js";
import type { VectorIndex, VectorItem } from "../ports/vector-index.js";
import { maskSecrets } from "../privacy/secret-masking.js";
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
  /**
   * 本次已判定跳過（不含 `skippedUnchanged`）的檔案數，對應結果的 `skippedFiles.length`。
   *
   * 來源有三類：讀取前守衛再檢查失敗（`unresolved-symlink`／`blocked`）、
   * 內容層二進位偵測（`binary-content`），以及媒體檔解不開（`undecodable`）。
   */
  skipped: number;
  /**
   * 本次處理失敗、但**沒有中斷整輪**的檔案數，對應結果的 `failedFiles.length`。
   *
   * 對帳語意：整輪跑完時 `processed + skippedUnchanged + skipped + failed === total`。
   * 失敗檔的既有索引資料**刻意保留**（不 purge）：下一輪索引會重試它，成功即自癒。
   */
  failed: number;
  /**
   * 本次已完成嵌入並寫入的 chunk 數（逐檔累加，`processFile` 成功才增加）。
   *
   * 為什麼不是「檔內即時進度」：`embedDocuments` 契約明定**呼叫端不需自行分批**
   * （超過批次上限由實作內部切視窗），所以一個檔案從進入嵌入到寫入完成之間，
   * 這裡不會有中間值。它提供的是「實際完成量」與跨檔的細粒度。
   */
  processedChunks: number;
  /**
   * 目前為止已切塊、預期會嵌入的 chunk 數（每個檔案讀取並切塊後累加）。
   *
   * 掃描階段無從得知內容，因此這是**下界**且只增不減；`estimatedChunks - processedChunks`
   * 是「已排入但尚未嵌入」的量。它讓 UI 在大檔開始時就能顯示規模
   * （例如「已嵌入 0／預估 8,800 塊」），而不是只看到檔案數不動。
   */
  estimatedChunks: number;
}

/**
 * 一個處理失敗、但沒有中斷整輪的檔案。
 *
 * `reason` 只放**短標籤**，不放原始錯誤訊息：`fs` 的錯誤訊息含本機絕對路徑，
 * 會經 REST 回應與 UI 外洩（見 repo 的隱私規範）。
 */
export interface FailedFileEntry {
  /** 相對 root 的路徑（`/` 分隔）。 */
  relPath: string;
  /** 失敗原因標籤：優先取錯誤的 `code`（如 `EACCES`），其次取錯誤名稱，都沒有時為 `error`。 */
  reason: string;
}

export interface IndexRootOptions {
  embedder: Embedder;
  store: MetadataStore;
  vec: VectorIndex;
  /**
   * 同時處理的檔案數上限（預設 2）。
   *
   * `embedder.runtimeStatus.serializedInference` 為 true 時（例如 DirectML：同一 session
   * 不可並發 `Run`）一律降為 1，呼叫端不需自行判斷。
   */
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
  /**
   * 本次**實際重新處理**（重新切塊並嵌入）的檔案中，至少遮罩一處機密的檔案數。
   *
   * - 只計文字／程式碼：媒體檔不套文字遮罩，永遠不計入。
   * - 不計跳過與失敗的檔案；`skippedUnchanged` 的檔案上一輪已遮罩，這一輪沒有重新遮罩，
   *   因此也不計入。
   * - 大於 0 代表遮罩在這一輪確實生效；可用於驗收與診斷（不看 chunk 內容也能確認）。
   *
   * 型別上標成選填，是為了讓既有的 `IndexRootResult` 物件字面值（例如不涉及遮罩的測試夾具）
   * 不必同步補欄位；`indexRoot` 的實際回傳值**一定**包含這個欄位。
   */
  maskedFiles?: number;
  /** 從磁碟消失、或不再納入而清除資料的檔案數。 */
  removedFiles: number;
  /**
   * 掃描時納入、但**讀取前守衛再檢查**失敗（例如掃描後路徑被換成 root 外 symlink）、
   * **內容層判定為二進位**（`binary-content`），或**媒體檔解不開**（`undecodable`）
   * 而跳過的檔案。正常情況為空；
   * 計數上 `processed + skippedUnchanged + skippedFiles.length + failedFiles.length === total`。
   */
  skippedFiles: SkippedEntry[];
  /**
   * 本次處理失敗（讀取、嵌入或寫入拋錯）的檔案；這些檔案**不中斷整輪**，其餘檔案照常完成。
   *
   * 對帳語意：`processed + skippedUnchanged + skippedFiles.length + failedFiles.length === total`。
   */
  failedFiles: FailedFileEntry[];
}

/** 內容層二進位偵測只看檔案前段這麼多 bytes（成本固定、與檔案大小無關）。 */
export const BINARY_SNIFF_BYTES = 8 * 1024;

/**
 * 前段內容中「不可印字元」的比例上限，超過即視為二進位。
 *
 * 計數方式：把前段解碼為 UTF-8 後逐 code point 檢查，計入
 * - C0／C1 控制字元（**保留 tab、LF、CR**——純文字檔的合法空白與換行）；
 * - DEL（U+007F）；
 * - U+FFFD（UTF-8 解碼失敗的替代字元，代表位元組不是合法 UTF-8）。
 *
 * 門檻 10% 是自訂值：正常文字（中文、emoji、程式碼）幾乎為 0；二進位檔即使沒有
 * NUL 位元組，解碼後也常出現大量 U+FFFD 或控制字元。先做 NUL 位元組快篩
 * （二進位格式幾乎必備），再用比例把關，兩者都不需要讀完整個檔案。
 */
const BINARY_MAX_NON_PRINTABLE_RATIO = 0.1;

/**
 * 前段內容看起來像二進位嗎？（副檔名說是文字／程式碼時的第二道防線）
 *
 * 為什麼需要：`classifyFile` 對未知副檔名一律回 `text`，所以 `.h5`／`.parquet`／
 * `.dng` 或沒有副檔名的系統檔會被當文字硬讀、切成上千塊嵌入（成本爆炸且無意義）。
 * 這裡在讀入後立刻放棄，不切塊、不嵌入。
 *
 * 已知限制：只看前 `BINARY_SNIFF_BYTES`（8 KB），NUL 位元組出現在更後面、
 * 或前段剛好全是可印字元的二進位檔不會被擋下（此時仍由副檔名層負責）。
 */
export function looksBinary(head: Uint8Array): boolean {
  if (head.includes(0)) return true;

  // `stream: true`：前段剛好切在半個多位元組字元中間時，尾端的不完整序列會被保留，
  // 不會變成 U+FFFD（否則正常的中文檔會因為 8 KB 邊界而誤判）。
  const text = new TextDecoder("utf-8", { fatal: false }).decode(head, { stream: true });

  let codePoints = 0;
  let nonPrintable = 0;
  for (const char of text) {
    codePoints += 1;
    const code = char.codePointAt(0) ?? 0;
    if (code === 0x09 || code === 0x0a || code === 0x0d) continue; // tab / LF / CR
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0xfffd) nonPrintable += 1;
  }
  if (codePoints === 0) return false;
  return nonPrintable / codePoints > BINARY_MAX_NON_PRINTABLE_RATIO;
}

/** 檔案位元組的 sha256（十六進位）。做為增量比對的檔案級內容 hash。 */
export function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * 這個檔案是不是「整檔交給 embedder 解碼」的媒體檔（非文字／程式碼）？
 *
 * 媒體檔每檔固定一個 chunk，嵌入前不切塊、也不做內容層二進位偵測
 * （圖片本來就是二進位；`looksBinary` 只服務 text／code）。
 */
function isMediaKind(kind: ChunkKind): boolean {
  return kind !== "text" && kind !== "code";
}

/**
 * 解碼失敗的**穩定錯誤碼**清單（跨 embedder 實作的結構化標記）。
 *
 * 本專案的 embedder（`@mnemoshelf/embedder-transformers`）把解不開的輸入拋成
 * `EmbedderInputError`（`code:"undecodable"`）。core 以這個碼為**主要**判準，不必解析
 * 訊息文字，也不需 import 該套件（core 不該知道 embedder 內用哪個解碼器）。`undecodable`
 * 與 `SkipReason` 同名是刻意的：同一個語意、同一個字。
 *
 * 其他 embedder 實作照樣帶這個 `code` 即可被認成同一類；沒帶的則靠下方的訊息措辭後備判定。
 */
const DECODE_FAILURE_ERROR_CODES: readonly string[] = ["undecodable"];

/**
 * 解碼失敗訊息的特徵（一律以**小寫**比對 `String(error.message)`）。
 *
 * **後備判準**：主要判準是上面的穩定錯誤碼；這裡保留訊息比對是為了**其他 embedder 實作**
 * 與既有行為（解碼發生在 embedder 內部，有些實作只拋一般的 `Error`：沒有 `code`、
 * `error.name` 也只是 `"Error"`——core 拿不到更結構化的訊號；而 core 也不該知道 embedder
 * 內部用了哪個解碼器）。
 *
 * 保守原則：**只認得清單內的措辭才降級成 skipped**，其餘（含未知的新錯誤）一律維持
 * `failedFiles`。萬一解碼器改了措辭，症狀會是「又出現 failed 的圖」這種看得見的回歸，
 * 而不是把真正的嵌入錯誤靜默吞成 skipped。
 *
 * 清單來源（皆為實際會拋出的字串，2026-10-16 查證 sharp 0.35／transformers.js 4.3.1）：
 * - sharp／libvips：`Input file contains unsupported image format`、
 *   `Input buffer contains unsupported image format`、`Input buffer has corrupt header`、
 *   `Input image exceeds pixel limit`（`limitInputPixels` 預設約 268 MP）。
 *   前兩者正是 HEIC／BMP／ICO 這類 sharp prebuilt 不支援的格式會走到的路。
 * - transformers.js：`Conversion failed due to unsupported number of channels: 2`
 *   （灰階＋alpha 的 2 通道圖）。
 */
const DECODE_FAILURE_MESSAGE_PATTERNS: readonly string[] = [
  "unsupported image format",
  "corrupt header",
  "unsupported number of channels",
  "exceeds pixel limit",
];

/**
 * 解碼失敗的錯誤**名稱**清單（同樣保守：只認得這些名字才降級）。
 *
 * 都是**本專案自己的** embedder 定義的穩定標籤，因此用名稱而非訊息：
 * - `EmbedderInputError`：輸入類錯誤的基底（解碼／前處理失敗），帶 `code:"undecodable"`。
 * - `EmptyImageInputError`：零位元組圖片輸入（例如 iCloud「最佳化儲存空間」留下的
 *   0 byte 佔位檔）；位元組為空＝永遠解不開，是 `EmbedderInputError` 的特例。
 */
const DECODE_FAILURE_ERROR_NAMES: readonly string[] = ["EmbedderInputError", "EmptyImageInputError"];

/**
 * 這個錯誤是否代表「媒體檔**解不開**」（而不是讀取／模型／寫入等真正的失敗）？
 *
 * 判準（依序）：
 * 1. **結構化標記優先**：錯誤的 `code` 是 `undecodable`（`DECODE_FAILURE_ERROR_CODES`），
 *    或錯誤名稱是已知的輸入類錯誤（`DECODE_FAILURE_ERROR_NAMES`）。這是與 embedder
 *    實作的穩定契約，與訊息措辭無關。
 * 2. **訊息措辭後備**：只認得 `DECODE_FAILURE_MESSAGE_PATTERNS` 內的措辭（保守原則見上），
 *    服務其他沒有帶 `code` 的 embedder 實作。
 *
 * 命中的檔案在 `indexRoot` 會被記成 `skipped(undecodable)`，不進 `failedFiles`、不中斷整輪。
 *
 * 取消（`AbortError`）**不算**解碼失敗：呼叫端必須先 `throwIfAborted`，讓取消照舊中止整輪；
 * 這裡也先擋掉 `AbortError`，免得它被帶有 `undecodable` 碼的包裝錯誤誤判（見 else 分支）。
 */
export function isMediaDecodeError(error: unknown): boolean {
  if (error instanceof Error && error.name === "AbortError") return false;
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && DECODE_FAILURE_ERROR_CODES.includes(code)) return true;
    if (DECODE_FAILURE_ERROR_NAMES.includes(error.name)) return true;
  }
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (message === "") return false;
  const lower = message.toLowerCase();
  return DECODE_FAILURE_MESSAGE_PATTERNS.some((pattern) => lower.includes(pattern));
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

/**
 * 依種類把檔案內容切成要寫入的 chunk 輸入。
 *
 * 文字／程式碼的 `content` 必須是**已遮罩**的文字（見 `processFile`）：遮罩發生在切塊之前，
 * 因此 chunk 文字與送進 embedder 的文字都不含可辨識憑證。`contentHash` 也必須是遮罩後
 * 內容的 sha256，增量比對才與「遮罩後才切塊」的語意一致。
 *
 * 媒體檔不傳內容：每檔固定一個 chunk（`text: null`），`contentHash` 為原始位元組的 sha256。
 */
function buildChunkInputs(file: ScanEntry, contentHash: string, content = ""): ChunkInput[] {
  // 媒體檔每檔一個 chunk（text: null）；文字／程式碼依（已遮罩的）內容切塊。
  if (isMediaKind(file.kind)) {
    return [{ seq: 0, kind: file.kind, text: null, contentHash }];
  }

  const pieces = file.kind === "code" ? chunkCode(content) : chunkText(content);
  return pieces.map((piece, index) => ({
    seq: index,
    kind: file.kind,
    text: piece.text,
    // 檔案級 hash（同一檔案的所有 chunk 相同）；chunk 級 hash 為後續加分項。
    contentHash,
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

  if (isMediaKind(file.kind)) {
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
  | { status: "processed"; chunks: number; masked: boolean }
  | { status: "unchanged" }
  | { status: "skipped"; reason: SkipReason };

/** `processFile` 的呼叫端掛鉤（只用於進度回報，不影響資料寫入）。 */
interface ProcessHooks {
  /**
   * 檔案切塊完成、**即將開始嵌入**時呼叫，帶該檔的 chunk 數。
   *
   * 時機刻意放在嵌入之前：大檔的嵌入是一次批次呼叫、中間不會有回報，
   * 先把預估塊數加進去，UI 才能立刻顯示這個檔案的規模。
   */
  onChunked?: (chunkCount: number) => void;
}

/**
 * 錯誤 → 可安全外洩的短標籤（見 `FailedFileEntry.reason`）。
 *
 * 不用 `error.message`：`fs` 的訊息（例如 `ENOENT: no such file or directory, open '<絕對路徑>'`）
 * 含本機絕對路徑。這裡只取結構化的 `code` 或錯誤名稱，並限制字元集與長度。
 */
function failureReason(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(code)) return code;
  if (error instanceof Error && /^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(error.name)) return error.name;
  return "error";
}

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
 * 移除某個檔案既有的 chunk 與向量（先刪向量再刪 chunk，與 `processFile` 的順序一致）。
 *
 * 用在「本次判定為 `binary-content`」與「媒體檔解不開（`undecodable`）」的檔案：
 * `indexRoot` 的清理迴圈只涵蓋「掃描未納入（不在 `files` 內）」的檔案，這兩類仍在 `files` 內，
 * 因此必須在這裡主動清除——否則先前（內容不同時）被索引的內容會留在索引裡
 * （違反「被跳過就不得保留索引」的語意，搜尋也會繼續撈到讀不出來的舊內容）。
 */
async function purgeChunks(rootId: number, relPath: string, deps: ProcessDeps): Promise<void> {
  const existing = await deps.store.listChunksByPath(rootId, relPath);
  if (existing.length === 0) return;
  await deps.vec.deleteByKeys(existing.map((chunk) => `c:${chunk.id}`));
  await deps.store.deleteChunksByPath(rootId, relPath);
}

/**
 * 處理單一檔案。
 *
 * 順序（資料完整性優先）：
 * 1. 讀取前守衛再檢查（TOCTOU）。
 * 2. 讀檔；文字／程式碼**先遮罩機密**（`maskSecrets`），再以遮罩後文字算檔案級 sha256；
 *    媒體檔不套文字遮罩，仍用原始位元組 sha256。
 * 3. 內容層二進位偵測（僅文字／程式碼）：命中即清除該檔既有資料並記 `binary-content`。
 * 4. 增量判斷：hash 未變**且**該檔所有 `c:<id>` 向量都還在，才跳過；否則整檔重做。
 * 5. **先嵌入**（全部成功才動 DB）：embed 失敗或中止時 DB 完全不動，下一輪自動重做。
 *    媒體檔的「解不開」（已知的解碼失敗）不算失敗：清除既有資料後記 `undecodable` 跳過。
 * 6. **先刪舊向量**再 `replaceChunks`（見下方註解），最後 `vec.upsert` 新向量。
 *
 * 第 6 步刻意「先刪舊向量」而不是「寫入後才刪」：如此任一中途失敗點都能在下輪自癒——
 * 若在刪除與寫入之間失敗，DB 仍是舊 hash 但向量已缺，下輪的增量判斷（第 4 步）會發現
 * 「hash 未變但向量不齊」而重做；若反過來「寫入後才刪」，在 `replaceChunks`→`upsert`
 * 之間失敗會讓舊向量成為永遠不會再被回收的孤兒（下輪只看到新 hash 的新向量齊全而跳過）。
 */
async function processFile(
  root: Root,
  file: ScanEntry,
  deps: ProcessDeps,
  signal: AbortSignal | undefined,
  hooks: ProcessHooks = {},
): Promise<FileOutcome> {
  const target = await revalidateReadPath(root, file);
  if (!target.ok) return { status: "skipped", reason: target.reason };

  const bytes = await fs.readFile(target.abs);

  // 內容層防線放在增量判斷**之前**：hash 未變的舊資料也必須被清掉。
  if (
    (file.kind === "text" || file.kind === "code") &&
    looksBinary(bytes.subarray(0, BINARY_SNIFF_BYTES))
  ) {
    await purgeChunks(root.id, file.relPath, deps);
    return { status: "skipped", reason: "binary-content" };
  }

  // 檔案級 hash 與切塊用的內容。
  //
  // - 媒體檔：原始位元組 hash（不套文字遮罩，行為不變）。
  // - 文字／程式碼：**先遮罩**，再用遮罩後文字算 hash 與切塊。好處：
  //   ① 既有（未遮罩）索引的 hash 不同 → 升級後第一次索引自動重做，不必手動清庫；
  //   ② 只改到會被遮罩的區段時，遮罩後內容相同 → 仍可跳過、不重嵌；
  //   ③ 遮罩規則改進導致結果變化時，下一次索引自動重做受影響檔案。
  //   已知取捨：無效 UTF-8 在解碼時變成 U+FFFD，重編碼後 hash 與原始位元組不同 →
  //   升級後第一次索引會重做一次，屬預期。遮罩本身是純函式且 idempotent。
  let contentHash: string;
  let content = "";
  let masked = false;
  if (isMediaKind(file.kind)) {
    contentHash = hashBytes(bytes);
  } else {
    const maskedContent = maskSecrets(bytes.toString("utf8"));
    content = maskedContent.text;
    contentHash = hashBytes(Buffer.from(content, "utf8"));
    masked = maskedContent.redacted;
  }

  const existing = await deps.store.listChunksByPath(root.id, file.relPath);
  if (existing.length > 0 && existing.every((chunk) => chunk.contentHash === contentHash)) {
    const keys = existing.map((chunk) => `c:${chunk.id}`);
    const present = await deps.vec.existingKeys(keys);
    if (keys.every((key) => present.has(key))) return { status: "unchanged" };
  }

  const inputs = buildChunkInputs(file, contentHash, content);
  hooks.onChunked?.(inputs.length);
  let vectors: Float32Array[];
  try {
    vectors = await embedInputs(inputs, file, bytes, deps.embedder, signal);
  } catch (error) {
    // 取消不是「檔案壞掉」：原樣拋出，讓整輪以 AbortError 結束（見 throwIfAborted）。
    throwIfAborted(signal);
    if (!isMediaKind(file.kind) || !isMediaDecodeError(error)) throw error;
    // 解不開的媒體檔（HEIC／BMP／ICO、2 通道圖、0 byte 佔位檔…）**不是**處理失敗：
    // 它這輩子都索引不了，記 failed 只會讓照片庫一開就滿是失敗，而且重跑結果相同。
    // 因此記成 skipped(undecodable)（短標籤、不含路徑），整輪照常完成。
    //
    // 既有索引資料一律清除（與 `binary-content` 同一條規則：「被跳過者不得保留索引」）：
    // 這個檔案先前可能是讀得出來、已被索引的版本，內容被換成解不開的位元組後，
    // 若保留舊向量，搜尋會一直撈到讀不出來的舊內容。
    await purgeChunks(root.id, file.relPath, deps);
    return { status: "skipped", reason: "undecodable" };
  }
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
  return { status: "processed", chunks: inputs.length, masked };
}

/**
 * 掃描並索引一個 `mode:'index'` 的 root。
 *
 * - 增量：文字／程式碼以**遮罩後內容**的 sha256、媒體檔以原始位元組的 sha256，與 DB 內既有
 *   chunk 的 `contentHash` 比對；hash 未變**且**該檔向量齊全才整檔跳過，否則重做
 *   （可自癒「DB 有 hash 但缺向量」的狀態）。
 * - **機密遮罩**：文字／程式碼在切塊、嵌入、寫入 DB 之前套用 curated 遮罩（與記憶同一組規則），
 *   chunk 文字不含可辨識憑證；媒體檔不套文字遮罩（位元組照舊送 embedder）。使用者磁碟上的
 *   檔案只讀不寫。`maskedFiles` 回報本輪至少遮一處的檔案數。
 * - 清理：以 `listRelPaths(rootId)` 減去**本次將納入的 `files`** 為準。磁碟上已消失、或本次
 *   被跳過（排除規則、`.gitignore`、黑名單、關模態、超過大小上限等）的檔案，其 chunk 與向量
 *   一律清除——不得因為出現在 skipped 就保留索引（隱私契約：不索引、不回傳）。
 *   內容層跳過（`binary-content`）與解碼失敗跳過（`undecodable`）的檔案仍在 `files` 內
 *   （掃描不讀內容，無法事先知道），因此由 `processFile` 自己清除（見 `purgeChunks`），
 *   結果同樣不保留索引。
 * - 可取消（`signal`：掃描期間於每個目錄／檔案迭代前檢查，worker 池於每個檔案開始前與嵌入前檢查）。
 *   限併發（`concurrency`，預設 2；embedder 宣告 `runtimeStatus.serializedInference` 時固定為 1）。
 * - **單檔失敗不中斷整輪**：`processFile` 的錯誤被記入 `failedFiles`（原因只留短標籤），
 *   其餘檔案照常處理；失敗檔的既有索引資料保留，下一輪重試（成功即自癒）。
 *   例外：「解不開的媒體檔」不算失敗，記 `skipped(undecodable)`（見 `isMediaDecodeError`）。
 * - 進度：檔案級計數（`processed`／`skippedUnchanged`／`skipped`／`failed`）整輪可對帳
 *   （四者相加 === `total`）；另有 chunk 級資訊（`processedChunks`／`estimatedChunks`），
 *   後者是逐檔切塊後累加的下界，只增不減（單一大檔的嵌入是單次批次呼叫，檔內不會有中間值）。
 * - 全程唯讀使用者檔案。
 */
export async function indexRoot(root: Root, options: IndexRootOptions): Promise<IndexRootResult> {
  if (root.mode !== "index") {
    throw new RootNotIndexableError(root.id, root.mode);
  }

  const { embedder, store, vec, signal } = options;
  // 序列推論的裝置（例如 DirectML）不允許同一 session 並發 `Run`：一律單一檔案 worker。
  // 這裡是唯一的下限來源，呼叫端傳進來的 concurrency 也不得超過它。
  const serialized = embedder.runtimeStatus?.serializedInference === true;
  const concurrency = serialized ? 1 : Math.max(1, Math.floor(options.concurrency ?? 2));
  const scanOptions: ScanOptions = {};
  if (options.maxFileBytes !== undefined) scanOptions.maxFileBytes = options.maxFileBytes;
  // 把 signal 一路帶進掃描層：大目錄下取消不必等整輪走訪結束（見 ScanOptions.signal）。
  if (signal !== undefined) scanOptions.signal = signal;

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
  let maskedFiles = 0;
  let failed = 0;
  let processedChunks = 0;
  let estimatedChunks = 0;
  const skippedFiles: SkippedEntry[] = [];
  const failedFiles: FailedFileEntry[] = [];
  const report = (): void =>
    options.onProgress?.({
      processed,
      total,
      skippedUnchanged,
      skipped: skippedFiles.length,
      failed,
      processedChunks,
      estimatedChunks,
    });

  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= files.length) return;
      throwIfAborted(signal);
      const file = files[index]!;
      let outcome: FileOutcome;
      try {
        outcome = await processFile(root, file, { embedder, store, vec }, signal, {
          onChunked: (chunkCount) => {
            estimatedChunks += chunkCount;
            report();
          },
        });
      } catch (error) {
        // 中止優先於「壞檔」：取消不是檔案失敗，整輪就此結束（見 throwIfAborted）。
        throwIfAborted(signal);
        // 壞檔（讀取／嵌入／寫入拋錯）只記下來，不讓整輪失敗。
        failed += 1;
        failedFiles.push({ relPath: file.relPath, reason: failureReason(error) });
        report();
        continue;
      }
      if (outcome.status === "processed") {
        processed += 1;
        processedChunks += outcome.chunks;
        if (outcome.masked) maskedFiles += 1;
      } else if (outcome.status === "unchanged") skippedUnchanged += 1;
      else skippedFiles.push({ relPath: file.relPath, reason: outcome.reason });
      report();
    }
  };

  const workerCount = Math.min(concurrency, files.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return { total, processed, skippedUnchanged, maskedFiles, removedFiles, skippedFiles, failedFiles };
}
