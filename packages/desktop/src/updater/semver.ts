/**
 * 最小 semver 比較（給 macOS 的 GitHub Release tag 用）。
 *
 * 為什麼不用套件：`semver` 不是 `@mnemoshelf/desktop` 的直接依賴（pnpm 嚴格佈局下
 * 解析不到），本卡也禁止改 `package.json`。這裡只需要「比較兩個版本誰比較新」，
 * 依 semver 2.0.0 的 precedence 規則實作 major／minor／patch／prerelease 即可。
 *
 * 接受 `v` 前綴（GitHub tag 習慣），回傳一律是不含 `v` 的正規化版本。
 */

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: (string | number)[];
}

const VERSION_PATTERN =
  /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function parseVersion(value: string): ParsedVersion | null {
  const match = VERSION_PATTERN.exec(value.trim());
  if (match === null) return null;
  const [, major, minor, patch, prerelease] = match;
  const parsed: ParsedVersion = {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease:
      prerelease === undefined
        ? []
        : prerelease.split(".").map((identifier) => (/^\d+$/.test(identifier) ? Number(identifier) : identifier)),
  };
  // `Number("999999999999999999999")` 會失去精度；這類版本不可能出現在本專案。
  if (![parsed.major, parsed.minor, parsed.patch].every((part) => Number.isSafeInteger(part))) return null;
  return parsed;
}

/** 是否可以解析成合法版本。 */
export function isValidVersion(value: string): boolean {
  return parseVersion(value) !== null;
}

/** 正規化版本字串（去 `v`、去 build metadata）；不合法時回 null。 */
export function normalizeVersion(value: string): string | null {
  const parsed = parseVersion(value);
  if (parsed === null) return null;
  const core = `${parsed.major}.${parsed.minor}.${parsed.patch}`;
  return parsed.prerelease.length === 0 ? core : `${core}-${parsed.prerelease.join(".")}`;
}

/**
 * 比較兩個版本（semver precedence）。
 *
 * 回傳 `-1`（a 較舊）、`0`（相同）、`1`（a 較新）；任一版本不合法時回 null。
 * 依 semver：有 prerelease 的版本 < 同 core 的正式版；數字識別碼以數值比較且
 * 數字 < 非數字；識別碼較少者較小（前提是前面的都相同）。
 */
export function compareVersions(a: string, b: string): number | null {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (left === null || right === null) return null;

  for (const key of ["major", "minor", "patch"] as const) {
    if (left[key] !== right[key]) return left[key] > right[key] ? 1 : -1;
  }

  const leftPre = left.prerelease;
  const rightPre = right.prerelease;
  // 沒有 prerelease 的版本優先序較高。
  if (leftPre.length === 0 && rightPre.length === 0) return 0;
  if (leftPre.length === 0) return 1;
  if (rightPre.length === 0) return -1;

  const length = Math.min(leftPre.length, rightPre.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = leftPre[index]!;
    const rightPart = rightPre[index]!;
    if (leftPart === rightPart) continue;
    const leftIsNumber = typeof leftPart === "number";
    const rightIsNumber = typeof rightPart === "number";
    if (leftIsNumber && rightIsNumber) return leftPart > rightPart ? 1 : -1;
    if (leftIsNumber) return -1;
    if (rightIsNumber) return 1;
    return leftPart > rightPart ? 1 : -1;
  }
  if (leftPre.length === rightPre.length) return 0;
  return leftPre.length > rightPre.length ? 1 : -1;
}
