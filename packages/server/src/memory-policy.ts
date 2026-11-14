import { organizationOf } from "./memory-organization.js";
import {
  mapMaskedRange,
  maskSecrets,
  maskSecretsWithSpans,
  type MaskSecretsResult,
  type MaskSecretsWithSpansResult,
  type Memory,
  type MemoryPolicy,
  type MemorySource,
  type MemorySourceMessage,
  type MetadataStore,
} from "@mnemoshelf/core";

export function memoryContentView(content: string, policy: Pick<MemoryPolicy, "maskSecrets">): MaskSecretsResult {
  return policy.maskSecrets ? maskSecrets(content) : { text: content, redacted: false, count: 0 };
}

function messageView(content: string, policy: MemoryPolicy): MaskSecretsWithSpansResult {
  return policy.maskSecrets
    ? maskSecretsWithSpans(content)
    : { text: content, redacted: false, count: 0, spans: [] };
}

export function metadataView(text: string): string;
export function metadataView(text: string | null): string | null;
export function metadataView(text: string | null): string | null {
  return text === null ? null : maskSecrets(text).text;
}

export function sourceMessageView(message: MemorySourceMessage, policy: MemoryPolicy): MemorySourceMessage {
  return {
    ...message,
    sourceMessage: metadataView(message.sourceMessage),
    content: memoryContentView(message.content, policy).text,
  };
}

export function splitsSurrogate(text: string, offset: number): boolean {
  const left = text.charCodeAt(offset - 1);
  const right = text.charCodeAt(offset);
  return left >= 0xd800 && left <= 0xdbff && right >= 0xdc00 && right <= 0xdfff;
}

type RawMemoryDetails = {
  sourceType: "raw-turn";
  role: MemorySourceMessage["role"];
  occurredAt: string | null;
  sourceTurn: string;
  hasMore: true;
  snippetStart: number;
  snippetEnd: number;
  /** 字面命中在遮罩後節錄內的 UTF-16 位置。 */
  snippetAnchor?: number;
  truncated: boolean;
};

export type MemoryView = Memory & (RawMemoryDetails | { sourceType: "legacy-memory" });
type MemoryPresentation = { memory: Memory; source: MemorySource | null };
export type PrepareMemoryPresentation<T> = () => Promise<(policy: MemoryPolicy) => T>;
type SnippetOptions = { query: string; maxChars: number };

const querySegmenter = new Intl.Segmenter("und", { granularity: "word" });
type SnippetPattern = { expression: RegExp; strength: number };
type SnippetPatterns = { exact: RegExp; terms: SnippetPattern[] };
type SnippetRange = { start: number; end: number; anchor?: number };
type LocatedTerm = { index: number; length: number };

function literalPattern(text: string): RegExp {
  return new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
}

function strongestPatterns(terms: Map<string, number>): SnippetPattern[] {
  return [...terms].sort((a, b) => b[1] - a[1]).slice(0, 24)
    .map(([text, strength]) => ({ expression: literalPattern(text), strength }));
}

function snippetPatterns(query: string): SnippetPatterns {
  // 舊版統一搜尋允許較大的 query，定位節錄只需有限的字面候選。
  const phrase = query.trim().slice(0, 2_000);
  const words = [...querySegmenter.segment(phrase)].filter(({ isWordLike }) => isWordLike);
  const singles = new Map<string, number>();
  const phrases = new Map<string, number>();
  for (const [index, word] of words.entries()) {
    if (word.segment.length >= 2) singles.set(word.segment.toLowerCase(), Math.min(word.segment.length, 24));
    let previousEnd = word.index + word.segment.length;
    for (let distance = 1; distance <= 2; distance += 1) {
      const next = words[index + distance];
      if (next === undefined || !/^\s*$/u.test(phrase.slice(previousEnd, next.index))) break;
      previousEnd = next.index + next.segment.length;
      const joined = phrase.slice(word.index, previousEnd);
      if (joined.length >= 3) phrases.set(joined.toLowerCase(), Math.min(joined.length, 24) + distance * 2);
    }
  }
  return { exact: literalPattern(phrase), terms: [...strongestPatterns(phrases), ...strongestPatterns(singles)] };
}

function findSnippetAnchor(chunk: string, patterns: SnippetPatterns, proximity: number): LocatedTerm | undefined {
  const exact = chunk.matchAll(patterns.exact).next().value;
  if (exact !== undefined) return { index: exact.index, length: exact[0].length };

  const weights: number[] = [];
  const matches = patterns.terms.flatMap(({ expression, strength }, term) => {
    const found = [...chunk.matchAll(expression)];
    // 同一詞在片段內越常重複，對定位的貢獻越小。
    weights[term] = Math.round(strength * 100 / Math.sqrt(found.length || 1));
    return found.map((match) => ({ index: match.index, length: match[0].length, term }));
  }).sort((a, b) => a.index - b.index);

  const counts = new Uint16Array(weights.length);
  let left = 0;
  let score = 0;
  let bestScore = 0;
  let bestStart = 0;
  let bestEnd = -1;
  for (const [right, match] of matches.entries()) {
    if (counts[match.term]++ === 0) score += weights[match.term]!;
    while (match.index - matches[left]!.index > proximity) {
      const term = matches[left++]!.term;
      if (--counts[term] === 0) score -= weights[term]!;
    }
    if (score > bestScore) {
      bestScore = score;
      bestStart = left;
      bestEnd = right;
    }
  }

  let anchor: LocatedTerm | undefined;
  let anchorWeight = 0;
  for (let index = bestStart; index <= bestEnd; index += 1) {
    const match = matches[index]!;
    const weight = weights[match.term]!;
    if (weight <= anchorWeight) continue;
    anchorWeight = weight;
    anchor = match;
  }
  return anchor;
}

function snippetRange(
  text: string, start: number, end: number, maxChars: number, patterns: SnippetPatterns,
): SnippetRange {
  const chunk = text.slice(start, end);
  const match = findSnippetAnchor(chunk, patterns, Math.min(128, Math.floor(maxChars / 2)));
  const anchor = match === undefined ? undefined : start + match.index;
  if (chunk.length <= maxChars) return { start, end, anchor };
  // 保留少量前文。命中靠近尾端時，讓節錄縮短以保留注入預算。
  const lead = Math.max(0, Math.min(96, maxChars - (match?.length ?? 0)));
  const from = anchor === undefined
    ? start + Math.floor((chunk.length - maxChars) / 2)
    : Math.max(start, anchor - lead);
  const safeStart = from - Number(splitsSurrogate(text, from));
  const to = Math.min(end, safeStart + maxChars);
  return { start: safeStart, end: to - Number(splitsSurrogate(text, to)), anchor };
}

/** 先載入來源，待所有非同步工作完成後再讀取政策並同步呈現。 */
export async function loadMemoryPresentations(
  store: MetadataStore,
  memories: readonly Memory[],
): Promise<MemoryPresentation[]> {
  const sources = new Map<number, MemorySource | null>();
  for (const memory of memories) {
    if (memory.sourceId == null || sources.has(memory.sourceId)) continue;
    sources.set(memory.sourceId, await store.getMemorySource(memory.sourceId));
  }
  return memories.flatMap<MemoryPresentation>((memory) => {
    if (memory.sourceId == null) return [{ memory, source: null }];
    const source = sources.get(memory.sourceId);
    if (source == null || source.deletedAt !== null || source.chunkVersion !== memory.chunkVersion) return [];
    // 片段查詢後可能已被移到其他 scope，使用目前的來源判斷可見範圍。
    return [{ memory: { ...memory, ...organizationOf(source), scope: source.scope, project: source.project }, source }];
  });
}

/** 排名可能在鎖外完成，回應組裝前依 id 讀取仍有效的記憶與來源。 */
export async function loadCurrentMemoryPresentations(
  store: MetadataStore,
  ids: readonly number[],
): Promise<MemoryPresentation[]> {
  const memories = (await Promise.all(ids.map((id) => store.getMemory(id))))
    .filter((memory): memory is Memory => memory !== null && memory.deletedAt === null);
  return loadMemoryPresentations(store, memories);
}

/** 同一個回應內，每則完整原文最多做一次遮罩與範圍映射準備。 */
export function createMemoryPresenter(policy: MemoryPolicy) {
  const views = new Map<MemorySourceMessage, MaskSecretsWithSpansResult>();
  const patterns = new Map<string, SnippetPatterns>();

  return ({ memory, source }: MemoryPresentation, snippet?: SnippetOptions): MemoryView | null => {
    const metadata = {
      agent: metadataView(memory.agent),
      originProject: metadataView(memory.originProject),
      assignedProject: metadataView(memory.assignedProject),
      project: metadataView(memory.project),
      sourceSession: metadataView(memory.sourceSession),
      sourceMessage: metadataView(memory.sourceMessage),
    };
    if (source === null) {
      return {
        ...memory,
        ...metadata,
        content: memoryContentView(memory.content, policy).text,
        sourceType: "legacy-memory",
      };
    }

    const { messageIndex, sourceStart, sourceEnd } = memory;
    if (messageIndex == null || sourceStart == null || sourceEnd == null) return null;
    const message = source.messages[messageIndex];
    if (message === undefined) return null;
    let view = views.get(message);
    if (view === undefined) {
      view = messageView(message.content, policy);
      views.set(message, view);
    }
    let range: SnippetRange = { start: sourceStart, end: sourceEnd };
    if (snippet !== undefined) {
      let candidates = patterns.get(snippet.query);
      if (candidates === undefined) {
        candidates = snippetPatterns(snippet.query);
        patterns.set(snippet.query, candidates);
      }
      range = snippetRange(message.content, sourceStart, sourceEnd, snippet.maxChars, candidates);
    }
    const displayed = mapMaskedRange(view.spans, range.start, range.end);
    const snippetAnchor = range.anchor === undefined
      ? undefined
      : mapMaskedRange(view.spans, range.anchor, range.anchor).start - displayed.start;
    return {
      ...memory,
      ...metadata,
      content: view.text.slice(displayed.start, displayed.end),
      sourceType: "raw-turn",
      role: message.role,
      occurredAt: message.occurredAt,
      sourceTurn: metadataView(source.sourceTurn),
      hasMore: true,
      snippetStart: range.start,
      snippetEnd: range.end,
      ...(snippetAnchor === undefined ? {} : { snippetAnchor }),
      truncated: range.start !== 0 || range.end !== message.content.length || source.messages.length > 1,
    };
  };
}
