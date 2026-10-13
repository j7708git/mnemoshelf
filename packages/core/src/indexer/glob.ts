/**
 * 極簡 glob 比對（不引入額外依賴）。
 *
 * 支援的語法：
 * - `*`：單一路徑層內任意字元（不含分隔符 `/`）；
 * - `?`：單一路徑層內的一個字元；
 * - `**`：跨任意層目錄（可為零層）；
 * - 字元類別 `[abc]`、`[!abc]`。
 *
 * 比對對象是**以 `/` 分隔的相對路徑**（POSIX 風格）。比對是整條路徑的完全比對
 * （`^...$`），因此 `*.md` 只匹配頂層的 `.md`；要比對任意層請用 `**\/*.md`。
 */

/** 已在 segment 解析中特別處理的字元，不需再行轉義。 */
function escapeChar(char: string): string {
  return /[.*+?^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
}

/** 把單一路徑層（不含 `/`）轉成 regex 片段。 */
function segmentToRegExp(segment: string): string {
  let out = "";
  for (let index = 0; index < segment.length; index += 1) {
    const char = segment[index]!;
    if (char === "*") {
      out += "[^/]*";
    } else if (char === "?") {
      out += "[^/]";
    } else if (char === "[") {
      const close = segment.indexOf("]", index + 1);
      if (close === -1) {
        out += "\\[";
      } else {
        let body = segment.slice(index + 1, close);
        if (body.startsWith("!")) body = `^${body.slice(1)}`;
        out += `[${body.replace(/\\/g, "\\\\")}]`;
        index = close;
      }
    } else {
      out += escapeChar(char);
    }
  }
  return out;
}

/** 把 glob 樣式編譯成完全比對的 regex。 */
export function globToRegExp(pattern: string): RegExp {
  const segments = pattern.split("/");
  let source = "^";
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    const isLast = index === segments.length - 1;
    if (segment === "**") {
      source += isLast ? ".*" : "(?:[^/]+/)*";
    } else {
      source += segmentToRegExp(segment);
      if (!isLast) source += "/";
    }
  }
  source += "$";
  return new RegExp(source);
}

const cache = new Map<string, RegExp>();

function compiled(pattern: string): RegExp {
  let regex = cache.get(pattern);
  if (regex === undefined) {
    regex = globToRegExp(pattern);
    cache.set(pattern, regex);
  }
  return regex;
}

/** 相對路徑是否匹配單一 glob 樣式。 */
export function matchesGlob(relPath: string, pattern: string): boolean {
  if (pattern.length === 0) return false;
  return compiled(pattern).test(relPath);
}

/** 相對路徑是否匹配任何一個 glob 樣式（空清單回傳 false）。 */
export function matchesAnyGlob(relPath: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => matchesGlob(relPath, pattern));
}
