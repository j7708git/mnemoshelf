import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { formatMediaTime, toggleModality } from "../src/audio";
import { fetchAudioBlobUrl } from "../src/api";
import { FilePreview } from "../src/FilePreview";
import { AudioModelStatus } from "../src/AudioModelStatus";
import { RootsList } from "../src/RootsList";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("音訊時間與 root 模態", () => {
  it("保留小數尾段與分鐘，不顯示負值或 NaN", () => {
    expect(formatMediaTime(61.25)).toBe("1:01.3");
    expect(formatMediaTime(0)).toBe("0:00.0");
    expect(formatMediaTime(59.96)).toBe("1:00.0");
    expect(formatMediaTime(-1)).toBe("0:00.0");
    expect(formatMediaTime(NaN)).toBe("0:00.0");
  });
  it("切換照片不會清掉音訊或使用者關閉的文字模態", () => {
    expect(toggleModality(["audio"], "image", true)).toEqual(["audio", "image"]);
    expect(toggleModality(["audio", "image"], "image", false)).toEqual(["audio"]);
    expect(toggleModality(["text", "audio"], "audio", true)).toEqual(["text", "audio"]);
    expect(toggleModality(["audio"], "audio", false)).toEqual([]);
  });
  it("音訊請求使用授權端點且拒絕非音訊回應", async () => {
    vi.stubGlobal("sessionStorage", { getItem: () => "fixture" });
    const fetch = vi.fn().mockResolvedValueOnce(new Response(new Uint8Array([1]), { headers: { "content-type": "audio/wav" } }))
      .mockResolvedValueOnce(Response.json({ kind: "text" }));
    vi.stubGlobal("fetch", fetch);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:fixture");
    expect(await fetchAudioBlobUrl(1, "sound clip.wav")).toBe("blob:fixture");
    expect(fetch.mock.calls[0][0]).toBe("/roots/1/file?path=sound%20clip.wav");
    expect(fetch.mock.calls[0][1].headers.get("authorization")).toBe("Bearer fixture");
    await expect(fetchAudioBlobUrl(1, "note.txt")).rejects.toThrow("WAV");
  });
  it("音訊來源顯示時間片段與明確載入狀態", () => {
    const html = renderToStaticMarkup(createElement(FilePreview, {
      rootId: 1, entry: { kind: "audio", name: "sample.wav", path: "sample.wav", size: null, mimeType: null },
      media: { startSeconds: 30, endSeconds: 35.5, track: "audio", preprocessVersion: "v1", embedderId: "fake", embeddingDim: 8 },
    }));
    expect(html).toContain("0:30.0");
    expect(html).toContain("0:35.5");
    expect(html).toContain("正在載入音訊");
    expect(renderToStaticMarkup(createElement(AudioModelStatus))).toContain("音訊模型狀態");
  });
  it("既有 root 音訊開關反映設定並在寫入中鎖住", () => {
    const html = renderToStaticMarkup(createElement(RootsList, {
      roots: [{ id: 1, path: "fixture", mode: "index", modalities: ["audio"], include: [], exclude: [], respectGitignore: true, watch: false, createdAt: "2026-11-08" }],
      selectedRootId: 1, onSelect: () => {}, onRemove: () => {}, onToggleAudio: () => {}, imagesBusyRootId: 1,
    }));
    expect(html).toContain("含音訊 WAV");
    expect(html).toContain('checked=""');
    expect(html).toContain('disabled=""');
  });
});
