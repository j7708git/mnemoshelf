/**
 * 預設的 canned 假模型：一個**刻意簡單的抽取式基線**。
 *
 * 目的不是假裝成好模型，而是讓 `eval:digest` 完全離線、零成本、確定性地跑完整條管線；
 * 報告會把它標成 canned 基線（不收斂成模型品質結論）。它的行為固定且不讀取期望值：
 * - turn：助理回覆的**前兩句**，前面加「回合紀錄：」。
 * - items：逐句掃描，遇到含有「踩到／坑／失敗」的句子記 pitfall、含有「決定／改用」的
 *   記 decision、含有「偏好／慣例」的記 preference；最多 3 筆（故意超過 parser 的 2 筆上限，
 *   讓「原始 items 數 vs 保留數」有資料）。
 *
 * 它只看 prompt 裡這一回合的文字，因此結構上不可能把其他回合或跨專案的內容帶進來。
 */

const USER_MARKER = "這一回合的使用者訊息：";
const ASSISTANT_MARKER = "助理這一回合的最終回覆：";

/** 從 `buildDigestPrompt()` 的固定格式取出使用者／助理文字。 */
export function promptSections(prompt) {
  const text = typeof prompt === "string" ? prompt : "";
  const userStart = text.indexOf(USER_MARKER);
  const assistantStart = text.indexOf(ASSISTANT_MARKER);
  if (userStart < 0 || assistantStart < 0 || assistantStart < userStart) {
    return { user: "", assistant: "" };
  }
  const user = text.slice(userStart + USER_MARKER.length, assistantStart).trim();
  const assistant = text.slice(assistantStart + ASSISTANT_MARKER.length).trim();
  return { user, assistant };
}

/** 切句：句號、問號、驚嘆號與換行都算邊界，保留標點。 */
export function splitSentences(text) {
  if (typeof text !== "string") return [];
  return text
    .split(/(?<=[。！？!?])|\n+/u)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence !== "");
}

function classify(sentence) {
  if (/踩到|坑|失敗/u.test(sentence)) return "pitfall";
  if (/決定|改用/u.test(sentence)) return "decision";
  if (/偏好|慣例/u.test(sentence)) return "preference";
  return null;
}

/**
 * canned 基線的回應（`{ text }`，形狀與宿主 `generate.text` 一致）。
 *
 * @param {string} prompt
 * @param {{ transcript?: (entry: object) => void }} [hooks] 測試用：把內部決策記下來（不含 prompt）。
 */
export function cannedBaselineResponse(prompt, hooks = {}) {
  const { assistant } = promptSections(prompt);
  const sentences = splitSentences(assistant);
  const turn = `回合紀錄：${sentences.slice(0, 2).join("")}`;
  const items = [];
  for (const sentence of sentences) {
    const kind = classify(sentence);
    if (kind === null) continue;
    items.push({
      content: sentence.slice(0, 400),
      kind,
      quote: sentence.slice(0, 120),
    });
    if (items.length >= 3) break;
  }
  hooks.transcript?.({ sentenceCount: sentences.length, itemCount: items.length });
  return { text: JSON.stringify({ turn, items }) };
}
