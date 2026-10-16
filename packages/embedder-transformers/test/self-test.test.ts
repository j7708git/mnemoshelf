/**
 * 加速器（CoreML）自我測試的單元測試：判準邊界、決定記錄的讀寫與生命週期、編排流程。
 *
 * 全部與真實模型無關（相依以回呼注入、暫存目錄用 `os.tmpdir()`），因此能在任何平台跑；
 * 判準的三個邊界（1.3×／0.999／6 GiB）在**編排層**再測一次，用腳本化時鐘把倍率固定住
 * （純函式層另有一組）。
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { EmbedderSelfTestStatus } from "@mnemoshelf/core";
import {
  ACCEL_UNAVAILABLE_MESSAGE,
  COREML_MLPROGRAM_FLAG,
  DEVICE_DECISION_SCHEMA,
  MAX_SUSPECTED_LOAD_CRASHES,
  SELF_TEST_CRITERIA,
  SELF_TEST_REASONS,
  classifyDecision,
  cosineSimilarity,
  decisionMatchesIdentity,
  describeLoadCrashRetry,
  describeSelfTestReason,
  evaluateSelfTest,
  measurementFieldsOf,
  nextLoadCrashDecision,
  parseDecisionRecord,
  readDecisionRecord,
  runCoreMlSelfTest,
  selfTestFallbackCode,
  toSelfTestStatus,
  writeDecisionRecord,
  type CoreMlSelfTestResult,
  type DeviceDecisionIdentity,
  type DeviceDecisionRecord,
} from "../src/index.js";

const GIB = 1024 ** 3;

/** 身分（測試用；不代表任何真實機器）。 */
const IDENTITY: DeviceDecisionIdentity = {
  appVersion: "1.0.0",
  modelId: "example/model-ONNX",
  dtype: "q4",
  platform: "darwin",
  arch: "arm64",
  coreMlFlags: COREML_MLPROGRAM_FLAG,
};

/** 完整記錄（測試用；可覆寫個別欄位）。 */
function record(overrides: Partial<DeviceDecisionRecord> = {}): DeviceDecisionRecord {
  return {
    schema: DEVICE_DECISION_SCHEMA,
    ...IDENTITY,
    outcome: "usable",
    testedAt: "2026-10-16T00:00:00.000Z",
    ...overrides,
  };
}

/** 測試用暫存目錄。 */
const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mnemoshelf-selftest-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 判準（純函式）
// ---------------------------------------------------------------------------

describe("判準邊界（evaluateSelfTest）", () => {
  /** 一份「全部通過」的量測（個別測試再壓低某一項）。 */
  const passing = { throughputRatio: 2, minCosine: 1, peakRssBytes: 1 * GIB };

  it("預設判準＝吞吐 1.3×、min cos 0.999、峰值 RSS 6 GiB", () => {
    expect(SELF_TEST_CRITERIA).toEqual({
      minThroughputRatio: 1.3,
      minCosine: 0.999,
      maxPeakRssBytes: 6 * GIB,
    });
  });

  it("全部通過 → usable（沒有 reason）", () => {
    expect(evaluateSelfTest(passing)).toEqual({ outcome: "usable" });
  });

  it("吞吐倍率：剛好 1.3 通過；差一點（1.2999）未達", () => {
    expect(evaluateSelfTest({ ...passing, throughputRatio: 1.3 }).outcome).toBe("usable");
    expect(evaluateSelfTest({ ...passing, throughputRatio: 1.2999 })).toEqual({
      outcome: "unusable",
      reason: SELF_TEST_REASONS.tooSlow,
    });
  });

  it("向量一致性：剛好 0.999 通過；差一點（0.9989）未達", () => {
    expect(evaluateSelfTest({ ...passing, minCosine: 0.999 }).outcome).toBe("usable");
    expect(evaluateSelfTest({ ...passing, minCosine: 0.9989 })).toEqual({
      outcome: "unusable",
      reason: SELF_TEST_REASONS.inconsistent,
    });
  });

  it("峰值記憶體：剛好 6 GiB 通過；多一個 byte 就未達", () => {
    expect(evaluateSelfTest({ ...passing, peakRssBytes: 6 * GIB }).outcome).toBe("usable");
    expect(evaluateSelfTest({ ...passing, peakRssBytes: 6 * GIB + 1 })).toEqual({
      outcome: "unusable",
      reason: SELF_TEST_REASONS.memoryExceeded,
    });
  });

  it("多項同時未達時，先報最嚴重的一項（安全 > 正確性 > 效能）", () => {
    expect(
      evaluateSelfTest({ throughputRatio: 0.5, minCosine: 0.1, peakRssBytes: 7 * GIB }).reason,
    ).toBe(SELF_TEST_REASONS.memoryExceeded);
    expect(evaluateSelfTest({ throughputRatio: 0.5, minCosine: 0.1, peakRssBytes: GIB }).reason).toBe(
      SELF_TEST_REASONS.inconsistent,
    );
    expect(evaluateSelfTest({ throughputRatio: 0.5, minCosine: 1, peakRssBytes: GIB }).reason).toBe(
      SELF_TEST_REASONS.tooSlow,
    );
  });

  it("量測壞掉（NaN）一律判未達，不得被當成通過", () => {
    expect(evaluateSelfTest({ ...passing, minCosine: Number.NaN }).outcome).toBe("unusable");
    expect(evaluateSelfTest({ ...passing, throughputRatio: Number.NaN }).outcome).toBe("unusable");
    expect(evaluateSelfTest({ ...passing, peakRssBytes: Number.NaN }).outcome).toBe("unusable");
  });

  it("可傳入自訂判準（門檻可調，不必改程式）", () => {
    const lenient = { minThroughputRatio: 1, minCosine: 0.9, maxPeakRssBytes: 2 * GIB };
    expect(
      evaluateSelfTest({ throughputRatio: 1, minCosine: 0.9, peakRssBytes: 2 * GIB }, lenient).outcome,
    ).toBe("usable");
    expect(evaluateSelfTest({ ...passing, minCosine: 0.95 }, lenient).outcome).toBe("usable");
  });
});

describe("向量比較工具", () => {
  it("cosineSimilarity 取共同長度", () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1, 10);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 10);
    // 不同長度時只看共同的前綴。
    expect(cosineSimilarity([1, 0, 0], [1, 0])).toBeCloseTo(1, 10);
  });
});

describe("量測欄位的過濾（measurementFieldsOf）", () => {
  it("只留量測欄位：outcome／reason 一律不搬（避免舊結論被寫進 pending 標記）", () => {
    // 刻意用**變數**（生產路徑就是這樣傳的：整個 selfTest 摘要進去）而不是字面物件。
    const status: EmbedderSelfTestStatus = {
      outcome: "unusable",
      reason: SELF_TEST_REASONS.tooSlow,
      throughputRatio: 0.9,
      minCosine: 0.9995,
      cpuSessionBuildMs: 410,
      coreMlSessionBuildMs: 11_800,
      testedAt: "2026-10-16T00:00:00.000Z",
    };
    const fields = measurementFieldsOf(status);
    expect(fields).toEqual({
      throughputRatio: 0.9,
      minCosine: 0.9995,
      cpuSessionBuildMs: 410,
      coreMlSessionBuildMs: 11_800,
      testedAt: "2026-10-16T00:00:00.000Z",
    });
    expect(Object.keys(fields)).not.toContain("outcome");
    expect(Object.keys(fields)).not.toContain("reason");
  });

  it("缺的欄位不會變成 undefined 鍵（JSON 才不會出現 null／undefined）", () => {
    expect(measurementFieldsOf({})).toEqual({});
    expect(measurementFieldsOf({ minCosine: 1 })).toEqual({ minCosine: 1 });
    // 記錄（身分 + 結論 + 量測）也可以直接餵進來。
    expect(measurementFieldsOf(record({ throughputRatio: 2.4 }))).toEqual({
      throughputRatio: 2.4,
      testedAt: "2026-10-16T00:00:00.000Z",
    });
  });
});

// ---------------------------------------------------------------------------
// 決定記錄：解析、原子寫入、寬鬆相容
// ---------------------------------------------------------------------------

describe("決定記錄（parseDecisionRecord）", () => {
  it("完整記錄可往返（寫入後讀回相等）", () => {
    const dir = tempDir();
    const path = join(dir, "device-decision.json");
    const original = record({
      outcome: "unusable",
      reason: SELF_TEST_REASONS.tooSlow,
      throughputRatio: 0.9,
      minCosine: 0.9999,
      cpuSessionBuildMs: 430,
      coreMlSessionBuildMs: 12_600,
    });
    expect(writeDecisionRecord(path, original)).toBe(true);
    expect(readDecisionRecord(path)).toEqual(original);
  });

  it("原子寫入：目錄裡不留暫存檔", () => {
    const dir = tempDir();
    const path = join(dir, "device-decision.json");
    writeDecisionRecord(path, record());
    writeDecisionRecord(path, record({ outcome: "pending" }));
    expect(readdirSync(dir)).toEqual(["device-decision.json"]);
  });

  it("缺檔／壞 JSON／不是物件一律回 null（＝重測）", () => {
    const dir = tempDir();
    expect(readDecisionRecord(join(dir, "absent.json"))).toBeNull();
    expect(parseDecisionRecord("{ 這不是 JSON")).toBeNull();
    expect(parseDecisionRecord("null")).toBeNull();
    expect(parseDecisionRecord('"字串"')).toBeNull();
    expect(parseDecisionRecord("[]")).toBeNull();
  });

  it("schema 版本或 outcome 不認識 → null（不猜、重測）", () => {
    expect(parseDecisionRecord(JSON.stringify(record({ schema: 99 })))).toBeNull();
    const unknownOutcome = { ...record(), outcome: "maybe" };
    expect(parseDecisionRecord(JSON.stringify(unknownOutcome))).toBeNull();
  });

  it("必要欄位缺一不可（舊格式缺 dtype／coreMlFlags 視為無效）", () => {
    const withoutDtype: Record<string, unknown> = { ...record() };
    delete withoutDtype["dtype"];
    expect(parseDecisionRecord(JSON.stringify(withoutDtype))).toBeNull();

    const withoutFlags: Record<string, unknown> = { ...record() };
    delete withoutFlags["coreMlFlags"];
    expect(parseDecisionRecord(JSON.stringify(withoutFlags))).toBeNull();

    const withoutVersion: Record<string, unknown> = { ...record() };
    delete withoutVersion["appVersion"];
    expect(parseDecisionRecord(JSON.stringify(withoutVersion))).toBeNull();
  });

  it("舊 payload 相容：選填欄位不存在也能解析；未知欄位被忽略", () => {
    const minimal = JSON.stringify({
      schema: DEVICE_DECISION_SCHEMA,
      outcome: "usable",
      testedAt: "2026-10-16T00:00:00.000Z",
      ...IDENTITY,
      // 沒有 reason／throughputRatio／minCosine／session 建置耗時（舊版只記結論），
      // 另有一個未來版本才有的欄位。
      futureField: "ignored",
    });
    const parsed = parseDecisionRecord(minimal);
    expect(parsed).not.toBeNull();
    expect(parsed?.outcome).toBe("usable");
    expect(parsed?.reason).toBeUndefined();
    expect(parsed?.throughputRatio).toBeUndefined();
    expect(parsed?.minCosine).toBeUndefined();
    expect(parsed?.cpuSessionBuildMs).toBeUndefined();
    expect(parsed?.coreMlSessionBuildMs).toBeUndefined();
    expect(parsed && "futureField" in parsed).toBe(false);
  });

  it("只有其中一邊的建置耗時也能解析（CoreML 載入失敗的記錄）", () => {
    const parsed = parseDecisionRecord(
      JSON.stringify(record({ outcome: "unusable", reason: SELF_TEST_REASONS.loadFailed, cpuSessionBuildMs: 512 })),
    );
    expect(parsed?.cpuSessionBuildMs).toBe(512);
    expect(parsed?.coreMlSessionBuildMs).toBeUndefined();
  });

  it("建置耗時型別不對（字串）一律忽略該欄位，不讓整份記錄失效", () => {
    const parsed = parseDecisionRecord(
      JSON.stringify({ ...record(), cpuSessionBuildMs: "430", coreMlSessionBuildMs: null }),
    );
    expect(parsed).not.toBeNull();
    expect(parsed?.cpuSessionBuildMs).toBeUndefined();
    expect(parsed?.coreMlSessionBuildMs).toBeUndefined();
  });

  it("寫不進去（路徑的上層是檔案）回 false，不拋錯、也不留暫存檔", () => {
    const dir = tempDir();
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "not a directory", "utf8");
    expect(writeDecisionRecord(join(blocker, "device-decision.json"), record())).toBe(false);
    expect(readdirSync(dir)).toEqual(["blocker"]);
  });
});

describe("記錄 → 診斷摘要（toSelfTestStatus）", () => {
  it("usable／unusable 帶著量測數字與兩邊的建置耗時", () => {
    expect(
      toSelfTestStatus(
        record({
          throughputRatio: 2.4,
          minCosine: 0.9995,
          cpuSessionBuildMs: 410,
          coreMlSessionBuildMs: 11_800,
        }),
      ),
    ).toEqual({
      outcome: "usable",
      reason: undefined,
      testedAt: "2026-10-16T00:00:00.000Z",
      throughputRatio: 2.4,
      minCosine: 0.9995,
      cpuSessionBuildMs: 410,
      coreMlSessionBuildMs: 11_800,
    });
    expect(
      toSelfTestStatus(record({ outcome: "unusable", reason: SELF_TEST_REASONS.tooSlow, throughputRatio: 0.8 })),
    ).toMatchObject({ outcome: "unusable", reason: SELF_TEST_REASONS.tooSlow });
  });

  it("未量到的欄位不出現在摘要裡（不是 null）", () => {
    const status = toSelfTestStatus(record({ outcome: "unusable", reason: SELF_TEST_REASONS.loadFailed }));
    expect(Object.keys(status).sort()).toEqual(["outcome", "reason", "testedAt"]);
  });

  it("pending 與 crashed 都呈現成 crashed，且帶崩潰原因", () => {
    expect(toSelfTestStatus(record({ outcome: "pending" }))).toMatchObject({
      outcome: "crashed",
      reason: SELF_TEST_REASONS.crashed,
    });
    expect(toSelfTestStatus(record({ outcome: "crashed" }))).toMatchObject({ outcome: "crashed" });
  });
});

describe("決定是否可沿用（classifyDecision）", () => {
  it("沒有記錄 → 必須測一次", () => {
    expect(classifyDecision(null, IDENTITY).kind).toBe("test-required");
  });

  it("usable／unusable 且身分與版本相同 → 直接沿用", () => {
    const usable = classifyDecision(record(), IDENTITY);
    expect(usable.kind).toBe("usable");
    expect(usable.kind === "usable" && usable.status.outcome).toBe("usable");
    expect(usable.kind === "usable" && usable.suspectedLoadCrashes).toBe(0);

    const withCount = classifyDecision(record({ suspectedLoadCrashes: 1 }), IDENTITY);
    expect(withCount.kind === "usable" && withCount.suspectedLoadCrashes).toBe(1);

    const unusable = classifyDecision(
      record({ outcome: "unusable", reason: SELF_TEST_REASONS.memoryExceeded }),
      IDENTITY,
    );
    expect(unusable.kind).toBe("unusable");
    expect(unusable.kind === "unusable" && unusable.status.reason).toBe(SELF_TEST_REASONS.memoryExceeded);
  });

  it("appVersion 變更 → 重測一次（不沿用也不當成崩潰）", () => {
    expect(classifyDecision(record(), { ...IDENTITY, appVersion: "2.0.0" }).kind).toBe("test-required");
  });

  it("模型／dtype／平台／架構／旗標任一不同 → 重測", () => {
    const variations: Partial<DeviceDecisionIdentity>[] = [
      { modelId: "other/model" },
      { dtype: "q8" },
      { platform: "linux" },
      { arch: "x64" },
      { coreMlFlags: 0x000 },
    ];
    for (const variation of variations) {
      const record2 = record({ ...variation });
      expect(decisionMatchesIdentity(record2, IDENTITY)).toBe(false);
      expect(classifyDecision(record2, IDENTITY).kind).toBe("test-required");
    }
  });

  it("crashed 是機器層級的事實：即使身分不同也不重試，且磁碟上已是結論（不必改寫）", () => {
    const classified = classifyDecision(record({ outcome: "crashed", modelId: "other/model" }), IDENTITY);
    expect(classified.kind).toBe("crashed");
    expect(classified.kind === "crashed" && classified.rewrite).toBeNull();
    expect(classified.kind === "crashed" && classified.status.outcome).toBe("crashed");
  });

  it("pending（上次測試中死掉）→ crashed，並改寫檔案成結論", () => {
    const classified = classifyDecision(record({ outcome: "pending", throughputRatio: undefined }), IDENTITY);
    expect(classified.kind).toBe("crashed");
    expect(classified.kind === "crashed" && classified.status.outcome).toBe("crashed");
    expect(classified.kind === "crashed" && classified.status.reason).toBe(SELF_TEST_REASONS.crashed);
    const rewrite = classified.kind === "crashed" ? classified.rewrite : null;
    expect(rewrite?.outcome).toBe("crashed");
    expect(rewrite?.reason).toBe(SELF_TEST_REASONS.crashed);
    expect(rewrite?.pendingPhase).toBe("self-test");
  });

  it("舊檔沒有 pendingPhase → 視為自我測試（保守：永久停用）", () => {
    const classified = classifyDecision(record({ outcome: "pending" }), IDENTITY);
    expect(classified.kind).toBe("crashed");
    expect(classified.kind === "crashed" && classified.status.reason).toBe(SELF_TEST_REASONS.crashed);
  });

  it("pending(self-test) 的記錄在呈現上與 crashed 一致（不因階段而放寬）", () => {
    const classified = classifyDecision(record({ outcome: "pending", pendingPhase: "self-test" }), IDENTITY);
    expect(classified.kind).toBe("crashed");
  });
});

describe("載入期崩潰的容忍（classifyDecision ＋ nextLoadCrashDecision）", () => {
  it("容忍上限＝2：第一次疑似→重試（寫回 usable）、連續第二次→永久停用", () => {
    expect(MAX_SUSPECTED_LOAD_CRASHES).toBe(2);
    expect(nextLoadCrashDecision(0)).toEqual({ count: 1, permanent: false });
    expect(nextLoadCrashDecision(1)).toEqual({ count: 2, permanent: true });
    // 不會無限成長：達到上限後仍是永久處置。
    expect(nextLoadCrashDecision(2)).toEqual({ count: 3, permanent: true });
  });

  it("pending(load) 第一次：這次用 CPU，決定寫回 usable＋次數 1（量測欄位沿用）", () => {
    const classified = classifyDecision(
      record({
        outcome: "pending",
        pendingPhase: "load",
        throughputRatio: 2.4,
        minCosine: 0.9995,
        cpuSessionBuildMs: 410,
        coreMlSessionBuildMs: 11_800,
      }),
      IDENTITY,
    );
    expect(classified.kind).toBe("load-crash-retry");
    if (classified.kind !== "load-crash-retry") throw new Error("預期 load-crash-retry");
    expect(classified.suspectedLoadCrashes).toBe(1);
    // 呈現上仍是「可用」（決定沒被推翻，只是這次先用 CPU）。
    expect(classified.status.outcome).toBe("usable");
    // 寫回磁碟的記錄：usable、次數 1、量測欄位沿用（崩潰不該讓量測數據消失）。
    expect(classified.rewrite.outcome).toBe("usable");
    expect(classified.rewrite.suspectedLoadCrashes).toBe(1);
    expect(classified.rewrite.pendingPhase).toBe("load");
    expect(classified.rewrite.throughputRatio).toBe(2.4);
    expect(classified.rewrite.minCosine).toBe(0.9995);
    expect(classified.rewrite.cpuSessionBuildMs).toBe(410);
    expect(classified.rewrite.coreMlSessionBuildMs).toBe(11_800);
    expect(classified.rewrite.testedAt).toBe("2026-10-16T00:00:00.000Z");
  });

  it("pending(load) 連續第二次：永久停用（crashed-during-load），次數記 2", () => {
    const classified = classifyDecision(
      record({ outcome: "pending", pendingPhase: "load", suspectedLoadCrashes: 1 }),
      IDENTITY,
    );
    expect(classified.kind).toBe("crashed");
    if (classified.kind !== "crashed") throw new Error("預期 crashed");
    expect(classified.status.reason).toBe(SELF_TEST_REASONS.crashedDuringLoad);
    expect(classified.rewrite?.outcome).toBe("crashed");
    expect(classified.rewrite?.reason).toBe(SELF_TEST_REASONS.crashedDuringLoad);
    expect(classified.rewrite?.suspectedLoadCrashes).toBe(2);
  });

  it("已是結論的 crashed（crashed-during-load）不必再改寫，且不因身分不同而放寬", () => {
    const classified = classifyDecision(
      record({ outcome: "crashed", reason: SELF_TEST_REASONS.crashedDuringLoad, suspectedLoadCrashes: 2, modelId: "other" }),
      IDENTITY,
    );
    expect(classified.kind).toBe("crashed");
    expect(classified.kind === "crashed" && classified.rewrite).toBeNull();
    expect(classified.kind === "crashed" && classified.status.reason).toBe(SELF_TEST_REASONS.crashedDuringLoad);
  });
});

describe("失敗原因 → 退回代碼與說明", () => {
  it("accel-* 家族讓診斷看得出是加速器自我測試擋掉的", () => {
    expect(selfTestFallbackCode(SELF_TEST_REASONS.tooSlow)).toBe("accel-slow");
    expect(selfTestFallbackCode(SELF_TEST_REASONS.inconsistent)).toBe("accel-inconsistent");
    expect(selfTestFallbackCode(SELF_TEST_REASONS.memoryExceeded)).toBe("accel-memory-exceeded");
    expect(selfTestFallbackCode(SELF_TEST_REASONS.crashed)).toBe("accel-crashed");
    expect(selfTestFallbackCode(SELF_TEST_REASONS.inferenceFailed)).toBe("inference-failed");
    expect(selfTestFallbackCode(SELF_TEST_REASONS.loadFailed)).toBe("load-failed");
    expect(selfTestFallbackCode(undefined)).toBe("load-failed");
  });

  it("每個原因都有非空的人類可讀說明（不含路徑）", () => {
    for (const reason of Object.values(SELF_TEST_REASONS)) {
      const message = describeSelfTestReason(reason);
      expect(message.length).toBeGreaterThan(0);
      expect(message).not.toContain("/");
    }
    expect(describeSelfTestReason(undefined)).toContain("CPU");
  });
});

// ---------------------------------------------------------------------------
// 編排：runCoreMlSelfTest（相依以回呼注入）
// ---------------------------------------------------------------------------

/** 測試用的假 session。 */
interface FakeBackend {
  device: "cpu" | "coreml";
}

/**
 * 編排測試的環境：記錄呼叫順序、可控制向量／失敗／時鐘／RSS。
 *
 * 時鐘是「虛擬時鐘＋工作量」模型：假 session 與假嵌入在執行時把各自設定的耗時加到
 * 虛擬時鐘上，因此「量到的建置耗時／推論耗時」正好等於注入值，不受內部呼叫順序影響。
 */
function harness(options: {
  /** 建立各裝置 session 的耗時（毫秒）。 */
  buildMs?: { cpu: number; coreml: number };
  /** 各裝置一次嵌入的耗時（毫秒）＝計時那一次的量測值。 */
  inferenceMs?: { cpu: number; coreml: number };
  /** CoreML 的向量偏移（0＝與 CPU 完全一致）。 */
  drift?: number;
  /** 建 CoreML session 時拋錯。 */
  coremlLoadFails?: boolean;
  /** 嵌入時（CoreML）拋錯。 */
  coremlEmbedFails?: boolean;
  /** CPU 建 session 時拋錯。 */
  cpuLoadFails?: boolean;
  /** 量測期間的 RSS 腳本（逐次讀取回傳；超出即重複最後一項）。 */
  rss?: number[];
  /**
   * 模擬「marker 寫得進去、但最終決定寫不進去」：在建立 CoreML session 的那一刻把決定檔的
   * 目錄換成一個普通檔案，之後任何寫入都會失敗（`ENOTDIR`）。
   */
  failFinalWrite?: boolean;
  /** 決定記錄的檔案路徑（預設在暫存目錄）。 */
  decisionPath?: string;
} = {}) {
  const dir = tempDir();
  const decisionPath = options.decisionPath ?? join(dir, "device-decision.json");
  const created: string[] = [];
  const disposed: string[] = [];
  /** 建 CoreML session 當下，磁碟上的狀態（驗證「先寫 pending」的關鍵斷言）。 */
  const pendingAtCoreMlLoad: (string | null)[] = [];
  const buildMs = options.buildMs ?? { cpu: 400, coreml: 12_000 };
  const inferenceMs = options.inferenceMs ?? { cpu: 100, coreml: 50 };
  let virtualNow = 0;
  const rssValues = options.rss ?? [GIB];
  let rssIndex = 0;

  const deps = {
    decisionPath,
    identity: IDENTITY,
    createBackend: async (device: "cpu" | "coreml"): Promise<FakeBackend> => {
      created.push(device);
      if (device === "coreml") {
        pendingAtCoreMlLoad.push(readDecisionRecord(decisionPath)?.outcome ?? null);
        if (options.failFinalWrite === true) {
          // marker 已經落地了；現在把它的目錄換成檔案 → 之後的最終寫入必定失敗。
          rmSync(dirname(decisionPath), { recursive: true, force: true });
          writeFileSync(dirname(decisionPath), "blocked", "utf8");
        }
        if (options.coremlLoadFails === true) throw new Error("CoreML 載入失敗（模擬）");
      }
      if (device === "cpu" && options.cpuLoadFails === true) throw new Error("CPU 載入失敗（模擬）");
      virtualNow += buildMs[device];
      return { device };
    },
    embed: async (backend: FakeBackend, texts: readonly string[]): Promise<readonly number[][]> => {
      if (backend.device === "coreml" && options.coremlEmbedFails === true) {
        throw new Error("CoreML 推論失敗（模擬）");
      }
      virtualNow += inferenceMs[backend.device];
      // 真實實作回傳的是**已 L2 正規化**的最終向量（契約要求），這裡照樣正規化。
      const drift = backend.device === "coreml" ? (options.drift ?? 0) : 0;
      const norm = Math.sqrt(1 + drift * drift);
      return texts.map(() => [1 / norm, drift / norm, 0]);
    },
    disposeBackend: async (backend: FakeBackend): Promise<void> => {
      disposed.push(backend.device);
    },
    now: (): number => virtualNow,
    readRss: (): number => {
      const value = rssValues[Math.min(rssIndex, rssValues.length - 1)]!;
      rssIndex += 1;
      return value;
    },
    nowIso: (): string => "2026-10-16T12:00:00.000Z",
  };

  return { deps, decisionPath, created, disposed, pendingAtCoreMlLoad };
}

/** 跑自我測試並要求「marker 落地成功」那條路徑（既有測試都走這條）。 */
async function runTested(deps: Parameters<typeof runCoreMlSelfTest<FakeBackend>>[0]) {
  const result: CoreMlSelfTestResult<FakeBackend> = await runCoreMlSelfTest<FakeBackend>(deps);
  if (result.kind !== "tested") throw new Error(`預期 tested，得到 ${result.kind}`);
  return result;
}

describe("自我測試的編排（runCoreMlSelfTest）", () => {
  it("通過：判定 usable、保留 CoreML session、寫下量測數字與兩邊的建置耗時", async () => {
    const { deps, decisionPath, created, disposed, pendingAtCoreMlLoad } = harness({
      buildMs: { cpu: 430, coreml: 12_600 },
      inferenceMs: { cpu: 100, coreml: 50 },
    });

    const result = await runTested(deps);

    // 先量 CPU（量完立刻釋放），再量 CoreML。
    expect(created).toEqual(["cpu", "coreml"]);
    expect(disposed).toEqual(["cpu"]);
    // 碰 CoreML 之前，磁碟上已經是 pending（崩潰防護的前提）。
    expect(pendingAtCoreMlLoad).toEqual(["pending"]);

    expect(result.record.outcome).toBe("usable");
    expect(result.record.throughputRatio).toBeCloseTo(2, 10);
    expect(result.record.minCosine).toBeCloseTo(1, 10);
    expect(result.record.testedAt).toBe("2026-10-16T12:00:00.000Z");
    expect(result.record.modelId).toBe(IDENTITY.modelId);
    expect(result.record.arch).toBe("arm64");
    // 建置耗時：CPU 與 CoreML 兩邊都記（純診斷數據）。
    expect(result.record.cpuSessionBuildMs).toBeCloseTo(430, 10);
    expect(result.record.coreMlSessionBuildMs).toBeCloseTo(12_600, 10);
    // 判定可用 → 把 session 交回去（呼叫端不必重編）。
    expect(result.backend?.device).toBe("coreml");
    expect(readDecisionRecord(decisionPath)).toEqual(result.record);
  });

  it("建置耗時不參與判準：CoreML 建置再久，只要推論夠快、向量一致就判 usable", async () => {
    // 建置 10 分鐘、推論仍是 CPU 的 2 倍快 → 門檻（吞吐／cos／RSS）全部通過。
    const { deps } = harness({
      buildMs: { cpu: 500, coreml: 600_000 },
      inferenceMs: { cpu: 100, coreml: 50 },
    });
    const result = await runTested(deps);
    expect(result.record.outcome).toBe("usable");
    expect(result.record.coreMlSessionBuildMs).toBeCloseTo(600_000, 10);
  });

  it("倍率剛好 1.3 通過；1.29 未達（門檻含邊界）", async () => {
    const exactly = harness({ inferenceMs: { cpu: 130, coreml: 100 } });
    expect((await runTested(exactly.deps)).record).toMatchObject({
      outcome: "usable",
    });

    const below = harness({ inferenceMs: { cpu: 129, coreml: 100 } });
    const belowResult = await runTested(below.deps);
    expect(belowResult.record.outcome).toBe("unusable");
    expect(belowResult.record.reason).toBe(SELF_TEST_REASONS.tooSlow);
    // 未通過的 CoreML session 必須被釋放，而且不交回呼叫端。
    expect(below.disposed).toEqual(["cpu", "coreml"]);
    expect(belowResult.backend).toBeNull();
    // 未通過時仍然記下兩邊的建置耗時（同樣是診斷數據）。
    expect(belowResult.record.cpuSessionBuildMs).toBeCloseTo(400, 10);
    expect(belowResult.record.coreMlSessionBuildMs).toBeCloseTo(12_000, 10);
  });

  it("向量不一致 → inconsistent，並記下量到的餘弦", async () => {
    const { deps, disposed } = harness({ drift: 0.05 });
    const result = await runTested(deps);
    expect(result.record.outcome).toBe("unusable");
    expect(result.record.reason).toBe(SELF_TEST_REASONS.inconsistent);
    // 兩個已正規化向量的內積＝餘弦：`1 / sqrt(1 + drift²)` ≈ 0.99875 < 0.999。
    expect(result.record.minCosine).toBeCloseTo(1 / Math.sqrt(1 + 0.05 ** 2), 6);
    expect(disposed).toContain("coreml");
  });

  it("峰值 RSS 超限 → memory-exceeded（即使倍率與一致性都過）", async () => {
    const { deps } = harness({ rss: [GIB, GIB, 7 * GIB, GIB] });
    const result = await runTested(deps);
    expect(result.record.outcome).toBe("unusable");
    expect(result.record.reason).toBe(SELF_TEST_REASONS.memoryExceeded);
  });

  it("CoreML 載入失敗 → load-failed，附上去識別化的訊息摘要", async () => {
    const { deps, decisionPath } = harness({ coremlLoadFails: true });
    const result = await runTested(deps);
    expect(result.record.outcome).toBe("unusable");
    expect(result.record.reason).toBe(SELF_TEST_REASONS.loadFailed);
    expect(result.record.throughputRatio).toBeUndefined();
    expect(result.backend).toBeNull();
    expect(result.message).toContain("CoreML 載入失敗（模擬）");
    // 沒有建好的 CoreML session → 不記它的建置耗時（欄位語意與名稱一致）；CPU 那邊照記。
    expect(result.record.coreMlSessionBuildMs).toBeUndefined();
    expect(result.record.cpuSessionBuildMs).toBeCloseTo(400, 10);
    // 記錄不含原始訊息（只有穩定標籤），重啟後仍安全。
    expect(JSON.stringify(readDecisionRecord(decisionPath))).not.toContain("模擬");
  });

  it("CoreML 載入成功但推論失敗 → inference-failed（與載入失敗分得開），建置耗時照記", async () => {
    const { deps } = harness({ coremlEmbedFails: true, buildMs: { cpu: 380, coreml: 9_500 } });
    const result = await runTested(deps);
    expect(result.record.reason).toBe(SELF_TEST_REASONS.inferenceFailed);
    expect(result.message).toContain("CoreML 推論失敗（模擬）");
    // session 建起來了（推論才失敗）→ 建置耗時有值。
    expect(result.record.coreMlSessionBuildMs).toBeCloseTo(9_500, 10);
  });

  it("CPU 基準載入失敗：往外拋（沒有可退的地方），pending(self-test) 留在磁碟上由呼叫端改寫", async () => {
    const { deps, decisionPath, created } = harness({ cpuLoadFails: true });
    await expect(runCoreMlSelfTest<FakeBackend>(deps)).rejects.toThrow("CPU 載入失敗（模擬）");
    expect(created).toEqual(["cpu"]);
    // 呼叫端（embedder）負責把 pending 改成 unusable：否則下次啟動會誤記成崩潰。
    const leftover = readDecisionRecord(decisionPath);
    expect(leftover?.outcome).toBe("pending");
    expect(leftover?.pendingPhase).toBe("self-test");
  });

  it("marker 寫不進去就不碰 CoreML：回 unavailable、沒有建立任何 session", async () => {
    const dir = tempDir();
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "not a directory", "utf8");
    const { deps, created } = harness({ decisionPath: join(blocker, "device-decision.json") });

    const result = await runCoreMlSelfTest<FakeBackend>(deps);
    expect(result).toEqual({ kind: "unavailable", reason: "marker-write-failed" });
    // 保護鏈的前提不存在 → 完全不碰模型（連 CPU 基準都不做）。
    expect(created).toEqual([]);
  });

  it("marker 寫得進去、最終決定寫不進去：仍回傳 tested 的決定（快取只是加速，不是正確性來源）", async () => {
    const { deps } = harness({ failFinalWrite: true });
    const result = await runTested(deps);
    expect(result.record.outcome).toBe("usable");
    expect(result.backend?.device).toBe("coreml");
  });
});
