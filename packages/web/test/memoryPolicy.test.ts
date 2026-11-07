import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchMemoryPolicy, MemoryPolicyUnavailableError, updateMemoryPolicy } from "../src/api";
import { MemoryPolicySetting, type MemoryPolicyState } from "../src/MemoryPolicySetting";

afterEach(() => vi.unstubAllGlobals());

describe("記憶遮罩 REST 設定", () => {
  it("透過既有 token 讀取服務回傳的未設定預設值，並避開 HTTP 快取", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ maskSecrets: true, version: 1 }));
    vi.stubGlobal("fetch", fetch);
    vi.stubGlobal("sessionStorage", { getItem: () => "fixture" });

    await expect(fetchMemoryPolicy()).resolves.toEqual({ maskSecrets: true, version: 1 });
    expect(fetch).toHaveBeenCalledWith("/memory-policy", expect.objectContaining({ cache: "no-store" }));
    expect(fetch.mock.calls[0][1].headers.get("authorization")).toBe("Bearer fixture");
    expect(fetch.mock.calls[0][1].headers.get("accept")).toBe("application/json");
  });

  it("送出 PATCH，採用服務回傳的有效值與版本", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ maskSecrets: false, version: 2 }));
    vi.stubGlobal("fetch", fetch);

    await expect(updateMemoryPolicy(false)).resolves.toEqual({ maskSecrets: false, version: 2 });
    expect(fetch).toHaveBeenCalledWith("/memory-policy", expect.objectContaining({
      method: "PATCH",
      body: JSON.stringify({ maskSecrets: false }),
    }));
    expect(fetch.mock.calls[0][1].headers.get("content-type")).toBe("application/json");
  });

  it("回報儲存失敗，並拒絕將格式錯誤的回應當成有效值", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 500 }))
      .mockResolvedValueOnce(Response.json({ maskSecrets: false, version: 0 })));

    await expect(updateMemoryPolicy(false)).rejects.toThrow("HTTP 500");
    await expect(fetchMemoryPolicy()).rejects.toThrow("設定格式不正確");
  });

  it("GET 與 PATCH 的 404 均回報本機服務需要升級", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => new Response(null, { status: 404 })));

    await expect(fetchMemoryPolicy()).rejects.toBeInstanceOf(MemoryPolicyUnavailableError);
    await expect(updateMemoryPolicy(false)).rejects.toThrow("本機服務需要升級");
  });
});

function renderSetting(state: MemoryPolicyState): string {
  return renderToStaticMarkup(createElement(MemoryPolicySetting, { state, onChange: vi.fn(), onRetry: vi.fn() }));
}

describe("記憶遮罩設定畫面", () => {
  it("儲存時鎖住開關並保留已確認的值，失敗時顯示舊值並可重試", () => {
    const value = { maskSecrets: true, version: 1 };
    const saving = renderSetting({ kind: "saving", value, error: null });
    expect(saving).toContain('disabled=""');
    expect(saving).toContain('checked=""');
    expect(saving).toContain("儲存中…");

    const failed = renderSetting({ kind: "ready", value, error: "儲存失敗。" });
    expect(failed).not.toContain('disabled=""');
    expect(failed).toContain('checked=""');
    expect(failed).toContain("儲存失敗。 請再次切換以重試。");

    const saved = renderSetting({ kind: "ready", value: { maskSecrets: false, version: 2 }, error: null });
    expect(saved).toContain('type="checkbox"');
    expect(saved).not.toContain('checked=""');
  });

  it("舊版服務顯示升級提示，不顯示可操作的開關", () => {
    const html = renderSetting({ kind: "unavailable", message: new MemoryPolicyUnavailableError().message });
    expect(html).toContain("本機服務需要升級");
    expect(html).not.toContain('type="checkbox"');
  });
});
