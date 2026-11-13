/**
 * 資料夾瀏覽對話框、風險橫幅、加入資料夾改版與相關 API／CSS 契約測試。
 */
import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccessPolicyRiskBanner, describeRelaxedPolicyReasons } from "../src/AccessPolicyRiskBanner";
import { AddRootFlow } from "../src/AddRootFlow";
import { browseDirectories, fetchHealth, setToken, type BrowseAccessPolicy } from "../src/api";
import { ConfirmDialog } from "../src/ConfirmDialog";
import { FolderPickerDialog } from "../src/FolderPickerDialog";

const STRICT_POLICY: BrowseAccessPolicy = {
  host: "127.0.0.1",
  nonLoopbackBind: false,
  allowAnonymous: false,
  browseScope: "home",
  respectBlacklist: true,
  relaxed: false,
};

const RELAXED_POLICY: BrowseAccessPolicy = {
  host: "0.0.0.0",
  nonLoopbackBind: true,
  allowAnonymous: true,
  browseScope: "unrestricted",
  respectBlacklist: false,
  relaxed: true,
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("AccessPolicyRiskBanner", () => {
  it("安全預設時不顯示任何警告內容", () => {
    expect(describeRelaxedPolicyReasons(STRICT_POLICY)).toEqual([]);
    const html = renderToStaticMarkup(createElement(AccessPolicyRiskBanner, { policy: STRICT_POLICY }));
    expect(html).toBe("");
  });

  it("策略放寬時列出所有放寬項目與風險承擔說明", () => {
    const reasons = describeRelaxedPolicyReasons(RELAXED_POLICY);
    expect(reasons).toHaveLength(4);
    const html = renderToStaticMarkup(createElement(AccessPolicyRiskBanner, { policy: RELAXED_POLICY }));
    expect(html).toContain("預設安全限制已被放寬");
    expect(html).toContain("0.0.0.0");
    expect(html).toContain("匿名存取");
    expect(html).toContain("不限");
    expect(html).toContain("黑名單");
  });
});

describe("原生 <dialog> 對話框元件與樣式", () => {
  it("FolderPickerDialog 使用原生 <dialog>，不手動加 role=dialog 或 aria-modal", () => {
    const html = renderToStaticMarkup(
      createElement(FolderPickerDialog, {
        open: true,
        knownPolicy: RELAXED_POLICY,
        onSelect: () => undefined,
        onClose: () => undefined,
      }),
    );
    expect(html).toContain("<dialog");
    expect(html).not.toContain('role="dialog"');
    expect(html).not.toContain("aria-modal");
    expect(html).toContain("選擇資料夾");
    expect(html).toContain("預設安全限制已被放寬");
    expect(html).toContain("關閉");
  });

  it("ConfirmDialog 使用原生 <dialog>，不手動加 role=dialog 或 aria-modal", () => {
    const html = renderToStaticMarkup(
      createElement(ConfirmDialog, {
        open: true,
        title: "移除資料夾",
        description: "確定要移除嗎？",
        confirmLabel: "移除",
        variant: "danger",
        onConfirm: () => undefined,
        onCancel: () => undefined,
      }),
    );
    expect(html).toContain("<dialog");
    expect(html).not.toContain('role="dialog"');
    expect(html).not.toContain("aria-modal");
    expect(html).toContain("移除資料夾");
    expect(html).toContain("確定要移除嗎？");
  });

  it("styles.css 具備 color-scheme: light dark、light-dark() 與 overscroll-behavior: contain", () => {
    const cssPath = path.resolve(import.meta.dirname, "../src/styles.css");
    const css = fs.readFileSync(cssPath, "utf8");
    expect(css).toContain("color-scheme: light dark");
    expect(css).toContain("light-dark(");
    expect(css).toContain("overscroll-behavior: contain");
  });
});

describe("AddRootFlow 新版面與瀏覽按鈕", () => {
  it("顯示瀏覽按鈕、三步導引條、進階大小上限摺疊與三種模態選項卡", () => {
    const html = renderToStaticMarkup(
      createElement(AddRootFlow, {
        onAdded: () => undefined,
        videoCapability: {
          available: false,
          state: "unavailable",
          reason: "missing-ffmpeg",
          embedderVideo: true,
          maxFileBytes: 512 * 1024 * 1024,
          durationLimitSeconds: 600,
          ffmpegVersion: null,
          ffprobeVersion: null,
        },
      }),
    );
    expect(html).toContain("瀏覽…");
    expect(html).toContain("選擇資料夾");
    expect(html).toContain("預覽統計");
    expect(html).toContain("開始索引");
    expect(html).toContain("<details");
    expect(html).toContain("進階：檔案大小上限");
    expect(html).toContain("含照片");
    expect(html).toContain("含音訊");
    expect(html).toContain("含影片");
    expect(html).toContain("找不到影片解碼器");
    expect(html).toContain("disabled");
  });
});

describe("browseDirectories 與 fetchHealth API", () => {
  it("只在呼叫 browseDirectories 時發送 GET /fs/browse，並正確編碼路徑查詢參數", async () => {
    const storage = new Map<string, string>();
    vi.stubGlobal("sessionStorage", {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => storage.set(k, v),
      removeItem: (k: string) => storage.delete(k),
    });
    setToken("picker-test-token");

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        currentPath: "/sandbox/photos",
        parentPath: "/sandbox",
        breadcrumbs: [{ name: "sandbox", path: "/sandbox" }, { name: "photos", path: "/sandbox/photos" }],
        quickLocations: [{ label: "家目錄", path: "/sandbox" }],
        directories: [{ name: "2026", path: "/sandbox/photos/2026" }],
        policy: STRICT_POLICY,
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    expect(fetchMock).not.toHaveBeenCalled();
    const res = await browseDirectories("/sandbox/photos & raw");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/fs/browse?path=%2Fsandbox%2Fphotos%20%26%20raw");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer picker-test-token");
    expect(res.directories.map((d) => d.name)).toEqual(["2026"]);
  });

  it("fetchHealth 解析 authRequired 與 accessPolicy", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        status: "ok",
        service: "mnemoshelf",
        authRequired: false,
        accessPolicy: RELAXED_POLICY,
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const health = await fetchHealth();
    expect(health.service).toBe("mnemoshelf");
    expect(health.authRequired).toBe(false);
    expect(health.accessPolicy?.relaxed).toBe(true);
  });
});
