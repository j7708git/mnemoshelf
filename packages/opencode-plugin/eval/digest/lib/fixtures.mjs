/**
 * fixture 載入與規則驗證（給 runner 與測試共用）。
 *
 * 驗證的用意：比對規則寫死在 `text.mjs`，fixture 就必須符合它——針太短、期望針不在
 * 對話裡、隱私樣式命中，都在載入時直接失敗，而不是跑完才發現量測沒有意義。
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { MIN_NEEDLE_CHARS, needleLength, normalizeForMatch } from "./text.mjs";

/** fixture／報告的隱私掃描（與 L1／L2 的 forbidden regex 清單一致）。 */
export const FORBIDDEN_PATTERNS = [
  { name: "email", regex: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/u },
  { name: "api-key", regex: /\bsk-[A-Za-z0-9_-]{8,}/u },
  { name: "home-path", regex: /\/(?:home|Users)\/[^/\s"'`]+/u },
  { name: "windows-user-path", regex: /[A-Za-z]:\\Users\\[^\\\s"'`]+/u },
];

/** 掃描一段文字，回傳命中的樣式名稱。 */
export function privacyFindings(text) {
  return FORBIDDEN_PATTERNS.filter((pattern) => pattern.regex.test(String(text))).map((pattern) => pattern.name);
}

export async function loadFixtures(fixtureDir) {
  const conversationsText = await fs.readFile(path.join(fixtureDir, "conversations.json"), "utf8");
  const expectationsText = await fs.readFile(path.join(fixtureDir, "digest-expectations.json"), "utf8");
  const conversations = JSON.parse(conversationsText);
  const expectations = JSON.parse(expectationsText);
  const problems = [];

  const turns = Array.isArray(conversations.turns) ? conversations.turns : [];
  if (turns.length !== 30) problems.push(`conversations.json 應有 30 回合，實際 ${turns.length}`);

  const byId = new Map(turns.map((turn) => [turn.id, turn]));
  for (const turn of turns) {
    if (typeof turn.id !== "string" || turn.id === "") problems.push("有回合缺少 id");
    if (turn.mode !== "normal" && turn.mode !== "syntheticOnly") {
      problems.push(`${turn.id}：mode 只能是 normal／syntheticOnly`);
    }
    if (typeof turn.user !== "string" || typeof turn.assistant !== "string") {
      problems.push(`${turn.id}：缺少 user／assistant 文字`);
    }
  }

  for (const [id, expectation] of Object.entries(expectations.turns ?? {})) {
    if (!byId.has(id)) problems.push(`expectations 有未知回合：${id}`);
    const source = byId.get(id);
    const sourceText = source === undefined ? "" : `${source.user}\n${source.assistant}`;
    const mustNotInclude = expectation.mustNotInclude ?? [];
    const needles = [
      ...(expectation.mustInclude ?? []),
      ...mustNotInclude,
      ...(expectation.expectedItems ?? []).map((item) => item.contains),
      ...(typeof expectation.recallMarker === "string" ? [expectation.recallMarker] : []),
    ];
    for (const needle of needles) {
      if (typeof needle !== "string" || needleLength(needle) < MIN_NEEDLE_CHARS) {
        problems.push(`${id}：針「${needle}」正規化後不足 ${MIN_NEEDLE_CHARS} 字`);
        continue;
      }
      // mustNotInclude 是「不得出現」的字串，本來就不一定在本文；其餘必須能在對話裡找到。
      if (!mustNotInclude.includes(needle) && !normalizeForMatch(sourceText).includes(normalizeForMatch(needle))) {
        problems.push(`${id}：期望針「${needle}」不在對話原文中`);
      }
    }
    if (expectation.expectSkip !== undefined && expectation.expectEmpty !== true) {
      problems.push(`${id}：有 expectSkip 的回合必須同時標 expectEmpty=true`);
    }
  }

  for (const pattern of FORBIDDEN_PATTERNS) {
    for (const [name, text] of [
      ["conversations.json", conversationsText],
      ["digest-expectations.json", expectationsText],
    ]) {
      if (pattern.regex.test(text)) problems.push(`${name} 命中隱私樣式 ${pattern.name}`);
    }
  }

  if (problems.length > 0) {
    throw new Error(`fixture 驗證失敗：\n- ${problems.join("\n- ")}`);
  }

  const fingerprint = createHash("sha256")
    .update(conversationsText)
    .update(expectationsText)
    .digest("hex")
    .slice(0, 12);

  return {
    conversations,
    expectations,
    turns: turns.length,
    version: `${conversations.version ?? "?"}+${expectations.version ?? "?"}`,
    fingerprint,
  };
}

/** 依期望值估算模型呼叫次數（跳過的回合不會呼叫）。 */
export function estimateModelCalls(fixtures) {
  return fixtures.conversations.turns.filter((turn) => {
    const expectation = fixtures.expectations.turns[turn.id] ?? {};
    return expectation.expectEmpty !== true;
  }).length;
}
