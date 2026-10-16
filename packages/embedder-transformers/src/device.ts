/**
 * 嵌入執行裝置（device）的解析：裝置選項、批次視窗與自動退回的共用邏輯。
 *
 * 依據（2026-10-16 查核與實測）：
 *   - DirectML 只在 Windows x64／arm64 有預建二進位（`onnxruntime-node@1.30.0` 的
 *     `bin/napi-v6/win32/*` 帶 `DirectML.dll`）。
 *   - CoreML EP 只在 macOS 的預建二進位內（同版本的 `darwin/arm64` 帶 `USE_COREML`；
 *     transformers.js 4.3.1 也把 `coreml` 列進 darwin 的 `supportedDevices`）。
 *   - dml-bench 實測（`spikes/dml-bench`，在使用者 Windows 機器上跑）：DML 在 batch 32 最快
 *     （11.07 塊/s vs CPU batch 16 的 3.27 塊/s），向量與 CPU 的餘弦為 1.0。
 *   - DML 同一 session 不可並發 `Run`（onnxruntime 的 DirectML EP 官方文件）
 *     → `serializedInference` 為 true，索引器與 embedder 本身都會據此序列化。
 *   - 換 device 不會改變 `info.id`（只吃 model id 與 dtype 標籤）→ 既有索引不需重建。
 *
 * 平台的取捨：`auto` 只在「有預建二進位的那個平台」挑加速器（win32→dml、darwin→coreml），
 * 其他平台維持 CPU；**Windows 的既有行為完全不動**（新增的只有 darwin 這一條）。
 */
import { homedir } from "node:os";
import type { EmbedderFallbackReason } from "@mnemoshelf/core";
import { InvalidEmbedderOptionError } from "./errors.js";

/** 覆寫裝置的環境變數（值：`auto`／`cpu`／`dml`／`coreml`）。 */
export const EMBED_DEVICE_ENV = "MNEMOSHELF_EMBED_DEVICE";

/** 覆寫 DirectML adapter 索引的環境變數（非負整數，0＝預設顯示卡）。 */
export const EMBED_DML_DEVICE_ID_ENV = "MNEMOSHELF_EMBED_DML_DEVICE_ID";

/**
 * 覆寫 ONNX Runtime log 等級的環境變數（`0`–`4`；未設定＝不覆寫）。
 *
 * 診斷用途：`0`（verbose）會印出 ORT 內部的配置訊息，包括 arena 的每一次擴張
 * （`Extending BFCArena … num_bytes: N`），是「單一配置到底多大」唯一的直接讀數。
 * **不要預設開啟**：verbose 會印出完整的 graph 資訊，量大且會拖慢啟動。
 */
export const EMBED_ORT_LOG_ENV = "MNEMOSHELF_EMBED_ORT_LOG";

/** ONNX Runtime 的 log 等級（0＝verbose、1＝info、2＝warning、3＝error、4＝fatal）。 */
export type OrtLogSeverityLevel = 0 | 1 | 2 | 3 | 4;

/** 支援的 ORT log 等級（解析與錯誤訊息共用同一份清單）。 */
export const ORT_LOG_SEVERITY_LEVELS: readonly OrtLogSeverityLevel[] = [0, 1, 2, 3, 4];

/**
 * 解析 ORT log 等級。未設定或空字串 → `undefined`（不覆寫 ORT 預設，由 transformers.js 決定）；
 * 其他無法識別的值一律拋錯（與 `MNEMOSHELF_EMBED_DEVICE`／`MNEMOSHELF_EMBED_DML_DEVICE_ID`
 * 同一個「非法值不靜默回預設」的慣例）。
 */
export function parseOrtLogLevel(value: string | undefined): OrtLogSeverityLevel | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const trimmed = value.trim();
  if (!ORT_LOG_SEVERITY_LEVELS.some((level) => String(level) === trimmed)) {
    throw new InvalidEmbedderOptionError(
      "ortLogLevel",
      value,
      `只接受 ${ORT_LOG_SEVERITY_LEVELS.join("／")}（0＝verbose…4＝fatal；可經環境變數 ${EMBED_ORT_LOG_ENV} 設定）`,
    );
  }
  return Number(trimmed) as OrtLogSeverityLevel;
}

/** DirectML adapter 索引的預設值（0＝預設顯示卡；`IDXGIFactory::EnumAdapters` 的順序）。 */
export const DEFAULT_DML_DEVICE_ID = 0;

/**
 * 嵌入執行裝置。
 *
 * - `cpu`：所有平台都有。
 * - `dml`：DirectML（**只有 Windows x64／arm64 有預建二進位**）。
 * - `coreml`：CoreML EP（**只有 macOS 的 onnxruntime 預編二進位內建**；需通過內建自我測試
 *   才會自動採用，見 `self-test.ts`）。
 */
export type EmbedDevice = "cpu" | "dml" | "coreml";

/** 裝置選項：`auto` 表示依平台自動決定。 */
export type EmbedDeviceOption = EmbedDevice | "auto";

/** 支援的裝置選項（解析與錯誤訊息共用同一份清單）。 */
export const EMBED_DEVICE_OPTIONS: readonly EmbedDeviceOption[] = ["auto", "cpu", "dml", "coreml"];

/**
 * CPU 的批次視窗上限。
 *
 * 取值理由：批次會把同批文字 pad 到同批最長序列；批次愈大，pad 成本與記憶體愈高
 * （大量圖片批次曾把 RSS 推到數 GiB）。本專案的 chunk 是 600–1200 字元
 * （約 150–300 token），pad 成本相對小，取 16 作為「一次 forward 吃最多塊、
 * 又不會讓記憶體失控」的折衷。
 */
export const CPU_BATCH_SIZE = 16;

/** DirectML 的批次視窗上限；來源：dml-bench 實測（batch 32 最快，8／16／64 都較差）。 */
export const DML_BATCH_SIZE = 32;

/**
 * 單一推論視窗的 **prompt token 總量**上限（batch × 序列長度，含 padding）。
 *
 * 為什麼需要：推論時的單一配置大小隨「一窗的 token 總量」成長，而底層配置器對單一配置
 * 有硬上限——Chromium 的 PartitionAlloc 刻意把 `MaxAllocationSize()` 設在 2 GiB 以下並
 * **直接終止行程**（`PA_IMMEDIATE_CRASH`）。ONNX Runtime 的 CPU arena 更會把 chunk 以
 * 2 的冪次往上翻（上限 1 GiB），因此一次超過 1 GiB 的請求會變成 ≥2 GiB 的單一配置，
 * 在 Electron 內就是整個 app 閃退。實測（同一顆模型、16 塊中文一批）：一窗約 8k token 的
 * 最大單一配置請求約 0.3 GB，約 14k token 時約 0.7 GB。
 *
 * 取值 8192：取在實測安全區之下並留有餘裕（約 8k token ≈ 0.3 GB，離 1 GiB 的翻倍門檻
 * 還有 3 倍以上）。純英文的既有工作負載遠低於此值（1200 字元 ≈ 270 token，
 * 16 塊 ≈ 4.3k），不受影響。
 *
 * 這個上限只縮小「一窗幾個輸入」——`embedDocuments` 的輸出必須與輸入一一對應，
 * 因此**不切分單一輸入**（單塊的長度上限在切塊端，見 core 的 `CHUNK_MAX_TOKENS`）。
 */
export const BATCH_TOKEN_BUDGET = 8192;

/** 退回原因訊息的字數上限（診斷輸出不宜過長）。 */
export const FALLBACK_MESSAGE_MAX_CHARS = 200;

/**
 * 解析裝置選項。未設定或空字串視為 `auto`；其他無法識別的值一律拋錯。
 *
 * 值可能來自建構子選項或環境變數，因此錯誤訊息一併說明兩個來源。
 */
export function parseEmbedDeviceOption(value: string | undefined): EmbedDeviceOption {
  if (value === undefined || value.trim() === "") return "auto";
  const normalized = value.trim().toLowerCase();
  if ((EMBED_DEVICE_OPTIONS as readonly string[]).includes(normalized)) {
    return normalized as EmbedDeviceOption;
  }
  throw new InvalidEmbedderOptionError(
    "device",
    value,
    `只接受 ${EMBED_DEVICE_OPTIONS.join("／")}（可經建構子選項或環境變數 ${EMBED_DEVICE_ENV} 設定）`,
  );
}

/** DirectML 是否為這個平台的可用選項（只有 Windows 有預建二進位）。 */
export function isDmlPlatform(platform: string): boolean {
  return platform === "win32";
}

/**
 * CoreML 是否為這個平台的可用選項（只有 macOS 的預編二進位內建 CoreML EP）。
 *
 * 依據（研究筆記 F1，2026-10-16 查核）：`onnxruntime-node@1.30.0` 的 darwin-arm64 二進位
 * 帶 `USE_COREML`，binding 內有 `ListSupportedBackends`／`coreMlFlags` 等符號；
 * transformers.js 4.3.1 也把 `coreml` 列進 darwin 的 `supportedDevices`。
 * 其他平台（含 Windows、Linux）**不得**嘗試：`device:"coreml"` 在非 darwin 會直接被
 * transformers.js 拒絕（`Unsupported device`）。
 */
export function isCoreMlPlatform(platform: string): boolean {
  return platform === "darwin";
}

/**
 * 解析 DirectML adapter 索引。
 *
 * 未設定或空字串 → `0`（預設顯示卡）。只接受十進位非負整數字串：
 * `"0x1"`、`"1e2"`、`"1.5"`、`"-1"`、超出安全整數範圍者一律拋錯（與
 * `MNEMOSHELF_EMBED_DEVICE` 同一個「非法值就拋錯」慣例，不靜默回預設）。
 */
export function parseDmlDeviceId(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return DEFAULT_DML_DEVICE_ID;
  const trimmed = value.trim();
  if (!/^[0-9]+$/.test(trimmed)) {
    throw new InvalidEmbedderOptionError(
      "dmlDeviceId",
      value,
      `必須是十進位非負整數（0＝預設顯示卡；可經環境變數 ${EMBED_DML_DEVICE_ID_ENV} 設定）`,
    );
  }
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed)) {
    throw new InvalidEmbedderOptionError(
      "dmlDeviceId",
      value,
      `超出可表示的整數範圍（環境變數 ${EMBED_DML_DEVICE_ID_ENV}）`,
    );
  }
  return parsed;
}

/** 裝置解析的結果：要用的裝置，以及一開始就知道的退回原因。 */
export interface EmbedDevicePlan {
  /** 實際要使用的裝置（非 Windows 平台上不可能得到 `dml`；非 macOS 不可能得到 `coreml`）。 */
  device: EmbedDevice;
  /** 立即成立的退回原因（例如明確要求 `dml` 但平台不支援）；沒有時為 `null`。 */
  fallbackReason: EmbedderFallbackReason | null;
}

/**
 * 依裝置選項與平台解析要用的裝置。
 *
 * - `cpu`：一律 CPU（維持現狀）。
 * - `auto`：依平台挑一個加速器——`win32` → `dml`（**既有行為，不動**）、
 *   `darwin` → `coreml`（新；實際採不採用由內建自我測試決定，見 `self-test.ts`）、
 *   其他 → `cpu`。挑不到加速器**不算退回**（沒有失敗發生）。
 * - `dml`：Windows 上嘗試 `dml`；其他平台直接以 `cpu` 開始並註明原因（不必白費一次載入）。
 * - `coreml`：macOS 上嘗試 `coreml`；其他平台直接以 `cpu` 開始並註明原因。
 *   明示 `coreml` 的語意是「**使用者自負的強制嘗試**」：忽略自我測試快取、不寫回快取。
 */
export function resolveEmbedDevice(option: EmbedDeviceOption, platform: string): EmbedDevicePlan {
  if (option === "cpu") return { device: "cpu", fallbackReason: null };
  if (option === "auto") {
    if (isDmlPlatform(platform)) return { device: "dml", fallbackReason: null };
    if (isCoreMlPlatform(platform)) return { device: "coreml", fallbackReason: null };
    return { device: "cpu", fallbackReason: null };
  }
  if (option === "dml") {
    if (isDmlPlatform(platform)) return { device: "dml", fallbackReason: null };
    return {
      device: "cpu",
      fallbackReason: {
        code: "unsupported-platform",
        message: `DirectML 只在 Windows 提供（目前平台 ${platform}）`,
      },
    };
  }
  if (isCoreMlPlatform(platform)) return { device: "coreml", fallbackReason: null };
  return {
    device: "cpu",
    fallbackReason: {
      code: "unsupported-platform",
      message: `CoreML 只在 macOS 提供（目前平台 ${platform}）`,
    },
  };
}

/**
 * 裝置對應的批次視窗大小。
 *
 * CoreML 沿用 CPU 的 16：CoreML EP 收下的節點只是模型中段的小區塊（主算子 `MatMulNBits`
 * 不被支援），區塊邊界要付 marshal 成本，放大批次只會放大每次往返的搬運量；
 * 沒有實測證據支持更大或更小的值，因此先保守沿用（見研究筆記 I1／I2）。
 */
export function deviceBatchSize(device: EmbedDevice): number {
  if (device === "dml") return DML_BATCH_SIZE;
  return CPU_BATCH_SIZE;
}

/**
 * 這個裝置是否要求序列推論（同一 session 一次只能 `Run`）。
 *
 * CoreML 與 DirectML 同屬「多個 EP 分區」的裝置：同一 session 的並發 `Run` 對分區間的
 * 邊界搬運沒有好處，且與 DML 共用同一條序列化骨架最單純（先保守，未實測前不改）。
 */
export function requiresSerializedInference(device: EmbedDevice): boolean {
  return device === "dml" || device === "coreml";
}

/**
 * 把底層錯誤縮成可安全輸出的短說明：錯誤名稱＋訊息首行、遮掉家目錄前綴、限制長度。
 *
 * 為什麼要自己處理：`GET /diagnostics` 會原樣輸出這個字串，而底層錯誤（模型下載、
 * ORT 載入）常帶本機絕對路徑；REST 層只遮「以家目錄開頭」的字串，訊息中段的
 * 家目錄不會被遮到（見 `maskDiagnostics`）。
 */
export function summarizeFailure(error: unknown, homeDir: string = homedir()): string {
  const name = error instanceof Error && error.name !== "" ? error.name : "Error";
  const raw = error instanceof Error ? error.message : String(error);
  const firstLine = raw.split(/\r?\n/, 1)[0] ?? "";
  const masked = homeDir !== "" ? firstLine.split(homeDir).join("~") : firstLine;
  const trimmed = masked.trim();
  const clipped =
    trimmed.length > FALLBACK_MESSAGE_MAX_CHARS
      ? `${trimmed.slice(0, FALLBACK_MESSAGE_MAX_CHARS)}…`
      : trimmed;
  return `${name}: ${clipped}`;
}
