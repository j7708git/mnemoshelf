/**
 * 讀取並驗證 D3 評估資料集（`eval/fixtures/*.json`）。
 *
 * 驗證刻意嚴格且**指出位置**（陣列索引＋slug），因為 fixture 是人工維護的：
 * 一個打錯的 slug 會讓整份報告的 Recall 靜默變成 0，比直接失敗更糟。
 *
 * 這裡的驗證與 `test/eval-fixtures.test.ts` 互補：測試確保 CI 不會放進壞資料，
 * harness 確保「跑之前」就知道資料壞在哪。
 */
import { readFileSync } from "node:fs";
import path from "node:path";

export const CATEGORIES = ["single", "multi", "update", "negative", "cross"];
export const SPLITS = ["dev", "test"];
export const KINDS = ["fact", "decision", "pitfall", "preference"];

/** 讀 JSON，錯誤訊息帶檔名與（可取得的）位移。 */
export function readJson(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    throw new Error(`讀不到 fixture：${path.basename(file)}（${error instanceof Error ? error.message : "unknown"}）`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : "JSON 解析失敗";
    throw new Error(`${path.basename(file)} 不是合法 JSON：${message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/**
 * 載入資料集。
 *
 * @param {string} fixturesDir
 * @returns {{cards: object[], questions: object[], cardById: Map<string, object>, meta: object}}
 */
export function loadDataset(fixturesDir) {
  const cardsRaw = readJson(path.join(fixturesDir, "cards.json"));
  const questionsRaw = readJson(path.join(fixturesDir, "questions.json"));
  assert(Array.isArray(cardsRaw.cards), "cards.json 缺少 cards 陣列");
  assert(Array.isArray(questionsRaw.questions), "questions.json 缺少 questions 陣列");

  const cardById = new Map();
  cardsRaw.cards.forEach((card, index) => {
    const where = `cards[${index}]${typeof card?.id === "string" ? ` (${card.id})` : ""}`;
    assert(typeof card?.id === "string" && /^[a-z0-9-]+$/.test(card.id), `${where}: id 必須是 kebab-case 字串`);
    assert(!cardById.has(card.id), `${where}: id 重複`);
    assert(typeof card.content === "string" && card.content.length >= 10, `${where}: content 太短或不是字串`);
    assert(KINDS.includes(card.kind), `${where}: kind 必須是 ${KINDS.join(" / ")}`);
    const isGlobal = card.scope === "global";
    assert(isGlobal || ["alpha", "beta", "gamma"].includes(card.project), `${where}: project 必須是 alpha／beta／gamma`);
    assert(!isGlobal || card.project === undefined, `${where}: global 卡不該有 project`);
    cardById.set(card.id, card);
  });

  // supersedes 必須指向存在且順序在前的卡（載入器要拿到舊卡的數字 id）。
  const order = new Map(cardsRaw.cards.map((card, index) => [card.id, index]));
  cardsRaw.cards.forEach((card, index) => {
    if (card.supersedes === undefined) return;
    const where = `cards[${index}] (${card.id})`;
    assert(cardById.has(card.supersedes), `${where}: supersedes 指向不存在的卡 ${card.supersedes}`);
    assert(order.get(card.supersedes) < index, `${where}: supersedes 的舊卡必須排在前面（載入順序）`);
  });

  const deleted = new Set(cardsRaw.cards.filter((card) => card.superseded === true).map((card) => card.id));
  const supersededBy = new Map(cardsRaw.cards.filter((c) => c.supersedes).map((c) => [c.supersedes, c.id]));

  const seenQuery = new Set();
  const questions = questionsRaw.questions.map((question, index) => {
    const where = `questions[${index}]${typeof question?.id === "string" ? ` (${question.id})` : ""}`;
    assert(typeof question?.id === "string" && /^q\d{3}$/.test(question.id), `${where}: id 必須形如 q001`);
    assert(!seenQuery.has(question.id), `${where}: id 重複`);
    seenQuery.add(question.id);
    assert(CATEGORIES.includes(question.category), `${where}: category 不合法`);
    assert(SPLITS.includes(question.split), `${where}: split 必須是 dev／test`);
    assert(["zh", "en"].includes(question.lang), `${where}: lang 必須是 zh／en`);
    assert(["alpha", "beta", "gamma"].includes(question.project), `${where}: project 不合法`);
    assert(typeof question.query === "string" && [...question.query.trim()].length >= 6, `${where}: query 太短`);
    for (const field of ["expected_ids", "acceptable_ids", "forbidden_ids"]) {
      const value = question[field];
      assert(value === undefined || Array.isArray(value), `${where}: ${field} 必須是陣列`);
      for (const slug of value ?? []) {
        assert(cardById.has(slug), `${where}: ${field} 指向不存在的卡 ${slug}`);
      }
    }
    const expected = question.expected_ids ?? [];
    const forbidden = question.forbidden_ids ?? [];
    if (question.category === "negative") {
      assert(expected.length === 0 && forbidden.length === 0, `${where}: negative 題不得有 expected／forbidden`);
    } else if (question.category === "cross") {
      assert(expected.length === 0, `${where}: cross 題在預設範圍下不該有 expected`);
      assert(forbidden.length >= 1, `${where}: cross 題必須至少一個 forbidden`);
      assert(cardById.has(question.cross_check_id), `${where}: cross_check_id 不存在`);
    } else if (question.category === "update") {
      assert(expected.length === 1, `${where}: update 題必須恰好一個 expected（新卡）`);
      assert(forbidden.length === 1, `${where}: update 題必須恰好一個 forbidden（舊卡）`);
    } else if (question.category === "multi") {
      assert(expected.length >= 2, `${where}: multi 題必須至少兩個 required 卡`);
    } else {
      assert(expected.length === 1, `${where}: single 題必須恰好一個 expected`);
    }
    for (const slug of expected) {
      assert(!deleted.has(slug), `${where}: expected 指向已被 supersede 的卡 ${slug}`);
      const card = cardById.get(slug);
      const visible = card.scope === "global" || card.project === question.project;
      assert(visible, `${where}: expected 卡 ${slug} 不在提問專案的可見範圍（project/global）`);
    }
    for (const slug of forbidden) {
      const card = cardById.get(slug);
      if (question.category === "update") {
        assert(deleted.has(slug), `${where}: update 的 forbidden 應是已 supersede 的舊卡 ${slug}`);
        assert(supersededBy.get(slug) === expected[0], `${where}: forbidden 舊卡不是被 expected 取代`);
      } else {
        assert(card.scope !== "global", `${where}: forbidden 不該是 global 卡（global 依設計可見）`);
      }
    }
    return {
      ...question,
      expected_ids: expected,
      acceptable_ids: question.acceptable_ids ?? [],
      forbidden_ids: forbidden,
    };
  });

  const counts = { cards: cardsRaw.cards.length, questions: questions.length, byCategory: {}, bySplit: {} };
  for (const question of questions) {
    counts.byCategory[question.category] = (counts.byCategory[question.category] ?? 0) + 1;
    counts.bySplit[question.split] = (counts.bySplit[question.split] ?? 0) + 1;
  }

  return {
    cards: cardsRaw.cards,
    questions,
    cardById,
    deletedIds: deleted,
    supersededBy,
    meta: {
      ...counts,
      liveCards: cardsRaw.cards.length - deleted.size,
      supersededCards: deleted.size,
      pinnedCards: cardsRaw.cards.filter((card) => card.pinned === true).length,
      identifierQuestions: questions.filter((q) => q.identifier === true).length,
      codeIdentifierQuestions: questions.filter((q) => q.code_identifier === true).length,
      zhQuestions: questions.filter((q) => q.lang === "zh").length,
      enQuestions: questions.filter((q) => q.lang === "en").length,
    },
  };
}
