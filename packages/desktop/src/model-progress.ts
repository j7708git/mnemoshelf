/**
 * 模型下載進度的聚合（純函式，不碰 electron／transformers）。
 *
 * transformers.js 的 `progress_callback` 會送三種對進度有用的訊息：
 * - `download`／`initiate`：某個檔案開始處理（只知道檔名）；
 * - `progress`：某個檔案的下載位元組（`loaded`／`total`）；
 * - `progress_total`：呼叫 `from_pretrained()` 時，套件自己先問到「所有預期檔案」的大小，
 *   再送出的整體進度（`loaded`／`total`／`files`）。
 *
 * 之所以還要自己聚合：
 * 1. 進度來自兩個階段（AutoProcessor 的檔案 ＋ AutoModel 的檔案），套件不會替我們合併；
 * 2. **快取命中的檔案不會送 `progress`**（Node 下 ONNX 檔走 `return_path`），
 *    因此中斷後重試時，套件的整體百分比會偏保守。這裡把「掃描磁碟時已存在的完整檔案」
 *    當成已下載位元組加回去，重試時看到的就是「已經完成多少」的真實進度。
 */

/** transformers.js 送出的進度訊息（只取會用到的欄位）。 */
export interface RawProgressInfo {
  status?: string;
  name?: string;
  file?: string;
  loaded?: number;
  total?: number;
  files?: Record<string, { loaded?: number; total?: number }>;
}

/** 聚合後對外顯示的快照。 */
export interface ProgressSnapshot {
  /** 目前已知的模型位元組數（磁碟上已完成的 ＋ 這次下載的）。 */
  loaded: number;
  /** 目前已知的模型總位元組數；還沒取得任何檔案大小時為 0。 */
  total: number;
  /** 0–100（總量未知時為 0）。 */
  percent: number;
  /** 最後一個開始處理的檔案。 */
  currentFile: string | null;
  /** 這次下載實際抓到的位元組數（不含磁碟上沿用的部分）。 */
  downloadedBytes: number;
  /** 磁碟上已沿用（這次不必重抓）的位元組數。 */
  reusedBytes: number;
  /** 已完成的檔案數／目前已知的檔案數。 */
  filesDone: number;
  filesKnown: number;
}

interface FileEntry {
  loaded: number;
  total: number;
  reused: number;
}

/** 快取 key 在不同平台可能是反斜線；一律正規化成 `/` 再比對。 */
function normalizeFileKey(file: string): string {
  return file.split("\\").join("/");
}

export interface ModelProgressTrackerOptions {
  /** 掃描磁碟得到的既有檔案大小（相對模型目錄，POSIX 分隔）。 */
  preloaded?: Record<string, number>;
}

/** 累積 progress 訊息，輸出可顯示的整體進度。 */
export class ModelProgressTracker {
  private readonly files = new Map<string, FileEntry>();
  private currentFile: string | null = null;
  private downloadedBytes = 0;

  constructor(options: ModelProgressTrackerOptions = {}) {
    for (const [file, size] of Object.entries(options.preloaded ?? {})) {
      if (size > 0) this.files.set(normalizeFileKey(file), { loaded: 0, total: size, reused: size });
    }
  }

  /** 餵入一則進度訊息，回傳更新後的快照（未知形狀的訊息只會回傳現況）。 */
  handle(info: RawProgressInfo | null | undefined): ProgressSnapshot {
    if (info === null || info === undefined || typeof info !== "object") return this.snapshot();
    const status = typeof info.status === "string" ? info.status : "";

    if (status === "progress" || status === "initiate" || status === "download" || status === "done") {
      if (typeof info.file === "string" && info.file !== "") this.currentFile = normalizeFileKey(info.file);
    }

    if (status === "progress_total" && info.files !== undefined && info.files !== null) {
      // 這一則帶著「所有預期檔案」的大小：補進還沒見過的檔案，讓分母一開始就正確。
      for (const [file, entry] of Object.entries(info.files)) {
        const key = normalizeFileKey(file);
        const total = typeof entry?.total === "number" ? entry.total : 0;
        if (!this.files.has(key)) this.files.set(key, { loaded: 0, total, reused: 0 });
      }
    }

    if (status === "progress" && typeof info.file === "string") {
      const key = normalizeFileKey(info.file);
      const entry = this.files.get(key) ?? { loaded: 0, total: 0, reused: 0 };
      const loaded = typeof info.loaded === "number" ? info.loaded : entry.loaded;
      const total = typeof info.total === "number" ? info.total : entry.total;
      entry.loaded = Math.max(entry.loaded, loaded);
      entry.total = Math.max(entry.total, total);
      this.files.set(key, entry);
    }

    return this.snapshot();
  }

  /** 目前的快照。 */
  snapshot(): ProgressSnapshot {
    let loaded = 0;
    let total = 0;
    let downloadedBytes = 0;
    let reusedBytes = 0;
    let filesDone = 0;
    for (const entry of this.files.values()) {
      const available = Math.max(entry.loaded, entry.reused);
      loaded += Math.min(available, Math.max(entry.total, available));
      total += Math.max(entry.total, available);
      downloadedBytes += entry.loaded;
      reusedBytes += entry.reused;
      if (entry.total > 0 && available >= entry.total) filesDone += 1;
    }
    return {
      loaded,
      total,
      percent: total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 0,
      currentFile: this.currentFile,
      downloadedBytes,
      reusedBytes,
      filesDone,
      filesKnown: this.files.size,
    };
  }
}
