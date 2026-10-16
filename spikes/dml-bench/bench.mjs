/**
 * Mnemoshelf spike：DirectML（GPU）vs CPU 的文字嵌入基準。
 *
 * 目的（一次性量測工具，不進產品碼）：
 *   1. 在同一台機器上比較 `device:"cpu"` 與 `device:"dml"` 的嵌入吞吐（塊/s、每塊 ms）。
 *   2. 量批次效應（8／16／32／64）與**首次載入**、**首次 shape 建立**的固定成本。
 *   3. 量 CPU 與 DML 對**同一批輸入**的向量餘弦（判定閾值 0.999）。
 *   4. DML 失敗（平台／驅動／算子／下載）時給出明確訊息與建議，不讓程式崩潰。
 *
 * 為什麼要對齊 App：
 *   - 模型 id、dtype（q4）、文件 prefix、512 維截斷後重新 L2 正規化，全部與
 *     `packages/embedder-transformers/src/embedder.ts` 相同，數字才能與 App 比較。
 *   - 依賴版本與 App 相同：`@huggingface/transformers@4.3.1`＋`onnxruntime-node@1.30.0`
 *     （見 `packages/embedder-transformers/package.json` 與 4.3.1 的 dependencies）。
 *
 * 本檔用到的官方依據（2026-10-16 查核；來源為官方文件與套件原始碼）：
 *   - onnxruntime-node 1.30.0 `README.md` 支援表：DirectML 只有 Windows x64／arm64 有預建
 *     二進位（`bin/napi-v6/win32/x64/DirectML.dll` 隨套件附上）。
 *   - onnxruntime-node `dist/backend.d.ts`：`listSupportedBackends(): { name, bundled }[]`。
 *   - onnxruntime JS API（`InferenceSession.DmlExecutionProviderOption`）：`{ name:"dml", deviceId:0 }`，
 *     deviceId 對應 `IDXGIFactory::EnumAdapters` 的順序，0＝預設顯示卡。
 *   - transformers.js 4.3.1 `src/backends/onnx.js`：win32 才把 `'dml'` 放進 `supportedDevices`，
 *     `DEVICE_TO_EXECUTION_PROVIDER_MAPPING.dml = 'dml'`；`src/models/session.js` 以
 *     `session_options.executionProviders ??=` 保留使用者指定的 EP 清單（所以 `device` 與
 *     `session_options.executionProviders` 可並用）。
 *   - DirectML EP 官方文件：不支援 memory pattern 與平行執行 → ORT core 會自動調整，不需要
 *     使用者手動處理；同一 session 不支援多執行緒同時 `Run`（索引端因此要 concurrency=1）。
 *   - transformers.js 4.3.1 `processing_embedding_gemma2.js`：批次一律 pad 到窗內最長，
 *     所以同批長度變異會浪費算力（本工具會同時報「pad 後的 token 數」與「真實 token 數」）。
 *
 * 用法：
 *   node bench.mjs --quick                 # 只快檢環境與 DirectML 可用性（不載模型）
 *   node bench.mjs --device cpu            # CPU 基準（batch 16、256 塊）
 *   node bench.mjs --device dml            # DML（batch 8/16/32/64）＋與 CPU 的一致性
 *   node bench.mjs                         # = --device cpu,dml（完整）
 *   node bench.mjs --device cpu,cpu        # 同一裝置跑兩次：餘弦噪音基準
 *   node bench.mjs --help
 *
 * 輸出：console 摘要 ＋ `dml-bench-report.json`（--quick 時為 `dml-bench-report.quick.json`）。
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SPIKE_ROOT = import.meta.dirname;
const TOOL_NAME = "mnemoshelf-dml-bench";
const TOOL_VERSION = "0.1.0";

/** 與 App 相同的模型與輸出設定（見檔案開頭說明）。 */
const MODEL_ID = "onnx-community/embeddinggemma-2-ONNX";
const OUTPUT_DIM = 512;
const DTYPE = { model: "q4" };
const COSINE_THRESHOLD = 0.999;

const DEFAULT_CACHE_DIR = path.join(SPIKE_ROOT, ".cache", "models");
const DEFAULT_OUT = path.join(SPIKE_ROOT, "dml-bench-report.json");
const DEFAULT_QUICK_OUT = path.join(SPIKE_ROOT, "dml-bench-report.quick.json");

/** 文件 prefix，與 `embedder.ts` 的 `documentPrefix` 相同（bench 的塊都沒有標題 → "none"）。 */
const documentPrefix = (text, title = "none") => `title: ${title} | text: ${text}`;

// ---------------------------------------------------------------------------
// 合成語料（決定性；不含任何使用者檔案內容）
// ---------------------------------------------------------------------------

const ZH_TOPICS = [
  "這份文件", "索引服務", "嵌入模型", "向量資料庫", "掃描模組",
  "使用者介面", "背景工作", "錯誤處理", "設定檔", "快取層",
  "搜尋路徑", "統計報表",
];
const ZH_ACTIONS = [
  "記錄了", "描述了", "說明了", "驗證了", "追蹤了",
  "整理了", "比較了", "釐清了", "保留了", "簡化了",
];
const ZH_DETAILS = [
  "在本機執行的設計取捨與後續維護事項，並註明尚未驗證的假設。",
  "在批次處理時的記憶體用量與可接受的延遲上限。",
  "每一次執行的耗時分布，以及與前一次基準的差異。",
  "失敗情況下的退回路徑，確保服務仍可正常運作。",
  "路徑驗證的實作細節，避免符號連結逃逸出根目錄。",
  "增量索引的判定條件，以及內容變更後的重新嵌入策略。",
  "使用者按下取消之後的清理流程與狀態機轉移。",
  "跨平台差異：分隔符號、權限、以及檔案名稱的編碼問題。",
  "預估模型與實際量測之間的落差來源。",
  "以合成資料重現問題的最短步驟。",
];

const EN_SUBJECTS = [
  "The indexing service", "The embedder", "The vector store", "The scan step",
  "The background job", "The settings panel", "The progress reporter", "The cache layer",
  "The chunker", "The retrieval probe",
];
const EN_VERBS = [
  "records", "describes", "validates", "tracks", "summarizes",
  "compares", "clarifies", "keeps", "simplifies", "reports",
];
const EN_OBJECTS = [
  "the trade-offs made for a local-first application and the open questions that remain.",
  "memory usage during batch processing and the acceptable latency ceiling.",
  "the duration distribution of each run against the previous baseline.",
  "the fallback path when inference fails so the service keeps working.",
  "the path guard details that prevent symlink escapes from a configured root.",
  "the incremental decision rules and the re-embedding strategy after edits.",
  "the cleanup flow after a cancel request and the state machine transitions.",
  "cross-platform differences in separators, permissions and filename encoding.",
  "the gap between the estimated model and the measured numbers.",
  "a reproducible minimum set of steps using synthetic data only.",
];

const CODE_TEMPLATES = [
  "for (let i = 0; i < window.length; i += 1) { results.push(await run(window[i])); }",
  "const session = await InferenceSession.create(modelPath, { executionProviders: [\"cpu\"] });",
  "if (!Number.isFinite(value) || value === 0) return { ok: false, reason: \"invalid\" };",
  "export interface Embedder { embedDocuments(inputs: readonly DocumentInput[]): Promise<Float32Array[]>; }",
  "const bytes = Buffer.byteLength(text, \"utf8\"); // 中文一字約 3 bytes",
  "try { await embed(batch); } catch (error) { logger.warn(error.message); throw error; }",
  "const normalised = l2normalize(vector.slice(0, dim));",
  "CREATE INDEX IF NOT EXISTS idx_chunks_path ON chunks(path, chunk_index);",
];

/** 決定性 PRNG（mulberry32）：任何機器、同一 seed 都產生同一份語料。 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const byteLength = (text) => Buffer.byteLength(text, "utf8");

/**
 * 產生合成塊：中英混合、每塊約 `targetBytes` 個 UTF-8 位元組（到量就停，容許 ±5%）。
 * 每塊依索引輪替四種樣貌（純中文／純英文／混排／程式碼），貼近 App 的實際混合。
 */
function buildCorpus({ count, seed, targetBytes }) {
  const rng = mulberry32(seed);
  const pick = (list) => list[Math.floor(rng() * list.length)];
  const profiles = ["zh", "en", "mixed", "code"];
  const chunks = [];

  for (let index = 0; index < count; index += 1) {
    const profile = profiles[index % profiles.length];
    const parts = [];
    let bytes = 0;
    let guard = 0;
    while (bytes < targetBytes && guard < 200) {
      guard += 1;
      let piece;
      if (profile === "zh") piece = `${pick(ZH_TOPICS)}${pick(ZH_ACTIONS)}${pick(ZH_DETAILS)}`;
      else if (profile === "en") piece = `${pick(EN_SUBJECTS)} ${pick(EN_VERBS)} ${pick(EN_OBJECTS)}`;
      else if (profile === "code") piece = pick(CODE_TEMPLATES);
      else piece = rng() < 0.5 ? `${pick(ZH_TOPICS)}${pick(ZH_ACTIONS)}${pick(ZH_DETAILS)}` : `${pick(EN_SUBJECTS)} ${pick(EN_VERBS)} ${pick(EN_OBJECTS)}`;
      parts.push(piece);
      bytes = byteLength(parts.join(" "));
    }
    // 收尾：以「整個句子」為單位回退到 ±5% 內，避免把句子切半（塊大小因此落在 0.9–1.05×target）。
    while (parts.length > 1 && bytes > targetBytes * 1.05) {
      parts.pop();
      bytes = byteLength(parts.join(" "));
    }
    const text = parts.join(" ");
    chunks.push({ id: `c${String(index).padStart(4, "0")}`, profile, text, bytes: byteLength(text), chars: text.length });
  }
  return chunks;
}

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const corpusHash = (chunks) => sha256(chunks.map((chunk) => chunk.text).join("\u0000"));

// ---------------------------------------------------------------------------
// 向量工具（與 App 的 `src/vector.ts` 語意相同：截斷後重新 L2 正規化）
// ---------------------------------------------------------------------------

function l2normalize(vector) {
  let sum = 0;
  for (const value of vector) sum += value * value;
  const norm = Math.sqrt(sum);
  if (!Number.isFinite(norm) || norm === 0) return vector.slice();
  return vector.map((value) => value / norm);
}

const truncateAndNormalize = (vector, dim) => l2normalize(vector.slice(0, dim));

function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? Number.NaN : dot / denom;
}

function vectorStats(vector) {
  let nan = 0;
  let zeros = 0;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let squared = 0;
  for (const value of vector) {
    if (Number.isNaN(value)) nan += 1;
    if (value === 0) zeros += 1;
    if (value < min) min = value;
    if (value > max) max = value;
    squared += value * value;
  }
  return { dim: vector.length, nan, zeros, min: round(min), max: round(max), l2: round(Math.sqrt(squared)) };
}

const round = (value, digits = 6) => (Number.isFinite(value) ? Number(value.toFixed(digits)) : null);
const ms = (value) => Number(value.toFixed(1));
const mib = (bytes) => Number((bytes / 1024 / 1024).toFixed(1));
const perSecond = (count, wallMs) => (wallMs > 0 ? Number(((count / wallMs) * 1000).toFixed(3)) : null);

function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

// ---------------------------------------------------------------------------
// 路徑淨化：報告檔不得含本機絕對路徑（含個人帳號層）
// ---------------------------------------------------------------------------

function displayPath(target) {
  if (!target) return null;
  const resolved = path.resolve(target);
  const relativeToSpike = path.relative(SPIKE_ROOT, resolved);
  if (relativeToSpike === "") return "<spike>";
  if (!relativeToSpike.startsWith("..") && !path.isAbsolute(relativeToSpike)) {
    return `<spike>/${relativeToSpike.split(path.sep).join("/")}`;
  }
  const home = os.homedir();
  const relativeToHome = path.relative(home, resolved);
  if (relativeToHome !== "" && !relativeToHome.startsWith("..") && !path.isAbsolute(relativeToHome)) {
    return `~/${relativeToHome.split(path.sep).join("/")}`;
  }
  return `<外部路徑>/${path.basename(resolved)}`;
}

function dirSizeBytes(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) {
        try {
          total += fs.statSync(full).size;
        } catch {
          /* 讀不到就跳過（快取目錄可能有暫時檔案） */
        }
      }
    }
  }
  return total;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `
Mnemoshelf spike：DirectML vs CPU 嵌入基準

用法：node bench.mjs [選項]

選項：
  --quick                只做環境快檢（Node／ORT 後端／DirectML 可用性），不載入模型
  --device <清單>        要量的裝置，逗號分隔。"both" = cpu,dml（預設）
                         cpu,dml    完整：CPU 基準 → DML 批次 → 一致性
                         cpu        只量 CPU
                         dml        只量 DML＋與 CPU 的一致性
                         cpu,cpu    同一裝置跑兩次（量餘弦的噪音基準）
  --batch <n>            CPU 段與一致性段的批次大小（預設 16，與 App 相同）
  --chunks <n>           CPU 段總塊數（預設 256）
  --dml-batches <清單>   DML 要試的批次大小（預設 8,16,32,64）
  --consistency <n>      一致性比對用的塊數（預設 32；0 = 不做）
  --cosine-threshold <x> 一致性判定閾值（預設 0.999）
  --seed <n>             語料種子（預設 20261016）
  --chunk-bytes <n>      每塊目標位元組數（預設 900）
  --cache <dir>          模型快取目錄（預設 <spike>/.cache/models；可指向 App 已下載的目錄）
  --dml-device-id <n>    DirectML adapter 索引（預設 0＝預設顯示卡）
  --ort-verbose          開 ORT verbose log（可看到節點被分到哪個 EP；輸出很多，僅診斷用）
  --label <文字>         這輪量測的標記（例如 "桌機"、"筆電"）。請勿填個人資訊
  --out <檔案>           報告輸出路徑（預設 dml-bench-report.json）
  -h, --help             顯示本說明

退出碼：0＝要求的裝置都量成功；1＝主要裝置失敗（報告仍會寫出）；2＝參數錯誤
`.trim();

function parseArgs(argv) {
  const opts = {
    help: false,
    quick: false,
    devices: null,
    deviceSpec: "both",
    batch: 16,
    chunks: 256,
    dmlBatches: [8, 16, 32, 64],
    consistency: 32,
    threshold: COSINE_THRESHOLD,
    seed: 20261016,
    chunkBytes: 900,
    cache: null,
    dmlDeviceId: 0,
    ortVerbose: false,
    label: null,
    out: null,
  };

  const readValue = (index, name) => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new UsageError(`參數 ${name} 需要一個值`);
    }
    return value;
  };
  const readNumber = (index, name, { integer = true, min = 0 } = {}) => {
    const value = Number(readValue(index, name));
    if (!Number.isFinite(value) || value < min || (integer && !Number.isInteger(value))) {
      throw new UsageError(`參數 ${name} 需要 ${integer ? "整數" : "數字"}（≥ ${min}）`);
    }
    return value;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "-h":
      case "--help":
        opts.help = true;
        break;
      case "--quick":
        opts.quick = true;
        break;
      case "--device":
        opts.deviceSpec = readValue(index, arg);
        index += 1;
        break;
      case "--batch":
        opts.batch = readNumber(index, arg, { min: 1 });
        index += 1;
        break;
      case "--chunks":
        opts.chunks = readNumber(index, arg, { min: 1 });
        index += 1;
        break;
      case "--dml-batches": {
        const list = readValue(index, arg)
          .split(",")
          .map((piece) => Number(piece.trim()));
        if (list.length === 0 || list.some((value) => !Number.isInteger(value) || value < 1)) {
          throw new UsageError("--dml-batches 需要正整數清單，例如 8,16,32,64");
        }
        opts.dmlBatches = list;
        index += 1;
        break;
      }
      case "--consistency":
        opts.consistency = readNumber(index, arg, { min: 0 });
        index += 1;
        break;
      case "--cosine-threshold": {
        const value = Number(readValue(index, arg));
        if (!Number.isFinite(value) || value <= 0 || value > 1) {
          throw new UsageError("--cosine-threshold 需要在 (0, 1] 之間");
        }
        opts.threshold = value;
        index += 1;
        break;
      }
      case "--seed":
        opts.seed = readNumber(index, arg);
        index += 1;
        break;
      case "--chunk-bytes":
        opts.chunkBytes = readNumber(index, arg, { min: 1 });
        index += 1;
        break;
      case "--cache":
        opts.cache = readValue(index, arg);
        index += 1;
        break;
      case "--dml-device-id":
        opts.dmlDeviceId = readNumber(index, arg);
        index += 1;
        break;
      case "--ort-verbose":
        opts.ortVerbose = true;
        break;
      case "--label":
        opts.label = readValue(index, arg);
        index += 1;
        break;
      case "--out":
        opts.out = readValue(index, arg);
        index += 1;
        break;
      default:
        throw new UsageError(`未知參數：${arg}`);
    }
  }

  if (opts.deviceSpec === "both") opts.devices = ["cpu", "dml"];
  else if (opts.deviceSpec === "all") opts.devices = ["cpu", "dml"];
  else {
    const list = opts.deviceSpec.split(",").map((piece) => piece.trim()).filter(Boolean);
    for (const device of list) {
      if (device !== "cpu" && device !== "dml") {
        throw new UsageError(`--device 只接受 cpu／dml／both（收到 "${device}"）`);
      }
    }
    if (list.length === 0) throw new UsageError("--device 需要至少一個裝置");
    opts.devices = list;
  }

  return opts;
}

class UsageError extends Error {}

// ---------------------------------------------------------------------------
// 日誌
// ---------------------------------------------------------------------------

const LOG_PREFIX = "[dml-bench]";
const log = (...args) => console.log(LOG_PREFIX, ...args);
const warn = (...args) => console.warn(`${LOG_PREFIX} ⚠`, ...args);

function rule(title) {
  console.log("");
  console.log(`===== ${title} ${"=".repeat(Math.max(3, 62 - title.length))}`);
}

// ---------------------------------------------------------------------------
// 環境探測
// ---------------------------------------------------------------------------

function readInstalledVersion(packageName) {
  const candidates = [
    path.join(SPIKE_ROOT, "node_modules", ...packageName.split("/"), "package.json"),
  ];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(candidate, "utf8"));
      if (parsed.version) return parsed.version;
    } catch {
      /* 找不到就往下試 */
    }
  }
  return null;
}

/** 檢查 onnxruntime-node 的預建目錄是否真的帶 DirectML 相關 DLL（Windows 才有意義）。 */
function inspectNativeBinaries() {
  const dir = path.join(
    SPIKE_ROOT,
    "node_modules",
    "onnxruntime-node",
    "bin",
    "napi-v6",
    process.platform,
    process.arch,
  );
  try {
    const files = fs.readdirSync(dir);
    return {
      dir: displayPath(dir),
      exists: true,
      files,
      hasDirectMlDll: files.some((name) => name.toLowerCase().endsWith("directml.dll")),
      hasOrtDll: files.some((name) => /^onnxruntime(\.dll|\.so|\.dylib)$/i.test(name) || name === "libonnxruntime.so"),
      hasBinding: files.some((name) => name.endsWith(".node")),
    };
  } catch (error) {
    return { dir: displayPath(dir), exists: false, error: sanitizeText(String(error?.message ?? error)) };
  }
}

async function probeOrt() {
  const result = {
    packageVersion: readInstalledVersion("onnxruntime-node"),
    commonVersion: readInstalledVersion("onnxruntime-common"),
    transformersVersion: readInstalledVersion("@huggingface/transformers"),
    importOk: false,
    backends: null,
    error: null,
    nativeBinaries: inspectNativeBinaries(),
  };
  try {
    const ort = await import("onnxruntime-node");
    result.importOk = true;
    result.backends = ort.listSupportedBackends();
  } catch (error) {
    result.error = { name: error?.name ?? null, message: sanitizeText(String(error?.message ?? error)) };
  }
  return result;
}

function dmlPreflight(ortProbe) {
  if (process.platform !== "win32") {
    return {
      ok: false,
      code: "platform",
      message: `DirectML 只在 Windows 提供；本機是 ${process.platform}，onnxruntime-node 的預建二進位沒有 DirectML.dll。`,
      hints: [
        "這是預期行為，不是工具壞掉：DML 無法在非 Windows 機器上驗證。",
        "改用 --device cpu 取得 CPU 基準（可直接比較跨機數字）。",
        "要量 DML 請把整個 spikes/dml-bench 資料夾帶到 Windows 機器執行。",
      ],
    };
  }
  if (!ortProbe.importOk) {
    return {
      ok: false,
      code: "backend-import",
      message: `載入 onnxruntime-node 失敗：${ortProbe.error?.message ?? "未知原因"}`,
      hints: ["先跑 npm install 確認依賴完整", "確認平台（win32 x64／arm64）有預建二進位"],
    };
  }
  const entry = (ortProbe.backends ?? []).find((backend) => backend?.name === "dml");
  if (!entry) {
    return {
      ok: false,
      code: "no-dml-backend",
      message: `onnxruntime-node 回報的後端清單沒有 dml（清單：${(ortProbe.backends ?? []).map((b) => `${b.name}${b.bundled ? "" : "(未內建)"}`).join(", ")}）`,
      hints: [
        "可能是這個安裝不是預建的 Windows 二進位（例如自己編譯、或平台不是 win32）。",
        "改用 --device cpu；並把報告回傳以釐清安裝狀態。",
      ],
    };
  }
  if (entry.bundled === false) {
    return {
      ok: false,
      code: "dml-not-bundled",
      message: "onnxruntime-node 列出了 dml，但回報 `bundled: false`（執行檔不在套件內）。",
      hints: ["重新安裝依賴（Windows x64／arm64 的預建二進位才有 DirectML.dll）", "改用 --device cpu"],
    };
  }
  return { ok: true, entry };
}

/**
 * 淨化任意文字中的本機路徑（報告與訊息都不得出現個人絕對路徑）。
 * 只留檔名，資訊足夠除錯又不外洩目錄結構。
 */
function sanitizeText(text) {
  if (typeof text !== "string") return text;
  let out = text.split(os.homedir()).join("~");
  out = out.replace(/file:\/\/\/?[^\s"')]+/gi, "<檔案>");
  out = out.replace(/[A-Za-z]:\\[^\s"')]*/g, (match) => `<路徑>/${path.win32.basename(match)}`);
  out = out.replace(/(?<![\w:])\/(?:[^\s"')\/]+\/)+[^\s"')\/]*/g, (match) => `<路徑>/${path.posix.basename(match)}`);
  return out;
}

/** 只留前幾行 stack，並把行內路徑換成檔名。 */
function sanitizeStack(stack) {
  if (typeof stack !== "string") return null;
  return stack
    .split("\n")
    .slice(0, 4)
    .map((line) => sanitizeText(line))
    .join("\n");
}

/** 失敗分類：把底層錯誤翻成「階段＋可能原因＋建議動作」。 */
function classifyFailure(stage, error) {
  const message = sanitizeText(String(error?.message ?? error));
  const hints = [];

  if (/Unsupported device/i.test(message)) {
    hints.push("transformers.js 認為這個平台不支援該 device（Node 上只有 Windows 提供 'dml'）。");
    hints.push("改用 --device cpu；或在 Windows 機器重跑。");
  } else if (/DXGI|D3D12|DirectX|adapter|device_id|0x887|8007000|WinML|DirectML\.dll|dxgi/i.test(message)) {
    hints.push("看起來是 DirectX／顯示驅動層：更新顯示卡驅動（用顯卡廠商官方版本），確認 Windows 10 1903+ 且支援 DirectX 12。");
    hints.push("機器有多張顯示卡時，用 --dml-device-id 換 adapter（0 通常是預設顯示卡；筆電常見 0＝內顯）。");
  } else if (/not implemented|NOT_IMPLEMENTED|Could not find an implementation|kernel|op type|GatherBlockQuantized|fallback|unsupported/i.test(message)) {
    hints.push("看起來是算子支援問題：模型有節點在 DirectML 沒有實作（已知 GatherBlockQuantized 會退回 CPU）。");
    hints.push("先退回 CPU（--device cpu），並把報告回傳，由 PM 決定是否值得處理。");
  } else if (/ENOSPC|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|fetch failed|network|download|401|403|404|Hugging/i.test(message)) {
    hints.push("看起來是模型下載／網路問題：確認能連到 huggingface.co、磁碟還有數百 MB 空間（文字 q4 模型約 200 MB）。");
  } else if (/out of memory|OOM|allocation|memory/i.test(message)) {
    hints.push("記憶體不足：把 --batch 或 --dml-batches 調小（例如 8,16）。");
  }

  if (hints.length === 0) {
    hints.push("先用 --device cpu 確認 CPU 基準仍可跑，再把完整錯誤訊息與報告回傳。");
  }

  return {
    stage,
    name: error?.name ?? null,
    code: error?.code ?? null,
    message,
    hints,
    stack: sanitizeStack(error?.stack),
  };
}

// ---------------------------------------------------------------------------
// 模型與推論
// ---------------------------------------------------------------------------

async function loadTextModel({ device, cacheDir, dmlDeviceId, ortVerbose }) {
  const { AutoConfig, AutoModel, AutoProcessor, env } = await import("@huggingface/transformers");
  env.cacheDir = cacheDir;

  const config = await AutoConfig.from_pretrained(MODEL_ID);
  // 只量文字：不載入音訊與視覺編碼器（官方模型卡 Selective Encoder Loading）。
  config.audio_config = null;
  config.vision_config = null;

  const processor = await AutoProcessor.from_pretrained(MODEL_ID);

  const sessionOptions = {};
  if (device === "dml") {
    // 官方 JS API：`{ name: "dml", deviceId }`；deviceId 對應 IDXGIFactory::EnumAdapters 的順序。
    sessionOptions.executionProviders = [{ name: "dml", deviceId: dmlDeviceId }];
  }
  if (ortVerbose) {
    // 0 = verbose：可看到節點被分到哪個 EP（判斷是否有算子退回 CPU）。
    sessionOptions.logSeverityLevel = 0;
  }

  const started = performance.now();
  const model = await AutoModel.from_pretrained(MODEL_ID, {
    config,
    device,
    dtype: DTYPE,
    // transformers.js 以 `session_options.executionProviders ??=` 保留這裡指定的 EP。
    session_options: sessionOptions,
  });
  const loadMs = performance.now() - started;

  return { processor, model, loadMs, sessionOptions };
}

/** 從 attention_mask 取真實 token 數（pad 前）；取不到回 null。 */
function countRealTokens(attentionMask) {
  try {
    const data = attentionMask?.data;
    if (!data || typeof data.length !== "number") return null;
    let sum = 0;
    for (let index = 0; index < data.length; index += 1) {
      const value = data[index];
      sum += typeof value === "bigint" ? Number(value) : Number(value);
    }
    return sum;
  } catch {
    return null;
  }
}

/**
 * 一次 forward：`processor(texts)` → `model(inputs)` → `sentence_embedding`。
 * 與 App 相同：批次一次進模型，輸出逐列截斷成 512 維並重新 L2 正規化。
 * 模型偶發回不出可用 tensor 時重試一次（沿用 App `runModel` 的行為）。
 */
async function embedWindow(processor, model, texts) {
  const processStarted = performance.now();
  const inputs = await processor(texts);
  const processedMs = performance.now() - processStarted;

  const dims = inputs?.input_ids?.dims ?? null;
  const paddedTokens = dims && dims.length === 2 ? dims[0] * dims[1] : null;
  const realTokens = countRealTokens(inputs?.attention_mask);

  const inferStarted = performance.now();
  let rows = null;
  let lastMessage = "未取得輸出";
  for (let attempt = 0; attempt < 2 && rows === null; attempt += 1) {
    const output = await model(inputs);
    const tensor = output?.sentence_embedding;
    if (tensor && typeof tensor.tolist === "function") {
      rows = await tensor.tolist();
    } else {
      lastMessage = `模型輸出缺少可用的 sentence_embedding（第 ${attempt + 1} 次嘗試）`;
    }
  }
  const inferMs = performance.now() - inferStarted;
  if (rows === null) throw new Error(lastMessage);
  if (rows.length !== texts.length) {
    throw new Error(`批次回傳 ${rows.length} 筆向量，預期 ${texts.length} 筆`);
  }

  return {
    vectors: rows.map((row) => truncateAndNormalize(Float32Array.from(row), OUTPUT_DIM)),
    processedMs,
    inferMs,
    dims,
    paddedTokens,
    realTokens,
  };
}

/** 依批次大小把塊切窗並逐一量測。 */
async function measureWindows({ processor, model, chunks, batch, onWindow }) {
  const windows = [];
  for (let start = 0; start < chunks.length; start += batch) {
    const windowChunks = chunks.slice(start, start + batch);
    const texts = windowChunks.map((chunk) => documentPrefix(chunk.text));
    const bytes = texts.reduce((total, text) => total + byteLength(text), 0);
    const wallStarted = performance.now();
    const result = await embedWindow(processor, model, texts);
    const wallMs = performance.now() - wallStarted;
    const row = {
      index: windows.length,
      chunkCount: windowChunks.length,
      bytes,
      wallMs: ms(wallMs),
      processedMs: ms(result.processedMs),
      inferMs: ms(result.inferMs),
      maxSeqLen: result.dims ? result.dims[1] : null,
      paddedTokens: result.paddedTokens,
      realTokens: result.realTokens,
      msPerChunk: Number((wallMs / windowChunks.length).toFixed(1)),
      chunksPerSec: perSecond(windowChunks.length, wallMs),
      vectors: result.vectors,
    };
    windows.push(row);
    if (onWindow) onWindow(row, windows.length, Math.ceil(chunks.length / batch));
  }
  return windows;
}

/** 把逐窗結果彙總（純粹由窗推導，不混入整段的 CPU 統計）。 */
function summarizeWindows(windows) {
  const list = windows;
  const totalWall = list.reduce((total, row) => total + row.wallMs, 0);
  const totalChunks = list.reduce((total, row) => total + row.chunkCount, 0);
  const totalBytes = list.reduce((total, row) => total + row.bytes, 0);
  const totalRealTokens = list.every((row) => row.realTokens !== null)
    ? list.reduce((total, row) => total + row.realTokens, 0)
    : null;
  const totalPaddedTokens = list.every((row) => row.paddedTokens !== null)
    ? list.reduce((total, row) => total + row.paddedTokens, 0)
    : null;
  const msPerChunkValues = list.map((row) => row.msPerChunk);

  return {
    windowCount: list.length,
    chunks: totalChunks,
    bytes: totalBytes,
    wallMs: ms(totalWall),
    chunksPerSec: perSecond(totalChunks, totalWall),
    msPerChunk: totalChunks > 0 ? Number((totalWall / totalChunks).toFixed(1)) : null,
    msPerKb: totalBytes > 0 ? Number(((totalWall / totalBytes) * 1024).toFixed(1)) : null,
    msPerRealToken: totalRealTokens ? Number((totalWall / totalRealTokens).toFixed(3)) : null,
    paddedTokens: totalPaddedTokens,
    realTokens: totalRealTokens,
    paddingRatio: totalPaddedTokens && totalRealTokens ? Number((totalPaddedTokens / totalRealTokens).toFixed(3)) : null,
    msPerChunkMin: msPerChunkValues.length ? ms(Math.min(...msPerChunkValues)) : null,
    msPerChunkMedian: msPerChunkValues.length ? ms(percentile(msPerChunkValues, 50)) : null,
    msPerChunkMax: msPerChunkValues.length ? ms(Math.max(...msPerChunkValues)) : null,
  };
}

/**
 * 取整段（含暖機窗）與穩態段（去掉第一窗）的統計。
 * DML 的第一窗含 pipeline 建置成本，所以兩者分開報。
 */
function sectionSummary(windows) {
  const first = windows[0] ?? null;
  return {
    all: summarizeWindows(windows),
    firstWindow: first
      ? {
          wallMs: first.wallMs,
          inferMs: first.inferMs,
          chunkCount: first.chunkCount,
          msPerChunk: first.msPerChunk,
          chunksPerSec: first.chunksPerSec,
        }
      : null,
    steady: windows.length > 1 ? summarizeWindows(windows.slice(1)) : null,
  };
}

// ---------------------------------------------------------------------------
// 單一裝置的量測流程
// ---------------------------------------------------------------------------

async function runSection({ label, device, opts, corpus, consistencyChunks, cacheDir, ortProbe, mode = "throughput" }) {
  const referenceOnly = mode === "reference";
  const section = {
    label,
    device,
    mode,
    ok: false,
    failure: null,
    load: null,
    batches: [],
    consistency: null,
    cpu: null,
    rssBytesAfter: null,
  };

  const preflight = device === "dml" ? dmlPreflight(ortProbe) : { ok: true };
  if (!preflight.ok) {
    section.failure = {
      stage: "preflight",
      name: null,
      code: preflight.code,
      message: preflight.message,
      hints: preflight.hints,
      stack: null,
    };
    log(`[${label}] 跳過：${preflight.message}`);
    for (const hint of preflight.hints) log(`[${label}]   建議：${hint}`);
    return section;
  }

  const batches = referenceOnly ? [] : device === "cpu" ? [opts.batch] : opts.dmlBatches;
  const chunkCount = referenceOnly ? 0 : device === "cpu" ? opts.chunks : Math.min(opts.chunks, 128);
  const chunks = corpus.slice(0, chunkCount);

  rule(`${label}（device=${device}${referenceOnly ? "、只取一致性參考向量" : ""}）`);
  log(`模型 ${MODEL_ID}（dtype q4、文字 only）；塊數 ${chunks.length}、批次 ${batches.join("/") || "（不跑吞吐）"}`);
  log(`快取目錄 ${displayPath(cacheDir)}（目前 ${mib(dirSizeBytes(cacheDir))} MiB）`);

  const cacheBytesBefore = dirSizeBytes(cacheDir);
  let loaded = null;
  const cpuBefore = process.cpuUsage();
  let cpuAfterLoad = null;
  try {
    const loadStarted = performance.now();
    loaded = await loadTextModel({
      device,
      cacheDir,
      dmlDeviceId: opts.dmlDeviceId,
      ortVerbose: opts.ortVerbose,
    });
    const loadWallMs = performance.now() - loadStarted;
    cpuAfterLoad = process.cpuUsage(cpuBefore);
    const cacheBytesAfter = dirSizeBytes(cacheDir);
    section.load = {
      ms: ms(loadWallMs),
      sessionCreateMs: ms(loaded.loadMs),
      cacheBytesBefore,
      cacheBytesAfter,
      downloadedBytes: Math.max(0, cacheBytesAfter - cacheBytesBefore),
      cacheWasCold: cacheBytesBefore === 0,
      sessions: Object.keys(loaded.model?.sessions ?? {}),
      executionProviders: loaded.sessionOptions.executionProviders ?? "(由 transformers.js 依 device 決定)",
      cpu: {
        userMs: ms(cpuAfterLoad.user / 1000),
        systemMs: ms(cpuAfterLoad.system / 1000),
        totalMs: ms((cpuAfterLoad.user + cpuAfterLoad.system) / 1000),
      },
      rssMiB: mib(process.memoryUsage().rss),
    };
    log(
      `載入完成 ${section.load.ms} ms（下載 ${mib(section.load.downloadedBytes)} MiB${section.load.cacheWasCold ? "／冷快取" : ""}；session 建立 ${section.load.sessionCreateMs} ms；RSS ${section.load.rssMiB} MiB）`,
    );
    log(`EP 設定 ${JSON.stringify(section.load.executionProviders)}；sessions ${JSON.stringify(section.load.sessions)}`);
  } catch (error) {
    section.failure = classifyFailure("load", error);
    reportError(section.failure, label);
    return section;
  }

  // 逐批次量測。DML 每個新的批次大小＝新的 shape，第一次 forward 會含 pipeline 建置成本，
  // 所以每個批次都跑「第一輪＋第二輪」，把首輪與穩態分開報（官方文件：known shapes 才吃得到
  // constant folding 等好處）。
  const rounds = device === "dml" ? 2 : 1;
  try {
    for (const batch of batches) {
      // CPU 基準跑滿 --chunks；DML 探索各批次時每個批次取 4 個窗，避免總工作量隨批次數膨脹。
      const batchChunks = device === "cpu" ? chunks : chunks.slice(0, Math.min(chunks.length, batch * 4));
      const entry = {
        batch,
        chunkCount: batchChunks.length,
        rounds,
        ok: false,
        failure: null,
        loadMs: section.load.ms,
        runs: [],
      };
      section.batches.push(entry);

      for (let round = 1; round <= rounds; round += 1) {
        const cpuStarted = process.cpuUsage();
        try {
          const windows = await measureWindows({
            processor: loaded.processor,
            model: loaded.model,
            chunks: batchChunks,
            batch,
            onWindow: (row, index, total) => {
              log(
                `[${label}] batch=${batch} 第 ${round} 輪 窗 ${index}/${total}：${row.chunkCount} 塊 ${row.wallMs} ms（${row.chunksPerSec} 塊/s、每塊 ${row.msPerChunk} ms、seqLen ${row.maxSeqLen}）`,
              );
            },
          });
          const cpuUsed = process.cpuUsage(cpuStarted);
          const wallMs = windows.reduce((total, row) => total + row.wallMs, 0);
          entry.runs.push({
            round,
            ...sectionSummary(windows),
            walls: { wallMs: ms(wallMs) },
            cpu: {
              userMs: ms(cpuUsed.user / 1000),
              systemMs: ms(cpuUsed.system / 1000),
              totalMs: ms((cpuUsed.user + cpuUsed.system) / 1000),
              perWallRatio: wallMs > 0 ? Number(((cpuUsed.user + cpuUsed.system) / 1000 / wallMs).toFixed(2)) : null,
            },
            windows: windows.map(({ vectors, ...rest }) => rest),
          });
          entry.ok = true;
        } catch (error) {
          entry.failure = classifyFailure(`run(batch=${batch},round=${round})`, error);
          reportError(entry.failure, label);
          break;
        }
      }
    }

    // 一致性向量：同一批塊、同一批次大小、同一 prefix，兩邊各算一次。
    if (consistencyChunks && consistencyChunks.length > 0) {
      const consistencyBatch = Math.min(opts.batch, consistencyChunks.length);
      log(`[${label}] 一致性：${consistencyChunks.length} 塊、批次 ${consistencyBatch}（與另一裝置逐塊比餘弦）`);
      const windows = await measureWindows({
        processor: loaded.processor,
        model: loaded.model,
        chunks: consistencyChunks,
        batch: consistencyBatch,
      });
      const vectors = windows.flatMap((row) => row.vectors);
      section.consistency = {
        chunkCount: vectors.length,
        batch: consistencyBatch,
        corpusHash: corpusHash(consistencyChunks),
        vectorStats: {
          first: vectorStats(vectors[0]),
          meanL2: round(vectors.reduce((total, vector) => total + (vectorStats(vector).l2 ?? 0), 0) / vectors.length, 6),
          anyNan: vectors.some((vector) => vectorStats(vector).nan > 0),
        },
        _vectors: vectors,
      };
      log(`[${label}] 一致性向量完成（維度 ${vectors[0]?.length ?? 0}、任何 NaN=${section.consistency.vectorStats.anyNan}）`);
    } else {
      section.consistency = {
        status: "skipped",
        reason: opts.consistencySkipReason ?? "未要求一致性比對",
      };
    }

    section.ok = referenceOnly
      ? Array.isArray(section.consistency?._vectors)
      : section.batches.some((entry) => entry.ok);
  } finally {
    try {
      await loaded?.model?.dispose?.();
    } catch (error) {
      warn(`[${label}] dispose 失敗（不影響量測結果）：${sanitizeText(String(error?.message ?? error))}`);
    }
  }

  section.rssBytesAfter = process.memoryUsage().rss;
  section.cpu = {
    loadUserMs: cpuAfterLoad ? ms(cpuAfterLoad.user / 1000) : null,
    loadSystemMs: cpuAfterLoad ? ms(cpuAfterLoad.system / 1000) : null,
  };
  return section;
}

function reportError(failure, label) {
  warn(`[${label}] 失敗於階段「${failure.stage}」：${failure.message}`);
  for (const hint of failure.hints) warn(`[${label}]   建議：${hint}`);
}

// ---------------------------------------------------------------------------
// 一致性比對
// ---------------------------------------------------------------------------

function compareConsistency(sections, opts) {
  const comparable = sections.filter((section) => Array.isArray(section.consistency?._vectors));
  if (comparable.length < 2) {
    // 理由要說清楚「這是預期行為、不是失敗」，否則單一裝置模式會被誤讀成「cpu 失敗」。
    const missing = sections.filter((section) => !comparable.includes(section)).map((section) => section.label);
    let reason;
    if (opts.consistency === 0) {
      reason = "一致性比較已用 --consistency 0 關閉，這是預期行為，不是失敗";
    } else if (opts.devices.length === 1 && !opts.devices.includes("dml")) {
      reason = `單一裝置模式（${opts.devices[0]}）：跳過一致性比較，這是預期行為，不是失敗（要比 CPU↔DML 請用 --device cpu,dml 或 npm run bench）`;
    } else if (comparable.length === 0) {
      reason = `沒有任何裝置取得一致性向量，無法比對；不代表裝置失敗——未取得向量者（${missing.join("、") || "無"}）失敗時會記在該段的 failure 與 errors[]`;
    } else {
      reason = `只有 ${comparable[0].label} 取得一致性向量，無從比對；不代表 ${comparable[0].label} 失敗——未取得向量者（${missing.join("、") || "無"}）的原因見該段的 failure 與 errors[]`;
    }
    return { status: "skipped", threshold: opts.threshold, reason, pairs: [] };
  }

  const pairs = [];
  const baseline = comparable.find((section) => section.device === "cpu") ?? comparable[0];
  for (const target of comparable) {
    if (target === baseline) continue;
    const a = baseline.consistency._vectors;
    const b = target.consistency._vectors;
    const count = Math.min(a.length, b.length);
    const cosines = [];
    for (let index = 0; index < count; index += 1) cosines.push(cosine(a[index], b[index]));
    const finite = cosines.filter((value) => Number.isFinite(value));
    const min = finite.length ? Math.min(...finite) : Number.NaN;
    const mean = finite.length ? finite.reduce((total, value) => total + value, 0) / finite.length : Number.NaN;
    pairs.push({
      baseline: baseline.label,
      baselineDevice: baseline.device,
      target: target.label,
      targetDevice: target.device,
      chunkCount: count,
      sameCorpusHash: baseline.consistency.corpusHash === target.consistency.corpusHash,
      cosineMin: round(min),
      cosineMean: round(mean),
      cosineMax: finite.length ? round(Math.max(...finite)) : null,
      belowThreshold: finite.filter((value) => value < opts.threshold).length,
      nan: cosines.length - finite.length,
      pass: finite.length === count && min >= opts.threshold,
    });
  }

  return { status: "ok", threshold: opts.threshold, pairs };
}

// ---------------------------------------------------------------------------
// 結論
// ---------------------------------------------------------------------------

function buildConclusion(report) {
  const findings = [];
  const cpuSection = report.results.find((section) => section.device === "cpu" && section.ok && section.mode !== "reference");
  const dmlSection = report.results.find((section) => section.device === "dml");

  const bestCpu = cpuSection ? bestRun(cpuSection) : null;
  const bestDml = dmlSection?.ok ? bestRun(dmlSection) : null;

  if (cpuSection && bestCpu) {
    findings.push(
      `CPU（batch ${bestCpu.batch}）：${bestCpu.summary.chunksPerSec} 塊/s、每塊 ${bestCpu.summary.msPerChunk} ms、每 KB ${bestCpu.summary.msPerKb} ms、每真實 token ${bestCpu.summary.msPerRealToken} ms`,
    );
  }
  if (dmlSection && !dmlSection.ok) {
    findings.push(`DML 未成功：${dmlSection.failure ? `${dmlSection.failure.stage}／${dmlSection.failure.message}` : "未知原因"}`);
  }
  if (bestDml) {
    findings.push(
      `DML（batch ${bestDml.batch}）：${bestDml.summary.chunksPerSec} 塊/s、每塊 ${bestDml.summary.msPerChunk} ms、每 KB ${bestDml.summary.msPerKb} ms`,
    );
    if (bestCpu) {
      const speedup = bestCpu.summary.msPerChunk / bestDml.summary.msPerChunk;
      findings.push(`DML 相對 CPU 加速：${speedup.toFixed(2)}×（以各自最佳批次比較）`);
      const cpuRatio = bestDml.cpu?.perWallRatio;
      const cpuRatioBaseline = bestCpu.cpu?.perWallRatio;
      if (cpuRatio !== null && cpuRatio !== undefined) {
        findings.push(
          `每塊耗用的行程 CPU 時間（user+system ÷ wall）：CPU 段 ${cpuRatioBaseline ?? "?"}×、DML 段 ${cpuRatio}×（越接近 0 表示越不佔 CPU）`,
        );
      }
    }
    const firstWindows = dmlSection.batches.filter((entry) => entry.ok).map((entry) => ({
      batch: entry.batch,
      first: entry.runs[0]?.firstWindow?.msPerChunk ?? null,
      steady: entry.runs[entry.runs.length - 1]?.steady?.msPerChunk ?? entry.runs[0]?.all?.msPerChunk ?? null,
    }));
    findings.push(
      `DML 首次 shape 成本：${firstWindows.map((row) => `batch ${row.batch} 首窗 ${row.first} → 穩態 ${row.steady} ms/塊`).join("；")}`,
    );
  }
  if (report.consistency?.status === "ok") {
    for (const pair of report.consistency.pairs) {
      findings.push(
        `餘弦 ${pair.baseline}↔${pair.target}：min ${pair.cosineMin}、mean ${pair.cosineMean}（< ${report.consistency.threshold} 的有 ${pair.belowThreshold} 筆）→ ${pair.pass ? "通過" : "未通過"}`,
      );
    }
  }

  let recommendation = "insufficient-data";
  let recommendationText = "資料不足：先確認 CPU 段與 DML 段都完成量測。";
  const dmlConsistency = report.consistency?.pairs?.find((pair) => pair.targetDevice === "dml");
  const speedup = bestCpu && bestDml ? bestCpu.summary.msPerChunk / bestDml.summary.msPerChunk : null;

  if (bestDml && speedup !== null && speedup >= 1.3 && (!dmlConsistency || dmlConsistency.pass)) {
    recommendation = "use-dml";
    recommendationText = `DML 可行且有 ${speedup.toFixed(2)}× 增益，向量一致性也通過 → 可考慮在 Windows 預設 GPU、CPU 作為退回。落地時注意：DirectML 同一 session 不支援並發 Run，索引併發要設 1；換 device 不會改 embedder id，需確定既有索引的處理方式。`;
  } else if (bestDml && speedup !== null) {
    recommendation = "keep-cpu";
    recommendationText = `DML 可跑但增益只有 ${speedup.toFixed(2)}×${dmlConsistency && !dmlConsistency.pass ? "，且一致性未通過" : ""} → 現階段不值得切換，保留 CPU 路徑。`;
  } else if (bestDml) {
    recommendation = "dml-only";
    recommendationText = `DML 可以跑（最佳 batch ${bestDml.batch}、每塊 ${bestDml.summary.msPerChunk} ms），但這輪沒有 CPU 對照 → 用 --device cpu,dml（或 npm run bench）才能算出加速倍率。`;
  } else if (dmlSection && !dmlSection.ok) {
    recommendation = "keep-cpu";
    recommendationText = "DML 在這台機器上不可用或失敗 → 以 CPU 為準，後續靠執行緒／優先級等 CPU 節流手段；DML 失敗細節見 errors。";
  } else if (!dmlSection) {
    recommendation = "cpu-baseline-only";
    recommendationText = "這輪只量了 CPU（--device 未含 dml）→ 這些數字可當 CPU 基準；要判斷 GPU 是否值得預設，請在 Windows 機器跑 npm run bench。";
  }

  return { findings, recommendation, recommendationText };
}

function bestRun(section) {
  const runs = [];
  for (const entry of section.batches) {
    for (const run of entry.runs) {
      if (!entry.ok) continue;
      const summary = run.steady ?? run.all;
      if (summary) runs.push({ batch: entry.batch, round: run.round, summary, cpu: run.cpu });
    }
  }
  if (runs.length === 0) return null;
  return runs.reduce((best, run) => (run.summary.msPerChunk < best.summary.msPerChunk ? run : best), runs[0]);
}

// ---------------------------------------------------------------------------
// 報告
// ---------------------------------------------------------------------------

function stripInternalFields(report) {
  const clone = JSON.parse(JSON.stringify(report, (key, value) => (key === "_vectors" ? undefined : value)));
  for (const section of clone.results ?? []) {
    if (section.consistency?._vectors) delete section.consistency._vectors;
  }
  return clone;
}

function writeReport(report, outFile) {
  const payload = stripInternalFields(report);
  payload.meta.outFile = displayPath(outFile);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return outFile;
}

function baseMeta(opts, ortProbe) {
  const cpus = os.cpus();
  return {
    tool: { name: TOOL_NAME, version: TOOL_VERSION, mode: opts.quick ? "quick" : "bench" },
    runAt: new Date().toISOString(),
    label: opts.label ?? null,
    node: process.version,
    platform: process.platform,
    release: os.release(),
    arch: process.arch,
    cpu: { model: cpus[0]?.model ?? "unknown", logicalThreads: cpus.length },
    totalMemMiB: mib(os.totalmem()),
    loadAvgAtStart: os.loadavg().map((value) => round(value, 2)),
    versions: {
      onnxruntimeNode: ortProbe.packageVersion,
      onnxruntimeCommon: ortProbe.commonVersion,
      transformersJs: ortProbe.transformersVersion,
    },
    ort: {
      importOk: ortProbe.importOk,
      importError: ortProbe.error,
      supportedBackends: ortProbe.backends,
      nativeBinaries: ortProbe.nativeBinaries,
    },
  };
}

function baseConfig(opts, cacheDir) {
  return {
    modelId: MODEL_ID,
    dtype: DTYPE,
    outputDim: OUTPUT_DIM,
    modalities: "text",
    documentPrefix: "title: none | text: {text}",
    devices: opts.devices,
    cpuBatch: opts.batch,
    cpuChunks: opts.chunks,
    dmlBatches: opts.dmlBatches,
    consistencyChunks: opts.consistency,
    cosineThreshold: opts.threshold,
    seed: opts.seed,
    targetChunkBytes: opts.chunkBytes,
    cacheDir: displayPath(cacheDir),
    dmlDeviceId: opts.dmlDeviceId,
    ortVerbose: opts.ortVerbose,
  };
}

function printSummary(report) {
  rule("摘要");
  log(`結論：${report.conclusion.recommendation}`);
  console.log(`  ${report.conclusion.recommendationText}`);
  for (const finding of report.conclusion.findings) console.log(`  · ${finding}`);

  const failures = [];
  for (const section of report.results ?? []) {
    if (section.failure) failures.push({ where: section.label, ...section.failure });
    for (const entry of section.batches ?? []) {
      if (entry.failure) failures.push({ where: `${section.label} batch=${entry.batch}`, ...entry.failure });
    }
  }
  if (failures.length > 0) {
    console.log("");
    warn("以下錯誤已記錄在報告的 errors：");
    for (const failure of failures) {
      warn(`- [${failure.where}] ${failure.stage}：${failure.message}`);
      for (const hint of failure.hints ?? []) warn(`    → ${hint}`);
    }
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`${LOG_PREFIX} 參數錯誤：${error.message}`);
      console.error(USAGE);
      process.exitCode = 2;
      return;
    }
    throw error;
  }

  if (opts.help) {
    console.log(USAGE);
    return;
  }

  const cacheDir = path.resolve(opts.cache ?? process.env.MNEMOSHELF_MODEL_DIR ?? DEFAULT_CACHE_DIR);
  const outFile = path.resolve(opts.out ?? (opts.quick ? DEFAULT_QUICK_OUT : DEFAULT_OUT));

  const ortProbe = await probeOrt();

  const report = {
    schemaVersion: 1,
    meta: baseMeta(opts, ortProbe),
    config: baseConfig(opts, cacheDir),
    results: [],
    consistency: null,
    conclusion: null,
  };

  const dmlStatus = dmlPreflight(ortProbe);

  if (opts.quick) {
    rule("環境快檢（--quick：不載入模型）");
    log(`Node ${process.version}（${process.platform} ${os.release()} ${process.arch}）`);
    log(`CPU ${report.meta.cpu.model}（${report.meta.cpu.logicalThreads} 邏輯執行緒）、記憶體 ${report.meta.totalMemMiB} MiB`);
    log(`onnxruntime-node ${ortProbe.packageVersion ?? "未知"}、@huggingface/transformers ${ortProbe.transformersVersion ?? "未知"}`);
    log(`onnxruntime-node 可載入：${ortProbe.importOk ? "是" : `否（${ortProbe.error?.message}）`}`);
    log(
      `ORT 後端：${(ortProbe.backends ?? []).map((backend) => `${backend.name}${backend.bundled ? "" : "（未內建）"}`).join(", ") || "（取不到清單）"}`,
    );
    const binaries = ortProbe.nativeBinaries;
    log(`原生二進位目錄：${binaries.dir}${binaries.exists ? `（DirectML.dll：${binaries.hasDirectMlDll ? "有" : "無"}、binding：${binaries.hasBinding ? "有" : "無"}）` : "（不存在）"}`);

    if (dmlStatus.ok) {
      log("DirectML：可用 ✅");
      log("下一步：npm run bench（= 完整 CPU＋DML 量測）或 npm run bench:dml");
    } else {
      warn(`DirectML：不可用 ❌（${dmlStatus.code}）`);
      warn(`原因：${dmlStatus.message}`);
      for (const hint of dmlStatus.hints) warn(`建議：${hint}`);
    }
    log(`模型快取目錄：${displayPath(cacheDir)}（目前 ${mib(dirSizeBytes(cacheDir))} MiB；首次執行會下載約 200 MB 的文字 q4 模型）`);

    report.conclusion = {
      findings: [
        `DirectML ${dmlStatus.ok ? "可用" : "不可用"}（${dmlStatus.ok ? "回報後端清單含 dml" : dmlStatus.code}）`,
        ...(dmlStatus.ok ? [] : dmlStatus.hints),
      ],
      recommendation: dmlStatus.ok ? "run-dml-bench" : "keep-cpu",
      recommendationText: dmlStatus.ok
        ? "環境具備 DirectML，接著跑 npm run bench 取得數字。"
        : "這台機器無法用 DML；CPU 基準仍可用 --device cpu 取得。",
    };
    printSummary(report);
  } else {
    const corpusChunkCount = Math.max(...opts.devices.map((device) => (device === "cpu" ? opts.chunks : Math.min(opts.chunks, 128))));
    const corpus = buildCorpus({ count: corpusChunkCount, seed: opts.seed, targetBytes: opts.chunkBytes });
    const bytes = corpus.map((chunk) => chunk.bytes);
    report.corpus = {
      seed: opts.seed,
      chunkCount: corpus.length,
      targetBytes: opts.chunkBytes,
      hash: corpusHash(corpus),
      bytesMean: Math.round(bytes.reduce((total, value) => total + value, 0) / bytes.length),
      bytesMin: Math.min(...bytes),
      bytesMax: Math.max(...bytes),
      profiles: corpus.reduce((acc, chunk) => ({ ...acc, [chunk.profile]: (acc[chunk.profile] ?? 0) + 1 }), {}),
      note: "合成語料（決定性 PRNG），不含任何使用者檔案內容",
    };
    const needsReference = opts.devices.includes("dml") && !opts.devices.includes("cpu");
    const pairPossible = opts.devices.length >= 2 || opts.devices.includes("dml");
    const consistencyChunks =
      opts.consistency > 0 && pairPossible ? corpus.slice(0, Math.min(opts.consistency, corpus.length)) : null;
    const consistencySkipReason =
      opts.consistency === 0
        ? "一致性比較已用 --consistency 0 關閉，這是預期行為，不是失敗"
        : "單一裝置模式（cpu）：跳過一致性比較，這是預期行為，不是失敗（要比 CPU↔DML 請用 --device dml 或 --device cpu,dml）";
    opts.consistencySkipReason = consistencySkipReason;
    report.consistencyCorpus = consistencyChunks
      ? { count: consistencyChunks.length, hash: corpusHash(consistencyChunks) }
      : { count: 0, hash: null, skippedReason: consistencySkipReason };
    report.config.consistencyChunks = consistencyChunks ? consistencyChunks.length : 0;
    report.config.cpuReferencePass = needsReference;

    rule("環境");
    log(`Node ${process.version}（${process.platform} ${os.release()} ${process.arch}）`);
    log(`CPU ${report.meta.cpu.model}（${report.meta.cpu.logicalThreads} 邏輯執行緒）、記憶體 ${report.meta.totalMemMiB} MiB`);
    log(`ORT 後端：${(ortProbe.backends ?? []).map((backend) => `${backend.name}${backend.bundled ? "" : "（未內建）"}`).join(", ") || "（取不到清單）"}`);
    log(`語料：${corpus.length} 塊、平均 ${report.corpus.bytesMean} bytes／塊、hash ${report.corpus.hash.slice(0, 12)}…`);
    log(`注意：量測期間請關閉 Mnemoshelf App 與其他高負載程式，數字才可比。`);

    const seen = new Map();
    for (const device of opts.devices) {
      const count = (seen.get(device) ?? 0) + 1;
      seen.set(device, count);
      const label = count === 1 ? device : `${device}#${count}`;
      const section = await runSection({ label, device, opts, corpus, consistencyChunks, cacheDir, ortProbe });
      report.results.push(section);
    }

    // 只量 DML 時，另外跑一趟 CPU 取得參考向量（僅載入＋算一致性向量，不做吞吐量測）。
    const dmlHasVectors = report.results.some(
      (section) => section.device === "dml" && Array.isArray(section.consistency?._vectors),
    );
    if (needsReference && consistencyChunks && dmlHasVectors) {
      const reference = await runSection({
        label: "cpu（參考）",
        device: "cpu",
        mode: "reference",
        opts,
        corpus,
        consistencyChunks,
        cacheDir,
        ortProbe,
      });
      report.results.push(reference);
    }

    report.consistency = compareConsistency(report.results, opts);
    report.conclusion = buildConclusion(report);
    printSummary(report);
  }

  // errors：從各段（含逐批次）收集，方便閱讀
  report.errors = [];
  for (const section of report.results) {
    if (section.failure) report.errors.push({ where: section.label, ...section.failure });
    for (const entry of section.batches ?? []) {
      if (entry.failure) report.errors.push({ where: `${section.label} batch=${entry.batch}`, ...entry.failure });
    }
  }

  const written = writeReport(report, outFile);
  console.log("");
  log(`報告已寫入 ${displayPath(written)}`);

  // 退出碼：CPU 段失敗、或明確只要求 dml 而 dml 失敗 → 1。
  // （cpu,dml 完整模式下 dml 失敗不算失敗：自動退回 CPU 本來就是預期行為。）
  const cpuFailed = report.results.some((section) => section.device === "cpu" && !section.ok && section.mode !== "reference");
  const dmlOnly = opts.devices.length === 1 && opts.devices[0] === "dml";
  const dmlFailed = report.results.some((section) => section.device === "dml" && !section.ok);
  if (!opts.quick) {
    if (cpuFailed) {
      console.error(`${LOG_PREFIX} CPU 量測失敗（見報告 errors）`);
      process.exitCode = 1;
    } else if (dmlOnly && dmlFailed) {
      console.error(`${LOG_PREFIX} 指定了 --device dml，但 DML 無法完成（見報告 errors）`);
      process.exitCode = 1;
    }
  }
}

try {
  await main();
} catch (error) {
  // 非預期錯誤也要留下痕跡，不要只噴 stack 就消失（輸出一樣先淨化路徑）
  console.error(`${LOG_PREFIX} 未預期錯誤：${sanitizeText(String(error?.message ?? error))}`);
  console.error(sanitizeStack(error?.stack) ?? "");
  process.exitCode = 1;
}
