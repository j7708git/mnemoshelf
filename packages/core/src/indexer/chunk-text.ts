/**
 * 文字與程式碼的切塊。
 *
 * 規則（依 spike 的檢索實驗：依 `#` 標題切塊、每塊 600–1200 字元、過長依段落再切）：
 * - 文字檔：先依 markdown 標題（`#`～`######`）分節，過長的一節再依空行分段，最後貪婪合併成塊。
 * - 程式碼檔：以行為單位累積，並在超過上限時斷塊；超長單行強制切開。
 * - 每塊長度上限 1200 字元（硬性）；600 字元是「儘量達到」的目標，內容不足時塊可以更小。
 * - 另有**估算 token 數**上限（`CHUNK_MAX_TOKENS`，見 `estimateTokens`）：字元數相同時，
 *   中日韓等非 ASCII 內容的 token 數遠高於英文，只有字元上限擋不住「單塊過長」。
 * - 空內容回傳空陣列（呼叫端據此清掉該檔的舊 chunk）。
 */

/** 每塊的目標下限（字元）。 */
export const CHUNK_MIN_CHARS = 600;
/** 每塊的硬性上限（字元）。 */
export const CHUNK_MAX_CHARS = 1200;

/**
 * 每塊的**估算 token 數**上限。
 *
 * 為什麼需要（除了字元上限之外）：字元數不是 token 數。同一個 1200 字元上限，
 * 英文約 270 token，中文卻接近 900–1200 token（見 `estimateTokens` 的實測校準）。
 * 而推論時的單一配置大小隨「一批的 token 總量」成長：實測（同一顆模型、16 塊一批）
 * 一窗約 8k token 的最大單一配置請求約 0.3 GB，約 14k token 時約 0.7 GB；ONNX Runtime
 * 的 CPU arena 在請求超過目前 chunk 時會把 chunk 以 2 的冪次往上翻，因此請求一旦超過
 * 1 GiB 就會翻成 ≥2 GiB 的單一配置，而 Chromium 的 PartitionAlloc 對這種大小是
 * *直接終止行程*（`PA_IMMEDIATE_CRASH`）——在 Electron 內就是整個 app 閃退。
 *
 * 取值 512：以實測的安全區（16 塊 × 913 token 的批次仍在舒適範圍內）反推，
 * 512 估算 token/塊 搭配批次上限（embedder 的 `BATCH_TOKEN_BUDGET`）留有 2 倍以上餘裕。
 * 英文內容不受影響：1200 字元的英文估算約 400 token，仍在 512 以內。
 */
export const CHUNK_MAX_TOKENS = 512;

/** 估算時每個 ASCII 字元（U+0000–U+007F）分攤的 token 數（約 3 字元 1 token，偏保守）。 */
const ASCII_CHARS_PER_TOKEN = 3;

/**
 * 估算一段文字的 token 數（**保守**上界，非精確值）。
 *
 * 校準（同一顆模型的 tokenizer 實測，2026-10-16）：
 * - 常見中文 1,200 字 → 883 token（0.74 token/字）
 * - 同一個中文字重複 1,200 次 → 1,202 token（1.0 token/字）
 * - 英文 1,200 字 → 268 token（4.5 字元/token）
 * - emoji 序列 → 約 1 token/code point（逐 code point 計已偏保守）
 *
 * 因此「非 ASCII 1 字元 1 token、ASCII 3 字元 1 token」在常見內容上是上界：
 * 中文、英文、emoji 混合都不會低估，純 ASCII 的 1200 字元塊估算 400 token，
 * 不觸發 `CHUNK_MAX_TOKENS`（既有英文切塊不變）。
 *
 * **已知的低估**（設計上接受）：罕用 CJK 字元會走 tokenizer 的 byte fallback，
 * 實測 512 個罕用字 → 1,538 token（3 token/字），此時估算只有實際的約 1/3。
 * 這類內容少見，且**單批的總量**另有 embedder 端以 tokenizer 的實際 `input_ids`
 * 形狀把關（見 `BATCH_TOKEN_BUDGET`），因此低估不會讓配置失控。
 */
export function estimateTokens(text: string): number {
  let tokens = 0;
  for (let index = 0; index < text.length; ) {
    const code = text.codePointAt(index) ?? 0;
    tokens += code > 0x7f ? 1 : 1 / ASCII_CHARS_PER_TOKEN;
    index += code > 0xffff ? 2 : 1;
  }
  return Math.ceil(tokens);
}

/**
 * 在同時滿足「≤ `maxChars` 字元」與「估算 token ≤ `CHUNK_MAX_TOKENS`」的前提下，
 * 回傳 `text` 可作為單一塊的最大前綴長度（至少 1 個字元，避免無限迴圈）。
 *
 * 只有字元上限或 token 預算先到者生效；兩者都是單調的，因此逐 code point 前進即可。
 */
function prefixLengthWithinBudget(text: string, maxChars: number): number {
  const charLimit = Math.min(maxChars, text.length);
  let tokens = 0;
  let index = 0;
  while (index < charLimit) {
    const code = text.codePointAt(index) ?? 0;
    const next = index + (code > 0xffff ? 2 : 1);
    if (next > charLimit) break;
    const cost = code > 0x7f ? 1 : 1 / ASCII_CHARS_PER_TOKEN;
    if (tokens + cost > CHUNK_MAX_TOKENS) break;
    tokens += cost;
    index = next;
  }
  // 至少切一個字元：`CHUNK_MAX_TOKENS` 遠大於單一字元的成本，正常情況不會走到這裡。
  return index > 0 ? index : Math.min(1, charLimit);
}

/** 這一段是否還需要再切（字元或 token 預算任一邊超標）。 */
function exceedsBudget(text: string, maxChars: number): boolean {
  return text.length > maxChars || estimateTokens(text) > CHUNK_MAX_TOKENS;
}

export interface TextChunk {
  text: string;
}

/**
 * 把超長片段硬切成多段（同時受 `max` 字元與 `CHUNK_MAX_TOKENS` 限制），盡量在空白處斷開。
 *
 * 未超標時原樣回傳一段——純 ASCII 內容的行為與只有字元上限時完全相同。
 */
function splitOversized(block: string, max: number): string[] {
  if (!exceedsBudget(block, max)) return [block];
  const pieces: string[] = [];
  let rest = block;
  while (rest.length > 0) {
    if (!exceedsBudget(rest, max)) {
      pieces.push(rest);
      break;
    }
    const limit = prefixLengthWithinBudget(rest, max);
    const window = rest.slice(0, limit);
    let cut = limit;
    const breakAt = Math.max(window.lastIndexOf("\n"), window.lastIndexOf(" "));
    if (breakAt > limit * 0.6) cut = breakAt;
    pieces.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).replace(/^\s+/, "");
  }
  return pieces;
}

/** 貪婪地把片段合併成塊：字元與估算 token 預算都不超過即合併，超過即斷塊。 */
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
      const combined = buffer.length === 0 ? piece : `${buffer}${separator}${piece}`;
      if (buffer.length === 0) {
        buffer = piece;
      } else if (combined.length <= CHUNK_MAX_CHARS && estimateTokens(combined) <= CHUNK_MAX_TOKENS) {
        buffer = combined;
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
