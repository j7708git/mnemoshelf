import { describe, expect, it } from "vitest";
import { fixture } from "./fixture.js";
import { currentCards, digestInputs, evidenceFound, expand, neighborMap, pack, rawPassages } from "./representations.js";

describe("合成題庫與評分對照", () => {
  it("固定種子，調參與保留集互斥，證據能定位到唯一原始回合與角色", () => {
    const tune = fixture("tune");
    const holdout = fixture("holdout");
    expect(holdout).toEqual(fixture("holdout"));
    expect(holdout.questions.length).toBeGreaterThanOrEqual(120);
    const tuneProjects = new Set(tune.turns.map(turn => turn.project));
    expect(holdout.turns.every(turn => !tuneProjects.has(turn.project))).toBe(true);
    expect(new Set(holdout.questions.map(q => q.id)).size).toBe(holdout.questions.length);
    for (const data of [tune, holdout]) {
      for (const question of data.questions) {
        expect(question.evidence.length === 0).toBe(question.category === "unanswerable");
        for (const evidence of question.evidence) {
          expect(question.query.includes(evidence.quote)).toBe(false);
          const matches = data.turns.filter(turn => turn.project === question.project &&
            (turn.user.includes(evidence.quote) || turn.assistant.includes(evidence.quote)));
          expect(matches.map(turn => turn.id)).toEqual([evidence.turn]);
          expect(matches[0][evidence.role]).toContain(evidence.quote);
        }
      }
    }
  });

  it("長回合正反對照能抓出 dsh 頭段與 OpenCode 摘要輸入尾段的差異", () => {
    const { turns, questions } = fixture("holdout");
    for (const question of questions.filter(q => q.category.startsWith("long-"))) {
      const turn = turns.find(t => t.id === question.evidence[0].turn)!;
      expect(Array.from(turn.assistant).length).toBeGreaterThan(8000);
      expect(evidenceFound(question, currentCards([turn])[0].content)).toEqual([false]);
      expect(evidenceFound(question, digestInputs([turn])[0].content)).toEqual([question.category === "long-tail"]);
      expect(rawPassages([turn]).some(p => evidenceFound(question, p.content)[0])).toBe(true);
      expect(evidenceFound(question, "").every(Boolean)).toBe(false);
    }
  });

  it("保留可重組的 UTF-16 來源位置，鄰接限同回合，預算含完整包裝", () => {
    const turn = { id: "turn-a", project: "proj-a", user: "給我說明", assistant: "甲".repeat(1023) + "🧪乙".repeat(700) };
    const other = { ...turn, id: "turn-b", project: "proj-b" };
    const passages = rawPassages([turn, other]);
    let reconstructed = "";
    for (const passage of passages.filter(p => p.turn === turn.id && p.location?.role === "assistant")) {
      const { start, end } = passage.location!;
      expect(passage.content).toBe(turn.assistant.slice(start, end));
      expect(Array.from(passage.content).every(ch => ch.length > 1 || !/[\ud800-\udfff]/u.test(ch))).toBe(true);
      reconstructed += passage.content.slice(reconstructed.length - start);
    }
    expect(reconstructed).toBe(turn.assistant);
    expect(expand([passages[0]], neighborMap(passages)).every(p => p.turn === turn.id)).toBe(true);
    const packed = pack([passages[1], passages[2]], 140, text => Array.from(text).length);
    expect(packed.truncated).toBe(true);
    expect(packed.dropped).toBe(1);
    expect(Array.from(packed.block).length).toBeLessThanOrEqual(140);
    expect(packed.block).toMatch(/…\n<\/memory-context>$/);
  });
});
