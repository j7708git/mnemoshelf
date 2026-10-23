/**
 * 場景內的檢查收集器。
 *
 * 每個場景回傳一組 checks（name／expected／actual），全部為真才算 pass；
 * 失敗時報告能直接看到「預期 vs 實際」，不用重跑猜原因。
 */

/** 把任意值轉成報告用的短字串（不吞掉 undefined）。 */
export function describeValue(value, limit = 300) {
  let text;
  if (value === undefined) text = "undefined";
  else if (typeof value === "string") text = value;
  else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }
  if (typeof text !== "string") text = String(text);
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function same(left, right) {
  return describeValue(left, 100000) === describeValue(right, 100000);
}

export function createChecks() {
  const list = [];
  return {
    list,
    eq(name, actual, expected) {
      list.push({ name, ok: same(actual, expected), expected, actual });
      return same(actual, expected);
    },
    ok(name, condition, expected, actual) {
      list.push({ name, ok: condition === true, expected, actual });
      return condition === true;
    },
    /** 只記錄、不影響 pass/fail（報告用的觀察值）。 */
    note(name, actual) {
      list.push({ name, ok: true, expected: "（僅記錄）", actual, informational: true });
    },
    get passed() {
      return list.every((entry) => entry.ok);
    },
  };
}

/** 取唯一值（排序後），方便比對「全部都是同一個值」。 */
export function uniqueValues(values) {
  return [...new Set(values.map((value) => (value === null ? "null" : value)))].sort();
}

/** 兩個集合是否完全相同（忽略順序）。 */
export function sameSet(left, right) {
  const a = [...new Set(left)].sort();
  const b = [...new Set(right)].sort();
  return describeValue(a, 100000) === describeValue(b, 100000);
}
