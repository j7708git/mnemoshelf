/**
 * Stage 3 端到端評估：`mnemoshelf`（`dsh-plugin`／`opencode-plugin`）vs 純原始切片 Naive RAG。
 *
 * 預設跳過；明確執行方式：
 *   STAGE3_EVAL=1 RAW_MEMORY_BACKEND=real pnpm --filter @mnemoshelf/server exec vitest \
 *     --config eval/raw-memory/vitest.config.ts run eval/raw-memory/stage3-e2e.test.ts
 *
 * 固定 Reader 模型（選配，須明確設定才會送出外部或本機推論請求）：
 *   STAGE3_READER_BASE_URL=http://127.0.0.1:8080/v1
 *   STAGE3_READER_MODEL=qwen2.5-7b-instruct
 *   STAGE3_READER_API_KEY=<token>
 */
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../../../opencode-plugin/src/config.js";
import { planRecall } from "../../../opencode-plugin/src/recall.js";
import { buildMemoryBlock } from "../../../dsh-plugin/src/recall.js";
import type { RecallHitLike } from "../../../dsh-plugin/src/types.js";
import { createServer, type MnemoshelfServer } from "../../src/index.js";
import { NaiveRagBaseline } from "./naive-rag.js";
import { backend, NOW, REPO } from "./runtime.js";
import {
  aggregateStage3Scores,
  buildReaderPrompt,
  callReaderModel,
  readReaderConfigFromEnv,
  scoreContextRetrieval,
  scoreReaderResponse,
  type QuestionEvalRow,
  type SystemEvalSummary,
} from "./stage3-reader.js";
import { STAGE3_SEED, unseenFixture, type UnseenQuestion } from "./unseen-fixture.js";

const STAGE3_ENABLED = process.env.STAGE3_EVAL === "1";
const STAGE3_BUDGET_CHARS = 900;
const STAGE3_OUTPUT_DIR = path.join(REPO, ".tmp", "stage3-eval");

interface SearchApiResponse {
  hits: RecallHitLike[];
  degraded: boolean;
  degradedReason: string | null;
}

async function waitForEmbeddings(server: MnemoshelfServer, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const worker = server.memoryEmbedder.stats();
    const stats = await server.store.memoryEmbeddingStats(server.embedder.info.id);
    if (worker.queued === 0 && worker.processing === 0 && stats.pending === 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("等待 Mnemoshelf 記憶嵌入佇列清空逾時");
}

function formatMarkdownReport(input: {
  mode: string;
  embedderId: string;
  turnsCount: number;
  questionsCount: number;
  answerableCount: number;
  unanswerableCount: number;
  naiveChunksCount: number;
  summaries: readonly SystemEvalSummary[];
}): string {
  const lines: string[] = [
    "# Stage 3 未見題庫端到端評估報告",
    "",
    `- 種子：\`${STAGE3_SEED}\`（40 題未見題庫：可答 ${input.answerableCount} 題、拒答 ${input.unanswerableCount} 題，涵蓋 ${input.turnsCount} 個回合）`,
    `- Embedder 檢索後端：\`${input.mode}\`（\`${input.embedderId}\`）`,
    `- Naive RAG 切片數：\`${input.naiveChunksCount}\`（512 chars / overlap 64 / k=4 / budget 900）`,
    `- Reader 狀態：\`${input.summaries[0]?.readerStatus ?? "NOT_RUN"}\`${
      input.summaries[0]?.readerModel ? `（\`${input.summaries[0].readerModel}\`）` : ""
    }`,
    "",
    "## 總覽比較（900 Unicode code points 預算）",
    "",
    "| 系統 | 可答 context recall | 可答乾淨上下文率 | 無答案空區塊率 | 無答案陷阱洩漏率 | 平均字元 | 最大字元 | Reader 總正確率 | Reader 可答正確率 | Reader 拒答正確率 |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];

  const pct = (value: number | null) => (value === null ? "NOT_RUN" : `${(value * 100).toFixed(1)}%`);
  for (const s of input.summaries) {
    lines.push(
      `| ${s.system} | ${pct(s.answerableContextRecall)} | ${pct(s.answerableCleanContextRate)} | ${pct(
        s.unanswerableEmptyBlockRate,
      )} | ${pct(s.unanswerableTrapLeakRate)} | ${s.avgContextChars.toFixed(1)} | ${s.maxContextChars} | ${pct(
        s.readerOverallAccuracy,
      )} | ${pct(s.readerAnswerableAccuracy)} | ${pct(s.readerAbstentionAccuracy)} |`,
    );
  }

  lines.push("", "## 分類表現（contextClean / total；若有跑 Reader 附 readerCorrect）", "");
  lines.push("| 類別 | dsh-plugin | opencode-plugin | naive-rag-chunk512 |");
  lines.push("| --- | --- | --- | --- |");

  const categories = Object.keys(input.summaries[0]!.byCategory) as Array<keyof SystemEvalSummary["byCategory"]>;
  for (const cat of categories) {
    const cells = input.summaries.map((s) => {
      const b = s.byCategory[cat];
      const readerPart = b.readerCorrect === null ? "" : ` (LLM ${b.readerCorrect}/${b.total})`;
      return `${b.contextClean}/${b.total}${readerPart}`;
    });
    lines.push(`| ${cat} | ${cells.join(" | ")} |`);
  }

  return lines.join("\n") + "\n";
}

describe("Stage 3：40 題未見題庫與 Naive RAG 對照評估", () => {
  it.skipIf(!STAGE3_ENABLED)(
    "在真實 loopback server 與一致預算下完成檢索裝箱對比與可選 Reader 評估",
    async () => {
      const { turns, questions } = unseenFixture();
      const readerConfig = readReaderConfigFromEnv();
      const runtimeBackend = await backend();
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "mnemoshelf-stage3-"));
      const dataDir = path.join(tmpDir, "data");
      const webDir = path.join(tmpDir, "web");
      await mkdir(dataDir, { recursive: true });
      await mkdir(webDir, { recursive: true });
      const token = "stage3-eval-token";

      let server: MnemoshelfServer | null = null;
      let naiveRag: NaiveRagBaseline | null = null;

      try {
        server = await createServer({
          env: {},
          dataDir,
          webDir,
          token,
          port: 0,
          embedder: runtimeBackend.embedder,
          memoryEmbedding: { retryDelayMs: 0 },
        });
        const headers = {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        };

        for (let turnIndex = 0; turnIndex < turns.length; turnIndex += 1) {
          const turn = turns[turnIndex]!;
          const occurredAt = new Date(NOW.getTime() + turnIndex * 60_000).toISOString();
          const writeRes = await fetch(`${server.url}/memory-sources`, {
            method: "POST",
            headers,
            body: JSON.stringify({
              agent: "stage3-eval",
              scope: "project",
              project: turn.project,
              sourceSession: `session-${turn.project}`,
              sourceTurn: turn.id,
              messages: [
                { sourceMessage: `${turn.id}:u`, role: "user", content: turn.user, occurredAt },
                {
                  sourceMessage: `${turn.id}:a`,
                  role: "assistant",
                  content: turn.assistant,
                  occurredAt,
                },
              ],
            }),
          });
          expect(writeRes.status).toBe(201);
        }

        if (runtimeBackend.mode === "real") {
          await waitForEmbeddings(server);
        }

        naiveRag = await NaiveRagBaseline.create(runtimeBackend, turns);

        const dshRows: QuestionEvalRow[] = [];
        const opencodeRows: QuestionEvalRow[] = [];
        const naiveRows: QuestionEvalRow[] = [];

        const evaluateSystemRow = async (
          question: UnseenQuestion,
          retrievedCount: number,
          keptCount: number,
          block: string,
        ): Promise<QuestionEvalRow> => {
          const contextScore = scoreContextRetrieval(question, block);
          expect(contextScore.chars).toBeLessThanOrEqual(STAGE3_BUDGET_CHARS);

          if (readerConfig === null) {
            return {
              questionId: question.id,
              category: question.category,
              project: question.project,
              answerable: question.answerable,
              retrievedCount,
              keptCount,
              contextScore,
            };
          }

          const prompt = buildReaderPrompt({ query: question.query, contextBlock: block });
          const llmResult = await callReaderModel(readerConfig, prompt);
          const score = scoreReaderResponse(question, llmResult.answer);
          return {
            questionId: question.id,
            category: question.category,
            project: question.project,
            answerable: question.answerable,
            retrievedCount,
            keptCount,
            contextScore,
            reader: {
              answer: llmResult.answer,
              latencyMs: llmResult.latencyMs,
              score,
            },
          };
        };

        for (const question of questions) {
          const searchRes = await fetch(`${server.url}/memories/search`, {
            method: "POST",
            headers,
            body: JSON.stringify({
              query: question.query,
              project: question.project,
              k: 8,
              minScore: 0.65,
            }),
          });
          expect(searchRes.status).toBe(200);
          const searchBody = (await searchRes.json()) as SearchApiResponse;

          const dshBlock = buildMemoryBlock({
            hits: searchBody.hits,
            project: question.project,
            now: NOW,
            maxChars: STAGE3_BUDGET_CHARS,
            query: question.query,
          });
          dshRows.push(
            await evaluateSystemRow(question, searchBody.hits.length, dshBlock.kept, dshBlock.block),
          );

          const ocPlan = planRecall({
            hits: searchBody.hits as unknown as Parameters<typeof planRecall>[0]["hits"],
            query: question.query,
            settings: { ...DEFAULT_SETTINGS, hardChars: STAGE3_BUDGET_CHARS },
            project: question.project,
            dedupe: new Map(),
            turn: 1,
            now: NOW,
          });
          opencodeRows.push(
            await evaluateSystemRow(
              question,
              searchBody.hits.length,
              ocPlan.stats.kept,
              ocPlan.block,
            ),
          );

          const naiveRes = await naiveRag.search({
            project: question.project,
            query: question.query,
            budgetChars: STAGE3_BUDGET_CHARS,
          });
          naiveRows.push(
            await evaluateSystemRow(question, naiveRes.hits.length, naiveRes.keptCount, naiveRes.block),
          );
        }

        const readerModel = readerConfig?.model ?? null;
        const dshSummary = aggregateStage3Scores({
          system: "dsh-plugin",
          rows: dshRows,
          readerModel,
        });
        const opencodeSummary = aggregateStage3Scores({
          system: "opencode-plugin",
          rows: opencodeRows,
          readerModel,
        });
        const naiveSummary = aggregateStage3Scores({
          system: "naive-rag-chunk512",
          rows: naiveRows,
          readerModel,
        });
        const summaries = [dshSummary, opencodeSummary, naiveSummary] as const;

        await mkdir(STAGE3_OUTPUT_DIR, { recursive: true });
        await writeFile(
          path.join(STAGE3_OUTPUT_DIR, "stage3-summary.json"),
          JSON.stringify(
            {
              generatedAt: new Date().toISOString(),
              seed: STAGE3_SEED,
              backendMode: runtimeBackend.mode,
              embedderId: runtimeBackend.embedder.info.id,
              turnsCount: turns.length,
              questionsCount: questions.length,
              naiveChunksCount: naiveRag.chunkCount,
              budgetChars: STAGE3_BUDGET_CHARS,
              readerConfig: readerConfig
                ? { baseUrl: readerConfig.baseUrl, model: readerConfig.model }
                : null,
              summaries,
              details: {
                "dsh-plugin": dshRows,
                "opencode-plugin": opencodeRows,
                "naive-rag-chunk512": naiveRows,
              },
            },
            null,
            2,
          ) + "\n",
          "utf8",
        );

        await writeFile(
          path.join(STAGE3_OUTPUT_DIR, "stage3-report.md"),
          formatMarkdownReport({
            mode: runtimeBackend.mode,
            embedderId: runtimeBackend.embedder.info.id,
            turnsCount: turns.length,
            questionsCount: questions.length,
            answerableCount: questions.filter((q) => q.answerable).length,
            unanswerableCount: questions.filter((q) => !q.answerable).length,
            naiveChunksCount: naiveRag.chunkCount,
            summaries,
          }),
          "utf8",
        );

        expect(dshSummary.totalQuestions).toBe(40);
        expect(opencodeSummary.totalQuestions).toBe(40);
        expect(naiveSummary.totalQuestions).toBe(40);
        if (readerConfig === null) {
          expect(dshSummary.readerStatus).toBe("NOT_RUN");
          expect(opencodeSummary.readerStatus).toBe("NOT_RUN");
          expect(naiveSummary.readerStatus).toBe("NOT_RUN");
        } else {
          expect(dshSummary.readerStatus).toBe("COMPLETED");
        }
      } finally {
        if (naiveRag !== null) naiveRag.close();
        if (server !== null) await server.close();
        await runtimeBackend.embedder.dispose();
        await rm(tmpDir, { recursive: true, force: true });
      }
    },
    300_000,
  );
});
