/**
 * L3 管線：假宿主 ＋ 真 server，逐回合跑完整條 digest 流程。
 *
 * `resolveDigestTurn` → `buildDigestPrompt` → 模型 → `parseDigestItems` →
 * `buildDigestCards` → `writeDigestMemory` → follow-up 召回。
 *
 * 卡片「真的會寫什麼」以 runtime 的 POST 內容為準；`buildDigestCards()` 的輸出同時被拿來
 * 比對同一批 POST（parity），所以 harness 不需要自己模仿一份組卡邏輯。
 */
import path from "node:path";
import { promises as fs } from "node:fs";
import { pathToFileURL } from "node:url";

import {
  assistantMessage,
  createHost,
  DIGEST_MODEL,
  injectedBlock,
  userMessage,
} from "../../loop/host.mjs";
import { listMemories, searchMemories, seedMemory, waitForReady } from "../../loop/server.mjs";
import { evaluateTurn } from "./metrics.mjs";
import { includesNeedle } from "./text.mjs";

/** digest 場景的 plugin options（production digestTimeoutMs 口徑）。 */
export const DIGEST_SETTINGS = {
  trigger: "first-turn+explicit",
  recentTurns: 3,
  minScore: 0.4,
  kMax: 8,
  maxItems: 4,
  dedupeTTL: 8,
  // 召回 timeout 放寬：這張卡量的是摘要品質，不是 150ms 的延遲邊界。
  timeoutMs: 1000,
  digestEnabled: true,
  digestModel: DIGEST_MODEL,
};

/** 只做召回（digest 關閉）的 plugin options。 */
export const RECALL_ONLY_SETTINGS = {
  ...DIGEST_SETTINGS,
  digestEnabled: false,
};

/** 動態載入建置產物（run.mjs 已先做 dist 新鮮度檢查）。 */
export async function loadDistDigest(packageDir) {
  return import(pathToFileURL(path.join(packageDir, "dist", "digest.js")).href);
}

function syntheticUser(id, text) {
  return { ...userMessage(id, text), type: "synthetic" };
}

/** 從模型原始輸出數 items 陣列長度（超限時 parser 會 break，不能靠 rejected 反推）。 */
export function countRawItems(raw) {
  if (typeof raw !== "string") return 0;
  const trimmed = raw.trim();
  const fenced = /^```(?:json|JSON)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  const body = fenced !== null && typeof fenced[1] === "string" ? fenced[1].trim() : trimmed;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return 0;
  try {
    const parsed = JSON.parse(body.slice(start, end + 1));
    return Array.isArray(parsed?.items) ? parsed.items.length : 0;
  } catch {
    return 0;
  }
}

/** runtime 實際 POST 的 payload（與 `postMemory` 的欄位一致）。 */
export function digestPostBody(card, { sessionID, messageID, project }) {
  return {
    content: card.item.content,
    kind: card.item.kind,
    scope: "project",
    project,
    agent: card.agent,
    sourceSession: sessionID,
    sourceMessage: messageID,
    ...(card.force === true ? { force: true } : {}),
  };
}

function stableBody(body) {
  return JSON.stringify(body);
}

/** 讀 digest.log 的新增行（每次 dispatch 一筆）。 */
async function newDigestEntries(host, cursor) {
  const lines = await host.readDigestLines();
  const entries = [];
  for (const line of lines.slice(cursor)) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      entries.push({ parseError: true });
    }
  }
  return { entries, cursor: lines.length };
}

/**
 * 跑完整條 L3 管線。
 *
 * @returns {Promise<object>} 逐回合結果、parity、召回、cross-project 檢查與 cleanup 參照
 */
export async function runDigestPipeline(input) {
  const {
    client,
    baseUrl,
    token,
    tmpRoot,
    logDir,
    conversations,
    expectations,
    modelRunner,
    project = "alpha",
    foreignProject = "beta",
    onHost,
  } = input;
  const digest = await loadDistDigest(input.packageDir);
  const settings = DIGEST_SETTINGS;
  const sessionID = `${project}-session`;
  const modelLatencies = [];

  const projectDir = path.join(tmpRoot, project);
  const foreignDir = path.join(tmpRoot, foreignProject);
  await fs.mkdir(projectDir, { recursive: true });
  await fs.mkdir(foreignDir, { recursive: true });

  const host = await createHost({
    name: project,
    directory: projectDir,
    baseUrl,
    token,
    settings,
    logFile: path.join(logDir, `digest-${project}.log`),
    home: path.join(tmpRoot, "home"),
    canned: async (prompt, meta = {}) => {
      const output = await modelRunner.call(prompt, meta);
      modelLatencies.push(output.latencyMs);
      return { text: output.text };
    },
  });
  onHost?.(host);

  const turnResults = [];
  const attemptLatencies = [];
  let cursor = 0;

  for (const turn of conversations.turns) {
    if (turn.mode === "syntheticOnly") {
      host.appendMessage(sessionID, syntheticUser(`su-${turn.id}`, turn.user));
      host.appendMessage(sessionID, assistantMessage(`sa-${turn.id}`, turn.assistant));
    } else {
      host.pushTurn(sessionID, turn.user, turn.assistant);
    }
    const postsBefore = host.posts.length;
    const callsBefore = modelRunner.calls.length;
    const attemptsBefore = Array.isArray(modelRunner.attempts) ? modelRunner.attempts.length : null;
    const started = Date.now();
    await host.settle(sessionID);
    const latencyMs = Date.now() - started;

    const log = await newDigestEntries(host, cursor);
    cursor = log.cursor;
    const entry = log.entries.at(-1) ?? { parseError: true };
    const outcome =
      entry.state === "ok" ? "digested" : entry.state === "failed" ? "failed" : "skipped";

    // 本回合的模型原始輸出（跳過的回合不會呼叫模型）。
    //
    // `attempts` 只在矩陣 runner 提供（含失敗的嘗試）；L3 的 runner 沒有這個欄位時，
    // 退回原本只看成功呼叫的 `calls`，行為與 L3 完全一致。
    const records =
      attemptsBefore === null
        ? modelRunner.calls.slice(callsBefore)
        : modelRunner.attempts.slice(attemptsBefore);
    for (const record of records) {
      if (Number.isFinite(record?.latencyMs)) attemptLatencies.push(record.latencyMs);
    }
    const successful = records.filter((record) => record?.ok !== false);
    const raw = successful.length > 0 ? successful[0].text : "";
    const modelCalled = records.length > 0;

    // 用產品自己的解析與組卡邏輯，取得「應該送出的卡片」。
    const snapshot = host.messagesFor(sessionID);
    const resolved = digest.resolveDigestTurn(snapshot);
    let parsed = null;
    let cards = [];
    let parseError = null;
    let rejected = 0;
    let rawItemCount = 0;
    let keptItemCount = 0;
    let sourceText = "";
    if (!("skip" in resolved) && raw !== "") {
      sourceText = resolved.turn.sourceText;
      parsed = digest.parseDigestItems(raw, sourceText, digest.MAX_DIGEST_ITEMS);
      parseError = parsed.error ?? null;
      rejected = parsed.rejected;
      rawItemCount = countRawItems(raw);
      keptItemCount = parsed.items.length;
      cards = digest.buildDigestCards(parsed);
    }

    // 實際 POST 內容 vs buildDigestCards 的輸出（同一回合、同一順序）。
    const actualPosts = host.posts
      .slice(postsBefore)
      .filter((post) => typeof post.body?.agent === "string" && post.body.agent.startsWith("opencode-plugin"));
    let parityOk = true;
    let parityDetail = null;
    if (!("skip" in resolved)) {
      const messageID = resolved.turn.assistantMessageID;
      const expectedBodies = cards.map((card) =>
        digestPostBody(card, { sessionID, messageID, project }),
      );
      const actualBodies = actualPosts.map((post) => post.body);
      parityOk =
        expectedBodies.length === actualBodies.length &&
        expectedBodies.every((body, index) => stableBody(body) === stableBody(actualBodies[index]));
      if (!parityOk) {
        parityDetail = {
          expectedCount: expectedBodies.length,
          actualCount: actualBodies.length,
          expected: expectedBodies.map((body) => ({ agent: body.agent, kind: body.kind, force: body.force === true })),
          actual: actualBodies.map((body) => ({ agent: body.agent, kind: body.kind, force: body.force === true })),
        };
      }
    }

    const turnCard = actualPosts.find((post) => post.body.agent === "opencode-plugin/turn");
    const itemPosts = actualPosts.filter((post) => post.body.agent === "opencode-plugin");
    turnResults.push({
      id: turn.id,
      outcome,
      skipReason:
        entry.state === "skipped" ? (entry.reason ?? null) : entry.state === "failed" ? (entry.reason ?? null) : null,
      written: entry.state === "ok" ? (entry.written ?? 0) : 0,
      turnContent: typeof turnCard?.body.content === "string" ? turnCard.body.content : null,
      turnCardWritten: turnCard !== undefined,
      atomicItemsWritten: itemPosts.length,
      items: itemPosts.map((post) => ({ content: String(post.body.content ?? ""), kind: String(post.body.kind ?? "") })),
      modelCalled,
      modelOutputPresent: raw !== "",
      crossProjectHit: false,
      rawItemCount,
      keptItemCount,
      rejected,
      parseError,
      latencyMs,
      recall: null,
      parity: { ok: parityOk, ...(parityDetail === null ? {} : { detail: parityDetail }) },
    });
  }

  // follow-up 召回：查詢命中 + 實際注入。
  //
  // 重要：先等所有新寫入的記憶向量就緒。否則查詢會退回關鍵字（`degraded`），
  // 量到的就不是語意召回，而且**不會有任何錯誤**——寧可等，也不要靜默量錯。
  const vectorReadiness = await waitForReady(client, 180000);
  if (vectorReadiness.gate !== "passed") {
    throw new Error(
      `召回前的向量就緒閘門逾時（pending=${vectorReadiness.final?.pending} failed=${vectorReadiness.final?.failed} stale=${vectorReadiness.final?.stale}）；` +
        "拒絕在向量未就緒時量端到端召回。",
    );
  }

  for (const result of turnResults) {
    const expectation = expectations.turns[result.id] ?? {};
    if (typeof expectation.recallQuery !== "string" || typeof expectation.recallMarker !== "string") continue;
    const search = await searchMemories(client, {
      query: expectation.recallQuery,
      project,
      k: 8,
      minScore: 0.4,
    });
    let rank = null;
    for (let index = 0; index < search.hits.length; index += 1) {
      if (includesNeedle(search.hits[index].content, expectation.recallMarker)) {
        rank = index + 1;
        break;
      }
    }
    const event = await host.recall({ sessionID: `digest-recall-${result.id}`, text: expectation.recallQuery });
    const block = injectedBlock(event);
    result.recall = {
      queryHit: rank !== null,
      rank,
      injected: includesNeedle(block, expectation.recallMarker),
      degraded: search.degraded === true,
      degradedReason: search.degradedReason ?? null,
    };
  }

  // 內容層的跨專案洩漏：其他專案的標記出現在本專案的輸出。
  //
  // 逐回合標註（只記回合 id，不落地任何文字）：報告要能回答「哪個回合出事」。
  const cross = expectations.crossProject ?? {};
  const foreignMarker = typeof cross.foreignMarker === "string" ? cross.foreignMarker : "";
  const crossProjectHitIds = [];
  for (const result of turnResults) {
    const hit =
      (result.turnContent !== null && includesNeedle(result.turnContent, foreignMarker)) ||
      result.items.some((item) => includesNeedle(item.content, foreignMarker));
    result.crossProjectHit = hit;
    if (hit) crossProjectHitIds.push(result.id);
  }
  const contentLeaks = crossProjectHitIds.length;

  // scope 層的跨專案洩漏：從 foreign 專案召回／列出時看得到本專案內容。
  const foreign = await createHost({
    name: foreignProject,
    directory: foreignDir,
    baseUrl,
    token,
    settings: RECALL_ONLY_SETTINGS,
    logFile: path.join(logDir, `digest-${foreignProject}.log`),
    home: path.join(tmpRoot, "home"),
  });
  onHost?.(foreign);
  const foreignSeed = "FOREIGN-SCOPE-CARD：其他專案自己的排程設定，只給 scope 隔離檢查用。";
  await seedMemory(client, {
    content: foreignSeed,
    kind: "fact",
    scope: "project",
    project: foreignProject,
    agent: "user",
  });
  const forbidden = Array.isArray(cross.forbiddenInForeignScope) ? cross.forbiddenInForeignScope : [];
  let scopeLeaks = 0;
  let foreignBlockSeen = false;
  for (let index = 0; index < (cross.queries ?? []).length; index += 1) {
    const query = cross.queries[index];
    const event = await foreign.recall({ sessionID: `digest-foreign-${index}`, text: query });
    const block = injectedBlock(event);
    if (includesNeedle(block, foreignSeed)) foreignBlockSeen = true;
    for (const marker of forbidden) {
      if (includesNeedle(block, marker)) scopeLeaks += 1;
    }
  }
  const foreignMemories = await listMemories(client, { scope: "project", project: foreignProject });
  for (const memory of foreignMemories) {
    for (const marker of forbidden) {
      if (includesNeedle(String(memory.content ?? ""), marker)) scopeLeaks += 1;
    }
  }

  const evaluated = turnResults.map((result) =>
    evaluateTurn({
      id: result.id,
      expectation: expectations.turns[result.id] ?? {},
      actual: result,
    }),
  );
  // 召回結果掛回 evaluated（metrics 需要）。
  for (const turn of evaluated) {
    const source = turnResults.find((result) => result.id === turn.id);
    turn.recall = source?.recall ?? null;
  }

  return {
    turns: evaluated,
    rawTurns: turnResults,
    parity: {
      ok: turnResults.every((result) => result.parity.ok),
      mismatches: turnResults.filter((result) => !result.parity.ok).map((result) => ({
        id: result.id,
        ...result.parity.detail,
      })),
    },
    crossProject: {
      contentLeaks,
      crossProjectHitIds,
      scopeLeaks,
      total: contentLeaks + scopeLeaks,
      foreignBlockSeen,
      foreignMemories: foreignMemories.length,
    },
    vectorReadiness: {
      gate: vectorReadiness.gate,
      waitedMs: vectorReadiness.waitedMs,
      polls: vectorReadiness.polls,
    },
    recallDegraded: turnResults.filter((result) => result.recall?.degraded === true).length,
    modelLatencies,
    attemptLatencies,
    modelCalls: modelRunner.callCount,
    host,
    foreignHost: foreign,
  };
}
