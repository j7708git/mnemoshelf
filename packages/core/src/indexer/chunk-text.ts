/**
 * 文字與程式碼的切塊。
 *
 * 規則（依 spike 的檢索實驗：依 `#` 標題切塊、每塊 600–1200 字元、過長依段落再切）：
 * - 文字檔：先依 markdown 標題（`#`～`######`）分節，過長的一節再依空行分段，最後貪婪合併成塊。
 * - 程式碼檔：以行為單位累積，並在超過上限時斷塊；超長單行強制切開。
 * - 每塊長度上限 1200 字元（硬性）；600 字元是「儘量達到」的目標，內容不足時塊可以更小。
 * - 空內容回傳空陣列（呼叫端據此清掉該檔的舊 chunk）。
 */

/** 每塊的目標下限（字元）。 */
export const CHUNK_MIN_CHARS = 600;
/** 每塊的硬性上限（字元）。 */
export const CHUNK_MAX_CHARS = 1200;

export interface TextChunk {
  text: string;
}

/** 把超長片段硬切成不超過 `max` 的多段，盡量在空白處斷開。 */
function splitOversized(block: string, max: number): string[] {
  if (block.length <= max) return [block];
  const pieces: string[] = [];
  let rest = block;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = max;
    const breakAt = Math.max(window.lastIndexOf("\n"), window.lastIndexOf(" "));
    if (breakAt > max * 0.6) cut = breakAt;
    pieces.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).replace(/^\s+/, "");
  }
  if (rest.length > 0) pieces.push(rest);
  return pieces;
}

/** 貪婪地把片段合併成塊：不超過上限，超過即斷塊。 */
function packSegments(segments: readonly string[], separator: string): string[] {
  const chunks: string[] = [];
  let buffer = "";

  const flush = (): void => {
    const trimmed = buffer.trim();
    if (trimmed.length > 0) chunks.push(trimmed);
    buffer = "";
  };

  for (const segment of segments) {
    const trimmed = segment.trim();
    if (trimmed.length === 0) continue;
    for (const piece of splitOversized(trimmed, CHUNK_MAX_CHARS)) {
      if (buffer.length === 0) {
        buffer = piece;
      } else if (buffer.length + separator.length + piece.length <= CHUNK_MAX_CHARS) {
        buffer = `${buffer}${separator}${piece}`;
      } else {
        flush();
        buffer = piece;
      }
    }
  }
  flush();
  return chunks;
}

const HEADING = /^#{1,6}(\s|$)/;

/** 依 markdown 標題分節；標題行歸屬於其後的一節。 */
function splitByHeadings(content: string): string[] {
  const lines = content.split(/\r?\n/);
  const sections: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (HEADING.test(line) && current.length > 0) {
      sections.push(current.join("\n"));
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) sections.push(current.join("\n"));
  return sections;
}

/** 依空行切段落。 */
function splitByParagraphs(section: string): string[] {
  return section
    .split(/\r?\n[ \t]*\r?\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);
}

/**
 * 把一節拆成 block。
 * 一節不超過上限時整節為一個 block；超過時依段落拆，但**標題與其後第一段保持在一起**，
 * 避免標題單獨變成極短的塊。
 */
function sectionBlocks(section: string): string[] {
  const trimmed = section.trim();
  if (trimmed.length === 0) return [];
  if (trimmed.length <= CHUNK_MAX_CHARS) return [trimmed];

  const match = /^(#{1,6}[^\n]*\n?)([\s\S]*)$/.exec(trimmed);
  if (match === null) return splitByParagraphs(trimmed);

  const heading = match[1]!.trim();
  const paragraphs = splitByParagraphs(match[2]!);
  if (paragraphs.length === 0) return heading.length > 0 ? [heading] : [];

  const first = heading.length > 0 ? `${heading}\n\n${paragraphs[0]!}` : paragraphs[0]!;
  return [first, ...paragraphs.slice(1)];
}

/** 文字檔切塊。 */
export function chunkText(content: string): TextChunk[] {
  if (content.trim().length === 0) return [];

  const blocks: string[] = [];
  for (const section of splitByHeadings(content)) {
    blocks.push(...sectionBlocks(section));
  }

  return packSegments(blocks, "\n\n").map((text) => ({ text }));
}

/** 程式碼檔切塊（以行為單位，行邊界不切斷）。 */
export function chunkCode(content: string): TextChunk[] {
  if (content.trim().length === 0) return [];
  return packSegments(content.split(/\r?\n/), "\n").map((text) => ({ text }));
}
