/**
 * 首次啟動的模型下載狀態機：確認就緒 → 下載（帶進度）→ 驗證 → 就緒；失敗可重試。
 *
 * 設計要點：
 * - **狀態機與副作用分離**：真的下載（`download`）與驗證（`verify`）由呼叫端注入，
 *   因此重試、進度聚合、錯誤狀態都可以用單元測試覆蓋，不需要真的連網。
 * - **重試不清掉已完成的檔案**：下載一律走 transformers.js 的快取（tmp ＋ rename），
 *   這裡只負責「重掃磁碟 → 把已完成的位元組算進進度 → 再下載缺的部分」。
 * - **中斷後的暫存檔**：程序被砍會留下 `*.tmp.<pid>.<rand>`，啟動時先清掉（它們永遠是垃圾），
 *   並把清掉的路徑回報給 UI／報告。
 * - 每次狀態變化都回呼 `onUpdate`（main process 轉送到 renderer）。
 */
import {
  checkModelReadiness,
  modelRootDir,
  removeStaleTempFiles,
  type ModelProfile,
} from "./model-profile.js";
import { ModelProgressTracker, type ProgressSnapshot, type RawProgressInfo } from "./model-progress.js";

export type BootstrapPhase = "idle" | "checking" | "downloading" | "verifying" | "ready" | "failed";

/** 可讀的錯誤摘要（不含堆疊）。 */
export interface BootstrapError {
  name: string;
  message: string;
}

export interface BootstrapState {
  phase: BootstrapPhase;
  modelId: string;
  /** 模型檔案的落地目錄。 */
  modelDir: string;
  /** 這次啟動第幾次嘗試（1 起算）；未開始為 0。 */
  attempt: number;
  maxAttempts: number;
  progress: ProgressSnapshot;
  /** 這次啟動沿用的位元組數（>0 表示上次中斷前下載好的檔案被重用）。 */
  reusedBytes: number;
  /** 上一次嘗試的錯誤（若這輪重試前曾失敗）。 */
  lastError: BootstrapError | null;
  /** 目前為止失敗過的嘗試。 */
  failures: { attempt: number; error: BootstrapError }[];
  /** 缺少的必要檔案（最近一次檢查）。 */
  missingFiles: string[];
  /** 這次啟動清掉的中斷暫存檔。 */
  removedTempFiles: string[];
  /** 給使用者看的短說明。 */
  message: string;
  /** 失敗時的處理建議。 */
  hint: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface ModelBootstrapContext {
  profile: ModelProfile;
  modelDir: string;
  /** 磁碟上已完成的檔案（讓下載端與進度顯示知道不必重抓的部分）。 */
  preloaded: Record<string, number>;
  onProgress: (info: RawProgressInfo) => void;
}

export interface ModelBootstrapOptions {
  profile: ModelProfile;
  modelDir: string;
  /** 真的把檔案抓下來（正式版是 transformers.js；測試注入假的）。 */
  download: (context: ModelBootstrapContext) => Promise<void>;
  /** 下載完成後的驗證（例如請 embedder 真的載入一次）。失敗視為這一輪失敗。 */
  verify?: (context: { profile: ModelProfile; modelDir: string }) => Promise<void>;
  onUpdate?: (state: BootstrapState) => void;
  /** 最多嘗試幾次（含第一次）；預設 3。 */
  maxAttempts?: number;
  /** 第 n 次失敗後等多久再試（毫秒）；預設 1s、2s、4s… */
  retryDelayMs?: (attempt: number) => number;
  log?: (message: string) => void;
  /** 測試用：跳過等待。 */
  delay?: (ms: number) => Promise<void>;
}

const DEFAULT_MAX_ATTEMPTS = 3;

function describeError(error: unknown): BootstrapError {
  if (error instanceof Error) return { name: error.name, message: error.message };
  return { name: "Error", message: String(error) };
}

const EMPTY_PROGRESS: ProgressSnapshot = {
  loaded: 0,
  total: 0,
  percent: 0,
  currentFile: null,
  downloadedBytes: 0,
  reusedBytes: 0,
  filesDone: 0,
  filesKnown: 0,
};

function defaultDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 首次啟動的模型下載器（同一時間只會有一輪在跑）。 */
export class ModelBootstrap {
  private readonly options: ModelBootstrapOptions;
  private state: BootstrapState;
  private running: Promise<BootstrapState> | null = null;

  constructor(options: ModelBootstrapOptions) {
    this.options = options;
    this.state = {
      phase: "idle",
      modelId: options.profile.modelId,
      modelDir: modelRootDir(options.modelDir, options.profile),
      attempt: 0,
      maxAttempts: options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      progress: EMPTY_PROGRESS,
      reusedBytes: 0,
      lastError: null,
      failures: [],
      missingFiles: [],
      removedTempFiles: [],
      message: "尚未檢查模型。",
      hint: null,
      startedAt: null,
      finishedAt: null,
    };
  }

  /** 目前的狀態（複本）。 */
  getState(): BootstrapState {
    return { ...this.state, progress: { ...this.state.progress }, failures: [...this.state.failures] };
  }

  /**
   * 確認模型就緒；未就緒就下載（含自動重試）。
   *
   * 可重複呼叫：已就緒時直接回傳；進行中時回同一個 promise（不會同時跑兩輪）。
   * UI 的「重試」按鈕就是再呼叫一次。
   */
  async start(): Promise<BootstrapState> {
    if (this.running !== null) return this.running;
    this.running = this.perform().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private update(patch: Partial<BootstrapState>): void {
    this.state = { ...this.state, ...patch };
    this.options.onUpdate?.(this.getState());
  }

  private async perform(): Promise<BootstrapState> {
    const log = this.options.log ?? ((): void => {});
    const delay = this.options.delay ?? defaultDelay;

    this.update({
      phase: "checking",
      message: "正在確認模型是否已下載…",
      hint: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      lastError: null,
      failures: [],
      missingFiles: [],
      removedTempFiles: [],
    });

    const initial = await checkModelReadiness(this.options.modelDir, this.options.profile);
    if (initial.staleTempFiles.length > 0) {
      const removed = await removeStaleTempFiles(
        modelRootDir(this.options.modelDir, this.options.profile),
        initial,
      );
      this.update({ removedTempFiles: removed });
      log(`清除中斷下載留下的暫存檔 ${removed.length} 個：${removed.join("、")}`);
    }

    if (initial.ready) {
      log("模型已就緒（磁碟上已有完整檔案），略過下載");
      return this.markReady(initial.totalBytes, "模型已就緒，直接使用磁碟上的快取。");
    }

    log(`模型尚未就緒（缺少 ${initial.missing.join("、") || "檔案"}），開始下載`);
    const failures: { attempt: number; error: BootstrapError }[] = [];

    for (let attempt = 1; attempt <= this.state.maxAttempts; attempt += 1) {
      // 每次嘗試都重掃磁碟：上一輪下載完成的檔案不必重抓，也要算進進度。
      const before = await checkModelReadiness(this.options.modelDir, this.options.profile);
      const tracker = new ModelProgressTracker({ preloaded: before.files });

      this.update({
        phase: "downloading",
        attempt,
        missingFiles: before.missing,
        progress: tracker.snapshot(),
        reusedBytes: tracker.snapshot().reusedBytes,
        message:
          attempt === 1
            ? "首次啟動需要下載模型（約 300 MB），請保持網路連線。"
            : `第 ${attempt} 次嘗試下載模型…`,
        hint: null,
      });

      try {
        await this.options.download({
          profile: this.options.profile,
          modelDir: this.options.modelDir,
          preloaded: before.files,
          onProgress: (info) => {
            const snapshot = tracker.handle(info);
            this.update({ progress: snapshot, reusedBytes: snapshot.reusedBytes });
          },
        });

        const after = await checkModelReadiness(this.options.modelDir, this.options.profile);
        if (!after.ready) {
          throw new Error(`下載結束但仍缺少必要檔案：${after.missing.join("、")}`);
        }

        if (this.options.verify !== undefined) {
          this.update({ phase: "verifying", message: "模型下載完成，正在驗證可用性…" });
          await this.options.verify({ profile: this.options.profile, modelDir: this.options.modelDir });
        }

        log(`模型下載完成（第 ${attempt} 次嘗試）：${after.totalBytes} bytes`);
        return this.markReady(after.totalBytes, "模型下載完成，已可使用。");
      } catch (error) {
        const failure = describeError(error);
        failures.push({ attempt, error: failure });
        log(`模型下載失敗（第 ${attempt} 次嘗試）：${failure.name}: ${failure.message}`);
        const last = attempt >= this.state.maxAttempts;
        if (last) {
          this.update({
            phase: "failed",
            failures: [...failures],
            lastError: failure,
            finishedAt: new Date().toISOString(),
            message: "模型下載失敗。",
            hint:
              "確認網路可以連到 huggingface.co，或稍後再按「重試」。已經下載完成的檔案會保留，重試只會抓缺少的部分。",
          });
          return this.getState();
        }
        const waitMs = this.options.retryDelayMs?.(attempt) ?? 1000 * 2 ** (attempt - 1);
        this.update({
          phase: "downloading",
          failures: [...failures],
          lastError: failure,
          message: `下載中斷（${failure.message}），${Math.round(waitMs / 1000)} 秒後自動重試…`,
          hint: null,
        });
        await delay(waitMs);
      }
    }

    // 理論上不會走到這裡（迴圈最後一輪必定 return）；留著避免無聲回傳 undefined。
    return this.getState();
  }

  private markReady(totalBytes: number, message: string): BootstrapState {
    this.update({
      phase: "ready",
      message,
      hint: null,
      finishedAt: new Date().toISOString(),
      missingFiles: [],
      progress: {
        ...this.getState().progress,
        percent: 100,
        loaded: Math.max(this.getState().progress.loaded, totalBytes),
        total: Math.max(this.getState().progress.total, totalBytes),
      },
    });
    return this.getState();
  }
}
