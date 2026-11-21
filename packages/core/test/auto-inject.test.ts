import { describe, expect, it } from "vitest";
import {
  AUTO_INJECT_MODES,
  applyAutoInjectPatch,
  normalizeAutoInjectSettings,
  normalizeMemorySearchFilter,
  readMemoryAutoInjectSettings,
  resolveAutoInjectMode,
  MEMORY_SEARCH_SOURCE_KINDS,
  type MemoryAutoInjectSettings,
} from "../src/index.js";

const base = (overrides: Partial<MemoryAutoInjectSettings> = {}): MemoryAutoInjectSettings => ({
  revision: 1,
  defaultMode: "all",
  projects: {},
  ...overrides,
});

describe("AUTO_INJECT_MODES", () => {
  it("包含三種模式", () => {
    expect(AUTO_INJECT_MODES).toEqual(["all", "refined-only", "off"]);
  });
});

describe("normalizeAutoInjectSettings", () => {
  it("trim 專案鍵並依鍵排序", () => {
    const result = normalizeAutoInjectSettings(base({ projects: { " beta ": "off", alpha: "refined-only" } }));
    expect(Object.keys(result.projects)).toEqual(["alpha", "beta"]);
    expect(result.projects).toEqual({ alpha: "refined-only", beta: "off" });
  });

  it("不改動輸入物件", () => {
    const input = base({ projects: { " a ": "off" } });
    normalizeAutoInjectSettings(input);
    expect(input.projects).toEqual({ " a ": "off" });
  });

  it.each([
    ["revision 非正整數", base({ revision: 0 })],
    ["revision 非整數", base({ revision: 1.5 })],
    ["defaultMode 非法", base({ defaultMode: "bogus" as never })],
    ["專案值非法", base({ projects: { a: "bogus" as never } })],
    ["空白專案鍵", base({ projects: { "  ": "off" } })],
    ["專案鍵過長", base({ projects: { ["x".repeat(201)]: "off" } })],
    ["專案鍵含 NUL", base({ projects: { "a\0": "off" } })],
    ["trim 後重複", base({ projects: { a: "off", " a": "all" } })],
    ["projects 為陣列", base({ projects: [] as never })],
    ["設定不是物件", null as never],
  ])("拒絕：%s", (_label, value) => {
    expect(() => normalizeAutoInjectSettings(value)).toThrow(TypeError);
  });

  it("專案鍵剛好 200 字元可接受", () => {
    const key = "x".repeat(200);
    expect(normalizeAutoInjectSettings(base({ projects: { [key]: "off" } })).projects).toEqual({ [key]: "off" });
  });
});

describe("readMemoryAutoInjectSettings", () => {
  it("讀取資料庫列（revision 可為字串）", () => {
    expect(readMemoryAutoInjectSettings({ revision: "3", default_mode: "refined-only", projects_json: '{"a":"off"}' }))
      .toEqual({ revision: 3, defaultMode: "refined-only", projects: { a: "off" } });
  });

  it("損毀資料拋 TypeError", () => {
    expect(() => readMemoryAutoInjectSettings({ revision: 1, default_mode: "all", projects_json: "{" })).toThrow(TypeError);
    expect(() => readMemoryAutoInjectSettings({ revision: 1, default_mode: "x", projects_json: "{}" })).toThrow(TypeError);
    expect(() => readMemoryAutoInjectSettings({ revision: 1, default_mode: "all", projects_json: "[]" })).toThrow(TypeError);
    expect(() => readMemoryAutoInjectSettings(undefined as never)).toThrow(TypeError);
  });
});

describe("applyAutoInjectPatch", () => {
  it("只改預設模式，專案覆寫不變，revision + 1", () => {
    const current = base({ projects: { a: "off" } });
    expect(applyAutoInjectPatch(current, { expectedRevision: 1, defaultMode: "refined-only" }))
      .toEqual({ revision: 2, defaultMode: "refined-only", projects: { a: "off" } });
    expect(current).toEqual(base({ projects: { a: "off" } }));
  });

  it("只更動 patch 列出的專案鍵；null 刪除覆寫", () => {
    const current = base({ projects: { a: "off", b: "refined-only", c: "all" } });
    const next = applyAutoInjectPatch(current, { expectedRevision: 1, projects: { " a ": "all", b: null, d: "off", missing: null } });
    expect(next.projects).toEqual({ a: "all", c: "all", d: "off" });
    expect(next.defaultMode).toBe("all");
  });

  it("可同時改預設與專案", () => {
    expect(applyAutoInjectPatch(base(), { expectedRevision: 1, defaultMode: "off", projects: { a: "all" } }))
      .toEqual({ revision: 2, defaultMode: "off", projects: { a: "all" } });
  });

  it.each([
    ["expectedRevision 為 0", { expectedRevision: 0, defaultMode: "off" }],
    ["expectedRevision 為小數", { expectedRevision: 1.5, defaultMode: "off" }],
    ["expectedRevision 缺少", { defaultMode: "off" }],
    ["沒有任何變更", { expectedRevision: 1 }],
    ["projects 為空物件", { expectedRevision: 1, projects: {} }],
    ["defaultMode 非法", { expectedRevision: 1, defaultMode: "bogus" }],
    ["專案值非法", { expectedRevision: 1, projects: { a: "bogus" } }],
    ["專案值為 undefined", { expectedRevision: 1, projects: { a: undefined } }],
    ["空白專案鍵", { expectedRevision: 1, projects: { " ": "off" } }],
    ["專案鍵過長", { expectedRevision: 1, projects: { ["x".repeat(201)]: "off" } }],
    ["專案鍵含 NUL", { expectedRevision: 1, projects: { "a\0": "off" } }],
    ["trim 後重複鍵", { expectedRevision: 1, projects: { a: "off", " a ": "all" } }],
    ["projects 為陣列", { expectedRevision: 1, projects: [] }],
    ["patch 不是物件", null],
  ])("拒絕：%s", (_label, patch) => {
    expect(() => applyAutoInjectPatch(base(), patch as never)).toThrow(TypeError);
  });

  it("不比對 expectedRevision 與目前 revision（衝突由 store 判定）", () => {
    expect(applyAutoInjectPatch(base({ revision: 5 }), { expectedRevision: 1, defaultMode: "off" }).revision).toBe(6);
  });
});

describe("resolveAutoInjectMode", () => {
  const settings = { defaultMode: "refined-only" as const, projects: { alpha: "off" as const, beta: "all" as const } };

  it("命中專案覆寫回該模式（trim 後比對）", () => {
    expect(resolveAutoInjectMode(settings, "alpha")).toBe("off");
    expect(resolveAutoInjectMode(settings, "  beta ")).toBe("all");
  });

  it("未命中、空白、null、undefined 回預設模式", () => {
    expect(resolveAutoInjectMode(settings, "gamma")).toBe("refined-only");
    expect(resolveAutoInjectMode(settings, "   ")).toBe("refined-only");
    expect(resolveAutoInjectMode(settings, null)).toBe("refined-only");
    expect(resolveAutoInjectMode(settings)).toBe("refined-only");
  });

  it("不會命中原型鏈屬性", () => {
    expect(resolveAutoInjectMode(settings, "constructor")).toBe("refined-only");
    expect(resolveAutoInjectMode(settings, "__proto__")).toBe("refined-only");
  });
});

describe("normalizeMemorySearchFilter.sourceKind", () => {
  it("未提供為 undefined，合法值原樣保留", () => {
    expect(normalizeMemorySearchFilter({}).sourceKind).toBeUndefined();
    expect(normalizeMemorySearchFilter({ buckets: [] }).sourceKind).toBeUndefined();
    for (const kind of MEMORY_SEARCH_SOURCE_KINDS) {
      expect(normalizeMemorySearchFilter({ sourceKind: kind }).sourceKind).toBe(kind);
      expect(normalizeMemorySearchFilter({ sourceKind: kind, buckets: [{ scope: "global" }] }).sourceKind).toBe(kind);
    }
  });

  it("非法值拋 TypeError", () => {
    expect(() => normalizeMemorySearchFilter({ sourceKind: "bogus" as never })).toThrow(TypeError);
    expect(() => normalizeMemorySearchFilter({ sourceKind: 1 as never, buckets: [] })).toThrow(TypeError);
  });
});
