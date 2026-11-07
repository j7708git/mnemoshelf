import { buildTurnCard, resolveDigestTurn } from "./historical.js";
import type { Question, Turn } from "./fixture.js";

export const CHUNK_UNITS = 1024;
export const OVERLAP_UNITS = 128;
const HEADER = '<memory-context source="mnemoshelf-eval" trust="untrusted">';
const FOOTER = "</memory-context>";

type Role = "user" | "assistant";

export interface Passage {
  id: string;
  project: string;
  turn: string;
  content: string;
  location?: { role: Role; start: number; end: number };
}

/** 用 UTF-16 偏移保留來源位置，避免在代理對之間截斷。 */
function boundary(text: string, end: number): number {
  const last = text.charCodeAt(end - 1);
  return last >= 0xd800 && last <= 0xdbff ? end - 1 : end;
}

function chunkMessage(turn: Turn, role: Role): Passage[] {
  const text = turn[role];
  const chunks: Passage[] = [];
  let start = 0;
  while (start < text.length) {
    const hardEnd = boundary(text, Math.min(text.length, start + CHUNK_UNITS));
    const paragraph = hardEnd < text.length ? text.lastIndexOf("\n\n", hardEnd - 2) : -1;
    const atParagraph = paragraph > start;
    const end = atParagraph ? paragraph + 2 : hardEnd;
    chunks.push({
      id: `${turn.id}-${role}-${start}`,
      project: turn.project,
      turn: turn.id,
      content: text.slice(start, end),
      location: { role, start, end },
    });
    if (end === text.length) break;
    // 只有被硬切的段落才重疊。來源紀錄仍保留完整文字。
    start = atParagraph ? end : boundary(text, end - OVERLAP_UNITS);
  }
  return chunks;
}

export function rawPassages(turns: Turn[]): Passage[] {
  return turns.flatMap(turn => [...chunkMessage(turn, "user"), ...chunkMessage(turn, "assistant")]);
}

export function currentCards(turns: Turn[]): Passage[] {
  return turns.flatMap(turn => {
    const result = buildTurnCard(turn.user, turn.assistant);
    return result.ok
      ? [{ id: turn.id, project: turn.project, turn: turn.id, content: result.card.content }]
      : [];
  });
}

export function digestInputs(turns: Turn[]): Passage[] {
  return turns.flatMap(turn => {
    const result = resolveDigestTurn([
      { type: "user", id: `${turn.id}-user`, text: turn.user },
      { type: "assistant", id: `${turn.id}-assistant`, text: turn.assistant },
    ]);
    return "turn" in result
      ? [{
          id: turn.id,
          project: turn.project,
          turn: turn.id,
          content: `${result.turn.userText}\n${result.turn.assistantText}`,
        }]
      : [];
  });
}

export function neighborMap(passages: Passage[]): Map<string, Passage[]> {
  return new Map(passages.map((passage, index) => [
    passage.id,
    [passages[index - 1], passages[index + 1]].filter(
      (candidate): candidate is Passage => candidate !== undefined && candidate.turn === passage.turn &&
        candidate.project === passage.project,
    ),
  ]));
}

export function expand(hits: Passage[], neighbors: Map<string, Passage[]>): Passage[] {
  const unique = new Map<string, Passage>();
  for (const hit of hits) {
    unique.set(hit.id, hit);
    for (const neighbor of neighbors.get(hit.id) ?? []) unique.set(neighbor.id, neighbor);
  }
  return [...unique.values()];
}

export function escapeText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function evidenceFound(question: Question, block: string): boolean[] {
  const normalized = block.replace(/\s+/gu, " ");
  return question.evidence.map(evidence => normalized.includes(escapeText(evidence.quote).replace(/\s+/gu, " ")));
}

/** 各表示法使用同一個包裝與預算，預算含完整前後標記及來源標籤。 */
export function pack(passages: Passage[], budget: number, count: (text: string) => number) {
  const lines = [HEADER];
  const ids: string[] = [];
  let truncated = false;
  const blockWith = (line?: string) => [...lines, ...(line === undefined ? [] : [line]), FOOTER].join("\n");
  for (const passage of passages) {
    const label = `- [${passage.turn}][${passage.location?.role ?? "card"}] `;
    const chars = Array.from(passage.content.trim());
    const line = label + escapeText(chars.join(""));
    if (count(blockWith(line)) <= budget) {
      lines.push(line);
      ids.push(passage.id);
      continue;
    }
    // 第一筆過大時只收一個可放進預算的前綴，後續候選超過即停止。
    if (ids.length === 0) {
      let lower = 0;
      let upper = chars.length;
      while (lower + 1 < upper) {
        const middle = Math.floor((lower + upper) / 2);
        const text = label + escapeText(chars.slice(0, middle).join("")) + "…";
        if (count(blockWith(text)) <= budget) lower = middle;
        else upper = middle;
      }
      if (lower > 0) {
        lines.push(label + escapeText(chars.slice(0, lower).join("")) + "…");
        ids.push(passage.id);
        truncated = true;
      }
    }
    break;
  }
  return { block: ids.length > 0 ? blockWith() : "", ids, truncated, dropped: passages.length - ids.length };
}
