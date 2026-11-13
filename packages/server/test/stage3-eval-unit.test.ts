import { describe, expect, it } from "vitest";
import { fixture } from "../eval/raw-memory/fixture.js";
import { chunkRawText, packNaiveRagHits, type NaiveRagHit } from "../eval/raw-memory/naive-rag.js";
import {
  aggregateStage3Scores,
  buildReaderPrompt,
  readReaderConfigFromEnv,
  scoreContextRetrieval,
  scoreReaderResponse,
} from "../eval/raw-memory/stage3-reader.js";
import { STAGE3_SEED, unseenFixture } from "../eval/raw-memory/unseen-fixture.js";

const chars = (text: string) => Array.from(text).length;

describe("Stage 3 未見題庫、Naive RAG 切片與 Reader 計分器單元驗證", () => {
  it("unseenFixture 含 40 題（30 可答 + 10 拒答），且與 tune／holdout 完全不重疊", () => {
    const unseen = unseenFixture();
    const tune = fixture("tune");
    const holdout = fixture("holdout");

    expect(STAGE3_SEED).toBe(482913);
    expect(unseen.questions).toHaveLength(40);
    expect(unseen.questions.filter((q) => q.answerable)).toHaveLength(30);
    expect(unseen.questions.filter((q) => !q.answerable)).toHaveLength(10);

    const existingProjects = new Set([
      ...tune.turns.map((t) => t.project),
      ...holdout.turns.map((t) => t.project),
    ]);
    const existingQueries = new Set([
      ...tune.questions.map((q) => q.query),
      ...holdout.questions.map((q) => q.query),
    ]);
    for (const turn of unseen.turns) {
      expect(existingProjects.has(turn.project)).toBe(false);
    }
    for (const q of unseen.questions) {
      expect(existingQueries.has(q.query)).toBe(false);
      if (q.answerable) {
        expect(q.expectedFacts.length).toBeGreaterThan(0);
      } else {
        expect(q.expectedFacts).toHaveLength(0);
      }
    }
  });

  it("chunkRawText 與 packNaiveRagHits 遵守 512/64 切片重疊與 900 code points 預算上限", () => {
    const longText = "甲".repeat(600) + "🚀".repeat(100);
    const chunks = chunkRawText(longText, 512, 64);
    expect(chunks.length).toBe(2);
    expect(Array.from(chunks[0]!)).toHaveLength(512);
    expect(Array.from(chunks[1]!)).toHaveLength(700 - (512 - 64));

    const hits: NaiveRagHit[] = [
      { id: 1, turnId: "t1", chunkIndex: 0, score: 0.9, source: "semantic", content: "內容甲".repeat(160) },
      { id: 2, turnId: "t2", chunkIndex: 0, score: 0.8, source: "semantic", content: "內容乙".repeat(200) },
    ];
    const packed = packNaiveRagHits(hits, 900);
    expect(chars(packed.block)).toBeLessThanOrEqual(900);
    expect(packed.keptCount).toBe(1);

    const singleOversize: NaiveRagHit[] = [
      { id: 3, turnId: "t3", chunkIndex: 0, score: 0.9, source: "semantic", content: "長".repeat(1200) },
    ];
    const packedSingle = packNaiveRagHits(singleOversize, 900);
    expect(chars(packedSingle.block)).toBe(900);
    expect(packedSingle.keptCount).toBe(1);
  });

  it("scoreReaderResponse 與 scoreContextRetrieval 具備明確的正／反對照組", () => {
    const { questions } = unseenFixture();
    const answerableQ = questions.find((q) => q.answerable && q.forbiddenFacts.length > 0)!;
    const unanswerableQ = questions.find((q) => !q.answerable && q.forbiddenFacts.length > 0)!;

    const idealAnswer = answerableQ.expectedFacts.map((group) => group[0]!).join("，");
    const wrongWithForbidden = `${idealAnswer}；另外仍沿用 ${answerableQ.forbiddenFacts[0]!}`;
    const falseAbstain = "不知道（記憶中沒有足夠依據）";

    expect(scoreReaderResponse(answerableQ, idealAnswer).correct).toBe(true);
    expect(scoreReaderResponse(answerableQ, wrongWithForbidden).correct).toBe(false);
    expect(scoreReaderResponse(answerableQ, falseAbstain).falseAbstention).toBe(true);
    expect(scoreReaderResponse(answerableQ, falseAbstain).correct).toBe(false);

    expect(scoreReaderResponse(unanswerableQ, falseAbstain).correct).toBe(true);
    expect(scoreReaderResponse(unanswerableQ, falseAbstain).abstained).toBe(true);
    expect(scoreReaderResponse(unanswerableQ, `應該是用 ${unanswerableQ.forbiddenFacts[0]!}`).correct).toBe(false);
    expect(scoreReaderResponse(unanswerableQ, `應該是用 ${unanswerableQ.forbiddenFacts[0]!}`).falsePositiveAnswer).toBe(
      true,
    );
    expect(
      scoreReaderResponse(
        unanswerableQ,
        `不知道（記憶中沒有足夠依據），但別專案有 ${unanswerableQ.forbiddenFacts[0]!}`,
      ).correct,
    ).toBe(false);

    expect(scoreContextRetrieval(answerableQ, idealAnswer).allFactsInContext).toBe(true);
    expect(scoreContextRetrieval(unanswerableQ, "").emptyBlock).toBe(true);
    expect(scoreContextRetrieval(unanswerableQ, unanswerableQ.forbiddenFacts[0]!).cleanContext).toBe(false);
  });

  it("readReaderConfigFromEnv、buildReaderPrompt 與 aggregateStage3Scores 在無 LLM 時誠實標記 NOT_RUN", () => {
    expect(readReaderConfigFromEnv({})).toBeNull();
    expect(readReaderConfigFromEnv({ STAGE3_READER_BASE_URL: "http://127.0.0.1:8080/v1" })).toBeNull();
    expect(
      readReaderConfigFromEnv({
        STAGE3_READER_BASE_URL: "http://127.0.0.1:8080/v1/",
        STAGE3_READER_MODEL: "test-model",
      }),
    ).toEqual({
      baseUrl: "http://127.0.0.1:8080/v1",
      model: "test-model",
      timeoutMs: 30_000,
    });

    const prompt = buildReaderPrompt({ query: "測試問題", contextBlock: "" });
    expect(prompt.user).toContain("(無檢索到的背景資料)");

    const q = unseenFixture().questions[0]!;
    const summary = aggregateStage3Scores({
      system: "dsh-plugin",
      readerModel: null,
      rows: [
        {
          questionId: q.id,
          category: q.category,
          project: q.project,
          answerable: q.answerable,
          retrievedCount: 1,
          keptCount: 1,
          contextScore: scoreContextRetrieval(q, q.expectedFacts.map((g) => g[0]!).join(" ")),
        },
      ],
    });
    expect(summary.readerStatus).toBe("NOT_RUN");
    expect(summary.readerOverallAccuracy).toBeNull();
    expect(summary.answerableContextRecall).toBe(1);
  });
});
