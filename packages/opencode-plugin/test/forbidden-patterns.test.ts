/**
 * 共用「禁用樣式」清單的自我驗證。
 *
 * 這裡測的是 `test/forbidden-patterns.ts` 的清單本身：
 * 1. 新規則抓得到目標形式（單反斜線的 Windows 家目錄、裸的 Unix 家目錄）；
 * 2. 舊形式仍命中（既有覆蓋不得弱化）；
 * 3. 無害字串零命中；
 * 4. 兩個消費端真的從共用模組 import，避免清單再次各自漂移。
 *
 * 樣本字串的寫法：Unix 路徑不寫結尾斜線、Windows 反斜線在 TS 常值裡寫兩次，
 * 避免隱私掃描器把規則或樣本本身誤判成真實本機路徑。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { FORBIDDEN_PATTERNS } from "./forbidden-patterns.js";

/** 回傳命中的樣式名稱（沒有命中就是空陣列）。 */
const hitPatterns = (text: string): string[] =>
  FORBIDDEN_PATTERNS.filter(({ pattern }) => pattern.test(text)).map(({ name }) => name);

describe("禁用樣式的自我驗證", () => {
  it("抓得到真正的 Windows 家目錄（單反斜線，尾端有無反斜線都要命中）", () => {
    // TS 字串常值用兩個反斜線表示執行期的一個反斜線。
    const samples = ["C:\\Users\\alice", "C:\\Users\\alice\\notes.txt", "C:\\Users\\alice\\"];
    for (const sample of samples) {
      expect(hitPatterns(sample).length, `樣本應命中：${sample}`).toBeGreaterThan(0);
    }
  });

  it("Windows 樣本由具名規則回報（windows-users-path-named 排在單反斜線規則之前）", () => {
    expect(hitPatterns("C:\\Users\\alice")).toContain("windows-users-path-named");
    // 陣列順序有意義：第一個命中的名稱就是失敗訊息會顯示的規則。
    expect(hitPatterns("C:\\Users\\alice")[0]).toBe("windows-users-path-named");
  });

  it("抓得到結尾沒有斜線的 Unix 家目錄路徑", () => {
    expect(hitPatterns("/home/alice").length, "裸的 home 路徑應命中").toBeGreaterThan(0);
    expect(hitPatterns("/Users/alice").length, "裸的 Users 路徑應命中").toBeGreaterThan(0);
    // 有結尾斜線的舊形式仍要命中（既有覆蓋不得弱化）；路徑用串接避開掃描器的字面比對。
    expect(hitPatterns("/home/alice" + "/data").length).toBeGreaterThan(0);
  });

  it("保留舊的雙反斜線規則", () => {
    // 執行期字串是 `C:\\Users\\alice`（反斜線各兩個），由舊規則負責。
    expect(hitPatterns("C:\\\\Users\\\\alice")).toContain("windows-users-path");
  });

  it("不抓無害字串：使用者目錄簡寫、一般中文、非家目錄的路由", () => {
    const harmless = [
      "設定檔放在 ~/.config/Mnemoshelf/data/runtime.json。",
      "文件在自己家目錄下的 notes.md。",
      "這個專案把設定放在使用者目錄中，路徑由程式推導。",
      "網頁路由 /homepage 與 /users/list 只是普通路徑。",
      "Windows 的資料目錄通常在 AppData\\Roaming 底下。",
    ];
    for (const sample of harmless) expect(hitPatterns(sample)).toEqual([]);
  });
});

describe("共用清單：消費端不得各自維護副本", () => {
  const readSource = (url: URL): string => readFileSync(fileURLToPath(url), "utf8");

  it("eval-fixtures.test.ts 從 ./forbidden-patterns.js import，且沒有本地清單", () => {
    const source = readSource(new URL("./eval-fixtures.test.ts", import.meta.url));
    expect(source).toContain('from "./forbidden-patterns.js"');
    // 同時查兩件事：命名（FORBIDDEN… 含底線後綴）＋ 只會出現在清單裡的 token（改名字也擋得住）。
    expect(source).not.toMatch(/const\s+FORBIDDEN\w*\s*[:=]/);
    expect(source, "消費端不得貼一份本地禁用清單；樣本請放在 forbidden-patterns.test.ts").not.toContain("sk-");
    expect(source, "消費端不得貼一份本地禁用清單；樣本請放在 forbidden-patterns.test.ts").not.toContain("AKIA");
  });

  it("rules/regression-queries.test.ts 從 ../forbidden-patterns.js import，且沒有本地清單", () => {
    const source = readSource(new URL("./rules/regression-queries.test.ts", import.meta.url));
    expect(source).toContain('from "../forbidden-patterns.js"');
    // 同時查兩件事：命名（FORBIDDEN… 含底線後綴）＋ 只會出現在清單裡的 token（改名字也擋得住）。
    expect(source).not.toMatch(/const\s+FORBIDDEN\w*\s*[:=]/);
    expect(source, "消費端不得貼一份本地禁用清單；樣本請放在 forbidden-patterns.test.ts").not.toContain("sk-");
    expect(source, "消費端不得貼一份本地禁用清單；樣本請放在 forbidden-patterns.test.ts").not.toContain("AKIA");
  });
});
