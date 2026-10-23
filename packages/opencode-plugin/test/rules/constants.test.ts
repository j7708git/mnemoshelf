/**
 * 對話記憶的常數鎖（L1）。
 *
 * 這些值不是「順手寫死的魔法數字」：每一個都對應一次實際事故或一條產品契約。
 * 本檔把 `src/` 的常數與設定預設值逐條釘住；只要有人無聲改動，測試就會紅並說出
 * 「哪個常數從 X 變成 Y」。
 *
 * 邊界：本檔只讀產品碼，不修改任何東西，也不啟動 server／模型。
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_SETTINGS,
  DEFAULT_DIGEST_TIMEOUT_MS,
  DEFAULT_RECENT_TURNS,
  DIGEST_TIMEOUT_MAX_MS,
  DIGEST_TIMEOUT_MIN_MS,
  RECENT_TURNS_MAX,
  readSettings,
} from "../../src/config.js";
import {
  DIGEST_AGENT,
  DIGEST_KINDS,
  DIGEST_TIMEOUT_MS,
  DIGEST_TURN_AGENT,
  MAX_DIGEST_ITEMS,
  MAX_TURN_CONTENT_CHARS,
  MIN_DIGEST_TURN_CHARS,
} from "../../src/digest.js";

/** 讓失敗訊息直接說明「哪個常數從 X 變成 Y」。 */
function fmt(value: unknown): string {
  return typeof value === "string" ? `"${value}"` : JSON.stringify(value);
}

function lockConstant(name: string, actual: unknown, expected: unknown): void {
  expect(
    actual,
    `常數 ${name} 從 ${fmt(expected)} 變成 ${fmt(actual)}；若這是刻意的規則變更，請同步更新 docs 與本測試。`,
  ).toEqual(expected);
}

describe("digest 常數鎖", () => {
  it("寫入 timeout 固定 8 秒（DIGEST_TIMEOUT_MS）", () => {
    lockConstant("DIGEST_TIMEOUT_MS", DIGEST_TIMEOUT_MS, 8000);
  });

  it("模型 timeout 預設 45 秒，且合法範圍是 3000–120000（DEFAULT_DIGEST_TIMEOUT_MS）", () => {
    lockConstant("DEFAULT_DIGEST_TIMEOUT_MS", DEFAULT_DIGEST_TIMEOUT_MS, 45000);
    lockConstant("DIGEST_TIMEOUT_MIN_MS", DIGEST_TIMEOUT_MIN_MS, 3000);
    lockConstant("DIGEST_TIMEOUT_MAX_MS", DIGEST_TIMEOUT_MAX_MS, 120000);
    expect(
      DEFAULT_DIGEST_TIMEOUT_MS,
      `DEFAULT_DIGEST_TIMEOUT_MS 必須落在 ${DIGEST_TIMEOUT_MIN_MS}–${DIGEST_TIMEOUT_MAX_MS} 之間，實際 ${DEFAULT_DIGEST_TIMEOUT_MS}`,
    ).toBeGreaterThanOrEqual(DIGEST_TIMEOUT_MIN_MS);
    expect(
      DEFAULT_DIGEST_TIMEOUT_MS,
      `DEFAULT_DIGEST_TIMEOUT_MS 必須落在 ${DIGEST_TIMEOUT_MIN_MS}–${DIGEST_TIMEOUT_MAX_MS} 之間，實際 ${DEFAULT_DIGEST_TIMEOUT_MS}`,
    ).toBeLessThanOrEqual(DIGEST_TIMEOUT_MAX_MS);
  });

  it("回合內容門檻為 40 字（MIN_DIGEST_TURN_CHARS）", () => {
    lockConstant("MIN_DIGEST_TURN_CHARS", MIN_DIGEST_TURN_CHARS, 40);
  });

  it("每回合最多 2 則原子記憶（MAX_DIGEST_ITEMS）", () => {
    lockConstant("MAX_DIGEST_ITEMS", MAX_DIGEST_ITEMS, 2);
  });

  it("回合紀錄內容上限 300 字（MAX_TURN_CONTENT_CHARS）", () => {
    lockConstant("MAX_TURN_CONTENT_CHARS", MAX_TURN_CONTENT_CHARS, 300);
  });

  it("agent 標記固定：回合紀錄是 opencode-plugin/turn、一般卡是 opencode-plugin", () => {
    lockConstant("DIGEST_TURN_AGENT", DIGEST_TURN_AGENT, "opencode-plugin/turn");
    lockConstant("DIGEST_AGENT", DIGEST_AGENT, "opencode-plugin");
    // 回合紀錄必須能被「只看自動寫入」的篩選看到，所以要用同一個前綴。
    expect(DIGEST_TURN_AGENT.startsWith(`${DIGEST_AGENT}/`)).toBe(true);
  });

  it("DIGEST_KINDS 固定四種且順序固定", () => {
    lockConstant("DIGEST_KINDS", [...DIGEST_KINDS], ["decision", "pitfall", "fact", "preference"]);
  });
});

describe("召回與 digest 設定預設值鎖", () => {
  it("minScore 預設 0.65", () => {
    lockConstant("DEFAULT_SETTINGS.minScore", DEFAULT_SETTINGS.minScore, 0.65);
  });

  it("dedupeTTL 預設 8（範圍 8–10）", () => {
    lockConstant("DEFAULT_SETTINGS.dedupeTTL", DEFAULT_SETTINGS.dedupeTTL, 8);
    lockConstant("DEFAULT_SETTINGS.dedupeTTL 下限", readSettings({ dedupeTTL: 7 }).dedupeTTL, 8);
    lockConstant("DEFAULT_SETTINGS.dedupeTTL 上限", readSettings({ dedupeTTL: 11 }).dedupeTTL, 10);
  });

  it("recentTurns 預設 3（範圍 0–5）", () => {
    lockConstant("DEFAULT_RECENT_TURNS", DEFAULT_RECENT_TURNS, 3);
    lockConstant("RECENT_TURNS_MAX", RECENT_TURNS_MAX, 5);
    lockConstant("DEFAULT_SETTINGS.recentTurns", DEFAULT_SETTINGS.recentTurns, 3);
  });

  it("maxItems 預設 4、kMax 預設 8", () => {
    lockConstant("DEFAULT_SETTINGS.maxItems", DEFAULT_SETTINGS.maxItems, 4);
    lockConstant("DEFAULT_SETTINGS.kMax", DEFAULT_SETTINGS.kMax, 8);
  });

  it("digestMaxPerTurn 預設 3（範圍 0–5）", () => {
    lockConstant("DEFAULT_SETTINGS.digestMaxPerTurn", DEFAULT_SETTINGS.digestMaxPerTurn, 3);
    lockConstant("digestMaxPerTurn 下限", readSettings({ digestMaxPerTurn: -1 }).digestMaxPerTurn, 0);
    lockConstant("digestMaxPerTurn 上限", readSettings({ digestMaxPerTurn: 6 }).digestMaxPerTurn, 5);
  });

  it("digestMaxPerSession 預設 20、上限 100", () => {
    lockConstant("DEFAULT_SETTINGS.digestMaxPerSession", DEFAULT_SETTINGS.digestMaxPerSession, 20);
    lockConstant("digestMaxPerSession 下限", readSettings({ digestMaxPerSession: -1 }).digestMaxPerSession, 0);
    lockConstant("digestMaxPerSession 上限", readSettings({ digestMaxPerSession: 500 }).digestMaxPerSession, 100);
  });

  it("digestMaxPerDay 預設 100、上限 1000", () => {
    lockConstant("DEFAULT_SETTINGS.digestMaxPerDay", DEFAULT_SETTINGS.digestMaxPerDay, 100);
    lockConstant("digestMaxPerDay 下限", readSettings({ digestMaxPerDay: -1 }).digestMaxPerDay, 0);
    lockConstant("digestMaxPerDay 上限", readSettings({ digestMaxPerDay: 5000 }).digestMaxPerDay, 1000);
  });

  it("digestTimeoutMs 預設等於模型 timeout 常數", () => {
    lockConstant("DEFAULT_SETTINGS.digestTimeoutMs", DEFAULT_SETTINGS.digestTimeoutMs, DEFAULT_DIGEST_TIMEOUT_MS);
  });

  it("readSettings({}) 的結果與 DEFAULT_SETTINGS 完全一致（避免兩份預設值漂移）", () => {
    // 逐鍵比對：失敗訊息會指出是哪個鍵不一致，比單純 toEqual 的 diff 好讀。
    const parsed = readSettings({});
    for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof typeof DEFAULT_SETTINGS)[]) {
      lockConstant(`readSettings({}).${key}`, parsed[key], DEFAULT_SETTINGS[key]);
    }
    expect(parsed).toEqual({ ...DEFAULT_SETTINGS });
  });
});

describe("設定範圍鎖（超出範圍一律夾住，不是靜默接受）", () => {
  it("recentTurns 夾在 0–5（0＝關閉回合筆數限制的查詢）", () => {
    lockConstant("recentTurns(-1)", readSettings({ recentTurns: -1 }).recentTurns, 0);
    lockConstant("recentTurns(0)", readSettings({ recentTurns: 0 }).recentTurns, 0);
    lockConstant("recentTurns(5)", readSettings({ recentTurns: 5 }).recentTurns, 5);
    lockConstant("recentTurns(9)", readSettings({ recentTurns: 9 }).recentTurns, 5);
  });

  it("digestTimeoutMs 夾在 3000–120000", () => {
    lockConstant("digestTimeoutMs(1000)", readSettings({ digestTimeoutMs: 1000 }).digestTimeoutMs, 3000);
    lockConstant("digestTimeoutMs(3000)", readSettings({ digestTimeoutMs: 3000 }).digestTimeoutMs, 3000);
    lockConstant("digestTimeoutMs(120000)", readSettings({ digestTimeoutMs: 120000 }).digestTimeoutMs, 120000);
    lockConstant("digestTimeoutMs(999999)", readSettings({ digestTimeoutMs: 999999 }).digestTimeoutMs, 120000);
  });

  it("minScore 夾在 0–1，maxItems 夾在 1–8", () => {
    lockConstant("minScore(-1)", readSettings({ minScore: -1 }).minScore, 0);
    lockConstant("minScore(2)", readSettings({ minScore: 2 }).minScore, 1);
    lockConstant("maxItems(0)", readSettings({ maxItems: 0 }).maxItems, 1);
    lockConstant("maxItems(99)", readSettings({ maxItems: 99 }).maxItems, 8);
  });

  it("kMax 夾在 1–20", () => {
    lockConstant("kMax(0)", readSettings({ kMax: 0 }).kMax, 1);
    lockConstant("kMax(99)", readSettings({ kMax: 99 }).kMax, 20);
  });

  it("digest 配額之外的鍵回退預設：digestEnabled 預設關閉", () => {
    lockConstant("DEFAULT_SETTINGS.digestEnabled", DEFAULT_SETTINGS.digestEnabled, false);
    lockConstant("digestEnabled('yes')", readSettings({ digestEnabled: "yes" }).digestEnabled, false);
    lockConstant("digestEnabled(true)", readSettings({ digestEnabled: true }).digestEnabled, true);
  });
});
