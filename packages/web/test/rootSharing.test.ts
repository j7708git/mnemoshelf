/**
 * Roots 的 agent 分享開關與通用單檔上限：UI 邏輯與 API 測試（M7.5／1B）。
 *
 * 契約：
 * - `Root.allowAgentSearch`（required boolean，預設 false）；
 * - `Root.maxFileBytes`（optional bytes；未設定時缺省，不補 10 MiB）；
 * - `PATCH /roots/:id` 接受 `allowAgentSearch` 與 `maxFileBytes`（null＝清除）；
 * - UI 的開關文案要明示「分享意圖／防誤用，不是多租戶硬隔離」；
 * - 通用上限以整數 MiB 輸入、換算成 bytes，非法值不送出。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Root } from "../src/api";
import { addRoot, updateRootAgentSearch, updateRootMaxFileBytes } from "../src/api";
import { AddRootFlow } from "../src/AddRootFlow";
import {
  DEFAULT_MAX_FILE_BYTES,
  MAX_FILE_LIMIT_MAX_MIB,
  RootsList,
  effectiveMaxFileBytes,
  formatMaxFileLimitBytes,
  maxFileLimitMiBDefault,
  parseMaxFileLimitMiB,
} from "../src/RootsList";
import { BYTES_PER_MIB } from "../src/media";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** `GET /roots` 的回應 root（欄位與 Core 契約一致）。 */
function root(overrides: Partial<Root> = {}): Root {
  return {
    id: 1,
    path: "fixture",
    mode: "index",
    modalities: ["text", "code"],
    include: [],
    exclude: [],
    respectGitignore: true,
    watch: false,
    createdAt: "2026-11-12",
    allowAgentSearch: false,
    ...overrides,
  };
}

/** 讓 fetch 依序回應（每次呼叫各一個 Response）。 */
function stubFetch(...responses: Response[]): ReturnType<typeof vi.fn> {
  vi.stubGlobal("sessionStorage", { getItem: () => "fixture" });
  const fetch = vi.fn();
  for (const response of responses) fetch.mockResolvedValueOnce(response);
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

describe("parseMaxFileLimitMiB（通用上限的 UI 輸入驗證與換算）", () => {
  it("整數 MiB 正確換算成 bytes（含預設 10 與上下界）", () => {
    expect(parseMaxFileLimitMiB("10")).toEqual({ ok: true, bytes: 10 * BYTES_PER_MIB });
    expect(parseMaxFileLimitMiB("1")).toEqual({ ok: true, bytes: BYTES_PER_MIB });
    expect(parseMaxFileLimitMiB(" 16384 ")).toEqual({ ok: true, bytes: 16 * 1024 * BYTES_PER_MIB });
    expect(MAX_FILE_LIMIT_MAX_MIB).toBe(16384);
  });

  it("空值、非整數、0、負數、超界與帶單位字串都有可讀錯誤", () => {
    for (const input of ["", "   "]) {
      const result = parseMaxFileLimitMiB(input);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toContain("請輸入");
    }
    for (const input of ["abc", "1.5", "10MiB", "1,024", "-1", "0"]) {
      const result = parseMaxFileLimitMiB(input);
      expect(result.ok, input).toBe(false);
      if (!result.ok) expect(result.message.length).toBeGreaterThan(0);
    }
    const tooLarge = parseMaxFileLimitMiB("16385");
    expect(tooLarge.ok).toBe(false);
    if (!tooLarge.ok) expect(tooLarge.message).toContain("16 GiB");
    const zero = parseMaxFileLimitMiB("0");
    if (!zero.ok) expect(zero.message).toContain("至少 1 MiB");
  });
});

describe("通用上限的顯示與生效值", () => {
  it("位元組顯示沿用影片上限格式（MiB／bytes／小數）", () => {
    expect(formatMaxFileLimitBytes(10 * BYTES_PER_MIB)).toBe("10 MiB");
    expect(formatMaxFileLimitBytes(1)).toBe("1 B");
    expect(formatMaxFileLimitBytes(1.5 * BYTES_PER_MIB)).toBe("1.5 MiB");
  });

  it("生效值優先序：root 設定 → 服務預設 10 MiB（非法值不當 0）", () => {
    expect(effectiveMaxFileBytes({ maxFileBytes: 2 * BYTES_PER_MIB }, DEFAULT_MAX_FILE_BYTES)).toBe(2 * BYTES_PER_MIB);
    expect(effectiveMaxFileBytes({ maxFileBytes: null }, DEFAULT_MAX_FILE_BYTES)).toBe(DEFAULT_MAX_FILE_BYTES);
    expect(effectiveMaxFileBytes({}, undefined)).toBe(DEFAULT_MAX_FILE_BYTES);
    expect(effectiveMaxFileBytes({ maxFileBytes: 0 }, undefined)).toBe(DEFAULT_MAX_FILE_BYTES);
    expect(effectiveMaxFileBytes({ maxFileBytes: -5 }, undefined)).toBe(DEFAULT_MAX_FILE_BYTES);
    expect(maxFileLimitMiBDefault(undefined)).toBe("10");
    expect(maxFileLimitMiBDefault(1024 * BYTES_PER_MIB)).toBe("1024");
  });
});

describe("API：分享開關與通用上限", () => {
  it("POST /roots 帶 allowAgentSearch 與 maxFileBytes", async () => {
    const fetch = stubFetch(
      Response.json(root({ allowAgentSearch: true, maxFileBytes: 5 * BYTES_PER_MIB }), { status: 201 }),
    );
    const created = await addRoot({
      path: "fixture",
      modalities: ["text", "code"],
      maxFileBytes: 5 * BYTES_PER_MIB,
      allowAgentSearch: true,
    });
    expect(created.allowAgentSearch).toBe(true);
    expect(created.maxFileBytes).toBe(5 * BYTES_PER_MIB);
    const body = JSON.parse(String(fetch.mock.calls[0]![1]!.body)) as Record<string, unknown>;
    expect(body.maxFileBytes).toBe(5 * BYTES_PER_MIB);
    expect(body.allowAgentSearch).toBe(true);
  });

  it("PATCH /roots/:id 只送 allowAgentSearch；回應反映新值", async () => {
    const fetch = stubFetch(Response.json(root({ allowAgentSearch: true })));
    const updated = await updateRootAgentSearch(3, true);
    expect(updated.allowAgentSearch).toBe(true);
    expect(fetch.mock.calls[0]![0]).toBe("/roots/3");
    expect(fetch.mock.calls[0]![1]!.method).toBe("PATCH");
    const body = JSON.parse(String(fetch.mock.calls[0]![1]!.body)) as Record<string, unknown>;
    expect(body).toEqual({ allowAgentSearch: true });
  });

  it("PATCH /roots/:id 只送 maxFileBytes；null＝清除", async () => {
    const fetch = stubFetch(Response.json(root({ maxFileBytes: 2 * BYTES_PER_MIB })), Response.json(root()));
    const updated = await updateRootMaxFileBytes(4, 2 * BYTES_PER_MIB);
    expect(updated.maxFileBytes).toBe(2 * BYTES_PER_MIB);
    expect(JSON.parse(String(fetch.mock.calls[0]![1]!.body))).toEqual({ maxFileBytes: 2 * BYTES_PER_MIB });

    const cleared = await updateRootMaxFileBytes(4, null);
    expect(cleared.maxFileBytes).toBeUndefined();
    expect(JSON.parse(String(fetch.mock.calls[1]![1]!.body))).toEqual({ maxFileBytes: null });
  });

  it("非法 bytes 在呼叫端就被擋下（不送請求）", async () => {
    const fetch = stubFetch();
    await expect(updateRootMaxFileBytes(1, 0)).rejects.toThrow("1 byte");
    await expect(updateRootMaxFileBytes(1, 1.5)).rejects.toThrow("1 byte");
    await expect(updateRootMaxFileBytes(1, 17 * 1024 ** 3)).rejects.toThrow("16 GiB");
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("SSR：分享開關與通用上限入口", () => {
  it("資料夾清單顯示分享開關與說明；已分享的 root 是勾選狀態", () => {
    const html = renderToStaticMarkup(
      createElement(RootsList, {
        roots: [root({ id: 1, allowAgentSearch: true }), root({ id: 2, allowAgentSearch: false })],
        selectedRootId: null,
        onSelect: () => {},
        onRemove: () => {},
      }),
    );
    expect(html).toContain("允許 Agent 搜尋此資料夾");
    // 文案要明示不是硬隔離（防止把分享開關誤當安全邊界）。
    expect(html).toContain("不是多租戶硬隔離");
    expect(html).toContain("本機 owner 全權");
    // 已分享的 root 是勾選狀態（checked 屬性只會出現在有開的 checkbox）。
    expect(html).toContain('checked=""');
    // 通用上限編輯器與服務預設標註（不需要父層提供回呼也會出現）。
    expect(html).toContain("一般檔案單檔上限：");
    expect(html).toContain("10 MiB");
    expect(html).toContain("（服務預設）");
    expect(html).toContain("影片另用影片上限");
  });

  it("已設定通用上限的 root 顯示自己的值與「恢復預設」", () => {
    const html = renderToStaticMarkup(
      createElement(RootsList, {
        roots: [root({ maxFileBytes: 2 * BYTES_PER_MIB })],
        selectedRootId: null,
        onSelect: () => {},
        onRemove: () => {},
      }),
    );
    expect(html).toContain("2 MiB");
    expect(html).not.toContain("（服務預設）");
    expect(html).toContain("恢復預設");
  });

  it("加入資料夾流程有通用上限欄位（預設 10 MiB）", () => {
    const html = renderToStaticMarkup(
      createElement(AddRootFlow, {
        onCancel: () => {},
        onDone: () => {},
      }),
    );
    expect(html).toContain("一般檔案單檔上限（MiB）");
    expect(html).toContain('value="10"');
    expect(html).toContain("只套用非影片檔案");
  });
});
