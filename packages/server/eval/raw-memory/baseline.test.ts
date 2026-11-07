import { openDatabase, runMigrations, SqliteMetadataStore } from "@mnemoshelf/core";
import { DEFAULT_MODEL_ID } from "@mnemoshelf/embedder-transformers";
import { mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { buildMemoryBlock, MAX_BLOCK_CHARS, RECALL_K, RECALL_MIN_SCORE, RECALL_TIMEOUT_MS } from "./historical.js";
import { searchMemories } from "./historical-search.js";
import { fixture, SEED, type Question, type Split } from "./fixture.js";
import {
  CHUNK_UNITS, OVERLAP_UNITS, currentCards, digestInputs, evidenceFound, expand, neighborMap, pack, rawPassages,
  type Passage,
} from "./representations.js";

import { backend, bytes, chars, NOW, OUTPUT, quantiles, REPO, TOKEN_BUDGETS, type Backend } from "./runtime.js";

const CANDIDATE_K = 8;
const BATCH = 8;

async function buildIndex(passages: Passage[], file: string, bench: Backend) {
  const db = openDatabase(file);
  try {
    runMigrations(db);
    const dbSize = async () => {
      db.pragma("wal_checkpoint(TRUNCATE)");
      return (await stat(file)).size;
    };
    const schemaBytes = await dbSize();
    const store = new SqliteMetadataStore(db);
    const byId = new Map<number, Passage>();
    for (const passage of passages) {
      const memory = await store.addMemory({
        content: passage.content, agent: "raw-memory-eval", scope: "project", kind: "fact",
        project: passage.project, supersedes: null, sourceSession: passage.project, sourceMessage: passage.id,
      });
      byId.set(memory.id, passage);
    }
    const keywordDbBytes = await dbSize() - schemaBytes;

    const batchMs: number[] = [];
    const embeddingStarted = performance.now();
    if (bench.mode === "real") {
      // 依字元長度分組減少 padding。沿用 embedder 自己的 8192 token 限制及批次預算。
      const ordered = [...byId].sort((a, b) => a[1].content.length - b[1].content.length);
      for (let offset = 0; offset < ordered.length; offset += BATCH) {
        const batch = ordered.slice(offset, offset + BATCH);
        const started = performance.now();
        const vectors = await bench.embedder.embedDocuments(batch.map(([, passage]) => ({ text: passage.content })));
        batchMs.push(performance.now() - started);
        for (const [index, [id]] of batch.entries()) {
          await store.markMemoryEmbedded(id, bench.embedder.info.id, vectors[index]);
        }
      }
    }
    const embeddingWallMs = bench.mode === "real" ? performance.now() - embeddingStarted : null;
    const corpus = {
      rows: passages.length,
      textBytes: passages.reduce((sum, passage) => sum + bytes(passage.content), 0),
      schemaBytes,
      keywordDbBytes,
      vectorDbBytes: await dbSize() - schemaBytes - keywordDbBytes,
      vectorPayloadBytes: bench.mode === "real" ? passages.length * bench.embedder.info.dim * 4 : 0,
      embeddingWallMs,
      batchCount: batchMs.length,
      batchMs: quantiles(batchMs),
      embeddingFailures: bench.mode === "real" ? 0 : null,
    };
    return { store, byId, corpus, close: () => db.close() };
  } catch (error) {
    db.close();
    throw error;
  }
}

type Index = Awaited<ReturnType<typeof buildIndex>>;
type Variant = "dsh-current" | "card" | "raw" | "neighbor";
type Budget = "dsh:900cp" | "common:900cp" | `embedder:${number}tok`;

interface Observation {
  question: string;
  category: string;
  variant: Variant;
  budget: Budget;
  ranked: { passage: string; source: string; rank: number }[];
  packed: string[];
  expected: number;
  retrieved: number;
  injected: number;
  evidence: boolean[];
  chars: number;
  tokens: number | null;
  dropped: number;
  truncated: boolean;
  degraded: boolean;
  timedOut: boolean;
  searchMs: number;
  packMs: number;
}

async function lookup(index: Index, bench: Backend, question: Question, k: number) {
  const start = performance.now();
  const found = await searchMemories({ store: index.store, embedder: bench.embedder }, {
    query: question.query, project: question.project, k, minScore: RECALL_MIN_SCORE,
  });
  const ms = performance.now() - start;
  if (bench.mode === "real" && found.degraded) throw new Error(`真向量模式降級 ${found.degradedReason}`);
  const ranked = found.hits.map(hit => ({ passage: index.byId.get(hit.id)!.id, source: hit.source, rank: hit.rank }));
  const passages = found.hits.map(hit => ({ ...index.byId.get(hit.id)!, content: hit.content }));
  expect(passages.every(p => p.project === question.project)).toBe(true);
  return { found, ranked, passages, ms };
}

function observationsOf(
  question: Question, lookupResult: Awaited<ReturnType<typeof lookup>>, variant: Variant, bench: Backend,
  passages: Passage[],
): Observation[] {
  const { found, ranked, ms } = lookupResult;
  const retrieved = question.evidence.filter(evidence =>
    lookupResult.passages.some(passage => evidenceFound({ ...question, evidence: [evidence] }, passage.content)[0])).length;
  const toRow = (
    budget: Budget, block: string, ids: string[], dropped: number, truncated: boolean, packMs: number,
  ): Observation => {
    const evidence = evidenceFound(question, block);
    return {
      question: question.id, category: question.category, variant, budget, ranked, packed: ids,
      expected: evidence.length, retrieved, injected: evidence.filter(Boolean).length, evidence,
      chars: chars(block), tokens: bench.tokens?.(block) ?? null, dropped, truncated,
      degraded: found.degraded, timedOut: variant === "dsh-current" && ms > RECALL_TIMEOUT_MS,
      searchMs: ms, packMs,
    };
  };

  if (variant === "dsh-current") {
    const start = performance.now();
    const built = found.degraded || ms > RECALL_TIMEOUT_MS
      ? { block: "", kept: 0 }
      : buildMemoryBlock({ hits: found.hits, project: question.project, now: NOW });
    return [toRow("dsh:900cp", built.block, passages.slice(0, built.kept).map(p => p.id),
      passages.length - built.kept, /…\n<\/memory-context>$/u.test(built.block), performance.now() - start)];
  }

  const budgets: { label: Budget; limit: number; count: (text: string) => number }[] = [
    { label: "common:900cp", limit: MAX_BLOCK_CHARS, count: chars },
  ];
  if (bench.tokens !== null) {
    for (const limit of TOKEN_BUDGETS) budgets.push({ label: `embedder:${limit}tok`, limit, count: bench.tokens });
  }
  return budgets.map(({ label, limit, count }) => {
    const start = performance.now();
    const result = pack(passages, limit, count);
    return toRow(label, result.block, result.ids, result.dropped, result.truncated, performance.now() - start);
  });
}

function summarize(rows: Observation[]) {
  const answerable = rows.filter(row => row.expected > 0);
  const missing = rows.filter(row => row.expected === 0);
  const sum = (key: "expected" | "injected" | "retrieved") => answerable.reduce((n, row) => n + row[key], 0);
  return {
    questions: rows.length,
    answerable: answerable.length,
    complete: answerable.filter(row => row.injected === row.expected).length,
    spans: { expected: sum("expected"), retrieved: sum("retrieved"), injected: sum("injected") },
    noAnswer: missing.length,
    noAnswerWithContext: missing.filter(row => row.packed.length > 0).length,
    truncated: rows.filter(row => row.truncated).length,
    dropped: rows.filter(row => row.dropped > 0).length,
    degraded: rows.filter(row => row.degraded).length,
    timedOut: rows.filter(row => row.timedOut).length,
    hitSources: {
      semantic: rows.flatMap(row => row.ranked).filter(hit => hit.source === "semantic").length,
      keyword: rows.flatMap(row => row.ranked).filter(hit => hit.source === "keyword").length,
    },
    chars: quantiles(rows.map(row => row.chars)),
    tokens: quantiles(rows.flatMap(row => row.tokens === null ? [] : [row.tokens])),
    searchMs: quantiles(rows.map(row => row.searchMs)),
    packMs: quantiles(rows.map(row => row.packMs)),
    totalMs: quantiles(rows.map(row => row.searchMs + row.packMs)),
  };
}

async function runSplit(split: Split, bench: Backend, output: string) {
  const { turns, questions } = fixture(split);
  const cards = currentCards(turns);
  const raw = rawPassages(turns);
  const digest = new Map(digestInputs(turns).map(p => [p.turn, p.content]));
  const neighbors = neighborMap(raw);
  const rawBytes = turns.reduce((sum, turn) => sum + bytes(turn.user) + bytes(turn.assistant), 0);
  const cardIndex = await buildIndex(cards, path.join(output, `${split}-cards.sqlite`), bench);
  try {
    const rawIndex = await buildIndex(raw, path.join(output, `${split}-raw.sqlite`), bench);
    try {
      const rows: Observation[] = [];
      for (const question of questions) {
        const current = await lookup(cardIndex, bench, question, RECALL_K);
        rows.push(...observationsOf(question, current, "dsh-current", bench, current.passages));

        const card = await lookup(cardIndex, bench, question, CANDIDATE_K);
        rows.push(...observationsOf(question, card, "card", bench, card.passages));

        const source = await lookup(rawIndex, bench, question, CANDIDATE_K);
        rows.push(...observationsOf(question, source, "raw", bench, source.passages));
        // 用同一組排名展開。另量展開時間並計入此組的封裝成本。
        const started = performance.now();
        const expanded = expand(source.passages, neighbors);
        const expandMs = performance.now() - started;
        rows.push(...observationsOf(question, source, "neighbor", bench, expanded)
          .map(row => ({ ...row, packMs: row.packMs + expandMs })));
      }

      const groups: Record<string, Observation[]> = {};
      for (const row of rows) (groups[`${row.variant}/${row.budget}`] ??= []).push(row);
      const stats = Object.fromEntries(Object.entries(groups).map(([name, group]) => [
        name, {
          ...summarize(group),
          byCategory: Object.fromEntries([...new Set(group.map(row => row.category))].map(category => [
            category, summarize(group.filter(row => row.category === category)),
          ])),
        },
      ]));

      const comparisons = questions.map(question => ({
        ...question,
        opencodePromptEvidence: question.evidence.map(evidence =>
          evidenceFound({ ...question, evidence: [evidence] }, digest.get(evidence.turn) ?? "")[0]),
        observations: rows.filter(row => row.question === question.id),
      }));

      return {
        turns: turns.length, questions: questions.length, rawBytes,
        corpus: { card: cardIndex.corpus, raw: rawIndex.corpus },
        stats, comparisons,
      };
    } finally {
      rawIndex.close();
    }
  } finally {
    cardIndex.close();
  }
}

it.skipIf(process.env.RAW_MEMORY_BENCH !== "1")("量測固定合成題庫的原文記憶基準", async () => {
  const requested = process.env.RAW_MEMORY_SPLIT ?? "both";
  const splits: Split[] = requested === "both" ? ["tune", "holdout"]
    : requested === "tune" || requested === "holdout" ? [requested]
    : [];
  if (splits.length === 0) throw new Error("RAW_MEMORY_SPLIT 必須是 both、tune 或 holdout");

  await mkdir(OUTPUT, { recursive: true });
  const output = await mkdtemp(path.join(OUTPUT, "run-"));
  const bench = await backend();
  try {
    const config = {
      mode: bench.mode, seed: SEED, chunkUnits: CHUNK_UNITS, overlapUnits: OVERLAP_UNITS,
      candidateK: CANDIDATE_K, tokenBudgets: bench.tokens === null ? [] : TOKEN_BUDGETS,
      embedderId: bench.embedder.info.id, tokenizerId: bench.tokens === null ? null : DEFAULT_MODEL_ID,
      runtime: bench.embedder.runtimeStatus ?? null, firstQueryMs: bench.firstQueryMs,
      reader: null,
    };
    for (const split of splits) {
      const results = await runSplit(split, bench, output);
      await writeFile(path.join(output, `${split}.json`), JSON.stringify({ config, ...results }, null, 2) + "\n");
      console.log(`${split} ${bench.mode} ${results.questions} 題 ${path.relative(REPO, output)}`);
    }
  } finally {
    await bench.embedder.dispose();
  }
});
