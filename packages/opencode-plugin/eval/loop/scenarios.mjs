/**
 * L2 迴圈 harness 的場景。
 *
 * 每個場景都有獨立名稱與明確的預期值；報告逐條對應九條斷言。
 * 共用世界：alpha／beta／global chat 三個實例先跑完 digest 回合，後面的召回場景再重用
 * 它們的卡片；需要乾淨狀態的場景各自建立新實例。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import { createChecks, sameSet, uniqueValues } from "./checks.mjs";
import {
  assistantMessage,
  cannedBadJsonResponse,
  cannedEmptyResponse,
  cannedFixedTurnResponse,
  cannedTurnResponse,
  createHost,
  DIGEST_MODEL,
  injectedBlock,
  turnAssistant,
  turnUser,
  userMessage,
} from "./host.mjs";
import {
  listMemories,
  searchMemories,
  seedMemory,
  waitForReady,
} from "./server.mjs";

/** 聊天 session 目錄的固定 uuid（v4 形狀；不是任何人的真實 session）。 */
const CHAT_UUID = "4f1c2f0e-9a1b-4c3d-8e2f-1a2b3c4d5e6f";
const CHAT_DATE = "2026-10-23";

/** digest 相關場景的 plugin options。 */
const DIGEST_SETTINGS = {
  trigger: "first-turn+explicit",
  recentTurns: 3,
  minScore: 0.4,
  digestEnabled: true,
  digestModel: DIGEST_MODEL,
};

/** 只測召回的場景（digest 關閉，不訂閱事件）。 */
const RECALL_SETTINGS = {
  trigger: "first-turn+explicit",
  recentTurns: 3,
  minScore: 0.4,
  kMax: 8,
  maxItems: 4,
  dedupeTTL: 8,
  // 召回 timeout 刻意放寬：這張卡量的是行為，不是 150ms 的延遲邊界。
  timeoutMs: 1000,
  digestEnabled: false,
};

/** fail-open 的搜尋逾時案例要回到外掛預設的 150ms，才真的會觸發 timeout。 */
const FAIL_OPEN_TIMEOUT_SETTINGS = { ...RECALL_SETTINGS, timeoutMs: 150 };

function extractToken(text) {
  const match = /TURN-[A-Z0-9]+(?:-[A-Z0-9]+)*/.exec(String(text));
  return match === null ? null : match[0];
}

function turnLines(block) {
  return block.split("\n").filter((line) => line.startsWith("- [turn]"));
}

async function digestEntries(host) {
  const lines = await host.readDigestLines();
  const entries = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      entries.push({ parseError: true, rawLength: line.length });
    }
  }
  return entries;
}

/**
 * 建立共用世界並執行所有場景。
 *
 * @returns {Promise<{ cases: object[], readiness: object, hosts: object[], token: string }>}
 */
export async function runScenarios({ client, baseUrl, token, tmpRoot, logDir, fault, sanitize, onHost }) {
  const root = sanitize ?? ((value) => value);
  const hosts = [];
  const usedNames = new Set();
  const directories = new Map();

  await fs.mkdir(path.join(tmpRoot, "home"), { recursive: true });

  async function projectDirectory(name) {
    if (!directories.has(name)) {
      const dir = path.join(tmpRoot, name);
      await fs.mkdir(dir, { recursive: true });
      directories.set(name, await fs.realpath(dir));
    }
    return directories.get(name);
  }

  async function chatDirectory() {
    if (!directories.has("__chat")) {
      const dir = path.join(tmpRoot, "openchamber", "chats", CHAT_DATE, `session-${CHAT_UUID}`);
      await fs.mkdir(dir, { recursive: true });
      directories.set("__chat", await fs.realpath(dir));
    }
    return directories.get("__chat");
  }

  async function makeHost(name, options = {}) {
    if (usedNames.has(name)) throw new Error(`重複的宿主名稱：${name}`);
    usedNames.add(name);
    const directory = options.chat === true ? await chatDirectory() : await projectDirectory(options.project ?? name);
    const settings = options.settings ?? DIGEST_SETTINGS;
    const host = await createHost({
      name,
      directory,
      chat: options.chat === true,
      baseUrl,
      token,
      settings,
      logFile: path.join(logDir, `digest-${name}.log`),
      home: path.join(tmpRoot, "home"),
      canned: options.canned ?? cannedTurnResponse,
      delayMs: options.delayMs ?? 0,
      modelList: options.modelList ?? "ok",
      sessionGetDirectory: options.sessionGetDirectory ?? null,
      parentID: options.parentID ?? null,
      fault,
      ignoreFault: options.ignoreFault === true,
      fetchFault: options.fetchFault ?? null,
      digestTimeoutMs: options.digestTimeoutMs,
    });
    hosts.push(host);
    if (typeof onHost === "function") onHost(host);
    return host;
  }

  /* ---------------------------------------------------------------- *
   * 共用世界：三個實例 ＋ 召回用的合成卡（全部在就緒閘門前灌入）
   * ---------------------------------------------------------------- */

  const alpha = await makeHost("alpha", { project: "alpha", settings: DIGEST_SETTINGS });
  const beta = await makeHost("beta", { project: "beta", settings: DIGEST_SETTINGS });
  const chat = await makeHost("chat", { chat: true, settings: DIGEST_SETTINGS });

  async function runTurns(host, sessionID, prefix, count) {
    for (let index = 1; index <= count; index += 1) {
      const token = `TURN-${prefix}-${String(index).padStart(2, "0")}`;
      host.pushTurn(sessionID, turnUser(token), turnAssistant(token));
      await host.settle(sessionID);
    }
  }

  await runTurns(alpha, "alpha-s1", "ALPHA", 15);
  await runTurns(beta, "beta-s1", "BETA", 15);
  await runTurns(chat, "chat-s1", "CHAT", 6);

  // 召回場景的合成卡（不經 digest，直接灌進真 server）。
  const globalCard = await seedMemory(
    client,
    {
      content: "GLOBAL-SCOPE-CARD：所有專案共用的版本發布檢查清單，包含測試、打包與回滾演練。",
      kind: "fact",
      scope: "global",
      agent: "seed",
    },
    "global",
  );

  const semanticContents = [
    "SEMANTIC-OLD-TURN-01：資料匯入器的重試策略採指數退避，最多三次，批次大小固定為 32。",
    "SEMANTIC-NEW-TURN-02：介面按鈕的圓角與色票調整，與資料匯入無關。",
    "SEMANTIC-NEW-TURN-03：鍵盤快捷鍵的顯示順序調整，與資料匯入無關。",
    "SEMANTIC-NEW-TURN-04：文件目錄的字型與行距調整，與資料匯入無關。",
    "SEMANTIC-NEW-TURN-05：視窗標題的顏色調整，與資料匯入無關。",
  ];
  const semanticCards = [];
  for (const [index, content] of semanticContents.entries()) {
    semanticCards.push(
      await seedMemory(
        client,
        {
          content,
          kind: "fact",
          scope: "project",
          project: "semantic",
          agent: "opencode-plugin/turn",
          sourceSession: "semantic-s1",
          sourceMessage: `a-semantic-${index + 1}`,
          force: true,
        },
        `semantic-${index + 1}`,
      ),
    );
  }
  const semanticTargetId = semanticCards[0].id;

  await seedMemory(
    client,
    {
      content: "FAILOPEN-TURN-CARD：先前回合的紀錄，語意搜尋失敗時仍應固定注入。",
      kind: "fact",
      scope: "project",
      project: "failopen",
      agent: "opencode-plugin/turn",
      sourceSession: "failopen-s1",
      sourceMessage: "a-failopen-1",
      force: true,
    },
    "failopen-turn",
  );

  const dedupeSeeds = [
    { content: "DEDUPE-FACT-01：快取批次大小固定為 32，避免記憶體尖峰。", kind: "fact" },
    { content: "DEDUPE-DECISION-01：決定把快取批次大小設為 32，而不是 64。", kind: "decision" },
    { content: "DEDUPE-PITFALL-01：曾因快取批次過大造成記憶體尖峰，批次上限必須壓在 32。", kind: "pitfall" },
  ];
  for (const [index, card] of dedupeSeeds.entries()) {
    await seedMemory(
      client,
      { content: card.content, kind: card.kind, scope: "project", project: "dedupe", agent: "seed" },
      `dedupe-${index + 1}`,
    );
  }

  /* ---------------------------------------------------------------- *
   * 就緒閘門（語意搜尋一定要真 embedder，不得靜默跳過）
   * ---------------------------------------------------------------- */

  const readiness = await waitForReady(client, 180000);
  if (readiness.gate !== "passed") {
    throw new Error(
      `就緒閘門逾時（pending=${readiness.final?.pending} failed=${readiness.final?.failed} stale=${readiness.final?.stale}）；` +
        "拒絕在向量未就緒時對語意斷言下結論。",
    );
  }

  // 暖機一次查詢路徑：避開 embedder 第一次查詢的載入成本造成 150ms／1000ms timeout 抖動。
  try {
    await searchMemories(client, { query: "暖機查詢：確認向量查詢路徑可用", project: "alpha" });
  } catch {
    // 暖機失敗不影響斷言；真正的語意案例會自己回報。
  }

  /** 統計 digest 的狀態／原因（紅燈時一眼看出是 other-location 還是 model-unavailable）。 */
  function digestStatusCounts(entries) {
    const counts = {};
    for (const entry of entries) {
      const key = entry.state === "ok" ? "ok" : `${entry.state}:${entry.reason ?? "?"}`;
      counts[key] = (counts[key] ?? 0) + 1;
    }
    return counts;
  }

  const definitions = [];
  function scenario(id, assertion, title, run, { gated = true } = {}) {
    definitions.push({ id, assertion, title, run, gated });
  }

  /* ---------------------------------------------------------------- *
   * 斷言 1：回合卡
   * ---------------------------------------------------------------- */

  scenario("a1.turn-cards-alpha", 1, "alpha 的 15 個回合各寫一張正確的回合卡", async () => {
    const checks = createChecks();
    const cards = await listMemories(client, {
      scope: "project",
      project: "alpha",
      agent: "opencode-plugin/turn",
    });
    checks.eq("回合卡張數", cards.length, 15);
    checks.eq("agent", uniqueValues(cards.map((card) => card.agent)), ["opencode-plugin/turn"]);
    checks.eq("kind", uniqueValues(cards.map((card) => card.kind)), ["fact"]);
    checks.eq("scope", uniqueValues(cards.map((card) => card.scope)), ["project"]);
    checks.eq("project", uniqueValues(cards.map((card) => card.project)), ["alpha"]);
    const expectedWatermarks = Array.from({ length: 15 }, (_, index) => `a-${index + 1}`);
    checks.eq(
      "sourceMessage 等於事件當下的水位線",
      sameSet(cards.map((card) => card.sourceMessage), expectedWatermarks),
      true,
    );
    checks.eq(
      "回合卡內容帶回合 token",
      cards.every((card) => extractToken(card.content) !== null),
      true,
    );

    const turnPosts = alpha.posts.filter((post) => post.body?.agent === "opencode-plugin/turn");
    checks.eq("回合卡寫入請求數", turnPosts.length, 15);
    checks.eq("每個請求都帶 force=true", turnPosts.every((post) => post.body.force === true), true);
    checks.eq("請求 kind 皆為 fact", turnPosts.every((post) => post.body.kind === "fact"), true);
    checks.eq("請求 scope 皆為 project／alpha", uniqueValues(turnPosts.map((post) => `${post.body.scope}:${post.body.project}`)), ["project:alpha"]);

    const atomic = await listMemories(client, {
      scope: "project",
      project: "alpha",
      agent: "opencode-plugin",
    });
    checks.eq("原子記憶張數（每 3 回合 1 張）", atomic.length, 5);
    checks.eq("模型清單有被呼叫", alpha.modelListCalls > 0, true);
    checks.eq("模型清單命中 digestModel", alpha.modelMatched, true);

    const statusCounts = digestStatusCounts(await digestEntries(alpha));
    return {
      checks,
      metrics: {
        modelCalls: alpha.modelCallCount,
        writeAttempts: alpha.writeAttempts,
        writes: cards.length,
        atomicWrites: atomic.length,
      },
      detail: `digest 狀態統計：${JSON.stringify(statusCounts)}`,
    };
  });

  scenario("a1.turn-cards-chat", 1, "global chat 的 6 個回合寫入 scope=global 的回合卡", async () => {
    const checks = createChecks();
    const globalTurns = await listMemories(client, { scope: "global", agent: "opencode-plugin/turn" });
    const chatCards = globalTurns.filter((card) => extractToken(card.content)?.startsWith("TURN-CHAT-"));
    checks.eq("chat 回合卡張數", chatCards.length, 6);
    checks.eq("chat 卡的 scope", uniqueValues(chatCards.map((card) => card.scope)), ["global"]);
    checks.eq("chat 卡沒有 project", uniqueValues(chatCards.map((card) => card.project)), ["null"]);
    const posts = chat.posts.filter((post) => post.body?.agent === "opencode-plugin/turn");
    checks.eq("chat 寫入 scope 皆為 global", uniqueValues(posts.map((post) => post.body.scope)), ["global"]);
    checks.eq("chat 寫入不帶 project", posts.every((post) => post.body.project === undefined), true);
    checks.eq("chat 模型清單命中", chat.modelMatched, true);
    const statusCounts = digestStatusCounts(await digestEntries(chat));
    return {
      checks,
      metrics: { modelCalls: chat.modelCallCount, writeAttempts: chat.writeAttempts, writes: chatCards.length },
      detail: `digest 狀態統計：${JSON.stringify(statusCounts)}`,
    };
  });

  scenario("a1.snapshot-waterline", 1, "事件之後才追加的訊息不得進入本次 digest", async () => {
    const checks = createChecks();
    const host = await makeHost("waterline", { project: "waterline", settings: DIGEST_SETTINGS });
    host.pushTurn("waterline-s1", turnUser("TURN-WATERLINE-01"), turnAssistant("TURN-WATERLINE-01"));
    await host.dispatch("waterline-s1");
    host.appendMessage("waterline-s1", userMessage("u-waterline-late", "TURN-WATERLINE-LATE：事件之後才追加的使用者訊息。"));
    host.appendMessage(
      "waterline-s1",
      assistantMessage("a-waterline-late", "TURN-WATERLINE-LATE 的助理回覆，不應該進入這一次的 digest。"),
    );
    await host.waitIdle();

    const cards = await listMemories(client, {
      scope: "project",
      project: "waterline",
      agent: "opencode-plugin/turn",
    });
    checks.eq("只寫一張回合卡", cards.length, 1);
    checks.eq("sourceMessage 是事件當下的水位線", cards[0]?.sourceMessage, "a-1");
    checks.eq("內容是事件當下的回合", extractToken(cards[0]?.content), "TURN-WATERLINE-01");
    checks.eq("晚到的訊息沒有被摘要", String(cards[0]?.content).includes("TURN-WATERLINE-LATE"), false);
    return {
      checks,
      metrics: { modelCalls: host.modelCallCount, writeAttempts: host.writeAttempts, writes: cards.length },
    };
  });

  /* ---------------------------------------------------------------- *
   * 斷言 2：最近回合注入
   * ---------------------------------------------------------------- */

  scenario("a2.recent-turns-order", 2, "15 字短句觸發召回，注入最新 3 筆回合卡（舊→新、無重複）", async () => {
    const checks = createChecks();
    const query = "把這輪重點整理成三個清單項目吧";
    checks.eq("查詢長度 15 字", [...query].length, 15);
    const latest = await listMemories(client, {
      scope: "project",
      project: "alpha",
      agent: "opencode-plugin/turn",
      limit: 3,
    });
    const expected = latest.map((card) => extractToken(card.content)).reverse();
    const event = await alpha.recall({ sessionID: "alpha-recall", text: query });
    const block = injectedBlock(event);
    const lines = turnLines(block);
    const injectedTokens = lines.map((line) => extractToken(line));
    checks.eq("回合行數", lines.length, 3);
    checks.eq("順序為舊→新（最新 3 筆反轉）", injectedTokens, expected);
    checks.eq("沒有重複", new Set(injectedTokens).size, 3);
    const recallLog = alpha.logPayloads("recall").at(-1);
    checks.eq("log 回合數", recallLog?.turns, 3);
    checks.eq("未被跳過", recallLog?.skipped, undefined);
    return {
      checks,
      metrics: { modelCalls: 0, writeAttempts: 0, writes: 0, turns: lines.length },
      detail: `注入 ${lines.length} 筆回合卡：${injectedTokens.join("、")}`,
    };
  });

  scenario("a2.greeting-not-injected", 2, "乾淨 session 的招呼語（早安）不注入", async () => {
    const checks = createChecks();
    const host = await makeHost("greet", { project: "greet", settings: RECALL_SETTINGS });
    const existing = await listMemories(client, { scope: "project", project: "greet" });
    checks.eq("乾淨 session 沒有既有卡", existing.length, 0);
    checks.eq("招呼語長度 2 字", [..."早安"].length, 2);
    const event = await host.recall({ sessionID: "greet-s1", text: "早安" });
    checks.eq("沒有注入任何區塊", injectedBlock(event), "");
    const recallLog = host.logPayloads("recall").at(-1);
    checks.eq("跳過原因為 short", recallLog?.skipped, "short");
    return { checks, metrics: { modelCalls: 0, writeAttempts: 0, writes: 0 } };
  });

  /* ---------------------------------------------------------------- *
   * 斷言 3：語意找回舊回合（僅報告）
   * ---------------------------------------------------------------- */

  scenario(
    "a3.semantic-old-turn",
    3,
    "較舊的回合卡靠語意搜尋找回（確認真 embedder；僅報告）",
    async () => {
      const checks = createChecks();
      const query = "匯入器重試幾次、批次大小是多少";
      const direct = await searchMemories(client, { query, project: "semantic" });
      const found = direct.hits.some((hit) => hit.id === semanticTargetId);
      const host = await makeHost("semantic-recall", { project: "semantic", settings: RECALL_SETTINGS });
      const event = await host.recall({ sessionID: "semantic-s1", text: query });
      const block = injectedBlock(event);
      const injectedTarget = block.includes("SEMANTIC-OLD-TURN-01");
      const top = direct.hits.find((hit) => hit.id === semanticTargetId);
      checks.note("語意搜尋命中舊回合", found);
      checks.note("召回區塊含舊回合", injectedTarget);
      checks.note("命中分數／來源", top === undefined ? null : { score: top.score, source: top.source });
      checks.note("搜尋回傳筆數", direct.hits.length);
      return {
        checks,
        metrics: { modelCalls: 0, writeAttempts: 0, writes: 0, semanticHits: direct.hits.length },
        detail:
          `僅供報告、不設門檻：語意搜尋${found ? "有" : "沒有"}命中 ` +
          `SEMANTIC-OLD-TURN-01，召回區塊${injectedTarget ? "有" : "沒有"}它。` +
          `（degraded=${direct.degraded}）`,
      };
    },
    { gated: false },
  );

  /* ---------------------------------------------------------------- *
   * 斷言 4：scope
   * ---------------------------------------------------------------- */

  async function alphaTurnCard() {
    const cards = await listMemories(client, { scope: "project", project: "alpha", agent: "opencode-plugin/turn" });
    return cards.find((card) => extractToken(card.content) === "TURN-ALPHA-15") ?? cards[0];
  }

  scenario("a4.alpha-not-beta", 4, "alpha 的卡不會在 beta 命中", async () => {
    const checks = createChecks();
    const alpha15 = await alphaTurnCard();
    checks.ok("找到 alpha 的測試卡", alpha15 !== undefined, true, alpha15 !== undefined);
    const query = String(alpha15?.content ?? "");
    const direct = await searchMemories(client, { query, project: "beta" });
    checks.eq(
      "beta 搜尋沒有 project=alpha 的命中",
      direct.hits.filter((hit) => hit.project === "alpha").length,
      0,
    );
    checks.eq(
      "beta 搜尋內容不含 ALPHA token",
      direct.hits.filter((hit) => String(hit.content).includes("TURN-ALPHA")).length,
      0,
    );
    const event = await beta.recall({ sessionID: "beta-recall", text: query });
    checks.eq("beta 召回區塊不含 alpha 卡", injectedBlock(event).includes("TURN-ALPHA"), false);
    return { checks, metrics: { modelCalls: 0, writeAttempts: 0, writes: 0, betaHits: direct.hits.length } };
  });

  scenario("a4.global-visible-alpha", 4, "global 卡在 alpha 可見", async () => {
    const checks = createChecks();
    const query = "版本發布檢查清單包含哪些項目";
    const direct = await searchMemories(client, { query, project: "alpha" });
    checks.eq(
      "alpha 搜尋命中 global 卡",
      direct.hits.some((hit) => hit.id === globalCard.id),
      true,
    );
    const event = await alpha.recall({ sessionID: "alpha-global", text: query });
    checks.eq("alpha 召回區塊含 global 卡", injectedBlock(event).includes("GLOBAL-SCOPE-CARD"), true);
    return { checks, metrics: { modelCalls: 0, writeAttempts: 0, writes: 0, alphaHits: direct.hits.length } };
  });

  scenario("a4.alpha-not-chat", 4, "alpha 的卡不會在 global chat 命中", async () => {
    const checks = createChecks();
    const alpha15 = await alphaTurnCard();
    const query = String(alpha15?.content ?? "");
    const direct = await searchMemories(client, { query, scope: "global" });
    checks.eq(
      "chat 範圍搜尋沒有 project=alpha 的命中",
      direct.hits.filter((hit) => hit.project === "alpha").length,
      0,
    );
    const event = await chat.recall({ sessionID: "chat-recall", text: query });
    const block = injectedBlock(event);
    checks.eq("chat 召回區塊不含 alpha 卡", block.includes("TURN-ALPHA"), false);
    checks.eq("chat 召回仍有自己的回合卡", block.includes("TURN-CHAT-"), true);
    return { checks, metrics: { modelCalls: 0, writeAttempts: 0, writes: 0, chatHits: direct.hits.length } };
  });

  /* ---------------------------------------------------------------- *
   * 斷言 5：去重 TTL
   * ---------------------------------------------------------------- */

  scenario("a5.dedupe-ttl", 5, "TTL 8 輪內不重注；TTL 後 fact 不重注、decision／pitfall 可重注", async () => {
    const checks = createChecks();
    const host = await makeHost("dedupe", { project: "dedupe", settings: RECALL_SETTINGS });
    const query = "還記得先前那個快取批次大小的決定嗎";
    const seen = [];
    for (let turn = 1; turn <= 9; turn += 1) {
      const event = await host.recall({ sessionID: "dedupe-s", text: query });
      const block = injectedBlock(event);
      seen.push({
        turn,
        fact: block.includes("DEDUPE-FACT-01"),
        decision: block.includes("DEDUPE-DECISION-01"),
        pitfall: block.includes("DEDUPE-PITFALL-01"),
      });
    }
    checks.eq("第 1 輪三張都注入", [seen[0].fact, seen[0].decision, seen[0].pitfall], [true, true, true]);
    checks.eq(
      "第 2–8 輪都不重注",
      seen.slice(1, 8).every((entry) => !entry.fact && !entry.decision && !entry.pitfall),
      true,
    );
    checks.eq("第 9 輪 fact 不重注", seen[8].fact, false);
    checks.eq("第 9 輪 decision 重注", seen[8].decision, true);
    checks.eq("第 9 輪 pitfall 重注", seen[8].pitfall, true);
    return {
      checks,
      metrics: { modelCalls: 0, writeAttempts: 0, writes: 0, recallTurns: seen.length },
      detail: `逐輪注入：${seen.map((entry) => `${entry.turn}:${["fact", "decision", "pitfall"].filter((kind) => entry[kind]).join("+") || "none"}`).join(" ")}`,
    };
  });

  /* ---------------------------------------------------------------- *
   * 斷言 6：fail-open
   * ---------------------------------------------------------------- */

  async function failOpenScenario(name, fetchFault, expectedReason, expectedStatus, settings = RECALL_SETTINGS) {
    const checks = createChecks();
    const host = await makeHost(name, { project: "failopen", settings, fetchFault });
    const event = await host.recall({ sessionID: `${name}-s`, text: "把這輪重點整理成三個清單項目吧" });
    const block = injectedBlock(event);
    checks.eq("搜尋失敗但回合卡仍注入", block.includes("FAILOPEN-TURN-CARD"), true);
    const recallLog = host.logPayloads("recall").at(-1);
    checks.eq("log 標記 degraded", recallLog?.degraded, true);
    checks.eq("log 記錄 recallFailure", recallLog?.recallFailure, expectedReason);
    if (expectedStatus !== undefined) checks.eq("log 記錄 HTTP status", recallLog?.status, expectedStatus);
    return {
      checks,
      metrics: { modelCalls: 0, writeAttempts: 0, writes: 0, injected: block === "" ? 0 : 1 },
      detail: `search 故障＝${fetchFault}；仍注入回合卡。`,
    };
  }

  scenario("a6.fail-open-503", 6, "/memories/search 回 503、GET /memories 正常 → 仍注入回合卡", () =>
    failOpenScenario("failopen-503", "search-503", "http", 503),
  );

  scenario("a6.fail-open-timeout", 6, "/memories/search 逾時、GET /memories 正常 → 仍注入回合卡", () =>
    failOpenScenario("failopen-timeout", "search-timeout", "timeout", undefined, FAIL_OPEN_TIMEOUT_SETTINGS),
  );

  /* ---------------------------------------------------------------- *
   * 斷言 7：模型逾時（寫入前）
   * ---------------------------------------------------------------- */

  scenario("a7.model-timeout-before-write", 7, "模型在寫入前逾時：0 寫入、沒有走到寫入", async () => {
    const checks = createChecks();
    const host = await makeHost("timeout", {
      project: "timeout",
      settings: DIGEST_SETTINGS,
      digestTimeoutMs: 250,
      delayMs: 800,
    });
    host.pushTurn("timeout-s1", turnUser("TURN-TIMEOUT-01"), turnAssistant("TURN-TIMEOUT-01"));
    await host.settle("timeout-s1");
    const entries = await digestEntries(host);
    const last = entries.at(-1);
    const cards = await listMemories(client, { scope: "project", project: "timeout", agent: "opencode-plugin/turn" });
    checks.eq("模型呼叫次數", host.modelCallCount, 1);
    checks.eq("寫入嘗試次數", host.writeAttempts, 0);
    checks.eq("寫入張數", cards.length, 0);
    checks.eq("log 狀態", last?.state, "failed");
    checks.eq("log 原因", last?.reason, "timeout");
    return {
      checks,
      metrics: { modelCalls: host.modelCallCount, writeAttempts: host.writeAttempts, writes: cards.length },
      detail: "模型在寫入前逾時；沒有走到寫入（writeAttempts=0、writes=0）。",
    };
  });

  /* ---------------------------------------------------------------- *
   * 斷言 8：冪等
   * ---------------------------------------------------------------- */

  scenario("a8.idempotent-success", 8, "成功重送：只呼叫模型一次、只寫一次、log already", async () => {
    const checks = createChecks();
    const host = await makeHost("idem-success", {
      project: "idem-success",
      settings: DIGEST_SETTINGS,
      canned: () => cannedFixedTurnResponse("TURN-IDEM-SUCCESS-01"),
    });
    host.pushTurn("idem-success-s1", turnUser("TURN-IDEM-SUCCESS-01"), turnAssistant("TURN-IDEM-SUCCESS-01"));
    await host.settle("idem-success-s1");
    await host.settle("idem-success-s1");
    const cards = await listMemories(client, {
      scope: "project",
      project: "idem-success",
      agent: "opencode-plugin/turn",
    });
    const entries = await digestEntries(host);
    checks.eq("模型呼叫次數", host.modelCallCount, 1);
    checks.eq("寫入嘗試次數", host.writeAttempts, 1);
    checks.eq("寫入張數", cards.length, 1);
    checks.eq(
      "log 有 already",
      entries.filter((entry) => entry.state === "skipped" && entry.reason === "already").length,
      1,
    );
    return {
      checks,
      metrics: { modelCalls: host.modelCallCount, writeAttempts: host.writeAttempts, writes: cards.length },
      detail: "第二次事件在 seen 檢查就被擋下，沒有再呼叫模型。",
    };
  });

  scenario("a8.idempotent-empty", 8, "空結果重送：只呼叫模型一次、0 寫入、log already", async () => {
    const checks = createChecks();
    const host = await makeHost("idem-empty", {
      project: "idem-empty",
      settings: DIGEST_SETTINGS,
      canned: () => cannedEmptyResponse(),
    });
    host.pushTurn("idem-empty-s1", turnUser("TURN-IDEM-EMPTY-01"), turnAssistant("TURN-IDEM-EMPTY-01"));
    await host.settle("idem-empty-s1");
    await host.settle("idem-empty-s1");
    const cards = await listMemories(client, {
      scope: "project",
      project: "idem-empty",
      agent: "opencode-plugin/turn",
    });
    const entries = await digestEntries(host);
    checks.eq("模型呼叫次數", host.modelCallCount, 1);
    checks.eq("寫入嘗試次數", host.writeAttempts, 0);
    checks.eq("寫入張數", cards.length, 0);
    checks.eq("第一次是空結果成功", `${entries[0]?.state}:${entries[0]?.written}`, "ok:0");
    checks.eq(
      "第二次是 already",
      `${entries[1]?.state}:${entries[1]?.reason}`,
      "skipped:already",
    );
    return {
      checks,
      metrics: { modelCalls: host.modelCallCount, writeAttempts: host.writeAttempts, writes: cards.length },
    };
  });

  scenario("a8.idempotent-timeout", 8, "模型逾時重送：再呼叫一次模型、仍 0 寫入", async () => {
    const checks = createChecks();
    const host = await makeHost("idem-timeout", {
      project: "idem-timeout",
      settings: DIGEST_SETTINGS,
      digestTimeoutMs: 200,
      delayMs: 700,
    });
    host.pushTurn("idem-timeout-s1", turnUser("TURN-IDEM-TIMEOUT-01"), turnAssistant("TURN-IDEM-TIMEOUT-01"));
    await host.settle("idem-timeout-s1");
    await host.settle("idem-timeout-s1");
    const cards = await listMemories(client, {
      scope: "project",
      project: "idem-timeout",
      agent: "opencode-plugin/turn",
    });
    const entries = await digestEntries(host);
    checks.eq("模型呼叫次數", host.modelCallCount, 2);
    checks.eq("寫入嘗試次數", host.writeAttempts, 0);
    checks.eq("寫入張數", cards.length, 0);
    checks.eq("兩次都記 timeout", uniqueValues(entries.map((entry) => entry.reason)), ["timeout"]);
    return {
      checks,
      metrics: { modelCalls: host.modelCallCount, writeAttempts: host.writeAttempts, writes: cards.length },
      detail: "逾時不 markSeen，重送會再呼叫一次模型；兩次都沒有走到寫入。",
    };
  });

  scenario("a8.idempotent-bad-json", 8, "壞 JSON 重送：再呼叫一次模型、仍 0 寫入", async () => {
    const checks = createChecks();
    const host = await makeHost("idem-badjson", {
      project: "idem-badjson",
      settings: DIGEST_SETTINGS,
      canned: () => cannedBadJsonResponse(),
    });
    host.pushTurn("idem-badjson-s1", turnUser("TURN-IDEM-BADJSON-01"), turnAssistant("TURN-IDEM-BADJSON-01"));
    await host.settle("idem-badjson-s1");
    await host.settle("idem-badjson-s1");
    const cards = await listMemories(client, {
      scope: "project",
      project: "idem-badjson",
      agent: "opencode-plugin/turn",
    });
    const entries = await digestEntries(host);
    checks.eq("模型呼叫次數", host.modelCallCount, 2);
    checks.eq("寫入嘗試次數", host.writeAttempts, 0);
    checks.eq("寫入張數", cards.length, 0);
    checks.eq("兩次都記 not-json", uniqueValues(entries.map((entry) => entry.reason)), ["not-json"]);
    return {
      checks,
      metrics: { modelCalls: host.modelCallCount, writeAttempts: host.writeAttempts, writes: cards.length },
    };
  });

  scenario("a8.idempotent-write-failure", 8, "寫入失敗重送：再呼叫一次模型、仍 0 寫入", async () => {
    const checks = createChecks();
    const host = await makeHost("idem-writefail", {
      project: "idem-writefail",
      settings: DIGEST_SETTINGS,
      canned: () => cannedFixedTurnResponse("TURN-IDEM-WRITEFAIL-01"),
      fetchFault: "digest-write-500",
    });
    host.pushTurn("idem-writefail-s1", turnUser("TURN-IDEM-WRITEFAIL-01"), turnAssistant("TURN-IDEM-WRITEFAIL-01"));
    await host.settle("idem-writefail-s1");
    await host.settle("idem-writefail-s1");
    const cards = await listMemories(client, {
      scope: "project",
      project: "idem-writefail",
      agent: "opencode-plugin/turn",
    });
    const entries = await digestEntries(host);
    checks.eq("模型呼叫次數", host.modelCallCount, 2);
    checks.eq("寫入嘗試次數（每次事件重試 2 次）", host.writeAttempts, 4);
    checks.eq("寫入張數", cards.length, 0);
    checks.eq("log 原因為 http-500", uniqueValues(entries.map((entry) => entry.reason)), ["http-500"]);
    checks.eq("log 狀態為 failed", uniqueValues(entries.map((entry) => entry.state)), ["failed"]);
    return {
      checks,
      metrics: { modelCalls: host.modelCallCount, writeAttempts: host.writeAttempts, writes: cards.length },
      detail: "寫入失敗不 markSeen；每次事件呼叫模型一次、寫入嘗試 2 次（內建重試），兩次都 0 寫入。",
    };
  });

  /* ---------------------------------------------------------------- *
   * 斷言 9：digest.log 隱私
   * ---------------------------------------------------------------- */

  scenario("a9.log-privacy", 9, "digest.log 只有 hash／reason／count（只掃檔案）", async () => {
    const checks = createChecks();
    const files = (await fs.readdir(logDir)).filter((file) => file.startsWith("digest-") && file.endsWith(".log"));
    checks.eq("有產生 digest.log 檔案", files.length > 0, true);
    const allowedKeys = new Set([
      "at",
      "session",
      "state",
      "reason",
      "model",
      "latencyMs",
      "items",
      "written",
      "duplicates",
      "failed",
      "cards",
    ]);
    const allowedStates = new Set(["ok", "skipped", "failed"]);
    const sessionIds = ["alpha-s1", "beta-s1", "chat-s1", "waterline-s1"];
    const markers = ["TURN-", "USER-", "ITEM-", "GLOBAL-SCOPE", "DEDUPE-", "FAILOPEN-", "SEMANTIC-"];
    let lineCount = 0;
    let badKeys = 0;
    let badSessions = 0;
    let badStates = 0;
    let leakedSessions = 0;
    let leakedContent = 0;
    let leakedToken = 0;
    for (const file of files) {
      const text = await fs.readFile(path.join(logDir, file), "utf8");
      for (const sessionID of sessionIds) if (text.includes(sessionID)) leakedSessions += 1;
      for (const marker of markers) if (text.includes(marker)) leakedContent += 1;
      if (text.includes(token)) leakedToken += 1;
      for (const line of text.split(/\r?\n/)) {
        if (line === "") continue;
        lineCount += 1;
        let entry;
        try {
          entry = JSON.parse(line);
        } catch {
          badKeys += 1;
          continue;
        }
        for (const key of Object.keys(entry)) if (!allowedKeys.has(key)) badKeys += 1;
        if (!/^[0-9a-f]{8}$/.test(String(entry.session))) badSessions += 1;
        if (!allowedStates.has(String(entry.state))) badStates += 1;
      }
    }
    checks.eq("log 行數 > 0", lineCount > 0, true);
    checks.eq("欄位皆在允許清單", badKeys, 0);
    checks.eq("session 是 8 碼 hash", badSessions, 0);
    checks.eq("state 合法", badStates, 0);
    checks.eq("沒有 sessionID 明文", leakedSessions, 0);
    checks.eq("沒有對話內容標記", leakedContent, 0);
    checks.eq("沒有 server token", leakedToken, 0);
    return {
      checks,
      metrics: { modelCalls: 0, writeAttempts: 0, writes: 0, logLines: lineCount, logFiles: files.length },
      detail: `掃描 ${files.length} 個 digest.log 檔、${lineCount} 行；不掃 console log。`,
    };
  });

  /* ---------------------------------------------------------------- *
   * 負向對照的自我檢查（正常模式下應通過）
   * ---------------------------------------------------------------- */

  scenario("n1.other-location-skipped", null, "負向自我檢查：session.get 回不同目錄 → other-location", async () => {
    const checks = createChecks();
    const host = await makeHost("neg-location", {
      project: "neg-location",
      settings: DIGEST_SETTINGS,
      ignoreFault: true,
      sessionGetDirectory: path.join(tmpRoot, "some-other-location"),
    });
    host.pushTurn("neg-location-s1", turnUser("TURN-NEG-LOCATION-01"), turnAssistant("TURN-NEG-LOCATION-01"));
    await host.settle("neg-location-s1");
    const entries = await digestEntries(host);
    const cards = await listMemories(client, {
      scope: "project",
      project: "neg-location",
      agent: "opencode-plugin/turn",
    });
    checks.eq("模型呼叫次數", host.modelCallCount, 0);
    checks.eq("寫入張數", cards.length, 0);
    checks.eq("跳過原因", uniqueValues(entries.map((entry) => entry.reason)), ["other-location"]);
    return {
      checks,
      metrics: { modelCalls: host.modelCallCount, writeAttempts: host.writeAttempts, writes: cards.length },
      detail: "session.get 的 location.directory 與實例不同：digest 以 other-location 跳過。",
    };
  });

  scenario("n2.model-unavailable-skipped", null, "負向自我檢查：model.list 不含 digestModel → 全部跳過", async () => {
    const checks = createChecks();
    const host = await makeHost("neg-model", {
      project: "neg-model",
      settings: DIGEST_SETTINGS,
      ignoreFault: true,
      modelList: "missing",
    });
    host.pushTurn("neg-model-s1", turnUser("TURN-NEG-MODEL-01"), turnAssistant("TURN-NEG-MODEL-01"));
    await host.settle("neg-model-s1");
    const entries = await digestEntries(host);
    const cards = await listMemories(client, {
      scope: "project",
      project: "neg-model",
      agent: "opencode-plugin/turn",
    });
    checks.eq("模型清單呼叫次數（只驗一次）", host.modelListCalls, 1);
    checks.eq("模型清單沒有命中", host.modelMatched, false);
    checks.eq("模型呼叫次數", host.modelCallCount, 0);
    checks.eq("寫入張數", cards.length, 0);
    checks.eq("跳過原因", uniqueValues(entries.map((entry) => entry.reason)), ["model-unavailable"]);
    return {
      checks,
      metrics: { modelCalls: host.modelCallCount, writeAttempts: host.writeAttempts, writes: cards.length },
      detail: "model.list 不含 digestModel：每回合以 model-unavailable 跳過，不會出現「看起來有寫入」。",
    };
  });

  /* ---------------------------------------------------------------- *
   * 執行
   * ---------------------------------------------------------------- */

  const cases = [];
  for (const definition of definitions) {
    const startedAt = Date.now();
    const gated = definition.gated !== false;
    try {
      const result = await definition.run();
      const checks = result.checks ?? createChecks();
      // 僅報告的場景一律標 `info`：不顯示 PASS／FAIL，也不影響退出碼。
      const status = gated ? (result.status ?? (checks.passed ? "pass" : "fail")) : "info";
      cases.push({
        id: definition.id,
        assertion: definition.assertion,
        title: definition.title,
        gated,
        status,
        durationMs: Date.now() - startedAt,
        checks: checks.list ?? [],
        metrics: result.metrics ?? {},
        detail: root(result.detail ?? ""),
      });
    } catch (error) {
      cases.push({
        id: definition.id,
        assertion: definition.assertion,
        title: definition.title,
        gated,
        status: gated ? "fail" : "info",
        durationMs: Date.now() - startedAt,
        checks: [],
        metrics: {},
        detail: root(`${error?.name ?? "Error"}: ${error?.message ?? ""}`),
      });
    }
  }

  const modelValidation = {
    digestModel: DIGEST_MODEL,
    instances: hosts.map((host) => ({
      name: host.name,
      checked: host.settings.digestEnabled === true,
      matched: host.settings.digestEnabled === true ? host.modelMatched : null,
      listCalls: host.modelListCalls,
    })),
  };

  return { cases, readiness, hosts, modelValidation, token };
}

/** 依斷言彙總（報告用）。`info` 代表僅報告、不設門檻。 */
export function summarizeAssertions(cases) {
  const summary = [];
  for (let id = 1; id <= 9; id += 1) {
    const related = cases.filter((entry) => entry.assertion === id);
    const status =
      related.length === 0
        ? "not-run"
        : related.some((entry) => entry.status === "fail")
          ? "fail"
          : related.every((entry) => entry.status === "info")
            ? "info"
            : related.every((entry) => entry.status === "pass")
              ? "pass"
              : "not-run";
    summary.push({ id, status, cases: related.map((entry) => entry.id) });
  }
  return summary;
}
