/**
 * per-root 影片單檔大小上限的 UI 邏輯與 API 測試（C4b）。
 *
 * 契約（task-11／task-12）：POST /roots 與 PATCH /roots/:id 接受 optional
 * `videoMaxFileBytes`（bytes；1–16 GiB；預設 512 MiB），GET /roots 回傳；
 * UI 以整數 MiB 輸入、顯示目前值與服務預設，非法值不送出。
 * 後端由 server-c（task-11）實作；本檔以 mock API 驗前端，並驗證顯示／停用狀態。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Root, VideoCapability } from "../src/api";
import { addRoot, fetchRoots, updateRootVideoMaxFileBytes } from "../src/api";
import { AddRootFlow } from "../src/AddRootFlow";
import { RootsList } from "../src/RootsList";
import {
  BYTES_PER_MIB,
  DEFAULT_VIDEO_MAX_FILE_BYTES,
  effectiveVideoMaxFileBytes,
  formatVideoLimitBytes,
  parseVideoLimitMiB,
  VIDEO_LIMIT_MAX_BYTES,
  VIDEO_LIMIT_MAX_MIB,
  videoLimitMiBDefault,
} from "../src/media";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** 一個可用的影片能力（預設 512 MiB 上限）。 */
function capability(overrides: Partial<VideoCapability> = {}): VideoCapability {
  return {
    available: true,
    state: "available",
    reason: null,
    embedderVideo: true,
    maxFileBytes: DEFAULT_VIDEO_MAX_FILE_BYTES,
    durationLimitSeconds: 600,
    ffmpegVersion: "n9.0.2",
    ffprobeVersion: "n9.0.2",
    ...overrides,
  };
}

/** `GET /roots`／`POST /roots` 的回應 root（欄位與 Core 契約一致）。 */
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
    createdAt: "2026-11-08",
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

describe("parseVideoLimitMiB（UI 輸入驗證與換算）", () => {
  it("整數 MiB 正確換算成 bytes（含預設 512 與上下界）", () => {
    expect(parseVideoLimitMiB("512")).toEqual({ ok: true, bytes: 512 * BYTES_PER_MIB });
    expect(parseVideoLimitMiB("1")).toEqual({ ok: true, bytes: BYTES_PER_MIB });
    expect(parseVideoLimitMiB(" 16384 ")).toEqual({ ok: true, bytes: 16 * 1024 * BYTES_PER_MIB });
    expect(VIDEO_LIMIT_MAX_MIB).toBe(16384);
    expect(VIDEO_LIMIT_MAX_BYTES).toBe(16 * 1024 * BYTES_PER_MIB);
  });

  it("空值、非整數、0、負數、超界與帶單位字串都有可讀錯誤", () => {
    for (const input of ["", "   "]) {
      const result = parseVideoLimitMiB(input);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toContain("請輸入");
    }
    for (const input of ["abc", "1.5", "512MiB", "1,024", "-1", "0"]) {
      const result = parseVideoLimitMiB(input);
      expect(result.ok, input).toBe(false);
      if (!result.ok) expect(result.message.length).toBeGreaterThan(0);
    }
    const tooLarge = parseVideoLimitMiB("16385");
    expect(tooLarge.ok).toBe(false);
    if (!tooLarge.ok) expect(tooLarge.message).toContain("16 GiB");
    const zero = parseVideoLimitMiB("0");
    if (!zero.ok) expect(zero.message).toContain("至少 1 MiB");
  });
});

describe("上限顯示與生效值", () => {
  it("512 MiB 等常見值顯示為 MiB；小於 1 MiB 顯示 bytes、非整數保留兩位小數", () => {
    expect(formatVideoLimitBytes(512 * BYTES_PER_MIB)).toBe("512 MiB");
    expect(formatVideoLimitBytes(16 * 1024 * BYTES_PER_MIB)).toBe("16384 MiB");
    expect(formatVideoLimitBytes(1)).toBe("1 B");
    expect(formatVideoLimitBytes(1.5 * BYTES_PER_MIB)).toBe("1.5 MiB");
    expect(formatVideoLimitBytes(0)).toBe("—");
    expect(formatVideoLimitBytes(Number.NaN)).toBe("—");
  });

  it("生效值優先序：root 設定 → 服務預設 → 產品預設 512 MiB（非法值不當 0）", () => {
    expect(effectiveVideoMaxFileBytes({ videoMaxFileBytes: 2 * 1024 * BYTES_PER_MIB }, DEFAULT_VIDEO_MAX_FILE_BYTES)).toBe(2 * 1024 * BYTES_PER_MIB);
    expect(effectiveVideoMaxFileBytes({ videoMaxFileBytes: null }, 1024 * BYTES_PER_MIB)).toBe(1024 * BYTES_PER_MIB);
    expect(effectiveVideoMaxFileBytes({}, undefined)).toBe(DEFAULT_VIDEO_MAX_FILE_BYTES);
    expect(effectiveVideoMaxFileBytes({ videoMaxFileBytes: 0 }, undefined)).toBe(DEFAULT_VIDEO_MAX_FILE_BYTES);
    expect(effectiveVideoMaxFileBytes({ videoMaxFileBytes: -5 }, undefined)).toBe(DEFAULT_VIDEO_MAX_FILE_BYTES);
  });

  it("新增資料夾的預設輸入值沿用服務預設（正常 512）", () => {
    expect(videoLimitMiBDefault(undefined)).toBe("512");
    expect(videoLimitMiBDefault(1024 * BYTES_PER_MIB)).toBe("1024");
    expect(videoLimitMiBDefault(1.5 * BYTES_PER_MIB)).toBe("1.5");
  });
});

describe("API：建立與更新影片上限", () => {
  it("POST /roots 帶 videoMaxFileBytes（bytes）；GET /roots 回傳值可讀", async () => {
    const fetch = stubFetch(
      Response.json(root({ videoMaxFileBytes: 512 * BYTES_PER_MIB }), { status: 201 }),
      Response.json({ roots: [root({ videoMaxFileBytes: 1024 * BYTES_PER_MIB })], video: capability() }),
    );
    const created = await addRoot({ path: "fixture", modalities: ["text", "code"], videoMaxFileBytes: 512 * BYTES_PER_MIB });
    expect(created.videoMaxFileBytes).toBe(512 * BYTES_PER_MIB);
    const body = JSON.parse(String(fetch.mock.calls[0]![1]!.body)) as { videoMaxFileBytes?: number; modalities?: string[] };
    expect(body.videoMaxFileBytes).toBe(512 * BYTES_PER_MIB);
    expect(body.modalities).toEqual(["text", "code"]);

    const listed = await fetchRoots();
    expect(listed.roots[0]?.videoMaxFileBytes).toBe(1024 * BYTES_PER_MIB);
  });

  it("PATCH /roots/:id 只送 videoMaxFileBytes，不覆寫 modalities", async () => {
    const fetch = stubFetch(Response.json(root({ videoMaxFileBytes: 2 * 1024 * BYTES_PER_MIB })));
    const updated = await updateRootVideoMaxFileBytes(3, 2 * 1024 * BYTES_PER_MIB);
    expect(updated.videoMaxFileBytes).toBe(2 * 1024 * BYTES_PER_MIB);
    expect(fetch.mock.calls[0]![0]).toBe("/roots/3");
    expect(fetch.mock.calls[0]![1]!.method).toBe("PATCH");
    const body = JSON.parse(String(fetch.mock.calls[0]![1]!.body)) as Record<string, unknown>;
    expect(body).toEqual({ videoMaxFileBytes: 2 * 1024 * BYTES_PER_MIB });
    expect(fetch.mock.calls[0]![1]!.headers.get("authorization")).toBe("Bearer fixture");
  });

  it("清除設定：PATCH null（回到服務層預設）", async () => {
    const fetch = stubFetch(Response.json(root()));
    const updated = await updateRootVideoMaxFileBytes(4, null);
    expect(updated.videoMaxFileBytes).toBeUndefined();
    const body = JSON.parse(String(fetch.mock.calls[0]![1]!.body)) as Record<string, unknown>;
    expect(body).toEqual({ videoMaxFileBytes: null });
  });

  it("非法 bytes 在呼叫端就被擋下（不送請求）", async () => {
    const fetch = stubFetch();
    await expect(updateRootVideoMaxFileBytes(1, 0)).rejects.toThrow("1 byte");
    await expect(updateRootVideoMaxFileBytes(1, 1.5)).rejects.toThrow("1 byte");
    await expect(updateRootVideoMaxFileBytes(1, 17 * 1024 * 1024 * 1024)).rejects.toThrow("16 GiB");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("PATCH 被伺服器拒絕時顯示伺服器訊息（例如超出範圍）", async () => {
    stubFetch(Response.json({ error: { message: "videoMaxFileBytes 必須在 1 byte–16 GiB 之間" } }, { status: 400 }));
    await expect(updateRootVideoMaxFileBytes(1, 17 * 1024 * BYTES_PER_MIB)).rejects.toThrow("16 GiB");
  });
});

describe("SSR：設定入口與目前值", () => {
  it("加入資料夾流程預設 512 MiB 的欄位（單位 MiB），並說明可先設定", () => {
    const html = renderToStaticMarkup(createElement(AddRootFlow, {
      onCancel: () => {},
      onDone: () => {},
      videoCapability: capability(),
    }));
    expect(html).toContain("影片單檔大小上限（MiB）");
    expect(html).toContain('value="512"');
    expect(html).toContain("影片未開啟也可以先設定");
    expect(html).toContain("512 MiB");
  });

  it("服務預設不是 512 時，新增表單的預設輸入跟著服務值", () => {
    const html = renderToStaticMarkup(createElement(AddRootFlow, {
      onCancel: () => {},
      onDone: () => {},
      videoCapability: capability({ maxFileBytes: 1024 * BYTES_PER_MIB }),
    }));
    expect(html).toContain('value="1024"');
  });

  it("資料夾清單顯示目前上限（未設定時標服務預設）；busy 時停用輸入與儲存", () => {
    const html = renderToStaticMarkup(createElement(RootsList, {
      roots: [
        root({ id: 1, modalities: ["text", "video"], videoMaxFileBytes: 2 * 1024 * BYTES_PER_MIB }),
        root({ id: 2, modalities: ["text"] }),
      ],
      selectedRootId: null,
      onSelect: () => {},
      onRemove: () => {},
      onSetVideoMaxFileBytes: () => {},
      defaultVideoMaxFileBytes: DEFAULT_VIDEO_MAX_FILE_BYTES,
      videoLimitBusyRootId: 1,
    }));
    // 有設定值：直接顯示 2048 MiB，不標「服務預設」。
    expect(html).toContain("影片單檔上限：");
    expect(html).toContain("2048 MiB");
    // 未設定：顯示服務預設 512 MiB 並標註（span 與文字分開渲染，分開斷言）。
    expect(html).toContain(">512 MiB<");
    expect(html).toContain("（服務預設）");
    // busy 的 root：輸入與按鈕 disabled、placeholder 是生效值、按鈕顯示儲存中。
    expect(html).toContain('placeholder="512"');
    expect(html).toContain("儲存中…");
    expect(html).toContain('disabled=""');
    // 只有「有設定值」的 root 顯示「恢復預設」（root 2 未設定，不需要清除）。
    expect(html.match(/恢復預設/g)?.length).toBe(1);
  });

  it("沒有提供儲存回呼時不顯示上限編輯器（舊呼叫端不受影響）", () => {
    const html = renderToStaticMarkup(createElement(RootsList, {
      roots: [root({ modalities: ["text", "video"] })],
      selectedRootId: null,
      onSelect: () => {},
      onRemove: () => {},
    }));
    expect(html).not.toContain("影片單檔上限");
  });
});
