/**
 * 加速器（macOS 的 CoreML EP）**自我測試**：量測 → 判斷 → 持久化決定。
 *
 * 為什麼需要這一層（研究依據：`research/mac-gpu-coreml-feasibility.md`）：
 *   - CoreML **沒有能力查詢 API**：沒有辦法事先問「這個模型在 CoreML 上會不會更快」。
 *     能拿到的最強訊號只有「能不能建 session」「實測耗時」「向量相似度」。
 *   - 建 session 的成本是**編譯時間**（官方文件：不設 `ModelCacheDirectory` 時每次都要重編，
 *     可能數分鐘；而 Node 綁定拿不到該選項），所以「每次啟動都先試」不可接受
 *     → 必須「量測一次、把決定快取起來」。
 *   - 已知的上游風險：`onnxruntime#28005`（CoreML EP＋external data＋以檔案路徑建 session 的
 *     SIGBUS，未修）可能在測試中直接殺掉行程。因此**測試前先落地 `pending` 標記**，
 *     下次啟動看到它就知道「前一輪死於測試中」，永久改用 CPU（見 `classifyDecision`）。
 *
 * 這一輪的判斷沿用既有判準（`spikes/dml-bench` 的原則）：吞吐倍率 ≥ 1.3×、
 * 向量一致性 min cos ≥ 0.999、測試期峰值 RSS ≤ 6 GiB。三者皆以「剛好達到」為通過。
 *
 * 除了判準用的三個數字，這裡另外記錄**建立 session 的耗時**（CPU 與 CoreML 兩邊都記；
 * **不參與判準**、不設門檻）：Node 端拿不到 CoreML 的編譯快取，每次啟動第一次使用都要重編，
 * 這個數字就是「那次會不會卡」的直接讀數，供之後決定是否收緊產品行為。
 *
 * 本檔刻意與模型實作解耦：建 session／嵌入／釋放都以回呼注入，因此
 * 判斷與快取生命週期都能在非 macOS 的開發機上完整單元測試。
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { EmbedderSelfTestStatus } from "@mnemoshelf/core";
import { summarizeFailure } from "./device.js";

/**
 * CoreML EP 的旗標：`COREML_FLAG_CREATE_MLPROGRAM`（值 `0x010`）。
 *
 * 為什麼一定要帶：Node 端唯一能調的旋鈕就是這個（其他屬性被綁定層靜默丟棄）。
 * 不帶＝預設的 NeuralNetwork 格式，算子覆蓋更窄**且會隱式把運算轉成 fp16**
 * （直接威脅「換裝置不得改變向量」這條驗收）。
 */
export const COREML_MLPROGRAM_FLAG = 0x010;

/**
 * 自我測試的樣本（≤16 條短字串，含中文）。
 *
 * 為什麼是短字串而不是真實 chunk：這批樣本只用來**比較兩個裝置的相對表現**，
 * 不是品質基準；短字串讓測試成本維持在數秒內（建 session 才是主要成本）。
 * 中英文混合是刻意的：中文的 token 數／字元比較高，pad 行為與英文不同。
 */
export const SELF_TEST_SAMPLES: readonly string[] = [
  "硬體自我測試樣本：本機裝置偵測與向量一致性檢查。",
  "索引、搜尋與記憶管理共用同一組向量。",
  "批次視窗與序列推論的設定會依裝置而不同。",
  "換裝置不得改變既有索引的語意，向量必須一致。",
  "峰值記憶體是這條路徑的安全上限之一。",
  "transport layer security handshake overhead",
  "vector similarity search over local documents",
  "on-device embedding keeps content off the network",
  "hardware acceleration is only adopted after measurement",
  "the decision is cached for the next launch",
  "中文與 English 混在同一份文件裡是常見情況。",
  "程式碼區塊、表格與清單都必須能被索引。",
  "搜尋結果依相似度排序，並附上來源路徑。",
  "本機服務只綁定 127.0.0.1，不對外開放。",
  "診斷資訊不含檔案內容、token 或個資。",
  "自我測試失敗時一律退回 CPU，並記下原因。",
];

/**
 * 量測解析度以下的秒數下限。
 *
 * 時鐘若回報 0 秒（解析度不足、或測試注入固定時鐘），倍率會變成 `Infinity`／`NaN`；
 * 取 1 µs 讓比率保持有限且可比較。真實推論不可能低於這個量級。
 */
const MIN_SECONDS = 1e-6;

/** 自我測試的判準（沿用 dml-bench 的既有原則）。 */
export interface SelfTestCriteria {
  /** 吞吐倍率下限：CoreML 吞吐 ÷ CPU 吞吐。 */
  minThroughputRatio: number;
  /** 向量一致性下限：逐樣本餘弦相似度的最小值。 */
  minCosine: number;
  /** 測試期峰值 RSS 上限（bytes）。 */
  maxPeakRssBytes: number;
}

/**
 * 預設判準：吞吐 ≥ 1.3×、min cos ≥ 0.999、峰值 RSS ≤ 6 GiB。
 *
 * 1.3× 是「值得多養一條裝置路徑」的門檻（低於它，編譯與維護成本都不划算）；
 * 0.999 是「同一份文件不得有兩種向量」的門檻；6 GiB 是 16 GB 機器的安全上限
 * （上游 `#32212` 回報同類模型在 MLProgram 下可達 17 GiB 峰值）。
 */
export const SELF_TEST_CRITERIA: SelfTestCriteria = {
  minThroughputRatio: 1.3,
  minCosine: 0.999,
  maxPeakRssBytes: 6 * 1024 ** 3,
};

/**
 * 失敗原因的穩定短標籤（寫進決定記錄與 `runtimeStatus.selfTest.reason`）。
 *
 * 與 `EmbedderFallbackReason.code` 的分工：記錄裡存的是這組「量測語意」的標籤，
 * 記憶體裡的 `fallbackReason.code` 另外用 `accel-*` 家族（見 `selfTestFallbackCode`），
 * 讓診斷一眼看出「是加速器自我測試擋掉的」而不是別的載入錯誤。
 */
export const SELF_TEST_REASONS = {
  /** 建 CoreML session 失敗。 */
  loadFailed: "load-failed",
  /** 建 CoreML session 成功，但測試中的推論失敗。 */
  inferenceFailed: "inference-failed",
  /** 吞吐倍率未達門檻。 */
  tooSlow: "too-slow",
  /** 向量一致性未達門檻。 */
  inconsistent: "inconsistent",
  /** 測試期峰值 RSS 超限。 */
  memoryExceeded: "memory-exceeded",
  /** 由 `pending` 標記推導：上一次測試讓行程死掉。 */
  crashed: "crashed-during-self-test",
} as const;

/** 失敗原因標籤。 */
export type SelfTestReason = (typeof SELF_TEST_REASONS)[keyof typeof SELF_TEST_REASONS];

/** 決定記錄的 schema 版本（檔案第一個欄位；版本不同一律視為無效並重測）。 */
export const DEVICE_DECISION_SCHEMA = 1;

/** 自我測試在磁碟上的狀態：`pending` 是「測試進行中」的落地標記。 */
export type DeviceDecisionOutcome = "pending" | "usable" | "unusable" | "crashed";

/** 決定記錄的**身分**欄位：任何一項不同＝那次量測不代表現在這個組合。 */
export interface DeviceDecisionIdentity {
  /** 應用程式版本（換版本時重測一次）。 */
  appVersion: string;
  /** 模型 id。 */
  modelId: string;
  /** dtype 標籤（逐元件不同時為組合字串）。 */
  dtype: string;
  /** 平台（`process.platform`）。 */
  platform: string;
  /** CPU 架構（`process.arch`）。 */
  arch: string;
  /** CoreML 旗標（目前固定 `0x010`；改旗標等於換一條路徑，必須重測）。 */
  coreMlFlags: number;
}

/** 持久化的決定記錄（一個平台一份；檔案在模型快取目錄旁）。 */
export interface DeviceDecisionRecord extends DeviceDecisionIdentity {
  /** schema 版本；與 `DEVICE_DECISION_SCHEMA` 不同一律視為無效。 */
  schema: number;
  /** 決定（`pending` 只出現在測試進行中的檔案裡）。 */
  outcome: DeviceDecisionOutcome;
  /** 失敗原因的穩定短標籤；通過時不存在。 */
  reason?: string;
  /** 量測到的吞吐倍率；未量到時不存在。 */
  throughputRatio?: number;
  /** 量測到的向量一致性下限；未量到時不存在。 */
  minCosine?: number;
  /** 建立 CPU session 的耗時（毫秒）；未量到時不存在。 */
  cpuSessionBuildMs?: number;
  /** 建立 CoreML session 的耗時（毫秒）；載入失敗或未量到時不存在。 */
  coreMlSessionBuildMs?: number;
  /** 這次測試（或崩潰的那次測試）的時間（ISO 8601）。 */
  testedAt: string;
}

/** 量測結果（餵給判準的三個數字）。 */
export interface SelfTestMeasurement {
  /** 吞吐倍率（CoreML ÷ CPU，同樣本數）。 */
  throughputRatio: number;
  /** 逐樣本餘弦相似度的最小值。 */
  minCosine: number;
  /** 測試期峰值 RSS（bytes）。 */
  peakRssBytes: number;
}

/**
 * 依判準判斷量測結果。
 *
 * 檢查順序＝嚴重度：**安全 > 正確性 > 效能**。記憶體超限代表這台機器有 OOM 風險
 * （先擋），向量不一致代表資料會靜默劣化（再擋），最後才看划不划算。
 *
 * 邊界語意：**剛好達到門檻即通過**（`>=`／`<=`）。比較式刻意寫成 `!(value >= 門檻)`
 * 而不是 `value < 門檻`，讓 `NaN` 落在「未達」那一邊（量測壞掉不得被當成通過）。
 */
export function evaluateSelfTest(
  measurement: SelfTestMeasurement,
  criteria: SelfTestCriteria = SELF_TEST_CRITERIA,
): { outcome: "usable" | "unusable"; reason?: string } {
  if (!(measurement.peakRssBytes <= criteria.maxPeakRssBytes)) {
    return { outcome: "unusable", reason: SELF_TEST_REASONS.memoryExceeded };
  }
  if (!(measurement.minCosine >= criteria.minCosine)) {
    return { outcome: "unusable", reason: SELF_TEST_REASONS.inconsistent };
  }
  if (!(measurement.throughputRatio >= criteria.minThroughputRatio)) {
    return { outcome: "unusable", reason: SELF_TEST_REASONS.tooSlow };
  }
  return { outcome: "usable" };
}

/** 兩向量的餘弦相似度（取共同長度；兩邊皆為已 L2 正規化的最終向量）。 */
export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < n; i += 1) dot += a[i]! * b[i]!;
  return dot;
}

/** 逐樣本餘弦相似度的最小值；數量不一致時拋錯（呼叫端保證一一對應）。 */
export function minCosineOf(
  a: readonly ArrayLike<number>[],
  b: readonly ArrayLike<number>[],
): number {
  if (a.length !== b.length) {
    throw new Error(`自我測試的向量數不一致：CPU ${a.length} 筆、加速器 ${b.length} 筆`);
  }
  let min = Number.POSITIVE_INFINITY;
  for (let i = 0; i < a.length; i += 1) {
    min = Math.min(min, cosineSimilarity(a[i]!, b[i]!));
  }
  return min;
}

/** 記錄 → 診斷用的摘要（`pending` 推導成 `crashed`；見檔頭）。 */
export function toSelfTestStatus(record: DeviceDecisionRecord): EmbedderSelfTestStatus {
  const crashed = record.outcome === "pending" || record.outcome === "crashed";
  const status: EmbedderSelfTestStatus = {
    outcome: crashed ? "crashed" : record.outcome === "usable" ? "usable" : "unusable",
    reason: crashed ? SELF_TEST_REASONS.crashed : record.reason,
    testedAt: record.testedAt,
  };
  if (record.throughputRatio !== undefined) status.throughputRatio = record.throughputRatio;
  if (record.minCosine !== undefined) status.minCosine = record.minCosine;
  if (record.cpuSessionBuildMs !== undefined) status.cpuSessionBuildMs = record.cpuSessionBuildMs;
  if (record.coreMlSessionBuildMs !== undefined) status.coreMlSessionBuildMs = record.coreMlSessionBuildMs;
  return status;
}

/** 這份記錄是否代表現在這組（模型／dtype／平台／架構／旗標）。 */
export function decisionMatchesIdentity(
  record: DeviceDecisionRecord,
  identity: DeviceDecisionIdentity,
): boolean {
  return (
    record.modelId === identity.modelId &&
    record.dtype === identity.dtype &&
    record.platform === identity.platform &&
    record.arch === identity.arch &&
    record.coreMlFlags === identity.coreMlFlags
  );
}

/**
 * 解析決定記錄的內容（**寬鬆**：任何不對勁一律回 `null`＝當作沒測過、重測一次）。
 *
 * 為什麼寬鬆到底：這個檔案是「上一次執行的殘留」，最壞的情況只是多做一次量測；
 * 誤信壞資料才是真的有害。缺欄位（例如舊格式沒有 `dtype`／`coreMlFlags`）同樣視為無效。
 */
export function parseDecisionRecord(text: string): DeviceDecisionRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const raw = parsed as Record<string, unknown>;

  const stringField = (key: string): string | null => {
    const value = raw[key];
    return typeof value === "string" && value !== "" ? value : null;
  };
  const outcomes: readonly string[] = ["pending", "usable", "unusable", "crashed"];

  if (raw["schema"] !== DEVICE_DECISION_SCHEMA) return null;
  const outcome = stringField("outcome");
  if (outcome === null || !outcomes.includes(outcome)) return null;
  const appVersion = stringField("appVersion");
  const modelId = stringField("modelId");
  const dtype = stringField("dtype");
  const platform = stringField("platform");
  const arch = stringField("arch");
  const testedAt = stringField("testedAt");
  const coreMlFlags = raw["coreMlFlags"];
  if (
    appVersion === null ||
    modelId === null ||
    dtype === null ||
    platform === null ||
    arch === null ||
    testedAt === null ||
    typeof coreMlFlags !== "number"
  ) {
    return null;
  }

  const record: DeviceDecisionRecord = {
    schema: DEVICE_DECISION_SCHEMA,
    outcome: outcome as DeviceDecisionOutcome,
    testedAt,
    appVersion,
    modelId,
    dtype,
    platform,
    arch,
    coreMlFlags,
  };
  const reason = raw["reason"];
  if (typeof reason === "string") record.reason = reason;
  const throughputRatio = raw["throughputRatio"];
  if (typeof throughputRatio === "number") record.throughputRatio = throughputRatio;
  const minCosine = raw["minCosine"];
  if (typeof minCosine === "number") record.minCosine = minCosine;
  const cpuSessionBuildMs = raw["cpuSessionBuildMs"];
  if (typeof cpuSessionBuildMs === "number") record.cpuSessionBuildMs = cpuSessionBuildMs;
  const coreMlSessionBuildMs = raw["coreMlSessionBuildMs"];
  if (typeof coreMlSessionBuildMs === "number") record.coreMlSessionBuildMs = coreMlSessionBuildMs;
  return record;
}

/** 讀取決定記錄；不存在、讀不到或內容無效一律回 `null`（＝重測一次）。 */
export function readDecisionRecord(path: string): DeviceDecisionRecord | null {
  try {
    return parseDecisionRecord(readFileSync(path, "utf8"));
  } catch {
    // 檔案不存在（第一次跑）、權限不足、目錄被刪掉…都只是「沒有可用的決定」。
    return null;
  }
}

/**
 * 原子寫入決定記錄：先寫同目錄的暫存檔再 `rename` 覆蓋，回傳是否寫入成功。
 *
 * 為什麼是原子寫入：這個檔案是「測試進行中」的存活證明。崩潰可能發生在寫入的瞬間，
 * 半截的 JSON 會讓下一次啟動讀到壞資料；`rename` 在同一目錄內是原子操作，
 * 讀者只會看到舊內容或完整的新內容。
 *
 * 為什麼寫不進去不算致命：目錄唯讀（例如共用模型快取）時，這一輪的決定仍在記憶體裡，
 * 只是下次啟動要重測一次。因此回傳布林值，呼叫端不需要為寫入失敗中斷任何流程。
 */
export function writeDecisionRecord(path: string, record: DeviceDecisionRecord): boolean {
  let temp: string | null = null;
  try {
    mkdirSync(dirname(path), { recursive: true });
    temp = `${path}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    renameSync(temp, path);
    return true;
  } catch {
    if (temp !== null) {
      try {
        rmSync(temp, { force: true });
      } catch {
        // 清不掉暫存檔不影響結果（它是唯一的殘留物，且不含任何使用者資料）。
      }
    }
    return false;
  }
}

/**
 * 決定記錄的三種處置。
 *
 * - `test-required`：沒有記錄、身分不符（換模型／dtype／平台／架構／旗標）、
 *   或 `appVersion` 變了 → 必須重測一次。
 * - `crashed`：上一次測試讓行程死掉（`pending` 或已記成 `crashed`）→ **永久不自動重試**。
 *   這一條**刻意不看身分**：崩潰是這台機器（驅動／EP／記憶體）的事實，
 *   換模型不會讓它消失，重試只是再死一次。
 * - `decided`：可用或不可以用，直接沿用（`needsRewrite` 表示檔案裡的 `pending`
 *   還沒被改寫成 `crashed`，呼叫端應補寫）。
 */
export type DecisionClassification =
  | { kind: "test-required" }
  | { kind: "crashed"; status: EmbedderSelfTestStatus; record: DeviceDecisionRecord; needsRewrite: boolean }
  | { kind: "decided"; status: EmbedderSelfTestStatus; record: DeviceDecisionRecord };

/** 依記錄與現在的環境，決定「要不要重測」。 */
export function classifyDecision(
  record: DeviceDecisionRecord | null,
  identity: DeviceDecisionIdentity,
): DecisionClassification {
  if (record === null) return { kind: "test-required" };

  if (record.outcome === "pending" || record.outcome === "crashed") {
    return {
      kind: "crashed",
      status: toSelfTestStatus(record),
      record,
      needsRewrite: record.outcome === "pending",
    };
  }

  if (!decisionMatchesIdentity(record, identity)) return { kind: "test-required" };
  // 換版本時重測一次：量測結果與當時的實作綁在一起（編譯器、EP、我們的載入方式都可能變）。
  if (record.appVersion !== identity.appVersion) return { kind: "test-required" };
  return { kind: "decided", status: toSelfTestStatus(record), record };
}

/** 失敗原因標籤 → 記憶體裡的退回代碼（`accel-*` 家族；讓診斷看得出是加速器自我測試擋的）。 */
export function selfTestFallbackCode(reason: string | undefined): string {
  if (reason === SELF_TEST_REASONS.tooSlow) return "accel-slow";
  if (reason === SELF_TEST_REASONS.inconsistent) return "accel-inconsistent";
  if (reason === SELF_TEST_REASONS.memoryExceeded) return "accel-memory-exceeded";
  if (reason === SELF_TEST_REASONS.crashed) return "accel-crashed";
  if (reason === SELF_TEST_REASONS.inferenceFailed) return "inference-failed";
  return "load-failed";
}

/** 失敗原因標籤 → 人類可讀的短說明（診斷用；不含任何路徑或個資）。 */
export function describeSelfTestReason(reason: string | undefined): string {
  if (reason === SELF_TEST_REASONS.tooSlow) return "加速器沒有明顯較快（吞吐倍率未達 1.3 倍）";
  if (reason === SELF_TEST_REASONS.inconsistent) return "加速器算出的向量與 CPU 不一致（餘弦未達 0.999）";
  if (reason === SELF_TEST_REASONS.memoryExceeded) return "測試期峰值記憶體超過 6 GiB";
  if (reason === SELF_TEST_REASONS.crashed) return "上一次加速器自我測試造成行程結束，已永久改用 CPU";
  if (reason === SELF_TEST_REASONS.inferenceFailed) return "加速器推論失敗，已退回 CPU";
  if (reason === SELF_TEST_REASONS.loadFailed) return "加速器 session 載入失敗，已退回 CPU";
  return "加速器自我測試未通過，已退回 CPU";
}

/** 自我測試需要的（注入式）相依：建 session、嵌入、釋放、時鐘與記憶體讀數。 */
export interface CoreMlSelfTestOptions<TBackend> {
  /** 決定記錄的檔案路徑（呼叫端決定；見 `deviceDecisionPath`）。 */
  decisionPath: string;
  /** 這次量測代表的身分（寫進記錄；讀取時也用來比對）。 */
  identity: DeviceDecisionIdentity;
  /** 建立指定裝置的 session（呼叫端的 `createBackend`）。 */
  createBackend: (device: "cpu" | "coreml") => Promise<TBackend>;
  /** 以該 session 嵌入一批樣本，回傳**最終向量**（已截斷、已 L2 正規化）。 */
  embed: (backend: TBackend, texts: readonly string[]) => Promise<readonly ArrayLike<number>[]>;
  /** 釋放 session（失敗不得往外拋）。 */
  disposeBackend: (backend: TBackend) => Promise<void>;
  /** 樣本（預設 `SELF_TEST_SAMPLES`）。 */
  samples?: readonly string[];
  /** 判準（預設 `SELF_TEST_CRITERIA`）。 */
  criteria?: SelfTestCriteria;
  /** 單調時鐘（毫秒；測試注入用）。 */
  now?: () => number;
  /** RSS 讀數（bytes；測試注入用）。 */
  readRss?: () => number;
  /** 時間戳（ISO 8601；測試注入用）。 */
  nowIso?: () => string;
}

/** 自我測試的結果：決定本身，以及「判定可用時」可以直接沿用的 session。 */
export interface CoreMlSelfTestResult<TBackend> {
  /** 已寫入磁碟（或嘗試寫入）的決定記錄。 */
  record: DeviceDecisionRecord;
  /**
   * 判定可用時＝測試中已建好的 CoreML session（呼叫端直接沿用，**不必重編**）；
   * 不可用時＝`null`（已釋放）。
   */
  backend: TBackend | null;
  /**
   * 失敗的**已去識別化**摘要（錯誤名稱＋訊息首行、家目錄遮罩、長度上限）。
   *
   * 只放在回傳值裡、**不寫進磁碟**：診斷要能當場看到「CoreML 是怎麼失敗的」，
   * 但決定記錄只存穩定短標籤（重啟後由呼叫端用人類可讀的通用說明呈現）。
   */
  message?: string;
}

/** 釋放 session，失敗只吞掉（session 會隨行程結束回收；不能因為釋放失敗讓載入失敗）。 */
async function disposeQuietly<TBackend>(
  dispose: (backend: TBackend) => Promise<void>,
  backend: TBackend,
): Promise<void> {
  try {
    await dispose(backend);
  } catch {
    // 見上方說明：釋放失敗不是致命錯誤。
  }
}

/**
 * 跑一次「CPU 基準 vs CoreML」的自我測試，落地 `pending` 標記後再寫最終決定。
 *
 * 流程（順序刻意如此）：
 *   1. 先寫 `pending`（**在任何有風險的動作之前**：CPU 階段若也炸掉，同樣要留痕）。
 *   2. 量 CPU（暖機一次再計時；兩邊用完全相同的樣本與協定）。
 *   3. 量 CoreML（建 session 是主要成本；失敗→`load-failed`、推論失敗→`inference-failed`）。
 *   4. 依判準寫下最終記錄。
 *
 * 為什麼 CPU 先、CoreML 後：兩邊**不同時常駐**（16 GB 機器的峰值會被兩份模型污染，
 * 這也是研究筆記的明確建議），而 CoreML 的編譯是唯一昂貴的載入成本——
 * 排在後面才能「判定可用就直接沿用那個 session」，任何分支都只編譯一次。
 *
 * 暖機為什麼必須做：CoreML 的第一次 `predict` 會 **block 等編譯完成**（研究 F5），
 * 不暖機量到的會是「編譯時間」而不是「推論吞吐」。兩邊都暖機，比較才公平。
 *
 * CPU 基準載入失敗會**往上拋**（沒有 CPU 就沒有可退的地方，呼叫端本來就該失敗）；
 * 呼叫端應在拋出前把 `pending` 改寫成 `unusable`／`load-failed`，免得被誤記成崩潰。
 */
export async function runCoreMlSelfTest<TBackend>(
  options: CoreMlSelfTestOptions<TBackend>,
): Promise<CoreMlSelfTestResult<TBackend>> {
  const samples = options.samples ?? SELF_TEST_SAMPLES;
  const criteria = options.criteria ?? SELF_TEST_CRITERIA;
  const now = options.now ?? ((): number => performance.now());
  const readRss = options.readRss ?? ((): number => process.memoryUsage.rss());
  const nowIso = options.nowIso ?? ((): string => new Date().toISOString());

  // 1. `pending`：這是「測試中」的存活證明（崩潰後由下一次啟動推導成 `crashed`）。
  writeDecisionRecord(options.decisionPath, {
    schema: DEVICE_DECISION_SCHEMA,
    ...options.identity,
    outcome: "pending",
    testedAt: nowIso(),
  });

  let peakRssBytes = readRss();
  const sampleRss = (): void => {
    peakRssBytes = Math.max(peakRssBytes, readRss());
  };

  /** 暖機一次再計時，回傳耗時（秒）與該次的最終向量。 */
  const measure = async (backend: TBackend): Promise<{ seconds: number; vectors: readonly ArrayLike<number>[] }> => {
    await options.embed(backend, samples);
    sampleRss();
    const startedAt = now();
    const vectors = await options.embed(backend, samples);
    const seconds = (now() - startedAt) / 1000;
    sampleRss();
    return { seconds, vectors };
  };

  // 2. CPU 基準：先量，量完立刻釋放（不與 CoreML 同時常駐）。
  const cpuBuildStartedAt = now();
  const cpuBackend = await options.createBackend("cpu");
  // 建 session 的耗時（診斷數據，**不參與判準**）：Node 端拿不到 CoreML 的編譯快取
  // （`ModelCacheDirectory` 在綁定層被丟棄），因此每次啟動第一次使用都會重編；
  // 這個數字就是「那次會不會卡」的直接讀數。
  const cpuSessionBuildMs = now() - cpuBuildStartedAt;
  let cpuSeconds: number;
  let cpuVectors: readonly ArrayLike<number>[];
  try {
    sampleRss();
    const measured = await measure(cpuBackend);
    cpuSeconds = measured.seconds;
    cpuVectors = measured.vectors;
  } finally {
    await disposeQuietly(options.disposeBackend, cpuBackend);
  }

  // 3. CoreML。
  let throughputRatio: number | undefined;
  let minCosine: number | undefined;
  let coreMlSessionBuildMs: number | undefined;
  let coreMlBackend: TBackend | null = null;
  let failureMessage: string | undefined;
  let decision: { outcome: "usable" | "unusable"; reason?: string };

  try {
    const coreMlBuildStartedAt = now();
    coreMlBackend = await options.createBackend("coreml");
    coreMlSessionBuildMs = now() - coreMlBuildStartedAt;
    sampleRss();
    const measured = await measure(coreMlBackend);
    throughputRatio = Math.max(cpuSeconds, MIN_SECONDS) / Math.max(measured.seconds, MIN_SECONDS);
    minCosine = minOf(cpuVectors, measured.vectors);
    decision = evaluateSelfTest({ throughputRatio, minCosine, peakRssBytes }, criteria);
  } catch (error) {
    // 建 session 失敗與「建得起來但推論失敗」在診斷上要分得開。
    const loadFailed = coreMlBackend === null;
    decision = {
      outcome: "unusable",
      reason: loadFailed ? SELF_TEST_REASONS.loadFailed : SELF_TEST_REASONS.inferenceFailed,
    };
    failureMessage = summarizeFailure(error);
    if (loadFailed) {
      throughputRatio = undefined;
      // 載入失敗就沒有「建好」的 session，因此不記建置耗時（避免欄位語意與名稱不符）。
      coreMlSessionBuildMs = undefined;
    }
  }

  if (decision.outcome !== "usable" && coreMlBackend !== null) {
    await disposeQuietly(options.disposeBackend, coreMlBackend);
    coreMlBackend = null;
  }

  const record: DeviceDecisionRecord = {
    schema: DEVICE_DECISION_SCHEMA,
    ...options.identity,
    outcome: decision.outcome,
    testedAt: nowIso(),
  };
  if (decision.reason !== undefined) record.reason = decision.reason;
  if (throughputRatio !== undefined) record.throughputRatio = throughputRatio;
  if (minCosine !== undefined) record.minCosine = minCosine;
  record.cpuSessionBuildMs = cpuSessionBuildMs;
  if (coreMlSessionBuildMs !== undefined) record.coreMlSessionBuildMs = coreMlSessionBuildMs;
  writeDecisionRecord(options.decisionPath, record);

  const result: CoreMlSelfTestResult<TBackend> = {
    record,
    backend: decision.outcome === "usable" ? coreMlBackend : null,
  };
  if (failureMessage !== undefined) result.message = failureMessage;
  return result;
}

/** 逐樣本餘弦的最小值；數量不一致時視為量測失敗（`NaN` → 判準會判未達）。 */
function minOf(a: readonly ArrayLike<number>[], b: readonly ArrayLike<number>[]): number {
  try {
    return minCosineOf(a, b);
  } catch {
    return Number.NaN;
  }
}
