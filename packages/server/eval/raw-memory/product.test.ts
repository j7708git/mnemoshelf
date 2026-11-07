import { openDatabase, type Embedder, type MemorySourceMessage } from "@mnemoshelf/core";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import { MAX_BLOCK_CHARS, RECALL_K, RECALL_MIN_SCORE, RECALL_TIMEOUT_MS } from "../../../dsh-plugin/src/config.js";
import { buildMemoryBlock } from "../../../dsh-plugin/src/recall.js";
import { DEFAULT_SETTINGS } from "../../../opencode-plugin/src/config.js";
import { planRecall } from "../../../opencode-plugin/src/recall.js";
import { createServer, type MnemoshelfServer } from "../../src/index.js";
import type { MemoryRecallResponseBody } from "../../src/memory-search.js";
import { fixture, SEED, type Question, type Split } from "./fixture.js";
import { evidenceFound } from "./representations.js";
import { backend, bytes, chars, NOW, OUTPUT, quantiles, REPO, TOKEN_BUDGETS, type Backend } from "./runtime.js";

const COMMON_K = 8;
const MEASURED_SOURCES = [
  ["core", "src", "memory", "source.ts"],
  ["server", "src", "http", "app.ts"],
  ["server", "src", "memory-embedder.ts"],
  ["server", "src", "memory-policy.ts"],
  ["server", "src", "memory-search.ts"],
  ...["dsh-plugin", "opencode-plugin"].flatMap(plugin =>
    ["config.ts", "raw-recall.ts", "recall.ts"].map(file => [plugin, "src", file])),
];
type Hit = MemoryRecallResponseBody["hits"][number];
type View = {
  block: string;
  kept: number;
  sourceIds: number[];
};

async function sourceFingerprint(): Promise<string> {
  const hash = createHash("sha256");
  for (const parts of MEASURED_SOURCES) {
    const content = await readFile(path.join(REPO, "packages", ...parts));
    hash.update(JSON.stringify(parts));
    hash.update(String(content.length));
    hash.update(content);
  }
  return hash.digest("hex");
}

function packDsh(hits: Hit[], question: Question, budget: number): View {
  const result = buildMemoryBlock({ hits, project: question.project, query: question.query, now: NOW, maxChars: budget });
  if (result.chars > budget) throw new Error("dsh 封裝超出碼點預算");
  const sourceIds = Array.from(result.block.matchAll(/^\s*- \[source id=(\d+)\]$/gmu), match => Number(match[1]));
  return { ...result, sourceIds };
}

function packOpenCode(hits: Hit[], question: Question, budget: number): View {
  const result = planRecall({
    hits, project: question.project, query: question.query, now: NOW, dedupe: new Map(), turn: 1,
    settings: { ...DEFAULT_SETTINGS, hardChars: budget },
  });
  if (result.block.length > budget) throw new Error("OpenCode 封裝超出 UTF-16 預算");
  return {
    block: result.block,
    kept: result.stats.kept,
    sourceIds: [...new Set(result.injected.flatMap(item => item.sourceId === undefined ? [] : [item.sourceId]))],
  };
}

/** 只使用實際外掛封裝。token 量測以字元上限擬合，回傳結果逐一驗證真正的 token 數。 */
function tokenCappedPack(render: (cap: number) => View, maxChars: number, count: (text: string) => number, cap: number) {
  const full = render(maxChars);
  if (count(full.block) <= cap) return full;
  let low = 0;
  let high = maxChars;
  let best = render(0);
  while (low + 1 < high) {
    const mid = Math.floor((low + high) / 2);
    const current = render(mid);
    if (count(current.block) <= cap) {
      best = current;
      low = mid;
    } else {
      high = mid;
    }
  }
  expect(count(best.block)).toBeLessThanOrEqual(cap);
  return best;
}

function requestClient(instance: MnemoshelfServer, token: string) {
  return async <T>(pathname: string, payload?: unknown, status = 200): Promise<T> => {
    const response = await fetch(new URL(pathname, instance.url), {
      method: payload === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      signal: AbortSignal.timeout(30_000),
    });
    const body: unknown = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(status);
    return body as T;
  };
}

type Request = ReturnType<typeof requestClient>;

async function sizeOnDisk(file: string): Promise<number> {
  const db = openDatabase(file);
  try {
    db.pragma("wal_checkpoint(TRUNCATE)");
    return (await stat(file)).size;
  } finally {
    db.close();
  }
}

type SourcePage = {
  source: { id: number; chunkVersion: string };
  messages: Array<MemorySourceMessage & { messageIndex: number; start: number; end: number }>;
  next: { messageIndex: number; offset: number; policyVersion: number } | null;
};

async function readSource(request: Request, id: number, project: string): Promise<{ messages: string[]; pages: number }> {
  const pathname = `/memory-sources/${id}`;
  const query = new URLSearchParams({ project });
  const messages: string[] = [];
  for (let index = 0; index < 8; index += 1) {
    const page = await request<SourcePage>(`${pathname}?${query}`);
    expect(page.source).toMatchObject({ id, chunkVersion: "raw-v1" });
    for (const entry of page.messages) {
      const prefix = messages[entry.messageIndex] ?? "";
      expect(entry.role).toBe(entry.messageIndex === 0 ? "user" : "assistant");
      expect(prefix.length).toBe(entry.start);
      messages[entry.messageIndex] = prefix + entry.content;
      expect(messages[entry.messageIndex].length).toBe(entry.end);
    }
    if (page.next === null) return { messages, pages: index + 1 };
    for (const [key, value] of Object.entries(page.next)) query.set(key, String(value));
  }
  throw new Error("來源續讀超出合成測試上限");
}

function clockedEmbedder(bench: Backend) {
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  let lastQueryMs = 0;
  const documentsMs: number[] = [];
  const engine = bench.embedder;
  const embedder: Embedder = {
    info: engine.info,
    async embedQuery(query) {
      const started = performance.now();
      try {
        return await engine.embedQuery(query);
      } finally {
        lastQueryMs = performance.now() - started;
      }
    },
    async embedDocument(content, title) {
      await ready;
      const started = performance.now();
      try {
        return await engine.embedDocument(content, title);
      } finally {
        documentsMs.push(performance.now() - started);
      }
    },
    embedDocuments: engine.embedDocuments.bind(engine),
    embedImage: engine.embedImage.bind(engine),
    probe: engine.probe.bind(engine),
    // 同一離線模型由整個測試持有，分割之間只關閉伺服器。
    dispose: async () => {},
  };
  return { embedder, release, lastQueryMs: () => lastQueryMs, documentsMs };
}

async function lookup(request: Request, question: Question, k: number, minScore: number, queryMs: () => number) {
  const started = performance.now();
  const initial = await request<{ version: number }>("/memory-policy");
  const searchStarted = performance.now();
  const data = await request<MemoryRecallResponseBody>("/memories/search", {
    query: question.query, project: question.project, k, minScore,
  });
  const searchMs = performance.now() - searchStarted;
  const confirmed = await request<{ version: number }>("/memory-policy");
  const requestMs = performance.now() - started;
  expect(data.policyVersion).toBe(initial.version);
  expect(data.policyVersion).toBe(confirmed.version);
  expect(data.hits.every(hit => hit.project === question.project && hit.sourceType === "raw-turn")).toBe(true);
  return { data, requestMs, searchMs, queryMs: data.degraded ? 0 : queryMs() };
}

type Lookup = Awaited<ReturnType<typeof lookup>>;

function matchEvidence(question: Question, content: string, index: number): boolean {
  return evidenceFound({ ...question, evidence: [question.evidence[index]] }, content)[0];
}

function observe(
  question: Question, label: string, lookup: Lookup, view: View, packMs: number, bench: Backend, timedOut: boolean,
) {
  return {
    label,
    expected: question.evidence.length,
    evidence: evidenceFound(question, view.block),
    chars: chars(view.block),
    tokens: bench.tokens?.(view.block) ?? null,
    sourceIds: view.sourceIds,
    kept: view.kept,
    dropped: lookup.data.hits.length - view.kept,
    shortenedByPlugin: view.block.includes("…"),
    timedOut,
    block: view.block,
    requestMs: lookup.requestMs,
    searchMs: lookup.searchMs,
    queryMs: lookup.queryMs,
    packMs,
    totalMs: lookup.requestMs + packMs,
    nonEmbeddingMs: Math.max(0, lookup.requestMs - lookup.queryMs + packMs),
  };
}

type Row = ReturnType<typeof observe>;

function ranked(question: Question, lookup: Lookup, contentById: Map<number, string>) {
  return {
    degraded: lookup.data.degraded,
    fullChunkEvidence: question.evidence.map((evidence, i) => lookup.data.hits.some(hit =>
      hit.sourceType === "raw-turn" && hit.sourceTurn === evidence.turn && hit.role === evidence.role &&
      matchEvidence(question, contentById.get(hit.id) ?? "", i),
    )),
    snippetEvidence: question.evidence.map((evidence, i) => lookup.data.hits.some(hit =>
      hit.sourceType === "raw-turn" && hit.sourceTurn === evidence.turn && hit.role === evidence.role &&
      matchEvidence(question, hit.content, i),
    )),
    hits: lookup.data.hits.map(hit => ({
      id: hit.id,
      sourceId: hit.sourceId,
      sourceTurn: hit.sourceType === "raw-turn" ? hit.sourceTurn : null,
      role: hit.sourceType === "raw-turn" ? hit.role : null,
      messageIndex: hit.messageIndex,
      rank: hit.rank,
      ranking: hit.source,
      score: hit.score,
      sourceStart: hit.sourceStart,
      sourceEnd: hit.sourceEnd,
      snippetStart: hit.sourceType === "raw-turn" ? hit.snippetStart : null,
      snippetEnd: hit.sourceType === "raw-turn" ? hit.snippetEnd : null,
      snippetAnchor: hit.sourceType === "raw-turn" ? hit.snippetAnchor ?? null : null,
      sourceTruncated: hit.sourceType === "raw-turn" ? hit.truncated : false,
      shortenedByServer: hit.sourceType === "raw-turn" &&
        (hit.snippetStart !== hit.sourceStart || hit.snippetEnd !== hit.sourceEnd),
      snippet: hit.content,
    })),
  };
}

function summarize(rows: Row[]) {
  const answered = rows.filter(row => row.expected > 0);
  return {
    complete: answered.filter(row => row.evidence.every(Boolean)).length,
    answerable: answered.length,
    expected: answered.reduce((sum, row) => sum + row.expected, 0),
    found: answered.reduce((sum, row) => sum + row.evidence.filter(Boolean).length, 0),
    noAnswerWithContext: rows.filter(row => row.expected === 0 && row.kept > 0).length,
    omittedCandidates: rows.filter(row => row.dropped > 0).length,
    shortenedByPlugin: rows.filter(row => row.shortenedByPlugin).length,
    timedOut: rows.filter(row => row.timedOut).length,
    chars: quantiles(rows.map(row => row.chars)),
    tokens: quantiles(rows.flatMap(row => row.tokens ?? [])),
    totalMs: quantiles(rows.map(row => row.totalMs)),
    nonEmbeddingMs: quantiles(rows.map(row => row.nonEmbeddingMs)),
  };
}

async function runSplit(split: Split, bench: Backend, output: string, allowOrigin: (origin: string) => void) {
  const { turns, questions } = fixture(split);
  const dataDir = path.join(output, split);
  const token = randomUUID();
  const instrument = clockedEmbedder(bench);
  const instance = await createServer({
    env: {}, dataDir, webDir: path.join(dataDir, "no-web-ui"), token, port: 0, embedder: instrument.embedder,
  });
  try {
    allowOrigin(instance.url);
    const request = requestClient(instance, token);
    const schemaBytes = await sizeOnDisk(instance.config.dbPath);
    const writesMs: number[] = [];
    const sources = [];
    let rows = 0;
    for (const turn of turns) {
      const started = performance.now();
      const saved = await request<{ saved: boolean; redacted: boolean; source: { id: number }; memoryIds: number[] }>(
        "/memory-sources", {
          agent: "raw-memory-eval", scope: "project", project: turn.project,
          sourceSession: turn.project, sourceTurn: turn.id,
          messages: [
            { sourceMessage: `${turn.id}-user`, role: "user", content: turn.user, occurredAt: null },
            { sourceMessage: `${turn.id}-assistant`, role: "assistant", content: turn.assistant, occurredAt: null },
          ],
        }, 201,
      );
      writesMs.push(performance.now() - started);
      expect(saved).toMatchObject({ saved: true, redacted: false });
      rows += saved.memoryIds.length;
      sources.push({ turn, id: saved.source.id });
    }
    const writtenBytes = await sizeOnDisk(instance.config.dbPath);
    const embeddingStarted = performance.now();
    if (bench.mode === "real") {
      instrument.release();
      await expect.poll(() => {
        const work = instance.memoryEmbedder.stats();
        return work.embedded + work.failed + work.tooLong;
      }, { timeout: 300_000, interval: 100 }).toBe(rows);
    }
    const indexWallMs = bench.mode === "real" ? performance.now() - embeddingStarted : null;
    const embeddingState = await instance.store.memoryEmbeddingStats(bench.embedder.info.id);
    if (bench.mode === "real") expect(embeddingState.ready).toBe(rows);
    const indexedBytes = await sizeOnDisk(instance.config.dbPath);
    const contentById = new Map<number, string>();
    const reassembledSources = [];
    for (const { turn, id } of sources) {
      const reassembled = await readSource(request, id, turn.project);
      expect(reassembled.messages).toEqual([turn.user, turn.assistant]);
      reassembledSources.push({ turn: turn.id, id, pages: reassembled.pages });
      for (const chunk of await instance.store.listMemorySourceChunks(id)) contentById.set(chunk.id, chunk.content);
    }

    const comparisons = [];
    for (const question of questions) {
      const common = await lookup(request, question, COMMON_K, DEFAULT_SETTINGS.minScore, instrument.lastQueryMs);
      const dsh = RECALL_K === COMMON_K && RECALL_MIN_SCORE === DEFAULT_SETTINGS.minScore ? common
        : await lookup(request, question, RECALL_K, RECALL_MIN_SCORE, instrument.lastQueryMs);
      const previousK = await lookup(request, question, 4, RECALL_MIN_SCORE, instrument.lastQueryMs);
      if (bench.mode === "real") expect(dsh.data.degraded || common.data.degraded).toBe(false);
      else expect(dsh.data.degraded && common.data.degraded).toBe(true);

      const variants: Row[] = [];
      const observePacked = (label: string, data: Lookup, render: () => View, timedOut = false) => {
        const started = performance.now();
        const packed = timedOut ? { block: "", kept: 0, sourceIds: [] } : render();
        const packMs = performance.now() - started;
        variants.push(observe(question, label, data, packed, packMs, bench, timedOut));
      };
      observePacked("dsh-native", dsh, () => packDsh(dsh.data.hits, question, MAX_BLOCK_CHARS),
        dsh.requestMs > RECALL_TIMEOUT_MS);
      observePacked("dsh/k4-diagnostic", previousK, () => packDsh(previousK.data.hits, question, MAX_BLOCK_CHARS));
      observePacked("opencode-native", common, () => packOpenCode(common.data.hits, question, DEFAULT_SETTINGS.hardChars),
        common.searchMs > DEFAULT_SETTINGS.timeoutMs);
      const dshPack = (budget: number) => packDsh(common.data.hits, question, budget);
      const opencodePack = (budget: number) => packOpenCode(common.data.hits, question, budget);
      for (const [name, render, limit] of [
        ["dsh", dshPack, MAX_BLOCK_CHARS], ["opencode", opencodePack, DEFAULT_SETTINGS.hardChars],
      ] as const) {
        observePacked(`${name}/common:900cp`, common, () => render(900));
        const tokenizer = bench.tokens;
        if (tokenizer !== null) {
          for (const cap of TOKEN_BUDGETS) {
            observePacked(`${name}/embedder:${cap}tok`, common, () => tokenCappedPack(render, limit, tokenizer, cap));
          }
        }
      }
      comparisons.push({ ...question, native: ranked(question, dsh, contentById), common: ranked(question, common, contentById),
        k4Diagnostic: ranked(question, previousK, contentById), variants });
    }

    const groups = new Map<string, Row[]>();
    for (const q of comparisons) {
      for (const row of q.variants) {
        const group = groups.get(row.label) ?? [];
        group.push(row);
        groups.set(row.label, group);
      }
    }
    return {
      split, seed: SEED, mode: bench.mode, embedderId: bench.embedder.info.id, firstQueryMs: bench.firstQueryMs,
      dshNativeK: RECALL_K, commonK: COMMON_K,
      questions: questions.length, reassembledSources, rows, comparisons,
      summary: Object.fromEntries([...groups].map(([key, values]) => [key, summarize(values)])),
      sourceTextBytes: turns.reduce((sum, turn) => sum + bytes(turn.user) + bytes(turn.assistant), 0),
      chunksTextBytes: [...contentById.values()].reduce((sum, content) => sum + bytes(content), 0),
      schemaBytes, sourceChunkFtsDbBytes: writtenBytes - schemaBytes, vectorDbBytes: indexedBytes - writtenBytes,
      vectorPayloadBytes: embeddingState.ready * bench.embedder.info.dim * 4,
      embeddingState, indexWallMs, documentMs: quantiles(instrument.documentsMs),
      writeMs: quantiles(writesMs),
    };
  } finally {
    instrument.release();
    await instance.close();
  }
}

it.skipIf(process.env.RAW_MEMORY_PRODUCT !== "1")("量測產品來源 API、搜尋節錄與外掛的共同預算", async () => {
  const selected = process.env.RAW_MEMORY_SPLIT ?? "tune";
  expect(["tune", "holdout"]).toContain(selected);
  const split = selected as Split;
  await mkdir(OUTPUT, { recursive: true });
  const output = await mkdtemp(path.join(OUTPUT, "product-"));
  const http = globalThis.fetch;
  let allowedOrigin: string | undefined;
  let blockedRequests = 0;
  let localRequests = 0;
  vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) => {
    const target = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const isSourceRead = /^\/memory-sources\/\d+$/u.test(target.pathname);
    const isBenchRoute = ["/memory-sources", "/memories/search", "/memory-policy"].includes(target.pathname);
    if (target.hostname !== "127.0.0.1" || target.origin !== allowedOrigin || (!isSourceRead && !isBenchRoute)) {
      blockedRequests += 1;
      throw new Error("合成產品評測只允許隔離服務的來源、政策及搜尋端點");
    }
    localRequests += 1;
    return http(input, init);
  });
  let bench: Backend | undefined;
  try {
    const measuredSourceSha256 = await sourceFingerprint();
    bench = await backend();
    const result = await runSplit(split, bench, output, origin => { allowedOrigin = origin; });
    expect(blockedRequests).toBe(0);
    expect(await sourceFingerprint()).toBe(measuredSourceSha256);
    await writeFile(path.join(output, `${split}.json`), JSON.stringify({
      ...result, measuredSourceSha256, blockedRequests, localRequests, reader: null,
    }, null, 2) + "\n");
    console.log(`${split} ${bench.mode} ${result.questions} 題 ${path.relative(REPO, output)}`);
  } finally {
    vi.unstubAllGlobals();
    await bench?.embedder.dispose();
  }
});
